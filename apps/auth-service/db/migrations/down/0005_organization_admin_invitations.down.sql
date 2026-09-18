-- Rollback of 0005. Refuses to destroy invitations, or memberships that were admitted by one: archive them first.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_admin_invitation) THEN
    RAISE EXCEPTION 'down/0005 refused: organization_admin_invitation holds data. Archive it first.';
  END IF;
  IF EXISTS (SELECT 1 FROM organization_membership WHERE "invitationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'down/0005 refused: memberships reference an invitation. Archive them first.';
  END IF;
END $$;
-- Restore the 0004 guard (no invitationId in the frozen tuple) before dropping the column.
CREATE OR REPLACE FUNCTION membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_membership rows are never deleted (history is kept)' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."userId", NEW."organizationId", NEW."joinCodeId", NEW."requestedAt", NEW."createdAt")
     IS DISTINCT FROM (OLD.id, OLD."userId", OLD."organizationId", OLD."joinCodeId", OLD."requestedAt", OLD."createdAt") THEN
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
ALTER TABLE organization_membership
  DROP CONSTRAINT membership_one_admission_source,
  DROP CONSTRAINT membership_invitation_fk,
  DROP COLUMN "invitationId";
DROP TRIGGER organization_admin_invitation_guard ON organization_admin_invitation;
DROP TABLE organization_admin_invitation;
DROP FUNCTION admin_invitation_guard();
COMMIT;
