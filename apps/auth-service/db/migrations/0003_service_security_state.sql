-- 0003 — auth-service: persistent state the SERVICE layer needs to enforce ADR-0025/0026.
--
--   * TOTP: key id (rotation) + last accepted time step (replay protection), passkey transports
--   * owner_auth_challenge   — single-use, short-lived login/enrollment/WebAuthn challenges
--   * owner_recovery_request — recovery is a request with a cool-down, never an instant takeover
--   * auth_throttle          — shared (multi-instance) rate-limit counters
--   * auth_audit_event       — append-only security audit log
--
-- Same safety model as 0002: preflight (report everything, change nothing), no destructive step.
-- Rollback: down/0003_*.sql.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM owner_auth_factor WHERE type = 'totp';
  IF n > 0 THEN
    RAISE EXCEPTION E'0003 refused — % existing TOTP factor(s) have no secretKeyId, so the key that encrypted them is unknown.\n  Re-enroll them or backfill secretKeyId with the id of the key that encrypted each row, then re-run. This migration never guesses.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- TOTP key id + replay counter, passkey transports
-- ---------------------------------------------------------------------------------------------
ALTER TABLE owner_auth_factor
  ADD COLUMN "secretKeyId"     text,      -- which encryption key sealed secretCiphertext (rotation)
  ADD COLUMN "lastUsedCounter" bigint,    -- last accepted TOTP time step; a step is accepted at most once
  ADD COLUMN transports        text[],    -- passkey transport hints, informational only
  ADD CONSTRAINT owner_auth_factor_totp_key_id CHECK (type <> 'totp' OR "secretKeyId" IS NOT NULL),
  ADD CONSTRAINT owner_auth_factor_totp_only_columns CHECK (type = 'totp' OR ("secretKeyId" IS NULL AND "lastUsedCounter" IS NULL));
CREATE INDEX owner_auth_factor_key_idx ON owner_auth_factor ("secretKeyId") WHERE type = 'totp';

-- ---------------------------------------------------------------------------------------------
-- Challenges (login second-factor, first-factor enrollment, WebAuthn registration, step-up)
-- ---------------------------------------------------------------------------------------------
CREATE TYPE owner_challenge_kind AS ENUM ('login_mfa', 'enrollment', 'webauthn_registration', 'step_up');

CREATE TABLE owner_auth_challenge (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId"           uuid NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  kind                owner_challenge_kind NOT NULL,
  -- Opaque bearer tokens (login_mfa / enrollment) are stored ONLY as a SHA-256 digest of a
  -- 256-bit random value. Session-bound kinds (webauthn_registration / step_up) are addressed by id.
  "tokenHash"         text UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  "webauthnChallenge" text,          -- base64url; single use, only ever compared, never trusted
  "sessionFamilyId"   uuid,          -- session the challenge is bound to (step_up, webauthn_registration)
  purpose             text,          -- step_up only
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "expiresAt"         timestamptz NOT NULL,
  "consumedAt"        timestamptz,
  CONSTRAINT oac_short_lived CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '30 minutes'),
  CONSTRAINT oac_consumed_in_window CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt"),
  CONSTRAINT oac_token_kinds CHECK ((kind IN ('login_mfa','enrollment')) = ("tokenHash" IS NOT NULL)),
  CONSTRAINT oac_session_bound_kinds CHECK (kind NOT IN ('step_up','webauthn_registration') OR "sessionFamilyId" IS NOT NULL),
  CONSTRAINT oac_step_up_purpose CHECK ((kind = 'step_up') = (purpose IS NOT NULL))
);
CREATE INDEX oac_owner_idx ON owner_auth_challenge ("ownerId", kind) WHERE "consumedAt" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Owner recovery requests
-- ---------------------------------------------------------------------------------------------
-- Recovery = password + secret key + a mandatory cool-down, during which the owner is alerted and
-- may cancel from any session that still has a working factor. Nothing is revoked, spent or
-- issued until the request is COMPLETED after the cool-down.
CREATE TYPE recovery_status AS ENUM ('pending', 'cancelled', 'completed');

CREATE TABLE owner_recovery_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerId"     uuid NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  "tokenHash"   text NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  status        recovery_status NOT NULL DEFAULT 'pending',
  "requestIp"   text,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "availableAt" timestamptz NOT NULL,   -- earliest moment it may be completed (cool-down end)
  "expiresAt"   timestamptz NOT NULL,
  "resolvedAt"  timestamptz,
  CONSTRAINT orr_cooldown CHECK ("availableAt" > "createdAt" AND "expiresAt" > "availableAt"),
  CONSTRAINT orr_resolved_iff_not_pending CHECK ((status = 'pending') = ("resolvedAt" IS NULL))
);
CREATE UNIQUE INDEX owner_recovery_one_pending ON owner_recovery_request ("ownerId") WHERE status = 'pending';

-- A recovery request is a security record: never deleted, and only its resolution may change.
CREATE FUNCTION owner_recovery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner_recovery_request is an audit record: rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'owner_recovery_request % is already resolved', OLD.id USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."ownerId", NEW."tokenHash", NEW."createdAt", NEW."availableAt", NEW."expiresAt")
     IS DISTINCT FROM (OLD.id, OLD."ownerId", OLD."tokenHash", OLD."createdAt", OLD."availableAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'owner_recovery_request timing and identity are immutable (cool-down cannot be shortened)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_recovery_guard BEFORE UPDATE OR DELETE ON owner_recovery_request
  FOR EACH ROW EXECUTE FUNCTION owner_recovery_guard();

-- ---------------------------------------------------------------------------------------------
-- Shared rate-limit counters (fixed window). Keys are HMACs, never raw identifiers.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth_throttle (
  bucket        text NOT NULL CHECK (bucket ~ '^[a-z_.]+$'),
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  "windowStart" timestamptz NOT NULL DEFAULT now(),
  count         integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (bucket, key)
);
CREATE INDEX auth_throttle_window_idx ON auth_throttle ("windowStart");

-- ---------------------------------------------------------------------------------------------
-- Append-only security audit log. Contains NO secrets: the service redacts before writing, and
-- the size cap below stops a payload dump (a token/assertion) from being stored by mistake.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE auth_audit_event (
  id                bigserial PRIMARY KEY,
  "occurredAt"      timestamptz NOT NULL DEFAULT now(),
  type              text NOT NULL CHECK (type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  outcome           text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  "actorId"         uuid,      -- deliberately no FK: the trail must outlive any row it refers to
  "targetId"        uuid,
  "sessionFamilyId" uuid,
  ip                text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(metadata) < 2048)
);
CREATE INDEX auth_audit_event_actor_idx ON auth_audit_event ("actorId", "occurredAt");
CREATE INDEX auth_audit_event_type_idx ON auth_audit_event (type, "occurredAt");

CREATE FUNCTION auth_audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auth_audit_event is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER auth_audit_event_append_only BEFORE UPDATE OR DELETE ON auth_audit_event
  FOR EACH ROW EXECUTE FUNCTION auth_audit_event_append_only();

COMMIT;
