-- Core V2 S4d (register PAY-05, I-6; S0 FC-1, V-2; ADR-0035 C2), for Core V2 DEVELOPMENT AND SIMULATION ONLY. Immutable provider
-- transaction facts: payment-service's durable evidence that a provider reported a money movement. Additive only: one unique key on
-- payment_attempt, two append-only tables, one nullable reference column on payment_late_success. No existing row changes; no backfill.
--
--   * FC-1: every distinct provider money movement is ONE `provider_transaction_fact`, identity `(provider, providerTxnId, kind)`,
--     committed in its own transaction before (and independently of) any commercial processing (V-2). Identical redeliveries — the same
--     webhook again, or the same movement seen through the webhook and the provider status read — are the same fact. A fact is never
--     refused, edited or deleted: a success Payment cannot apply (an amount mismatch, a finished workflow, a confirmed failure) is still
--     recorded as the provider reported it.
--   * Kinds: `capture` only (the money the provider captured for a payment; FC-5's vocabulary). Refunds and chargebacks are S6.
--     Failures, expiries and unknown or pending answers are not money movements: they stay what they were (attempt state, webhook_event).
--   * Provenance (I-6): a fact only from an authenticated provider message — a signature-verified, parsed webhook (`webhookEventId`, the
--     stored raw notification, of the SAME provider) or the provider's status read (`status_check`). Bound to its attempt, payment and
--     provider by one composite key, so it can never be associated across payments or providers. `providerOccurredAt` is the provider's
--     own time when it states one (NULL otherwise, never fabricated); `observedAt` is Payment's database time.
--   * Contradiction: an observation with the same identity but different facts (amount, currency, payment, attempt) never overwrites the
--     fact; it is kept, once, in `provider_transaction_fact_conflict` for S6h reconciliation. No precedence rule is applied.
--   * ADR-0035 C2: commercial meaning is layered on top by append-only records. S4c's `payment_late_success` (a verified success Payment
--     did not apply) now references its fact; rows written before S4d keep NULL (nothing is backfilled or re-interpreted).
--   * FC-10 under P-6: `liveMode` is `false` (simulation only) and equals the attempt's mode.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the binding key

ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_fact_binding UNIQUE (id, "paymentId", provider);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── provider_transaction_fact

CREATE TABLE provider_transaction_fact (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider              text NOT NULL,
  "providerTxnId"       text NOT NULL,                     -- the provider's own transaction reference
  kind                  text NOT NULL,
  "paymentId"           uuid NOT NULL,
  "attemptId"           uuid NOT NULL,
  amount                bigint NOT NULL,                   -- as the PROVIDER reported it (it may differ from the snapshot: FI-13 refuses it later)
  currency              text NOT NULL,                     -- likewise
  "liveMode"            boolean NOT NULL,
  source                text NOT NULL,                     -- the authenticated channel that first reported it
  "webhookEventId"      uuid REFERENCES webhook_event (id),
  "providerOccurredAt"  timestamptz,                       -- the provider's stated time, if any
  "observedAt"          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT provider_transaction_fact_identity UNIQUE (provider, "providerTxnId", kind),
  CONSTRAINT provider_transaction_fact_binding FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT provider_transaction_fact_kind CHECK (kind IN ('capture')),
  CONSTRAINT provider_transaction_fact_txn_length CHECK (char_length("providerTxnId") BETWEEN 1 AND 256),
  CONSTRAINT provider_transaction_fact_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT provider_transaction_fact_currency CHECK (char_length(currency) BETWEEN 1 AND 16),
  CONSTRAINT provider_transaction_fact_live_mode CHECK ("liveMode" = false),
  CONSTRAINT provider_transaction_fact_source CHECK (source IN ('webhook', 'status_check')),
  CONSTRAINT provider_transaction_fact_webhook_ref CHECK ((source = 'webhook') = ("webhookEventId" IS NOT NULL))
);
CREATE INDEX provider_transaction_fact_payment_idx ON provider_transaction_fact ("paymentId");
CREATE INDEX provider_transaction_fact_attempt_idx ON provider_transaction_fact ("attemptId");

-- the provenance a key cannot express: a webhook of the SAME provider; the attempt's own mode; the database's own clock
CREATE FUNCTION provider_transaction_fact_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE am boolean;
BEGIN
  IF NEW."webhookEventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_event w WHERE w.id = NEW."webhookEventId" AND w.provider = NEW.provider) THEN
    RAISE EXCEPTION 'provider fact: its webhook event is not from provider %', NEW.provider USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_webhook_provider';
  END IF;
  SELECT "liveMode" INTO am FROM payment_attempt WHERE id = NEW."attemptId";
  IF am IS NOT NULL AND am <> NEW."liveMode" THEN
    RAISE EXCEPTION 'provider fact: its mode differs from its attempt''s' USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_attempt_mode';
  END IF;
  NEW."observedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER provider_transaction_fact_05_insert_guard BEFORE INSERT ON provider_transaction_fact FOR EACH ROW EXECUTE FUNCTION provider_transaction_fact_insert_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── contradicting observations

CREATE TABLE provider_transaction_fact_conflict (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "factId"          uuid NOT NULL REFERENCES provider_transaction_fact (id),
  "paymentId"       uuid NOT NULL,
  "attemptId"       uuid NOT NULL,
  provider          text NOT NULL,
  amount            bigint NOT NULL,
  currency          text NOT NULL,
  source            text NOT NULL,
  "webhookEventId"  uuid REFERENCES webhook_event (id),
  "observedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_transaction_fact_conflict_binding FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT provider_transaction_fact_conflict_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT provider_transaction_fact_conflict_currency CHECK (char_length(currency) BETWEEN 1 AND 16),
  CONSTRAINT provider_transaction_fact_conflict_source CHECK (source IN ('webhook', 'status_check')),
  CONSTRAINT provider_transaction_fact_conflict_webhook_ref CHECK ((source = 'webhook') = ("webhookEventId" IS NOT NULL)),
  -- the same contradiction redelivered is recorded once
  CONSTRAINT provider_transaction_fact_conflict_once UNIQUE NULLS NOT DISTINCT ("factId", "paymentId", "attemptId", amount, currency, source, "webhookEventId")
);
CREATE INDEX provider_transaction_fact_conflict_fact_idx ON provider_transaction_fact_conflict ("factId");

-- ─────────────────────────────────────────────────────────────────────────────────────────────── S4c late success → its fact

ALTER TABLE payment_late_success ADD COLUMN "factId" uuid REFERENCES provider_transaction_fact (id);
CREATE FUNCTION payment_late_success_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."factId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."factId" AND f."attemptId" = NEW."attemptId" AND f."paymentId" = NEW."paymentId"
  ) THEN
    RAISE EXCEPTION 'payment_late_success: its fact is for another attempt or payment' USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_fact_binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_late_success_05_fact_guard BEFORE INSERT ON payment_late_success FOR EACH ROW EXECUTE FUNCTION payment_late_success_fact_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── append-only, INSERT and SELECT only

CREATE FUNCTION provider_transaction_fact_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (provider evidence is never edited or deleted)', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
CREATE TRIGGER provider_transaction_fact_10_append_only BEFORE UPDATE OR DELETE ON provider_transaction_fact FOR EACH ROW EXECUTE FUNCTION provider_transaction_fact_append_only();
CREATE TRIGGER provider_transaction_fact_11_no_truncate BEFORE TRUNCATE ON provider_transaction_fact FOR EACH STATEMENT EXECUTE FUNCTION provider_transaction_fact_append_only();
CREATE TRIGGER provider_transaction_fact_conflict_10_append_only BEFORE UPDATE OR DELETE ON provider_transaction_fact_conflict FOR EACH ROW EXECUTE FUNCTION provider_transaction_fact_append_only();
CREATE TRIGGER provider_transaction_fact_conflict_11_no_truncate BEFORE TRUNCATE ON provider_transaction_fact_conflict FOR EACH STATEMENT EXECUTE FUNCTION provider_transaction_fact_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON provider_transaction_fact, provider_transaction_fact_conflict FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('provider_transaction_fact', 'provider_transaction_fact_conflict') AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %s', r.tbl, r.role);
  END LOOP;
END $$;
