-- Rollback of 0003. Refuses to destroy the audit log or recovery history: archive them first.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_audit_event) OR EXISTS (SELECT 1 FROM owner_recovery_request) THEN
    RAISE EXCEPTION 'down/0003 refused: auth_audit_event / owner_recovery_request hold data. Archive it first.';
  END IF;
END $$;
DROP TABLE auth_audit_event;
DROP FUNCTION auth_audit_event_append_only();
DROP TABLE auth_throttle;
DROP TABLE owner_recovery_request;
DROP FUNCTION owner_recovery_guard();
DROP TYPE recovery_status;
DROP TABLE owner_auth_challenge;
DROP TYPE owner_challenge_kind;
DROP INDEX owner_auth_factor_key_idx;
ALTER TABLE owner_auth_factor
  DROP CONSTRAINT owner_auth_factor_totp_only_columns,
  DROP CONSTRAINT owner_auth_factor_totp_key_id,
  DROP COLUMN transports, DROP COLUMN "lastUsedCounter", DROP COLUMN "secretKeyId";
COMMIT;
