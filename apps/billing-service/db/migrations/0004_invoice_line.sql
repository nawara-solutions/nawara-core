-- Invoice lines: insert-only, immutable, and a SNAPSHOT of what was charged (SDD sections 10, BI-04 to BI-07).
-- A line never depends on the current product or price to say what was charged: it copies quantity, unit amount, description,
-- product code and the entitlement snapshot at creation.

CREATE TABLE invoice_line (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoiceId"       uuid NOT NULL,
  currency          char(3) NOT NULL,
  "lineNumber"      integer NOT NULL,
  -- provenance inside Billing's own database; the amounts below are the truth
  "priceId"         uuid NOT NULL REFERENCES price (id),
  "productId"       uuid NOT NULL REFERENCES product (id),
  "productCode"     text NOT NULL,
  description       text NOT NULL,
  quantity          integer NOT NULL,
  "unitAmount"      bigint NOT NULL,
  "lineTotal"       bigint NOT NULL,
  "taxAmount"       bigint NOT NULL DEFAULT 0,
  -- snapshot of what was sold, so an entitlement decision at payment time never reads today's catalog (Stage 8)
  "entitlementKind" text NOT NULL,
  "interval"        text NOT NULL,
  "intervalUnit"    text,
  "intervalCount"   integer,
  "sourceType"      text,
  "sourceId"        text,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),

  -- BI-04: a line's currency is its invoice's (composite FK; the invoice's currency is immutable, BI-03)
  CONSTRAINT invoice_line_invoice_fk FOREIGN KEY ("invoiceId", currency) REFERENCES invoice (id, currency),
  CONSTRAINT invoice_line_number_unique UNIQUE ("invoiceId", "lineNumber"),
  CONSTRAINT invoice_line_number_range CHECK ("lineNumber" BETWEEN 1 AND 100),
  CONSTRAINT invoice_line_quantity_positive CHECK (quantity >= 1),                                -- BI-02: integer quantities only (B-034)
  CONSTRAINT invoice_line_unit_amount_positive CHECK ("unitAmount" > 0),
  CONSTRAINT invoice_line_total_positive CHECK ("lineTotal" > 0),
  CONSTRAINT invoice_line_tax_nonnegative CHECK ("taxAmount" >= 0),
  CONSTRAINT invoice_line_amounts_safe CHECK ("unitAmount" <= 9007199254740991 AND "lineTotal" <= 9007199254740991 AND "taxAmount" <= 9007199254740991),
  -- BI-05: computed as numeric so the check itself can never overflow into a different error
  CONSTRAINT invoice_line_total_is_quantity_times_unit CHECK ("lineTotal"::numeric = quantity::numeric * "unitAmount"::numeric),
  CONSTRAINT invoice_line_product_code_shape CHECK ("productCode" ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT invoice_line_description_shape CHECK (btrim(description) <> '' AND char_length(description) <= 140),
  CONSTRAINT invoice_line_entitlement_kind_valid CHECK ("entitlementKind" IN ('none', 'organization_license', 'user_subscription')),
  CONSTRAINT invoice_line_interval_valid CHECK ("interval" IN ('one_time', 'recurring')),
  CONSTRAINT invoice_line_interval_shape CHECK (
    ("interval" = 'one_time' AND "intervalUnit" IS NULL AND "intervalCount" IS NULL)
    OR ("interval" = 'recurring' AND "intervalUnit" IS NOT NULL AND "intervalUnit" IN ('day', 'week', 'month', 'year') AND "intervalCount" IS NOT NULL AND "intervalCount" >= 1)
  ),
  CONSTRAINT invoice_line_source_pair CHECK (
    ("sourceType" IS NULL AND "sourceId" IS NULL)
    OR ("sourceType" IS NOT NULL AND "sourceType" ~ '^[a-z][a-z0-9_]{1,62}$' AND "sourceId" IS NOT NULL AND char_length("sourceId") BETWEEN 1 AND 128)
  )
);
CREATE INDEX invoice_line_invoice_idx ON invoice_line ("invoiceId");

-- BI-07: lines are inserted only into a draft invoice (the invoice row is share-locked, so it cannot be issued underneath us),
-- and are never updated or deleted, ever.
CREATE FUNCTION billing_invoice_line_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM invoice WHERE id = NEW."invoiceId" FOR SHARE;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'lines can be added only to a draft invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_line_05_insert_guard BEFORE INSERT ON invoice_line FOR EACH ROW EXECUTE FUNCTION billing_invoice_line_insert_guard();
CREATE TRIGGER invoice_line_10_append_only BEFORE UPDATE OR DELETE ON invoice_line FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- BI-05: the header equals its lines, checked when the transaction COMMITS (the invoice is inserted before its lines). Sums are
-- numeric so the check cannot overflow. A zero-line invoice and one with more than 100 lines are refused.
CREATE FUNCTION billing_invoice_totals_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv uuid;
  h record;
  n integer;
  s numeric;
  t numeric;
BEGIN
  IF TG_TABLE_NAME = 'invoice' THEN inv := NEW.id; ELSE inv := NEW."invoiceId"; END IF;
  SELECT subtotal, "taxTotal", total INTO h FROM invoice WHERE id = inv;
  SELECT count(*), coalesce(sum("lineTotal"::numeric), 0), coalesce(sum("taxAmount"::numeric), 0) INTO n, s, t FROM invoice_line WHERE "invoiceId" = inv;
  IF n < 1 OR n > 100 OR s <> h.subtotal::numeric OR t <> h."taxTotal"::numeric OR s + t <> h.total::numeric THEN
    RAISE EXCEPTION 'invoice %: totals must equal the sum of 1 to 100 lines (BI-05)', inv USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_totals_at_commit AFTER INSERT ON invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_invoice_totals_check();
CREATE CONSTRAINT TRIGGER invoice_line_totals_at_commit AFTER INSERT ON invoice_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_invoice_totals_check();
