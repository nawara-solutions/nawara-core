-- Core V2 S4c (register PAY-02, PAY-04; S0 §1.1, §3.4, §3.10, L-1; the Owner's decisions F-1 to F-8), for Core V2 DEVELOPMENT AND
-- SIMULATION ONLY. Payment's workflow closing and its uncertainty, enforced at the database boundary. Additive only: two columns on each of
-- payment and payment_attempt, a wider status CHECK, one function, replaced transition guards, an attempt insert guard and one
-- append-only evidence table. No existing row changes; nothing is backfilled (F-8: finality and uncertainty are derived from evidence).
--
--   * UNCERTAIN (F-2): an attempt may still produce a verified financial result: it is `initiated`, `submitted` or `unknown`, or it failed
--     only BY INFERENCE (`failureInferred`) and no provider evidence has confirmed that failure since (`failureConfirmedAt` NULL). Only
--     provider-confirmed failure or provider-reported expiry (F-3) ends it; elapsed time, a retry limit or inference never does.
--   * CLOSING (F-1): a cancel or an expiry that arrives while the payment is uncertain moves it to `closing` (`closingReason` cancel |
--     expiry, `closingSince` the database time). A closing payment takes no new attempt and never returns to created or pending; it ends
--     `succeeded` on a verified success (F-4), or `cancelled` / `expired` (its own reason) once nothing is uncertain any more.
--   * A payment never becomes `cancelled`, `expired` or `failed` while uncertain (F-1, F-3): those are workflow-final.
--   * F-6: no new attempt while the payment is uncertain or not `created` (serialized on the payment row).
--   * F-4: a verified success for a payment already workflow-final changes nothing about the payment and emits no `payment.succeeded`;
--     it is recorded, durably and once per (attempt, source, webhook event), in `payment_late_success` for S4d facts and S6h reconciliation.
--     So is a success that contradicts a provider-CONFIRMED failure (never applied either): verified evidence is never discarded (L-1).

-- ─────────────────────────────────────────────────────────────────────────────────────────────── payment_attempt: confirmed failure

ALTER TABLE payment_attempt
  ADD COLUMN "failureConfirmedAt"   timestamptz, -- provider evidence later confirmed an INFERRED failure (F-3); set once
  ADD COLUMN "confirmedFailureCode" text;        -- the provider's own failure code for that confirmation (evidence, never a decision)
ALTER TABLE payment_attempt
  ADD CONSTRAINT payment_attempt_confirmation_shape CHECK (
    ("failureConfirmedAt" IS NULL AND "confirmedFailureCode" IS NULL)
    OR ("failureConfirmedAt" IS NOT NULL AND status = 'failed' AND "failureInferred")),
  ADD CONSTRAINT payment_attempt_confirmed_code_length CHECK ("confirmedFailureCode" IS NULL OR char_length("confirmedFailureCode") BETWEEN 1 AND 128);

CREATE FUNCTION payment_attempt_confirmation_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."failureConfirmedAt" IS NOT NULL AND (NEW."failureConfirmedAt" IS DISTINCT FROM OLD."failureConfirmedAt" OR NEW."confirmedFailureCode" IS DISTINCT FROM OLD."confirmedFailureCode") THEN
    RAISE EXCEPTION 'payment_attempt %: a confirmed failure is never rewritten', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD."failureConfirmedAt" IS NULL AND NEW."failureConfirmedAt" IS NOT NULL THEN NEW."failureConfirmedAt" := now(); END IF; -- database time only
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_12_confirmation_once BEFORE UPDATE ON payment_attempt FOR EACH ROW EXECUTE FUNCTION payment_attempt_confirmation_once();

-- the late-success edge (failed -> succeeded) stays only for an inferred failure that no provider evidence has confirmed since
CREATE OR REPLACE FUNCTION payment_attempt_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('initiated', 'submitted'), ('initiated', 'failed'), ('initiated', 'unknown'),
      ('submitted', 'succeeded'), ('submitted', 'failed'), ('submitted', 'expired'),
      ('unknown', 'submitted'), ('unknown', 'succeeded'), ('unknown', 'failed')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  )
  AND NOT (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD."failureInferred" AND OLD."failureConfirmedAt" IS NULL) THEN
    RAISE EXCEPTION 'payment_attempt % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── uncertainty (F-2)

CREATE FUNCTION payment_is_uncertain(p_payment uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM payment_attempt a
     WHERE a."paymentId" = p_payment
       AND (a.status IN ('initiated', 'submitted', 'unknown') OR (a.status = 'failed' AND a."failureInferred" AND a."failureConfirmedAt" IS NULL)));
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── payment: closing (F-1)

ALTER TABLE payment
  ADD COLUMN "closingReason" text,
  ADD COLUMN "closingSince"  timestamptz;
ALTER TABLE payment DROP CONSTRAINT payment_status_valid;
ALTER TABLE payment
  ADD CONSTRAINT payment_status_valid CHECK (status IN ('created', 'pending', 'closing', 'succeeded', 'failed', 'cancelled', 'expired')),
  ADD CONSTRAINT payment_closing_reason_valid CHECK ("closingReason" IS NULL OR "closingReason" IN ('cancel', 'expiry')),
  ADD CONSTRAINT payment_closing_fields_together CHECK (("closingReason" IS NULL) = ("closingSince" IS NULL)),
  ADD CONSTRAINT payment_closing_has_reason CHECK (status <> 'closing' OR "closingReason" IS NOT NULL),
  -- a payment that was closing ends only as its reason says, or succeeded; it never goes back to created or pending
  ADD CONSTRAINT payment_closing_outcome CHECK ("closingReason" IS NULL OR status IN ('closing', 'succeeded', CASE "closingReason" WHEN 'cancel' THEN 'cancelled' ELSE 'expired' END));

CREATE OR REPLACE FUNCTION payment_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('created', 'pending'), ('pending', 'created'), ('pending', 'succeeded'), ('pending', 'failed'),
      ('created', 'cancelled'), ('pending', 'cancelled'), ('created', 'expired'), ('pending', 'expired'),
      ('created', 'succeeded'), ('created', 'failed'),
      ('created', 'closing'), ('pending', 'closing'), ('closing', 'succeeded'), ('closing', 'cancelled'), ('closing', 'expired')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'payment % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'created' AND NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM payment_attempt
    WHERE id = NEW."succeededAttemptId" AND "paymentId" = NEW.id AND status = 'succeeded' AND "failureInferred"
  ) THEN
    RAISE EXCEPTION 'payment %: created -> succeeded is only the late success of an attempt failed by inference', OLD.id USING ERRCODE = '23514';
  END IF;
  -- F-3: created -> failed exists only for a payment whose inferred failure the provider has since CONFIRMED (the attempt limit was
  -- reached while that failure was still a guess, so the payment could not fail then)
  IF OLD.status = 'created' AND NEW.status = 'failed' AND NOT EXISTS (
    SELECT 1 FROM payment_attempt WHERE "paymentId" = NEW.id AND status = 'failed' AND "failureInferred" AND "failureConfirmedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'payment %: created -> failed is only for a confirmed inferred failure', OLD.id USING ERRCODE = '23514';
  END IF;
  -- F-1 / F-3: never workflow-final while uncertain, whatever path writes it
  IF NEW.status IN ('cancelled', 'expired', 'failed') AND payment_is_uncertain(NEW.id) THEN
    RAISE EXCEPTION 'payment %: an attempt may still settle it; it cannot become %', OLD.id, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'payment_not_final_while_uncertain';
  END IF;
  -- F-1: closing only while uncertain, with its reason; the time is the database's
  IF NEW.status = 'closing' THEN
    IF NOT payment_is_uncertain(NEW.id) THEN
      RAISE EXCEPTION 'payment %: closing is only for a payment an attempt may still settle', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'payment_closing_only_while_uncertain';
    END IF;
    IF NEW."closingReason" IS NULL THEN
      RAISE EXCEPTION 'payment %: closing records its reason', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'payment_closing_has_reason';
    END IF;
    NEW."closingSince" := now();
  END IF;
  RETURN NEW;
END $$;

-- the closing fields are written only by the move into closing, and never change afterwards
CREATE FUNCTION payment_closing_fields_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."closingReason" IS DISTINCT FROM OLD."closingReason" OR NEW."closingSince" IS DISTINCT FROM OLD."closingSince")
     AND NOT (OLD."closingReason" IS NULL AND OLD.status IN ('created', 'pending') AND NEW.status = 'closing') THEN
    RAISE EXCEPTION 'payment %: the closing reason and time are set once, when it starts closing', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'payment_closing_fields_once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_closing_fields_once BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION payment_closing_fields_once();

-- a new payment is never born closing (closing is reached only through the guarded transition)
CREATE FUNCTION payment_closing_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."closingReason" IS NOT NULL OR NEW."closingSince" IS NOT NULL OR NEW.status = 'closing' THEN
    RAISE EXCEPTION 'a payment is never created closing' USING ERRCODE = '23514', CONSTRAINT = 'payment_closing_not_at_creation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_06_closing_insert_guard BEFORE INSERT ON payment FOR EACH ROW EXECUTE FUNCTION payment_closing_insert_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── no second collection (F-6)

-- A new attempt only for a `created` payment that nothing may still settle. The payment row is locked first, so two concurrent attempt
-- starts (or a start racing a cancel or the sweeper) are serialized: the second sees the first attempt and is refused.
CREATE FUNCTION payment_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  IF st IS DISTINCT FROM 'created' OR payment_is_uncertain(NEW."paymentId") THEN
    RAISE EXCEPTION 'payment %: no new attempt while it is % or an earlier attempt may still settle it', NEW."paymentId", coalesce(st, 'unknown')
      USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_while_uncertain';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_04_insert_guard BEFORE INSERT ON payment_attempt FOR EACH ROW EXECUTE FUNCTION payment_attempt_insert_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── late success after closure (F-4)

CREATE TABLE payment_late_success (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId"       uuid NOT NULL REFERENCES payment (id),
  "attemptId"       uuid NOT NULL REFERENCES payment_attempt (id),
  source            text NOT NULL,                       -- how the verified success reached Payment
  "webhookEventId"  uuid REFERENCES webhook_event (id),  -- the stored, verified provider notification (webhook source only)
  amount            bigint NOT NULL,
  currency          char(3) NOT NULL,
  "paymentStatus"   text NOT NULL,                       -- the payment's status when the success arrived (kept as it was)
  "recordedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_late_success_source CHECK (source IN ('webhook', 'status_check')),
  CONSTRAINT payment_late_success_webhook_ref CHECK ((source = 'webhook') = ("webhookEventId" IS NOT NULL)),
  -- a workflow-final payment, or a provider-CONFIRMED failure contradicted by a success on a payment still open: both are evidence, kept
  CONSTRAINT payment_late_success_status CHECK ("paymentStatus" IN ('created', 'pending', 'closing', 'succeeded', 'failed', 'cancelled', 'expired')),
  CONSTRAINT payment_late_success_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_late_success_once UNIQUE NULLS NOT DISTINCT ("attemptId", source, "webhookEventId")
);
CREATE INDEX payment_late_success_payment_idx ON payment_late_success ("paymentId");

CREATE FUNCTION payment_late_success_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_late_success is append-only (verified provider evidence is never rewritten or discarded)' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER payment_late_success_10_append_only BEFORE UPDATE OR DELETE ON payment_late_success FOR EACH ROW EXECUTE FUNCTION payment_late_success_append_only();
CREATE TRIGGER payment_late_success_11_no_truncate BEFORE TRUNCATE ON payment_late_success FOR EACH STATEMENT EXECUTE FUNCTION payment_late_success_append_only();

-- The provisioning's DEFAULT PRIVILEGES give the runtime every DML privilege on a new table: take back the mutating ones (INSERT and SELECT stay).
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_late_success FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'payment_late_success' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_late_success FROM %s', r.role);
  END LOOP;
END $$;
