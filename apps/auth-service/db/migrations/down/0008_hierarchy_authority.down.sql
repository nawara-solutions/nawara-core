-- Rollback of 0008. It REFUSES once the hierarchy is no longer local: after the freeze or the switch, removing the guards would let
-- auth-service write a hierarchy it no longer owns. Unfreeze first (only possible before the switch).
BEGIN;
DO $$
BEGIN
  IF (SELECT mode FROM hierarchy_authority) <> 'local' THEN
    RAISE EXCEPTION 'down/0008 refused: the hierarchy authority is not local; unfreeze first, and after the switch there is no way back.';
  END IF;
END $$;
DROP TRIGGER company_write_guard ON company;
DROP TRIGGER platform_write_guard ON platform;
DROP TRIGGER organization_write_guard ON organization;
DROP TRIGGER company_truncate_guard ON company;
DROP TRIGGER platform_truncate_guard ON platform;
DROP TRIGGER organization_truncate_guard ON organization;
DROP FUNCTION hierarchy_write_guard();
DROP FUNCTION hierarchy_truncate_guard();
DROP TABLE hierarchy_authority_event;
DROP TABLE hierarchy_authority;
DROP FUNCTION hierarchy_authority_guard();
DROP FUNCTION hierarchy_authority_forbid();
COMMIT;
