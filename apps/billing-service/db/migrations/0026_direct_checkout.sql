-- Core V2 S3f direct checkout (register BIL-10; FC-12; the Owner's decisions D1 to D6 and D4 Option A), for Core V2 DEVELOPMENT AND
-- SIMULATION CERTIFICATION ONLY (G-2). B-001 and B-007 stay unresolved: these invoices carry REFERENCE snapshots, not a legal identity,
-- and production refuses checkout in the application (it never mounts the route). Nothing here resolves the production legal issuer.
--
--   * The reserved internal producer `billing-checkout` (D3) may only produce a direct purchase: a user payer, no Organization, a Company
--     seller that is the SIMULATION SELLER REFERENCE (D4: the Platform's Company as Auth verified it in `billing_platform`, not a verified
--     legal seller), exactly one line of quantity 1 of a personal subscription product of that Platform whose Company seller
--     reference is that same Company, issued (never left a draft), with its `direct_purchase` routing to the payer and a payment request,
--     and the version-2 reference snapshots built only from those verified facts (D1). Checked at COMMIT (a deferred constraint trigger),
--     on every write of such an invoice or its lines, so no path (application or raw SQL) can produce another shape under that name.
--   * checkout_idempotency: the register's class M for checkout (D5): (buyer, Idempotency-Key), bound to the exact request, permanent
--     (>= the approved 90 days); a success is replayed.
-- Expand only: a table, a function and two constraint triggers. No existing row is touched.

CREATE FUNCTION billing_checkout_invoice_check(p_invoice uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i invoice%ROWTYPE; n integer; l record;
BEGIN
  SELECT * INTO i FROM invoice WHERE id = p_invoice;
  IF NOT FOUND OR i.producer <> 'billing-checkout' THEN RETURN; END IF;
  SELECT count(*) INTO n FROM invoice_line WHERE "invoiceId" = p_invoice;
  SELECT il.quantity, il.currency AS "lineCurrency", p."platformId", p."subscriptionTarget", p."sellerType" AS "productSellerType", p."sellerId" AS "productSellerId",
         b."companyId", b.currency AS "platformCurrency"
    INTO l
    FROM invoice_line il JOIN product p ON p.id = il."productId" LEFT JOIN billing_platform b ON b."platformId" = p."platformId"
   WHERE il."invoiceId" = p_invoice LIMIT 1;
  IF i."payerType" <> 'user' OR i."organizationId" IS NOT NULL OR i."sellerType" <> 'company' OR i.status = 'draft'
     OR n <> 1 OR l.quantity <> 1 OR l."subscriptionTarget" <> 'personal'
     OR l."companyId" IS NULL OR i."sellerId" <> l."companyId"::text
     OR l."productSellerType" <> 'company' OR l."productSellerId" <> i."sellerId"
     OR i.currency <> l."platformCurrency" OR l."lineCurrency" <> i.currency
     OR i."issuerSnapshot" <> jsonb_build_object('schemaVersion', 2, 'partyType', 'company', 'companyId', i."sellerId", 'platformId', l."platformId"::text, 'legalIdentity', 'not_determined')
     OR i."billToSnapshot" <> jsonb_build_object('schemaVersion', 2, 'partyType', 'user', 'userId', i."payerId", 'legalIdentity', 'not_determined')
     OR NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = p_invoice AND e.purpose = 'direct_purchase' AND e."beneficiaryUserId" = i."payerId")
     OR NOT EXISTS (SELECT 1 FROM payment_request r WHERE r."invoiceId" = p_invoice) THEN
    RAISE EXCEPTION 'invoice %: not a valid direct checkout', p_invoice USING ERRCODE = '23514', CONSTRAINT = 'checkout_invoice_shape';
  END IF;
END $$;

CREATE FUNCTION billing_checkout_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_checkout_invoice_check(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_95_checkout_shape AFTER INSERT OR UPDATE ON invoice DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.producer = 'billing-checkout') EXECUTE FUNCTION billing_checkout_invoice_guard();

CREATE FUNCTION billing_checkout_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_checkout_invoice_check(NEW."invoiceId");
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_line_95_checkout_shape AFTER INSERT ON invoice_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_checkout_line_guard();

-- ──────────────────────────────────────────────────────────────────────────────────────────────── checkout_idempotency

CREATE TABLE checkout_idempotency (
  "buyerUserId"     text NOT NULL,                  -- the member Auth verified (live /auth/me), never a request value
  "idempotencyKey"  text NOT NULL,
  "requestHash"     char(64) NOT NULL,
  "responseStatus"  integer NOT NULL,
  "responseBody"    jsonb NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkout_idempotency_pkey PRIMARY KEY ("buyerUserId", "idempotencyKey"),
  CONSTRAINT checkout_idempotency_key_shape CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT checkout_idempotency_status CHECK ("responseStatus" BETWEEN 200 AND 299)
);
CREATE TRIGGER checkout_idempotency_10_append_only BEFORE UPDATE OR DELETE ON checkout_idempotency FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER checkout_idempotency_11_no_truncate BEFORE TRUNCATE ON checkout_idempotency FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON checkout_idempotency FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'checkout_idempotency' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON checkout_idempotency FROM %s', r.role);
  END LOOP;
END $$;
