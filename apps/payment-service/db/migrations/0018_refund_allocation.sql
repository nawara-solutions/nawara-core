-- Core V2 S6c (register PAY-07, PAY-08, EVT-02; S0 FC-1, FC-2, FC-3, DB-17, V-2, V-3; the Owner's R6C-1 to R6C-12, 2026-10-29), for Core V2
-- DEVELOPMENT AND SIMULATION ONLY. Refund allocation and financial completion. Expand only: four new tables, one unique key on refund_attempt,
-- one widened CHECK on refund_attempt_refusal, one new insert guard; existing S6b authorizations get their authorization row (no fact, amount
-- or capture is invented or changed).
--
--   * `refund_authorization` (R6C-1): one per authorized refund attempt (the consumed Auth receipt), with the approved full amount and
--     currency, the cumulative `allocatedIntended` and `completedAt`. FC-2: `0 <= allocatedIntended <= approvedAmount` on the row; the counter
--     equals the sum of its allocations (a DEFERRED constraint trigger). FC-3: `completedAt` is set once, exactly when `allocatedIntended`
--     reaches `approvedAmount`; at most one completed authorization per refund case and per payment, forever (V-3).
--   * `refund_allocation` (R6C-1, R6C-2 Option A, R6C-4, R6C-5): append-only, one per verified `refund` fact (`UNIQUE factId`), bound to that
--     fact's own attempt's authorization and payment, recording the provider's observed amount unchanged with
--     `intended = min(amount, approvedAmount - allocatedIntended)` (0 once the case is complete) and `excess = amount - intended`.
--   * `refund_fact_allocation_block` (R6C-6): a fact that can never be allocated (contested by a contradicting observation, another currency,
--     or no authorization for its attempt) is recorded once, append-only, with its reason, for reconciliation (S6h). The fact itself is untouched.
--   * `refund_fact_allocation_lease` (R6C-6): the allocation worker's retry state for a fact (attempts, next try, last technical failure
--     class), so a technical failure is retried with a bounded backoff, never in a tight loop; it holds no financial meaning.
--   * FC-3, V-3 (R6C-7): a new refund attempt for a refund case or payment whose authorization is completed is refused by the database too.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund_authorization

ALTER TABLE refund_attempt ADD CONSTRAINT refund_attempt_payment_binding UNIQUE (id, "paymentId");

CREATE TABLE refund_authorization (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "refundAttemptId"    uuid NOT NULL UNIQUE,                 -- the authorized attempt (the consumed receipt's consumeRef)
  "paymentId"          uuid NOT NULL,
  "refundCaseId"       uuid NOT NULL,
  producer             text NOT NULL,
  "receiptId"          uuid NOT NULL UNIQUE,                 -- Auth's consumed receipt: one authorization per consumption
  "approvedByUserId"   uuid NOT NULL,                        -- the approver from Auth's consumption (F-16)
  "approvedAmount"     bigint NOT NULL,
  currency             char(3) NOT NULL,
  "allocatedIntended"  bigint NOT NULL DEFAULT 0,
  "completedAt"        timestamptz,
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_authorization_attempt FOREIGN KEY ("refundAttemptId", "paymentId") REFERENCES refund_attempt (id, "paymentId"),
  CONSTRAINT refund_authorization_payment_binding UNIQUE (id, "paymentId"),
  CONSTRAINT refund_authorization_amount CHECK ("approvedAmount" > 0 AND "approvedAmount" <= 9007199254740991),
  CONSTRAINT refund_authorization_currency_upper CHECK (currency = upper(currency)),
  CONSTRAINT refund_authorization_bounded CHECK ("allocatedIntended" >= 0 AND "allocatedIntended" <= "approvedAmount"),      -- FC-2, DB-17
  CONSTRAINT refund_authorization_completion CHECK (("completedAt" IS NOT NULL) = ("allocatedIntended" = "approvedAmount"))  -- FC-3
);
-- V-3: a refund case, and a payment, are completed at most once, forever
CREATE UNIQUE INDEX refund_authorization_case_completed ON refund_authorization ("refundCaseId") WHERE "completedAt" IS NOT NULL;
CREATE UNIQUE INDEX refund_authorization_payment_completed ON refund_authorization ("paymentId") WHERE "completedAt" IS NOT NULL;
CREATE INDEX refund_authorization_payment_idx ON refund_authorization ("paymentId");
CREATE INDEX refund_authorization_case_idx ON refund_authorization ("refundCaseId");

-- the authorization is created only from an authorized attempt, with that attempt's own binding and Auth's consumption
CREATE FUNCTION refund_authorization_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a refund_attempt%ROWTYPE;
BEGIN
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId";
  IF a.id IS NULL OR a."receiptId" IS NULL OR a."receiptId" <> NEW."receiptId" OR a."approvedByUserId" <> NEW."approvedByUserId"
     OR a."paymentId" <> NEW."paymentId" OR a."refundCaseId" <> NEW."refundCaseId" OR a.producer <> NEW.producer
     OR a.amount <> NEW."approvedAmount" OR a.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund_authorization: not the consumed authorization of attempt %', NEW."refundAttemptId" USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_from_attempt';
  END IF;
  IF NEW."allocatedIntended" <> 0 OR NEW."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'refund_authorization: starts with nothing allocated' USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_created_empty';
  END IF;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_authorization_05_insert_guard BEFORE INSERT ON refund_authorization FOR EACH ROW EXECUTE FUNCTION refund_authorization_insert_guard();
CREATE TRIGGER refund_authorization_10_immutable BEFORE UPDATE ON refund_authorization
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'refundAttemptId', 'paymentId', 'refundCaseId', 'producer', 'receiptId', 'approvedByUserId',
    'approvedAmount', 'currency', 'createdAt');

-- the counter only grows; completedAt is set once and never changes
CREATE FUNCTION refund_authorization_progress_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."allocatedIntended" < OLD."allocatedIntended" THEN
    RAISE EXCEPTION 'refund_authorization %: the allocated amount never decreases', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_monotonic';
  END IF;
  IF OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt" THEN
    RAISE EXCEPTION 'refund_authorization %: completedAt is set once', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_completed_once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_authorization_20_progress BEFORE UPDATE ON refund_authorization FOR EACH ROW EXECUTE FUNCTION refund_authorization_progress_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── refund_allocation

CREATE TABLE refund_allocation (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "factId"                  uuid NOT NULL UNIQUE,            -- one allocation per provider fact, ever
  "refundAuthorizationId"   uuid NOT NULL,
  "paymentId"               uuid NOT NULL,
  "refundAttemptId"         uuid NOT NULL,
  amount                    bigint NOT NULL,                 -- the provider's observed amount, unchanged
  currency                  char(3) NOT NULL,
  intended                  bigint NOT NULL,
  excess                    bigint NOT NULL,
  "allocatedAt"             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_allocation_authorization FOREIGN KEY ("refundAuthorizationId", "paymentId") REFERENCES refund_authorization (id, "paymentId"),
  CONSTRAINT refund_allocation_fact FOREIGN KEY ("factId") REFERENCES provider_transaction_fact (id),
  CONSTRAINT refund_allocation_amounts CHECK (amount > 0 AND intended >= 0 AND excess >= 0 AND intended + excess = amount)
);
CREATE INDEX refund_allocation_authorization_idx ON refund_allocation ("refundAuthorizationId");

-- the allocation is bound to the fact as observed: a refund fact of this attempt and payment, its amount and currency unchanged, uncontested,
-- and to that attempt's own authorization
CREATE FUNCTION refund_allocation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f provider_transaction_fact%ROWTYPE; z refund_authorization%ROWTYPE;
BEGIN
  SELECT * INTO f FROM provider_transaction_fact WHERE id = NEW."factId";
  SELECT * INTO z FROM refund_authorization WHERE id = NEW."refundAuthorizationId";
  IF f.kind IS DISTINCT FROM 'refund' OR f."refundAttemptId" <> NEW."refundAttemptId" OR f."paymentId" <> NEW."paymentId"
     OR f.amount <> NEW.amount OR f.currency <> NEW.currency::text OR z."refundAttemptId" <> NEW."refundAttemptId" OR z.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund_allocation: fact % is not this authorization''s verified refund', NEW."factId" USING ERRCODE = '23514', CONSTRAINT = 'refund_allocation_binding';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = NEW."factId")
     OR EXISTS (SELECT 1 FROM refund_fact_allocation_block b WHERE b."factId" = NEW."factId") THEN
    RAISE EXCEPTION 'refund_allocation: fact % is contested or blocked', NEW."factId" USING ERRCODE = '23514', CONSTRAINT = 'refund_allocation_eligible';
  END IF;
  NEW."allocatedAt" := now();
  RETURN NEW;
END $$;

CREATE FUNCTION refund_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (financial evidence is never edited or deleted)', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- FC-2: the counter equals the sum of the allocations, checked at commit
CREATE FUNCTION refund_authorization_sum_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zid uuid; total bigint; counter bigint;
BEGIN
  -- separate statements: a single expression naming NEW."refundAuthorizationId" fails on an authorization row
  IF TG_TABLE_NAME = 'refund_allocation' THEN
    zid := NEW."refundAuthorizationId";
  ELSE
    zid := NEW.id;
  END IF;
  SELECT COALESCE(sum(intended), 0) INTO total FROM refund_allocation WHERE "refundAuthorizationId" = zid;
  SELECT "allocatedIntended" INTO counter FROM refund_authorization WHERE id = zid;
  IF counter IS DISTINCT FROM total THEN
    RAISE EXCEPTION 'refund_authorization %: allocatedIntended % differs from the sum of its allocations %', zid, counter, total
      USING ERRCODE = '23514', CONSTRAINT = 'refund_authorization_sum';
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── blocked facts and the worker's lease

CREATE TABLE refund_fact_allocation_block (
  "factId"      uuid PRIMARY KEY REFERENCES provider_transaction_fact (id),
  reason        text NOT NULL,
  "blockedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_fact_allocation_block_reason CHECK (reason IN ('contested', 'currency_mismatch', 'no_authorization'))
);

CREATE TABLE refund_fact_allocation_lease (
  "factId"        uuid PRIMARY KEY REFERENCES provider_transaction_fact (id),
  attempts        integer NOT NULL DEFAULT 0,
  "workAfter"     timestamptz,
  "lastFailure"   text,
  CONSTRAINT refund_fact_allocation_lease_attempts CHECK (attempts >= 0),
  CONSTRAINT refund_fact_allocation_lease_failure CHECK ("lastFailure" IS NULL OR "lastFailure" ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE TRIGGER refund_allocation_05_insert_guard BEFORE INSERT ON refund_allocation FOR EACH ROW EXECUTE FUNCTION refund_allocation_insert_guard();
CREATE TRIGGER refund_allocation_10_append_only BEFORE UPDATE OR DELETE ON refund_allocation FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_allocation_11_no_truncate BEFORE TRUNCATE ON refund_allocation FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_fact_allocation_block_10_append_only BEFORE UPDATE OR DELETE ON refund_fact_allocation_block FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_fact_allocation_block_11_no_truncate BEFORE TRUNCATE ON refund_fact_allocation_block FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_authorization_90_no_delete BEFORE DELETE ON refund_authorization FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_authorization_91_no_truncate BEFORE TRUNCATE ON refund_authorization FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE CONSTRAINT TRIGGER refund_allocation_30_sum AFTER INSERT ON refund_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_authorization_sum_check();
CREATE CONSTRAINT TRIGGER refund_authorization_30_sum AFTER INSERT OR UPDATE ON refund_authorization DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_authorization_sum_check();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── FC-3, V-3: a completed case refuses new attempts

ALTER TABLE refund_attempt_refusal DROP CONSTRAINT refund_attempt_refusal_code;
ALTER TABLE refund_attempt_refusal ADD CONSTRAINT refund_attempt_refusal_code CHECK (code IN ('payment_not_refundable', 'refund_capture_unverified',
  'refund_amount_not_full', 'refund_dispute_open', 'refund_in_progress', 'refund_already_recorded', 'refund_case_completed'));

CREATE FUNCTION refund_attempt_case_completed_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM refund_authorization z WHERE z."completedAt" IS NOT NULL AND (z."refundCaseId" = NEW."refundCaseId" OR z."paymentId" = NEW."paymentId")) THEN
    RAISE EXCEPTION 'refund_attempt: refund case % is completed', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_case_completed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_04_case_completed BEFORE INSERT ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_case_completed_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── existing S6b authorizations

-- every attempt Auth already authorized gets its authorization row (nothing allocated; the worker allocates its existing refund facts)
INSERT INTO refund_authorization ("refundAttemptId", "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", "approvedAmount", currency)
SELECT id, "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", amount, currency FROM refund_attempt WHERE "receiptId" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── runtime grants

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_authorization, refund_fact_allocation_lease FROM PUBLIC;
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_allocation, refund_fact_allocation_block FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('refund_authorization', 'refund_allocation', 'refund_fact_allocation_block', 'refund_fact_allocation_lease')
       AND a.grantee <> c.relowner AND a.grantee <> 0
       AND (a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
            OR (a.privilege_type = 'UPDATE' AND c.relname IN ('refund_allocation', 'refund_fact_allocation_block')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
