-- 0004 — auth-service: organization join codes, organization membership, member contact verification.
--
--   * platform.key                 — short public slug shown to the app (e.g. "nawara-drive")
--   * organization_join_code       — server-authoritative onboarding credential: resolves to
--                                    (organization, platform, audience); stored as an HMAC, never plaintext
--   * organization_membership      — a member's relationship with their organization
--                                    (pending | active | rejected), separate from "user"."isActive"
--   * member_contact_verification  — one-time codes proving an e-mail / phone belongs to a member
--
-- Invariants kept by the DATABASE (not only by the service):
--   - a join code can only name an (organization, platform) pair that really belong together
--     (composite FK), so it can never cross platform or company;
--   - a membership can only name the member's OWN organization (composite FK to "user"), one per
--     (user, organization), and its status may only move pending -> active | rejected;
--   - a join code can never be used more often than maxUses, never revived after revocation, and
--     its target/hash/audience are immutable.
--
-- Existing members are backfilled as ACTIVE memberships so nobody loses access by this migration.
-- Rollback: down/0004_*.down.sql (refuses to destroy data that would be lost).

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Preflight: refuse rather than guess
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE existing text;
BEGIN
  SELECT string_agg(t, ', ') INTO existing
  FROM unnest(ARRAY['organization_join_code','organization_membership','member_contact_verification']) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL;
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION '0004 refused: tables already exist (%). This migration never repairs or overwrites existing data.', existing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Supporting keys on existing tables
-- ---------------------------------------------------------------------------------------------
ALTER TABLE platform
  ADD COLUMN key text,
  ADD CONSTRAINT platform_key_format CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD CONSTRAINT platform_key_uk UNIQUE (key);

-- Targets of the composite FKs below.
ALTER TABLE organization ADD CONSTRAINT organization_id_platform_uk UNIQUE (id, "platformId");
ALTER TABLE "user"       ADD CONSTRAINT user_id_organization_uk UNIQUE (id, "organizationId");

-- A member's contact (e-mail or phone) is unverified until proven. Operators keep their own column.
ALTER TABLE "user" ADD COLUMN "contactVerifiedAt" timestamptz;

-- ---------------------------------------------------------------------------------------------
-- OrganizationJoinCode
-- ---------------------------------------------------------------------------------------------
CREATE TABLE organization_join_code (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"       uuid NOT NULL,
  "platformId"           uuid NOT NULL,
  -- HMAC-SHA-256(JOIN_CODE_PEPPER, normalized code). The plaintext is shown once, at creation.
  "codeHash"             text NOT NULL CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  -- Opaque registration audience label chosen by the platform ("student", "teacher", ...). Auth never
  -- interprets it: behaviour comes from the two flags below.
  -- 'admin' stays reserved for management identities (user_admin_role_reserved): a member can never carry it,
  -- so a code with that audience could never be redeemed.
  audience               text NOT NULL CHECK (audience ~ '^[a-z][a-z0-9_-]{0,31}$' AND audience <> 'admin'),
  "requiresApproval"     boolean NOT NULL,
  -- Onboarding HINT for the app only. Entitlement is owned by payment-service; auth stores no state.
  "requiresSubscription" boolean NOT NULL,
  "expiresAt"            timestamptz,
  "maxUses"              integer CHECK ("maxUses" IS NULL OR "maxUses" > 0),
  "usedCount"            integer NOT NULL DEFAULT 0 CHECK ("usedCount" >= 0),
  "isActive"             boolean NOT NULL DEFAULT true,
  "createdBy"            uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  "createdAt"            timestamptz NOT NULL DEFAULT now(),
  "revokedAt"            timestamptz,
  "revokedBy"            uuid REFERENCES "user" (id) ON DELETE RESTRICT,

  CONSTRAINT join_code_hash_uk UNIQUE ("codeHash"),
  -- Target of membership.joinCodeId's composite FK (a membership's code must be for its organization).
  CONSTRAINT join_code_id_org_uk UNIQUE (id, "organizationId"),
  -- The pair MUST be a real (organization, platform): no Organization A + Platform B, hence no
  -- cross-platform and (via platform.companyId) no cross-company code.
  CONSTRAINT join_code_org_platform_fk FOREIGN KEY ("organizationId", "platformId")
    REFERENCES organization (id, "platformId") ON DELETE RESTRICT,
  CONSTRAINT join_code_not_overused CHECK ("maxUses" IS NULL OR "usedCount" <= "maxUses"),
  CONSTRAINT join_code_expiry_after_creation CHECK ("expiresAt" IS NULL OR "expiresAt" > "createdAt"),
  CONSTRAINT join_code_revocation_consistent CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL) AND ("revokedAt" IS NULL OR NOT "isActive"))
);
CREATE INDEX join_code_org_idx ON organization_join_code ("organizationId");

CREATE FUNCTION join_code_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_join_code rows are never deleted (revoke instead)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."organizationId", NEW."platformId", NEW."codeHash", NEW.audience, NEW."requiresApproval",
      NEW."requiresSubscription", NEW."expiresAt", NEW."maxUses", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."organizationId", OLD."platformId", OLD."codeHash", OLD.audience, OLD."requiresApproval",
      OLD."requiresSubscription", OLD."expiresAt", OLD."maxUses", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'organization_join_code target, hash, audience, flags and limits are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."usedCount" < OLD."usedCount" THEN
    RAISE EXCEPTION 'organization_join_code.usedCount can only increase' USING ERRCODE = '23514';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" OR NEW."isActive") THEN
    RAISE EXCEPTION 'a revoked join code can never be revived' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_join_code_guard
  BEFORE UPDATE OR DELETE ON organization_join_code
  FOR EACH ROW EXECUTE FUNCTION join_code_guard();

-- ---------------------------------------------------------------------------------------------
-- OrganizationMembership
-- ---------------------------------------------------------------------------------------------
CREATE TYPE membership_status AS ENUM ('pending', 'active', 'rejected');

CREATE TABLE organization_membership (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"               uuid NOT NULL,
  "organizationId"       uuid NOT NULL,
  status                 membership_status NOT NULL,
  "joinCodeId"           uuid,
  "requestedAt"          timestamptz NOT NULL DEFAULT now(),
  "approvedAt"           timestamptz,
  "approvedBy"           uuid REFERENCES "user" (id) ON DELETE RESTRICT,  -- NULL = automatic (no approval required)
  "rejectedAt"           timestamptz,
  "rejectedBy"           uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  -- Organization administration is an access-scope capability owned by Auth (ADR-0028). Granted by an
  -- Owner with step-up; only meaningful for an ACTIVE membership.
  "isOrganizationAdmin"  boolean NOT NULL DEFAULT false,
  "createdAt"            timestamptz NOT NULL DEFAULT now(),
  "updatedAt"            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT membership_user_org_uk UNIQUE ("userId", "organizationId"),
  -- A membership can only name the member's OWN organization ("member -> exactly one organization").
  CONSTRAINT membership_member_org_fk FOREIGN KEY ("userId", "organizationId")
    REFERENCES "user" (id, "organizationId") ON DELETE RESTRICT,
  -- The code that admitted the member must belong to the same organization.
  CONSTRAINT membership_join_code_fk FOREIGN KEY ("joinCodeId", "organizationId")
    REFERENCES organization_join_code (id, "organizationId") ON DELETE RESTRICT,
  CONSTRAINT membership_active_needs_approval_time CHECK (status <> 'active' OR "approvedAt" IS NOT NULL),
  CONSTRAINT membership_rejected_needs_actor CHECK (status <> 'rejected' OR ("rejectedAt" IS NOT NULL AND "rejectedBy" IS NOT NULL)),
  CONSTRAINT membership_no_mixed_resolution CHECK (NOT ("approvedAt" IS NOT NULL AND "rejectedAt" IS NOT NULL)),
  CONSTRAINT membership_pending_unresolved CHECK (status <> 'pending' OR ("approvedAt" IS NULL AND "rejectedAt" IS NULL)),
  CONSTRAINT membership_admin_only_when_active CHECK (NOT "isOrganizationAdmin" OR status = 'active')
);
CREATE INDEX membership_org_status_idx ON organization_membership ("organizationId", status);

CREATE FUNCTION membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_membership rows are never deleted (history is kept)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."userId", NEW."organizationId", NEW."joinCodeId", NEW."requestedAt", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."userId", OLD."organizationId", OLD."joinCodeId", OLD."requestedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'organization_membership identity fields are immutable' USING ERRCODE = '23514';
  END IF;
  -- The only legal moves: pending -> active | rejected. Resolved states are final (revocation and
  -- suspension are future scope and will be added deliberately, not by loosening this).
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected')) THEN
    RAISE EXCEPTION 'illegal membership transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND (NEW."approvedAt", NEW."approvedBy", NEW."rejectedAt", NEW."rejectedBy")
       IS DISTINCT FROM (OLD."approvedAt", OLD."approvedBy", OLD."rejectedAt", OLD."rejectedBy") THEN
    RAISE EXCEPTION 'a resolved membership decision cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_membership_guard
  BEFORE UPDATE OR DELETE ON organization_membership
  FOR EACH ROW EXECUTE FUNCTION membership_guard();

-- Existing members keep their access: one ACTIVE membership each.
INSERT INTO organization_membership ("userId", "organizationId", status, "approvedAt", "requestedAt", "createdAt", "updatedAt")
SELECT id, "organizationId", 'active', "createdAt", "createdAt", "createdAt", now()
FROM "user" WHERE kind = 'member';

-- ---------------------------------------------------------------------------------------------
-- Member contact verification (mirrors admin_operator_code)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE member_contact_verification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"        uuid NOT NULL,
  kind            user_kind NOT NULL DEFAULT 'member' CHECK (kind = 'member'),
  channel         text NOT NULL CHECK (channel IN ('email', 'phone')),
  "codeHash"      text NOT NULL CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),   -- HMAC; the raw code is never stored
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "expiresAt"     timestamptz NOT NULL,
  "attemptCount"  smallint NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "consumedAt"    timestamptz,
  "supersededAt"  timestamptz,
  FOREIGN KEY ("userId", kind) REFERENCES "user" (id, kind) ON DELETE RESTRICT,
  CONSTRAINT member_contact_verification_expiry CHECK ("expiresAt" > "createdAt")
);
-- At most one LIVE code per member: a race can never leave two valid codes.
CREATE UNIQUE INDEX member_contact_verification_one_live
  ON member_contact_verification ("userId") WHERE "consumedAt" IS NULL AND "supersededAt" IS NULL;

COMMIT;
