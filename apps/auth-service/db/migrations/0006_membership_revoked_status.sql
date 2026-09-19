-- 0006 — auth-service: a REVOKED organization-membership status.
--
-- Kept in its own migration: a newly added enum value cannot be used in constraints or defaults inside the
-- transaction that adds it, and 0007 needs to. The rules for the new state (active -> revoked only, final,
-- who revoked and when) are added by 0007.
-- Rollback: PostgreSQL cannot remove an enum value; down/0006 only verifies the value is unused.

BEGIN;
ALTER TYPE membership_status ADD VALUE IF NOT EXISTS 'revoked';
COMMIT;
