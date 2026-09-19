-- Which currencies a PLATFORM has enabled for its future billing operations (three layers: the global `currency` reference, this
-- Platform-level configuration, and the historical currency an invoice carries).
--
-- FOUNDATION ONLY. What is here is justified without deciding anything: the enabled set is data, it can only name a currency that exists
-- in the immutable `currency` reference, and it can never reach a historical record. What is NOT decided (see B-036) and therefore not
-- built: how an invoice determines its Platform, who administers this table, a Platform default currency, an Organization-level
-- restriction, and how this set combines with BILLING_SUPPORTED_CURRENCIES. Nothing calls `billing_currency_permitted` yet.
--
-- Ownership: `platformId` is an OPAQUE reference to a Platform that Auth (later organization-service) owns; there is no foreign key and
-- no Platform table in Billing. The currency's exponent lives only in `currency`: this table has no such column, so a Platform can
-- never change or override it. There is NO reference from `invoice`, `invoice_line` or `payment_request` to this table: changing it
-- cannot touch a historical financial record. An Organization-level restriction can later be added as its own table referencing
-- (platformId, currency) without changing this one.

CREATE TABLE platform_currency (
  "platformId" text NOT NULL,
  currency     char(3) NOT NULL REFERENCES currency (code),      -- an unknown currency cannot be enabled
  enabled      boolean NOT NULL DEFAULT true,                    -- disabling is a flag: the row (and its history of use) stays
  revision     integer NOT NULL DEFAULT 0,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_currency_pkey PRIMARY KEY ("platformId", currency),
  CONSTRAINT platform_currency_platform_id_shape CHECK (char_length("platformId") BETWEEN 1 AND 128 AND btrim("platformId") <> ''),
  CONSTRAINT platform_currency_revision_nonnegative CHECK (revision >= 0)
);

CREATE FUNCTION billing_platform_currency_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revision <> 0 THEN
    RAISE EXCEPTION 'a platform currency is created at revision 0' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER platform_currency_05_insert_guard BEFORE INSERT ON platform_currency FOR EACH ROW EXECUTE FUNCTION billing_platform_currency_insert_guard();

-- Immutable by default: only the flag (and the columns the touch trigger below owns) may change. The platform and the currency of a
-- row can never be re-pointed.
CREATE TRIGGER platform_currency_10_immutable BEFORE UPDATE ON platform_currency
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('enabled', 'revision', 'updatedAt');

-- `revision` and `updatedAt` move only when the flag actually changes, and are overwritten here so a caller can never supply them.
CREATE FUNCTION billing_platform_currency_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.enabled IS DISTINCT FROM OLD.enabled THEN
    NEW.revision := OLD.revision + 1;
    NEW."updatedAt" := now();
  ELSE
    NEW.revision := OLD.revision;
    NEW."updatedAt" := OLD."updatedAt";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_currency_20_touch BEFORE UPDATE ON platform_currency FOR EACH ROW EXECUTE FUNCTION billing_platform_currency_touch();
CREATE TRIGGER platform_currency_90_no_delete BEFORE DELETE ON platform_currency FOR EACH ROW EXECUTE FUNCTION billing_no_delete();

-- The one question later billing operations will ask: may this Platform use this currency for NEW work? True only when the currency
-- exists globally (guaranteed by the foreign key) AND the Platform has it enabled. No row means "not permitted". It reads nothing about
-- any invoice: whether an existing invoice keeps working when its currency is disabled is not decided here.
CREATE FUNCTION billing_currency_permitted(p_platform_id text, p_currency text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM platform_currency WHERE "platformId" = p_platform_id AND currency = p_currency AND enabled);
$$;
