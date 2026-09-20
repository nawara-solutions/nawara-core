-- Ownership transition (ADR-0040, Stage 10.1). FORWARD-ONLY and INERT: it adds state and guards, it moves NO authority and copies NO data.
--
--   ownership_state        the ONE row that records whether this service is authoritative. It starts PREPARED (not authoritative).
--   ownership_event        append-only audit of every transition attempt (who, what, when, from, to, snapshot digest).
--   ownership_import_run   append-only record of every snapshot import (digest, counts, outcome).
--   hierarchy_id_ledger    every hierarchy id ever assigned, so an id can never be reused (I1).
--
-- Phases (ADR-0040 has one authority switch, ACTIVATE AUTHORITY; the phases before it are preparation):
--   PREPARED -> VERIFIED -> FROZEN -> ACTIVATABLE -> ACTIVE -> RETIRED        (existing environment)
--   PREPARED -> VERIFIED ------------> ACTIVATABLE -> ACTIVE -> RETIRED       (fresh environment: nothing to freeze)
--   authoritative = phase IN (ACTIVE, RETIRED). A move back to PREPARED is allowed ONLY before activation. After ACTIVE there is
--   no backward transition at all: the one-way door (ownership rollback then needs reconciliation, which is not designed).
--
-- The runtime role gets SELECT on the ownership tables and NO write; only the migration/operations login changes state.
-- No runtime role may DELETE or TRUNCATE hierarchy rows (I2(b)); once authoritative NO role can (until a lifecycle ADR exists).

CREATE TABLE ownership_state (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),          -- exactly one row
  phase              text NOT NULL DEFAULT 'PREPARED'
                     CHECK (phase IN ('PREPARED','VERIFIED','FROZEN','ACTIVATABLE','ACTIVE','RETIRED')),
  environment_class  text CHECK (environment_class IN ('existing','fresh')),   -- declared once, never changed
  authoritative      boolean GENERATED ALWAYS AS (phase IN ('ACTIVE','RETIRED')) STORED,
  verified_digest    text,                                                   -- whole-artifact digest (existing) or content digest (fresh) verified
  approved_by        text,
  approved_reference text,                                                   -- the recorded rehearsal / approval reference (ADR-0040 gate G7)
  approved_at        timestamptz,
  activated_by       text,
  activated_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ownership_state DEFAULT VALUES;

CREATE FUNCTION ownership_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legal boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ownership_state is never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.environment_class IS NOT NULL AND NEW.environment_class IS DISTINCT FROM OLD.environment_class THEN
    RAISE EXCEPTION 'the environment class is declared once and never changes' USING ERRCODE = '55000';
  END IF;
  IF OLD.phase IN ('ACTIVE','RETIRED') AND NEW.phase = OLD.phase THEN
    RAISE EXCEPTION 'ownership_state is immutable once authoritative' USING ERRCODE = '55000';
  END IF;
  IF NEW.phase = OLD.phase THEN
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  legal := CASE
    WHEN OLD.phase = 'PREPARED'    AND NEW.phase = 'VERIFIED'    THEN true
    WHEN OLD.phase = 'VERIFIED'    AND NEW.phase = 'FROZEN'      AND NEW.environment_class = 'existing' THEN true
    WHEN OLD.phase = 'VERIFIED'    AND NEW.phase = 'ACTIVATABLE' AND NEW.environment_class = 'fresh'    THEN true
    WHEN OLD.phase = 'FROZEN'      AND NEW.phase = 'ACTIVATABLE' THEN true
    WHEN OLD.phase IN ('VERIFIED','FROZEN','ACTIVATABLE') AND NEW.phase = 'PREPARED' THEN true   -- rollback BEFORE activation only
    WHEN OLD.phase = 'ACTIVATABLE' AND NEW.phase = 'ACTIVE'      THEN true
    WHEN OLD.phase = 'ACTIVE'      AND NEW.phase = 'RETIRED'     THEN true
    ELSE false END;
  IF NOT legal THEN
    RAISE EXCEPTION 'illegal ownership transition % -> %', OLD.phase, NEW.phase USING ERRCODE = '55000';
  END IF;

  IF NEW.phase = 'VERIFIED' AND (NEW.environment_class IS NULL OR NEW.verified_digest IS NULL) THEN
    RAISE EXCEPTION 'VERIFIED needs a declared environment class and a verified digest' USING ERRCODE = '55000';
  END IF;
  IF NEW.phase = 'ACTIVATABLE' AND (NEW.approved_by IS NULL OR NEW.approved_reference IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'ACTIVATABLE needs a recorded approval (who, reference, when)' USING ERRCODE = '55000';
  END IF;
  IF NEW.phase = 'ACTIVE' AND (NEW.activated_by IS NULL OR NEW.activated_at IS NULL) THEN
    RAISE EXCEPTION 'ACTIVE needs the recorded activation (who, when)' USING ERRCODE = '55000';
  END IF;
  IF NEW.phase = 'PREPARED' THEN                -- a rollback clears every piece of evidence
    NEW.verified_digest := NULL; NEW.approved_by := NULL; NEW.approved_reference := NULL; NEW.approved_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER ownership_state_guard BEFORE UPDATE OR DELETE ON ownership_state FOR EACH ROW EXECUTE FUNCTION ownership_state_guard();

CREATE FUNCTION forbid_ownership_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TABLE ownership_event (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  operation      text NOT NULL CHECK (btrim(operation) <> ''),
  actor          text NOT NULL CHECK (btrim(actor) <> ''),                  -- a person, or the provisioning identity; never a secret
  environment    text NOT NULL,                                             -- the service's NODE_ENV
  correlation_id text,
  from_phase     text,
  to_phase       text,
  snapshot_digest text,
  outcome        text NOT NULL CHECK (outcome IN ('succeeded','rejected','failed')),
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER ownership_event_append_only BEFORE UPDATE OR DELETE ON ownership_event FOR EACH ROW EXECUTE FUNCTION forbid_ownership_change();
CREATE TRIGGER ownership_event_no_truncate BEFORE TRUNCATE ON ownership_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_ownership_change();

CREATE TABLE ownership_import_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at              timestamptz NOT NULL DEFAULT now(),
  snapshot_digest text NOT NULL,
  final           boolean NOT NULL,                                          -- taken under the source's freeze
  counts          jsonb NOT NULL,
  inserted        jsonb NOT NULL,
  skipped         jsonb NOT NULL,
  actor           text NOT NULL,
  correlation_id  text
);
CREATE TRIGGER ownership_import_run_append_only BEFORE UPDATE OR DELETE ON ownership_import_run FOR EACH ROW EXECUTE FUNCTION forbid_ownership_change();
CREATE TRIGGER ownership_import_run_no_truncate BEFORE TRUNCATE ON ownership_import_run FOR EACH STATEMENT EXECUTE FUNCTION forbid_ownership_change();

-- I1: a hierarchy id is never reused. The ledger records every id at insert; an insert of an id the ledger already holds is refused.
CREATE TABLE hierarchy_id_ledger (
  id         uuid PRIMARY KEY,
  entity     text NOT NULL CHECK (entity IN ('company','platform','organization')),
  first_seen timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hierarchy_id_ledger (id, entity)
  SELECT id, 'company' FROM company UNION ALL SELECT id, 'platform' FROM platform UNION ALL SELECT id, 'organization' FROM organization;
CREATE TRIGGER hierarchy_id_ledger_append_only BEFORE UPDATE OR DELETE ON hierarchy_id_ledger FOR EACH ROW EXECUTE FUNCTION forbid_ownership_change();

CREATE FUNCTION hierarchy_id_check() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM hierarchy_id_ledger WHERE id = NEW.id) THEN
    RAISE EXCEPTION 'hierarchy id % was already assigned and is never reused (I1)', NEW.id USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION hierarchy_id_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO hierarchy_id_ledger (id, entity) VALUES (NEW.id, TG_TABLE_NAME);
  RETURN NEW;
END $$;

-- The write gate: a NON-owner role (the runtime role) cannot write the hierarchy unless this service is authoritative, or the
-- bounded preparation modes apply. The schema owner and superuser (migration, import, operations, tests) are not gated here: the
-- application's own guard refuses writes when it is not authoritative, and the runtime role has no path around it in normal use.
-- This is defense in depth, not a privilege boundary against a compromised runtime role.
CREATE FUNCTION ownership_write_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st record; mode text := current_setting('nawara.write_mode', true); owner_name name;
BEGIN
  SELECT phase, environment_class INTO st FROM ownership_state;
  IF st.phase IN ('ACTIVE','RETIRED') THEN RETURN NEW; END IF;
  SELECT pg_get_userbyid(c.relowner) INTO owner_name FROM pg_class c WHERE c.oid = TG_RELID;
  IF pg_has_role(current_user, owner_name, 'MEMBER') THEN RETURN NEW; END IF;
  IF mode = 'import' AND st.phase IN ('PREPARED','VERIFIED','FROZEN') THEN RETURN NEW; END IF;
  IF mode = 'bootstrap' AND TG_TABLE_NAME = 'company' AND TG_OP = 'INSERT' AND st.environment_class = 'fresh' AND st.phase = 'PREPARED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'organization-service is not authoritative (phase %): hierarchy writes are refused', st.phase USING ERRCODE = '55000';
END $$;

-- I2(b): once authoritative, no role physically deletes or truncates a hierarchy row (until a lifecycle ADR decides otherwise).
-- Before activation the data is a non-authoritative prepared copy, so the schema owner may discard it (rollback before activation).
CREATE FUNCTION hierarchy_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authoritative boolean;
BEGIN
  SELECT s.authoritative INTO authoritative FROM ownership_state s;
  IF authoritative THEN
    RAISE EXCEPTION 'hierarchy rows are never physically deleted once organization-service is authoritative (I2(b))' USING ERRCODE = '55000';
  END IF;
  IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER company_id_check      BEFORE INSERT ON company      FOR EACH ROW EXECUTE FUNCTION hierarchy_id_check();
CREATE TRIGGER platform_id_check     BEFORE INSERT ON platform     FOR EACH ROW EXECUTE FUNCTION hierarchy_id_check();
CREATE TRIGGER organization_id_check BEFORE INSERT ON organization FOR EACH ROW EXECUTE FUNCTION hierarchy_id_check();
CREATE TRIGGER company_id_record      AFTER INSERT ON company      FOR EACH ROW EXECUTE FUNCTION hierarchy_id_record();
CREATE TRIGGER platform_id_record     AFTER INSERT ON platform     FOR EACH ROW EXECUTE FUNCTION hierarchy_id_record();
CREATE TRIGGER organization_id_record AFTER INSERT ON organization FOR EACH ROW EXECUTE FUNCTION hierarchy_id_record();

CREATE TRIGGER company_write_gate      BEFORE INSERT OR UPDATE ON company      FOR EACH ROW EXECUTE FUNCTION ownership_write_gate();
CREATE TRIGGER platform_write_gate     BEFORE INSERT OR UPDATE ON platform     FOR EACH ROW EXECUTE FUNCTION ownership_write_gate();
CREATE TRIGGER organization_write_gate BEFORE INSERT OR UPDATE ON organization FOR EACH ROW EXECUTE FUNCTION ownership_write_gate();

CREATE TRIGGER company_no_delete      BEFORE DELETE ON company      FOR EACH ROW EXECUTE FUNCTION hierarchy_no_delete();
CREATE TRIGGER platform_no_delete     BEFORE DELETE ON platform     FOR EACH ROW EXECUTE FUNCTION hierarchy_no_delete();
CREATE TRIGGER organization_no_delete BEFORE DELETE ON organization FOR EACH ROW EXECUTE FUNCTION hierarchy_no_delete();
CREATE TRIGGER company_no_truncate      BEFORE TRUNCATE ON company      FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_no_delete();
CREATE TRIGGER platform_no_truncate     BEFORE TRUNCATE ON platform     FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_no_delete();
CREATE TRIGGER organization_no_truncate BEFORE TRUNCATE ON organization FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_no_delete();

-- Least privilege for the conventional runtime role (infra/postgres creates `organization_app`): it may read the ownership tables and
-- write the hierarchy, but it can never change the ownership state, write the audit, or delete or truncate the hierarchy (I2(b)).
-- Skipped where that role does not exist (a test database, a fresh laptop); the triggers above hold regardless.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organization_app') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ownership_state, ownership_event, ownership_import_run, hierarchy_id_ledger FROM organization_app;
    REVOKE DELETE, TRUNCATE ON company, platform, organization FROM organization_app;
  END IF;
END $$;
