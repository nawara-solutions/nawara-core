-- Rollback of 0009. Restores the [1..N] member-membership requirement. Refuses if any member currently
-- has zero memberships, since the restored constraint could not otherwise hold at commit.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.kind = 'member'
      AND NOT EXISTS (SELECT 1 FROM organization_membership m WHERE m."userId" = u.id)
  ) THEN
    RAISE EXCEPTION 'down/0009 refused: a member with zero memberships exists; the [1..N] model cannot represent it.';
  END IF;
END $$;

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
