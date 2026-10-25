-- Core V2 S3b (ADR-0044 B3; S0 §3.2 DB-9, DB-10, DB-11, safeguard S-4; register BIL-09): the Organization settlement guard.
--
-- An Organization Subscription starts or extends a period ONLY in the transaction that records a `subscription_settlement`: the verified
-- settlement of an `organization_subscription` invoice (its immutable routing record, 0020) for that very Organization and product. The
-- settlement evidence is Billing's own record of Payment's authoritative terminal fact: the APPLIED `payment.succeeded` receipt (a
-- provenance-verified Payment event, ADR-0057 §13 / S1, or the reconciler's direct read of Payment), with its payment request and its
-- invoice both `paid` (BI-14). A paid invoice, a request or an event alone is not a settlement.
--
--   * subscription_settlement: append-only (INSERT / SELECT only for the runtime role). DB-9: a same-row CHECK (purpose =
--     organization_subscription) and a composite FK to the routing record on (invoice, purpose, Organization, product), so a settlement
--     can never name another Organization or product than its invoice was routed to. DB-10: UNIQUE(invoiceId), and one settlement per
--     receipt. The Subscription it extends belongs to that Organization and product (composite FK). The transaction that writes it is
--     stamped by the database (never by the caller).
--   * DB-11: a deferred constraint trigger on `subscription`: a period that starts (a new currentPeriodStart) or extends (a later
--     currentPeriodEnd) must have a settlement of that Subscription written in the SAME transaction. Grace, expiry, cancellation and
--     termination are unaffected (they never start or extend a period).
--   * The direct `activate()` / `renew()` operations are retired in the same change (S-4: before this guard, never after).
--   * DB-9 / DB-10 for `subscription_purchase` (S3c) and `recovery_payment` (S6) come with those tables.
-- Expand only: new unique keys every existing row satisfies, one new table, one new deferred trigger. No existing row changes.

ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_settlement_key UNIQUE ("invoiceId", purpose, "organizationId", "productId");
ALTER TABLE subscription ADD CONSTRAINT subscription_settlement_key UNIQUE (id, "organizationId", "productId");

CREATE TABLE subscription_settlement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "invoiceId"        uuid NOT NULL,
  purpose            text NOT NULL,
  "organizationId"   uuid NOT NULL,
  "productId"        uuid NOT NULL,
  "subscriptionId"   uuid NOT NULL,
  "paymentRequestId" uuid NOT NULL REFERENCES payment_request (id),
  "receiptId"        uuid NOT NULL REFERENCES payment_event_receipt (id),
  "settledAt"        timestamptz NOT NULL,
  "transactionId"    xid8 NOT NULL,
  "recordedAt"       timestamptz NOT NULL DEFAULT now(),

  -- DB-9: only an Organization-subscription routing record can be settled here, and only for its own Organization and product
  CONSTRAINT subscription_settlement_purpose CHECK (purpose = 'organization_subscription'),
  CONSTRAINT subscription_settlement_routing_fk FOREIGN KEY ("invoiceId", purpose, "organizationId", "productId")
    REFERENCES invoice_entitlement ("invoiceId", purpose, "organizationId", "productId"),
  CONSTRAINT subscription_settlement_subscription_fk FOREIGN KEY ("subscriptionId", "organizationId", "productId")
    REFERENCES subscription (id, "organizationId", "productId"),
  -- DB-10: at most one settlement (one financial effect) per invoice, and per settlement receipt
  CONSTRAINT subscription_settlement_invoice_unique UNIQUE ("invoiceId"),
  CONSTRAINT subscription_settlement_receipt_unique UNIQUE ("receiptId")
);
CREATE INDEX subscription_settlement_subscription_idx ON subscription_settlement ("subscriptionId", "transactionId");

-- The evidence must be the verified settlement itself: the APPLIED `payment.succeeded` receipt of this invoice's payment request, the
-- request `paid`, the invoice `paid`. The writing transaction is recorded here, whatever the caller sent (DB-11 reads it).
CREATE FUNCTION billing_subscription_settlement_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."transactionId" := pg_current_xact_id();
  IF NOT EXISTS (
    SELECT 1 FROM payment_event_receipt r
      JOIN payment_request pr ON pr.id = r."paymentRequestId"
      JOIN invoice i ON i.id = pr."invoiceId"
     WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded'
       AND r."paymentRequestId" = NEW."paymentRequestId" AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid' AND i.status = 'paid'
  ) THEN
    RAISE EXCEPTION 'subscription_settlement: invoice % has no verified settlement (applied payment.succeeded, request and invoice paid)', NEW."invoiceId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_settlement_verified';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_settlement_05_insert_guard BEFORE INSERT ON subscription_settlement
  FOR EACH ROW EXECUTE FUNCTION billing_subscription_settlement_insert_guard();

CREATE TRIGGER subscription_settlement_10_append_only BEFORE UPDATE OR DELETE ON subscription_settlement
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER subscription_settlement_11_no_truncate BEFORE TRUNCATE ON subscription_settlement
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- DB-11: no Organization period without an Organization settlement, in the same transaction (deferred: checked at commit).
CREATE FUNCTION billing_subscription_period_settled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM subscription_settlement s WHERE s."subscriptionId" = NEW.id AND s."transactionId" = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'subscription %: a period starts or extends only with a subscription_settlement in the same transaction', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_period_settled';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER subscription_95_period_settled AFTER UPDATE OF "currentPeriodStart", "currentPeriodEnd" ON subscription
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (
       NEW."currentPeriodStart" IS DISTINCT FROM OLD."currentPeriodStart"
    OR (NEW."currentPeriodEnd" IS NOT NULL AND (OLD."currentPeriodEnd" IS NULL OR NEW."currentPeriodEnd" > OLD."currentPeriodEnd"))
  )
  EXECUTE FUNCTION billing_subscription_period_settled();
CREATE CONSTRAINT TRIGGER subscription_96_period_settled_insert AFTER INSERT ON subscription
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."currentPeriodStart" IS NOT NULL OR NEW."currentPeriodEnd" IS NOT NULL)
  EXECUTE FUNCTION billing_subscription_period_settled();

-- DB-9 / DB-10: the runtime role keeps INSERT and SELECT only (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON subscription_settlement FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'subscription_settlement' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON subscription_settlement FROM %s', r.role);
  END LOOP;
END $$;
