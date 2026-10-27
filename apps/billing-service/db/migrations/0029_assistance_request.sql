-- Core V2 S5a Organization assistance (register BIL-13, BIL-14, BIL-15 and the assistance read; FC-8; the Owner's decisions D-1 to D-12,
-- 2026-10-27), for Core V2 DEVELOPMENT AND SIMULATION ONLY: production never mounts these routes and the service refuses there too.
--
--   * assistance_request: a beneficiary's consented request that an Organization pay for one personal subscription product. Its
--     financial terms are FROZEN at creation (D-1): the product and its authoritative price, the base amount, the Organization's approved
--     fee (or 0 when there is none), the currency, the fee proposal and the fee-cap version it satisfied, and the total the beneficiary
--     accepted. The insert guard re-derives every term under the Platform's fee lock (0025), so an above-cap fee or a term that is not the
--     current approved one cannot be written by any path; after insert the terms never change.
--   * Lifecycle (D-6): `pending -> declined` (D-4) and `pending -> cash_collected` (D-11, BIL-15) only. The database is the clock:
--     `consentAt`, `declinedAt` and `reportedAt` are its time; `cashCollectedAt` is the asserted event time; `settleBy` is exactly
--     `cashCollectedAt + 72 hours`; `consentAt <= cashCollectedAt <= reportedAt`. A cash-collection report is evidence, never settlement:
--     nothing here references an invoice, a payment request, a payment, a purchase or an entitlement.
--   * Overdue is DERIVED (D-6 refinement), never stored: `billing_assistance_overdue` is true while the request is unresolved and the
--     database's current time is past `settleBy`. In S5a a `cash_collected` request is always unresolved (no settlement exists).
--   * At most one unresolved request per (beneficiary, Organization, product) (D-7): only `declined` releases it; any later status a
--     future stage adds stays unresolved unless that stage changes the index.
--   * assistance_command_idempotency: class K (D-10): (actor, Idempotency-Key) bound to the exact command, permanent, success replayed.
-- Expand only: two tables, three functions and their triggers. No existing row is touched.

CREATE TABLE assistance_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "beneficiaryUserId" uuid NOT NULL,                -- the member Auth verified (live /auth/me), never a request value
  "organizationId"    uuid NOT NULL,                -- an active membership of the beneficiary, on the Organization reference's Platform
  "platformId"        uuid NOT NULL,
  "productId"         uuid NOT NULL,
  target              text NOT NULL DEFAULT 'personal',
  "priceId"           uuid NOT NULL,
  currency            char(3) NOT NULL,
  "baseAmount"        bigint NOT NULL,
  "feeAmount"         bigint NOT NULL,
  "totalAmount"       bigint NOT NULL,
  "feeProposalId"     uuid REFERENCES fee_proposal (id),   -- the approved fee applied; NULL: none was approved (fee 0)
  "feeCapVersion"     integer,                              -- the Platform's cap version at creation; NULL: no cap (fee 0)
  consent             boolean NOT NULL,
  "consentAt"         timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'pending',
  "declinedBy"        uuid,                          -- the authenticated declining actor
  "declinedByRole"    text,
  "declinedAt"        timestamptz,
  "cashCollectedAt"   timestamptz,                   -- asserted by the Organization actor: when the cash was physically collected
  "reportedAt"        timestamptz,                   -- the database's time of the report
  "reportedBy"        uuid,                          -- the Organization actor who reported it (never the beneficiary)
  "settleBy"          timestamptz,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistance_request_status_valid CHECK (status IN ('pending', 'declined', 'cash_collected')),
  CONSTRAINT assistance_request_target CHECK (target = 'personal'),
  CONSTRAINT assistance_request_consent CHECK (consent IS TRUE),
  CONSTRAINT assistance_request_amounts CHECK ("baseAmount" > 0 AND "feeAmount" >= 0 AND "totalAmount" = "baseAmount" + "feeAmount" AND "totalAmount" <= 9007199254740991),
  CONSTRAINT assistance_request_fee_shape CHECK (("feeProposalId" IS NOT NULL OR "feeAmount" = 0) AND ("feeCapVersion" IS NOT NULL OR "feeAmount" = 0)),
  CONSTRAINT assistance_request_decline_shape CHECK (
    (status = 'declined') = ("declinedBy" IS NOT NULL AND "declinedByRole" IS NOT NULL AND "declinedAt" IS NOT NULL)
    AND (status = 'declined' OR ("declinedBy" IS NULL AND "declinedByRole" IS NULL AND "declinedAt" IS NULL))),
  CONSTRAINT assistance_request_decline_role CHECK ("declinedByRole" IS NULL OR ("declinedByRole" IN ('beneficiary', 'organization_actor')
    AND ("declinedByRole" = 'beneficiary') = ("declinedBy" = "beneficiaryUserId"))),
  CONSTRAINT assistance_request_cash_shape CHECK (
    (status = 'cash_collected') = ("cashCollectedAt" IS NOT NULL AND "reportedAt" IS NOT NULL AND "reportedBy" IS NOT NULL AND "settleBy" IS NOT NULL)
    AND (status = 'cash_collected' OR ("cashCollectedAt" IS NULL AND "reportedAt" IS NULL AND "reportedBy" IS NULL AND "settleBy" IS NULL))),
  CONSTRAINT assistance_request_cash_time_order CHECK ("cashCollectedAt" IS NULL OR ("consentAt" <= "cashCollectedAt" AND "cashCollectedAt" <= "reportedAt")),
  CONSTRAINT assistance_request_settle_by CHECK ("settleBy" IS NULL OR "settleBy" = "cashCollectedAt" + interval '72 hours'),
  CONSTRAINT assistance_request_reporter_not_beneficiary CHECK ("reportedBy" IS NULL OR "reportedBy" <> "beneficiaryUserId"),
  CONSTRAINT assistance_request_decline_time CHECK ("declinedAt" IS NULL OR "declinedAt" >= "consentAt"),
  -- a personal subscription product of exactly this Platform, a price of that product, the Platform's own currency (DB-5 is the key below)
  CONSTRAINT assistance_request_product_fk FOREIGN KEY ("productId", target, "platformId") REFERENCES product (id, "subscriptionTarget", "platformId"),
  CONSTRAINT assistance_request_price_fk FOREIGN KEY ("priceId", "productId") REFERENCES price (id, "productId"),
  CONSTRAINT assistance_request_platform_fk FOREIGN KEY ("platformId", currency) REFERENCES billing_platform ("platformId", currency),
  CONSTRAINT assistance_request_parties_key UNIQUE (id, "beneficiaryUserId", "organizationId")
);
-- D-7: one unresolved request per (beneficiary, Organization, product); only a decline resolves one in S5a
CREATE UNIQUE INDEX assistance_request_unresolved_unique ON assistance_request ("beneficiaryUserId", "organizationId", "productId") WHERE status <> 'declined';
CREATE INDEX assistance_request_organization_idx ON assistance_request ("organizationId", "createdAt");

-- At creation: pending, consented now, and terms that are exactly Billing's current ones (D-1), under the Platform's fee lock so a cap
-- change, a fee approval and a request can never interleave.
CREATE FUNCTION billing_assistance_request_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fee record; cap record; ok boolean;
BEGIN
  PERFORM billing_fee_lock(NEW."platformId");
  IF NEW.status <> 'pending' OR NEW."declinedBy" IS NOT NULL OR NEW."declinedByRole" IS NOT NULL OR NEW."declinedAt" IS NOT NULL
     OR NEW."cashCollectedAt" IS NOT NULL OR NEW."reportedAt" IS NOT NULL OR NEW."reportedBy" IS NOT NULL OR NEW."settleBy" IS NOT NULL THEN
    RAISE EXCEPTION 'an assistance request is created pending' USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_created_pending';
  END IF;
  -- the authoritative offering: an active Owner-catalog personal product of a configured Platform sold by its Company, and an effective,
  -- unretired recurring price of it in the Platform currency whose unit amount is the base amount (quantity 1)
  SELECT EXISTS (
    SELECT 1 FROM product p JOIN billing_platform b ON b."platformId" = p."platformId" JOIN price r ON r."productId" = p.id
     WHERE p.id = NEW."productId" AND p."platformId" = NEW."platformId" AND p.status = 'active' AND p."subscriptionTarget" = 'personal'
       AND p."sellerType" = 'company' AND p."sellerId" = b."companyId"::text AND p.producer = 'billing-owner'
       AND r.id = NEW."priceId" AND r."retiredAt" IS NULL AND r."effectiveFrom" <= now() AND r."interval" = 'recurring'
       AND r.currency = b.currency AND NEW.currency = b.currency AND r."unitAmount" = NEW."baseAmount") INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION 'the assistance request does not freeze the current offering' USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_offering';
  END IF;
  SELECT f."proposalId", f.amount, f.currency, f.usable INTO fee FROM billing_fee_for_use(NEW."organizationId", NEW."productId") f;
  SELECT c.amount, c.version INTO cap FROM billing_current_fee_cap(NEW."platformId") c;
  IF fee."proposalId" IS NOT NULL AND NOT fee.usable THEN
    RAISE EXCEPTION 'the approved fee is above the platform''s current cap' USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_fee_not_usable';
  END IF;
  IF NEW."feeProposalId" IS DISTINCT FROM fee."proposalId" OR NEW."feeAmount" <> coalesce(fee.amount, 0)
     OR (fee."proposalId" IS NOT NULL AND fee.currency <> NEW.currency) OR NEW."feeCapVersion" IS DISTINCT FROM cap.version THEN
    RAISE EXCEPTION 'the assistance request does not freeze the current approved fee' USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_fee_terms';
  END IF;
  NEW."consentAt" := now();
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_request_05_insert_guard BEFORE INSERT ON assistance_request FOR EACH ROW EXECUTE FUNCTION billing_assistance_request_insert_guard();

-- After creation the terms, the parties and the consent never change; only one transition from pending, stamped with the database's time.
CREATE TRIGGER assistance_request_10_immutable BEFORE UPDATE ON assistance_request
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'declinedBy', 'declinedByRole', 'declinedAt', 'cashCollectedAt', 'reportedAt', 'reportedBy', 'settleBy');

CREATE FUNCTION billing_assistance_request_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('declined', 'cash_collected') THEN
    RAISE EXCEPTION 'assistance request % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_not_pending';
  END IF;
  IF NEW.status = 'declined' THEN
    NEW."declinedAt" := now();
  ELSE
    NEW."reportedAt" := now();
    NEW."settleBy" := NEW."cashCollectedAt" + interval '72 hours';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_request_20_transition BEFORE UPDATE ON assistance_request FOR EACH ROW EXECUTE FUNCTION billing_assistance_request_transition_guard();
CREATE TRIGGER assistance_request_90_no_delete BEFORE DELETE ON assistance_request FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER assistance_request_91_no_truncate BEFORE TRUNCATE ON assistance_request FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- D-6: overdue while unresolved and the database's current time is past the deadline. In S5a only `cash_collected` is unresolved with a
-- deadline (no settlement exists yet); a late report (`reportedAt > settleBy`) is therefore overdue from its first instant.
CREATE FUNCTION billing_assistance_overdue(p_status text, p_settle_by timestamptz) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_status = 'cash_collected' AND p_settle_by IS NOT NULL AND now() > p_settle_by;
$$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────── assistance_command_idempotency

CREATE TABLE assistance_command_idempotency (
  "actorUserId"     uuid NOT NULL,                  -- the user Auth verified, never a request value
  "idempotencyKey"  text NOT NULL,
  operation         text NOT NULL,
  "requestHash"     char(64) NOT NULL,
  "responseStatus"  integer NOT NULL,
  "responseBody"    jsonb NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistance_command_idempotency_pkey PRIMARY KEY ("actorUserId", "idempotencyKey"),
  CONSTRAINT assistance_command_idempotency_key_shape CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT assistance_command_idempotency_operation CHECK (operation IN ('assistance_request.create', 'assistance_request.decline', 'assistance_request.cash_collection')),
  CONSTRAINT assistance_command_idempotency_status CHECK ("responseStatus" BETWEEN 200 AND 299)
);
CREATE TRIGGER assistance_command_idempotency_10_append_only BEFORE UPDATE OR DELETE ON assistance_command_idempotency FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER assistance_command_idempotency_11_no_truncate BEFORE TRUNCATE ON assistance_command_idempotency FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the runtime role keeps INSERT and SELECT on the idempotency records, and INSERT, SELECT and UPDATE (the guarded transition) on
-- assistance_request (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record; t text; privs text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistance_request', 'assistance_command_idempotency'] LOOP
    privs := CASE WHEN t = 'assistance_request' THEN 'DELETE, TRUNCATE, REFERENCES, TRIGGER' ELSE 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER' END;
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
