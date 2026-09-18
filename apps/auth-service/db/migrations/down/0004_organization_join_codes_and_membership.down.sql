-- Rollback of 0004. Refuses to destroy join codes, non-backfilled memberships or verification history:
-- archive them first. Backfilled memberships (one ACTIVE row per pre-existing member, no join code,
-- no approver) are derived data and are dropped with the table.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_join_code) THEN
    RAISE EXCEPTION 'down/0004 refused: organization_join_code holds data. Archive it first.';
  END IF;
  IF EXISTS (SELECT 1 FROM organization_membership
              WHERE "joinCodeId" IS NOT NULL OR "approvedBy" IS NOT NULL OR "rejectedBy" IS NOT NULL
                 OR status <> 'active' OR "isOrganizationAdmin") THEN
    RAISE EXCEPTION 'down/0004 refused: organization_membership holds onboarding decisions. Archive them first.';
  END IF;
  IF EXISTS (SELECT 1 FROM member_contact_verification) THEN
    RAISE EXCEPTION 'down/0004 refused: member_contact_verification holds data. Archive it first.';
  END IF;
END $$;
DROP TABLE member_contact_verification;
DROP TRIGGER organization_membership_guard ON organization_membership;
DROP TABLE organization_membership;
DROP FUNCTION membership_guard();
DROP TYPE membership_status;
DROP TRIGGER organization_join_code_guard ON organization_join_code;
DROP TABLE organization_join_code;
DROP FUNCTION join_code_guard();
ALTER TABLE "user" DROP COLUMN "contactVerifiedAt";
ALTER TABLE "user" DROP CONSTRAINT user_id_organization_uk;
ALTER TABLE organization DROP CONSTRAINT organization_id_platform_uk;
ALTER TABLE platform DROP CONSTRAINT platform_key_uk, DROP CONSTRAINT platform_key_format, DROP COLUMN key;
COMMIT;
