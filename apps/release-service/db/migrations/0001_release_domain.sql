-- release-service 0001: the Release Management domain (ADR-0051, Stage 20.2).
--
-- product ─1:N─ component ─1:N─ release
--                         └─1:N─ compatibility_policy (append-only, versioned)
--
-- Release Management is metadata and compatibility, never delivery: no deployment, environment, artifact, channel or tenant
-- column exists. Product is a release-registry key, unrelated to Billing's commercial product and to Core's tenant Platform.
-- Invariants are enforced HERE, in two layers (the audit-service convention): privileges taken back from every non-owner role, and
-- triggers that refuse the operation whoever runs it.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── shared definitions

-- SemVer 2.0 core with an optional pre-release; NO build metadata (native build identities live in release."buildId", ADR-0051 §4).
-- Numeric identifiers without leading zeros, at most 15 digits (a safe integer, as the service's comparison library requires).
CREATE FUNCTION release_semver_valid(v text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT length(v) <= 128
     AND v ~ '^(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})(-(0|[1-9][0-9]{0,14}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]{0,14}|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
$$;

-- A key of the registry (product, component): lowercase, stable, product-independent.
CREATE FUNCTION release_key_valid(k text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT k ~ '^[a-z][a-z0-9-]{0,62}$'
$$;

-- Refuses the operation, whoever runs it (layer 2). TG_ARGV[0] names the rule for the message.
CREATE FUNCTION release_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % refused: %', TG_OP, TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '42501';
END $$;

-- Layer 1: the Core provisioning gives every runtime role SELECT, INSERT, UPDATE, DELETE on each new table (DEFAULT PRIVILEGES). Takes
-- the listed privileges back from EVERY role other than the owner (the runtime role's name differs per deployment and per test).
CREATE FUNCTION release_revoke(t regclass, privileges text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  EXECUTE format('REVOKE %s ON %s FROM PUBLIC', privileges, t);
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = t AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE %s ON %s FROM %s', privileges, t, r.role);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION release_revoke(regclass, text) FROM PUBLIC;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── product

-- A release-registry key that groups components and scopes future release authority (per-product CI policies, ADR-0051 §8).
CREATE TABLE product (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_key_valid CHECK (release_key_valid(key)),
  CONSTRAINT product_key_unique UNIQUE (key)
);
CREATE TRIGGER product_immutable BEFORE UPDATE OR DELETE ON product FOR EACH ROW EXECUTE FUNCTION release_refuse('a product is immutable and never deleted');
CREATE TRIGGER product_no_truncate BEFORE TRUNCATE ON product FOR EACH STATEMENT EXECUTE FUNCTION release_refuse('a product is never deleted');
SELECT release_revoke('product', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');

-- ─────────────────────────────────────────────────────────────────────────────────────────────── component

-- The independently versioned unit a client checks. Its kind is fixed forever (ADR-0051 §3). Desktop is technology-neutral: a
-- technology such as Tauri is not a kind. `ai` is reserved by ADR-0051 and is added by a later migration only when needed.
CREATE TABLE component (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  key         text NOT NULL,
  kind        text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT component_key_valid CHECK (release_key_valid(key)),
  CONSTRAINT component_kind_valid CHECK (kind IN ('backend', 'web', 'desktop', 'mobile_ios', 'mobile_android')),
  CONSTRAINT component_product_key_unique UNIQUE ("productId", key)
);
CREATE TRIGGER component_immutable BEFORE UPDATE OR DELETE ON component FOR EACH ROW EXECUTE FUNCTION release_refuse('a component (and its kind) is immutable and never deleted');
CREATE TRIGGER component_no_truncate BEFORE TRUNCATE ON component FOR EACH STATEMENT EXECUTE FUNCTION release_refuse('a component is never deleted');
SELECT release_revoke('component', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');

-- ─────────────────────────────────────────────────────────────────────────────────────────────── release

-- The immutable declaration that version V of a component exists (ADR-0051 §3). Only its lifecycle moves:
--   registered → published → withdrawn   (no other transition; no reverse; no resurrection; never deleted)
-- The comparable parts of the version are DERIVED by the database from the canonical text, so they can never disagree with it.
CREATE TABLE release (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "componentId"    uuid NOT NULL REFERENCES component (id) ON DELETE RESTRICT,
  version          text NOT NULL,
  major            bigint GENERATED ALWAYS AS ((substring(version from '^([0-9]+)\.'))::bigint) STORED,
  minor            bigint GENERATED ALWAYS AS ((substring(version from '^[0-9]+\.([0-9]+)\.'))::bigint) STORED,
  patch            bigint GENERATED ALWAYS AS ((substring(version from '^[0-9]+\.[0-9]+\.([0-9]+)'))::bigint) STORED,
  prerelease       text GENERATED ALWAYS AS (substring(version from '^[0-9]+\.[0-9]+\.[0-9]+-(.+)$')) STORED,
  -- Native identities, stored and never compared (iOS build number, Android versionCode, a build number, …) and the source revision.
  "buildId"        text,
  "sourceRevision" text,
  "notesRef"       text,
  status           text NOT NULL DEFAULT 'registered',
  "registeredAt"   timestamptz NOT NULL DEFAULT now(),
  "publishedAt"    timestamptz,
  "withdrawnAt"    timestamptz,
  CONSTRAINT release_version_semver CHECK (release_semver_valid(version)),
  CONSTRAINT release_build_id_shape CHECK ("buildId" IS NULL OR "buildId" ~ '^[!-~]{1,128}$'),
  CONSTRAINT release_source_revision_shape CHECK ("sourceRevision" IS NULL OR "sourceRevision" ~ '^[0-9a-f]{7,64}$'),
  CONSTRAINT release_notes_ref_shape CHECK ("notesRef" IS NULL OR "notesRef" ~ '^[!-~]{1,512}$'),
  CONSTRAINT release_status_valid CHECK (status IN ('registered', 'published', 'withdrawn')),
  -- The timestamps are exactly those of the steps taken: withdrawn implies published (only a published release can be withdrawn).
  CONSTRAINT release_status_timestamps CHECK (
    (status = 'registered' AND "publishedAt" IS NULL AND "withdrawnAt" IS NULL) OR
    (status = 'published'  AND "publishedAt" IS NOT NULL AND "withdrawnAt" IS NULL) OR
    (status = 'withdrawn'  AND "publishedAt" IS NOT NULL AND "withdrawnAt" IS NOT NULL AND "withdrawnAt" >= "publishedAt")),
  CONSTRAINT release_published_after_registered CHECK ("publishedAt" IS NULL OR "publishedAt" >= "registeredAt"),
  CONSTRAINT release_component_version_unique UNIQUE ("componentId", version)
);

-- A release is always born `registered` (a lifecycle step is an UPDATE, so each step is its own fact).
CREATE FUNCTION release_born_registered() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'registered' OR NEW."publishedAt" IS NOT NULL OR NEW."withdrawnAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a release is registered first (status %)', NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_born_registered BEFORE INSERT ON release FOR EACH ROW EXECUTE FUNCTION release_born_registered();

-- The identity never changes (the kit's generic trigger), whatever the status.
CREATE TRIGGER release_identity_immutable BEFORE UPDATE ON release FOR EACH ROW
  EXECUTE FUNCTION forbid_column_change('id', 'componentId', 'version', 'buildId', 'sourceRevision', 'notesRef', 'registeredAt');

-- The only moves: registered → published, published → withdrawn. A recorded step's timestamp never changes afterwards.
CREATE FUNCTION release_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT ((OLD.status = 'registered' AND NEW.status = 'published') OR (OLD.status = 'published' AND NEW.status = 'withdrawn')) THEN
    RAISE EXCEPTION 'release lifecycle: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'release.publishedAt is immutable once recorded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_lifecycle BEFORE UPDATE ON release FOR EACH ROW EXECUTE FUNCTION release_lifecycle();
CREATE TRIGGER release_no_delete BEFORE DELETE ON release FOR EACH ROW EXECUTE FUNCTION release_refuse('a release is never deleted (withdraw it)');
CREATE TRIGGER release_no_truncate BEFORE TRUNCATE ON release FOR EACH STATEMENT EXECUTE FUNCTION release_refuse('a release is never deleted');
SELECT release_revoke('release', 'DELETE, TRUNCATE, REFERENCES, TRIGGER');

-- "Latest" (ADR-0051 §4): the highest published, not-withdrawn release without a pre-release tag, by SemVer precedence. Among such
-- releases precedence is exactly (major, minor, patch): no pre-release, and build metadata is not allowed.
CREATE INDEX release_latest_idx ON release ("componentId", major DESC, minor DESC, patch DESC)
  WHERE status = 'published' AND prerelease IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── compatibility policy

-- The minimum supported version of a CLIENT component (web, desktop, mobile; never a backend), append-only and versioned: every change
-- is a new row with the next policyVersion (1, 2, 3, … per component). Two concurrent changes cannot both win: the second collides on
-- the unique (componentId, policyVersion), which is the optimistic-concurrency foundation of Stage 20.4. The minimum is a stable
-- version (no pre-release).
CREATE TABLE compatibility_policy (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "componentId"     uuid NOT NULL REFERENCES component (id) ON DELETE RESTRICT,
  "policyVersion"   integer NOT NULL,
  "minimumVersion"  text NOT NULL,
  "minimumMajor"    bigint GENERATED ALWAYS AS ((substring("minimumVersion" from '^([0-9]+)\.'))::bigint) STORED,
  "minimumMinor"    bigint GENERATED ALWAYS AS ((substring("minimumVersion" from '^[0-9]+\.([0-9]+)\.'))::bigint) STORED,
  "minimumPatch"    bigint GENERATED ALWAYS AS ((substring("minimumVersion" from '^[0-9]+\.[0-9]+\.([0-9]+)'))::bigint) STORED,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compatibility_policy_version_positive CHECK ("policyVersion" >= 1),
  CONSTRAINT compatibility_policy_minimum_stable CHECK (release_semver_valid("minimumVersion") AND position('-' in "minimumVersion") = 0),
  CONSTRAINT compatibility_policy_component_version_unique UNIQUE ("componentId", "policyVersion")
);

-- The invariant minimum ≤ latest (ADR-0051 §3), from both directions. Both paths first take a transaction-scoped advisory lock keyed by
-- the component, so a policy change and a withdrawal of the same component are serialized (no write skew): the second waits for the
-- first's commit or rollback, and its checks (later statements, READ COMMITTED) then see it. An advisory lock needs no table privilege
-- (a row lock would need UPDATE on `component`, which the runtime role does not have), and every path that can break the invariant
-- takes it, inside these triggers. Namespace 20020 (Stage 20.2) keeps the keys apart from any other advisory lock.
CREATE FUNCTION release_lock_component(c uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(20020, hashtext(c::text))
$$;

-- Is (major, minor, patch) at or below the latest release of the component? False when no latest release exists.
CREATE FUNCTION release_at_or_below_latest(c uuid, ma bigint, mi bigint, pa bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM release r
    WHERE r."componentId" = c AND r.status = 'published' AND r.prerelease IS NULL
      AND (r.major, r.minor, r.patch) >= (ma, mi, pa))
$$;

CREATE FUNCTION compatibility_policy_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text; expected integer;
BEGIN
  -- BEFORE triggers run ahead of CHECK constraints: a malformed minimum is left to `compatibility_policy_minimum_stable`, so it is
  -- refused for what it is (a shape error), never misreported as a minimum above the latest release.
  IF NOT (release_semver_valid(NEW."minimumVersion") AND position('-' in NEW."minimumVersion") = 0) THEN
    RETURN NEW;
  END IF;
  PERFORM release_lock_component(NEW."componentId");
  SELECT kind INTO k FROM component WHERE id = NEW."componentId";
  IF k = 'backend' THEN
    RAISE EXCEPTION 'a backend component has no compatibility policy (traceability only)' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max("policyVersion"), 0) + 1 INTO expected FROM compatibility_policy WHERE "componentId" = NEW."componentId";
  IF NEW."policyVersion" <> expected THEN
    -- A stale expectation (someone changed the policy meanwhile): the Stage 20.4 optimistic-concurrency conflict.
    RAISE EXCEPTION 'compatibility policy version % is not the next (%)', NEW."policyVersion", expected USING ERRCODE = '40001';
  END IF;
  -- Generated columns are computed AFTER the BEFORE triggers (NEW."minimumMajor" is still NULL here): derive the parts from the text.
  IF NOT release_at_or_below_latest(NEW."componentId",
       (substring(NEW."minimumVersion" from '^([0-9]+)\.'))::bigint,
       (substring(NEW."minimumVersion" from '^[0-9]+\.([0-9]+)\.'))::bigint,
       (substring(NEW."minimumVersion" from '^[0-9]+\.[0-9]+\.([0-9]+)'))::bigint) THEN
    RAISE EXCEPTION 'the minimum version must not exceed the latest published release' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER compatibility_policy_append BEFORE INSERT ON compatibility_policy FOR EACH ROW EXECUTE FUNCTION compatibility_policy_append();
CREATE TRIGGER compatibility_policy_append_only BEFORE UPDATE OR DELETE ON compatibility_policy FOR EACH ROW
  EXECUTE FUNCTION release_refuse('a compatibility policy is append-only');
CREATE TRIGGER compatibility_policy_no_truncate BEFORE TRUNCATE ON compatibility_policy FOR EACH STATEMENT
  EXECUTE FUNCTION release_refuse('a compatibility policy is append-only');
SELECT release_revoke('compatibility_policy', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');

-- The withdrawal side: withdrawing must never leave the current minimum above the (new) latest release, or every client would be
-- required to update with nothing to update to. The withdrawal is refused; the minimum is lowered first (ADR-0051 §3).
CREATE FUNCTION release_withdrawal_keeps_minimum() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn' THEN
    PERFORM release_lock_component(NEW."componentId");
    SELECT "minimumMajor", "minimumMinor", "minimumPatch" INTO p FROM compatibility_policy
      WHERE "componentId" = NEW."componentId" ORDER BY "policyVersion" DESC LIMIT 1;
    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM release r
      WHERE r."componentId" = NEW."componentId" AND r.id <> NEW.id AND r.status = 'published' AND r.prerelease IS NULL
        AND (r.major, r.minor, r.patch) >= (p."minimumMajor", p."minimumMinor", p."minimumPatch")) THEN
      RAISE EXCEPTION 'withdrawing this release would leave the minimum version above the latest published release' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_withdrawal_keeps_minimum BEFORE UPDATE ON release FOR EACH ROW EXECUTE FUNCTION release_withdrawal_keeps_minimum();

-- The current policy of a component: the unique (componentId, policyVersion) index, read newest first.
