-- Core V2 S6h-P (register PAY-12, PAY-13, EVT-10; S0 FC-1, FC-2, FC-5; ADR-0035 C2; the Owner's R6H-1 to R6H-12, 2026-10-30), for Core V2
-- DEVELOPMENT AND SIMULATION ONLY. Payment's financial evidence for reconciliation:
--   * R6H-3 (FC-1): a verified provider money movement survives even when its payment and attempt are unknown. An UNMATCHED fact has no
--     payment and no attempt, and only ever comes from a signature-verified, stored webhook of the same provider (a provider status read is
--     always about a known attempt), as a `capture` or a `refund`, with its immutable identity, amount, currency and provenance. A fact is
--     never refused, edited or deleted; matched facts keep every S4d / S6b / S6e rule unchanged.
--   * R6H-3 (FC-2, PAY-13): an unmatched fact is associated later only by an append-only association, by the live Owner of the destination's
--     seller Company with Auth's `provider_fact_associate` receipt, consumed once under the association's id: one live association per fact,
--     and only a destination whose kind, currency, amount and provider match the fact. The fact itself never changes.
--   * an associated `refund` fact is allocated by the S6c worker against its destination authorization, under the same FC-2 arithmetic; the
--     allocation guard admits it only through its association (the one gap of the 0018 guard, where a NULL attempt compared as unknown, is
--     closed).
--   * R6H-4: `payment_late_success` is unchanged; its event `payment.late_success.recorded` is written to the outbox in the recording transaction.
-- No backfill: rows recorded before S6h keep their meaning.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── unmatched verified facts (R6H-3)

ALTER TABLE provider_transaction_fact ALTER COLUMN "paymentId" DROP NOT NULL;
ALTER TABLE provider_transaction_fact ALTER COLUMN "attemptId" DROP NOT NULL;
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_matched_shape CHECK (("paymentId" IS NULL) = ("attemptId" IS NULL));
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_unmatched_shape CHECK (
  "paymentId" IS NOT NULL
  OR (kind IN ('capture', 'refund') AND source = 'webhook' AND "webhookEventId" IS NOT NULL AND "refundAttemptId" IS NULL AND "disputeId" IS NULL));
-- a MATCHED refund fact names its refund attempt; an unmatched one cannot (it is associated instead)
ALTER TABLE provider_transaction_fact DROP CONSTRAINT provider_transaction_fact_refund_attempt;
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_refund_attempt CHECK (((kind = 'refund') AND "paymentId" IS NOT NULL) = ("refundAttemptId" IS NOT NULL));
CREATE INDEX provider_transaction_fact_unmatched_idx ON provider_transaction_fact ("observedAt", id) WHERE "paymentId" IS NULL;

CREATE OR REPLACE FUNCTION provider_transaction_fact_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE am boolean;
BEGIN
  IF NEW."webhookEventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_event w WHERE w.id = NEW."webhookEventId" AND w.provider = NEW.provider) THEN
    RAISE EXCEPTION 'provider fact: its webhook event is not from provider %', NEW.provider USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_webhook_provider';
  END IF;
  -- Core V2 S6h (R6H-3): an unmatched fact only from a stored (so signature-verified) webhook that claimed exactly this money movement
  IF NEW."paymentId" IS NULL AND NOT EXISTS (
    SELECT 1 FROM webhook_event w WHERE w.id = NEW."webhookEventId" AND w."eventType" = CASE NEW.kind WHEN 'capture' THEN 'payment.succeeded' ELSE 'refund.succeeded' END) THEN
    RAISE EXCEPTION 'provider fact: an unmatched fact needs its verified webhook of the same movement' USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_unmatched_webhook';
  END IF;
  SELECT "liveMode" INTO am FROM payment_attempt WHERE id = NEW."attemptId";
  IF am IS NOT NULL AND am <> NEW."liveMode" THEN
    RAISE EXCEPTION 'provider fact: its mode differs from its attempt''s' USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_attempt_mode';
  END IF;
  NEW."observedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── association (R6H-3, PAY-13)

CREATE TABLE provider_fact_association (
  id                        uuid PRIMARY KEY,                              -- also the Auth consumeRef
  "factId"                  uuid NOT NULL REFERENCES provider_transaction_fact (id),
  "targetType"              text NOT NULL,
  "paymentId"               uuid NOT NULL REFERENCES payment (id),         -- the destination payment (or the destination authorization's)
  "refundAuthorizationId"   uuid REFERENCES refund_authorization (id),
  "companyId"               uuid NOT NULL,
  "requestedByUserId"       uuid NOT NULL,
  "idempotencyKey"          text NOT NULL,
  "receiptDigest"           char(64) NOT NULL,                             -- sha-256 of the receipt secret, never the secret
  status                    text NOT NULL DEFAULT 'authorization_pending',
  refusal                   text,
  "receiptId"               uuid UNIQUE,
  "approvedByUserId"        uuid,
  "requestedAt"             timestamptz NOT NULL DEFAULT now(),
  "associatedAt"            timestamptz,
  CONSTRAINT provider_fact_association_target CHECK (
    ("targetType" = 'payment' AND "refundAuthorizationId" IS NULL) OR ("targetType" = 'refund_authorization' AND "refundAuthorizationId" IS NOT NULL)),
  CONSTRAINT provider_fact_association_status CHECK (status IN ('authorization_pending', 'associated', 'authorization_refused', 'authorization_expired')),
  CONSTRAINT provider_fact_association_shape CHECK (
    (status = 'associated') = ("receiptId" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "associatedAt" IS NOT NULL)
    AND (status IN ('authorization_refused', 'authorization_expired')) = (refusal IS NOT NULL)),
  CONSTRAINT provider_fact_association_approver CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" = "requestedByUserId"),
  CONSTRAINT provider_fact_association_key UNIQUE ("requestedByUserId", "idempotencyKey")
);
-- one live (pending or recorded) association per fact: a fact is never associated twice, nor reassociated
CREATE UNIQUE INDEX provider_fact_association_live ON provider_fact_association ("factId") WHERE status IN ('authorization_pending', 'associated');
CREATE INDEX provider_fact_association_payment_idx ON provider_fact_association ("paymentId");

-- the destination is re-checked by the database, under the fact's and the destination's row locks
CREATE FUNCTION provider_fact_association_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f provider_transaction_fact%ROWTYPE; p payment%ROWTYPE; z refund_authorization%ROWTYPE; a refund_attempt%ROWTYPE;
BEGIN
  IF NEW.status <> 'authorization_pending' OR NEW."receiptId" IS NOT NULL OR NEW."approvedByUserId" IS NOT NULL OR NEW."associatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'provider fact association: created pending' USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_created_pending';
  END IF;
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."factId";
  IF f."paymentId" IS NOT NULL THEN
    RAISE EXCEPTION 'provider fact %: already matched to its payment', NEW."factId" USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_unmatched';
  END IF;
  SELECT * INTO p FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  IF p."sellerType" <> 'company' OR p."sellerId" <> NEW."companyId"::text OR p."liveMode" IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'provider fact association: the destination is not this Company''s simulation payment' USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_company';
  END IF;
  IF NEW."targetType" = 'payment' THEN
    -- a capture of this payment: its own amount and currency, through a provider this payment has used
    IF f.kind <> 'capture' OR f.amount <> p.amount OR f.currency <> trim(p.currency)
       OR NOT EXISTS (SELECT 1 FROM payment_attempt t WHERE t."paymentId" = p.id AND t.provider = f.provider) THEN
      RAISE EXCEPTION 'provider fact association: fact % is not a capture of payment %', f.id, p.id USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_match';
    END IF;
  ELSE
    -- a refund under this authorization: its currency, through the provider its refund attempt used (the amount is FC-2's allocation's)
    SELECT * INTO z FROM refund_authorization WHERE id = NEW."refundAuthorizationId" FOR UPDATE;
    SELECT * INTO a FROM refund_attempt WHERE id = z."refundAttemptId";
    IF z.id IS NULL OR z."paymentId" <> p.id OR f.kind <> 'refund' OR f.currency <> trim(z.currency) OR a.provider IS DISTINCT FROM f.provider THEN
      RAISE EXCEPTION 'provider fact association: fact % is not a refund under authorization %', f.id, NEW."refundAuthorizationId" USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_match';
    END IF;
  END IF;
  NEW."requestedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER provider_fact_association_05_insert_guard BEFORE INSERT ON provider_fact_association FOR EACH ROW EXECUTE FUNCTION provider_fact_association_insert_guard();

-- pending -> associated | authorization_refused | authorization_expired, once; nothing else ever changes
CREATE FUNCTION provider_fact_association_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW."factId", NEW."targetType", NEW."paymentId", NEW."refundAuthorizationId", NEW."companyId", NEW."requestedByUserId", NEW."idempotencyKey", NEW."receiptDigest", NEW."requestedAt")
     IS DISTINCT FROM (OLD.id, OLD."factId", OLD."targetType", OLD."paymentId", OLD."refundAuthorizationId", OLD."companyId", OLD."requestedByUserId", OLD."idempotencyKey", OLD."receiptDigest", OLD."requestedAt")
     OR OLD.status <> 'authorization_pending' OR NEW.status = 'authorization_pending' THEN
    RAISE EXCEPTION 'provider fact association %: decided once, never changed', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'provider_fact_association_transition';
  END IF;
  IF NEW.status = 'associated' THEN NEW."associatedAt" := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_fact_association_10_transition BEFORE UPDATE ON provider_fact_association FOR EACH ROW EXECUTE FUNCTION provider_fact_association_transition_guard();
CREATE TRIGGER provider_fact_association_90_no_delete BEFORE DELETE ON provider_fact_association FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER provider_fact_association_91_no_truncate BEFORE TRUNCATE ON provider_fact_association FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── allocation of an associated refund fact

-- the allocation is bound to the fact as observed: a refund fact of this attempt and payment (or, Core V2 S6h, an UNMATCHED refund fact
-- associated with exactly this authorization), its amount and currency unchanged, uncontested, and to that attempt's own authorization
CREATE OR REPLACE FUNCTION refund_allocation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f provider_transaction_fact%ROWTYPE; z refund_authorization%ROWTYPE; bound boolean;
BEGIN
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."factId";
  SELECT * INTO z FROM refund_authorization WHERE id = NEW."refundAuthorizationId";
  bound := CASE WHEN f."paymentId" IS NULL
    THEN EXISTS (SELECT 1 FROM provider_fact_association s WHERE s."factId" = f.id AND s.status = 'associated' AND s."refundAuthorizationId" = z.id)
         AND z."paymentId" = NEW."paymentId"
    ELSE f."refundAttemptId" = NEW."refundAttemptId" AND f."paymentId" = NEW."paymentId" END;
  IF f.kind IS DISTINCT FROM 'refund' OR bound IS NOT TRUE OR f.amount <> NEW.amount OR f.currency <> NEW.currency::text
     OR z."refundAttemptId" IS DISTINCT FROM NEW."refundAttemptId" OR z.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund_allocation: fact % is not this authorization''s verified refund', NEW."factId" USING ERRCODE = '23514', CONSTRAINT = 'refund_allocation_binding';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = NEW."factId")
     OR EXISTS (SELECT 1 FROM refund_fact_allocation_block b WHERE b."factId" = NEW."factId") THEN
    RAISE EXCEPTION 'refund_allocation: fact % is contested or blocked', NEW."factId" USING ERRCODE = '23514', CONSTRAINT = 'refund_allocation_eligible';
  END IF;
  NEW."allocatedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── grants

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON provider_fact_association FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'provider_fact_association' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
