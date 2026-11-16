-- 0032 — payment-service: no outbound refund while refund evidence of the same capture exists; a durable, deduplicated escalation
-- (Core V2 DO-76 S1; the Owner's D-76-1, D-76-2 and D-76-4 of 2026-11-16). DEVELOPMENT AND SIMULATION ONLY. Expand only: one table, three
-- functions, three triggers. No existing row, column, constraint or privilege changes; nothing is backfilled.
--
-- DO-76 (register §7.2.6): the provider learns a refund attempt's id (the idempotency key) only once Payment commits `dispatching`. Verified refund
-- evidence of the attempt's capture that exists BEFORE that commit is therefore money the provider returned without Payment's dispatch (an
-- external refund under Payment's reference, a forged but correctly signed notification, or a provider error). Dispatching then may return the
-- same money a second time. The frozen per-capture rule `refund_capture_has_evidence` (0022) already refuses a NEW attempt in that situation;
-- this migration applies the SAME rule to the one remaining step that sends money: `authorized` -> `dispatching`.
--
--   * D-76-1 (hold). `authorized` -> `dispatching` is refused while `refund_capture_has_evidence(captureFactId)` holds, or once the attempt is held
--     (`refund_attempt_dispatch_hold`, 23514). The guard takes the payment row lock first: every writer of that evidence holds the same lock
--     (a refund fact: FOR SHARE in `RefundEvidenceService`; an association: FOR UPDATE in its 0021 insert guard), so evidence committed before
--     the transition is always seen and evidence written after it waits for it. The attempt stays `authorized`: no new status, no terminal state,
--     no money effect.
--   * D-76-2 (no automatic release). A hold is an append-only `refund_safety_escalation` row of kind `dispatch_held`; once it exists the attempt is
--     never dispatched by the database rule above, whatever later happens to the evidence (an association later refused, for example). Nothing
--     releases, abandons, resolves, allocates or retries it; a release would need its own approved contract.
--   * D-76-4 (escalation). Kind `refund_fact_without_authorization`: one row per refund fact blocked as `no_authorization` (S6c), written in the
--     block's transaction. It is an escalation for review, never a determination that a provider or secret was compromised.
--   * Each row derives its payment, Company, capture and the attempt's status from the attempt itself; a caller supplies only the kind, the attempt
--     and the evidence fact, and the database checks that the fact IS that evidence. At most one row per held attempt and per blocked fact.
--
-- Limits (recorded): evidence the provider has not reported yet is not visible to any rule (the external race); evidence that arrives after
-- `dispatching` keeps the existing S6b semantics; a superuser can bypass triggers.

CREATE TABLE refund_safety_escalation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  "refundAttemptId"  uuid NOT NULL REFERENCES refund_attempt (id),
  "factId"           uuid NOT NULL REFERENCES provider_transaction_fact (id),   -- the evidence escalated
  "paymentId"        uuid NOT NULL,                                            -- derived from the attempt
  "companyId"        uuid NOT NULL,                                            -- derived from the attempt
  "captureFactId"    uuid NOT NULL,                                            -- derived from the attempt
  "attemptStatus"    text NOT NULL,                                            -- the attempt's status when escalated (derived)
  "escalatedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_safety_escalation_kind CHECK (kind IN ('dispatch_held', 'refund_fact_without_authorization')),
  CONSTRAINT refund_safety_escalation_payment_binding FOREIGN KEY ("refundAttemptId", "paymentId") REFERENCES refund_attempt (id, "paymentId")
);
CREATE UNIQUE INDEX refund_safety_escalation_hold_once ON refund_safety_escalation ("refundAttemptId") WHERE kind = 'dispatch_held';
CREATE UNIQUE INDEX refund_safety_escalation_fact_once ON refund_safety_escalation ("factId") WHERE kind = 'refund_fact_without_authorization';
CREATE INDEX refund_safety_escalation_payment_idx ON refund_safety_escalation ("paymentId");

-- The evidence of a capture that `refund_capture_has_evidence` (0022) counts, oldest first: the same two sources, never a third.
CREATE FUNCTION refund_capture_evidence_facts(capture uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  SELECT x.id FROM (
    SELECT f.id, f."observedAt" FROM provider_transaction_fact f JOIN refund_attempt a ON a.id = f."refundAttemptId"
     WHERE f.kind = 'refund' AND a."captureFactId" = capture
    UNION
    SELECT f.id, f."observedAt" FROM provider_fact_association s JOIN refund_authorization z ON z.id = s."refundAuthorizationId"
      JOIN refund_attempt a ON a.id = z."refundAttemptId" JOIN provider_transaction_fact f ON f.id = s."factId"
     WHERE s.status IN ('authorization_pending', 'associated') AND a."captureFactId" = capture
  ) x ORDER BY x."observedAt", x.id
$$;

CREATE FUNCTION refund_safety_escalation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a refund_attempt%ROWTYPE;
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
CREATE TRIGGER refund_safety_escalation_05_insert_guard BEFORE INSERT ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION refund_safety_escalation_insert_guard();
CREATE TRIGGER refund_safety_escalation_10_append_only BEFORE UPDATE OR DELETE ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_safety_escalation_11_no_truncate BEFORE TRUNCATE ON refund_safety_escalation FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

-- D-76-1 at the database: the only transition that sends money waits for the payment row (the evidence writers' lock), then re-reads the evidence
CREATE FUNCTION refund_attempt_dispatch_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM refund_safety_escalation h WHERE h."refundAttemptId" = NEW.id AND h.kind = 'dispatch_held')
     OR refund_capture_has_evidence(NEW."captureFactId") THEN
    RAISE EXCEPTION 'refund_attempt %: refund evidence of capture % exists before dispatch; held for review', NEW.id, NEW."captureFactId"
      USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_dispatch_hold';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_09_dispatch_hold BEFORE UPDATE OF status ON refund_attempt
  FOR EACH ROW WHEN (OLD.status = 'authorized' AND NEW.status = 'dispatching') EXECUTE FUNCTION refund_attempt_dispatch_hold_guard();
