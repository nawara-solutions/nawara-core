-- 0038 — billing-service: fraud holds, their evidence, termination and exact-duration compensation evidence (Core V2 S6e-H; register
-- BIL-27; S0 §1.1; OD-10 resolved by the Owner's H-1 to H-7 and compensation option C-1, 2026-10-29). DEVELOPMENT AND SIMULATION ONLY.
--
--   * H-1: a hold suspends ONE beneficiary's Personal entitlement to ONE product (its personal subscription), of the Owner's Company and the
--     product's Platform. It never touches a purchase, a reversal, a payment request, an obligation or any other subscription.
--   * H-2 / H-3: placed by the Owner with a consumed `fraud_hold_place` receipt and at least one File `fraud_evidence` grant for exactly
--     this hold, Company and beneficiary (append-only references); released only with a `fraud_hold_release` receipt.
--   * H-4: it restricts from `placedAt` (the database clock, at millisecond precision) until the EARLIER of its release and
--     `placedAt + 14 days`; that end is a pure function of these rows, so entitlement reads apply it directly, whatever the sweep's delay.
--     No hold of a subscription may be placed while another still restricts it (no stacking, no silent extension).
--   * C-1: the effective compensation is DERIVED (see `src/fraud-holds/fraud-hold-intervals.ts`) from the current paid spans and the holds;
--     `fraud_hold_compensation` is the append-only evidence of what each terminated hold denied when the sweep recorded it.
-- Every row here is append-only; none is ever deleted.

CREATE TABLE fraud_hold (
  id                        uuid PRIMARY KEY,                 -- chosen before placement: the Owner's receipt names it
  "personalSubscriptionId"  uuid NOT NULL REFERENCES personal_subscription (id),
  "companyId"               uuid NOT NULL,
  "platformId"              uuid NOT NULL,
  "productId"               uuid NOT NULL,
  "beneficiaryUserId"       text NOT NULL,
  reason                    text NOT NULL,
  "placedByUserId"          uuid NOT NULL,
  "receiptId"               uuid NOT NULL UNIQUE,             -- Auth's consumed placement receipt
  "placedAt"                timestamptz NOT NULL,
  "expiresAt"               timestamptz NOT NULL,
  CONSTRAINT fraud_hold_reason CHECK (reason IN ('account_takeover', 'stolen_payment_method', 'identity_fraud', 'chargeback_abuse', 'promotion_abuse')),
  CONSTRAINT fraud_hold_review_window CHECK ("expiresAt" = "placedAt" + interval '14 days'),
  CONSTRAINT fraud_hold_subscription FOREIGN KEY ("personalSubscriptionId", "beneficiaryUserId", "productId") REFERENCES personal_subscription (id, "userId", "productId")
);
CREATE INDEX fraud_hold_subscription_idx ON fraud_hold ("personalSubscriptionId", "placedAt");

-- the scope is Billing's own: the product is a personal product of that Platform, the Platform is the Company's; the clock is the database's;
-- no other hold of the subscription still restricts it (the subscription's advisory lock serializes every hold change of it)
CREATE FUNCTION billing_fraud_hold_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM personal_subscription s JOIN product p ON p.id = s."productId" JOIN billing_platform b ON b."platformId" = p."platformId"
     WHERE s.id = NEW."personalSubscriptionId" AND s."platformId" = NEW."platformId" AND p."subscriptionTarget" = 'personal' AND b."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'fraud hold: not a personal product of a Platform of this Company' USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_scope';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.fraud_hold:' || NEW."personalSubscriptionId", 0));
  NEW."placedAt" := date_trunc('milliseconds', clock_timestamp());
  NEW."expiresAt" := NEW."placedAt" + interval '14 days';
  IF EXISTS (
    SELECT 1 FROM fraud_hold h LEFT JOIN fraud_hold_release r ON r."holdId" = h.id
     WHERE h."personalSubscriptionId" = NEW."personalSubscriptionId" AND LEAST(h."expiresAt", COALESCE(r."releasedAt", h."expiresAt")) > NEW."placedAt") THEN
    RAISE EXCEPTION 'fraud hold: another hold still restricts this subscription' USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_active';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── evidence (H-3)

CREATE TABLE fraud_hold_evidence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "holdId"      uuid NOT NULL REFERENCES fraud_hold (id),
  "grantId"     uuid NOT NULL UNIQUE,                         -- File's `fraud_evidence` grant, verified live: its case is this hold
  "fileId"      uuid NOT NULL,
  "verifiedAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fraud_hold_evidence_once UNIQUE ("holdId", "fileId")
);

-- a hold exists only with its evidence: checked when the placing transaction commits
CREATE FUNCTION billing_fraud_hold_evidence_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fraud_hold_evidence e WHERE e."holdId" = NEW.id) THEN
    RAISE EXCEPTION 'fraud hold %: no evidence', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_evidence_required';
  END IF;
  RETURN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── termination (H-4)

CREATE TABLE fraud_hold_release (
  "holdId"            uuid PRIMARY KEY REFERENCES fraud_hold (id),
  "releasedAt"        timestamptz NOT NULL,
  "releasedByUserId"  uuid NOT NULL,
  "receiptId"         uuid NOT NULL UNIQUE
);
CREATE FUNCTION billing_fraud_hold_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h fraud_hold%ROWTYPE;
BEGIN
  SELECT * INTO h FROM fraud_hold WHERE id = NEW."holdId";
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.fraud_hold:' || h."personalSubscriptionId", 0));
  NEW."releasedAt" := date_trunc('milliseconds', clock_timestamp());
  IF NEW."releasedAt" >= h."expiresAt" OR EXISTS (SELECT 1 FROM fraud_hold_expiry x WHERE x."holdId" = NEW."holdId") THEN
    RAISE EXCEPTION 'fraud hold %: already ended at its 14-day review deadline', NEW."holdId" USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_not_active';
  END IF;
  RETURN NEW;
END $$;

-- the sweep's record of a hold that reached its deadline unreleased (its restriction ended at expiresAt whether or not this row exists)
CREATE TABLE fraud_hold_expiry (
  "holdId"       uuid PRIMARY KEY REFERENCES fraud_hold (id),
  "expiredAt"    timestamptz NOT NULL,
  "recordedAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION billing_fraud_hold_expiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h fraud_hold%ROWTYPE;
BEGIN
  SELECT * INTO h FROM fraud_hold WHERE id = NEW."holdId";
  PERFORM pg_advisory_xact_lock(hashtextextended('billing.fraud_hold:' || h."personalSubscriptionId", 0));
  NEW."expiredAt" := h."expiresAt";
  NEW."recordedAt" := clock_timestamp();
  IF h."expiresAt" > NEW."recordedAt" OR EXISTS (SELECT 1 FROM fraud_hold_release r WHERE r."holdId" = NEW."holdId") THEN
    RAISE EXCEPTION 'fraud hold %: not expired (released, or its deadline is ahead)', NEW."holdId" USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_not_expired';
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── compensation evidence (C-1)

-- what a TERMINATED hold denied of otherwise-valid paid entitlement (its own time, not already denied by an earlier hold), in exact
-- milliseconds, when the sweep recorded it. Evidence only: the effective compensation is re-derived from the current ledger, so a later
-- reversal reduces it without editing this row.
CREATE TABLE fraud_hold_compensation (
  "holdId"                  uuid PRIMARY KEY REFERENCES fraud_hold (id),
  "personalSubscriptionId"  uuid NOT NULL REFERENCES personal_subscription (id),
  "deniedMs"                bigint NOT NULL,
  "holdEndedAt"             timestamptz NOT NULL,
  "computedAt"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fraud_hold_compensation_denied CHECK ("deniedMs" >= 0 AND "deniedMs" <= 1209600000)   -- never more than the 14-day window
);
CREATE FUNCTION billing_fraud_hold_compensation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h fraud_hold%ROWTYPE; ended timestamptz;
BEGIN
  SELECT * INTO h FROM fraud_hold WHERE id = NEW."holdId";
  SELECT LEAST(h."expiresAt", COALESCE((SELECT r."releasedAt" FROM fraud_hold_release r WHERE r."holdId" = h.id), h."expiresAt")) INTO ended;
  IF h."personalSubscriptionId" IS DISTINCT FROM NEW."personalSubscriptionId" OR NEW."holdEndedAt" IS DISTINCT FROM ended OR ended > clock_timestamp()
     OR NEW."deniedMs" > (EXTRACT(EPOCH FROM (ended - h."placedAt")) * 1000)::bigint THEN
    RAISE EXCEPTION 'fraud hold %: compensation evidence only for an ended hold, within its own window', NEW."holdId" USING ERRCODE = '23514', CONSTRAINT = 'fraud_hold_compensation_ended';
  END IF;
  NEW."computedAt" := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER fraud_hold_05_guard BEFORE INSERT ON fraud_hold FOR EACH ROW EXECUTE FUNCTION billing_fraud_hold_insert_guard();
CREATE CONSTRAINT TRIGGER fraud_hold_06_evidence AFTER INSERT ON fraud_hold DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_fraud_hold_evidence_required();
CREATE TRIGGER fraud_hold_release_05_guard BEFORE INSERT ON fraud_hold_release FOR EACH ROW EXECUTE FUNCTION billing_fraud_hold_release_guard();
CREATE TRIGGER fraud_hold_expiry_05_guard BEFORE INSERT ON fraud_hold_expiry FOR EACH ROW EXECUTE FUNCTION billing_fraud_hold_expiry_guard();
CREATE TRIGGER fraud_hold_compensation_05_guard BEFORE INSERT ON fraud_hold_compensation FOR EACH ROW EXECUTE FUNCTION billing_fraud_hold_compensation_guard();
CREATE TRIGGER fraud_hold_10_append_only BEFORE UPDATE OR DELETE ON fraud_hold FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_11_no_truncate BEFORE TRUNCATE ON fraud_hold FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_evidence_10_append_only BEFORE UPDATE OR DELETE ON fraud_hold_evidence FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_evidence_11_no_truncate BEFORE TRUNCATE ON fraud_hold_evidence FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_release_10_append_only BEFORE UPDATE OR DELETE ON fraud_hold_release FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_release_11_no_truncate BEFORE TRUNCATE ON fraud_hold_release FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_expiry_10_append_only BEFORE UPDATE OR DELETE ON fraud_hold_expiry FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_expiry_11_no_truncate BEFORE TRUNCATE ON fraud_hold_expiry FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_compensation_10_append_only BEFORE UPDATE OR DELETE ON fraud_hold_compensation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fraud_hold_compensation_11_no_truncate BEFORE TRUNCATE ON fraud_hold_compensation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── runtime grants

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON fraud_hold, fraud_hold_evidence, fraud_hold_release, fraud_hold_expiry, fraud_hold_compensation FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('fraud_hold', 'fraud_hold_evidence', 'fraud_hold_release', 'fraud_hold_expiry', 'fraud_hold_compensation')
       AND a.grantee <> c.relowner AND a.grantee <> 0 AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
