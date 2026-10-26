-- Core V2 S3g Owner catalog administration (register BIL-02, BIL-03; the Owner's decisions D-CAT-1 to D-CAT-10), for Core V2 DEVELOPMENT
-- AND SIMULATION ONLY. No catalog VALUE is configured here (OD-05 stays open): this only fixes who an Owner product is, and what may sell it.
--
--   * The reserved internal producer `billing-owner` (D-CAT-8 Option C) is the provenance of a product the verified Owner created through
--     `/billing/admin/platforms/:platformId/products`. No service may hold a token in that name (configuration refuses it), and no invoice
--     is ever produced under it. Such a product is, at insert (every product column but status is immutable, 0002), a `personal`
--     subscription product (D-CAT-5a) of a CONFIGURED Platform whose seller is that Platform's Company reference
--     `company:<billing_platform.companyId>` (D-CAT-2, a simulation reference, not a legal issuer: B-001 / B-007 stay open).
--   * Direct checkout (S3f, BIL-10) and new fee proposals (S3f, BIL-06) accept only such a product (D-CAT-8). Both guards fire on INSERT
--     only: an invoice line and a fee proposal are written once, so an existing checkout invoice, its settlement and an already-submitted
--     proposal are never re-judged (nothing historical is rewritten or invalidated).
--   * Producer products, their routes and every Organization subscription workflow are unchanged.
-- Expand only: three functions, three triggers and one CHECK every existing row satisfies. No existing row changes.

-- ──────────────────────────────────────────────────────────────────────────────────────────────── product: Owner provenance

CREATE FUNCTION billing_owner_product_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."subscriptionTarget" <> 'personal' OR NEW."platformId" IS NULL OR NEW."sellerType" <> 'company'
     OR NOT EXISTS (SELECT 1 FROM billing_platform b WHERE b."platformId" = NEW."platformId" AND b."companyId"::text = NEW."sellerId") THEN
    RAISE EXCEPTION 'product %: an Owner product is a personal subscription product of a configured Platform, sold by its Company reference', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'product_owner_shape';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER product_07_owner_shape BEFORE INSERT ON product
  FOR EACH ROW WHEN (NEW.producer = 'billing-owner') EXECUTE FUNCTION billing_owner_product_guard();

-- the Owner's provenance never produces an invoice (the Owner creates catalog entries, never obligations)
ALTER TABLE invoice ADD CONSTRAINT invoice_producer_not_owner CHECK (producer <> 'billing-owner');

-- ──────────────────────────────────────────────────────────────────────────────────────────────── checkout: Owner products only

CREATE FUNCTION billing_checkout_owner_product_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice i WHERE i.id = NEW."invoiceId" AND i.producer = 'billing-checkout')
     AND NOT EXISTS (SELECT 1 FROM product p WHERE p.id = NEW."productId" AND p.producer = 'billing-owner') THEN
    RAISE EXCEPTION 'invoice %: direct checkout sells an Owner product only', NEW."invoiceId" USING ERRCODE = '23514', CONSTRAINT = 'checkout_owner_product';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER invoice_line_96_checkout_owner_product AFTER INSERT ON invoice_line
  FOR EACH ROW EXECUTE FUNCTION billing_checkout_owner_product_guard();

-- ──────────────────────────────────────────────────────────────────────────────────────────────── fee proposals: Owner products only

CREATE FUNCTION billing_fee_proposal_owner_product_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM product p WHERE p.id = NEW."productId" AND p.producer = 'billing-owner') THEN
    RAISE EXCEPTION 'fee proposal %: a fee is proposed on an Owner product only', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'fee_proposal_owner_product';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_proposal_06_owner_product BEFORE INSERT ON fee_proposal
  FOR EACH ROW EXECUTE FUNCTION billing_fee_proposal_owner_product_guard();
