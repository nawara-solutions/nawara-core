-- Core V2 S3f (register BIL-04 to BIL-07; S0 §1.1; the Owner's S3f decisions A1 to A5, which resolve OD-03 and Q10 for these commands):
-- the optional, member-funded Organization fee an Organization may charge on top of one Platform subscription product, under the Owner's cap.
--
--   * fee_cap (A1, A2): one maximum FIXED fee per Platform, in that Platform's one currency (S3d `billing_platform`), in minor units,
--     >= 0. Versioned and append-only: a change is a new version, never an edit. No row means the permitted fee is 0.
--   * fee_delegation (+ fee_delegation_revocation) (A3): the Owner delegates proposing to ONE operator on ONE Platform; no expiry;
--     explicit, append-only revocation. At most one active delegation per (Platform, operator).
--   * fee_proposal (A4): pending -> approved | rejected (the Owner) | withdrawn (the proposer). At most one pending proposal per
--     (Organization, product). An approved fee is immutable; a later approval supersedes it prospectively (history is never rewritten).
--     The cap is re-checked here at proposal and at approval (A2), and again at the future point of use (`billing_fee_for_use`).
--   * fee_command_idempotency (A5): the admin idempotency class for these commands: (actor, Idempotency-Key) is permanent and bound to
--     the exact request; a successful outcome is replayed. Rows are never deleted (retention >= the approved 90 days).
--
-- Every fee write of a Platform is serialized by ONE transaction-scoped advisory lock taken HERE, in the triggers (so raw SQL is serialized
-- too): a cap change, a delegation or revocation, a proposal and an approval can never interleave and read a stale cap or delegation.
-- Fees are catalog configuration: no invoice, payment request, settlement or purchase references these tables, and nothing here changes
-- one. Expand only.

ALTER TABLE billing_platform ADD CONSTRAINT billing_platform_currency_key UNIQUE ("platformId", currency);

CREATE FUNCTION billing_fee_lock(p_platform uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('billing.fee_platform:' || p_platform::text, 0));
$$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────── fee_cap

CREATE TABLE fee_cap (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId" uuid NOT NULL,
  version      integer NOT NULL,
  amount       bigint NOT NULL,
  currency     char(3) NOT NULL,
  "setBy"      uuid NOT NULL,                       -- the Owner Auth verified (attribution)
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_cap_platform_fk FOREIGN KEY ("platformId", currency) REFERENCES billing_platform ("platformId", currency),
  CONSTRAINT fee_cap_version_unique UNIQUE ("platformId", version),
  CONSTRAINT fee_cap_version_positive CHECK (version >= 1),
  CONSTRAINT fee_cap_amount_range CHECK (amount >= 0 AND amount <= 9007199254740991)
);

-- The version is the database's: the next one for the Platform, under the Platform's fee lock.
CREATE FUNCTION billing_fee_cap_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_fee_lock(NEW."platformId");
  NEW.version := coalesce((SELECT max(version) FROM fee_cap WHERE "platformId" = NEW."platformId"), 0) + 1;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fee_cap_05_insert_guard BEFORE INSERT ON fee_cap FOR EACH ROW EXECUTE FUNCTION billing_fee_cap_insert_guard();

-- The Platform's current cap: its latest version (amount, version), or none (then the permitted fee is 0).
CREATE FUNCTION billing_current_fee_cap(p_platform uuid) RETURNS TABLE (amount bigint, version integer) LANGUAGE sql STABLE AS $$
  SELECT c.amount, c.version FROM fee_cap c WHERE c."platformId" = p_platform ORDER BY c.version DESC LIMIT 1;
$$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────── fee_delegation

CREATE TABLE fee_delegation (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId"       uuid NOT NULL REFERENCES billing_platform ("platformId"),
  "operatorUserId"   uuid NOT NULL,
  "grantedBy"        uuid NOT NULL,                 -- the Owner Auth verified
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_delegation_key UNIQUE (id, "platformId", "operatorUserId"),
  CONSTRAINT fee_delegation_not_self CHECK ("operatorUserId" <> "grantedBy")
);

CREATE TABLE fee_delegation_revocation (
  "delegationId" uuid PRIMARY KEY REFERENCES fee_delegation (id),   -- at most one revocation: revoked is final
  "revokedBy"    uuid NOT NULL,
  "createdAt"    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION billing_fee_delegation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_fee_lock(NEW."platformId");
  IF EXISTS (SELECT 1 FROM fee_delegation d WHERE d."platformId" = NEW."platformId" AND d."operatorUserId" = NEW."operatorUserId"
               AND NOT EXISTS (SELECT 1 FROM fee_delegation_revocation r WHERE r."delegationId" = d.id)) THEN
    RAISE EXCEPTION 'operator % already holds an active fee delegation on platform %', NEW."operatorUserId", NEW."platformId"
      USING ERRCODE = '23505', CONSTRAINT = 'fee_delegation_active_unique';
  END IF;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fee_delegation_05_insert_guard BEFORE INSERT ON fee_delegation FOR EACH ROW EXECUTE FUNCTION billing_fee_delegation_insert_guard();

CREATE FUNCTION billing_fee_revocation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_fee_lock((SELECT "platformId" FROM fee_delegation WHERE id = NEW."delegationId"));
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fee_delegation_revocation_05_insert_guard BEFORE INSERT ON fee_delegation_revocation
  FOR EACH ROW EXECUTE FUNCTION billing_fee_revocation_insert_guard();

-- ──────────────────────────────────────────────────────────────────────────────────────────────── fee_proposal

CREATE TABLE fee_proposal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId"      uuid NOT NULL,
  "organizationId"  uuid NOT NULL,                  -- verified live through Auth by the application (an Organization of the Platform)
  "productId"       uuid NOT NULL,
  target            text NOT NULL DEFAULT 'personal',
  amount            bigint NOT NULL,
  currency          char(3) NOT NULL,
  "delegationId"    uuid NOT NULL,
  "proposedBy"      uuid NOT NULL,                  -- the delegated operator Auth verified
  status            text NOT NULL DEFAULT 'pending',
  "capVersion"      integer,                        -- the cap version an approval satisfied (NULL: no cap, the fee is 0)
  "decidedBy"       uuid,
  "decidedAt"       timestamptz,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_proposal_status_valid CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  CONSTRAINT fee_proposal_target CHECK (target = 'personal'),
  CONSTRAINT fee_proposal_amount_range CHECK (amount >= 0 AND amount <= 9007199254740991),
  CONSTRAINT fee_proposal_decision_shape CHECK ((status = 'pending') = ("decidedBy" IS NULL AND "decidedAt" IS NULL)),
  CONSTRAINT fee_proposal_cap_shape CHECK (status = 'approved' OR "capVersion" IS NULL),
  CONSTRAINT fee_proposal_withdrawn_by_proposer CHECK (status <> 'withdrawn' OR "decidedBy" = "proposedBy"),
  CONSTRAINT fee_proposal_not_self_decided CHECK (status NOT IN ('approved', 'rejected') OR "decidedBy" <> "proposedBy"),
  -- a personal subscription product of exactly this Platform; the Platform's own currency; a delegation of this Platform to this proposer
  CONSTRAINT fee_proposal_product_fk FOREIGN KEY ("productId", target, "platformId") REFERENCES product (id, "subscriptionTarget", "platformId"),
  CONSTRAINT fee_proposal_platform_fk FOREIGN KEY ("platformId", currency) REFERENCES billing_platform ("platformId", currency),
  CONSTRAINT fee_proposal_delegation_fk FOREIGN KEY ("delegationId", "platformId", "proposedBy") REFERENCES fee_delegation (id, "platformId", "operatorUserId")
);
CREATE UNIQUE INDEX fee_proposal_pending_unique ON fee_proposal ("organizationId", "productId") WHERE status = 'pending';
CREATE INDEX fee_proposal_approved_idx ON fee_proposal ("organizationId", "productId", "decidedAt") WHERE status = 'approved';

-- At proposal: pending, undecided, an active delegation, and within the Platform's CURRENT cap (0 when none).
CREATE FUNCTION billing_fee_proposal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap bigint;
BEGIN
  PERFORM billing_fee_lock(NEW."platformId");
  IF NEW.status <> 'pending' OR NEW."decidedBy" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."capVersion" IS NOT NULL THEN
    RAISE EXCEPTION 'a fee proposal is created pending and undecided' USING ERRCODE = '23514', CONSTRAINT = 'fee_proposal_created_pending';
  END IF;
  IF EXISTS (SELECT 1 FROM fee_delegation_revocation r WHERE r."delegationId" = NEW."delegationId") THEN
    RAISE EXCEPTION 'the fee delegation is revoked' USING ERRCODE = '23514', CONSTRAINT = 'fee_proposal_delegation_active';
  END IF;
  cap := coalesce((SELECT c.amount FROM billing_current_fee_cap(NEW."platformId") c), 0);
  IF NEW.amount > cap THEN
    RAISE EXCEPTION 'the fee is above the platform''s cap' USING ERRCODE = '23514', CONSTRAINT = 'fee_above_cap';
  END IF;
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER fee_proposal_05_insert_guard BEFORE INSERT ON fee_proposal FOR EACH ROW EXECUTE FUNCTION billing_fee_proposal_insert_guard();

-- Decisions: once, from pending only, never re-pointed. An approval satisfies the CURRENT cap at that moment and records its version.
CREATE TRIGGER fee_proposal_10_immutable BEFORE UPDATE ON fee_proposal
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'capVersion', 'decidedBy', 'decidedAt');

CREATE FUNCTION billing_fee_proposal_decision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap record;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'fee proposal % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'fee_proposal_not_pending';
  END IF;
  PERFORM billing_fee_lock(OLD."platformId");
  NEW."decidedAt" := now();
  NEW."capVersion" := NULL;
  IF NEW.status = 'approved' THEN
    SELECT c.amount, c.version INTO cap FROM billing_current_fee_cap(OLD."platformId") c;
    IF OLD.amount > coalesce(cap.amount, 0) THEN
      RAISE EXCEPTION 'the fee is above the platform''s current cap' USING ERRCODE = '23514', CONSTRAINT = 'fee_above_cap';
    END IF;
    NEW."capVersion" := cap.version;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fee_proposal_20_decision BEFORE UPDATE ON fee_proposal FOR EACH ROW EXECUTE FUNCTION billing_fee_proposal_decision_guard();

-- The approved fee for future use (A2: re-checked against the CURRENT cap at the point of use; S5 is its caller): the latest approval for
-- (Organization, product), and whether it is usable now. No row: no approved fee (the fee is 0). Reads only; never writes.
CREATE FUNCTION billing_fee_for_use(p_organization uuid, p_product uuid)
  RETURNS TABLE ("proposalId" uuid, amount bigint, currency char(3), usable boolean) LANGUAGE sql STABLE AS $$
  SELECT f.id, f.amount, f.currency, f.amount <= coalesce((SELECT c.amount FROM billing_current_fee_cap(f."platformId") c), 0)
    FROM fee_proposal f
   WHERE f."organizationId" = p_organization AND f."productId" = p_product AND f.status = 'approved'
   ORDER BY f."decidedAt" DESC, f.id DESC LIMIT 1;
$$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────── fee_command_idempotency

CREATE TABLE fee_command_idempotency (
  "actorUserId"     uuid NOT NULL,
  "idempotencyKey"  text NOT NULL,
  operation         text NOT NULL,
  "requestHash"     char(64) NOT NULL,
  "responseStatus"  integer NOT NULL,
  "responseBody"    jsonb NOT NULL,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fee_command_idempotency_pkey PRIMARY KEY ("actorUserId", "idempotencyKey"),
  CONSTRAINT fee_command_idempotency_key_shape CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT fee_command_idempotency_status CHECK ("responseStatus" BETWEEN 200 AND 299)
);

-- ──────────────────────────────────────────────────────────────────────────────────────────────── immutability and privileges

CREATE TRIGGER fee_cap_10_append_only BEFORE UPDATE OR DELETE ON fee_cap FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_delegation_10_append_only BEFORE UPDATE OR DELETE ON fee_delegation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_delegation_revocation_10_append_only BEFORE UPDATE OR DELETE ON fee_delegation_revocation FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_command_idempotency_10_append_only BEFORE UPDATE OR DELETE ON fee_command_idempotency FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_proposal_90_no_delete BEFORE DELETE ON fee_proposal FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER fee_cap_11_no_truncate BEFORE TRUNCATE ON fee_cap FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_delegation_11_no_truncate BEFORE TRUNCATE ON fee_delegation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_delegation_revocation_11_no_truncate BEFORE TRUNCATE ON fee_delegation_revocation FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_proposal_11_no_truncate BEFORE TRUNCATE ON fee_proposal FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER fee_command_idempotency_11_no_truncate BEFORE TRUNCATE ON fee_command_idempotency FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- the runtime role keeps INSERT and SELECT only on the append-only tables, and INSERT, SELECT and UPDATE (the guarded decision) on
-- fee_proposal (the 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record; t text; privs text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fee_cap', 'fee_delegation', 'fee_delegation_revocation', 'fee_command_idempotency', 'fee_proposal'] LOOP
    privs := CASE WHEN t = 'fee_proposal' THEN 'DELETE, TRUNCATE, REFERENCES, TRIGGER' ELSE 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER' END;
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
