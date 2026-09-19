-- The invoice: the authoritative obligation, with an immutable financial snapshot (SDD sections 8, 9 and 17.1).
-- Created complete (header and lines in ONE transaction) and immutable from creation, except the small allow-list of lifecycle
-- columns. Gateway-independent: nothing here knows how a payment happens.

CREATE TABLE invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producer           text NOT NULL,
  "invoiceRequestId" uuid NOT NULL,
  -- sha256 of the canonical producer request. Makes "identical replay" (every field equal) a database fact, and a changed replay
  -- a conflict, without re-deriving anything from prices that may have changed since (SDD 25).
  "requestHash"      text NOT NULL,
  "sellerType"       text NOT NULL,
  "sellerId"         text NOT NULL,
  "payerType"        text NOT NULL,
  "payerId"          text NOT NULL,
  "organizationId"   uuid,
  "sourceType"       text NOT NULL,
  "sourceId"         text NOT NULL,
  currency           char(3) NOT NULL REFERENCES currency (code),                       -- BI-11
  subtotal           bigint NOT NULL,
  "taxTotal"         bigint NOT NULL DEFAULT 0,
  total              bigint NOT NULL,
  "taxTreatment"     text NOT NULL DEFAULT 'not_determined',
  description        text,
  "dueAt"            timestamptz,
  number             text,
  status             text NOT NULL DEFAULT 'draft',
  revision           integer NOT NULL DEFAULT 0,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  "issuedAt"         timestamptz,
  "paidAt"           timestamptz,
  "voidedAt"         timestamptz,
  "overdueAt"        timestamptz,
  "updatedAt"        timestamptz NOT NULL DEFAULT now(),
  "voidReasonCode"   text,
  "issuerSnapshot"   jsonb NOT NULL,
  "billToSnapshot"   jsonb NOT NULL,
  presentation       jsonb,

  -- BI-01 / BI-02: integer minor units, positive where positive is required, never above what Payment and a JSON number can carry
  CONSTRAINT invoice_subtotal_positive CHECK (subtotal > 0),
  CONSTRAINT invoice_total_positive CHECK (total > 0),
  CONSTRAINT invoice_tax_nonnegative CHECK ("taxTotal" >= 0),
  CONSTRAINT invoice_amounts_safe CHECK (subtotal <= 9007199254740991 AND "taxTotal" <= 9007199254740991 AND total <= 9007199254740991),
  CONSTRAINT invoice_total_is_subtotal_plus_tax CHECK (total = subtotal + "taxTotal"),        -- BI-05 (header side)
  -- B-006: no tax determination exists. The value is honest ("not determined"), not an assertion that no tax is due.
  CONSTRAINT invoice_tax_treatment_valid CHECK ("taxTreatment" IN ('not_determined')),
  CONSTRAINT invoice_tax_zero_until_determined CHECK ("taxTreatment" <> 'not_determined' OR "taxTotal" = 0),

  -- BI-18: a Billing invoice can never yield a payment request Payment would refuse (Payment contract copied onto the columns)
  CONSTRAINT invoice_seller_type_valid CHECK ("sellerType" IN ('user', 'organization', 'company')),
  CONSTRAINT invoice_payer_type_valid CHECK ("payerType" IN ('user', 'organization', 'company')),
  CONSTRAINT invoice_seller_id_length CHECK (char_length("sellerId") BETWEEN 1 AND 128),
  CONSTRAINT invoice_payer_id_length CHECK (char_length("payerId") BETWEEN 1 AND 128),
  CONSTRAINT invoice_payer_seller_distinct CHECK (("payerType", "payerId") IS DISTINCT FROM ("sellerType", "sellerId")),
  -- an organization seller names its own organization: never NULL (a NULL would slip past a bare equality CHECK)
  CONSTRAINT invoice_organization_matches_seller CHECK ("sellerType" <> 'organization' OR ("organizationId" IS NOT NULL AND "organizationId"::text = "sellerId")),
  CONSTRAINT invoice_currency_shape CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT invoice_source_type_shape CHECK ("sourceType" ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT invoice_source_id_length CHECK (char_length("sourceId") BETWEEN 1 AND 128),
  CONSTRAINT invoice_description_length CHECK (description IS NULL OR char_length(description) <= 140),
  CONSTRAINT invoice_number_length CHECK (number IS NULL OR char_length(number) BETWEEN 1 AND 64),
  CONSTRAINT invoice_void_reason_length CHECK ("voidReasonCode" IS NULL OR char_length("voidReasonCode") BETWEEN 1 AND 64),
  CONSTRAINT invoice_request_hash_shape CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invoice_producer_shape CHECK (producer ~ '^[a-z][a-z0-9-]{1,62}$'),

  -- Lifecycle shape (SDD 17.1): which columns exist in which state
  CONSTRAINT invoice_status_valid CHECK (status IN ('draft', 'open', 'paid', 'void')),
  CONSTRAINT invoice_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT invoice_draft_shape CHECK (status <> 'draft' OR (number IS NULL AND "issuedAt" IS NULL AND presentation IS NULL AND "paidAt" IS NULL AND "voidedAt" IS NULL)),
  CONSTRAINT invoice_open_paid_are_issued CHECK (status NOT IN ('open', 'paid') OR ("issuedAt" IS NOT NULL AND number IS NOT NULL)),
  CONSTRAINT invoice_paid_at_iff_paid CHECK ((status = 'paid') = ("paidAt" IS NOT NULL)),        -- BI-14 (column side)
  CONSTRAINT invoice_voided_at_iff_void CHECK ((status = 'void') = ("voidedAt" IS NOT NULL)),
  CONSTRAINT invoice_void_reason_only_when_void CHECK ("voidReasonCode" IS NULL OR status = 'void'),
  CONSTRAINT invoice_overdue_only_when_issued CHECK ("overdueAt" IS NULL OR "issuedAt" IS NOT NULL),
  CONSTRAINT invoice_number_implies_issued CHECK (number IS NULL OR "issuedAt" IS NOT NULL),
  -- BI-20: the presentation snapshot exists exactly once the invoice has been issued
  CONSTRAINT invoice_issued_has_presentation CHECK ("issuedAt" IS NULL OR presentation IS NOT NULL),

  -- BI-20: snapshots are bounded JSON objects with a schemaVersion. The party snapshots' CONTENT is B-007 and is not decided here.
  -- (`?` first: a missing key makes jsonb_typeof(NULL) NULL, and a CHECK that evaluates to NULL PASSES)
  CONSTRAINT invoice_issuer_snapshot_shape CHECK (
    jsonb_typeof("issuerSnapshot") = 'object' AND "issuerSnapshot" ? 'schemaVersion' AND jsonb_typeof("issuerSnapshot" -> 'schemaVersion') = 'number' AND octet_length("issuerSnapshot"::text) <= 8192),
  CONSTRAINT invoice_bill_to_snapshot_shape CHECK (
    jsonb_typeof("billToSnapshot") = 'object' AND "billToSnapshot" ? 'schemaVersion' AND jsonb_typeof("billToSnapshot" -> 'schemaVersion') = 'number' AND octet_length("billToSnapshot"::text) <= 8192),
  -- The presentation snapshot (SDD 9, 36): WHICH immutable presentation definition and locale the invoice was issued with. Version 1
  -- has exactly these three keys, so it can hold no amount, no markup and no executable content. A later version is a migration.
  CONSTRAINT invoice_presentation_shape CHECK (
    presentation IS NULL OR (
      jsonb_typeof(presentation) = 'object'
      AND presentation ? 'schemaVersion' AND presentation ? 'template' AND presentation ? 'locale'
      AND presentation -> 'schemaVersion' = '1'::jsonb
      AND (presentation - 'schemaVersion' - 'template' - 'locale') = '{}'::jsonb
      AND jsonb_typeof(presentation -> 'template') = 'string' AND presentation ->> 'template' ~ '^[a-z0-9][a-z0-9:._-]{0,63}$'
      AND jsonb_typeof(presentation -> 'locale') = 'string' AND presentation ->> 'locale' ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'
    )),

  CONSTRAINT invoice_request_unique UNIQUE (producer, "invoiceRequestId"),                       -- natural key (SDD 25)
  CONSTRAINT invoice_id_currency_unique UNIQUE (id, currency)                                    -- target of the composite FKs (BI-04)
);
-- BI-10 (TEMPORARY RESTRICTION: the scope of a number is B-004)
CREATE UNIQUE INDEX invoice_number_unique ON invoice ("sellerType", "sellerId", number) WHERE number IS NOT NULL;
CREATE INDEX invoice_payer_idx ON invoice ("payerType", "payerId", "createdAt" DESC);
CREATE INDEX invoice_organization_idx ON invoice ("organizationId");
CREATE INDEX invoice_producer_idx ON invoice (producer, "createdAt" DESC);
CREATE INDEX invoice_overdue_sweep_idx ON invoice ("dueAt") WHERE status = 'open' AND "overdueAt" IS NULL;

-- ---------------------------------------------------------------------------------------------------------------------------
-- Guards. BEFORE triggers fire in name order: 05 insert, 10 immutability, 20 lifecycle, 30 touch.
-- ---------------------------------------------------------------------------------------------------------------------------

-- A row is BORN a draft: it cannot be created already issued, paid or void.
CREATE FUNCTION billing_invoice_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.revision <> 0 OR NEW.number IS NOT NULL OR NEW."issuedAt" IS NOT NULL OR NEW."paidAt" IS NOT NULL
     OR NEW."voidedAt" IS NOT NULL OR NEW."overdueAt" IS NOT NULL OR NEW.presentation IS NOT NULL OR NEW."voidReasonCode" IS NOT NULL THEN
    RAISE EXCEPTION 'an invoice is created as a draft with no lifecycle data' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_05_insert_guard BEFORE INSERT ON invoice FOR EACH ROW EXECUTE FUNCTION billing_invoice_insert_guard();

-- BI-03, BI-06, BI-07, BI-20: IMMUTABLE BY DEFAULT. Only these lifecycle columns may ever change (and the lifecycle trigger below
-- decides WHEN each may). A column added by a later migration is immutable until it is deliberately added to this list.
CREATE TRIGGER invoice_10_immutable BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except(
    'status', 'revision', 'updatedAt', 'number', 'issuedAt', 'presentation', 'paidAt', 'voidedAt', 'voidReasonCode', 'overdueAt');

CREATE FUNCTION billing_invoice_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  issuing boolean := OLD.status = 'draft' AND NEW.status = 'open';
  paying  boolean := OLD.status = 'open' AND NEW.status = 'paid';
  voiding boolean := NEW.status = 'void' AND OLD.status <> 'void';
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- BI-16: exactly these moves. `open -> void` is NOT here: it needs B-015 (a migration adds it when decided).
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('open', 'void')) OR paying) THEN
      RAISE EXCEPTION 'invoice % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  END IF;

  IF issuing THEN
    NEW."issuedAt" := now();
    -- BI-10: the number is assigned ONLY here, by the counter, in this transaction (lock order: invoice, then the sequence row).
    -- Whatever number the caller supplied is discarded; a rollback returns the number.
    NEW.number := billing_allocate_invoice_number(NEW."sellerType", NEW."sellerId");
  ELSIF NEW.number IS DISTINCT FROM OLD.number OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt" THEN
    RAISE EXCEPTION 'invoice %: number and issuedAt are set once, at issue', OLD.id USING ERRCODE = '23514';
  END IF;

  -- BI-20: the presentation snapshot is set exactly once, by the issue transition
  IF NEW.presentation IS DISTINCT FROM OLD.presentation AND NOT (issuing AND OLD.presentation IS NULL) THEN
    RAISE EXCEPTION 'invoice %: presentation is set once, at issue', OLD.id USING ERRCODE = '23514';
  END IF;

  IF voiding THEN
    NEW."voidedAt" := now();
  ELSIF NEW."voidedAt" IS DISTINCT FROM OLD."voidedAt" OR NEW."voidReasonCode" IS DISTINCT FROM OLD."voidReasonCode" THEN
    RAISE EXCEPTION 'invoice %: voidedAt and voidReasonCode are set only when voiding', OLD.id USING ERRCODE = '23514';
  END IF;

  IF paying THEN
    -- BI-14: `paid` only through a payment request that is `paid` for the full total, in this same transaction.
    IF NOT EXISTS (SELECT 1 FROM payment_request WHERE "invoiceId" = NEW.id AND status = 'paid' AND amount = NEW.total) THEN
      RAISE EXCEPTION 'invoice % can become paid only through a paid payment request for its full total', OLD.id USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."paidAt" IS DISTINCT FROM OLD."paidAt" THEN
    RAISE EXCEPTION 'invoice %: paidAt is set only when the invoice is paid', OLD.id USING ERRCODE = '23514';
  END IF;

  -- overdueAt only marks that invoice.overdue was emitted: set once, and only while the invoice is open
  IF NEW."overdueAt" IS DISTINCT FROM OLD."overdueAt" AND (OLD."overdueAt" IS NOT NULL OR OLD.status <> 'open') THEN
    RAISE EXCEPTION 'invoice %: overdueAt is set once, while open', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_20_lifecycle BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION billing_invoice_lifecycle();

-- BI-19: `revision` counts state changes and `updatedAt` follows every update. Both are overwritten here, so a caller can never
-- supply them.
CREATE FUNCTION billing_invoice_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now();
  NEW.revision := OLD.revision + CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_30_touch BEFORE UPDATE ON invoice FOR EACH ROW EXECUTE FUNCTION billing_invoice_touch();

CREATE TRIGGER invoice_90_no_delete BEFORE DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
