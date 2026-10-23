-- Core V2 S1c-3 R2a (ADR-0057 §13.7 "S0-C4"): dormant, append-only evidence of future producer re-emission attempts. Additive only: two new
-- tables, their own triggers and grants; no existing table, row, constraint or trigger changes, and the outbox is untouched.
--
-- NOTHING WRITES THESE TABLES YET. R2a has no publication path and its dry run is read-only; the writer comes with a separately authorized
-- R2b. These rows are Payment's operational evidence of an attempt, NOT Audit records (ADR-0049 keeps accountability in audit-service; the
-- producer's audit intent goes through its outbox with a cataloged action, R2b) and they never claim that audit intent was recorded.
--
-- What is never stored: the event body or any part of it, a correlation id, a credential, an authorization secret, provider data, or free
-- error text. Each column is an identifier, a bounded code or a time. There is no foreign key to `outbox`: the attempt evidence must
-- survive any authorized outbox retention, and a reference must never stop it.

CREATE TABLE payment_reemission_attempt (
  id                uuid PRIMARY KEY,
  "eventId"         uuid NOT NULL,                     -- the original outbox event (no foreign key, see above)
  "eventName"       text NOT NULL,
  "eventVersion"    integer NOT NULL,
  reason            text NOT NULL,                     -- a reason CODE, never free text
  "approvalRef"     text NOT NULL,                     -- a reference the verified Owner approval carried; never proof by itself
  environment       text NOT NULL,
  operation         text NOT NULL,
  "pipelineVersion" integer NOT NULL,
  "requestedAt"     timestamptz NOT NULL,
  "recordedAt"      timestamptz NOT NULL DEFAULT now(),
  -- S0-C4 Payment-first: exactly the four approved events, version 1 (no pattern), serialization pipeline 1, operation `event.reemit`
  CONSTRAINT payment_reemission_attempt_event CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired') AND "eventVersion" = 1),
  CONSTRAINT payment_reemission_attempt_pipeline CHECK ("pipelineVersion" = 1),
  CONSTRAINT payment_reemission_attempt_operation CHECK (operation = 'event.reemit'),
  CONSTRAINT payment_reemission_attempt_reason CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT payment_reemission_attempt_approval_ref CHECK ("approvalRef" ~ '^[A-Za-z0-9._:/-]{1,128}$'),
  CONSTRAINT payment_reemission_attempt_environment CHECK (environment ~ '^[A-Za-z0-9._:/-]{1,128}$')
);
CREATE INDEX payment_reemission_attempt_event_idx ON payment_reemission_attempt ("eventId");

-- One row per state change (R1's `ReemissionTransition`): requested → publishing → confirmed | unroutable | failed | uncertain. Each attempt
-- leaves a state at most once, so an outcome is recorded at most once and never replaced (uncertain included).
CREATE TABLE payment_reemission_attempt_transition (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "attemptId"  uuid NOT NULL REFERENCES payment_reemission_attempt (id),
  "fromState"  text NOT NULL,
  "toState"    text NOT NULL,
  stage        text,                                    -- the bounded stage of a failed or uncertain outcome
  "at"         timestamptz NOT NULL,
  "recordedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_reemission_transition_allowed CHECK (
    ("fromState" = 'requested' AND "toState" = 'publishing' AND stage IS NULL)
    OR ("fromState" = 'publishing' AND "toState" IN ('confirmed', 'unroutable') AND stage IS NULL)
    OR ("fromState" = 'publishing' AND "toState" = 'failed' AND stage IS NOT NULL AND stage IN ('not_sent', 'nacked', 'refused'))
    OR ("fromState" = 'publishing' AND "toState" = 'uncertain' AND stage IS NOT NULL AND stage IN ('confirm_timeout', 'channel_closed'))),
  CONSTRAINT payment_reemission_transition_once UNIQUE ("attemptId", "fromState")
);

-- A transition must leave the state the attempt is in: `requested` is where every attempt starts; `publishing` must have been reached.
CREATE FUNCTION payment_reemission_transition_from_reached() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."fromState" = 'publishing' AND NOT EXISTS (
    SELECT 1 FROM payment_reemission_attempt_transition WHERE "attemptId" = NEW."attemptId" AND "toState" = 'publishing') THEN
    RAISE EXCEPTION 'payment_reemission_attempt_transition: % was never reached', NEW."fromState" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_reemission_transition_05_from_reached BEFORE INSERT ON payment_reemission_attempt_transition
  FOR EACH ROW EXECUTE FUNCTION payment_reemission_transition_from_reached();

CREATE FUNCTION payment_reemission_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;

CREATE TRIGGER payment_reemission_attempt_10_append_only BEFORE UPDATE OR DELETE ON payment_reemission_attempt
  FOR EACH ROW EXECUTE FUNCTION payment_reemission_append_only();
CREATE TRIGGER payment_reemission_attempt_11_no_truncate BEFORE TRUNCATE ON payment_reemission_attempt
  FOR EACH STATEMENT EXECUTE FUNCTION payment_reemission_append_only();
CREATE TRIGGER payment_reemission_transition_10_append_only BEFORE UPDATE OR DELETE ON payment_reemission_attempt_transition
  FOR EACH ROW EXECUTE FUNCTION payment_reemission_append_only();
CREATE TRIGGER payment_reemission_transition_11_no_truncate BEFORE TRUNCATE ON payment_reemission_attempt_transition
  FOR EACH STATEMENT EXECUTE FUNCTION payment_reemission_append_only();

-- The Core provisioning's DEFAULT PRIVILEGES give the runtime SELECT / INSERT / UPDATE / DELETE on every table the migrator creates: take
-- back every mutating privilege from every role but the owner (whatever the roles are called), so the runtime holds INSERT and SELECT only.
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_reemission_attempt, payment_reemission_attempt_transition FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('payment_reemission_attempt', 'payment_reemission_attempt_transition') AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %s', r.tbl, r.role);
  END LOOP;
END $$;
