-- Core V2 S6b (register BIL-24, BIL-25; ADR-0067 decision 5; S0 FC-3, V-3; the Owner's R6B-7, R6B-10, 2026-10-28), for Core V2 DEVELOPMENT AND
-- SIMULATION ONLY. The Owner relays an Auth refund authorization receipt for an open refund case to Payment. Billing never holds the secret
-- beyond the request (F-12); it records, BEFORE it calls Payment and under the case's row lock, one durable relay naming the refund attempt id
-- it generated. Payment is the authority on that attempt: Billing mirrors Payment's authoritative status from Payment's answers and reads
-- (PAY-07, PAY-08), never from an absent response. Expand only: one table, one unique key on refund_case, triggers. No existing row changes.
--
--   * One relay at a time per case while it may still produce a refund: a partial unique index (only `authorization_expired`,
--     `authorization_refused`, `failed` and `rejected` free the case for a new relay; `failed` needs a new receipt, Payment's rule).
--   * `attemptStatus` is NULL until Payment answered; afterwards it only moves the way Payment's attempt can (monotonic, terminal states fixed).
--     `rejected` is Payment's permanent refusal of the attempt id before any attempt existed (`refusal` is its code).
--   * R6B-10: a case cannot be cancelled while any relay is unconfirmed (NULL) or authorized, dispatched, submitted, unknown, succeeded, failed
--     or in discrepancy. Only when every relay ended without a consumed receipt (`authorization_expired`, `authorization_refused`, `rejected`,
--     each proven by Payment) may it be cancelled. Enforced here too, not only by the application.
--   * Nothing here completes a case (S6c), reverses a purchase (S6d) or creates an obligation.

ALTER TABLE refund_case ADD CONSTRAINT refund_case_payment_binding UNIQUE (id, "paymentId");

CREATE TABLE refund_authorization_relay (
  id                uuid PRIMARY KEY,                       -- the refund attempt id Billing generated: Payment's attempt id and consumeRef
  "refundCaseId"    uuid NOT NULL,
  "paymentId"       uuid NOT NULL,
  "requestedBy"     uuid NOT NULL,                          -- the Owner Auth verified, never a request value
  "idempotencyKey"  text NOT NULL,
  "requestHash"     char(64) NOT NULL,                      -- never covers the receipt secret
  "attemptStatus"   text,
  refusal           text,
  "requestedAt"     timestamptz NOT NULL DEFAULT now(),
  "statusAt"        timestamptz,
  "checkAfter"      timestamptz,                            -- the relay reconciler's lease
  CONSTRAINT refund_authorization_relay_case FOREIGN KEY ("refundCaseId", "paymentId") REFERENCES refund_case (id, "paymentId"),
  CONSTRAINT refund_authorization_relay_key UNIQUE ("requestedBy", "idempotencyKey"),
  CONSTRAINT refund_authorization_relay_key_shape CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT refund_authorization_relay_status CHECK ("attemptStatus" IS NULL OR "attemptStatus" IN ('authorization_pending', 'authorized',
    'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'succeeded', 'failed', 'unknown', 'discrepancy', 'rejected')),
  CONSTRAINT refund_authorization_relay_refusal CHECK (("attemptStatus" = 'rejected') = (refusal IS NOT NULL)
    AND (refusal IS NULL OR refusal IN ('payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open',
      'refund_in_progress', 'refund_already_recorded'))),
  CONSTRAINT refund_authorization_relay_status_at CHECK (("attemptStatus" IS NULL) = ("statusAt" IS NULL))
);
CREATE UNIQUE INDEX refund_authorization_relay_one_live ON refund_authorization_relay ("refundCaseId")
  WHERE "attemptStatus" IS NULL OR "attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'failed', 'rejected');
CREATE INDEX refund_authorization_relay_case_idx ON refund_authorization_relay ("refundCaseId", "requestedAt");
CREATE INDEX refund_authorization_relay_open_idx ON refund_authorization_relay ("checkAfter")
  WHERE "attemptStatus" IS NULL OR "attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy', 'rejected');

-- a relay starts unconfirmed, only for an OPEN case (the case's row lock serializes it against a cancellation)
CREATE FUNCTION billing_refund_relay_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."attemptStatus" IS NOT NULL OR NEW.refusal IS NOT NULL OR NEW."statusAt" IS NOT NULL OR NEW."checkAfter" IS NOT NULL THEN
    RAISE EXCEPTION 'a refund relay starts unconfirmed' USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_relay_created_unconfirmed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM refund_case c WHERE c.id = NEW."refundCaseId" AND c.status = 'open') THEN
    RAISE EXCEPTION 'refund relay: case % is not open', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_relay_case_open';
  END IF;
  NEW."requestedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_authorization_relay_05_insert_guard BEFORE INSERT ON refund_authorization_relay FOR EACH ROW EXECUTE FUNCTION billing_refund_relay_insert_guard();

CREATE TRIGGER refund_authorization_relay_10_immutable BEFORE UPDATE ON refund_authorization_relay
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('attemptStatus', 'refusal', 'statusAt', 'checkAfter');

-- the mirror only moves the way Payment's attempt can (migration payment 0017), never backwards; terminal states are fixed
CREATE FUNCTION billing_refund_relay_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."attemptStatus" IS NOT DISTINCT FROM NEW."attemptStatus" THEN
    IF OLD.refusal IS DISTINCT FROM NEW.refusal OR OLD."statusAt" IS DISTINCT FROM NEW."statusAt" THEN
      RAISE EXCEPTION 'refund relay %: its status facts change only with the status', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_relay_status_facts';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."attemptStatus" IS NULL AND NEW."attemptStatus" IS NOT NULL THEN
    NEW."statusAt" := now();
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('authorization_pending', 'authorized'), ('authorization_pending', 'authorization_expired'), ('authorization_pending', 'authorization_refused'),
      ('authorization_pending', 'dispatching'), ('authorization_pending', 'submitted'), ('authorization_pending', 'unknown'),
      ('authorization_pending', 'succeeded'), ('authorization_pending', 'failed'), ('authorization_pending', 'discrepancy'),
      ('authorized', 'dispatching'), ('authorized', 'submitted'), ('authorized', 'unknown'), ('authorized', 'succeeded'), ('authorized', 'failed'),
      ('authorized', 'discrepancy'),
      ('dispatching', 'submitted'), ('dispatching', 'unknown'), ('dispatching', 'succeeded'), ('dispatching', 'failed'), ('dispatching', 'discrepancy'),
      ('unknown', 'submitted'), ('unknown', 'succeeded'), ('unknown', 'failed'), ('unknown', 'discrepancy'),
      ('submitted', 'succeeded'), ('submitted', 'failed'), ('submitted', 'discrepancy'),
      ('failed', 'discrepancy')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD."attemptStatus" AND allowed.to_status = NEW."attemptStatus"
  ) THEN
    RAISE EXCEPTION 'refund relay % cannot move from % to %', OLD.id, OLD."attemptStatus", NEW."attemptStatus" USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_relay_transition';
  END IF;
  NEW."statusAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_authorization_relay_20_status BEFORE UPDATE ON refund_authorization_relay FOR EACH ROW EXECUTE FUNCTION billing_refund_relay_status_guard();
CREATE TRIGGER refund_authorization_relay_90_no_delete BEFORE DELETE ON refund_authorization_relay FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER refund_authorization_relay_91_no_truncate BEFORE TRUNCATE ON refund_authorization_relay FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- R6B-10: a case is cancelled only when every relay is PROVEN to have ended without a consumed receipt (the S6a open -> cancelled edge, narrowed)
CREATE FUNCTION billing_refund_case_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND EXISTS (
    SELECT 1 FROM refund_authorization_relay r WHERE r."refundCaseId" = OLD.id
       AND (r."attemptStatus" IS NULL OR r."attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'rejected'))) THEN
    RAISE EXCEPTION 'refund case %: refund processing has begun', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_case_processing_started';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_15_cancel_guard BEFORE UPDATE ON refund_case FOR EACH ROW EXECUTE FUNCTION billing_refund_case_cancel_guard();

-- the runtime role: INSERT, SELECT and UPDATE (the guarded mirror and lease); never DELETE
DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_authorization_relay FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'refund_authorization_relay' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_authorization_relay FROM %s', r.role);
  END LOOP;
END $$;
