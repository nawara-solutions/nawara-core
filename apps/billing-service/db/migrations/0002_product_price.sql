-- Catalog: a generic billable thing a seller offers (product) and its reusable, IMMUTABLE price (SDD sections 11 and 12).
-- Billing knows nothing about what a product means. Invoices never depend on these rows to know what was charged (BI-06):
-- every invoice line copies what it needs.

CREATE TABLE product (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sellerType"      text NOT NULL,
  "sellerId"        text NOT NULL,
  code              text NOT NULL,
  name              text NOT NULL,
  description       text,
  "entitlementKind" text NOT NULL DEFAULT 'none',
  status            text NOT NULL DEFAULT 'active',
  revision          integer NOT NULL DEFAULT 0,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_seller_type_valid CHECK ("sellerType" IN ('user', 'organization', 'company')),
  CONSTRAINT product_seller_id_length CHECK (char_length("sellerId") BETWEEN 1 AND 128),
  -- an organization id is a canonical (lower-case) uuid, exactly what Payment stores and echoes
  CONSTRAINT product_seller_org_is_uuid CHECK ("sellerType" <> 'organization' OR "sellerId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT product_code_shape CHECK (code ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT product_name_shape CHECK (btrim(name) <> '' AND char_length(name) <= 140),
  CONSTRAINT product_description_length CHECK (description IS NULL OR char_length(description) <= 280),
  CONSTRAINT product_entitlement_kind_valid CHECK ("entitlementKind" IN ('none', 'organization_license', 'user_subscription')),
  CONSTRAINT product_status_valid CHECK (status IN ('active', 'archived')),
  CONSTRAINT product_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT product_code_unique UNIQUE ("sellerType", "sellerId", code)
);

-- Everything is immutable except the archive flag (SDD 11: editing name/description is [X]).
CREATE TRIGGER product_10_immutable BEFORE UPDATE ON product
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'revision', 'updatedAt');

CREATE FUNCTION billing_product_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status = 'archived') THEN
    RAISE EXCEPTION 'product % cannot move from % to % (archiving is one way)', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := now();
  NEW.revision := OLD.revision + CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER product_20_lifecycle BEFORE UPDATE ON product FOR EACH ROW EXECUTE FUNCTION billing_product_lifecycle();
CREATE TRIGGER product_90_no_delete BEFORE DELETE ON product FOR EACH ROW EXECUTE FUNCTION billing_no_delete();

CREATE TABLE price (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId"       uuid NOT NULL REFERENCES product (id),
  "clientReference" text NOT NULL,
  currency          char(3) NOT NULL REFERENCES currency (code),
  "unitAmount"      bigint NOT NULL,
  "interval"        text NOT NULL,
  "intervalUnit"    text,
  "intervalCount"   integer,
  "pricingModel"    text NOT NULL DEFAULT 'flat',
  "effectiveFrom"   timestamptz NOT NULL DEFAULT now(),
  "retiredAt"       timestamptz,
  revision          integer NOT NULL DEFAULT 0,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT price_client_reference_shape CHECK ("clientReference" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT price_amount_positive CHECK ("unitAmount" > 0),                                     -- BI-02
  CONSTRAINT price_amount_safe CHECK ("unitAmount" <= 9007199254740991),                         -- BI-01
  CONSTRAINT price_interval_valid CHECK ("interval" IN ('one_time', 'recurring')),
  CONSTRAINT price_interval_shape CHECK (
    ("interval" = 'one_time' AND "intervalUnit" IS NULL AND "intervalCount" IS NULL)
    OR ("interval" = 'recurring' AND "intervalUnit" IS NOT NULL AND "intervalUnit" IN ('day', 'week', 'month', 'year') AND "intervalCount" IS NOT NULL AND "intervalCount" >= 1)
  ),   -- every arm names its NULLs: a CHECK that evaluates to NULL PASSES in PostgreSQL
  CONSTRAINT price_model_flat_only CHECK ("pricingModel" = 'flat'),                              -- tiered/usage pricing is [X]
  CONSTRAINT price_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT price_reference_unique UNIQUE ("productId", "clientReference")
);
CREATE INDEX price_product_idx ON price ("productId");

-- BI-06: every commercial column is immutable; only the retirement stamp may be set, once.
CREATE TRIGGER price_10_immutable BEFORE UPDATE ON price
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('retiredAt', 'revision', 'updatedAt');

CREATE FUNCTION billing_price_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."retiredAt" IS NOT NULL AND NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
    RAISE EXCEPTION 'price %: retiredAt is set once and cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := now();
  NEW.revision := OLD.revision + CASE WHEN NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER price_20_lifecycle BEFORE UPDATE ON price FOR EACH ROW EXECUTE FUNCTION billing_price_lifecycle();
CREATE TRIGGER price_90_no_delete BEFORE DELETE ON price FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
