-- 0003 — Platform.key: a persisted attribute that auth-service ALREADY has and organization-service was missing (Stage 9.1).
--
-- Source of truth: auth-service migration 0004 ("platform.key — short public slug shown to the app"), untouched by 0005-0007:
--     ALTER TABLE platform
--       ADD COLUMN key text,
--       ADD CONSTRAINT platform_key_format CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9-]{1,39}$'),
--       ADD CONSTRAINT platform_key_uk UNIQUE (key);
-- Reproduced here exactly, with the same constraint names, so an existing Auth value can be carried over unchanged later:
--   * nullable, no default (many platforms may have no key: UNIQUE treats NULLs as distinct, exactly as in Auth);
--   * lower-case letter first, then lower-case letters, digits or hyphens, 2 to 40 characters in all (a hyphen may be last or repeated:
--     that is what Auth's pattern permits, and no stricter rule is invented here);
--   * unique when present;
--   * NOT immutable (Auth puts no trigger on it) and no foreign key or extra index.
-- Purely additive: existing rows are untouched (their key is NULL), no id is generated or changed, and nothing is read from auth-service.
-- Nothing in this service writes it: Auth exposes `key` in reads only and has no route that sets it, so the API here does the same.

ALTER TABLE platform
  ADD COLUMN key text,
  ADD CONSTRAINT platform_key_format CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9-]{1,39}$'),
  ADD CONSTRAINT platform_key_uk UNIQUE (key);
