-- Core V2 S3a (ADR-0044 Part B, B2 as amended by the Owner's S3a decision, Option C; S0 §3.2 DB-1 to DB-4, DB-7; register BIL-08):
-- an immutable routing record on every newly issued invoice.
--
--   * invoice_entitlement: ONE row per invoice issued from now on (DB-2), written in the issuing transaction from server-side facts only
--     (DB-7), never updated or deleted (DB-1). purpose / target / payer / beneficiary / reference combinations are one same-row CHECK
--     (DB-3); the payer is tied to the invoice and the target to the product (0019) by composite foreign keys (DB-3, DB-4). Purposes:
--
--       purpose                    target         payer                     beneficiary     reference
--       organization_subscription  organization   user                      —               organization (+ the product)
--       direct_purchase            personal       user (= beneficiary)      the buyer       the product
--       non_entitlement            none           any                       —               —   (Owner-approved fifth purpose, S3a)
--
--     `assisted_settlement` (S5a, DB-5) and `recovery_settlement` (S6, DB-6, DB-8) need tables that do not exist yet: the CHECK admits
--     neither, so they fail closed until their slices add their columns, foreign keys and arms. The effect tables of DB-9 / DB-10 come
--     with S3b / S3c / S6; `(invoiceId, purpose)` is unique here so they can reference it.
--   * No backfill: an invoice issued before this migration has no routing record and stays inert for subscriptions (the application
--     never derives one, and never from `entitlementKind`). A routing record can only be written for an invoice still in `draft`.
-- Expand only: one new constraint every existing row satisfies, one new table.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── invoice_entitlement (B2)

-- DB-3: the routing record's payer is the invoice's payer
ALTER TABLE invoice ADD CONSTRAINT invoice_id_payer_unique UNIQUE (id, "payerType", "payerId");

CREATE TABLE invoice_entitlement (
  "invoiceId"         uuid PRIMARY KEY,
  purpose             text NOT NULL,
  target              text NOT NULL,
  "payerType"         text NOT NULL,
  "payerId"           text NOT NULL,
  "beneficiaryUserId" text,
  "organizationId"    uuid,
  "productId"         uuid,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_entitlement_invoice_fk FOREIGN KEY ("invoiceId", "payerType", "payerId") REFERENCES invoice (id, "payerType", "payerId"),
  -- DB-4: the target is the product's own target (NULL product: no check, and the CHECK below requires NULL only for non_entitlement)
  CONSTRAINT invoice_entitlement_product_fk FOREIGN KEY ("productId", target) REFERENCES product (id, "subscriptionTarget"),
  -- DB-3: the only valid combinations (every arm names its NULLs: a CHECK that evaluates to NULL passes)
  CONSTRAINT invoice_entitlement_combination CHECK (
       (purpose = 'organization_subscription' AND target = 'organization' AND "payerType" = 'user' AND "beneficiaryUserId" IS NULL
        AND "organizationId" IS NOT NULL AND "productId" IS NOT NULL)
    OR (purpose = 'direct_purchase' AND target = 'personal' AND "payerType" = 'user' AND "beneficiaryUserId" IS NOT NULL
        AND "beneficiaryUserId" = "payerId" AND "organizationId" IS NULL AND "productId" IS NOT NULL)
    OR (purpose = 'non_entitlement' AND target = 'none' AND "beneficiaryUserId" IS NULL AND "organizationId" IS NULL AND "productId" IS NULL)
  ),
  -- what the effect tables of DB-9 / DB-10 (S3b, S3c, S6) will reference
  CONSTRAINT invoice_entitlement_invoice_purpose_unique UNIQUE ("invoiceId", purpose)
);
CREATE INDEX invoice_entitlement_product_idx ON invoice_entitlement ("productId") WHERE "productId" IS NOT NULL;

-- Written only while the invoice is still a draft (by the issuing transaction, which holds the invoice row lock): no backfill of an
-- already issued invoice, ever.
CREATE FUNCTION billing_invoice_entitlement_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoice i WHERE i.id = NEW."invoiceId" AND i.status = 'draft') THEN
    RAISE EXCEPTION 'invoice_entitlement %: a routing record is written only when its invoice leaves draft', NEW."invoiceId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_entitlement_05_insert_guard BEFORE INSERT ON invoice_entitlement
  FOR EACH ROW EXECUTE FUNCTION billing_invoice_entitlement_insert_guard();

-- DB-1: never updated, deleted or truncated
CREATE TRIGGER invoice_entitlement_10_append_only BEFORE UPDATE OR DELETE ON invoice_entitlement
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER invoice_entitlement_11_no_truncate BEFORE TRUNCATE ON invoice_entitlement
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- DB-2: an invoice issued from now on (draft → open) has its routing record by the end of the issuing transaction. Deferred, so the
-- record and the transition may be written in either order inside it.
CREATE FUNCTION billing_invoice_routed_at_issue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW.id) THEN
    RAISE EXCEPTION 'invoice % left draft without a routing record', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'invoice_routed_at_issue';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_95_routed_at_issue AFTER UPDATE OF status ON invoice
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'open')
  EXECUTE FUNCTION billing_invoice_routed_at_issue();

-- DB-1: the runtime role keeps INSERT and SELECT only (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON invoice_entitlement FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'invoice_entitlement' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON invoice_entitlement FROM %s', r.role);
  END LOOP;
END $$;
