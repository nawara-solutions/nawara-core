-- 0055 — billing-service: credible refund evidence after a FAILED refund attempt holds a loss's automatic financial effect (Core V2 R3; the Owner's GO
-- 2026-11-10; register BIL-33 R). DEVELOPMENT AND SIMULATION ONLY. Expand only: two append-only tables, their guards, new functions and three replaced
-- functions. No existing row is written, rewritten or deleted; every existing guard keeps refusing what it refused.
--
--   * `refund_relay_failure_evidence`: a durable, append-only record that a financial RISK was observed for one of Billing's own relays: Payment stated,
--     for that failed attempt, a verified unmatched refund fact or a signature-verified refund notification under the attempt's own provider refund
--     reference (PAY-08 I). It is not a mirror of Payment's current state, never changes, never disappears and is never cleared automatically. It holds
--     nothing of the fact or notification (no id, figure, reference, payment or Company of it).
--   * `loss_effect_attestation`: the per-decision proof that a fresh PAY-08 read, started after the loss was recorded and recently, stated `none` for every
--     relay of the loss's captured movement that is mirrored `failed`. Bound to the dispute, the effect, the loss's payment and capture (copied by the guard,
--     never supplied) and the CURRENT transaction (`pg_current_xact_id()`): it authorizes at most one effect insert in the transaction that wrote it, and is
--     never reusable by another transaction, loss, effect or movement. Unique per (dispute, effect, transaction): a no-op or rolled-back decision never
--     blocks a later one.
--   * The two approved effect inserts (`financial_loss` of kind `direct_chargeback_write_off`, `recovery_obligation`) now also require, in the inserting
--     transaction, that attestation and the absence of any marker on the movement's relays (fail-closed by absence AND by presence). The movement's relays
--     are share-locked first, so a marker committed meanwhile is seen. Refusals keep the EXISTING constraint names (`financial_loss_refund_live`,
--     `recovery_obligation_refund_live`): an older Billing already treats them as "waiting".
--   * `billing_loss_unresolved_exposure` also counts a marker of the movement: evidence found after an effect committed opens the existing
--     `chargeback_refund_exposure` case; nothing is rewritten.
-- WHAT THE DATABASE CANNOT AUTHENTICATE: that Payment really answered `none`. A writer with INSERT rights (`billing_app`) could forge an attestation; it is
-- still refused while a marker exists. Owners and superusers can bypass any trigger. These constraints establish local consistency, not provider truth.
-- Nothing here associates, allocates, completes, reverses or writes off anything, assigns liability, changes collection, or resolves FD-1 to FD-8, D9, D15.

-- ─── shared reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

-- the relays of the loss's captured movement (the same movement rule as S0-C14's billing_loss_refund_live)
CREATE FUNCTION billing_loss_movement_relays(p_dispute uuid) RETURNS SETOF uuid LANGUAGE sql STABLE AS $$
  SELECT x.id FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId" JOIN payment_dispute_loss l ON l."disputeId" = p_dispute
   WHERE r."paymentId" = l."paymentId" AND billing_refund_case_on_loss_movement(r.id, p_dispute);
$$;

-- the movement's relays mirrored `failed`, sorted (what an attestation must have cleared)
CREATE FUNCTION billing_loss_movement_failed_relays(p_dispute uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}'::uuid[]) FROM refund_authorization_relay x
   WHERE x.id IN (SELECT billing_loss_movement_relays(p_dispute)) AND x."attemptStatus" = 'failed';
$$;

-- ─── markers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE refund_relay_failure_evidence (
  "relayId"     uuid PRIMARY KEY REFERENCES refund_authorization_relay (id), -- one marker per observing failed attempt (Billing's own relay)
  "paymentId"   uuid NOT NULL,
  "firstState"  text NOT NULL,                                               -- what Payment stated when the risk was first observed
  "recordedAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_relay_failure_evidence_state CHECK ("firstState" IN ('unmatched_fact', 'notification_pending'))
);

CREATE FUNCTION billing_refund_relay_failure_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x refund_authorization_relay%ROWTYPE;
BEGIN
  SELECT * INTO x FROM refund_authorization_relay WHERE id = NEW."relayId";
  IF NOT FOUND OR x."paymentId" IS DISTINCT FROM NEW."paymentId" THEN
    RAISE EXCEPTION 'failure evidence: the relay is not one of this payment''s' USING ERRCODE = '23514', CONSTRAINT = 'refund_relay_failure_evidence_payment';
  END IF;
  IF x."attemptStatus" IS DISTINCT FROM 'failed' AND x."attemptStatus" IS DISTINCT FROM 'discrepancy' THEN
    RAISE EXCEPTION 'failure evidence: the relay''s attempt has not failed' USING ERRCODE = '23514', CONSTRAINT = 'refund_relay_failure_evidence_status';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_relay_failure_evidence_05_guard BEFORE INSERT ON refund_relay_failure_evidence FOR EACH ROW EXECUTE FUNCTION billing_refund_relay_failure_evidence_guard();
CREATE TRIGGER refund_relay_failure_evidence_10_append_only BEFORE UPDATE OR DELETE ON refund_relay_failure_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER refund_relay_failure_evidence_11_no_truncate BEFORE TRUNCATE ON refund_relay_failure_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

CREATE FUNCTION billing_loss_movement_marked(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM refund_relay_failure_evidence m WHERE m."relayId" IN (SELECT billing_loss_movement_relays(p_dispute)));
$$;

-- ─── attestations ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE loss_effect_attestation (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "disputeId"             uuid NOT NULL REFERENCES payment_dispute_loss ("disputeId"),
  effect                  text NOT NULL,
  "paymentId"             uuid NOT NULL,          -- copied from the loss, never supplied
  "captureFactId"         uuid,                   -- copied from the loss, never supplied
  "captureBasis"          text NOT NULL,          -- copied from the loss, never supplied
  "clearRelays"           uuid[] NOT NULL,        -- computed: the movement's relays mirrored `failed`
  "clearedByRead"         uuid[] NOT NULL,        -- supplied: the relays the read stated `none` for
  "paymentReadStartedAt"  timestamptz NOT NULL,   -- supplied: when that read started
  xact                    xid8 NOT NULL,          -- the inserting transaction, never supplied
  "recordedAt"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loss_effect_attestation_effect CHECK (effect IN ('direct_chargeback_write_off', 'recovery_obligation')),
  CONSTRAINT loss_effect_attestation_once UNIQUE ("disputeId", effect, xact)
);

CREATE FUNCTION billing_loss_effect_attestation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l payment_dispute_loss%ROWTYPE;
BEGIN
  IF NEW."paymentId" IS NOT NULL OR NEW."captureFactId" IS NOT NULL OR NEW."captureBasis" IS NOT NULL OR NEW."clearRelays" IS NOT NULL OR NEW.xact IS NOT NULL THEN
    RAISE EXCEPTION 'attestation: the movement, its failed relays and the transaction are derived, never supplied' USING ERRCODE = '23514', CONSTRAINT = 'loss_effect_attestation_supplied';
  END IF;
  SELECT * INTO l FROM payment_dispute_loss WHERE "disputeId" = NEW."disputeId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attestation: no verified loss %', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'loss_effect_attestation_loss';
  END IF;
  NEW."paymentId" := l."paymentId";
  NEW."captureFactId" := l."captureFactId";
  NEW."captureBasis" := l."captureBasis";
  NEW.xact := pg_current_xact_id();
  NEW."clearRelays" := billing_loss_movement_failed_relays(NEW."disputeId");
  IF NEW."clearedByRead" IS NULL OR NOT (NEW."clearedByRead" @> NEW."clearRelays") THEN
    RAISE EXCEPTION 'attestation: a failed relay of the movement was not stated clear by the read' USING ERRCODE = '23514', CONSTRAINT = 'loss_effect_attestation_relays';
  END IF;
  IF NEW."paymentReadStartedAt" < l."recordedAt" OR NEW."paymentReadStartedAt" < transaction_timestamp() - interval '120 seconds'
     OR NEW."paymentReadStartedAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'attestation: the read did not start after the loss and recently' USING ERRCODE = '23514', CONSTRAINT = 'loss_effect_attestation_stale';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER loss_effect_attestation_05_guard BEFORE INSERT ON loss_effect_attestation FOR EACH ROW EXECUTE FUNCTION billing_loss_effect_attestation_guard();
CREATE TRIGGER loss_effect_attestation_10_append_only BEFORE UPDATE OR DELETE ON loss_effect_attestation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER loss_effect_attestation_11_no_truncate BEFORE TRUNCATE ON loss_effect_attestation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─── the effect guards ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

-- why an effect insert of `p_effect` for the loss may not proceed in THIS transaction (NULL: it may, as far as R3 is concerned). Share-locks the movement's
-- relays first (id order): a marker transaction holds its relay FOR UPDATE, so a marker committed before this lock is granted is seen by the next statement.
CREATE FUNCTION billing_loss_effect_refusal(p_dispute uuid, p_effect text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM 1 FROM refund_authorization_relay x WHERE x.id IN (SELECT billing_loss_movement_relays(p_dispute)) ORDER BY x.id FOR SHARE;
  IF billing_loss_movement_marked(p_dispute) THEN
    RETURN 'refund_evidence_after_failure';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM loss_effect_attestation a WHERE a."disputeId" = p_dispute AND a.effect = p_effect AND a.xact = pg_current_xact_id()
                    AND a."clearRelays" = billing_loss_movement_failed_relays(p_dispute)) THEN
    RETURN 'effect_not_attested';
  END IF;
  RETURN NULL;
END $$;

-- 0050's guards, R3 first (its lock, then a fresh statement for S0-C14's local checks)
CREATE OR REPLACE FUNCTION billing_recovery_obligation_refund_live_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
  why := billing_loss_effect_refusal(NEW."disputeId", 'recovery_obligation');
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'recovery obligation: % for loss % (Core V2 R3)', why, NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_refund_live';
  END IF;
  IF billing_loss_refund_live(NEW."disputeId") OR billing_loss_overlap(NEW."disputeId") THEN
    RAISE EXCEPTION 'recovery obligation: a refund of the captured movement of loss % is live or completed (S0-C14 items 5, 6)', NEW."disputeId"
      USING ERRCODE = '23514', CONSTRAINT = 'recovery_obligation_refund_live';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing_financial_loss_refund_live_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE why text;
BEGIN
  IF NEW.kind = 'direct_chargeback_write_off' THEN
    why := billing_loss_effect_refusal(NEW."disputeId", 'direct_chargeback_write_off');
    IF why IS NOT NULL THEN
      RAISE EXCEPTION 'financial loss: % for loss % (Core V2 R3)', why, NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_refund_live';
    END IF;
    IF billing_loss_refund_live(NEW."disputeId") OR billing_loss_overlap(NEW."disputeId") THEN
      RAISE EXCEPTION 'financial loss: a refund of the captured movement of loss % is live or completed (S0-C14 items 5, 6)', NEW."disputeId"
        USING ERRCODE = '23514', CONSTRAINT = 'financial_loss_refund_live';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 0051's exposure, plus a marker of the movement (late evidence: the effect stands, the exposure case opens)
CREATE OR REPLACE FUNCTION billing_loss_unresolved_exposure(p_dispute uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM payment_dispute_loss l
     WHERE l."disputeId" = p_dispute AND l."chargebackFactId" IS NOT NULL AND NOT billing_loss_overlap(p_dispute)
       AND (EXISTS (
              SELECT 1 FROM refund_authorization_relay x JOIN refund_case r ON r.id = x."refundCaseId"
               WHERE r."paymentId" = l."paymentId" AND billing_refund_case_on_loss_movement(r.id, p_dispute)
                 AND (x."attemptStatus" = 'discrepancy' OR (x."attemptStatus" = 'succeeded' AND r.status <> 'completed')))
            OR EXISTS (
              SELECT 1 FROM reconciliation_case k
               WHERE k."caseType" = 'refund_discrepancy' AND k."paymentId" = l."paymentId"
                 AND (NOT EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x.id = k."evidenceKey")
                      OR EXISTS (SELECT 1 FROM refund_authorization_relay x WHERE x.id = k."evidenceKey"
                                    AND billing_refund_case_on_loss_movement(x."refundCaseId", p_dispute))))
            OR billing_loss_movement_marked(p_dispute))
  );
$$;
