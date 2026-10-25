-- Core V2 S2-Audit.4 (ADR-0069 decision 6; register AUD-05; OD-13 resolved by the Owner, decisions H1 to H7): legal holds.
--
-- A legal hold is placed and released by the active Owner of a Company (verified live through Auth, with a factor-only step-up; the API is
-- audit-service's). It covers the records with a TRUSTED Company scope row for that Company (`audit_record_scope`, basis
-- `verified_producer`), optionally only those whose `occurredAt` is in `[windowFrom, windowTo)`. Unverified, unscoped and historical
-- records without trusted Company scope are NOT covered (H7): ownership is never inferred.
--
--   * `audit_legal_hold_event`: append-only (every role), one `placed` and at most one `released` row per hold; the Company and the window
--     are fixed by the `placed` row (a `released` row names the same Company and carries no window). A hold is active from its `placed`
--     row until a `released` row exists. No expiry (H5).
--   * `audit_record_is_held(id)`: whether a record is covered by an active hold (SECURITY DEFINER, fixed search_path: the retention role
--     reads neither the scope rows nor the holds).
--   * `audit_record_append_only()` (the 0003 body + one check): a DELETE past the retention horizon is refused while the record is held.
--     Before checking, it takes the Company's legal-hold advisory lock SHARED; placing or releasing a hold takes it EXCLUSIVE in its own
--     transaction. So a hold committed before a deletion is always seen, a deletion committed first was lawful when it happened, and an
--     unsuccessful release (rolled back) changes nothing.
--   * The retention role also gets EXECUTE on `audit_record_is_held`, so its batches SKIP held records (decision 6: "the retention role
--     skips held records") instead of being refused whole; the trigger stays the backstop.
-- Expand only: no existing row changes; no retention policy is added (the shipped policy is still empty: nothing is purged).

CREATE TABLE audit_legal_hold_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "holdId"      uuid NOT NULL,
  kind          text NOT NULL,
  "companyId"   uuid NOT NULL,
  "windowFrom"  timestamptz,
  "windowTo"    timestamptz,
  "reasonCode"  text NOT NULL,
  "actorUserId" uuid NOT NULL,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_legal_hold_event_kind_valid CHECK (kind IN ('placed', 'released')),
  CONSTRAINT audit_legal_hold_event_reason_shape CHECK ("reasonCode" ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- the window: placed with both bounds (from < to) or none; a release never carries one
  CONSTRAINT audit_legal_hold_event_window CHECK (
       (kind = 'placed' AND (("windowFrom" IS NULL AND "windowTo" IS NULL)
                              OR ("windowFrom" IS NOT NULL AND "windowTo" IS NOT NULL AND "windowFrom" < "windowTo"
                                  AND isfinite("windowFrom") AND isfinite("windowTo"))))
    OR (kind = 'released' AND "windowFrom" IS NULL AND "windowTo" IS NULL)),
  CONSTRAINT audit_legal_hold_event_once UNIQUE ("holdId", kind)
);
CREATE INDEX audit_legal_hold_event_company_idx ON audit_legal_hold_event ("companyId", "holdId") WHERE kind = 'placed';

-- Append-only for every role; a release must follow its own placement, for the same Company.
CREATE FUNCTION audit_legal_hold_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'audit_legal_hold_event is append-only (% refused)', TG_OP USING ERRCODE = '42501';
  END IF;
  IF NEW.kind = 'released' AND NOT EXISTS (
       SELECT 1 FROM audit_legal_hold_event p WHERE p."holdId" = NEW."holdId" AND p.kind = 'placed' AND p."companyId" = NEW."companyId") THEN
    RAISE EXCEPTION 'audit_legal_hold_event: a release needs its placement, for the same Company' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_legal_hold_event_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_legal_hold_event
  FOR EACH ROW EXECUTE FUNCTION audit_legal_hold_event_guard();
CREATE TRIGGER audit_legal_hold_event_no_truncate BEFORE TRUNCATE ON audit_legal_hold_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_provenance_append_only();
SELECT audit_restrict_to_append_only('audit_legal_hold_event');

-- The advisory lock key of a Company's legal holds (one 64-bit key per Company; a collision only serializes more).
CREATE FUNCTION audit_legal_hold_lock_key(company uuid) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hashtextextended('nawara.audit.legal_hold:' || company::text, 0)
$$;

-- Whether a record is covered by an ACTIVE hold of its trusted Company (H7: only trusted Company scope; never inferred).
CREATE FUNCTION audit_record_is_held(record_id bigint) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM audit_record r
      JOIN audit_record_scope s ON s."recordId" = r.id AND s.basis = 'verified_producer' AND s."companyId" IS NOT NULL
      JOIN audit_legal_hold_event p ON p.kind = 'placed' AND p."companyId" = s."companyId"
           AND (p."windowFrom" IS NULL OR (r."occurredAt" >= p."windowFrom" AND r."occurredAt" < p."windowTo"))
     WHERE r.id = record_id
       AND NOT EXISTS (SELECT 1 FROM audit_legal_hold_event x WHERE x."holdId" = p."holdId" AND x.kind = 'released'))
$$;
REVOKE EXECUTE ON FUNCTION audit_record_is_held(bigint) FROM PUBLIC;

-- The delete-time check: the record's Company lock SHARED, then (a new statement, so a fresh snapshot) whether it is held.
CREATE FUNCTION audit_record_hold_guard(record_id bigint) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE company uuid;
BEGIN
  SELECT s."companyId" INTO company FROM audit_record_scope s
   WHERE s."recordId" = record_id AND s.basis = 'verified_producer' AND s."companyId" IS NOT NULL;
  IF company IS NULL THEN
    RETURN false; -- no trusted Company scope: no legal hold can cover it (H7)
  END IF;
  PERFORM pg_advisory_xact_lock_shared(audit_legal_hold_lock_key(company));
  RETURN audit_record_is_held(record_id);
END $$;
REVOKE EXECUTE ON FUNCTION audit_record_hold_guard(bigint) FROM PUBLIC;

-- Replaces the 0003 body (the triggers themselves are unchanged): a DELETE past the horizon is refused while the record is held.
CREATE OR REPLACE FUNCTION audit_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
       SELECT 1 FROM audit_retention_policy p
        WHERE p.category = OLD.category AND OLD."recordedAt" < now() - make_interval(days => p."retainDays")) THEN
    IF audit_record_hold_guard(OLD.id) THEN
      RAISE EXCEPTION 'audit_record % is under a legal hold (DELETE refused)', OLD.id USING ERRCODE = '42501';
    END IF;
    RETURN OLD; -- past its category's retention horizon (A41) and not held; only a role holding DELETE (the retention role) can get here
  END IF;
  RAISE EXCEPTION 'audit_record is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END $$;

-- The retention grant now also lets the role check holds (to skip held records) and pass the delete-time guard.
CREATE OR REPLACE FUNCTION audit_grant_retention(r regrole) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF has_table_privilege(r, 'audit_record', 'INSERT') OR has_table_privilege(r, 'audit_record', 'UPDATE') THEN
    RAISE EXCEPTION 'audit_grant_retention: % can write audit records; the retention role must be a separate role', r USING ERRCODE = '42501';
  END IF;
  EXECUTE format('GRANT SELECT (id, category, "recordedAt"), DELETE ON audit_record TO %s', r);
  EXECUTE format('GRANT SELECT ON audit_retention_policy TO %s', r);
  EXECUTE format('GRANT SELECT, INSERT ON audit_retention_run TO %s', r);
  EXECUTE format('GRANT EXECUTE ON FUNCTION audit_record_is_held(bigint), audit_record_hold_guard(bigint) TO %s', r);
END $$;
REVOKE EXECUTE ON FUNCTION audit_grant_retention(regrole) FROM PUBLIC;

-- Every role already granted retention (it holds DELETE on audit_record and is not the owner) gets the two functions too.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'audit_record'::regclass AND a.privilege_type = 'DELETE' AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION audit_record_is_held(bigint), audit_record_hold_guard(bigint) TO %s', r.role);
  END LOOP;
END $$;
