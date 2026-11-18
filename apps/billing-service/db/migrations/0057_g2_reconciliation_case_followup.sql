-- Core V2 G2 (DO-75 V2 and V3; the Owner's G3 + G2 GO, package C, 2026-11-18): append-only FOLLOW-UP evidence linked to an existing reconciliation case.
-- Additive only: two tables, their guards. No case, resolution, opening evidence, rule, status or figure changes; nothing is backfilled.
--
--   * reconciliation_case_followup: one row per (case, kind, Payment item) for evidence Payment states AFTER the case exists — a later observation of the
--     same refund attempt (V2, `refund_observation_conflict`) or a later contest of the same verified refund fact (V3, `refund_fact_contested`). The
--     evidence reference is Payment's own stable item id (PaymentItem.id: the provider_transaction_fact_conflict id). The guard derives the Company
--     from the case and refuses evidence of another payment, of another attempt (V2) or of another fact (V3), and the case's own opening evidence.
--   * reconciliation_case_opening_ref: the Payment item id that OPENED a `refund_fact_contested` case, recorded in the opening transaction from this
--     migration on (V2's is already reconciliation_observation_evidence."observationId"). A V3 case opened before this migration has none, so it
--     takes no follow-up (its opening item cannot be told apart: never misattributed; recorded limit).
--   * Nothing here reopens, supersedes, reallocates, refunds, reverses, abandons or amends a case or its resolution (FDR-08 level A only). A case
--     resolved before the evidence arrived keeps its resolution; the read derives "evidence after resolution" from the two times.
--   * DO-75 V1 / DO-77: a payment whose seller is not a Company has no case, so no follow-up (gated on Organization authority).

CREATE TABLE reconciliation_case_opening_ref (
  "caseId"      uuid PRIMARY KEY REFERENCES reconciliation_case (id),
  "evidenceRef" uuid NOT NULL,                                -- Payment's item id of the opening evidence
  "recordedAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION billing_reconciliation_opening_ref_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM reconciliation_case c WHERE c.id = NEW."caseId" AND c."caseType" = 'refund_fact_contested') THEN
    RAISE EXCEPTION 'reconciliation opening ref: case % is not a refund_fact_contested case', NEW."caseId"
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_opening_ref_case';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_opening_ref_05_guard BEFORE INSERT ON reconciliation_case_opening_ref FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_opening_ref_guard();
CREATE TRIGGER reconciliation_case_opening_ref_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_case_opening_ref FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_case_opening_ref_11_no_truncate BEFORE TRUNCATE ON reconciliation_case_opening_ref FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

CREATE TABLE reconciliation_case_followup (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "caseId"           uuid NOT NULL REFERENCES reconciliation_case (id),
  "evidenceKind"     text NOT NULL,                           -- refund_observation (V2) | refund_contest (V3)
  "evidenceRef"      uuid NOT NULL,                           -- Payment's stable item id (PaymentItem.id)
  "paymentId"        uuid NOT NULL,                           -- the item's payment: must be the case's
  "refundAttemptId"  uuid,                                    -- the observing attempt as Payment states it (V2: must be the case's attempt)
  "factId"           uuid,                                    -- V3: the contested fact (must be the case's); V2: none
  "itemObservedAt"   timestamptz,                             -- Payment's own time for the item, as Payment states it (navigation only)
  "companyId"        uuid NOT NULL,                           -- derived from the case
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_case_followup_kind CHECK ("evidenceKind" IN ('refund_observation', 'refund_contest')),
  CONSTRAINT reconciliation_case_followup_shape CHECK (("evidenceKind" = 'refund_contest') = ("factId" IS NOT NULL)
    AND ("evidenceKind" <> 'refund_observation' OR "refundAttemptId" IS NOT NULL)),
  CONSTRAINT reconciliation_case_followup_once UNIQUE ("caseId", "evidenceKind", "evidenceRef")
);
CREATE INDEX reconciliation_case_followup_case_idx ON reconciliation_case_followup ("caseId", "recordedAt");

CREATE FUNCTION billing_reconciliation_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c reconciliation_case%ROWTYPE; opening uuid;
BEGIN
  SELECT * INTO c FROM reconciliation_case WHERE id = NEW."caseId";
  IF c.id IS NULL OR c."paymentId" IS DISTINCT FROM NEW."paymentId"
     OR (NEW."evidenceKind" = 'refund_observation' AND (c."caseType" <> 'refund_observation_conflict' OR c."evidenceKey" <> NEW."refundAttemptId"))
     OR (NEW."evidenceKind" = 'refund_contest' AND (c."caseType" <> 'refund_fact_contested' OR c."evidenceKey" <> NEW."factId")) THEN
    RAISE EXCEPTION 'reconciliation follow-up: evidence % is not of case % (its payment, attempt or fact)', NEW."evidenceRef", NEW."caseId"
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_followup_evidence';
  END IF;
  opening := CASE WHEN NEW."evidenceKind" = 'refund_observation'
                  THEN (SELECT e."observationId" FROM reconciliation_observation_evidence e WHERE e."caseId" = c.id)
                  ELSE (SELECT o."evidenceRef" FROM reconciliation_case_opening_ref o WHERE o."caseId" = c.id) END;
  IF opening IS NULL OR opening = NEW."evidenceRef" THEN
    RAISE EXCEPTION 'reconciliation follow-up: % is the opening evidence of case %, or the case has no recorded opening evidence', NEW."evidenceRef", c.id
      USING ERRCODE = '23514', CONSTRAINT = 'reconciliation_case_followup_opening';
  END IF;
  NEW."companyId" := c."companyId";
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_case_followup_05_guard BEFORE INSERT ON reconciliation_case_followup FOR EACH ROW EXECUTE FUNCTION billing_reconciliation_followup_guard();
CREATE TRIGGER reconciliation_case_followup_10_append_only BEFORE UPDATE OR DELETE ON reconciliation_case_followup FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER reconciliation_case_followup_11_no_truncate BEFORE TRUNCATE ON reconciliation_case_followup FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
