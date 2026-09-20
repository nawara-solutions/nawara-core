-- 0008 — auth-service: the hierarchy authority marker and write guards (ADR-0040, Stage 10.1).
--
-- INERT: the marker starts in mode 'local' and every guard passes in that mode, so this migration changes NO behavior and moves NO
-- authority. (Auth deploys and migrates automatically on a merge, which is why nothing here may act until an operator runs the CLI.)
--
--   local              today: auth-service owns Company, Platform and Organization and writes them freely.
--   frozen             the ownership transition's freeze (ADR-0040 E2): NO hierarchy write at all, so a final export is exact.
--   org_authoritative  after ACTIVATE AUTHORITY in organization-service (the mirror, ADR-0040 A2.5): the tables are a non-authoritative
--                      reference cache. Only the reference-cache protocol may write (it sets nawara.reference_write = 'on'), never a
--                      delete, and an anchor (company/platform parent) never changes. There is NO way back: the one-way door.
--
-- Legal transitions: local -> frozen, frozen -> local (unfreeze, before the switch), frozen -> org_authoritative (existing environment),
-- local -> org_authoritative (fresh environment: there is nothing to freeze). org_authoritative is final.
BEGIN;

CREATE TABLE hierarchy_authority (
  id                  boolean PRIMARY KEY DEFAULT true CHECK (id),      -- exactly one row
  mode                text NOT NULL DEFAULT 'local' CHECK (mode IN ('local','frozen','org_authoritative')),
  frozen_at           timestamptz,
  frozen_by           text,
  activation_evidence text,                                            -- what proves organization-service was activated (its event / digest)
  retired_at          timestamptz,
  retired_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hierarchy_authority DEFAULT VALUES;

CREATE TABLE hierarchy_authority_event (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  operation text NOT NULL,
  actor     text NOT NULL CHECK (btrim(actor) <> ''),
  from_mode text,
  to_mode   text,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE FUNCTION hierarchy_authority_forbid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER hierarchy_authority_event_append_only BEFORE UPDATE OR DELETE ON hierarchy_authority_event FOR EACH ROW EXECUTE FUNCTION hierarchy_authority_forbid();
CREATE TRIGGER hierarchy_authority_event_no_truncate BEFORE TRUNCATE ON hierarchy_authority_event FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_authority_forbid();

CREATE FUNCTION hierarchy_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legal boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'hierarchy_authority is never deleted' USING ERRCODE = '55000'; END IF;
  IF OLD.mode = 'org_authoritative' THEN RAISE EXCEPTION 'organization-service is the hierarchy authority: there is no way back (the one-way door)' USING ERRCODE = '55000'; END IF;
  IF NEW.mode = OLD.mode THEN RETURN NEW; END IF;
  legal := (OLD.mode = 'local' AND NEW.mode = 'frozen') OR (OLD.mode = 'frozen' AND NEW.mode = 'local')
        OR (OLD.mode IN ('frozen','local') AND NEW.mode = 'org_authoritative');
  IF NOT legal THEN RAISE EXCEPTION 'illegal hierarchy authority transition % -> %', OLD.mode, NEW.mode USING ERRCODE = '55000'; END IF;
  IF NEW.mode = 'org_authoritative' AND (NEW.activation_evidence IS NULL OR btrim(NEW.activation_evidence) = '' OR NEW.retired_by IS NULL) THEN
    RAISE EXCEPTION 'org_authoritative needs the activation evidence and who retired the writes' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER hierarchy_authority_guard BEFORE UPDATE OR DELETE ON hierarchy_authority FOR EACH ROW EXECUTE FUNCTION hierarchy_authority_guard();

CREATE FUNCTION hierarchy_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m text;
BEGIN
  SELECT mode INTO m FROM hierarchy_authority;
  IF m = 'local' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF m = 'frozen' THEN
    RAISE EXCEPTION 'the hierarchy is frozen for the ownership transition' USING ERRCODE = '55000';
  END IF;
  -- org_authoritative: a non-authoritative reference cache.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference rows are never deleted' USING ERRCODE = '55000';
  END IF;
  IF current_setting('nawara.reference_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'organization-service is the hierarchy authority: auth-service may only place validated references' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION hierarchy_truncate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m text;
BEGIN
  SELECT mode INTO m FROM hierarchy_authority;
  IF m <> 'local' THEN RAISE EXCEPTION 'the hierarchy cannot be truncated while %', m USING ERRCODE = '55000'; END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER company_write_guard      BEFORE INSERT OR UPDATE OR DELETE ON company      FOR EACH ROW EXECUTE FUNCTION hierarchy_write_guard();
CREATE TRIGGER platform_write_guard     BEFORE INSERT OR UPDATE OR DELETE ON platform     FOR EACH ROW EXECUTE FUNCTION hierarchy_write_guard();
CREATE TRIGGER organization_write_guard BEFORE INSERT OR UPDATE OR DELETE ON organization FOR EACH ROW EXECUTE FUNCTION hierarchy_write_guard();
CREATE TRIGGER company_truncate_guard      BEFORE TRUNCATE ON company      FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_truncate_guard();
CREATE TRIGGER platform_truncate_guard     BEFORE TRUNCATE ON platform     FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_truncate_guard();
CREATE TRIGGER organization_truncate_guard BEFORE TRUNCATE ON organization FOR EACH STATEMENT EXECUTE FUNCTION hierarchy_truncate_guard();

COMMIT;
