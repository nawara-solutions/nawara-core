-- 0002 — auth-service: tenancy-anchor immutability, subtype integrity on DELETE, operator
-- code/session enforcement, owner MFA/passkey + step-up storage, authentication ≠ entitlement.
--
-- Design: docs/adr/0025-*.md (owner authentication, secret key as step-up/recovery),
--         docs/adr/0026-*.md (authentication is not entitlement), docs/sdd/auth-service.md.
--
-- Safety model (see the SDD "Migration" section):
--   1. PREFLIGHT: every constraint added below is first checked against existing rows. ALL
--      violations are collected into ONE report and the migration aborts (nothing is changed)
--      rather than repairing or deleting anything it cannot repair deterministically.
--   2. Nothing is destructive without acknowledgement: the only column dropped, "user"."trialEndsAt",
--      carries subscription-like state that moves to payment-service. If any row still holds a
--      value, the migration refuses unless the operator has exported it and explicitly opts in:
--        SET auth.ack_trial_ends_at_moved = 'on';   -- in the same session, before running this file
--   3. Reversible where practical: db/migrations/down/0002_*.sql restores the schema shape
--      (it cannot restore a dropped trialEndsAt VALUE — that lives in payment-service after export).
--
-- Operational note: like every trigger/FK in this schema, the triggers below are bypassed by
-- `SET session_replication_role = replica` and by TRUNCATE. Only migrations run as the schema
-- owner; the application role must not have those privileges.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. PREFLIGHT — detect, report, abort. No writes.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  problems text[] := ARRAY[]::text[];
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "user" u
   WHERE (u.kind = 'owner'    AND NOT EXISTS (SELECT 1 FROM owner    o WHERE o."userId" = u.id))
      OR (u.kind = 'operator' AND NOT EXISTS (SELECT 1 FROM operator p WHERE p."userId" = u.id));
  IF n > 0 THEN problems := problems || format('%s owner/operator user(s) have no subtype row', n); END IF;

  SELECT count(*) INTO n FROM "user" WHERE "trialEndsAt" IS NOT NULL;
  IF n > 0 AND coalesce(current_setting('auth.ack_trial_ends_at_moved', true), 'off') <> 'on' THEN
    problems := problems || format(
      '%s user(s) still hold a trialEndsAt value. It is subscription state that now belongs to payment-service (ADR-0026): export it, then SET auth.ack_trial_ends_at_moved = ''on'' and re-run', n);
  END IF;

  SELECT count(*) INTO n FROM admin_operator_code WHERE "consumedAt" IS NOT NULL AND "attemptCount" >= 5;
  IF n > 0 THEN problems := problems || format('%s operator code(s) were consumed after being locked out (attemptCount >= 5)', n); END IF;

  SELECT count(*) INTO n FROM admin_operator_code WHERE "consumedAt" IS NOT NULL AND "consumedAt" > "expiresAt";
  IF n > 0 THEN problems := problems || format('%s operator code(s) were consumed after they expired', n); END IF;

  SELECT count(*) INTO n FROM refresh_token r JOIN "user" u ON u.id = r."userId"
   WHERE u.kind = 'operator' AND r."sessionExpiresAt" IS NULL;
  IF n > 0 THEN problems := problems || format('%s operator refresh token(s) have no sessionExpiresAt', n); END IF;

  SELECT count(*) INTO n FROM refresh_token r JOIN "user" u ON u.id = r."userId"
   WHERE u.kind <> 'operator' AND r."sessionExpiresAt" IS NOT NULL;
  IF n > 0 THEN problems := problems || format('%s non-operator refresh token(s) carry a sessionExpiresAt', n); END IF;

  SELECT count(*) INTO n FROM refresh_token WHERE "sessionExpiresAt" IS NOT NULL AND "expiresAt" > "sessionExpiresAt";
  IF n > 0 THEN problems := problems || format('%s refresh token(s) outlive their sessionExpiresAt ceiling', n); END IF;

  SELECT count(*) INTO n FROM owner WHERE "secretKeyHash" IS NOT NULL AND "secretKeyHash" !~ '^[0-9a-f]{64}$';
  IF n > 0 THEN problems := problems || format('%s owner secretKeyHash value(s) are not a 64-hex digest (plaintext or wrong format?)', n); END IF;

  SELECT count(*) INTO n FROM admin_operator_code WHERE "codeHash" !~ '^[0-9a-f]{64}$';
  IF n > 0 THEN problems := problems || format('%s operator codeHash value(s) are not a 64-hex digest (plaintext or wrong format?)', n); END IF;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION E'0002 refused — the existing data violates the new invariants (nothing was changed):\n  - %\nFix or export these deliberately (see docs/sdd/auth-service.md "Migration"); this migration never guesses.',
      array_to_string(problems, E'\n  - ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Tenancy anchors: Owner.companyId / Operator.companyId (and the subtype keys) are immutable
-- ---------------------------------------------------------------------------------------------
-- forbid_column_change() comes from 0001. These protect the same-company composite FKs that
-- PlatformAssignment relies on: without them an UPDATE could move an operator/owner to another
-- company and silently re-anchor every check that compares companies.
CREATE TRIGGER owner_company_immutable BEFORE UPDATE ON owner
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('companyId', 'userId');
CREATE TRIGGER operator_company_immutable BEFORE UPDATE ON operator
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('companyId', 'userId');

-- ---------------------------------------------------------------------------------------------
-- 3. Subtype integrity on DELETE
-- ---------------------------------------------------------------------------------------------
-- 0001 only checked "kind=owner ⇒ owner row exists" right after INSERT. Since kind is immutable
-- the only remaining hole was deleting the SUBTYPE row and leaving the user behind. Closed here
-- with a deferred check, so deleting a subtype row and its user in one transaction still works.
CREATE FUNCTION subtype_row_still_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "user" WHERE id = OLD."userId" AND kind = TG_ARGV[0]::user_kind) THEN
    RAISE EXCEPTION 'user % has kind=% but its % row was removed', OLD."userId", TG_ARGV[0], TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER owner_row_required
  AFTER DELETE ON owner DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION subtype_row_still_required('owner');
CREATE CONSTRAINT TRIGGER operator_row_required
  AFTER DELETE ON operator DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION subtype_row_still_required('operator');

-- ---------------------------------------------------------------------------------------------
-- 4. Operator working codes: locked-out or expired codes can never have been consumed
-- ---------------------------------------------------------------------------------------------
ALTER TABLE admin_operator_code
  ADD CONSTRAINT aoc_consumed_not_locked_out CHECK ("consumedAt" IS NULL OR "attemptCount" < 5),
  ADD CONSTRAINT aoc_consumed_before_expiry  CHECK ("consumedAt" IS NULL OR "consumedAt" <= "expiresAt");

-- Credentials are stored only as digests: a raw 6-digit code, or a raw secret key, is
-- structurally unstorable (neither is a 64-char lowercase-hex string). This is a guard against
-- an application bug or a manual INSERT, not a substitute for hashing correctly:
--   * codeHash = HMAC-SHA-256(server-side pepper, operatorId || purpose || code), NOT a bare
--     SHA-256 — a bare hash of a 6-digit code falls to a 10^6-candidate offline search the moment
--     the table leaks (see the SDD).
--   * secretKeyHash = SHA-256 of a high-entropy, server-generated key (ADR-0010).
ALTER TABLE admin_operator_code ADD CONSTRAINT aoc_code_hash_format CHECK ("codeHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE owner ADD CONSTRAINT owner_secret_key_hash_format CHECK ("secretKeyHash" IS NULL OR "secretKeyHash" ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------------------------
-- 5. Operator sessions are time-bounded in the data layer, not only in prose
-- ---------------------------------------------------------------------------------------------
-- A refresh token may never outlive its session ceiling ...
ALTER TABLE refresh_token
  ADD CONSTRAINT refresh_token_within_session_ceiling
  CHECK ("sessionExpiresAt" IS NULL OR "expiresAt" <= "sessionExpiresAt");

-- ... and sessionExpiresAt is set exactly for operator sessions (ADR-0013/0014).
CREATE FUNCTION refresh_token_session_ceiling_by_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k user_kind;
BEGIN
  SELECT kind INTO k FROM "user" WHERE id = NEW."userId";
  IF (k = 'operator') AND NEW."sessionExpiresAt" IS NULL THEN
    RAISE EXCEPTION 'operator refresh token requires sessionExpiresAt' USING ERRCODE = '23514';
  ELSIF (k <> 'operator') AND NEW."sessionExpiresAt" IS NOT NULL THEN
    RAISE EXCEPTION 'sessionExpiresAt is only valid for operator sessions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refresh_token_session_ceiling_by_kind BEFORE INSERT ON refresh_token
  FOR EACH ROW EXECUTE FUNCTION refresh_token_session_ceiling_by_kind();

-- ---------------------------------------------------------------------------------------------
-- 6. Authentication ≠ entitlement (ADR-0026)
-- ---------------------------------------------------------------------------------------------
-- Trials are subscription state; they now live in payment-service (created on user.registered).
ALTER TABLE "user" DROP COLUMN "trialEndsAt";

-- Members authenticate with email OR phone + password (ADR-0025 aligns owners the same way).
-- 0001 forced an email for every non-operator; "at least one contact" + "password unless
-- operator" (both already in 0001) are the real rules.
ALTER TABLE "user" DROP CONSTRAINT user_email_unless_operator;

-- ---------------------------------------------------------------------------------------------
-- 7. Owner second factors and step-up (ADR-0025)
-- ---------------------------------------------------------------------------------------------
-- The secret key (owner.secretKeyHash) is NOT the daily credential. Normal owner login is
-- password + a second factor from this table; the secret key is a step-up / recovery credential.
CREATE TYPE owner_factor_type AS ENUM ('totp', 'webauthn');

CREATE TABLE owner_auth_factor (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId"          uuid NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  type               owner_factor_type NOT NULL,
  label              text,
  -- TOTP: the shared secret must be recoverable to verify a code, so it is stored ENCRYPTED
  -- (application-level AEAD, key held outside the database), never in plaintext and never hashed.
  "secretCiphertext" bytea,
  -- WebAuthn / passkey: public material only; the private key never leaves the authenticator.
  "credentialId"     bytea,
  "publicKey"        bytea,
  "signCount"        bigint,
  "confirmedAt"      timestamptz,   -- a factor is unusable until enrollment is confirmed
  "lastUsedAt"       timestamptz,
  "revokedAt"        timestamptz,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_auth_factor_id_owner_uk UNIQUE (id, "ownerId"),
  CONSTRAINT owner_auth_factor_credential_uk UNIQUE ("credentialId"),
  CONSTRAINT owner_auth_factor_totp_shape CHECK (
    type <> 'totp' OR ("secretCiphertext" IS NOT NULL AND "credentialId" IS NULL
                       AND "publicKey" IS NULL AND "signCount" IS NULL)),
  CONSTRAINT owner_auth_factor_webauthn_shape CHECK (
    type <> 'webauthn' OR ("secretCiphertext" IS NULL AND "credentialId" IS NOT NULL
                           AND "publicKey" IS NOT NULL AND "signCount" IS NOT NULL AND "signCount" >= 0)),
  CONSTRAINT owner_auth_factor_revoked_after_created CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);
CREATE INDEX owner_auth_factor_owner_idx ON owner_auth_factor ("ownerId") WHERE "revokedAt" IS NULL;

CREATE TYPE step_up_method AS ENUM ('secret_key', 'totp', 'webauthn');

-- One row per successful step-up. Doubles as the audit trail of who re-verified for which
-- sensitive operation. A step-up is short-lived, bound to one operation ("purpose") and one
-- session, and single-use.
CREATE TABLE owner_step_up (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId"         uuid NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  method            step_up_method NOT NULL,
  "factorId"        uuid,             -- required for totp/webauthn, absent for secret_key
  purpose           text NOT NULL CHECK (btrim(purpose) <> ''),  -- e.g. 'platform_assignment.grant'
  -- The refresh-token family (session) the step-up was performed in. Not an FK: familyId is not
  -- unique in refresh_token. A step-up from another session is rejected by the service.
  "sessionFamilyId" uuid NOT NULL,
  "verifiedAt"      timestamptz NOT NULL DEFAULT now(),
  "expiresAt"       timestamptz NOT NULL,
  "consumedAt"      timestamptz,
  CONSTRAINT owner_step_up_factor_fk FOREIGN KEY ("factorId", "ownerId")
    REFERENCES owner_auth_factor (id, "ownerId") ON DELETE RESTRICT,
  CONSTRAINT owner_step_up_factor_iff_not_secret CHECK ((method = 'secret_key') = ("factorId" IS NULL)),
  -- Short-lived by construction: at most 15 minutes of validity, whatever the service asks for.
  CONSTRAINT owner_step_up_short_lived CHECK ("expiresAt" > "verifiedAt" AND "expiresAt" <= "verifiedAt" + interval '15 minutes'),
  CONSTRAINT owner_step_up_consumed_in_window CHECK ("consumedAt" IS NULL OR ("consumedAt" >= "verifiedAt" AND "consumedAt" <= "expiresAt"))
);
CREATE INDEX owner_step_up_owner_idx ON owner_step_up ("ownerId", "verifiedAt");

-- Immutable audit record; the only permitted change is the single-use consumption.
CREATE FUNCTION owner_step_up_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner_step_up is an audit record: rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'owner_step_up % was already consumed (single use)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."ownerId", NEW.method, NEW."factorId", NEW.purpose, NEW."sessionFamilyId", NEW."verifiedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD.id, OLD."ownerId", OLD.method, OLD."factorId", OLD.purpose, OLD."sessionFamilyId", OLD."verifiedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'owner_step_up rows are immutable except for consumption' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_step_up_guard BEFORE UPDATE OR DELETE ON owner_step_up
  FOR EACH ROW EXECUTE FUNCTION owner_step_up_guard();

-- ---------------------------------------------------------------------------------------------
-- 8. Index for the owner authorization path  (Owner.companyId = Platform.companyId)
-- ---------------------------------------------------------------------------------------------
-- The operator path is already served by platform_assignment_one_active; the owner path joins
-- platform by companyId, which had no index.
CREATE INDEX platform_company_idx ON platform ("companyId");

COMMIT;
