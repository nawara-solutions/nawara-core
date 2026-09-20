-- Database-level invariant tests for organization-service's migrations. Run via db/tests/run.sh on a fresh scratch database.
-- Proves what the DATABASE refuses regardless of application code: the Company -> Platform -> Organization hierarchy, its
-- immutability, and that the schema can represent records that already have ids and timestamps (a later import).
-- Each assertion targets ONE rule.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE TEMP TABLE results (id text, name text, ok boolean, detail text);

-- expect_error: the statement must fail with exactly this SQLSTATE (and, when given, this constraint). Runs in a subtransaction that is
-- ALWAYS rolled back (also when it unexpectedly succeeds), so a broken invariant shows up as one FAIL row, not corrupted state.
CREATE FUNCTION pg_temp.expect_error(tid text, tname text, stmt text, want text, want_constraint text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE cn text;
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'statement unexpectedly succeeded' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF SQLSTATE = 'XX999' THEN
      INSERT INTO results VALUES (tid, tname, false, 'expected SQLSTATE '||want||' but the statement succeeded');
    ELSIF SQLSTATE <> want THEN
      INSERT INTO results VALUES (tid, tname, false, 'wanted '||want||' got '||SQLSTATE||': '||SQLERRM);
    ELSIF want_constraint IS NOT NULL AND cn IS DISTINCT FROM want_constraint THEN
      INSERT INTO results VALUES (tid, tname, false, 'wanted constraint '||want_constraint||' got '||coalesce(cn, 'none')||': '||SQLERRM);
    ELSE
      INSERT INTO results VALUES (tid, tname, true, NULL);
    END IF;
  END;
END $$;

CREATE FUNCTION pg_temp.expect_ok(tid text, tname text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (tid, tname, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (tid, tname, false, SQLSTATE||': '||SQLERRM);
  END;
END $$;

CREATE FUNCTION pg_temp.assert_eq(tid text, tname text, got text, want text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO results VALUES (tid, tname, got IS NOT DISTINCT FROM want,
    CASE WHEN got IS NOT DISTINCT FROM want THEN NULL ELSE 'wanted '||coalesce(want,'NULL')||' got '||coalesce(got,'NULL') END);
$$;

-- fixtures (fixed ids, so every assertion below can name them)
INSERT INTO company      (id, name)                    VALUES ('c0000000-0000-4000-8000-000000000001', 'Co One'), ('c0000000-0000-4000-8000-000000000002', 'Co Two');
INSERT INTO platform     (id, "companyId", name)       VALUES ('a0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'Pl One'),
                                                              ('a0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001', 'Pl Two');
INSERT INTO organization (id, "platformId", name)      VALUES ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Org One');

-- ---- OH-01 .. : the hierarchy -----------------------------------------------------------------------------------------------------
SELECT pg_temp.expect_error('OH-01', 'platform needs an existing company', $$INSERT INTO platform ("companyId", name) VALUES ('deadbeef-0000-4000-8000-000000000000', 'x')$$, '23503', 'platform_company_fk');
SELECT pg_temp.expect_error('OH-02', 'organization needs an existing platform', $$INSERT INTO organization ("platformId", name) VALUES ('deadbeef-0000-4000-8000-000000000000', 'x')$$, '23503', 'organization_platform_fk');
SELECT pg_temp.expect_error('OH-03', 'an organization cannot hang off a company id (no Organization -> Company shortcut)', $$INSERT INTO organization ("platformId", name) VALUES ('c0000000-0000-4000-8000-000000000001', 'x')$$, '23503', 'organization_platform_fk');
SELECT pg_temp.expect_error('OH-04', 'platform.companyId is NOT NULL', $$INSERT INTO platform ("companyId", name) VALUES (NULL, 'x')$$, '23502');
SELECT pg_temp.expect_error('OH-05', 'organization.platformId is NOT NULL', $$INSERT INTO organization ("platformId", name) VALUES (NULL, 'x')$$, '23502');
SELECT pg_temp.expect_error('OH-06', 'a company with platforms cannot be deleted (RESTRICT)', $$DELETE FROM company WHERE id = 'c0000000-0000-4000-8000-000000000001'$$, '23503', 'platform_company_fk');
SELECT pg_temp.expect_error('OH-07', 'a platform with organizations cannot be deleted (RESTRICT)', $$DELETE FROM platform WHERE id = 'a0000000-0000-4000-8000-000000000001'$$, '23503', 'organization_platform_fk');
SELECT pg_temp.expect_ok   ('OH-08', 'a childless platform and company can be removed by the schema owner (no cascade, no soft-delete semantics invented)', $$DELETE FROM platform WHERE id = 'a0000000-0000-4000-8000-000000000002'$$);
SELECT pg_temp.assert_eq   ('OH-09', 'the organization table has no companyId column',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'organization' AND column_name = 'companyId'), '0');
SELECT pg_temp.assert_eq   ('OH-10', 'the company of an organization is reachable only through its platform',
  (SELECT p."companyId"::text FROM organization o JOIN platform p ON p.id = o."platformId" WHERE o.id = 'b0000000-0000-4000-8000-000000000001'), 'c0000000-0000-4000-8000-000000000001');

-- ---- OI-01 .. : immutability (tenancy anchors never move) ------------------------------------------------------------------------------
SELECT pg_temp.expect_error('OI-01', 'a platform cannot move to another company', $$UPDATE platform SET "companyId" = 'c0000000-0000-4000-8000-000000000002' WHERE id = 'a0000000-0000-4000-8000-000000000001'$$, '23514');
SELECT pg_temp.expect_error('OI-02', 'an organization cannot move to another platform',
  $$UPDATE organization SET "platformId" = (SELECT id FROM platform WHERE id <> 'a0000000-0000-4000-8000-000000000001' LIMIT 1) WHERE id = 'b0000000-0000-4000-8000-000000000001'$$, '23514');
SELECT pg_temp.expect_error('OI-03', 'a company id is frozen', $$UPDATE company SET id = 'c0000000-0000-4000-8000-0000000000ff' WHERE id = 'c0000000-0000-4000-8000-000000000002'$$, '23514');
SELECT pg_temp.expect_error('OI-04', 'a platform id is frozen', $$UPDATE platform SET id = 'a0000000-0000-4000-8000-0000000000ff' WHERE id = 'a0000000-0000-4000-8000-000000000001'$$, '23514');
SELECT pg_temp.expect_error('OI-05', 'an organization id is frozen', $$UPDATE organization SET id = 'b0000000-0000-4000-8000-0000000000ff' WHERE id = 'b0000000-0000-4000-8000-000000000001'$$, '23514');
SELECT pg_temp.expect_error('OI-06', 'createdAt is history and is frozen', $$UPDATE company SET "createdAt" = now() - interval '1 year' WHERE id = 'c0000000-0000-4000-8000-000000000001'$$, '23514');
SELECT pg_temp.expect_ok   ('OI-07', 'the mutable fields still update', $$UPDATE organization SET name = 'Renamed', "taxCode" = 't', address = 'a', phone = 'p', type = 'k', "updatedAt" = now() WHERE id = 'b0000000-0000-4000-8000-000000000001'$$);
SELECT pg_temp.expect_ok   ('OI-08', 'an update that leaves the anchors alone is accepted (the trigger compares values, not columns)', $$UPDATE platform SET name = 'Pl Renamed', "companyId" = "companyId" WHERE id = 'a0000000-0000-4000-8000-000000000001'$$);

-- ---- OV-01 .. : value rules (identical to auth-service's) --------------------------------------------------------------------------
SELECT pg_temp.expect_error('OV-01', 'company.name is NOT NULL', $$INSERT INTO company (name) VALUES (NULL)$$, '23502');
SELECT pg_temp.expect_error('OV-02', 'company.name cannot be blank', $$INSERT INTO company (name) VALUES ('   ')$$, '23514', 'company_name_not_blank');
SELECT pg_temp.expect_error('OV-03', 'platform.name cannot be blank', $$INSERT INTO platform ("companyId", name) VALUES ('c0000000-0000-4000-8000-000000000001', '')$$, '23514', 'platform_name_not_blank');
SELECT pg_temp.expect_error('OV-04', 'organization.name cannot be blank', $$INSERT INTO organization ("platformId", name) VALUES ('a0000000-0000-4000-8000-000000000001', ' ')$$, '23514', 'organization_name_not_blank');
SELECT pg_temp.expect_ok   ('OV-05', 'the optional organization fields may all be NULL, and type is opaque text', $$INSERT INTO organization ("platformId", name, type) VALUES ('a0000000-0000-4000-8000-000000000001', 'Bare', 'anything at all')$$);
SELECT pg_temp.expect_ok   ('OV-06', 'names are NOT unique: two companies may share one (no uniqueness rule is established, and one could reject valid imported rows)', $$INSERT INTO company (name) VALUES ('Co One')$$);
SELECT pg_temp.expect_error('OV-07', 'a duplicate id is refused', $$INSERT INTO company (id, name) VALUES ('c0000000-0000-4000-8000-000000000001', 'dup')$$, '23505');

-- ---- OK-01 .. : Platform.key, reproduced from auth-service migration 0004 -------------------------------------------------------------
SELECT pg_temp.assert_eq   ('OK-01', 'platform.key is nullable text with no default',
  (SELECT data_type||'|'||is_nullable||'|'||coalesce(column_default,'-') FROM information_schema.columns WHERE table_name = 'platform' AND column_name = 'key'), 'text|YES|-');
SELECT pg_temp.assert_eq   ('OK-02', 'the format check and unique constraint exist under Auth''s names and definitions',
  (SELECT string_agg(conname||' '||pg_get_constraintdef(oid), ' ; ' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'platform'::regclass AND conname LIKE 'platform_key%'),
  'platform_key_format CHECK (((key IS NULL) OR (key ~ ''^[a-z][a-z0-9-]{1,39}$''::text))) ; platform_key_uk UNIQUE (key)');
SELECT pg_temp.expect_ok   ('OK-03', 'valid keys: shortest, longest, documented example, trailing and doubled hyphen',
  $$INSERT INTO platform ("companyId", name, key) VALUES
    ('c0000000-0000-4000-8000-000000000001', 'k1', 'ab'), ('c0000000-0000-4000-8000-000000000001', 'k2', 'a' || repeat('b', 39)),
    ('c0000000-0000-4000-8000-000000000001', 'k3', 'nawara-drive'), ('c0000000-0000-4000-8000-000000000001', 'k4', 'ab-'), ('c0000000-0000-4000-8000-000000000001', 'k5', 'a--b')$$);
SELECT pg_temp.expect_error('OK-04', 'key rejected: too short', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', 'a')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-05', 'key rejected: empty', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', '')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-06', 'key rejected: too long (41)', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', 'a' || repeat('b', 40))$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-07', 'key rejected: upper case', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', 'Ab')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-08', 'key rejected: leading digit', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', '1ab')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-09', 'key rejected: leading hyphen', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', '-ab')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-10', 'key rejected: underscore', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', 'a_b')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-11', 'key rejected: trailing newline', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000001', 'x', E'ab\n')$$, '23514', 'platform_key_format');
SELECT pg_temp.expect_error('OK-12', 'a duplicate non-null key is refused, across companies', $$INSERT INTO platform ("companyId", name, key) VALUES ('c0000000-0000-4000-8000-000000000002', 'x', 'nawara-drive')$$, '23505', 'platform_key_uk');
SELECT pg_temp.expect_ok   ('OK-13', 'many platforms may have no key (NULLs are distinct)', $$INSERT INTO platform ("companyId", name) VALUES ('c0000000-0000-4000-8000-000000000001', 'n1'), ('c0000000-0000-4000-8000-000000000001', 'n2'), ('c0000000-0000-4000-8000-000000000001', 'n3')$$);
SELECT pg_temp.expect_ok   ('OK-14', 'key is NOT immutable: it can be changed and cleared (the platform trigger freezes only id, createdAt and companyId)', $$UPDATE platform SET key = 'renamed-key' WHERE name = 'k3'; UPDATE platform SET key = NULL WHERE name = 'k3'$$);

-- ---- OM-01 .. : representability of existing (imported) records ----------------------------------------------------------------------
SELECT pg_temp.expect_ok   ('OM-01', 'a row with an EXPLICIT id and ORIGINAL timestamps is accepted, parents first',
  $$INSERT INTO company (id, name, "createdAt", "updatedAt") VALUES ('f0000000-0000-4000-8000-000000000001', 'Imported', '2021-01-02 03:04:05.123456+00', '2022-02-03 04:05:06.654321+00');
    INSERT INTO platform (id, "companyId", name, "createdAt", "updatedAt") VALUES ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'Imported Pl', '2021-01-02 03:04:05.123456+00', '2022-02-03 04:05:06.654321+00');
    INSERT INTO organization (id, "platformId", name, "createdAt", "updatedAt") VALUES ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000002', 'Imported Org', '2021-01-02 03:04:05.123456+00', '2022-02-03 04:05:06.654321+00')$$);
SELECT pg_temp.assert_eq   ('OM-02', 'the id and both timestamps are stored exactly as supplied (microsecond precision)',
  (SELECT id::text||'|'||to_char("createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')||'|'||to_char("updatedAt" AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') FROM organization WHERE id = 'f0000000-0000-4000-8000-000000000003'),
  'f0000000-0000-4000-8000-000000000003|2021-01-02 03:04:05.123456|2022-02-03 04:05:06.654321');
SELECT pg_temp.expect_error('OM-03', 'an imported child is still refused if its parent was not imported first (the invariant holds for imports too)',
  $$INSERT INTO platform (id, "companyId", name) VALUES ('f0000000-0000-4000-8000-0000000000aa', 'f0000000-0000-4000-8000-0000000000bb', 'orphan')$$, '23503');
WITH gen AS (INSERT INTO company (name) VALUES ('Generated') RETURNING id)
SELECT pg_temp.assert_eq('OM-04', 'an omitted id is still generated', (SELECT (id IS NOT NULL)::text FROM gen), 'true');

-- ---- OS-01 .. : the schema holds nothing that belongs elsewhere ------------------------------------------------------------------------
SELECT pg_temp.assert_eq   ('OS-01', 'exactly the hierarchy, its idempotency keys, the ownership-transition tables and the admin actor record (ADR-0042 decision 9) are this service''s own tables (the rest belong to the kit)',
  (SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN ('inbox', 'outbox', 'kit_rate_limit', 'schema_migrations')),
  'admin_actor_event,company,hierarchy_id_ledger,idempotency_key,organization,ownership_event,ownership_import_run,ownership_state,platform');
-- ---- AA-01 .. : the durable admin actor record (migration 0005, ADR-0042 decision 9) is append-only and validated ----------------------------
SELECT pg_temp.expect_ok   ('AA-01', 'an actor event can be appended',
  $$INSERT INTO admin_actor_event (actor_user_id, actor_kind, operation, target_type, target_id, outcome) VALUES (gen_random_uuid(), 'owner', 'platform.create', 'platform', gen_random_uuid(), 'succeeded')$$);
SELECT pg_temp.expect_error('AA-02', 'an actor event can never be updated', $$UPDATE admin_actor_event SET outcome = 'failed'$$, '55000');
SELECT pg_temp.expect_error('AA-03', 'an actor event can never be deleted', $$DELETE FROM admin_actor_event$$, '55000');
SELECT pg_temp.expect_error('AA-04', 'an actor event can never be truncated', $$TRUNCATE admin_actor_event$$, '55000');
SELECT pg_temp.expect_error('AA-05', 'the actor kind is one of owner, operator, member', $$INSERT INTO admin_actor_event (actor_user_id, actor_kind, operation, target_type, outcome) VALUES (gen_random_uuid(), 'root', 'x', 'platform', 'succeeded')$$, '23514');
SELECT pg_temp.expect_error('AA-06', 'the outcome is one of succeeded, denied, failed', $$INSERT INTO admin_actor_event (actor_user_id, actor_kind, operation, target_type, outcome) VALUES (gen_random_uuid(), 'owner', 'x', 'platform', 'maybe')$$, '23514');
SELECT pg_temp.expect_error('AA-07', 'the target type is one of company, platform, organization', $$INSERT INTO admin_actor_event (actor_user_id, actor_kind, operation, target_type, outcome) VALUES (gen_random_uuid(), 'owner', 'x', 'user', 'succeeded')$$, '23514');
SELECT pg_temp.expect_error('AA-08', 'an operation name cannot be blank', $$INSERT INTO admin_actor_event (actor_user_id, actor_kind, operation, target_type, outcome) VALUES (gen_random_uuid(), 'owner', '  ', 'platform', 'succeeded')$$, '23514');
SELECT pg_temp.assert_eq   ('AA-09', 'the actor record holds no foreign key (database-per-service: the actor is Auth''s, the target is opaque)',
  (SELECT count(*)::text FROM pg_constraint WHERE contype = 'f' AND conrelid = 'admin_actor_event'::regclass), '0');
SELECT pg_temp.assert_eq   ('OS-02', 'every foreign key stays inside this database: only organization -> platform and platform -> company',
  (SELECT string_agg(conrelid::regclass::text||'->'||confrelid::regclass::text, ',' ORDER BY conrelid::regclass::text) FROM pg_constraint WHERE contype = 'f'),
  'organization->platform,platform->company');
SELECT pg_temp.expect_error('OS-03', 'an idempotency key must have the documented shape', $$INSERT INTO idempotency_key (caller, operation, key, "requestHash", "resourceId") VALUES ('svc', 'company.create', 'short', 'h', gen_random_uuid())$$, '23514');
SELECT pg_temp.expect_error('OS-04', 'an idempotency key is only for the three creates', $$INSERT INTO idempotency_key (caller, operation, key, "requestHash", "resourceId") VALUES ('svc', 'membership.create', 'long-enough-key', 'h', gen_random_uuid())$$, '23514');

\o
SELECT id, name, coalesce(detail, '') AS detail FROM results WHERE NOT ok ORDER BY id;
DO $$
DECLARE failed int; total int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT ok), count(*) INTO failed, total FROM results;
  IF failed > 0 THEN RAISE EXCEPTION '% of % invariant checks FAILED (listed above)', failed, total; END IF;
  RAISE NOTICE 'invariants: % / % passed', total, total;
END $$;
