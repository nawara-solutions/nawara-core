-- Rollback of 0007. The single-organization model can only be restored when nothing depends on the new one:
-- it refuses if any user has more than one membership (there is no single organization to write back) or any
-- membership is revoked (the old model has no such state). Archive or resolve those first.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM (SELECT "userId" FROM organization_membership GROUP BY "userId" HAVING count(*) > 1) t;
  IF n > 0 THEN
    RAISE EXCEPTION 'down/0007 refused: % user(s) have more than one membership; the single-organization model cannot represent them.', n;
  END IF;
  IF EXISTS (SELECT 1 FROM organization_membership WHERE status::text = 'revoked') THEN
    RAISE EXCEPTION 'down/0007 refused: revoked memberships exist; the single-organization model has no such state.';
  END IF;
END $$;

DROP VIEW member_platform;

ALTER TABLE "user" DROP CONSTRAINT user_role_is_kind_neutral;
ALTER TABLE "user" ADD COLUMN "organizationId" uuid REFERENCES organization (id) ON DELETE RESTRICT;
UPDATE "user" u SET "organizationId" = m."organizationId", role = m.audience
  FROM organization_membership m WHERE m."userId" = u.id;
ALTER TABLE "user"
  ADD CONSTRAINT user_admin_role_reserved CHECK ((kind = 'member') = (role <> 'admin')),
  ADD CONSTRAINT user_org_iff_member CHECK ((kind = 'member') = ("organizationId" IS NOT NULL)),
  ADD CONSTRAINT user_id_organization_uk UNIQUE (id, "organizationId");
CREATE INDEX user_organization_idx ON "user" ("organizationId");
CREATE VIEW user_platform AS
  SELECT u.id AS "userId", u."organizationId", o."platformId", p."companyId"
  FROM "user" u JOIN organization o ON o.id = u."organizationId" JOIN platform p ON p.id = o."platformId";

ALTER TABLE organization_membership
  DROP CONSTRAINT membership_revoke_fields_only_when_revoked,
  DROP CONSTRAINT membership_revoked_needs_actor,
  DROP CONSTRAINT membership_member_fk,
  DROP CONSTRAINT membership_organization_fk,
  DROP CONSTRAINT membership_audience_shape,
  ADD CONSTRAINT membership_member_org_fk FOREIGN KEY ("userId", "organizationId") REFERENCES "user" (id, "organizationId") ON DELETE RESTRICT,
  DROP COLUMN audience, DROP COLUMN "userKind", DROP COLUMN "revokedAt", DROP COLUMN "revokedBy";

-- Restore the 0005 guard and the 0001 subtype check.
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
CREATE OR REPLACE FUNCTION user_require_subtype() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'owner' AND NOT EXISTS (SELECT 1 FROM owner WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=owner but no owner row', NEW.id USING ERRCODE = '23514';
  ELSIF NEW.kind = 'operator' AND NOT EXISTS (SELECT 1 FROM operator WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=operator but no operator row', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
COMMIT;
