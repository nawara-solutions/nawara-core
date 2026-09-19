-- 0007 — auth-service: one User, N OrganizationMemberships (ADR-0030).
--
-- Until now a member had exactly one organization, stored on the user row ("user"."organizationId") together
-- with a role label copied from the join code. That is a v1 restriction (ADR-0001/0024), and the label is a
-- platform-specific business concept that does not belong on an identity. This migration makes the membership
-- the ONLY user<->organization link:
--
--   * organization_membership.audience   — the opaque platform-defined label (moved from "user".role)
--   * organization_membership.revoked*   — the REVOKED state (active -> revoked, final)
--   * one membership row per (user, organization); a user can have many, in many organizations/platforms
--   * "user"."organizationId", the single-organization CHECK and the user_platform view are removed;
--     members get the neutral role 'member' (owners/operators keep the reserved 'admin')
--   * view member_platform: membership -> organization -> platform -> company
--   * a member must always have at least one membership row (deferred constraint; rows are never deleted)
--
-- Nothing platform-specific is introduced: no "User.platformId", no business role on the user.
-- Rollback: down/0007_*.sql refuses if any user has more than one membership or a revoked one.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- Preflight: refuse rather than guess
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "user" u
   WHERE u.kind = 'member' AND NOT EXISTS (SELECT 1 FROM organization_membership m WHERE m."userId" = u.id);
  IF n > 0 THEN
    RAISE EXCEPTION '0007 refused: % member(s) have no organization_membership row (0004 backfills one per member; investigate before continuing).', n;
  END IF;
  SELECT count(*) INTO n FROM organization_membership m JOIN "user" u ON u.id = m."userId"
   WHERE m."organizationId" IS DISTINCT FROM u."organizationId";
  IF n > 0 THEN
    RAISE EXCEPTION '0007 refused: % membership(s) name an organization other than the member''s own; the single-organization invariant was violated.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- organization_membership: label, member-only user link, REVOKED state
-- ---------------------------------------------------------------------------------------------
ALTER TABLE organization_membership
  ADD COLUMN audience    text,
  ADD COLUMN "userKind"  user_kind NOT NULL DEFAULT 'member' CHECK ("userKind" = 'member'),
  ADD COLUMN "revokedAt" timestamptz,
  ADD COLUMN "revokedBy" uuid REFERENCES "user" (id) ON DELETE RESTRICT;

-- The label lived on the user; it now lives on the relationship it describes.
UPDATE organization_membership m SET audience = u.role FROM "user" u WHERE u.id = m."userId";

ALTER TABLE organization_membership
  ALTER COLUMN audience SET NOT NULL,
  ADD CONSTRAINT membership_audience_shape CHECK (audience ~ '^[a-z][a-z0-9_-]{0,63}$' AND audience <> 'admin');

-- A membership belongs to a MEMBER (owners and operators have none), but to ANY of their organizations.
-- The organization was previously reachable only through "user"."organizationId"; the membership now needs its OWN
-- foreign key, or a membership could name an organization that does not exist (and an organization with members
-- could be deleted).
ALTER TABLE organization_membership
  DROP CONSTRAINT membership_member_org_fk,
  ADD CONSTRAINT membership_member_fk FOREIGN KEY ("userId", "userKind") REFERENCES "user" (id, kind) ON DELETE RESTRICT,
  ADD CONSTRAINT membership_organization_fk FOREIGN KEY ("organizationId") REFERENCES organization (id) ON DELETE RESTRICT;

ALTER TABLE organization_membership
  ADD CONSTRAINT membership_revoked_needs_actor CHECK (status <> 'revoked' OR ("revokedAt" IS NOT NULL AND "revokedBy" IS NOT NULL AND "approvedAt" IS NOT NULL)),
  ADD CONSTRAINT membership_revoke_fields_only_when_revoked CHECK (("revokedAt" IS NULL AND "revokedBy" IS NULL) OR status = 'revoked');

-- Same guard as 0005 plus: audience/userKind frozen, and the only new legal move is active -> revoked.
CREATE OR REPLACE FUNCTION membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_membership rows are never deleted (history is kept)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."userId", NEW."userKind", NEW."organizationId", NEW.audience, NEW."joinCodeId", NEW."invitationId", NEW."requestedAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."userId", OLD."userKind", OLD."organizationId", OLD.audience, OLD."joinCodeId", OLD."invitationId", OLD."requestedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'organization_membership identity fields are immutable' USING ERRCODE = '23514';
  END IF;
  -- Legal moves: pending -> active | rejected, and active -> revoked. rejected and revoked are final.
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('active', 'rejected')) OR (OLD.status = 'active' AND NEW.status = 'revoked')) THEN
    RAISE EXCEPTION 'illegal membership transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  -- An approval or rejection is never rewritten once made (a revoked membership keeps its approval as history).
  IF OLD.status <> 'pending' AND (NEW."approvedAt", NEW."approvedBy", NEW."rejectedAt", NEW."rejectedBy")
       IS DISTINCT FROM (OLD."approvedAt", OLD."approvedBy", OLD."rejectedAt", OLD."rejectedBy") THEN
    RAISE EXCEPTION 'a resolved membership decision cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked' AND (NEW."revokedAt", NEW."revokedBy") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedBy") THEN
    RAISE EXCEPTION 'a revocation cannot be rewritten' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------------------------
-- "user": no organization, no business role
-- ---------------------------------------------------------------------------------------------
DROP VIEW user_platform;
ALTER TABLE "user" DROP CONSTRAINT user_org_iff_member;
DROP INDEX user_organization_idx;
ALTER TABLE "user" DROP CONSTRAINT user_id_organization_uk;   -- target of the FK dropped above
ALTER TABLE "user" DROP COLUMN "organizationId";               -- also drops user_organizationId_fkey
UPDATE "user" SET role = 'member' WHERE kind = 'member';       -- neutral: a business role is the platform's concern
-- Hard guarantee: an identity's role can only be the neutral 'member' or the reserved 'admin' (owners/operators).
-- A platform-specific label ("teacher", "driver", ...) can never be stored on a user again.
ALTER TABLE "user"
  DROP CONSTRAINT user_admin_role_reserved,
  ADD CONSTRAINT user_role_is_kind_neutral CHECK ((kind = 'member' AND role = 'member') OR (kind <> 'member' AND role = 'admin'));

-- The ONE canonical membership -> organization -> platform -> company path (no denormalized copy anywhere).
CREATE VIEW member_platform AS
  SELECT m."userId", m.id AS "membershipId", m."organizationId", o."platformId", p."companyId", m.status, m."isOrganizationAdmin"
  FROM organization_membership m
  JOIN organization o ON o.id = m."organizationId"
  JOIN platform p ON p.id = o."platformId";

-- A member must always have at least one membership row (deferred, so both can be inserted together).
CREATE OR REPLACE FUNCTION user_require_subtype() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'owner' AND NOT EXISTS (SELECT 1 FROM owner WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=owner but no owner row', NEW.id USING ERRCODE = '23514';
  ELSIF NEW.kind = 'operator' AND NOT EXISTS (SELECT 1 FROM operator WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=operator but no operator row', NEW.id USING ERRCODE = '23514';
  ELSIF NEW.kind = 'member' AND NOT EXISTS (SELECT 1 FROM organization_membership WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=member but no organization membership', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

COMMIT;
