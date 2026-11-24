-- 0038 — payment-service: an Owner-visible escalation when D-R1B refuses to dispatch an already-authorized refund attempt (Core V2 D-R1C; the
-- Owner's GO of 2026-11-24, Q5 and Q6). DEVELOPMENT AND SIMULATION ONLY. ESCALATION ONLY: expand only, after 0033/0034/0036's precedent. No refund,
-- dispatch, replacement, finality, allocation, case, hold or release rule changes; no existing row is rewritten; nothing is backfilled.
--
--   * Kind `dispatch_blocked`: the attempt is `authorized`, not held, and D-R1B refused its dispatch because another attempt of the same money may still
--     pay. One row per attempt and blocking cause. The blocking attempt is recorded in "competingAttemptId" (0033's columns, now for two kinds); no fact.
--   * "blockingCause" (six values) and its derived "causeBasis":
--       - `database_verified`: `prior_may_still_pay`, `last_capture_may_still_pay`. The guard recomputes 0037's refusal for the attempt and requires
--         it to be exactly this cause, and the blocker to be in the cause's scope and still able to pay.
--       - `producer_derived`: `prior_registry_not_final`, `last_capture_registry_not_final` (the code registry no longer certifies the blocker's
--         finality), `prior_evidence_unresolved`, `last_capture_evidence_unresolved` (R3 evidence under the blocker is pending or unknown). The database
--         cannot recompute these; it checks the scope and that the blocker is `failed`. Such a row only adds a review item: it permits nothing.
--   * "blockingReason": the producer's bounded reason code (evidence of why, never an instruction).
--   * The exit (0034's `refund_safety_escalation_exit`) is observed once when the attempt has left `authorized`. An exit is an observation only:
--     never proof of provider finality, settlement, financial resolution or release.
--   * Lock order: the caller holds the payment row and the attempt row (the refund worker's dispatch transaction); the guard takes 0037's capability lock
--     shared, last. A superuser can bypass triggers.

ALTER TABLE refund_safety_escalation ADD COLUMN "blockingCause" text;   -- dispatch_blocked only
ALTER TABLE refund_safety_escalation ADD COLUMN "causeBasis" text;      -- dispatch_blocked only; derived
ALTER TABLE refund_safety_escalation ADD COLUMN "blockingReason" text;  -- dispatch_blocked only; the producer's bounded reason
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_blocking_shape
  CHECK ((kind = 'dispatch_blocked') = ("blockingCause" IS NOT NULL)
     AND (kind = 'dispatch_blocked') = ("causeBasis" IS NOT NULL)
     AND (kind = 'dispatch_blocked') = ("blockingReason" IS NOT NULL)
     AND ("blockingCause" IS NULL OR "blockingCause" IN ('prior_may_still_pay', 'last_capture_may_still_pay', 'prior_registry_not_final',
          'last_capture_registry_not_final', 'prior_evidence_unresolved', 'last_capture_evidence_unresolved'))
     AND ("causeBasis" IS NULL OR "causeBasis" = CASE WHEN "blockingCause" IN ('prior_may_still_pay', 'last_capture_may_still_pay') THEN 'database_verified' ELSE 'producer_derived' END)
     AND ("blockingReason" IS NULL OR "blockingReason" ~ '^[a-z][a-z0-9_]{0,63}$'));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_fact_shape;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_fact_shape
  CHECK ((kind IN ('dispatch_stalled', 'idempotency_retention_unproven', 'dispatch_blocked')) = ("factId" IS NULL));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_competing_shape;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_competing_shape
  CHECK ((kind IN ('failed_attempt_refund_evidence', 'dispatch_blocked')) = ("competingAttemptId" IS NOT NULL)
     AND ("competingAttemptId" IS NULL) = ("competingAttemptStatus" IS NULL));

ALTER TABLE refund_safety_escalation DROP CONSTRAINT refund_safety_escalation_kind;
ALTER TABLE refund_safety_escalation ADD CONSTRAINT refund_safety_escalation_kind
  CHECK (kind IN ('dispatch_held', 'refund_fact_without_authorization', 'failed_attempt_refund_evidence', 'dispatch_stalled',
                  'failure_after_refund_evidence', 'idempotency_retention_unproven', 'dispatch_blocked'));
CREATE UNIQUE INDEX refund_safety_escalation_dispatch_blocked_once ON refund_safety_escalation ("refundAttemptId", "blockingCause") WHERE kind = 'dispatch_blocked';

-- 0036's guard, with one more branch; its six existing branches are textually unchanged.
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
  ELSIF NEW.kind = 'failure_after_refund_evidence' THEN
    -- Core V2 D-R1A (Q4): the attempt's OWN verified refund fact exists, and the attempt was sent (any state after dispatch)
    IF a.status NOT IN ('dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy', 'failed')
       OR NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."factId" AND f.kind = 'refund' AND f."refundAttemptId" = a.id
                        AND f."paymentId" = a."paymentId") THEN
      RAISE EXCEPTION 'refund_safety_escalation: fact % is not verified refund evidence of attempt % in a state a failure report can contradict', NEW."factId", a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
  ELSIF NEW.kind = 'idempotency_retention_unproven' THEN
    -- Core V2 D-R1A (Q5): only an attempt whose key may already be at the provider and that the worker would otherwise send again; no evidence fact
    IF a.status NOT IN ('dispatching', 'unknown') OR a."authorizedAt" IS NULL THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not awaiting a same-key resend', a.id
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_evidence';
    END IF;
    NEW."factId" := NULL;
  ELSIF NEW.kind = 'dispatch_blocked' THEN
    -- Core V2 D-R1C (0038): an AUTHORIZED attempt, not held, whose dispatch D-R1B refuses; the blocker is ANOTHER attempt in the cause's scope.
    -- Database causes are recomputed here exactly (0037's refusal and the blocker's may-still-pay); producer causes are checked for scope only.
    PERFORM refund_require_read_committed();
    PERFORM pg_advisory_xact_lock_shared(refund_capability_lock_key());   -- last, after the caller's payment and attempt locks (0037 lock order)
    SELECT * INTO c FROM refund_attempt WHERE id = NEW."competingAttemptId";
    IF a.status <> 'authorized'
       OR EXISTS (SELECT 1 FROM refund_safety_escalation h WHERE h."refundAttemptId" = a.id AND h.kind = 'dispatch_held')
       OR c.id IS NULL OR c.id = a.id OR c."paymentId" <> a."paymentId"
       -- every test is COALESCEd: a NULL (an unknown blocker field, a NULL refusal) is never read as "not refused"
       OR NOT COALESCE(CASE
         WHEN NEW."blockingCause" IN ('prior_may_still_pay', 'prior_registry_not_final', 'prior_evidence_unresolved') THEN
           c."captureFactId" = a."captureFactId" OR (NOT c."captureSpecific" AND NOT a."captureSpecific")
         WHEN NEW."blockingCause" IN ('last_capture_may_still_pay', 'last_capture_registry_not_final', 'last_capture_evidence_unresolved') THEN
           a."captureSpecific" AND EXISTS (
             SELECT 1 FROM payment p JOIN provider_transaction_fact f ON f.id = a."captureFactId" AND f."paymentId" = p.id AND f."attemptId" = p."succeededAttemptId"
               JOIN provider_transaction_fact g ON g."paymentId" = p.id AND g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id
              WHERE p.id = a."paymentId" AND p.status = 'succeeded' AND g.id = c."captureFactId")
         ELSE false END, false)
       OR NOT COALESCE(CASE
         WHEN NEW."blockingCause" IN ('prior_may_still_pay', 'last_capture_may_still_pay') THEN
           refund_attempt_replacement_refusal(a.id, a."paymentId", a."captureFactId", a."captureSpecific", clock_timestamp()) = 'refund_attempt_' || NEW."blockingCause"
           AND refund_attempt_may_still_pay(c.id, clock_timestamp())
         ELSE c.status = 'failed' END, false) THEN
      RAISE EXCEPTION 'refund_safety_escalation: attempt % is not blocked at dispatch by attempt % (%)', a.id, NEW."competingAttemptId", NEW."blockingCause"
        USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_dispatch_blocked';
    END IF;
    NEW."factId" := NULL;
    NEW."competingAttemptStatus" := c.status;
    NEW."causeBasis" := CASE WHEN NEW."blockingCause" IN ('prior_may_still_pay', 'last_capture_may_still_pay') THEN 'database_verified' ELSE 'producer_derived' END;
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

-- 0034's exit guard, extended: a `dispatch_blocked` escalation exits once its attempt is no longer `authorized` (the `dispatch_stalled` branch unchanged).
CREATE OR REPLACE FUNCTION refund_safety_escalation_exit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e refund_safety_escalation%ROWTYPE; a refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO e FROM refund_safety_escalation WHERE id = NEW."escalationId";
  SELECT * INTO a FROM refund_attempt WHERE id = e."refundAttemptId";
  IF e.id IS NULL OR a.id IS NULL
     OR (e.kind = 'dispatch_stalled' AND refund_attempt_dispatch_stuck(a.status, a."submittedAt"))
     OR (e.kind = 'dispatch_blocked' AND a.status = 'authorized')
     OR e.kind NOT IN ('dispatch_stalled', 'dispatch_blocked') THEN
    RAISE EXCEPTION 'refund_safety_escalation_exit: escalation % has no attempt that left the escalated state', NEW."escalationId"
      USING ERRCODE = '23514', CONSTRAINT = 'refund_safety_escalation_exit_not_exited';
  END IF;
  NEW."exitedStatus" := a.status;
  NEW."observedAt" := now();
  RETURN NEW;
END $$;
