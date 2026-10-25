-- Core V2 S3c (ADR-0044 B4, B5, B6; S0 §1.1, K-3 Option D, DB-9, DB-10, DB-12; register BIL-11): Personal Subscriptions and their
-- append-only purchase ledger.
--
--   * personal_subscription: one per (user, product). The product is a `personal` subscription product and belongs to exactly one
--     Platform (S3a); the row records that Platform. It is owned by the named user, portable across the Platform's Organizations, and
--     grants no Platform authorization or membership. Several may coexist per user and Platform (one per product). Never changed.
--   * subscription_purchase: the ledger. One row per settled `direct_purchase` invoice (assisted purchases, S5a, add their arm later),
--     recorded in the transaction that applies Payment's verified settlement: the APPLIED `payment.succeeded` receipt of its request,
--     the request and the invoice `paid` (the S3b evidence). DB-9: purpose `direct_purchase` only, and a composite FK to the routing
--     record on (invoice, purpose, beneficiary, product) — a purchase can never credit another user or product than its invoice was
--     routed to. DB-10: UNIQUE(invoiceId), UNIQUE(receiptId). DB-12: one purchase per assistance request (a partial unique index; the
--     column stays NULL until S5a adds the assistance request and its foreign key). The original span is laid by the database at insert.
--   * subscription_purchase_reversal: at most one reversal per purchase (B5); written by the refund / chargeback flows (S6).
--   * K-3 Option D (B5): a purchase's EFFECTIVE span is a pure function of the ledger, `billing_personal_spans`: purchases in ledger order,
--     reversed ones removed; each starts at the later of its settlement instant and the end of the previous kept period, and lasts its full
--     paid interval (its price's); a period continuing the previous one keeps the chain's billing anchor (month / year, as 0015), a period
--     after a lapse starts a new chain. Laying (at purchase) and re-laying (after a reversal) are the same fold, so anchors move only
--     through reversals (and lapses), later periods keep their full duration, and a removed span leaves no gap. No grace (B13.2).
-- Expand only: new unique keys every existing row satisfies, new tables and functions. No existing row changes.

ALTER TABLE product ADD CONSTRAINT product_id_target_platform_unique UNIQUE (id, "subscriptionTarget", "platformId");
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_purchase_key UNIQUE ("invoiceId", purpose, "beneficiaryUserId", "productId");

-- ───────────────────────────────────────────────────────────────────────────────────────────────── personal_subscription

CREATE TABLE personal_subscription (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     text NOT NULL,
  "platformId" uuid NOT NULL,
  "productId"  uuid NOT NULL,
  target       text NOT NULL DEFAULT 'personal',
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_subscription_user_shape CHECK (char_length("userId") BETWEEN 1 AND 128),
  CONSTRAINT personal_subscription_target CHECK (target = 'personal'),
  -- the product is a PERSONAL subscription product, of exactly this Platform
  CONSTRAINT personal_subscription_product_fk FOREIGN KEY ("productId", target, "platformId") REFERENCES product (id, "subscriptionTarget", "platformId"),
  CONSTRAINT personal_subscription_owner_unique UNIQUE ("userId", "productId"),
  CONSTRAINT personal_subscription_key UNIQUE (id, "userId", "productId")
);
CREATE TRIGGER personal_subscription_10_append_only BEFORE UPDATE OR DELETE ON personal_subscription
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- ──────────────────────────────────────────────────────────────────────────────────────────────── subscription_purchase

CREATE TABLE subscription_purchase (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ledgerSeq"              bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  "personalSubscriptionId" uuid NOT NULL,
  "invoiceId"              uuid NOT NULL,
  purpose                  text NOT NULL,
  "beneficiaryUserId"      text NOT NULL,
  "productId"              uuid NOT NULL,
  "priceId"                uuid NOT NULL,
  "paymentRequestId"       uuid NOT NULL REFERENCES payment_request (id),
  "receiptId"              uuid NOT NULL REFERENCES payment_event_receipt (id),
  "assistanceRequestId"    uuid,
  "settledAt"              timestamptz NOT NULL,
  "originalStart"          timestamptz NOT NULL,
  "originalEnd"            timestamptz NOT NULL,
  "transactionId"          xid8 NOT NULL,
  "recordedAt"             timestamptz NOT NULL DEFAULT now(),

  -- DB-9: a personal purchase effect only for a direct purchase (the assisted arm comes with S5a), and only for its own routing record
  CONSTRAINT subscription_purchase_purpose CHECK (purpose = 'direct_purchase' AND "assistanceRequestId" IS NULL),
  CONSTRAINT subscription_purchase_routing_fk FOREIGN KEY ("invoiceId", purpose, "beneficiaryUserId", "productId")
    REFERENCES invoice_entitlement ("invoiceId", purpose, "beneficiaryUserId", "productId"),
  -- the Personal Subscription is the beneficiary's own, for this product; the price is this product's
  CONSTRAINT subscription_purchase_subscription_fk FOREIGN KEY ("personalSubscriptionId", "beneficiaryUserId", "productId")
    REFERENCES personal_subscription (id, "userId", "productId"),
  CONSTRAINT subscription_purchase_price_fk FOREIGN KEY ("priceId", "productId") REFERENCES price (id, "productId"),
  -- DB-10: at most one purchase per invoice, and per settlement receipt
  CONSTRAINT subscription_purchase_invoice_unique UNIQUE ("invoiceId"),
  CONSTRAINT subscription_purchase_receipt_unique UNIQUE ("receiptId"),
  CONSTRAINT subscription_purchase_span CHECK ("originalEnd" > "originalStart" AND "originalStart" >= "settledAt")
);
-- DB-12: one purchase per assistance request
CREATE UNIQUE INDEX subscription_purchase_assistance_unique ON subscription_purchase ("assistanceRequestId") WHERE "assistanceRequestId" IS NOT NULL;
CREATE INDEX subscription_purchase_ledger_idx ON subscription_purchase ("personalSubscriptionId", "ledgerSeq");

CREATE TABLE subscription_purchase_reversal (
  "purchaseId" uuid PRIMARY KEY REFERENCES subscription_purchase (id), -- B5: at most one reversal per purchase
  cause        text NOT NULL,
  "recordedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_purchase_reversal_cause CHECK (cause IN ('refund_completion', 'final_lost_chargeback'))
);

-- K-3 Option D: the effective spans of a Personal Subscription, reversed purchases removed, optionally with one more (not yet recorded)
-- purchase appended (`p_settled_at`, `p_price`): the span it would get, which is how a purchase is laid (purchaseId NULL).
CREATE FUNCTION billing_personal_spans(p_personal uuid, p_settled_at timestamptz DEFAULT NULL, p_price uuid DEFAULT NULL)
  RETURNS TABLE ("purchaseId" uuid, "effectiveStart" timestamptz, "effectiveEnd" timestamptz) LANGUAGE plpgsql STABLE AS $$
DECLARE r record; prev_end timestamptz; prev_unit text; anchor timestamptz; s timestamptz;
BEGIN
  FOR r IN
    SELECT * FROM (
      SELECT sp.id, sp."ledgerSeq" AS seq, sp."settledAt" AS settled, pr."intervalUnit" AS unit, pr."intervalCount" AS cnt
        FROM subscription_purchase sp JOIN price pr ON pr.id = sp."priceId"
       WHERE sp."personalSubscriptionId" = p_personal
         AND NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = sp.id)
      UNION ALL
      SELECT NULL::uuid, 9223372036854775807, p_settled_at, pr."intervalUnit", pr."intervalCount"
        FROM price pr WHERE p_price IS NOT NULL AND pr.id = p_price
    ) l ORDER BY l.seq
  LOOP
    IF prev_end IS NOT NULL AND r.settled <= prev_end THEN
      s := prev_end; -- continues the previous kept period, with no gap
      IF NOT (r.unit IN ('month', 'year') AND prev_unit IN ('month', 'year')) THEN anchor := s; END IF;
    ELSE
      s := r.settled; -- the first period, or one after a lapse: a new chain anchored on its own settlement
      anchor := s;
    END IF;
    "purchaseId" := r.id;
    "effectiveStart" := s;
    "effectiveEnd" := billing_subscription_period_end(s, anchor, r.unit, r."cnt");
    RETURN NEXT;
    prev_end := "effectiveEnd";
    prev_unit := r.unit;
  END LOOP;
END $$;

-- The purchase's evidence is the verified settlement (the S3b rule), its price is a line of its invoice, its original span is the one the
-- ledger lays for it NOW (the caller's value is replaced), and the writing transaction is recorded.
CREATE FUNCTION billing_subscription_purchase_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE span record;
BEGIN
  NEW."transactionId" := pg_current_xact_id();
  IF NOT EXISTS (
    SELECT 1 FROM payment_event_receipt r
      JOIN payment_request pr ON pr.id = r."paymentRequestId"
      JOIN invoice i ON i.id = pr."invoiceId"
     WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded'
       AND r."paymentRequestId" = NEW."paymentRequestId" AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid' AND i.status = 'paid'
  ) THEN
    RAISE EXCEPTION 'subscription_purchase: invoice % has no verified settlement (applied payment.succeeded, request and invoice paid)', NEW."invoiceId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_verified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice_line l WHERE l."invoiceId" = NEW."invoiceId" AND l."priceId" = NEW."priceId" AND l."productId" = NEW."productId") THEN
    RAISE EXCEPTION 'subscription_purchase: price % is not a line of invoice %', NEW."priceId", NEW."invoiceId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_line';
  END IF;
  SELECT * INTO span FROM billing_personal_spans(NEW."personalSubscriptionId", NEW."settledAt", NEW."priceId") s WHERE s."purchaseId" IS NULL;
  NEW."originalStart" := span."effectiveStart";
  NEW."originalEnd" := span."effectiveEnd";
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_purchase_05_insert_guard BEFORE INSERT ON subscription_purchase
  FOR EACH ROW EXECUTE FUNCTION billing_subscription_purchase_insert_guard();

CREATE TRIGGER subscription_purchase_10_append_only BEFORE UPDATE OR DELETE ON subscription_purchase
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER subscription_purchase_11_no_truncate BEFORE TRUNCATE ON subscription_purchase
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER subscription_purchase_reversal_10_append_only BEFORE UPDATE OR DELETE ON subscription_purchase_reversal
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER subscription_purchase_reversal_11_no_truncate BEFORE TRUNCATE ON subscription_purchase_reversal
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER personal_subscription_11_no_truncate BEFORE TRUNCATE ON personal_subscription
  FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the runtime role keeps INSERT and SELECT only on the three tables (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record; t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['personal_subscription', 'subscription_purchase', 'subscription_purchase_reversal'] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM PUBLIC', t);
    FOR r IN
      SELECT DISTINCT a.grantee::regrole::text AS role
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.relname = t AND a.grantee <> c.relowner AND a.grantee <> 0
         AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
    LOOP
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %s', t, r.role);
    END LOOP;
  END LOOP;
END $$;
