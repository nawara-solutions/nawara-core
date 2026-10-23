-- Core V2 S1e-2 (ADR-0057 §13.4, "S0-C6" H6): the TRUSTED envelope metadata of each verified original Payment event Billing receives.
-- Additive only: one new table, its own triggers and grants; no existing table, row, constraint or trigger changes.
--
-- Why: the provenance body commitment (0017) covers the body bytes only. Billing also takes financial inputs from the envelope: the
-- `occurredAt` header is the settlement instant (it anchors a Subscription period, Stage 12.4), the `version` header gates the payload
-- contract, and the correlation id is recorded with every transition. A default-exchange replay (a retry, an operator replay, an
-- injection) can copy an authentic body and change those headers, so a replay must never be trusted for them. This table keeps them as
-- the AUTHENTICATED original published them (a delivery through the event exchange whose broker `user_id` is the event's owner), and a
-- replay uses these stored values instead of its own headers.
--
-- Rules: one row per event id, written only from a verified original (or its verified redelivery) and only BEFORE that delivery's
-- financial processing; never updated or deleted (a second verified delivery with different metadata is a security conflict, refused by
-- the consumer, and never overwrites the row); never backfilled: an event recorded before this migration has no row, and a replay of it
-- is refused (the reconciler, which asks Payment directly, settles its request). Nothing here is a business de-duplication slot: the
-- receipts (0013/0016) stay the only one.

CREATE TABLE payment_event_origin (
  "eventId"       uuid PRIMARY KEY,
  source          text NOT NULL,                 -- the broker-verified producer (its `user_id`)
  "eventName"     text NOT NULL,
  "eventVersion"  integer NOT NULL,
  "occurredAt"    text NOT NULL,                 -- EXACTLY as the original published it (the settlement instant, parsed as before)
  "correlationId" text,                          -- as published; NULL when the original carried none
  "recordedAt"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_event_origin_source CHECK (source = 'payment-service'),
  CONSTRAINT payment_event_origin_name CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired')),
  CONSTRAINT payment_event_origin_version CHECK ("eventVersion" >= 1),
  CONSTRAINT payment_event_origin_occurred_at CHECK ("occurredAt" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$'),
  CONSTRAINT payment_event_origin_correlation CHECK ("correlationId" IS NULL OR char_length("correlationId") BETWEEN 1 AND 128)
);

CREATE TRIGGER payment_event_origin_10_append_only BEFORE UPDATE OR DELETE ON payment_event_origin
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER payment_event_origin_11_no_truncate BEFORE TRUNCATE ON payment_event_origin
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- The Core provisioning's DEFAULT PRIVILEGES give the runtime SELECT / INSERT / UPDATE / DELETE on every table the migrator creates: take
-- back every mutating privilege from every role but the owner (whatever the roles are called), so the runtime holds INSERT and SELECT only.
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_event_origin FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'payment_event_origin' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_event_origin FROM %s', r.role);
  END LOOP;
END $$;
