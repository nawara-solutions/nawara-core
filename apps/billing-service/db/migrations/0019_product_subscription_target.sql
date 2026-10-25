-- Core V2 S3a (ADR-0044 Part B, B1; register BIL-02 fields): an explicit subscription target on every product.
--
--   * product.subscriptionTarget ∈ {none, organization, personal}. A subscription product (organization or personal) names its Platform
--     and has recurring prices only; an ordinary product is `none` (the Owner's S3a decision). Like every product column but
--     status/revision, both fields are immutable from creation (the 0002 trigger), so they cannot change after a first sale either.
--     Existing products become `none`. The target is never derived from `entitlementKind` (ADR-0045).
--   * This is catalog configuration, not a financial record: invoices and payments still carry no Platform (ADR-0042 DEC-5). The
--     routing record (0020) references the product and its target, never a Platform.
-- Expand only: a nullable column, a defaulted column, constraints every existing row satisfies, one insert guard on price.

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────── product (B1)

ALTER TABLE product
  ADD COLUMN "platformId"         uuid,
  ADD COLUMN "subscriptionTarget" text NOT NULL DEFAULT 'none';

ALTER TABLE product
  ADD CONSTRAINT product_subscription_target_valid CHECK ("subscriptionTarget" IN ('none', 'organization', 'personal')),
  -- a subscription product belongs to exactly one Platform
  ADD CONSTRAINT product_subscription_has_platform CHECK ("subscriptionTarget" = 'none' OR "platformId" IS NOT NULL),
  -- DB-4: the routing record's (productId, target) must name a product WITH that target
  ADD CONSTRAINT product_id_target_unique UNIQUE (id, "subscriptionTarget");

-- A subscription product's prices recur (a one-time price could never be a subscription period): refused at insert. Prices are immutable
-- in these columns (0002), and so is the product's target, so the check at insert holds for ever.
CREATE FUNCTION billing_price_matches_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."interval" <> 'recurring' AND EXISTS (SELECT 1 FROM product p WHERE p.id = NEW."productId" AND p."subscriptionTarget" <> 'none') THEN
    RAISE EXCEPTION 'price %: a subscription product has recurring prices only', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'price_subscription_recurring';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_06_matches_target BEFORE INSERT ON price FOR EACH ROW EXECUTE FUNCTION billing_price_matches_target();
