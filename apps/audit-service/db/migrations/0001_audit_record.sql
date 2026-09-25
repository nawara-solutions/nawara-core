-- Stage 18.3: the append-only audit record (ADR-0049; Stage 18.1 A1, A9–A15, A22–A33, A37; SDD §4–§5). Evidence only: identifiers,
-- never a name, contact detail, address, token, raw payload or domain snapshot. No foreign key leaves this database (ADR-0032): every
-- identifier is opaque here. The catalog (which actions exist, their producer, category, resource type and change keys) is a code
-- contract (Stage 18.4), not a table: this schema enforces STRUCTURE, the catalog enforces MEANING.

-- ─────────────────────────────────────────────────────────────────────────────────────────── bounded change facts (A27, A28)

-- A scalar change value: a string of 1–64 safe characters (codes, enum-like values, ISO dates, UUIDs), an INTEGER within the exact
-- range of an IEEE double (no fractions, no exponent surprises for consumers), a boolean, or JSON null. Never an object or array.
CREATE FUNCTION audit_change_scalar_valid(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'string' THEN (v #>> '{}') ~ '^[A-Za-z0-9._:+-]{1,64}$'
    WHEN 'number' THEN (v::text)::numeric = trunc((v::text)::numeric) AND abs((v::text)::numeric) <= 9007199254740991
    WHEN 'boolean' THEN true
    WHEN 'null' THEN true
    ELSE false
  END
$$;

-- `changes`: an object of at most 8 keys, each key a lower-snake identifier, each value a scalar or exactly `{ "from": scalar, "to":
-- scalar }`; at most 1 024 bytes as PostgreSQL's canonical jsonb text (the counted representation: `changes::text`, UTF-8 bytes).
CREATE FUNCTION audit_changes_valid(c jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(c) = 'object'
    AND octet_length(c::text) <= 1024
    AND (SELECT count(*) FROM jsonb_object_keys(c)) BETWEEN 1 AND 8
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(c) AS e(k, v)
      WHERE NOT (
        e.k ~ '^[a-z][a-z0-9_]{0,31}$'
        AND (
          audit_change_scalar_valid(e.v)
          OR (
            jsonb_typeof(e.v) = 'object'
            AND (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(e.v) AS x) = ARRAY['from', 'to']
            AND audit_change_scalar_valid(e.v -> 'from')
            AND audit_change_scalar_valid(e.v -> 'to')
          )
        )
      )
    )
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────── audit_record

CREATE TABLE audit_record (
  -- Internal, server-generated, never exposed as identity (the external identity is (sourceService, eventId)); the stable tie-breaker
  -- of the (occurredAt, id) keyset order (A36).
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The producer's outbox row id (A15): unique per producing service.
  "eventId"         uuid NOT NULL,
  -- The emitting service (the envelope `source`, authenticated per A20 once P-A1 exists): the kit's caller grammar.
  "sourceService"   text NOT NULL,
  -- `<resource_type>.<past_tense_verb>` in the kit event-name grammar (A13); cataloged in 18.4.
  action            text NOT NULL,
  -- Derived from the catalog (A52), never producer-chosen.
  category          text NOT NULL,
  -- The audit payload version (the kit envelope `version`, A50); rows are never rewritten.
  "schemaVersion"   integer NOT NULL,
  -- Who caused it (A9): user | service | system; actorId always present, in the grammar of its type; userKind for users only.
  "actorType"       text NOT NULL,
  "actorId"         text NOT NULL,
  "userKind"        text,
  -- Resource-derived by the producer (A11); NULL = an explicitly platform-level record, never "all organizations".
  "organizationId"  uuid,
  -- What was acted on (A12), and at most one affected party.
  "resourceType"    text NOT NULL,
  "resourceId"      text NOT NULL,
  "subjectType"     text,
  "subjectId"       text,
  outcome           text NOT NULL,
  -- Catalog-bounded change facts (A27, A28); NULL when the action carries none.
  changes           jsonb,
  -- Navigation only (A33): may originate from a client-chosen header; never evidence, never authorization, never deduplication.
  "correlationId"   text,
  -- The eventId of the event that caused this action (a consumer-driven step), when there is one.
  "causationId"     uuid,
  -- When the producer says it happened (its database clock at the business transaction). May be later than recordedAt (A22: stored
  -- as sent, observed by 18.5) and far earlier (an outage backlog, a replay).
  "occurredAt"      timestamptz NOT NULL,
  -- When Audit stored it: Audit's database clock, set by the trigger below whatever an INSERT supplies.
  "recordedAt"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_record_source_event_unique UNIQUE ("sourceService", "eventId"),
  CONSTRAINT audit_record_source_shape CHECK ("sourceService" ~ '^[a-z][a-z0-9-]{1,62}$'),
  CONSTRAINT audit_record_action_shape CHECK (length(action) <= 100 AND action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT audit_record_category_valid CHECK (category IN ('security', 'business', 'commercial', 'administrative')),
  CONSTRAINT audit_record_schema_version_bounded CHECK ("schemaVersion" BETWEEN 1 AND 1000),
  CONSTRAINT audit_record_actor_type_valid CHECK ("actorType" IN ('user', 'service', 'system')),
  -- A user actor is an Auth user id (UUID, lowercase) with its kind as it was when acting; a service actor is a service name; a system
  -- actor is a cataloged process code. No kind outside `user`. (Every nullable term is tested with IS NOT NULL explicitly: a CHECK whose
  -- expression is NULL passes.)
  CONSTRAINT audit_record_actor_consistent CHECK (
    ("actorType" = 'user' AND "actorId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND "userKind" IS NOT NULL AND "userKind" IN ('member', 'owner', 'operator'))
    OR ("actorType" = 'service' AND "actorId" ~ '^[a-z][a-z0-9-]{1,62}$' AND "userKind" IS NULL)
    OR ("actorType" = 'system' AND "actorId" ~ '^[a-z][a-z0-9_]{0,63}$' AND "userKind" IS NULL)
  ),
  CONSTRAINT audit_record_resource_shape CHECK ("resourceType" ~ '^[a-z][a-z0-9_]{0,63}$' AND "resourceId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- At most one subject, complete or absent.
  CONSTRAINT audit_record_subject_shape CHECK (
    ("subjectType" IS NULL AND "subjectId" IS NULL)
    OR ("subjectType" IS NOT NULL AND "subjectId" IS NOT NULL AND "subjectType" ~ '^[a-z][a-z0-9_]{0,63}$' AND "subjectId" ~ '^[A-Za-z0-9._:-]{1,128}$')
  ),
  CONSTRAINT audit_record_outcome_valid CHECK (outcome IN ('succeeded', 'denied')),
  CONSTRAINT audit_record_changes_valid CHECK (changes IS NULL OR audit_changes_valid(changes)),
  -- The kit's request-context grammar (8–128 safe characters).
  CONSTRAINT audit_record_correlation_shape CHECK ("correlationId" IS NULL OR "correlationId" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  -- An event cannot be its own cause.
  CONSTRAINT audit_record_causation_not_self CHECK ("causationId" IS DISTINCT FROM "eventId"),
  -- A real instant: PostgreSQL also accepts 'infinity' / '-infinity' as timestamps.
  CONSTRAINT audit_record_occurred_finite CHECK (isfinite("occurredAt"))
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the database clock (A22)

-- recordedAt is Audit's, never the caller's: whatever an INSERT supplies is replaced by the transaction timestamp (now(): every row of
-- one ingestion transaction shares it; it is the time the storing transaction began, not the commit time).
CREATE FUNCTION audit_record_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER audit_record_stamp BEFORE INSERT ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_record_stamp();

-- ─────────────────────────────────────────────────────────────────────────────────── append-only (A23, A45: defense in depth)

-- Layer 2 (layer 1 is the grant below): any UPDATE, DELETE or TRUNCATE is refused, whoever runs it, while the triggers are enabled.
-- Only the table owner (the migrator) or a superuser can disable or drop them: the guarantee is against the application runtime, not
-- against a database administrator. Stage 18.8 (retention) will admit its maintenance role here, in a migration, for rows past their
-- category's horizon only.
CREATE FUNCTION audit_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_record is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_record_no_update_delete BEFORE UPDATE OR DELETE ON audit_record FOR EACH ROW EXECUTE FUNCTION audit_record_append_only();
CREATE TRIGGER audit_record_no_truncate BEFORE TRUNCATE ON audit_record FOR EACH STATEMENT EXECUTE FUNCTION audit_record_append_only();

-- Layer 1: privileges. The Core provisioning (infra/postgres/init) gives every runtime role SELECT, INSERT, UPDATE, DELETE on each new
-- table through the migrator's DEFAULT PRIVILEGES. An append-only table must take the mutating ones back from EVERY role other than
-- its owner, whatever that role is called (audit_app in deployments, generated names in tests). This helper does exactly that and is
-- the convention for every append-only table a later Audit migration creates: `SELECT audit_restrict_to_append_only('<table>');`.
CREATE FUNCTION audit_restrict_to_append_only(t regclass) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM PUBLIC', t);
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
    FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.oid = t AND a.grantee <> c.relowner AND a.grantee <> 0
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM %s', t, r.role);
  END LOOP;
END $$;
-- Migrations only: the runtime has no reason to call it (it could only revoke, and a non-owner's REVOKE is a no-op, but it is not its tool).
REVOKE EXECUTE ON FUNCTION audit_restrict_to_append_only(regclass) FROM PUBLIC;
SELECT audit_restrict_to_append_only('audit_record');

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────── indexes (A37)

-- (sourceService, eventId): the UNIQUE constraint above (idempotent ingestion, A15 / A48).
-- Organization-scope reads (A38): one organization, newest first; also `organizationId IS NULL` (platform-level) for platform scope.
CREATE INDEX audit_record_org_time_idx ON audit_record ("organizationId", "occurredAt" DESC, id DESC);
-- Actor investigations ("what did this user / service do").
CREATE INDEX audit_record_actor_time_idx ON audit_record ("actorType", "actorId", "occurredAt" DESC, id DESC);
-- Resource history ("what happened to this membership / file").
CREATE INDEX audit_record_resource_time_idx ON audit_record ("resourceType", "resourceId", "occurredAt" DESC, id DESC);
-- Subject history ("what happened to this user's authority"); only rows that have a subject.
CREATE INDEX audit_record_subject_time_idx ON audit_record ("subjectType", "subjectId", "occurredAt" DESC, id DESC) WHERE "subjectId" IS NOT NULL;
-- From a technical log line to its evidence (A33); only rows that carry one.
CREATE INDEX audit_record_correlation_idx ON audit_record ("correlationId") WHERE "correlationId" IS NOT NULL;
-- Retention by storage time (A41, Stage 18.8) and the ingestion-lag view (18.9).
CREATE INDEX audit_record_recorded_idx ON audit_record ("recordedAt");
