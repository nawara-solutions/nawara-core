-- Core V2 S5b assisted electronic settlement and cash-return obligations (register BIL-16, BIL-17; ADR-0044 B2, B4, B7, B14; S0 DB-5,
-- DB-12, DB-13, FC-8; the Owner's decisions E-1 to E-13, 2026-10-27), for Core V2 DEVELOPMENT AND SIMULATION ONLY: production never
-- mounts these routes or runs the sweep, and the services refuse there too.
--
--   * assistance_settlement_channel (E-5, DB-13): one channel = one invoice of the reserved producer `billing-assistance` and its payment
--     request. `open` (request created or requested) and `uncertain` (being sent: Payment may or may not hold it) follow the request by
--     trigger; `closed` only on an authoritative final unsuccessful outcome (failed, cancelled, expired, rejected), never on time; `settled`
--     only together with the request's purchase. At most one open or uncertain channel per request; a new one only before `settleBy`, while
--     the request is cash_collected with no purchase and no obligation (E-6).
--   * The settlement invoice (E-3, E-4): an Organization payer, one line of the request's FROZEN price (quantity 1, the frozen base, the
--     frozen currency; a price retired or a product archived since consent does not stop it), the Platform's Company as the simulation seller
--     reference, reference snapshots only, routed `assisted_settlement` to the consenting beneficiary with the request as its DB-5
--     reference. Checked at COMMIT for every invoice of the reserved producer, whatever path writes it. The Organization fee is never in it.
--   * The purchase (E-12, DB-12, B14): the S3c ledger gains its assisted arm. An assisted purchase needs the request still cash_collected, no
--     cash-return obligation and its channel not closed, under the request row lock; the request then becomes `settled`, which resolves it
--     (E-10). A verified success that cannot apply (E-7) is an append-only `assistance_late_settlement` held for S6h reconciliation.
--   * cash_return_obligation (E-6, E-8, E-9): opened only by the sweep when the database time is past `settleBy`, no purchase, no open or
--     uncertain channel and no obligation (all re-checked here under the request row lock); the Organization owes the beneficiary the frozen
--     total (base + fee) in the frozen currency. `open -> return_reported` only (the report never discharges it); S5c adds the rest.
--   * E-11: the Organization fee is validated against the Platform's current cap again when cash collection is recorded (S5a's report), and
--     the cap version is kept; the electronic settlement charges only the base and never re-checks or reprices the fee.
-- Expand only: new tables, new nullable columns, one generated column, widened checks every existing row satisfies, replaced guards.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_request: settled, E-11

-- DB-5 needs the beneficiary in the routing record's own type (text)
ALTER TABLE assistance_request ADD COLUMN "beneficiaryRef" text GENERATED ALWAYS AS ("beneficiaryUserId"::text) STORED;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_routing_key UNIQUE (id, "beneficiaryRef", "organizationId");
ALTER TABLE assistance_request ADD COLUMN "collectionFeeCapVersion" integer; -- E-11: the cap version the fee satisfied at cash collection

ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_status_valid;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_status_valid CHECK (status IN ('pending', 'declined', 'cash_collected', 'settled'));
ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_cash_shape;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_cash_shape CHECK (
  (status IN ('cash_collected', 'settled')) = ("cashCollectedAt" IS NOT NULL AND "reportedAt" IS NOT NULL AND "reportedBy" IS NOT NULL AND "settleBy" IS NOT NULL)
  AND (status IN ('cash_collected', 'settled') OR ("cashCollectedAt" IS NULL AND "reportedAt" IS NULL AND "reportedBy" IS NULL AND "settleBy" IS NULL)));
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_collection_cap_shape CHECK ("collectionFeeCapVersion" IS NULL OR status IN ('cash_collected', 'settled'));

-- E-10: a purchase resolves the request; a decline does too. An open obligation keeps it unresolved (it stays cash_collected).
DROP INDEX assistance_request_unresolved_unique;
CREATE UNIQUE INDEX assistance_request_unresolved_unique ON assistance_request ("beneficiaryUserId", "organizationId", "productId") WHERE status NOT IN ('declined', 'settled');

DROP TRIGGER assistance_request_10_immutable ON assistance_request;
CREATE TRIGGER assistance_request_10_immutable BEFORE UPDATE ON assistance_request
  -- `beneficiaryRef` is generated from the immutable `beneficiaryUserId`; a BEFORE trigger sees it as NULL, so it is not compared here
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'declinedBy', 'declinedByRole', 'declinedAt', 'cashCollectedAt', 'reportedAt', 'reportedBy', 'settleBy', 'collectionFeeCapVersion', 'beneficiaryRef');

CREATE OR REPLACE FUNCTION billing_assistance_request_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap record;
BEGIN
  IF OLD.status = 'cash_collected' AND NEW.status = 'settled' THEN
    -- E-12: only the purchase path settles a request, in the transaction that records its purchase; nothing else changes
    IF NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = OLD.id) THEN
      RAISE EXCEPTION 'assistance request % is settled only by its purchase', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_settled_by_purchase';
    END IF;
    IF NEW."cashCollectedAt" IS DISTINCT FROM OLD."cashCollectedAt" OR NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt" OR NEW."reportedBy" IS DISTINCT FROM OLD."reportedBy"
       OR NEW."settleBy" IS DISTINCT FROM OLD."settleBy" OR NEW."collectionFeeCapVersion" IS DISTINCT FROM OLD."collectionFeeCapVersion" THEN
      RAISE EXCEPTION 'assistance request %: the collection evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_collection_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('declined', 'cash_collected') THEN
    RAISE EXCEPTION 'assistance request % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_not_pending';
  END IF;
  IF NEW.status = 'declined' THEN
    NEW."declinedAt" := now();
    NEW."collectionFeeCapVersion" := NULL;
  ELSE
    NEW."reportedAt" := now();
    NEW."settleBy" := NEW."cashCollectedAt" + interval '72 hours';
    -- E-11: the frozen fee is validated against the Platform's CURRENT cap when the collection is recorded (never reduced or repriced)
    PERFORM billing_fee_lock(OLD."platformId");
    SELECT c.amount, c.version INTO cap FROM billing_current_fee_cap(OLD."platformId") c;
    IF OLD."feeAmount" > coalesce(cap.amount, 0) THEN
      RAISE EXCEPTION 'assistance request %: the frozen fee is above the platform''s current cap', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_fee_not_usable';
    END IF;
    NEW."collectionFeeCapVersion" := cap.version;
  END IF;
  RETURN NEW;
END $$;

-- D-6 / E-10: overdue while the settlement side is unresolved (cash_collected) and the database's current time is past the deadline
CREATE OR REPLACE FUNCTION billing_assistance_overdue(p_status text, p_settle_by timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_status = 'cash_collected' AND p_settle_by IS NOT NULL AND now() > p_settle_by;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── invoice_entitlement: the assisted arm (B2, DB-5)

ALTER TABLE invoice_entitlement ADD COLUMN "assistanceRequestId" uuid;
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_assistance_fk
  FOREIGN KEY ("assistanceRequestId", "beneficiaryUserId", "organizationId") REFERENCES assistance_request (id, "beneficiaryRef", "organizationId");
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_assistance_key UNIQUE ("invoiceId", "assistanceRequestId");
ALTER TABLE invoice_entitlement DROP CONSTRAINT invoice_entitlement_combination;
ALTER TABLE invoice_entitlement ADD CONSTRAINT invoice_entitlement_combination CHECK (
     (purpose = 'organization_subscription' AND target = 'organization' AND "payerType" = 'user' AND "beneficiaryUserId" IS NULL
      AND "organizationId" IS NOT NULL AND "productId" IS NOT NULL AND "assistanceRequestId" IS NULL)
  OR (purpose = 'direct_purchase' AND target = 'personal' AND "payerType" = 'user' AND "beneficiaryUserId" IS NOT NULL
      AND "beneficiaryUserId" = "payerId" AND "organizationId" IS NULL AND "productId" IS NOT NULL AND "assistanceRequestId" IS NULL)
  -- B2 / B7: an Organization pays a personal product for its consenting beneficiary, referencing the assistance request (DB-5)
  OR (purpose = 'assisted_settlement' AND target = 'personal' AND "payerType" = 'organization' AND "beneficiaryUserId" IS NOT NULL
      AND "organizationId" IS NOT NULL AND "payerId" = "organizationId"::text AND "productId" IS NOT NULL AND "assistanceRequestId" IS NOT NULL)
  OR (purpose = 'non_entitlement' AND target = 'none' AND "beneficiaryUserId" IS NULL AND "organizationId" IS NULL AND "productId" IS NULL AND "assistanceRequestId" IS NULL)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── subscription_purchase: the assisted arm (B4, DB-9, DB-12)

ALTER TABLE subscription_purchase DROP CONSTRAINT subscription_purchase_purpose;
ALTER TABLE subscription_purchase ADD CONSTRAINT subscription_purchase_purpose CHECK (
  (purpose = 'direct_purchase' AND "assistanceRequestId" IS NULL) OR (purpose = 'assisted_settlement' AND "assistanceRequestId" IS NOT NULL));
-- the purchase's request is its routing record's request (direct purchases carry none: MATCH SIMPLE skips the check)
ALTER TABLE subscription_purchase ADD CONSTRAINT subscription_purchase_assistance_fk
  FOREIGN KEY ("invoiceId", "assistanceRequestId") REFERENCES invoice_entitlement ("invoiceId", "assistanceRequestId");

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_settlement_channel (E-5, DB-13)

CREATE TABLE assistance_settlement_channel (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistanceRequestId" uuid NOT NULL REFERENCES assistance_request (id),
  "invoiceId"           uuid NOT NULL UNIQUE REFERENCES invoice (id),
  "paymentRequestId"    uuid UNIQUE REFERENCES payment_request (id), -- set once, in the channel's own transaction
  status                text NOT NULL DEFAULT 'open',
  "feeCapVersion"       integer,                                       -- E-11: the Platform's cap version when the channel opened (evidence only)
  "startedBy"           uuid NOT NULL,                                 -- the Organization actor Auth verified
  "createdAt"           timestamptz NOT NULL DEFAULT now(),
  "closedAt"            timestamptz,
  CONSTRAINT assistance_settlement_channel_status CHECK (status IN ('open', 'uncertain', 'settled', 'closed')),
  CONSTRAINT assistance_settlement_channel_closed_shape CHECK ((status = 'closed') = ("closedAt" IS NOT NULL))
);
-- DB-13: at most one open or uncertain channel per request
CREATE UNIQUE INDEX assistance_settlement_channel_active_unique ON assistance_settlement_channel ("assistanceRequestId") WHERE status IN ('open', 'uncertain');

CREATE FUNCTION billing_assistance_channel_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."paymentRequestId" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a settlement channel is created open, without a payment request yet' USING ERRCODE = '23514', CONSTRAINT = 'assistance_settlement_channel_created_open';
  END IF;
  -- E-1, E-6: only a request with recorded cash collection, before its deadline, with no purchase and no cash-return obligation
  IF r.status IS DISTINCT FROM 'cash_collected' OR now() > r."settleBy"
     OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = r.id)
     OR EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id) THEN
    RAISE EXCEPTION 'assistance request % is not settleable', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_not_settleable';
  END IF;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;

CREATE FUNCTION billing_assistance_channel_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW."assistanceRequestId" <> OLD."assistanceRequestId" OR NEW."invoiceId" <> OLD."invoiceId" OR NEW."startedBy" <> OLD."startedBy"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."feeCapVersion" IS DISTINCT FROM OLD."feeCapVersion"
     OR (OLD."paymentRequestId" IS NOT NULL AND NEW."paymentRequestId" IS DISTINCT FROM OLD."paymentRequestId") THEN
    RAISE EXCEPTION 'settlement channel %: only its payment request (once) and its status change', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_settlement_channel_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- open <-> uncertain while the request is in flight; closed and settled are final and are never reopened
    IF OLD.status IN ('closed', 'settled') OR NOT (NEW.status IN ('open', 'uncertain', 'closed') OR (NEW.status = 'settled' AND OLD.status IN ('open', 'uncertain'))) THEN
      RAISE EXCEPTION 'settlement channel % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_settlement_channel_transition';
    END IF;
    IF NEW.status = 'closed' AND NOT EXISTS (SELECT 1 FROM payment_request pr WHERE pr.id = OLD."paymentRequestId" AND pr.status IN ('failed', 'cancelled', 'expired', 'rejected')) THEN
      RAISE EXCEPTION 'settlement channel % closes only on a final unsuccessful payment outcome', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_settlement_channel_closed_final';
    END IF;
    IF NEW.status = 'settled' AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."invoiceId" = OLD."invoiceId") THEN
      RAISE EXCEPTION 'settlement channel % is settled only with its purchase', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_settlement_channel_settled_purchase';
    END IF;
    NEW."closedAt" := CASE WHEN NEW.status = 'closed' THEN now() ELSE NULL END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_settlement_channel_05_insert_guard BEFORE INSERT ON assistance_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_assistance_channel_insert_guard();
CREATE TRIGGER assistance_settlement_channel_10_update_guard BEFORE UPDATE ON assistance_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_assistance_channel_update_guard();
CREATE TRIGGER assistance_settlement_channel_90_no_delete BEFORE DELETE ON assistance_settlement_channel FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER assistance_settlement_channel_91_no_truncate BEFORE TRUNCATE ON assistance_settlement_channel FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- The channel follows its payment request: created / requested = open, sending = uncertain, a final unsuccessful outcome = closed. A paid
-- request leaves it as it is: the purchase path settles it, or (E-7) the late settlement record holds it for reconciliation.
CREATE FUNCTION billing_assistance_channel_follow_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE assistance_settlement_channel c
     SET status = CASE WHEN NEW.status IN ('created', 'requested') THEN 'open' WHEN NEW.status = 'sending' THEN 'uncertain' ELSE 'closed' END
   WHERE c."paymentRequestId" = NEW.id AND c.status IN ('open', 'uncertain')
     AND NEW.status IN ('created', 'requested', 'sending', 'failed', 'cancelled', 'expired', 'rejected')
     AND c.status IS DISTINCT FROM (CASE WHEN NEW.status IN ('created', 'requested') THEN 'open' WHEN NEW.status = 'sending' THEN 'uncertain' ELSE 'closed' END);
  RETURN NULL;
END $$;
CREATE TRIGGER payment_request_60_assistance_channel AFTER UPDATE OF status ON payment_request FOR EACH ROW EXECUTE FUNCTION billing_assistance_channel_follow_request();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the reserved producer `billing-assistance` (E-3, E-4)

CREATE FUNCTION billing_assistance_invoice_check(p_invoice uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE i invoice%ROWTYPE; n integer; l record; a record; ch record;
BEGIN
  SELECT * INTO i FROM invoice WHERE id = p_invoice;
  IF NOT FOUND OR i.producer <> 'billing-assistance' THEN RETURN; END IF;
  SELECT count(*) INTO n FROM invoice_line WHERE "invoiceId" = p_invoice;
  SELECT il.quantity, il."priceId", il."productId", il."unitAmount", il.currency AS "lineCurrency", b."companyId", p."platformId"
    INTO l
    FROM invoice_line il JOIN product p ON p.id = il."productId" LEFT JOIN billing_platform b ON b."platformId" = p."platformId"
   WHERE il."invoiceId" = p_invoice LIMIT 1;
  SELECT * INTO ch FROM assistance_settlement_channel WHERE "invoiceId" = p_invoice;
  SELECT * INTO a FROM assistance_request WHERE id = ch."assistanceRequestId";
  IF ch.id IS NULL OR a.id IS NULL OR i.status = 'draft'
     OR i."payerType" <> 'organization' OR i."payerId" <> a."organizationId"::text OR i."organizationId" IS DISTINCT FROM a."organizationId"
     OR i."sellerType" <> 'company' OR l."companyId" IS NULL OR i."sellerId" <> l."companyId"::text OR l."platformId" <> a."platformId"
     OR n <> 1 OR l.quantity <> 1 OR l."priceId" <> a."priceId" OR l."productId" <> a."productId"
     OR l."unitAmount" <> a."baseAmount" OR i.total <> a."baseAmount" OR i.currency <> a.currency OR l."lineCurrency" <> a.currency
     OR i."issuerSnapshot" <> jsonb_build_object('schemaVersion', 2, 'partyType', 'company', 'companyId', i."sellerId", 'platformId', a."platformId"::text, 'legalIdentity', 'not_determined')
     OR i."billToSnapshot" <> jsonb_build_object('schemaVersion', 2, 'partyType', 'organization', 'organizationId', a."organizationId"::text, 'legalIdentity', 'not_determined')
     OR NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = p_invoice AND e.purpose = 'assisted_settlement'
                      AND e."assistanceRequestId" = a.id AND e."beneficiaryUserId" = a."beneficiaryRef" AND e."productId" = a."productId")
     OR NOT EXISTS (SELECT 1 FROM payment_request r WHERE r."invoiceId" = p_invoice AND r.id = ch."paymentRequestId") THEN
    RAISE EXCEPTION 'invoice %: not a valid assisted settlement', p_invoice USING ERRCODE = '23514', CONSTRAINT = 'assistance_invoice_shape';
  END IF;
END $$;

CREATE FUNCTION billing_assistance_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_assistance_invoice_check(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_96_assistance_shape AFTER INSERT OR UPDATE ON invoice DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.producer = 'billing-assistance') EXECUTE FUNCTION billing_assistance_invoice_guard();

CREATE FUNCTION billing_assistance_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_assistance_invoice_check(NEW."invoiceId");
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_line_96_assistance_shape AFTER INSERT ON invoice_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_assistance_line_guard();

-- B-026, narrowed for this path only: an Organization-payer request exists only for an assisted-settlement invoice of the reserved producer
CREATE OR REPLACE FUNCTION billing_payment_request_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv record;
BEGIN
  IF NEW.status <> 'created' OR NEW."paymentId" IS NOT NULL OR NEW.revision <> 0 OR NEW."sendAttempts" <> 0
     OR NEW."sendingSince" IS NOT NULL OR NEW."cancelRequestedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL THEN
    RAISE EXCEPTION 'a payment request is created as `created` with no lifecycle data' USING ERRCODE = '23514';
  END IF;
  SELECT status, total, "payerType", producer INTO inv FROM invoice WHERE id = NEW."invoiceId" FOR UPDATE;
  IF inv.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'a payment request needs an open invoice' USING ERRCODE = '23514';
  END IF;
  -- v1 TEMPORARY RESTRICTION (B-026): Payment can start an attempt only for a `user` payer and has no cancel route yet, so a request
  -- for any other payer could never be completed or closed. Core V2 S5b (E-3): the single exception is the Organization payer of an
  -- assisted-settlement invoice of the reserved producer, whose attempts the Organization actor starts at Payment (S4e).
  IF inv."payerType" <> 'user' AND NOT (inv."payerType" = 'organization' AND inv.producer = 'billing-assistance'
       AND EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = NEW."invoiceId" AND e.purpose = 'assisted_settlement')) THEN
    RAISE EXCEPTION 'payment requests are supported only for a user payer until B-026 is decided' USING ERRCODE = '23514';
  END IF;
  -- v1 TEMPORARY RESTRICTION (B-010): the request is for exactly the invoice total (no partial payments)
  IF NEW.amount <> inv.total THEN
    RAISE EXCEPTION 'a payment request is for the full invoice total until B-010 is decided' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the assisted purchase (E-7, E-12)

-- Under the request row lock (the lock the sweep also takes): an assisted purchase needs the request still cash_collected, no cash-return
-- obligation, and its channel not closed. So a purchase and an obligation can never both exist, whatever commits first.
CREATE FUNCTION billing_assisted_purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.purpose <> 'assisted_settlement' OR NEW."assistanceRequestId" IS NULL THEN RETURN NEW; END IF; -- the CHECK refuses an assisted one without it
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF r.status IS DISTINCT FROM 'cash_collected'
     OR EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = r.id)
     OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no purchase after closure, a cash-return obligation or another purchase', NEW."assistanceRequestId"
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_purchase_assisted_applicable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_purchase_04_assisted_guard BEFORE INSERT ON subscription_purchase FOR EACH ROW EXECUTE FUNCTION billing_assisted_purchase_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_late_settlement (E-7, B14, L-1 to L-3)

CREATE TABLE assistance_late_settlement (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistanceRequestId" uuid NOT NULL REFERENCES assistance_request (id),
  "invoiceId"           uuid NOT NULL UNIQUE REFERENCES invoice (id),
  "paymentRequestId"    uuid NOT NULL REFERENCES payment_request (id),
  "receiptId"           uuid NOT NULL UNIQUE REFERENCES payment_event_receipt (id),
  reason                text NOT NULL,
  "recordedAt"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistance_late_settlement_reason CHECK (reason IN ('channel_closed', 'purchase_exists', 'cash_return_obligation_exists', 'request_not_settleable'))
);
CREATE FUNCTION billing_assistance_late_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the verified settlement it holds: an applied payment.succeeded of this invoice's request, which is paid
  IF NOT EXISTS (
    SELECT 1 FROM payment_event_receipt r JOIN payment_request pr ON pr.id = r."paymentRequestId"
     WHERE r.id = NEW."receiptId" AND r.outcome = 'applied' AND r."eventName" = 'payment.succeeded' AND pr.id = NEW."paymentRequestId"
       AND pr."invoiceId" = NEW."invoiceId" AND pr.status = 'paid')
     OR NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."invoiceId" = NEW."invoiceId" AND c."assistanceRequestId" = NEW."assistanceRequestId") THEN
    RAISE EXCEPTION 'assistance_late_settlement: invoice % has no verified settlement of that request', NEW."invoiceId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_late_settlement_verified';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_late_settlement_05_guard BEFORE INSERT ON assistance_late_settlement FOR EACH ROW EXECUTE FUNCTION billing_assistance_late_settlement_guard();
CREATE TRIGGER assistance_late_settlement_10_append_only BEFORE UPDATE OR DELETE ON assistance_late_settlement FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER assistance_late_settlement_11_no_truncate BEFORE TRUNCATE ON assistance_late_settlement FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── cash_return_obligation (E-6, E-8, E-9)

CREATE TABLE cash_return_obligation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistanceRequestId" uuid NOT NULL UNIQUE,                 -- E-8: at most one per request
  "organizationId"      uuid NOT NULL,                        -- the debtor
  "beneficiaryUserId"   uuid NOT NULL,                        -- the creditor
  amount                bigint NOT NULL,                      -- the frozen total: base + Organization fee
  currency              char(3) NOT NULL,
  "cashCollectedAt"     timestamptz NOT NULL,                 -- copied from the request (the time-order CHECK below)
  status                text NOT NULL DEFAULT 'open',
  "openedAt"            timestamptz NOT NULL DEFAULT now(),
  "returnedAt"          timestamptz,                          -- asserted by the Organization actor
  "returnReportedAt"    timestamptz,                          -- the database's time of the report
  "returnReportedBy"    uuid,
  CONSTRAINT cash_return_obligation_request_fk FOREIGN KEY ("assistanceRequestId", "beneficiaryUserId", "organizationId")
    REFERENCES assistance_request (id, "beneficiaryUserId", "organizationId"),
  CONSTRAINT cash_return_obligation_status CHECK (status IN ('open', 'return_reported')),
  CONSTRAINT cash_return_obligation_amount CHECK (amount > 0 AND amount <= 9007199254740991),
  CONSTRAINT cash_return_obligation_report_shape CHECK (
    (status = 'return_reported') = ("returnedAt" IS NOT NULL AND "returnReportedAt" IS NOT NULL AND "returnReportedBy" IS NOT NULL)
    AND (status = 'return_reported' OR ("returnedAt" IS NULL AND "returnReportedAt" IS NULL AND "returnReportedBy" IS NULL))),
  CONSTRAINT cash_return_obligation_time_order CHECK ("returnedAt" IS NULL OR ("cashCollectedAt" <= "returnedAt" AND "returnedAt" <= "returnReportedAt")),
  CONSTRAINT cash_return_obligation_reporter_not_beneficiary CHECK ("returnReportedBy" IS NULL OR "returnReportedBy" <> "beneficiaryUserId")
);
CREATE INDEX cash_return_obligation_organization_idx ON cash_return_obligation ("organizationId", "openedAt");

-- E-6: opened only past the deadline, with no purchase, no open or uncertain channel, and the request's own frozen terms, under the request lock
CREATE FUNCTION billing_cash_return_obligation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."returnedAt" IS NOT NULL OR NEW."returnReportedAt" IS NOT NULL OR NEW."returnReportedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'a cash-return obligation is opened open' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_created_open';
  END IF;
  IF r.status IS DISTINCT FROM 'cash_collected' OR NOT (now() > r."settleBy")
     OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = r.id)
     OR EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no cash-return obligation may open', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_not_due';
  END IF;
  IF NEW.amount <> r."totalAmount" OR NEW.currency <> r.currency OR NEW."cashCollectedAt" <> r."cashCollectedAt" THEN
    RAISE EXCEPTION 'cash-return obligation: the frozen total, currency and collection time of its request' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_terms';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cash_return_obligation_05_insert_guard BEFORE INSERT ON cash_return_obligation FOR EACH ROW EXECUTE FUNCTION billing_cash_return_obligation_insert_guard();

CREATE TRIGGER cash_return_obligation_10_immutable BEFORE UPDATE ON cash_return_obligation
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'returnedAt', 'returnReportedAt', 'returnReportedBy');
CREATE FUNCTION billing_cash_return_obligation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open' OR NEW.status <> 'return_reported' THEN
    RAISE EXCEPTION 'cash-return obligation % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_open';
  END IF;
  NEW."returnReportedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cash_return_obligation_20_transition BEFORE UPDATE ON cash_return_obligation FOR EACH ROW EXECUTE FUNCTION billing_cash_return_obligation_transition_guard();
CREATE TRIGGER cash_return_obligation_90_no_delete BEFORE DELETE ON cash_return_obligation FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER cash_return_obligation_91_no_truncate BEFORE TRUNCATE ON cash_return_obligation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── idempotency and privileges

ALTER TABLE assistance_command_idempotency DROP CONSTRAINT assistance_command_idempotency_operation;
ALTER TABLE assistance_command_idempotency ADD CONSTRAINT assistance_command_idempotency_operation CHECK (operation IN (
  'assistance_request.create', 'assistance_request.decline', 'assistance_request.cash_collection', 'assistance_request.settlement', 'cash_return_obligation.return'));

-- the runtime role: INSERT, SELECT and UPDATE (the guarded transitions) on the channel and the obligation, INSERT and SELECT on the late
-- settlement record (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record; t text; privs text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistance_settlement_channel', 'cash_return_obligation', 'assistance_late_settlement'] LOOP
    privs := CASE WHEN t = 'assistance_late_settlement' THEN 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER' ELSE 'DELETE, TRUNCATE, REFERENCES, TRIGGER' END;
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
