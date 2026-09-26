-- Stage 18.8: the retention path, separated from the runtime (ADR-0049 A41 mechanism, A45, T14, T23).
--
-- ADR-0049 decided the MECHANISM: per category, purged in bounded batches by a separate maintenance role that the append-only trigger
-- admits only for rows past their category's horizon; the DURATIONS are an owner / legal decision (P-A2) and the default is "never purge".
-- This migration therefore creates the mechanism and NO duration:
--   * `audit_retention_policy` — one optional row per category, written only by the schema owner (a deliberate, reviewed act; see the
--     Stage 18.8 record's runbook). No row = that category is never purged. It ships EMPTY.
--   * the append-only trigger now admits a DELETE of a row whose category has a policy AND whose `recordedAt` (Audit's own database
--     clock, which no producer can set; `occurredAt` is producer-controlled and is never used here) is older than that policy's horizon.
--     UPDATE and TRUNCATE stay refused for everyone; so does a DELETE of any row inside its horizon, or of a category with no policy.
--   * WHO may delete is decided by privileges: the runtime keeps INSERT / SELECT only (no DELETE, unchanged); a retention role receives
--     DELETE plus SELECT on (id, category, recordedAt) only — it cannot read the evidence it purges — through
--     `audit_grant_retention(role)`, which refuses the runtime role.
--   * `audit_retention_run` — an append-only ledger: every purge batch records category, horizon, cutoff and count in the SAME
--     transaction as its DELETE (no purge without its trace; no trace of a purge that rolled back).

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── policy

CREATE TABLE audit_retention_policy (
  category      text PRIMARY KEY,
  "retainDays"  integer NOT NULL,
  "setAt"       timestamptz NOT NULL DEFAULT now(),
  "setBy"       text NOT NULL DEFAULT current_user,
  CONSTRAINT audit_retention_policy_category_valid CHECK (category IN ('security', 'business', 'commercial', 'administrative')),
  -- A duration, never zero or negative (that would purge on arrival); the upper bound only keeps the interval arithmetic sane (100 years).
  CONSTRAINT audit_retention_policy_days_valid CHECK ("retainDays" BETWEEN 1 AND 36500)
);

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── ledger

CREATE TABLE audit_retention_run (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category      text NOT NULL,
  "retainDays"  integer NOT NULL,
  cutoff        timestamptz NOT NULL,
  deleted       integer NOT NULL,
  "ranAt"       timestamptz NOT NULL DEFAULT now(),
  "ranBy"       text NOT NULL DEFAULT current_user,
  CONSTRAINT audit_retention_run_category_valid CHECK (category IN ('security', 'business', 'commercial', 'administrative')),
  CONSTRAINT audit_retention_run_days_valid CHECK ("retainDays" BETWEEN 1 AND 36500),
  CONSTRAINT audit_retention_run_deleted_valid CHECK (deleted >= 1)
);

CREATE FUNCTION audit_retention_run_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_retention_run is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_retention_run_no_update_delete BEFORE UPDATE OR DELETE ON audit_retention_run FOR EACH ROW EXECUTE FUNCTION audit_retention_run_append_only();
CREATE TRIGGER audit_retention_run_no_truncate BEFORE TRUNCATE ON audit_retention_run FOR EACH STATEMENT EXECUTE FUNCTION audit_retention_run_append_only();

-- ───────────────────────────────────────────────────────────────────────────────────────────────── privileges of the new tables

-- The Core provisioning's DEFAULT PRIVILEGES give the runtime SELECT / INSERT / UPDATE / DELETE on every table the migrator creates.
-- Neither table is the runtime's: take EVERY privilege back from every role but the owner (whatever the roles are called).
DO $$
DECLARE r record;
BEGIN
  REVOKE ALL ON audit_retention_policy FROM PUBLIC;
  REVOKE ALL ON audit_retention_run FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('audit_retention_policy', 'audit_retention_run') AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON %I FROM %s', r.tbl, r.role);
  END LOOP;
END $$;

-- ───────────────────────────────────────────────────────────────────────────────────────────────────── the purge's index

-- A batch is `WHERE category = $c AND "recordedAt" < cutoff ORDER BY "recordedAt", id LIMIT n`. On the 18.3 `("recordedAt")` index alone
-- it must step over every older row of the OTHER categories, and a category with no policy (never purged) only accumulates: measured at
-- 620 000 rows with 300 000 older never-purged `security` rows, one 1 000-row batch discarded 315 015 rows (62 ms), a cost that grows
-- forever. This index makes each batch an index-only range scan of its own category (4 ms, ~400 buffers, whatever the other backlogs).
-- Cost: one more index entry per insert. `id` completes the ORDER BY.
CREATE INDEX audit_record_retention_idx ON audit_record (category, "recordedAt", id);

-- ────────────────────────────────────────────────────────────────────────────────── the append-only trigger admits retention only

-- Replaces the 18.3 body (the triggers themselves are unchanged). SECURITY INVOKER: the policy is read with the deleting role's rights.
CREATE OR REPLACE FUNCTION audit_record_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
       SELECT 1 FROM audit_retention_policy p
        WHERE p.category = OLD.category AND OLD."recordedAt" < now() - make_interval(days => p."retainDays")) THEN
    RETURN OLD; -- past its category's retention horizon (A41); only a role holding DELETE (the retention role) can get here
  END IF;
  RAISE EXCEPTION 'audit_record is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── granting the retention role

-- Called once by the schema owner (after provisioning created the role; the migration below does it for the conventional name). It
-- refuses a role that can INSERT into audit_record (the runtime, or anything like it): retention and runtime authority never meet.
CREATE FUNCTION audit_grant_retention(r regrole) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF has_table_privilege(r, 'audit_record', 'INSERT') OR has_table_privilege(r, 'audit_record', 'UPDATE') THEN
    RAISE EXCEPTION 'audit_grant_retention: % can write audit records; the retention role must be a separate role', r USING ERRCODE = '42501';
  END IF;
  EXECUTE format('GRANT SELECT (id, category, "recordedAt"), DELETE ON audit_record TO %s', r);
  EXECUTE format('GRANT SELECT ON audit_retention_policy TO %s', r);
  EXECUTE format('GRANT SELECT, INSERT ON audit_retention_run TO %s', r);
END $$;
REVOKE EXECUTE ON FUNCTION audit_grant_retention(regrole) FROM PUBLIC;

-- The conventional role of `infra/postgres/init` (`audit_retention`), when it exists; otherwise the owner runs the function later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_retention') THEN
    PERFORM audit_grant_retention('audit_retention');
  END IF;
END $$;
