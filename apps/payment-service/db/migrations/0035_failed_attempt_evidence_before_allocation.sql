-- 0035 — payment-service: a FAILED attempt's own refund fact is never allocated before its RLSC-1 evidence decision is durably committed
-- (Core V2 D-R3; the Owner's D-R3 GO of 2026-11-23, bounded technical safeguard). DEVELOPMENT AND SIMULATION ONLY. Expand only: one function and
-- one BEFORE INSERT trigger on `refund_allocation`. No table, column, status, escalation kind, index or privilege is added or weakened; nothing is
-- backfilled; no allocation arithmetic, case rule, replacement eligibility or provider-finality assumption changes.
--
-- The gap (OD-RLSC-1 probe P2): a verified refund fact is recorded in its own transaction (FC-1), BEFORE the evidence decision that, for a `failed`
-- attempt, either keeps it as a `failed_attempt_refund_evidence` escalation (another attempt is effective; RLSC-1, 0033) or moves the attempt to
-- `discrepancy` (S6b). The refund worker sweeps pending facts independently, so between those two transactions, or after the decision failed
-- (a rolled-back escalation transaction answers the webhook 500), it could allocate the fact and complete the refund case with no escalation.
--
-- The rule: inserting the allocation of a DIRECT refund fact (its own payment and refund attempt) whose attempt is `failed` requires that fact's
-- `failed_attempt_refund_evidence` row. Once the decision commits, either the row exists (the allocation is the unchanged S6c / R6C-4 one) or the
-- attempt is `discrepancy` (not `failed`: unchanged). An associated unmatched fact (S6h, R6H-3) is not a direct fact and is unchanged.
--
-- Concurrency: every move to `failed` and the evidence decision take the payment row lock (`lockAttempt`), and the allocation takes the same lock
-- before it inserts (FC-2 lock order), so the status and the escalation this trigger reads are those of a committed decision, on every instance.
-- The trigger takes that payment lock itself, so an insert that skipped the application's check is serialized the same way. An escalation and an
-- allocation in ONE transaction commit together (never one without the other). The application checks the same condition first and defers the
-- fact (bounded backoff on its lease, the fact kept pending); the refund worker then makes the stored fact's evidence decision itself (the same
-- code as the report's) when the report's processing never committed it. This trigger is the backstop (`23514`,
-- `refund_allocation_failed_attempt_evidence`). A superuser can bypass triggers.

CREATE FUNCTION refund_allocation_failed_attempt_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the payment row lock every move to `failed` and every evidence decision take (the allocation already holds it): the reads below, each a new
  -- statement, then see only committed decisions, even for an insert that skipped the application's own check
  PERFORM 1 FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact f JOIN refund_attempt a ON a.id = f."refundAttemptId" AND a."paymentId" = f."paymentId"
              WHERE f.id = NEW."factId" AND f.kind = 'refund' AND f."paymentId" IS NOT NULL AND a.status = 'failed')
     AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation e WHERE e."factId" = NEW."factId" AND e.kind = 'failed_attempt_refund_evidence') THEN
    RAISE EXCEPTION 'refund_allocation: a failed attempt''s refund fact needs its failed_attempt_refund_evidence before allocation'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_allocation_failed_attempt_evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refund_allocation_06_failed_attempt_evidence BEFORE INSERT ON refund_allocation
  FOR EACH ROW EXECUTE FUNCTION refund_allocation_failed_attempt_evidence_guard();
