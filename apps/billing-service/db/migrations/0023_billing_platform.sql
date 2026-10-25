-- Core V2 S3d (register BIL-01, AUTH-07; S0 §3.6, §1.1): `billing_platform`, the commercial configuration of one Platform.
--
--   * One row per Platform: its Company (`companyId`) and its ONE currency. Both are taken from verified facts only: `companyId` is the
--     Company Auth names for the Owner who created the row, after a live `/auth/platform-access` check (never a request value); the
--     currency is the Owner's choice among the immutable `currency` reference. The row is immutable once written (append-only): neither
--     the Company nor the currency of a Platform can be re-pointed, and a row is never deleted.
--   * OD-02 (the Owner's S3d decision): this table is THE Core V2 Platform currency configuration. `platform_currency` (0009, foundation
--     only, never called) is superseded for Core V2: it is left as it is, with its data, and nothing new reads or writes it.
--   * Projection enforcement (the Owner's S3d decision 4): a NEW subscription product (organization or personal) requires its Platform's
--     `billing_platform`, and a price of a subscription product whose Platform is configured must be in that Platform's currency. Existing
--     products, prices, invoices, purchases and settlements are not touched or backfilled: a subscription product created before S3d on a
--     Platform without a row keeps working as before, and becomes bound to the currency once its Platform is configured.
-- Expand only: a new table and two AFTER INSERT guards on product and price (an identical replay that loses to the natural key never
-- fires them, so replays answer exactly as before).

CREATE TABLE billing_platform (
  "platformId" uuid PRIMARY KEY,
  "companyId"  uuid NOT NULL,
  currency     char(3) NOT NULL REFERENCES currency (code),     -- an unknown currency cannot be configured
  "createdBy"  uuid NOT NULL,                                   -- the Owner Auth verified (attribution, never authority)
  "createdAt"  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION billing_platform_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := now(); -- the database clock, never a caller value
  RETURN NEW;
END $$;
CREATE TRIGGER billing_platform_05_insert_guard BEFORE INSERT ON billing_platform FOR EACH ROW EXECUTE FUNCTION billing_platform_insert_guard();

CREATE TRIGGER billing_platform_10_append_only BEFORE UPDATE OR DELETE ON billing_platform
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER billing_platform_11_no_truncate BEFORE TRUNCATE ON billing_platform
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ──────────────────────────────────────────────────────────────────────────────────────── product: a configured Platform

-- AFTER INSERT: the row exists, so the natural-key unique index has already accepted it (a replay never reaches this). `billing_platform`
-- rows are never deleted or changed, so a check that passes at insert holds for ever.
CREATE FUNCTION billing_product_platform_configured() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."subscriptionTarget" <> 'none' AND NOT EXISTS (SELECT 1 FROM billing_platform b WHERE b."platformId" = NEW."platformId") THEN
    RAISE EXCEPTION 'product %: its Platform has no billing configuration', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'product_platform_configured';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER product_30_platform_configured AFTER INSERT ON product FOR EACH ROW EXECUTE FUNCTION billing_product_platform_configured();

-- ──────────────────────────────────────────────────────────────────────────────────────── price: the Platform's currency

CREATE FUNCTION billing_price_platform_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM product p JOIN billing_platform b ON b."platformId" = p."platformId"
              WHERE p.id = NEW."productId" AND p."subscriptionTarget" <> 'none' AND b.currency <> NEW.currency) THEN
    RAISE EXCEPTION 'price %: a subscription price is in its Platform''s currency', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'price_platform_currency';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER price_30_platform_currency AFTER INSERT ON price FOR EACH ROW EXECUTE FUNCTION billing_price_platform_currency();

-- the runtime role keeps INSERT and SELECT only (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON billing_platform FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'billing_platform' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON billing_platform FROM %s', r.role);
  END LOOP;
END $$;
