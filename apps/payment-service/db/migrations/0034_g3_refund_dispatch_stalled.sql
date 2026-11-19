-- 0034 — payment-service: an escalation-only review item for a refund attempt whose dispatch outcome stays unknown (Core V2 G3, DO-44; the Owner's
-- G3 + G2 GO, package B, 2026-11-18). DEVELOPMENT AND SIMULATION ONLY. Expand only, after 0033's precedent: one escalation kind, `factId` optional
-- for that kind ONLY (a shape check keeps it required for the three existing kinds), one partial unique index, one threshold function, one exit
-- table, and the 0032/0033 insert guard extended by one branch (its three existing branches textually unchanged). No existing row is rewritten;
-- nothing is backfilled; no refund, dispatch, retry, allocation, case or balance rule changes.
--
--   * kind `dispatch_stalled` (DO-44): the attempt is `dispatching` or `unknown`, has NO `submittedAt` (the provider never acknowledged it), and
--     the database time is at least 72 hours after `authorizedAt` (a migration constant, never configuration). The episode is the attempt: the
--     R6B-4 cycle dispatching <-> unknown is one stay, counted from the one authorization. One row per attempt.
--   * `authorization_pending` (also DO-44) gets NO row here: S6h's existing PAY-12 `authorization_pending` item (15 minutes) already shows it.
--   * The row is a request for review. It does NOT hold the attempt (the 0032 dispatch rule reads `dispatch_held` only), does not stop the worker's
--     same-key retry (R6B-4, R6B-9), and releases, resolves, allocates and cancels nothing.
--   * refund_safety_escalation_exit: at most one append-only row per `dispatch_stalled` escalation, once its attempt has left the stuck state
--     (submitted, or a status other than dispatching / unknown); refused while it is still stuck. The status seen is derived.

ALTER TABLE refund_safety_escalation ALTER COLUMN "factId" DROP NOT NULL;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_fact_shape CHECK ((kind = 'dispatch_stalled') = ("factId" IS NULL));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_kind;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_kind
  CHECK (kind IN ('dispatch_held', 'refund_fact_without_authorization', 'failed_attempt_refund_evidence', 'dispatch_stalled'));
CREATE UNIQUE INDEX refund_safety_escalation_stalled_once ON refund_safety_escalation ("refundAttemptId") WHERE kind = 'dispatch_stalled';

-- DO-44's threshold (the Owner's G3 GO): 72 hours after the authorization, while the provider never acknowledged the attempt
CREATE FUNCTION refund_dispatch_stalled_threshold() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '72 hours' $$;

-- The stuck state of DO-44: dispatching or unknown, never submitted
CREATE FUNCTION refund_attempt_dispatch_stuck(p_status text, p_submitted timestamptz) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_status IN ('dispatching', 'unknown') AND p_submitted IS NULL
$$;

-- 0033's guard, with one more branch. The `dispatch_held`, `failed_attempt_refund_evidence` and `refund_fact_without_authorization` branches are
-- textually unchanged.
CREATE OR REPLACE FUNCTION refund_safety_escalation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a refund_attempt%ROWTYPE; c refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId";
  IF a.id IS NULL THEN
    RAISE EXCEPTION 'refund_safety_escalation: unknown refund attempt' USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
  END IF;
  IF NEW.kind = 'dispatch_held' THEN
    -- only an attempt that may still be sent, and only on evidence the frozen rule counts: a hold never stops a refund without that evidence
    IF a.status <> 'authorized' OR NOT EXISTS (SELECT 1 FROM refund_capture_evidence_facts(a."captureFactId") e WHERE e = NEW."factId") THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not held by evidence %', a.id, NEW."factId"
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
  ELSIF NEW.kind = 'failed_attempt_refund_evidence' THEN
    -- Core V2 RLSC-1: the failed attempt's OWN verified refund fact, and a competing attempt of the same payment and capture that is effective NOW
    SELECT * INTO c FROM refund_attempt WHERE id = NEW."competingAttemptId";
    IF a.status <> 'failed'
       OR NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."factId" AND f.kind = 'refund' AND f."refundAttemptId" = a.id
                        AND f."paymentId" = a."paymentId")
       OR c.id IS NULL OR c.id = a.id OR c."paymentId" <> a."paymentId" OR c."captureFactId" <> a."captureFactId"
       OR c.status IN ('authorization_expired', 'authorization_refused', 'failed') THEN
      RAISE EXCEPTION 'refund_safety_escalation: fact % of failed attempt % has no effective competing attempt %', NEW."factId", a.id, NEW."competingAttemptId"
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
    NEW."competingAttemptStatus" := c.status;
  ELSIF NEW.kind = 'dispatch_stalled' THEN
    -- Core V2 G3 (DO-44): still stuck, never acknowledged by the provider, 72 hours after its authorization (database time); no evidence fact
    IF NOT refund_attempt_dispatch_stuck(a.status, a."submittedAt") OR a."authorizedAt" IS NULL
       OR now() < a."authorizedAt" + refund_dispatch_stalled_threshold() THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not stuck in dispatch past its threshold', a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_not_due';
    END IF;
    NEW."factId" := NULL;
  ELSIF NOT EXISTS (SELECT 1 FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId"
                     WHERE b."factId" = NEW."factId" AND b.reason = 'no_authorization' AND f."refundAttemptId" = a.id) THEN
    RAISE EXCEPTION 'refund_safety_escalation: fact % is not a no_authorization block of attempt %', NEW."factId", a.id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
  END IF;
  NEW."paymentId" := a."paymentId";
  NEW."companyId" := a."companyId";
  NEW."captureFactId" := a."captureFactId";
  NEW."attemptStatus" := a.status;
  NEW."escalatedAt" := now();
  RETURN NEW;
END $$;

CREATE TABLE refund_safety_escalation_exit (
  -- no foreign key: TRUNCATE refund_safety_escalation must keep meeting its own append-only trigger (0032), never an FK error first; the
  -- guard below refuses an exit of an escalation that does not exist, and escalations are never deleted
  "escalationId" uuid PRIMARY KEY,
  "exitedStatus" text NOT NULL,                       -- derived: the attempt's status when the exit was observed
  "observedAt"   timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION refund_safety_escalation_exit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e refund_safety_escalation%ROWTYPE; a refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO e FROM refund_safety_escalation WHERE id = NEW."escalationId";
  SELECT * INTO a FROM refund_attempt WHERE id = e."refundAttemptId";
  IF e.id IS NULL OR e.kind <> 'dispatch_stalled' OR a.id IS NULL OR refund_attempt_dispatch_stuck(a.status, a."submittedAt") THEN
    RAISE EXCEPTION 'refund_safety_escalation_exit: escalation % has no attempt that left the stuck state', NEW."escalationId"
      USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_exit_not_exited';
  END IF;
  NEW."exitedStatus" := a.status;
  NEW."observedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_safety_escalation_exit_05_guard BEFORE INSERT ON refund_safety_escalation_exit FOR EACH ROW EXECUTE FUNCTION refund_safety_escalation_exit_guard();
CREATE TRIGGER refund_safety_escalation_exit_10_append_only BEFORE UPDATE OR DELETE ON refund_safety_escalation_exit FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_safety_escalation_exit_11_no_truncate BEFORE TRUNCATE ON refund_safety_escalation_exit FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
