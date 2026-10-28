-- Core V2 S6a refund cases and eligibility (register BIL-23, BIL-25; ADR-0067 decision 6; S0 D3, D4, FC-3; the Owner's decisions R6A-1
-- to R6A-9, 2026-10-28), for Core V2 DEVELOPMENT AND SIMULATION ONLY: production never mounts these routes.
--
--   * A refund case is the Owner's intent to refund ONE verified captured payment in FULL (R6A-1, D4). Opening one creates no refund attempt,
--     moves no money, and changes no invoice, payment request, purchase, entitlement or obligation (R6A-6, R6A-8). Execution (S6b),
--     allocation and completion (S6c) and reversal (S6d) are later stages.
--   * Eligibility (R6A-1), re-derived by the insert guard from Billing's own durable records, never from a request value:
--       - the payment request is `paid` and carries Payment's `paymentId`; the verified capture is an `applied` `payment.succeeded`
--         receipt of that request;
--       - the invoice is sold by a Company (R6A-2: Organization-sold payments are excluded) and its lines name exactly one Platform;
--       - its basis is one of: `personal_purchase` (a `direct_purchase` or `assisted_settlement` purchase of that invoice, not reversed);
--         `late_assisted_settlement` (a verified assisted success that produced no purchase, held for reconciliation, L-1 to L-3);
--         `non_entitlement` (an invoice routed `non_entitlement`). An `organization_subscription` payment is never eligible.
--     The amount and currency are the payment request's (the full captured amount; no partial refund).
--   * Uniqueness (FC-3, the strongest rule): at most one case per payment that is `open` or `completed`; a `cancelled` case frees it. A
--     completed case is terminal, and a payment fully refunded can never get a second case.
--   * Lifecycle (R6A-6): `open -> cancelled` (the Owner, before any irreversible refund processing; no refund attempt can exist before S6b,
--     which must add that guard) and `open -> completed` (RESERVED for S6c, on verified refund evidence: refused here). Terminal states
--     never move. `reason` is one of five codes; `legalOverride` is recorded and grants nothing (R6A-4, R6A-5).
-- Expand only: two new tables. No existing table or row changes.

CREATE TABLE refund_case (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId"          uuid NOT NULL,                                       -- Payment's id of the captured payment
  "paymentRequestId"   uuid NOT NULL REFERENCES payment_request (id),
  "invoiceId"          uuid NOT NULL REFERENCES invoice (id),
  "receiptId"          uuid NOT NULL REFERENCES payment_event_receipt (id), -- the verified capture
  eligibility          text NOT NULL,
  "purchaseId"         uuid REFERENCES subscription_purchase (id),
  "lateSettlementId"   uuid REFERENCES assistance_late_settlement (id),
  "companyId"          uuid NOT NULL,                                       -- the seller Company (the Owner's, verified live)
  "platformId"         uuid NOT NULL,
  "organizationId"     uuid,                                                -- the invoice's Organization context, if any
  amount               bigint NOT NULL,                                     -- the full captured amount, computed by Billing
  currency             char(3) NOT NULL,
  reason               text NOT NULL,
  "legalOverride"      boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'open',
  "openedBy"           uuid NOT NULL,
  "openedAt"           timestamptz NOT NULL DEFAULT now(),
  "cancelledBy"        uuid,
  "cancelledAt"        timestamptz,
  "completedAt"        timestamptz,
  CONSTRAINT refund_case_eligibility CHECK (eligibility IN ('personal_purchase', 'late_assisted_settlement', 'non_entitlement')),
  CONSTRAINT refund_case_basis CHECK (
       (eligibility = 'personal_purchase' AND "purchaseId" IS NOT NULL AND "lateSettlementId" IS NULL)
    OR (eligibility = 'late_assisted_settlement' AND "lateSettlementId" IS NOT NULL AND "purchaseId" IS NULL)
    OR (eligibility = 'non_entitlement' AND "purchaseId" IS NULL AND "lateSettlementId" IS NULL)),
  CONSTRAINT refund_case_reason CHECK (reason IN ('duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement')),
  CONSTRAINT refund_case_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT refund_case_status CHECK (status IN ('open', 'cancelled', 'completed')),
  CONSTRAINT refund_case_cancel_shape CHECK (
    (status = 'cancelled') = ("cancelledBy" IS NOT NULL AND "cancelledAt" IS NOT NULL)
    AND (status = 'cancelled' OR ("cancelledBy" IS NULL AND "cancelledAt" IS NULL))),
  CONSTRAINT refund_case_complete_shape CHECK ((status = 'completed') = ("completedAt" IS NOT NULL))
);
-- FC-3: one live case per payment; a completed case keeps the payment forever (a full refund happens once)
CREATE UNIQUE INDEX refund_case_payment_active_unique ON refund_case ("paymentId") WHERE status IN ('open', 'completed');
CREATE INDEX refund_case_company_idx ON refund_case ("companyId", "openedAt");

-- R6A-1, R6A-2: the guard re-derives every financial reference and the amount from Billing's records, under the payment request's row lock
CREATE FUNCTION billing_refund_case_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pr record; inv record; routing record; platforms uuid[];
BEGIN
  IF NEW.status <> 'open' OR NEW."cancelledBy" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL OR NEW."completedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a refund case is opened open' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_created_open';
  END IF;
  SELECT * INTO pr FROM payment_request WHERE id = NEW."paymentRequestId" FOR UPDATE;
  SELECT * INTO inv FROM invoice WHERE id = pr."invoiceId";
  SELECT * INTO routing FROM invoice_entitlement WHERE "invoiceId" = pr."invoiceId";
  SELECT array_agg(DISTINCT p."platformId") INTO platforms FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = pr."invoiceId";
  IF pr.id IS NULL OR pr.status <> 'paid' OR pr."paymentId" IS DISTINCT FROM NEW."paymentId" OR pr."invoiceId" <> NEW."invoiceId"
     OR NOT EXISTS (SELECT 1 FROM payment_event_receipt r WHERE r.id = NEW."receiptId" AND r."paymentRequestId" = pr.id
                      AND r."eventName" = 'payment.succeeded' AND r.outcome = 'applied') THEN
    RAISE EXCEPTION 'refund case: no verified capture of payment %', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_capture_unverified';
  END IF;
  IF NEW.amount <> pr.amount OR NEW.currency <> pr.currency THEN
    RAISE EXCEPTION 'refund case: the amount is the full captured amount, in its currency' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_full_amount';
  END IF;
  IF inv."sellerType" <> 'company' OR inv."sellerId" <> NEW."companyId"::text
     OR NEW."organizationId" IS DISTINCT FROM inv."organizationId"
     OR cardinality(platforms) <> 1 OR platforms[1] IS NULL OR platforms[1] <> NEW."platformId" THEN
    RAISE EXCEPTION 'refund case: the seller Company, Organization or Platform does not match' USING ERRCODE = '23514', CONSTRAINT = 'refund_case_seller';
  END IF;
  IF routing."invoiceId" IS NULL OR routing.purpose = 'organization_subscription'
     OR (NEW.eligibility = 'personal_purchase' AND NOT EXISTS (
           SELECT 1 FROM subscription_purchase s WHERE s.id = NEW."purchaseId" AND s."invoiceId" = pr."invoiceId" AND s."paymentRequestId" = pr.id
              AND s."receiptId" = NEW."receiptId" AND s.purpose IN ('direct_purchase', 'assisted_settlement')
              AND NOT EXISTS (SELECT 1 FROM subscription_purchase_reversal v WHERE v."purchaseId" = s.id)))
     OR (NEW.eligibility = 'late_assisted_settlement' AND (NOT EXISTS (
           SELECT 1 FROM assistance_late_settlement l WHERE l.id = NEW."lateSettlementId" AND l."invoiceId" = pr."invoiceId" AND l."paymentRequestId" = pr.id
              AND l."receiptId" = NEW."receiptId")
           OR EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."invoiceId" = pr."invoiceId")))
     OR (NEW.eligibility = 'non_entitlement' AND routing.purpose <> 'non_entitlement') THEN
    RAISE EXCEPTION 'refund case: payment % is not eligible', NEW."paymentId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_eligible';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_05_insert_guard BEFORE INSERT ON refund_case FOR EACH ROW EXECUTE FUNCTION billing_refund_case_insert_guard();

CREATE TRIGGER refund_case_10_immutable BEFORE UPDATE ON refund_case
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'cancelledBy', 'cancelledAt', 'completedAt');

-- R6A-6: open -> cancelled only; completion is S6c's, on verified refund evidence (refused until then); terminal states never move
CREATE FUNCTION billing_refund_case_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'cancelled' AND NEW."completedAt" IS NULL THEN
    NEW."cancelledAt" := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'completed' THEN
    RAISE EXCEPTION 'refund case %: completion needs verified refund evidence (S6c)', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_case_completion_reserved';
  END IF;
  RAISE EXCEPTION 'refund case % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_open';
END $$;
CREATE TRIGGER refund_case_20_transition BEFORE UPDATE ON refund_case FOR EACH ROW EXECUTE FUNCTION billing_refund_case_transition_guard();
CREATE TRIGGER refund_case_90_no_delete BEFORE DELETE ON refund_case FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER refund_case_91_no_truncate BEFORE TRUNCATE ON refund_case FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── command idempotency (class K, D-10 pattern)

CREATE TABLE refund_command_idempotency (
  "actorUserId"     uuid NOT NULL,                  -- the Owner Auth verified, never a request value
  "idempotencyKey"  text NOT NULL,
  operation         text NOT NULL,
  "requestHash"     char(64) NOT NULL,
  "responseStatus"  integer NOT NULL,
  "responseBody"    jsonb NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_command_idempotency_pkey PRIMARY KEY ("actorUserId", "idempotencyKey"),
  CONSTRAINT refund_command_idempotency_key_shape CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT refund_command_idempotency_operation CHECK (operation IN ('refund_case.open', 'refund_case.cancel')),
  CONSTRAINT refund_command_idempotency_status CHECK ("responseStatus" BETWEEN 200 AND 299)
);
CREATE TRIGGER refund_command_idempotency_10_append_only BEFORE UPDATE OR DELETE ON refund_command_idempotency FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER refund_command_idempotency_11_no_truncate BEFORE TRUNCATE ON refund_command_idempotency FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the runtime role: INSERT, SELECT and UPDATE (the guarded cancellation) on cases; INSERT and SELECT on idempotency records (the 0018 pattern)
DO $$
DECLARE r record; t text; privs text;
BEGIN
  FOREACH t IN ARRAY ARRAY['refund_case', 'refund_command_idempotency'] LOOP
    privs := CASE WHEN t = 'refund_case' THEN 'DELETE, TRUNCATE, REFERENCES, TRIGGER' ELSE 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER' END;
    EXECUTE format('REVOKE %s ON %I FROM PUBLIC', privs, t);
    FOR r IN
      SELECT DISTINCT a.grantee::regrole::text AS role
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.relname = t AND a.grantee <> c.relowner AND a.grantee <> 0
         AND a.privilege_type = ANY (string_to_array(replace(privs, ' ', ''), ','))
    LOOP
      EXECUTE format('REVOKE %s ON %I FROM %s', privs, t, r.role);
    END LOOP;
  END LOOP;
END $$;
