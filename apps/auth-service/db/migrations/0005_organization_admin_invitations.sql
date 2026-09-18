-- 0005 — auth-service: organization admin invitations (privileged provisioning).
--
--   * organization_admin_invitation — a separate, single-use, revocable, server-expiring credential that
--                                     provisions a member with the generic organization-management
--                                     capability. NEVER a join code, a license, a password or a session.
--   * organization_membership.invitationId — provenance of an invitation-admitted membership
--
-- Invariants kept by the DATABASE (not only by the service):
--   - an invitation can only name an (organization, platform) pair that really belong together
--     (composite FK), so it can never cross platform or company;
--   - single use: consumedAt/consumedBy are set once and never rewritten; an invitation can never be
--     both consumed and revoked, nor consumed after it expired, nor revived after revocation;
--   - its lifetime is bounded (never longer than 30 days; the service enforces the tighter, configurable
--     range) and the absolute expiry is fixed at creation;
--   - the label ("invitationType") is opaque and can never be the reserved word "admin" (a member can
--     never carry that role: user_admin_role_reserved, migration 0001).
--
-- Invitation lifetime and authentication-session lifetime are unrelated: once consumed the invitation is
-- dead and the new administrator uses the normal session machinery.
-- Rollback: down/0005_*.down.sql (refuses to destroy data that would be lost).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organization_admin_invitation') IS NOT NULL THEN
    RAISE EXCEPTION '0005 refused: organization_admin_invitation already exists. This migration never repairs or overwrites existing data.';
  END IF;
END $$;

CREATE TABLE organization_admin_invitation (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"     uuid NOT NULL,
  "platformId"         uuid NOT NULL,
  -- HMAC-SHA-256(JOIN_CODE_PEPPER, domain "admin_invitation", normalized code). Plaintext shown once.
  "codeHash"           text NOT NULL CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  -- Opaque, platform-defined label (stored as the new member's role). 'admin' stays reserved.
  "invitationType"     text NOT NULL CHECK ("invitationType" ~ '^[a-z][a-z0-9_-]{0,31}$' AND "invitationType" <> 'admin'),
  -- Optional binding to the intended person: HMAC of the normalized e-mail/phone (no PII at rest).
  "inviteeContactHash" text CHECK ("inviteeContactHash" IS NULL OR "inviteeContactHash" ~ '^[0-9a-f]{64}$'),
  "expiresAt"          timestamptz NOT NULL,
  "createdBy"          uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "consumedAt"         timestamptz,
  "consumedBy"         uuid REFERENCES "user" (id) ON DELETE RESTRICT,
  "revokedAt"          timestamptz,
  "revokedBy"          uuid REFERENCES "user" (id) ON DELETE RESTRICT,

  CONSTRAINT admin_invitation_hash_uk UNIQUE ("codeHash"),
  -- Target of membership.invitationId's composite FK (an invitation-admitted membership must be in the
  -- invitation's own organization).
  CONSTRAINT admin_invitation_id_org_uk UNIQUE (id, "organizationId"),
  CONSTRAINT admin_invitation_org_platform_fk FOREIGN KEY ("organizationId", "platformId")
    REFERENCES organization (id, "platformId") ON DELETE RESTRICT,
  CONSTRAINT admin_invitation_lifetime CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '30 days'),
  CONSTRAINT admin_invitation_consumed_pair CHECK (("consumedAt" IS NULL) = ("consumedBy" IS NULL)),
  CONSTRAINT admin_invitation_revoked_pair CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL)),
  CONSTRAINT admin_invitation_not_both CHECK ("consumedAt" IS NULL OR "revokedAt" IS NULL),
  CONSTRAINT admin_invitation_not_consumed_after_expiry CHECK ("consumedAt" IS NULL OR "consumedAt" <= "expiresAt")
);
CREATE INDEX admin_invitation_org_idx ON organization_admin_invitation ("organizationId");

CREATE FUNCTION admin_invitation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_admin_invitation rows are never deleted (revoke instead)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."organizationId", NEW."platformId", NEW."codeHash", NEW."invitationType",
      NEW."inviteeContactHash", NEW."expiresAt", NEW."createdBy", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."organizationId", OLD."platformId", OLD."codeHash", OLD."invitationType",
      OLD."inviteeContactHash", OLD."expiresAt", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'organization_admin_invitation target, hash, type, binding and expiry are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."consumedAt" IS NOT NULL AND (NEW."consumedAt", NEW."consumedBy") IS DISTINCT FROM (OLD."consumedAt", OLD."consumedBy") THEN
    RAISE EXCEPTION 'a consumed invitation can never be rewritten (single use)' USING ERRCODE = '23514';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND (NEW."revokedAt", NEW."revokedBy") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedBy") THEN
    RAISE EXCEPTION 'a revoked invitation can never be revived or rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_admin_invitation_guard
  BEFORE UPDATE OR DELETE ON organization_admin_invitation
  FOR EACH ROW EXECUTE FUNCTION admin_invitation_guard();

-- ---------------------------------------------------------------------------------------------
-- Membership provenance: a membership was admitted by a join code OR an invitation, never both.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE organization_membership
  ADD COLUMN "invitationId" uuid,
  ADD CONSTRAINT membership_invitation_fk FOREIGN KEY ("invitationId", "organizationId")
    REFERENCES organization_admin_invitation (id, "organizationId") ON DELETE RESTRICT,
  ADD CONSTRAINT membership_one_admission_source CHECK ("joinCodeId" IS NULL OR "invitationId" IS NULL);

-- Same guard as 0004, with the new provenance column frozen as well.
CREATE OR REPLACE FUNCTION membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_membership rows are never deleted (history is kept)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."userId", NEW."organizationId", NEW."joinCodeId", NEW."invitationId", NEW."requestedAt", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."userId", OLD."organizationId", OLD."joinCodeId", OLD."invitationId", OLD."requestedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'organization_membership identity fields are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('active', 'rejected')) THEN
    RAISE EXCEPTION 'illegal membership transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' AND (NEW."approvedAt", NEW."approvedBy", NEW."rejectedAt", NEW."rejectedBy")
       IS DISTINCT FROM (OLD."approvedAt", OLD."approvedBy", OLD."rejectedAt", OLD."rejectedBy") THEN
    RAISE EXCEPTION 'a resolved membership decision cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
