-- 0001 — auth-service initial schema: Company → Platform → Organization → User,
-- Owner/Operator subtype tables, append-only PlatformAssignment, and the security entities.
--
-- Design: docs/sdd/auth-service.md ("Data model"), docs/adr/0024-*.md.
-- Greenfield only. No auth-service schema has ever been deployed, so there is no legacy data to
-- repair; this migration REFUSES to run against a database that already has any of these tables
-- rather than guessing how to reconcile them (see the guard below and the SDD's "Migration" section).
-- Column names are quoted camelCase to match the TypeORM default naming used everywhere in the docs.

BEGIN;

DO $$
DECLARE
  existing text;
BEGIN
  SELECT string_agg(t, ', ') INTO existing
  FROM unnest(ARRAY['company','platform','organization','user','owner','operator',
                    'platform_assignment','refresh_token','device','admin_device',
                    'admin_operator_code','operator_schedule','operator_time_off',
                    'platform_non_working_day']) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL;
  IF existing IS NOT NULL THEN
    RAISE EXCEPTION
      '0001 refused: legacy auth-service tables already exist (%). Run the legacy-upgrade procedure in docs/sdd/auth-service.md ("Migration") instead; this migration never repairs or overwrites existing data.',
      existing;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Company → Platform → Organization
-- ---------------------------------------------------------------------------------------------

CREATE TABLE company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" uuid NOT NULL REFERENCES company (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  -- Target of composite FKs that force same-company consistency (platform_assignment).
  CONSTRAINT platform_id_company_uk UNIQUE (id, "companyId")
);

CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId" uuid NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (btrim(name) <> ''),
  "taxCode"   text,
  address     text,
  phone       text,
  type        text,            -- opaque to auth-service (ADR-0001/0020)
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_platform_idx ON organization ("platformId");

-- ---------------------------------------------------------------------------------------------
-- User (identity) and its Owner / Operator subtypes
-- ---------------------------------------------------------------------------------------------

-- "kind" is the ONE authoritative answer to "what is this identity?". It replaces adminTier.
CREATE TYPE user_kind AS ENUM ('member', 'owner', 'operator');

CREATE TABLE "user" (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             user_kind NOT NULL,
  email            text UNIQUE,
  phone            text UNIQUE,
  "passwordHash"   text,
  role             text NOT NULL CHECK (btrim(role) <> ''),  -- opaque for members (ADR-0001)
  "organizationId" uuid REFERENCES organization (id) ON DELETE RESTRICT,
  "isActive"       boolean NOT NULL DEFAULT true,
  "trialEndsAt"    timestamptz,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "updatedAt"      timestamptz NOT NULL DEFAULT now(),

  -- Target of the subtype tables' (userId, kind) FK: a subtype row can only attach to a user
  -- whose kind matches, and kind can never drift underneath it.
  CONSTRAINT user_id_kind_uk UNIQUE (id, kind),

  -- Tenancy: a member ALWAYS has exactly one organization; owners/operators are company-scoped
  -- management identities and NEVER have one. There is deliberately no "platformId" column: a
  -- member's platform is organization → platform (see view user_platform).
  CONSTRAINT user_org_iff_member CHECK ((kind = 'member') = ("organizationId" IS NOT NULL)),

  -- 'admin' is the reserved role claim of management identities. A member can never carry it, so
  -- role = 'admin' in a JWT can never be forged through POST /auth/register.
  CONSTRAINT user_admin_role_reserved CHECK ((kind = 'member') = (role <> 'admin')),

  -- Operators authenticate only by login code (ADR-0011): never a password. Everyone else needs
  -- password + email (owners: password + secret key).
  CONSTRAINT user_password_iff_not_operator CHECK ((kind = 'operator') = ("passwordHash" IS NULL)),
  CONSTRAINT user_contact_present CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CONSTRAINT user_email_unless_operator CHECK (kind = 'operator' OR email IS NOT NULL)
);
CREATE INDEX user_organization_idx ON "user" ("organizationId");

CREATE TABLE owner (
  "userId"            uuid PRIMARY KEY,
  kind                user_kind NOT NULL DEFAULT 'owner' CHECK (kind = 'owner'),
  "companyId"         uuid NOT NULL REFERENCES company (id) ON DELETE RESTRICT,
  "secretKeyHash"     text,   -- SHA-256 (ADR-0010). NULL is legitimate: freshly bootstrapped (ADR-0016)
  "secretKeyIssuedAt" timestamptz,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_user_fk FOREIGN KEY ("userId", kind) REFERENCES "user" (id, kind),
  CONSTRAINT owner_user_company_uk UNIQUE ("userId", "companyId"),
  CONSTRAINT owner_secret_key_pair CHECK (("secretKeyHash" IS NULL) = ("secretKeyIssuedAt" IS NULL))
);
-- v1 POLICY (ADR-0017): exactly one owner per company. This is the ONLY thing enforcing it, and
-- it is deliberately separate from the authorization model: dropping this one index is all it
-- takes to allow several owners; no authorization query or FK depends on it.
CREATE UNIQUE INDEX owner_single_per_company_v1 ON owner ("companyId");

CREATE TABLE operator (
  "userId"            uuid PRIMARY KEY,
  kind                user_kind NOT NULL DEFAULT 'operator' CHECK (kind = 'operator'),
  "companyId"         uuid NOT NULL REFERENCES company (id) ON DELETE RESTRICT,
  "contactVerifiedAt" timestamptz,   -- ADR-0015
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_user_fk FOREIGN KEY ("userId", kind) REFERENCES "user" (id, kind),
  CONSTRAINT operator_user_company_uk UNIQUE ("userId", "companyId")
);

-- Every owner/operator user MUST have its subtype row by commit time (deferred so the two rows
-- can be inserted in one transaction).
CREATE FUNCTION user_require_subtype() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'owner' AND NOT EXISTS (SELECT 1 FROM owner WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=owner but no owner row', NEW.id USING ERRCODE = '23514';
  ELSIF NEW.kind = 'operator' AND NOT EXISTS (SELECT 1 FROM operator WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=operator but no operator row', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER user_require_subtype
  AFTER INSERT ON "user" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION user_require_subtype();

-- Tenancy anchors never move: there is no designed "move organization to another platform" or
-- "change identity kind" operation, and either would silently rewrite who may access what.
CREATE FUNCTION forbid_column_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER organization_platform_immutable BEFORE UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('platformId');
CREATE TRIGGER platform_company_immutable BEFORE UPDATE ON platform
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('companyId');
CREATE TRIGGER user_kind_immutable BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('kind');

-- The ONE canonical User → Organization → Platform → Company path, as a view, so nothing ever
-- needs (or is tempted to add) a denormalized copy. Members only; owners/operators have no row.
CREATE VIEW user_platform AS
  SELECT u.id AS "userId", u."organizationId", o."platformId", p."companyId"
  FROM "user" u
  JOIN organization o ON o.id = u."organizationId"
  JOIN platform p ON p.id = o."platformId";

-- ---------------------------------------------------------------------------------------------
-- PlatformAssignment — Operator → Platform, append-only
-- ---------------------------------------------------------------------------------------------

CREATE TABLE platform_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operatorId" uuid NOT NULL,
  "platformId" uuid NOT NULL,
  -- Redundant BY DESIGN: the composite FKs below force it to equal the platform's, the
  -- operator's and the granting owner's company, so cross-company grants are unrepresentable.
  -- It is never read for authorization (that goes through platformId).
  "companyId"  uuid NOT NULL,
  "assignedBy" uuid NOT NULL,   -- the granting Owner, derived server-side, never from the client
  "assignedAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt"  timestamptz,
  "revokedBy"  uuid,            -- the revoking Owner
  active       boolean NOT NULL DEFAULT true,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  "updatedAt"  timestamptz NOT NULL DEFAULT now(),

  -- operator.userId → user.id, owner.userId → user.id, so all three are real FKs to "user"
  -- as well, and the operator/assigner are guaranteed to actually BE an operator / owner.
  CONSTRAINT pa_operator_fk FOREIGN KEY ("operatorId", "companyId")
    REFERENCES operator ("userId", "companyId") ON DELETE RESTRICT,
  CONSTRAINT pa_platform_fk FOREIGN KEY ("platformId", "companyId")
    REFERENCES platform (id, "companyId") ON DELETE RESTRICT,
  CONSTRAINT pa_assigned_by_fk FOREIGN KEY ("assignedBy", "companyId")
    REFERENCES owner ("userId", "companyId") ON DELETE RESTRICT,
  CONSTRAINT pa_revoked_by_fk FOREIGN KEY ("revokedBy", "companyId")
    REFERENCES owner ("userId", "companyId") ON DELETE RESTRICT,

  -- "active" and "revokedAt" can never disagree.
  CONSTRAINT pa_active_iff_not_revoked CHECK (active = ("revokedAt" IS NULL)),
  CONSTRAINT pa_revoker_iff_revoked CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL)),
  CONSTRAINT pa_revoked_after_assigned CHECK ("revokedAt" IS NULL OR "revokedAt" >= "assignedAt")
);

-- The race-proof invariant: at most one ACTIVE assignment per (operator, platform). Two
-- concurrent grants both pass any application-level "does one exist?" check; the second INSERT
-- blocks on this index and fails with 23505 (unique_violation) once the first commits.
-- It is also the lookup index for the live platform-access check.
CREATE UNIQUE INDEX platform_assignment_one_active
  ON platform_assignment ("operatorId", "platformId") WHERE active;
CREATE INDEX platform_assignment_platform_idx ON platform_assignment ("platformId");
CREATE INDEX platform_assignment_operator_history_idx ON platform_assignment ("operatorId", "assignedAt");

-- Append-only: rows are never deleted, and the only permitted UPDATE is the one-way revocation
-- (active true → false, setting revokedAt/revokedBy). Everything else is frozen.
CREATE FUNCTION platform_assignment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform_assignment is append-only: rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF OLD.active IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_assignment % is already revoked and cannot be modified', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."operatorId", NEW."platformId", NEW."companyId", NEW."assignedBy", NEW."assignedAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."operatorId", OLD."platformId", OLD."companyId", OLD."assignedBy", OLD."assignedAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'platform_assignment grant fields are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_assignment_append_only
  BEFORE UPDATE OR DELETE ON platform_assignment
  FOR EACH ROW EXECUTE FUNCTION platform_assignment_append_only();

-- ---------------------------------------------------------------------------------------------
-- Authentication / session security entities
-- ---------------------------------------------------------------------------------------------

CREATE TABLE refresh_token (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"            uuid NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  "tokenHash"         text NOT NULL UNIQUE,   -- the raw token is never stored (ADR-0002)
  "familyId"          uuid NOT NULL,
  "revokedAt"         timestamptz,
  "expiresAt"         timestamptz NOT NULL,
  "replacedByTokenId" uuid REFERENCES refresh_token (id) ON DELETE RESTRICT,
  "sessionExpiresAt"  timestamptz,            -- operator sessions only (ADR-0013/0014)
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_token_not_self_replaced CHECK ("replacedByTokenId" IS DISTINCT FROM id),
  -- A rotated-out token is always revoked, so a replaced token can never be replayed.
  CONSTRAINT refresh_token_replaced_is_revoked CHECK ("replacedByTokenId" IS NULL OR "revokedAt" IS NOT NULL)
);
-- The rotation chain is linear: a token has at most one successor.
CREATE UNIQUE INDEX refresh_token_single_successor ON refresh_token ("replacedByTokenId")
  WHERE "replacedByTokenId" IS NOT NULL;
CREATE INDEX refresh_token_user_idx ON refresh_token ("userId");
CREATE INDEX refresh_token_family_idx ON refresh_token ("familyId");

CREATE TABLE device (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "installId"    text NOT NULL UNIQUE,
  "ipAddress"    text NOT NULL,      -- server-observed, never client-supplied
  "userAgent"    text NOT NULL,      -- server-observed, never client-supplied
  "deviceModel"  text,
  "osVersion"    text,
  "appVersion"   text,
  locale         text,
  "userId"       uuid REFERENCES "user" (id) ON DELETE RESTRICT,   -- unlinked until register/login
  "firstSeenAt"  timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_user_idx ON device ("userId");

-- Distinct from device (ADR-0010): owner secret-key-login alerting. The fingerprint is a
-- normalized-User-Agent hash — a security SIGNAL, not proof of physical device identity.
CREATE TABLE admin_device (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"          uuid NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  "fingerprintHash" text NOT NULL,
  "ipAddress"       text NOT NULL,   -- last-seen, informational only
  "firstSeenAt"     timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_device_user_fingerprint_uk UNIQUE ("userId", "fingerprintHash")
);

CREATE TYPE operator_code_purpose AS ENUM ('confirmation', 'login');

CREATE TABLE admin_operator_code (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"        uuid NOT NULL REFERENCES operator ("userId") ON DELETE RESTRICT,
  purpose         operator_code_purpose NOT NULL,
  "codeHash"      text NOT NULL,      -- sha256 of the 6-digit code; the raw code is never stored
  "expiresAt"     timestamptz NOT NULL,
  "attemptCount"  smallint NOT NULL DEFAULT 0 CHECK ("attemptCount" BETWEEN 0 AND 5),
  "consumedAt"    timestamptz,
  -- Set when a newer code for the same (operator, purpose) is issued. Replaces the old
  -- physical DELETE so issuance history stays auditable; distinct from consumedAt, which
  -- still means exclusively "this code was actually verified".
  "supersededAt"  timestamptz,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aoc_consumed_xor_superseded CHECK ("consumedAt" IS NULL OR "supersededAt" IS NULL)
);
-- Only the latest issued code per (operator, purpose) can be live: the issuing transaction must
-- supersede the previous one first, and the database rejects any second live row.
CREATE UNIQUE INDEX admin_operator_code_one_live ON admin_operator_code ("userId", purpose)
  WHERE "consumedAt" IS NULL AND "supersededAt" IS NULL;

CREATE TABLE operator_schedule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    uuid NOT NULL REFERENCES operator ("userId") ON DELETE RESTRICT,
  "dayOfWeek" smallint NOT NULL CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  "startTime" varchar(5) NOT NULL CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "endTime"   varchar(5) NOT NULL CHECK ("endTime"   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_schedule_user_day_uk UNIQUE ("userId", "dayOfWeek"),
  CONSTRAINT operator_schedule_no_overnight CHECK ("endTime" > "startTime")  -- ADR-0012: no wrap-past-midnight
);

CREATE TABLE operator_time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"    uuid NOT NULL REFERENCES operator ("userId") ON DELETE RESTRICT,
  date        date NOT NULL,
  label       text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_time_off_user_date_uk UNIQUE ("userId", date)
);

-- Owned by auth-service (see SDD "Ownership of PlatformNonWorkingDay"): platform-level reference
-- data. Not consulted by any auth-service login/session check (ADR-0023).
CREATE TABLE platform_non_working_day (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId" uuid NOT NULL REFERENCES platform (id) ON DELETE RESTRICT,
  type        text NOT NULL CHECK (type IN ('holiday', 'weekly_weekend')),
  date        date,
  "dayOfWeek" smallint CHECK ("dayOfWeek" BETWEEN 0 AND 6),
  label       text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pnwd_shape CHECK (
    (type = 'holiday'        AND date IS NOT NULL AND "dayOfWeek" IS NULL) OR
    (type = 'weekly_weekend' AND date IS NULL     AND "dayOfWeek" IS NOT NULL))
);
CREATE INDEX pnwd_platform_idx ON platform_non_working_day ("platformId");

COMMIT;
