-- Rollback of 0006. PostgreSQL cannot drop an enum value, so the label stays (harmless when unused).
-- This only refuses to proceed while any membership still uses it, because 0005 and earlier do not know it.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM organization_membership WHERE status::text = 'revoked') THEN
    RAISE EXCEPTION 'down/0006 refused: revoked memberships exist. Archive them first.';
  END IF;
  RAISE NOTICE 'down/0006: the enum label "revoked" remains in membership_status (PostgreSQL cannot remove it) but is unused.';
END $$;
COMMIT;
