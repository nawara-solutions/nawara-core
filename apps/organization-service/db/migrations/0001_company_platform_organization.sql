-- 0001 — organization-service initial schema: Company → Platform → Organization (ADR-0031, ADR-0039).
--
-- This is organization-service's OWN schema in its OWN database (ADR-0032). It has no relationship of any kind to auth-service's
-- database: no shared table, no foreign key, no import. Organization-service is implemented but NOT yet authoritative; nothing here
-- migrates or reads auth-service data (that is the separate, later ownership-migration stage of ADR-0039).
--
-- The shape mirrors auth-service's existing hierarchy tables (its migration 0001) so a later import can preserve ids and rows:
--   * `id` is a plain `uuid PRIMARY KEY DEFAULT gen_random_uuid()`. The DEFAULT only fills an omitted id: an explicitly supplied id
--     (an id that already exists in auth-service) is accepted as-is. No sequence, no derived id, no trigger overrides it.
--   * `createdAt`/`updatedAt` are ordinary columns with defaults, so a row can also carry its original timestamps.
--   * Column names are quoted camelCase, as everywhere else in Core.
-- Not carried over from auth-service, deliberately: the composite UNIQUE (id, companyId) / (id, platformId) keys. They exist there
-- only as targets of composite foreign keys from auth-owned tables (platform_assignment, join codes) that do not exist here.
-- Not added, deliberately: any unique name, status/archive column, or delete path. None is established by an existing decision
-- (ADR-0039 "Deferred decisions": lifecycle semantics), and a unique name would risk rejecting valid auth-service rows on import.
--
-- The kit's migrations (kit_0003) have already created forbid_column_change(); the runner applies them first.

CREATE TABLE company (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_name_not_blank CHECK (btrim(name) <> '')
);

CREATE TABLE platform (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "companyId" uuid NOT NULL,
  name        text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT platform_company_fk FOREIGN KEY ("companyId") REFERENCES company (id) ON DELETE RESTRICT
);
CREATE INDEX platform_company_idx ON platform ("companyId");

CREATE TABLE organization (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "platformId" uuid NOT NULL,
  name        text NOT NULL,
  "taxCode"   text,
  address     text,
  phone       text,
  type        text,            -- generic and opaque: never validated or interpreted here (ADR-0001, ADR-0020)
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT organization_platform_fk FOREIGN KEY ("platformId") REFERENCES platform (id) ON DELETE RESTRICT
);
CREATE INDEX organization_platform_idx ON organization ("platformId");

-- Keyset-pagination order for lists (newest first, id as the tie-break).
CREATE INDEX company_created_idx      ON company      ("createdAt" DESC, id DESC);
CREATE INDEX platform_created_idx     ON platform     ("createdAt" DESC, id DESC);
CREATE INDEX organization_created_idx ON organization ("createdAt" DESC, id DESC);

-- Tenancy anchors never move (ADR-0024, same rule as auth-service): there is no designed "move a platform to another company" or
-- "move an organization to another platform" operation, and either would silently rewrite the hierarchy every consumer relies on.
-- An id is also frozen: every opaque reference held elsewhere (memberships, invoices, payments) points at it. `createdAt` is history.
CREATE TRIGGER company_immutable      BEFORE UPDATE ON company      FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'createdAt');
CREATE TRIGGER platform_immutable     BEFORE UPDATE ON platform     FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'createdAt', 'companyId');
CREATE TRIGGER organization_immutable BEFORE UPDATE ON organization FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'createdAt', 'platformId');
