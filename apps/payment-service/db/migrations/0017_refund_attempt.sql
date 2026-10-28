-- Core V2 S6b (register PAY-07, PAY-08, PAY-05; ADR-0067 decisions 5 to 7; S0 FC-1, FC-5, FC-7, FC-10, §3.7; the Owner's R6B-1 to R6B-10,
-- 2026-10-28), for Core V2 DEVELOPMENT AND SIMULATION ONLY. Refund attempts: Payment's durable refund intent, its Auth-receipt authorization
-- and the provider refund it dispatches, plus the provider's refund evidence. Expand only: three new tables, one widened CHECK and one new
-- nullable column (with its binding) on provider_transaction_fact. No existing row changes; nothing is backfilled.
--
--   * One attempt = one durable intent. Its id is the refund attempt id Billing generated; it is ALSO the receipt's `consumeRef` (F-13, F-18)
--     and the provider idempotency key (R6B-3), so the primary key is the permanent uniqueness of all three. One consumption authorizes at
--     most one attempt: `receiptId` is unique.
--   * The attempt is bound to its receipt by `receiptDigest`, a domain-separated SHA-256 of the receipt secret (a 256-bit random value,
--     so the digest reveals nothing): a lost response is recovered only with the SAME receipt, never by consuming another one (R6B-9). The
--     secret itself is never stored, logged or audited.
--   * States (R6B-3), enforced by a transition trigger: authorization_pending -> authorized | authorization_expired | authorization_refused
--     (only on Auth's definitive answer); authorized -> dispatching -> submitted | unknown | failed | succeeded | discrepancy; unknown ->
--     submitted | succeeded | failed | discrepancy; submitted -> succeeded | failed | discrepancy; failed -> discrepancy (verified refund
--     evidence contradicting a confirmed failure). authorization_expired, authorization_refused, succeeded and discrepancy are terminal.
--   * At most one potentially effective attempt per payment (a partial unique index): only authorization_expired, authorization_refused and
--     failed free the payment for a new attempt, and a new attempt is refused while ANY refund fact exists for the payment.
--   * `refund_attempt_refusal`: a permanent record that a refund attempt id was refused BEFORE any attempt existed (a definitive business
--     refusal). The same id can then never become an attempt, so Billing may treat the refusal as final (R6B-10).
--   * Refund facts (FC-1, R6B-5): `provider_transaction_fact` of kind `refund`, keyed `(provider, providerTxnId, kind)` like captures,
--     bound by one composite key to its refund attempt, the payment and the captured payment attempt. Allocation, completion and reversal
--     (S6c, S6d) are not here.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the capture a refund returns

ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_refund_source UNIQUE (id, "paymentId", "attemptId", provider, kind);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund_attempt

CREATE TABLE refund_attempt (
  id                    uuid PRIMARY KEY,                     -- Billing's refund attempt id = the receipt consumeRef = the provider idempotency key
  "paymentId"           uuid NOT NULL REFERENCES payment (id),
  producer              text NOT NULL,                        -- the authenticated caller that relayed it (the payment's own producer)
  "refundCaseId"        uuid NOT NULL,
  "companyId"           uuid NOT NULL,                        -- the payment's seller Company (the receipt binding's companyId)
  amount                bigint NOT NULL,
  currency              char(3) NOT NULL,
  reason                text NOT NULL,
  "legalOverride"       boolean NOT NULL,
  "captureFactId"       uuid NOT NULL,                        -- the verified original capture (S4d)
  "capturedAttemptId"   uuid NOT NULL,
  provider              text NOT NULL,                        -- the capture's provider: a refund returns to the original method
  "kindCapture"         text NOT NULL DEFAULT 'capture',
  "liveMode"            boolean NOT NULL,
  "receiptDigest"       text NOT NULL,
  status                text NOT NULL DEFAULT 'authorization_pending',
  "authorizationRefusal" text,                                -- Auth's definitive refusal code, for authorization_refused / _expired
  "receiptId"           uuid,                                 -- from Auth's consumption (F-16): never a request value
  "approvedByUserId"    uuid,
  "consumedAt"          timestamptz,
  "providerRefundId"    text,
  "failureCode"         text,
  "workAfter"           timestamptz,                          -- the refund worker's lease
  "requestedAt"         timestamptz NOT NULL DEFAULT now(),
  "authorizedAt"        timestamptz,
  "submittedAt"         timestamptz,
  "completedAt"         timestamptz,
  "succeededFactId"     uuid,

  CONSTRAINT refund_attempt_capture FOREIGN KEY ("captureFactId", "paymentId", "capturedAttemptId", provider, "kindCapture")
    REFERENCES provider_transaction_fact (id, "paymentId", "attemptId", provider, kind),
  CONSTRAINT refund_attempt_kind_capture CHECK ("kindCapture" = 'capture'),
  CONSTRAINT refund_attempt_fact_binding UNIQUE (id, "paymentId", "capturedAttemptId", provider),
  CONSTRAINT refund_attempt_producer_shape CHECK (producer ~ '^[a-z][a-z0-9-]{0,62}$'),
  CONSTRAINT refund_attempt_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT refund_attempt_currency_upper CHECK (currency = upper(currency)),
  CONSTRAINT refund_attempt_reason CHECK (reason IN ('duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement')),
  CONSTRAINT refund_attempt_live_mode CHECK ("liveMode" = false),
  CONSTRAINT refund_attempt_receipt_digest_shape CHECK ("receiptDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT refund_attempt_status CHECK (status IN ('authorization_pending', 'authorized', 'authorization_expired', 'authorization_refused',
    'dispatching', 'submitted', 'succeeded', 'failed', 'unknown', 'discrepancy')),
  -- Auth's consumption is recorded exactly when the attempt was authorized (every state after authorization keeps it)
  CONSTRAINT refund_attempt_authorization_shape CHECK (
    (status IN ('authorization_pending', 'authorization_expired', 'authorization_refused')
      AND "receiptId" IS NULL AND "approvedByUserId" IS NULL AND "consumedAt" IS NULL AND "authorizedAt" IS NULL)
    OR (status NOT IN ('authorization_pending', 'authorization_expired', 'authorization_refused')
      AND "receiptId" IS NOT NULL AND "approvedByUserId" IS NOT NULL AND "consumedAt" IS NOT NULL AND "authorizedAt" IS NOT NULL)),
  CONSTRAINT refund_attempt_refusal_shape CHECK (
    (status IN ('authorization_expired', 'authorization_refused')) = ("authorizationRefusal" IS NOT NULL)
    AND ("authorizationRefusal" IS NULL OR "authorizationRefusal" IN ('receipt_invalid', 'receipt_binding_invalid', 'receipt_expired'))
    AND (status <> 'authorization_expired' OR "authorizationRefusal" = 'receipt_expired')
    AND (status <> 'authorization_refused' OR "authorizationRefusal" <> 'receipt_expired')),
  CONSTRAINT refund_attempt_provider_refund_shape CHECK ("providerRefundId" IS NULL OR char_length("providerRefundId") BETWEEN 1 AND 256),
  CONSTRAINT refund_attempt_submitted_shape CHECK (status <> 'submitted' OR ("providerRefundId" IS NOT NULL AND "submittedAt" IS NOT NULL)),
  CONSTRAINT refund_attempt_failure_shape CHECK ((status = 'failed') = ("failureCode" IS NOT NULL) OR status = 'discrepancy'),
  CONSTRAINT refund_attempt_failure_code CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT refund_attempt_succeeded_shape CHECK ((status = 'succeeded') = ("succeededFactId" IS NOT NULL)),
  CONSTRAINT refund_attempt_completed_shape CHECK ((status IN ('succeeded', 'failed', 'discrepancy', 'authorization_expired', 'authorization_refused')) = ("completedAt" IS NOT NULL))
);
-- One consumption authorizes at most one attempt (S0 §3.7)
CREATE UNIQUE INDEX refund_attempt_receipt_unique ON refund_attempt ("receiptId") WHERE "receiptId" IS NOT NULL;
-- A provider refund transaction belongs to at most one attempt (FI-10)
CREATE UNIQUE INDEX refund_attempt_provider_refund_unique ON refund_attempt (provider, "providerRefundId") WHERE "providerRefundId" IS NOT NULL;
-- R6B-3: at most one unresolved or potentially effective attempt per payment
CREATE UNIQUE INDEX refund_attempt_one_effective ON refund_attempt ("paymentId")
  WHERE status NOT IN ('authorization_expired', 'authorization_refused', 'failed');
CREATE INDEX refund_attempt_payment_idx ON refund_attempt ("paymentId");
CREATE INDEX refund_attempt_work_idx ON refund_attempt (status, "workAfter") WHERE status IN ('authorization_pending', 'authorized', 'dispatching', 'submitted', 'unknown');

CREATE TRIGGER refund_attempt_immutable BEFORE UPDATE ON refund_attempt
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'paymentId', 'producer', 'refundCaseId', 'companyId', 'amount', 'currency', 'reason', 'legalOverride', 'captureFactId',
    'capturedAttemptId', 'provider', 'kindCapture', 'liveMode', 'receiptDigest', 'requestedAt'
  );

-- What an INSERT may say, and what the payment must be: a NEW attempt starts as an intent, on a verified, gateway-settled, Company-sold capture
-- of exactly the payment's full amount, never while a refund fact exists for the payment, never for an id already refused (defence in depth
-- behind the application, which checks all of it under the payment's row lock).
CREATE FUNCTION refund_attempt_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payment%ROWTYPE;
BEGIN
  IF NEW.status <> 'authorization_pending' OR NEW."workAfter" IS NOT NULL THEN
    RAISE EXCEPTION 'refund_attempt: a new attempt starts as authorization_pending' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_insert_state';
  END IF;
  SELECT * INTO p FROM payment WHERE id = NEW."paymentId";
  IF p.status <> 'succeeded' OR p."settledMethod" IS DISTINCT FROM 'gateway' OR p."sellerType" <> 'company' OR p."sellerId" <> NEW."companyId"::text
     OR p."succeededAttemptId" IS DISTINCT FROM NEW."capturedAttemptId" OR p.amount <> NEW.amount OR p.currency <> NEW.currency
     OR p.producer <> NEW.producer OR p."liveMode" IS DISTINCT FROM false
     OR p.purpose IS NULL OR p.purpose NOT IN ('direct_purchase', 'assisted_settlement', 'non_entitlement') THEN
    RAISE EXCEPTION 'refund_attempt: payment % is not refundable as requested', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_payment_refundable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."captureFactId" AND f.amount = p.amount AND f.currency = p.currency)
     OR EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = NEW."captureFactId") THEN
    RAISE EXCEPTION 'refund_attempt: the capture is not verified for the full amount' USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_capture_verified';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f."paymentId" = NEW."paymentId" AND f.kind = 'refund') THEN
    RAISE EXCEPTION 'refund_attempt: payment % already has refund evidence', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_no_refund_fact';
  END IF;
  IF EXISTS (SELECT 1 FROM refund_attempt_refusal r WHERE r.id = NEW.id) THEN
    RAISE EXCEPTION 'refund_attempt: % was refused' , NEW.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_refused_id';
  END IF;
  NEW."requestedAt" := now();
  RETURN NEW;
END $$;

CREATE FUNCTION refund_attempt_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('authorization_pending', 'authorized'), ('authorization_pending', 'authorization_expired'), ('authorization_pending', 'authorization_refused'),
      ('authorized', 'dispatching'),
      ('dispatching', 'submitted'), ('dispatching', 'unknown'), ('dispatching', 'failed'), ('dispatching', 'succeeded'), ('dispatching', 'discrepancy'),
      ('unknown', 'submitted'), ('unknown', 'succeeded'), ('unknown', 'failed'), ('unknown', 'discrepancy'),
      ('submitted', 'succeeded'), ('submitted', 'failed'), ('submitted', 'discrepancy'),
      ('failed', 'discrepancy')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'refund_attempt % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_transition';
  END IF;
  -- Auth's consumption is written once, by the authorizing transition, and never changes afterwards
  IF OLD."receiptId" IS NOT NULL AND (NEW."receiptId", NEW."approvedByUserId", NEW."consumedAt", NEW."authorizedAt")
       IS DISTINCT FROM (OLD."receiptId", OLD."approvedByUserId", OLD."consumedAt", OLD."authorizedAt") THEN
    RAISE EXCEPTION 'refund_attempt %: its authorization is immutable', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_authorization_immutable';
  END IF;
  IF OLD."providerRefundId" IS NOT NULL AND NEW."providerRefundId" IS DISTINCT FROM OLD."providerRefundId" THEN
    RAISE EXCEPTION 'refund_attempt %: its provider refund id is set once', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_provider_refund_immutable';
  END IF;
  IF NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f WHERE f.id = NEW."succeededFactId" AND f."refundAttemptId" = NEW.id AND f.kind = 'refund'
       AND f.amount = NEW.amount AND f.currency = NEW.currency) THEN
    RAISE EXCEPTION 'refund_attempt %: success needs its own verified full-amount refund fact', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_success_evidence';
  END IF;
  RETURN NEW;
END $$;

-- a terminal row never changes again (the lease column included)
CREATE FUNCTION refund_attempt_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy') THEN
    RAISE EXCEPTION 'refund_attempt % is terminal (%)', OLD.id, OLD.status USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_terminal';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION refund_attempt_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted (financial evidence)', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

CREATE TRIGGER refund_attempt_05_insert_guard BEFORE INSERT ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_insert_guard();
CREATE TRIGGER refund_attempt_06_terminal BEFORE UPDATE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_terminal_guard();
CREATE TRIGGER refund_attempt_07_transition BEFORE UPDATE OF status ON refund_attempt
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION refund_attempt_transition_guard();
CREATE TRIGGER refund_attempt_10_no_delete BEFORE DELETE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_no_delete();
CREATE TRIGGER refund_attempt_11_no_truncate BEFORE TRUNCATE ON refund_attempt FOR EACH STATEMENT EXECUTE FUNCTION refund_attempt_no_delete();

-- the authorization columns are written only together with a status change (no silent edit of an authorized attempt)
CREATE FUNCTION refund_attempt_authorization_with_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status AND ((NEW."receiptId", NEW."approvedByUserId", NEW."consumedAt", NEW."authorizationRefusal", NEW."succeededFactId", NEW."failureCode")
       IS DISTINCT FROM (OLD."receiptId", OLD."approvedByUserId", OLD."consumedAt", OLD."authorizationRefusal", OLD."succeededFactId", OLD."failureCode")) THEN
    RAISE EXCEPTION 'refund_attempt %: outcome columns change only with the status', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_outcome_with_status';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_08_outcome_with_status BEFORE UPDATE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_authorization_with_status();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund_attempt_refusal

CREATE TABLE refund_attempt_refusal (
  id              uuid PRIMARY KEY,                           -- the refused refund attempt id: never an attempt afterwards
  "paymentId"     uuid NOT NULL REFERENCES payment (id),
  producer        text NOT NULL,
  "refundCaseId"  uuid NOT NULL,
  code            text NOT NULL,
  "refusedAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_attempt_refusal_code CHECK (code IN ('payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full',
    'refund_dispute_open', 'refund_in_progress', 'refund_already_recorded'))
);
CREATE INDEX refund_attempt_refusal_payment_idx ON refund_attempt_refusal ("paymentId");

CREATE FUNCTION refund_attempt_refusal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM refund_attempt a WHERE a.id = NEW.id) THEN
    RAISE EXCEPTION 'refund_attempt_refusal: % is an attempt', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_refusal_not_attempt';
  END IF;
  NEW."refusedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_refusal_05_insert_guard BEFORE INSERT ON refund_attempt_refusal FOR EACH ROW EXECUTE FUNCTION refund_attempt_refusal_insert_guard();
CREATE TRIGGER refund_attempt_refusal_10_append_only BEFORE UPDATE OR DELETE ON refund_attempt_refusal FOR EACH ROW EXECUTE FUNCTION provider_transaction_fact_append_only();
CREATE TRIGGER refund_attempt_refusal_11_no_truncate BEFORE TRUNCATE ON refund_attempt_refusal FOR EACH STATEMENT EXECUTE FUNCTION provider_transaction_fact_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund facts (FC-1)

ALTER TABLE provider_transaction_fact DROP CONSTRAINT provider_transaction_fact_kind;
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_kind CHECK (kind IN ('capture', 'refund'));
ALTER TABLE provider_transaction_fact ADD COLUMN "refundAttemptId" uuid;
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_refund_attempt CHECK ((kind = 'refund') = ("refundAttemptId" IS NOT NULL));
-- a refund fact is bound to ITS refund attempt, that attempt's payment, the captured payment attempt it returns and the same provider
ALTER TABLE provider_transaction_fact ADD CONSTRAINT provider_transaction_fact_refund_binding
  FOREIGN KEY ("refundAttemptId", "paymentId", "attemptId", provider) REFERENCES refund_attempt (id, "paymentId", "capturedAttemptId", provider);
CREATE INDEX provider_transaction_fact_refund_attempt_idx ON provider_transaction_fact ("refundAttemptId") WHERE "refundAttemptId" IS NOT NULL;

ALTER TABLE provider_transaction_fact_conflict ADD COLUMN "refundAttemptId" uuid;
ALTER TABLE provider_transaction_fact_conflict ADD CONSTRAINT provider_transaction_fact_conflict_refund_binding
  FOREIGN KEY ("refundAttemptId", "paymentId", "attemptId", provider) REFERENCES refund_attempt (id, "paymentId", "capturedAttemptId", provider);
ALTER TABLE provider_transaction_fact_conflict DROP CONSTRAINT provider_transaction_fact_conflict_once;
ALTER TABLE provider_transaction_fact_conflict ADD CONSTRAINT provider_transaction_fact_conflict_once
  UNIQUE NULLS NOT DISTINCT ("factId", "paymentId", "attemptId", "refundAttemptId", amount, currency, source, "webhookEventId");

-- ─────────────────────────────────────────────────────────────────────────────────────────────── simulation refund commands (S4f, R6B-6)

-- The simulated provider's OWN refund records, written by the authorized harness (plans and outcomes) and by the simulated provider when it
-- receives a dispatch. Never Payment's evidence: Payment learns refund outcomes only through the signed notification or the status read.
CREATE TABLE simulation_refund_command (
  "commandId"         text PRIMARY KEY,
  kind                text NOT NULL,                 -- `dispatch_plan` (how the provider answers a payment's refund dispatches) or `outcome`
  "paymentId"         uuid NOT NULL REFERENCES payment (id),
  "refundAttemptId"   uuid,
  "capturedAttemptId" uuid,
  provider            text NOT NULL DEFAULT 'simulation',
  instruction         text NOT NULL,
  "failureCode"       text,
  amount              bigint,                        -- server-derived: the attempt's amount (amount_mismatch: one minor unit away)
  currency            text,
  "providerRefundId"  text,
  "eventBody"         bytea,
  delivery            text,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  seq                 bigint GENERATED ALWAYS AS IDENTITY UNIQUE,

  CONSTRAINT simulation_refund_command_id_shape CHECK ("commandId" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT simulation_refund_command_provider CHECK (provider = 'simulation'),
  CONSTRAINT simulation_refund_command_binding FOREIGN KEY ("refundAttemptId", "paymentId", "capturedAttemptId", provider)
    REFERENCES refund_attempt (id, "paymentId", "capturedAttemptId", provider),
  CONSTRAINT simulation_refund_command_kind CHECK (
       (kind = 'dispatch_plan' AND "refundAttemptId" IS NULL AND "capturedAttemptId" IS NULL AND instruction IN ('accepted', 'ambiguous', 'rejected')
        AND amount IS NULL AND "eventBody" IS NULL AND "providerRefundId" IS NULL)
    OR (kind = 'outcome' AND "refundAttemptId" IS NOT NULL AND "capturedAttemptId" IS NOT NULL AND "providerRefundId" IS NOT NULL
        AND instruction IN ('succeeded', 'amount_mismatch', 'failed', 'no_record', 'pending'))),
  CONSTRAINT simulation_refund_command_failure_code CHECK (("failureCode" IS NOT NULL) = (instruction IN ('rejected', 'failed'))
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$')),
  CONSTRAINT simulation_refund_command_money CHECK ((instruction IN ('succeeded', 'amount_mismatch')) = (amount IS NOT NULL AND currency IS NOT NULL)
    AND (amount IS NULL OR (amount > 0 AND amount <= 9007199254740991))),
  CONSTRAINT simulation_refund_command_event CHECK ((instruction IN ('succeeded', 'amount_mismatch', 'failed')) = ("eventBody" IS NOT NULL)
    AND ("eventBody" IS NULL) = (delivery IS NULL) AND (delivery IS NULL OR delivery IN ('immediate', 'held')))
);
CREATE INDEX simulation_refund_command_attempt_idx ON simulation_refund_command ("refundAttemptId", seq);
CREATE INDEX simulation_refund_command_payment_idx ON simulation_refund_command ("paymentId", seq);

-- what the simulated provider received: one row per idempotency key (the refund attempt id), whatever it answered
CREATE TABLE simulation_refund_dispatch (
  "idempotencyKey"    uuid PRIMARY KEY REFERENCES refund_attempt (id),
  answer              text NOT NULL,
  "failureCode"       text,
  "receivedAt"        timestamptz NOT NULL DEFAULT now(),
  "lastReceivedAt"    timestamptz NOT NULL DEFAULT now(),
  received            integer NOT NULL DEFAULT 1,
  CONSTRAINT simulation_refund_dispatch_answer CHECK (answer IN ('accepted', 'ambiguous', 'rejected')),
  CONSTRAINT simulation_refund_dispatch_failure CHECK (("failureCode" IS NOT NULL) = (answer = 'rejected')),
  CONSTRAINT simulation_refund_dispatch_received CHECK (received >= 1)
);

CREATE FUNCTION simulation_refund_command_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER simulation_refund_command_05_insert_guard BEFORE INSERT ON simulation_refund_command FOR EACH ROW EXECUTE FUNCTION simulation_refund_command_insert_guard();
CREATE TRIGGER simulation_refund_command_10_append_only BEFORE UPDATE OR DELETE ON simulation_refund_command FOR EACH ROW EXECUTE FUNCTION simulation_provider_command_append_only();
CREATE TRIGGER simulation_refund_command_11_no_truncate BEFORE TRUNCATE ON simulation_refund_command FOR EACH STATEMENT EXECUTE FUNCTION simulation_provider_command_append_only();

-- a provider's record of a request it received keeps its first answer: a repeat with the same key only counts the delivery
CREATE FUNCTION simulation_refund_dispatch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW."idempotencyKey", NEW.answer, NEW."failureCode", NEW."receivedAt") IS DISTINCT FROM (OLD."idempotencyKey", OLD.answer, OLD."failureCode", OLD."receivedAt")
     OR NEW.received <> OLD.received + 1 THEN
    RAISE EXCEPTION 'simulation_refund_dispatch keeps the first answer for a key' USING ERRCODE = '23514';
  END IF;
  NEW."lastReceivedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER simulation_refund_dispatch_10_guard BEFORE UPDATE OR DELETE ON simulation_refund_dispatch FOR EACH ROW EXECUTE FUNCTION simulation_refund_dispatch_guard();
CREATE TRIGGER simulation_refund_dispatch_11_no_truncate BEFORE TRUNCATE ON simulation_refund_dispatch FOR EACH STATEMENT EXECUTE FUNCTION simulation_provider_command_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── runtime grants

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_attempt FROM PUBLIC;
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_attempt_refusal, simulation_refund_command FROM PUBLIC;
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON simulation_refund_dispatch FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('refund_attempt', 'refund_attempt_refusal', 'simulation_refund_command', 'simulation_refund_dispatch')
       AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
            OR (a.privilege_type = 'UPDATE' AND c.relname IN ('refund_attempt_refusal', 'simulation_refund_command')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
