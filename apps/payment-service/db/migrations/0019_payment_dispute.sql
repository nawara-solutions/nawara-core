-- 0019 — payment-service: payment disputes, their verified observations, chargeback facts, Owner evidence and decisions
-- (Core V2 S6e-D; register PAY-09 to PAY-11, EVT-03; ADR-0044 B10; S0 FC-1, FC-4, FC-5, D3; the Owner's R6E-1 to R6E-6, R6E-8, R6E-9,
-- 2026-10-29). DEVELOPMENT AND SIMULATION ONLY: every row is `liveMode = false`.
--
-- R6E-1: a dispute is Payment's, identified by the provider's own reference `(provider, providerDisputeId)` and bound to the payment, its
-- captured attempt and that capture's verified fact. `open -> won | lost`, once; a terminal outcome is never replaced. Every verified
-- provider observation is kept, append-only, with what Payment made of it (`applied`, `duplicate`, or a `conflict` preserved for S6h).
-- A lost outcome alone moves no money: only a verified `chargeback` fact, reported by the provider and linked to the dispute, does (FC-1).
-- R6E-3: the Owner's evidence references (a File `dispute_evidence` grant) and the Owner's contest-or-accept decision, authorized by a
-- consumed `dispute_decision` Auth receipt. A decision never changes the dispute's state: the provider decides `won` or `lost`.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── disputes

CREATE TABLE payment_dispute (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  "providerDisputeId"  text NOT NULL,
  "paymentId"          uuid NOT NULL REFERENCES payment (id),
  "attemptId"          uuid NOT NULL,                     -- the captured attempt the provider disputes
  "captureFactId"      uuid NOT NULL REFERENCES provider_transaction_fact (id),
  amount               bigint NOT NULL,                   -- the exposure THE PROVIDER states (never inferred from the capture)
  currency             text NOT NULL,
  reason               text,                              -- the provider's bounded reason code, if any
  status               text NOT NULL,
  "liveMode"           boolean NOT NULL DEFAULT false,
  "providerOpenedAt"   timestamptz,
  "providerClosedAt"   timestamptz,
  "recordedAt"         timestamptz NOT NULL DEFAULT now(),
  "closedAt"           timestamptz,
  -- the verified chargeback fact of a lost dispute; it may be reported with the loss or after it, once
  "chargebackFactId"   uuid UNIQUE,
  CONSTRAINT payment_dispute_identity UNIQUE (provider, "providerDisputeId"),
  CONSTRAINT payment_dispute_attempt FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT payment_dispute_reference_length CHECK (char_length("providerDisputeId") BETWEEN 1 AND 256),
  CONSTRAINT payment_dispute_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT payment_dispute_currency CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payment_dispute_reason CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT payment_dispute_status CHECK (status IN ('open', 'won', 'lost')),
  CONSTRAINT payment_dispute_live_mode CHECK ("liveMode" = false),
  CONSTRAINT payment_dispute_closed CHECK ((status = 'open') = ("closedAt" IS NULL)),
  CONSTRAINT payment_dispute_chargeback_lost CHECK ("chargebackFactId" IS NULL OR status = 'lost')
);
CREATE INDEX payment_dispute_payment_idx ON payment_dispute ("paymentId");

-- ─────────────────────────────────────────────────────────────────────────────────────────────── chargeback facts (FC-1)

ALTER TABLE provider_transaction_fact DROP CONSTRAINT provider_transaction_fact_kind;
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_kind CHECK (kind IN ('capture', 'refund', 'chargeback'));
ALTER TABLE provider_transaction_fact ADD COLUMN "disputeId" uuid REFERENCES payment_dispute (id);
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_dispute CHECK ((kind = 'chargeback') = ("disputeId" IS NOT NULL));
ALTER TABLE payment_dispute ADD CONSTRAINT payment_dispute_chargeback_fact FOREIGN KEY ("chargebackFactId") REFERENCES provider_transaction_fact (id);

-- a chargeback fact belongs to its dispute's payment, captured attempt and provider, and to a LOST dispute
CREATE FUNCTION provider_transaction_fact_chargeback_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'chargeback' AND NOT EXISTS (
    SELECT 1 FROM payment_dispute d WHERE d.id = NEW."disputeId" AND d."paymentId" = NEW."paymentId" AND d."attemptId" = NEW."attemptId"
       AND d.provider = NEW.provider AND d.status = 'lost') THEN
    RAISE EXCEPTION 'chargeback fact: not the lost dispute of this payment, attempt and provider' USING ERRCODE = '23514', CONSTRAINT = 'provider_transaction_fact_chargeback_dispute';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provider_transaction_fact_06_chargeback_guard BEFORE INSERT ON provider_transaction_fact FOR EACH ROW EXECUTE FUNCTION provider_transaction_fact_chargeback_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── dispute guards

CREATE FUNCTION payment_dispute_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f record;
BEGIN
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."captureFactId";
  -- the verified capture of exactly this payment, attempt and provider; never contested; the provider's exposure never exceeds it
  IF f.kind IS DISTINCT FROM 'capture' OR f."paymentId" <> NEW."paymentId" OR f."attemptId" <> NEW."attemptId" OR f.provider <> NEW.provider
     OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) THEN
    RAISE EXCEPTION 'payment dispute: its capture is not the verified capture of this payment and attempt' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_capture';
  END IF;
  IF NEW.currency <> f.currency OR NEW.amount > f.amount THEN
    RAISE EXCEPTION 'payment dispute: its exposure exceeds, or is in another currency than, the verified capture' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_exposure';
  END IF;
  IF NEW."chargebackFactId" IS NOT NULL THEN
    RAISE EXCEPTION 'payment dispute: a chargeback fact is linked after the dispute exists' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_order';
  END IF;
  NEW."recordedAt" := now();
  NEW."closedAt" := CASE WHEN NEW.status = 'open' THEN NULL ELSE now() END;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_05_insert_guard BEFORE INSERT ON payment_dispute FOR EACH ROW EXECUTE FUNCTION payment_dispute_insert_guard();

-- identity, binding and the provider's statement never change; open -> won | lost once; a lost dispute's chargeback fact is linked once
CREATE FUNCTION payment_dispute_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.provider, NEW."providerDisputeId", NEW."paymentId", NEW."attemptId", NEW."captureFactId", NEW.amount, NEW.currency, NEW.reason,
      NEW."liveMode", NEW."providerOpenedAt", NEW."recordedAt")
     IS DISTINCT FROM
     (OLD.id, OLD.provider, OLD."providerDisputeId", OLD."paymentId", OLD."attemptId", OLD."captureFactId", OLD.amount, OLD.currency, OLD.reason,
      OLD."liveMode", OLD."providerOpenedAt", OLD."recordedAt") THEN
    RAISE EXCEPTION 'payment dispute: identity, binding and stated exposure are immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_immutable';
  END IF;
  IF OLD.status <> NEW.status THEN
    IF OLD.status <> 'open' THEN
      RAISE EXCEPTION 'payment dispute %: % is terminal', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_terminal';
    END IF;
    NEW."closedAt" := now();
  ELSIF (NEW."closedAt", NEW."providerClosedAt") IS DISTINCT FROM (OLD."closedAt", OLD."providerClosedAt") THEN
    RAISE EXCEPTION 'payment dispute: its closing is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_terminal';
  END IF;
  IF OLD."chargebackFactId" IS NOT NULL AND NEW."chargebackFactId" IS DISTINCT FROM OLD."chargebackFactId" THEN
    RAISE EXCEPTION 'payment dispute: its chargeback fact is linked once' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_once';
  END IF;
  IF NEW."chargebackFactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."chargebackFactId" AND f.kind = 'chargeback' AND f."disputeId" = NEW.id) THEN
    RAISE EXCEPTION 'payment dispute: its chargeback fact is another dispute''s' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_chargeback_fact';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_10_transition BEFORE UPDATE ON payment_dispute FOR EACH ROW EXECUTE FUNCTION payment_dispute_transition_guard();

CREATE FUNCTION payment_dispute_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (dispute evidence is never edited or deleted)', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
CREATE TRIGGER payment_dispute_90_no_delete BEFORE DELETE ON payment_dispute FOR EACH ROW EXECUTE FUNCTION payment_dispute_append_only();
CREATE TRIGGER payment_dispute_91_no_truncate BEFORE TRUNCATE ON payment_dispute FOR EACH STATEMENT EXECUTE FUNCTION payment_dispute_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── verified observations (R6E-2)

-- one row per verified provider notification about a dispute (its webhook event), with what Payment made of it. A conflict is never
-- applied and never erased: it keeps the payment's dispute exposure unresolved for new refunds until S6h reconciles it.
CREATE TABLE payment_dispute_observation (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "webhookEventId"        uuid NOT NULL UNIQUE REFERENCES webhook_event (id),
  provider                text NOT NULL,
  "providerDisputeId"     text NOT NULL,
  kind                    text NOT NULL,
  "paymentId"             uuid NOT NULL REFERENCES payment (id),
  "attemptId"             uuid NOT NULL,
  "disputeId"             uuid REFERENCES payment_dispute (id),
  amount                  bigint NOT NULL,
  currency                text NOT NULL,
  "chargebackTxnId"       text,
  "chargebackAmount"      bigint,
  "chargebackCurrency"    text,
  "providerOccurredAt"    timestamptz,
  disposition             text NOT NULL,
  reason                  text,
  "observedAt"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_dispute_observation_kind CHECK (kind IN ('opened', 'won', 'lost')),
  CONSTRAINT payment_dispute_observation_attempt FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT payment_dispute_observation_reference_length CHECK (char_length("providerDisputeId") BETWEEN 1 AND 256),
  CONSTRAINT payment_dispute_observation_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT payment_dispute_observation_currency CHECK (char_length(currency) BETWEEN 1 AND 16),
  CONSTRAINT payment_dispute_observation_chargeback CHECK (
    ("chargebackTxnId" IS NULL AND "chargebackAmount" IS NULL AND "chargebackCurrency" IS NULL)
    OR (kind = 'lost' AND char_length("chargebackTxnId") BETWEEN 1 AND 256 AND "chargebackAmount" > 0 AND "chargebackAmount" <= 9007199254740991
        AND char_length("chargebackCurrency") BETWEEN 1 AND 16)),
  CONSTRAINT payment_dispute_observation_disposition CHECK (disposition IN ('applied', 'duplicate', 'conflict')),
  CONSTRAINT payment_dispute_observation_reason CHECK (
    (disposition = 'applied' AND (reason IS NULL OR reason = 'chargeback_evidence'))
    OR (disposition = 'duplicate' AND (reason IS NULL OR reason = 'after_terminal'))
    OR (disposition = 'conflict' AND reason IS NOT NULL AND reason IN ('capture_unverified', 'exposure_mismatch', 'payment_mismatch', 'terminal_contradiction',
                                                'chargeback_mismatch', 'chargeback_unverifiable')))
);
CREATE INDEX payment_dispute_observation_payment_idx ON payment_dispute_observation ("paymentId");
CREATE INDEX payment_dispute_observation_dispute_idx ON payment_dispute_observation ("disputeId");

CREATE FUNCTION payment_dispute_observation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM webhook_event w WHERE w.id = NEW."webhookEventId" AND w.provider = NEW.provider) THEN
    RAISE EXCEPTION 'dispute observation: its webhook event is not from provider %', NEW.provider USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_observation_webhook';
  END IF;
  IF NEW."disputeId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_dispute d WHERE d.id = NEW."disputeId" AND d.provider = NEW.provider AND d."providerDisputeId" = NEW."providerDisputeId") THEN
    RAISE EXCEPTION 'dispute observation: not about this dispute' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_observation_dispute';
  END IF;
  IF NEW.disposition = 'applied' AND NEW."disputeId" IS NULL THEN
    RAISE EXCEPTION 'dispute observation: an applied observation names its dispute' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_observation_dispute';
  END IF;
  NEW."observedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_observation_05_guard BEFORE INSERT ON payment_dispute_observation FOR EACH ROW EXECUTE FUNCTION payment_dispute_observation_insert_guard();
CREATE TRIGGER payment_dispute_observation_10_append_only BEFORE UPDATE OR DELETE ON payment_dispute_observation FOR EACH ROW EXECUTE FUNCTION payment_dispute_append_only();
CREATE TRIGGER payment_dispute_observation_11_no_truncate BEFORE TRUNCATE ON payment_dispute_observation FOR EACH STATEMENT EXECUTE FUNCTION payment_dispute_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── Owner evidence (PAY-10)

-- an append-only reference to a file the Owner's side granted Payment as `dispute_evidence` for exactly this dispute (File verified the grant
-- when it was added: grantee, purpose, case, file). The file's contents are never copied here.
CREATE TABLE payment_dispute_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "disputeId"     uuid NOT NULL REFERENCES payment_dispute (id),
  "grantId"       uuid NOT NULL,
  "fileId"        uuid NOT NULL,
  "addedByUserId" uuid NOT NULL,
  "addedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_dispute_evidence_once UNIQUE ("disputeId", "fileId")
);

CREATE FUNCTION payment_dispute_evidence_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM payment_dispute d WHERE d.id = NEW."disputeId" AND d.status = 'open') THEN
    RAISE EXCEPTION 'dispute evidence: the dispute is not open' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_evidence_open';
  END IF;
  NEW."addedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_evidence_05_guard BEFORE INSERT ON payment_dispute_evidence FOR EACH ROW EXECUTE FUNCTION payment_dispute_evidence_insert_guard();
CREATE TRIGGER payment_dispute_evidence_10_append_only BEFORE UPDATE OR DELETE ON payment_dispute_evidence FOR EACH ROW EXECUTE FUNCTION payment_dispute_append_only();
CREATE TRIGGER payment_dispute_evidence_11_no_truncate BEFORE TRUNCATE ON payment_dispute_evidence FOR EACH STATEMENT EXECUTE FUNCTION payment_dispute_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── Owner decision (PAY-11)

-- the durable intent of an Owner's decision (its id is the receipt's consumeRef), then its authorization: `recorded` only with Auth's
-- consumption of a `dispute_decision` receipt bound to this dispute, payment, decision and Company. At most one live (pending or recorded)
-- decision per dispute; a refused one is kept and frees the dispute for a new decision.
CREATE TABLE payment_dispute_decision (
  id                  uuid PRIMARY KEY,
  "disputeId"         uuid NOT NULL REFERENCES payment_dispute (id),
  decision            text NOT NULL,
  "companyId"         uuid NOT NULL,
  "requestedByUserId" uuid NOT NULL,
  "idempotencyKey"    text NOT NULL,
  "receiptDigest"     text NOT NULL,
  status              text NOT NULL DEFAULT 'authorization_pending',
  "receiptId"         uuid,
  "approvedByUserId"  uuid,
  refusal             text,
  "requestedAt"       timestamptz NOT NULL DEFAULT now(),
  "decidedAt"         timestamptz,
  CONSTRAINT payment_dispute_decision_decision CHECK (decision IN ('contest', 'accept')),
  CONSTRAINT payment_dispute_decision_key CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT payment_dispute_decision_key_once UNIQUE ("requestedByUserId", "idempotencyKey"),
  CONSTRAINT payment_dispute_decision_digest CHECK ("receiptDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_dispute_decision_status CHECK (status IN ('authorization_pending', 'recorded', 'authorization_refused', 'authorization_expired')),
  CONSTRAINT payment_dispute_decision_pairing CHECK (
       (status = 'authorization_pending' AND "receiptId" IS NULL AND "approvedByUserId" IS NULL AND refusal IS NULL AND "decidedAt" IS NULL)
    OR (status = 'recorded' AND "receiptId" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND refusal IS NULL AND "decidedAt" IS NOT NULL)
    OR (status IN ('authorization_refused', 'authorization_expired') AND "receiptId" IS NULL AND "approvedByUserId" IS NULL AND refusal IS NOT NULL
        AND "decidedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX payment_dispute_decision_live ON payment_dispute_decision ("disputeId") WHERE status IN ('authorization_pending', 'recorded');

CREATE FUNCTION payment_dispute_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'authorization_pending' THEN
      RAISE EXCEPTION 'dispute decision: always inserted authorization_pending' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_decision_transition';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM payment_dispute d JOIN payment p ON p.id = d."paymentId"
       WHERE d.id = NEW."disputeId" AND d.status = 'open' AND p."sellerType" = 'company' AND p."sellerId" = NEW."companyId"::text) THEN
      RAISE EXCEPTION 'dispute decision: not an open dispute of this Company' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_decision_open';
    END IF;
    NEW."requestedAt" := now();
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW."disputeId", NEW.decision, NEW."companyId", NEW."requestedByUserId", NEW."idempotencyKey", NEW."receiptDigest", NEW."requestedAt")
     IS DISTINCT FROM (OLD.id, OLD."disputeId", OLD.decision, OLD."companyId", OLD."requestedByUserId", OLD."idempotencyKey", OLD."receiptDigest", OLD."requestedAt") THEN
    RAISE EXCEPTION 'dispute decision: its request is immutable' USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_decision_immutable';
  END IF;
  IF OLD.status <> 'authorization_pending' THEN
    RAISE EXCEPTION 'dispute decision %: % is terminal', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'payment_dispute_decision_transition';
  END IF;
  NEW."decidedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_dispute_decision_05_guard BEFORE INSERT OR UPDATE ON payment_dispute_decision FOR EACH ROW EXECUTE FUNCTION payment_dispute_decision_guard();
CREATE TRIGGER payment_dispute_decision_90_no_delete BEFORE DELETE ON payment_dispute_decision FOR EACH ROW EXECUTE FUNCTION payment_dispute_append_only();
CREATE TRIGGER payment_dispute_decision_91_no_truncate BEFORE TRUNCATE ON payment_dispute_decision FOR EACH STATEMENT EXECUTE FUNCTION payment_dispute_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── simulation harness (R6E-2)

-- what the authorized harness told the simulated provider to report about a dispute of a captured simulation payment. The command is the
-- provider's record, never Payment's evidence: Payment learns of it only through the signed notification it produces (F-S4).
CREATE TABLE simulation_dispute_command (
  "commandId"           text PRIMARY KEY,
  "paymentId"           uuid NOT NULL REFERENCES payment (id),
  "attemptId"           uuid NOT NULL,
  provider              text NOT NULL DEFAULT 'simulation',
  "providerDisputeId"   text NOT NULL,
  instruction           text NOT NULL,
  amount                bigint NOT NULL,
  currency              text NOT NULL,
  reason                text,
  "chargebackTxnId"     text,
  "chargebackAmount"    bigint,
  "chargebackCurrency"  text,
  "eventBody"           bytea NOT NULL,
  delivery              text NOT NULL,
  "createdAt"           timestamptz NOT NULL DEFAULT now(),
  seq                   bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  CONSTRAINT simulation_dispute_command_id_shape CHECK ("commandId" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT simulation_dispute_command_provider CHECK (provider = 'simulation'),
  CONSTRAINT simulation_dispute_command_attempt FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT simulation_dispute_command_instruction CHECK (instruction IN ('opened', 'won', 'lost')),
  CONSTRAINT simulation_dispute_command_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT simulation_dispute_command_chargeback CHECK (
    ("chargebackTxnId" IS NULL AND "chargebackAmount" IS NULL AND "chargebackCurrency" IS NULL)
    OR (instruction = 'lost' AND "chargebackTxnId" IS NOT NULL AND "chargebackAmount" > 0 AND "chargebackAmount" <= 9007199254740991 AND "chargebackCurrency" IS NOT NULL)),
  CONSTRAINT simulation_dispute_command_delivery CHECK (delivery IN ('immediate', 'held'))
);
CREATE INDEX simulation_dispute_command_payment_idx ON simulation_dispute_command ("paymentId", seq);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── runtime grants

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_dispute, payment_dispute_decision FROM PUBLIC;
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON payment_dispute_observation, payment_dispute_evidence, simulation_dispute_command FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('payment_dispute', 'payment_dispute_observation', 'payment_dispute_evidence', 'payment_dispute_decision', 'simulation_dispute_command')
       AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
            OR (a.privilege_type = 'UPDATE' AND c.relname IN ('payment_dispute_observation', 'payment_dispute_evidence', 'simulation_dispute_command')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;

