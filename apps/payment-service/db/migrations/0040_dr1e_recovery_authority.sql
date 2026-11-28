-- 0040 — payment-service: recovery has NO database authority to create refund failure finality (Core V2 D-R1E; the A1 correction of D-R1D / 0039,
-- the Owner's urgent post-merge direction of 2026-11-28). DEVELOPMENT AND SIMULATION ONLY. AUTHORITY ONLY: no refund, dispatch, replacement,
-- finality-eligibility, allocation, case, hold or release rule changes; no existing row is rewritten; nothing is backfilled.
--
-- The defect (0039): `refund_dispatch_application."appliedBy"` was a caller-supplied value, and a `dispatch_response` finality required an application
-- labelled `dispatch`. Every session of the shared runtime role could therefore present a recovered answer as the dispatch's own and record certified
-- finality. No mechanism inside one database role can tell two code paths of that role apart, so the distinction is now the ROLE itself:
--
--   * The RECOVERY role is a separate login role (convention: `payment_refund_recovery`, created by infra/postgres/init when its password is given),
--     used only by the separate recovery process (`cli/refund-response-recovery.ts`), never by the Payment service. `payment_grant_refund_recovery(r)`
--     grants it exactly what applying a stored answer needs and REFUSES any role that can record finality, sends or answers, is a superuser, bypasses
--     row security, owns the schema, or is a member of another role (it could switch to it). It never receives INSERT on
--     `refund_attempt_failure_finality`, `refund_dispatch_send` or `refund_dispatch_observation`.
--   * "appliedBy" is DERIVED from the connected role's own authority, never accepted from the caller: `dispatch` only for a role that can record
--     finality (the runtime role), `recovery` for any other. A caller's different value is refused, as is a session that switched roles.
--   * 0039's finality checks are unchanged and now rest on that derivation: a `dispatch_response` finality still needs an application by `dispatch`
--     in the same transaction, and the recovery role cannot insert finality at all (42501).
--   * The grant REGISTERS the role (`refund_recovery_role`, owner-written, append-only). A registered recovery role, as the current or the session
--     role, is refused every insert into `refund_attempt_failure_finality` (every source), `refund_dispatch_send` and `refund_dispatch_observation`,
--     and is always `recovery`, WHATEVER privileges or memberships it is given later (Codex round 1, P1): its identity, not its privileges, decides.
--     All privilege checks count column-level grants too (`has_any_column_privilege`; Codex round 1, P2).
--   * No SECURITY DEFINER function exists in this schema (a test pins it), so the recovery role cannot borrow another role's rights.
-- Remaining trust (recorded): the runtime role itself (the Payment service, which made the provider call) keeps the authority D-R1B gave it.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the recovery-role registry

CREATE TABLE refund_recovery_role (
  role          oid PRIMARY KEY,                     -- pg_roles.oid of a role granted by payment_grant_refund_recovery (a recreated role is a new oid)
  "grantedAt"   timestamptz NOT NULL DEFAULT clock_timestamp(),
  "grantedBy"   text NOT NULL DEFAULT current_user
);
CREATE TRIGGER refund_recovery_role_10_append_only BEFORE UPDATE OR DELETE ON refund_recovery_role FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_recovery_role_11_no_truncate BEFORE TRUNCATE ON refund_recovery_role FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

-- whether this session is a registered recovery role, as its current or its session role (never configuration, never a caller's value)
CREATE FUNCTION refund_is_recovery_session() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refund_recovery_role r
                  WHERE r.role IN ((SELECT oid FROM pg_roles WHERE rolname = current_user), (SELECT oid FROM pg_roles WHERE rolname = session_user)))
$$;

CREATE FUNCTION refund_refuse_recovery_role() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_is_recovery_session() THEN
    RAISE EXCEPTION 'refund recovery role % may not write %: recovery never records finality, a send or an answer', session_user, TG_TABLE_NAME
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_role_refused';
  END IF;
  RETURN NEW;
END $$;
-- 00: before every existing guard of these tables
CREATE TRIGGER refund_attempt_failure_finality_00_not_recovery BEFORE INSERT ON refund_attempt_failure_finality FOR EACH ROW EXECUTE FUNCTION refund_refuse_recovery_role();
CREATE TRIGGER refund_dispatch_send_00_not_recovery BEFORE INSERT ON refund_dispatch_send FOR EACH ROW EXECUTE FUNCTION refund_refuse_recovery_role();
CREATE TRIGGER refund_dispatch_observation_00_not_recovery BEFORE INSERT ON refund_dispatch_observation FOR EACH ROW EXECUTE FUNCTION refund_refuse_recovery_role();

CREATE OR REPLACE FUNCTION refund_dispatch_application_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a refund_attempt%ROWTYPE; pay uuid; o refund_dispatch_observation%ROWTYPE; authority text;
BEGIN
  PERFORM refund_require_read_committed();
  -- 0040 (D-R1E): who applies an answer is the connected role's own authority, never the caller's claim
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'refund_dispatch_application: a switched role (% as %) applies no dispatch answer', session_user, current_user
      USING ERRCODE = '42501', CONSTRAINT = 'refund_dispatch_application_authority';
  END IF;
  authority := CASE WHEN refund_is_recovery_session() THEN 'recovery'
                    WHEN has_any_column_privilege(current_user, 'refund_attempt_failure_finality', 'INSERT') THEN 'dispatch' ELSE 'recovery' END;
  IF NEW."appliedBy" IS DISTINCT FROM authority THEN
    RAISE EXCEPTION 'refund_dispatch_application: role % applies as %, not %', current_user, authority, NEW."appliedBy"
      USING ERRCODE = '42501', CONSTRAINT = 'refund_dispatch_application_authority';
  END IF;
  -- 0039's guard, unchanged
  SELECT "paymentId" INTO pay FROM refund_attempt WHERE id = NEW."refundAttemptId";
  PERFORM 1 FROM payment WHERE id = pay FOR UPDATE;                                   -- re-entrant: the applying transaction already holds both
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId" FOR UPDATE;
  SELECT * INTO o FROM refund_dispatch_observation WHERE id = NEW."observationId" AND "refundAttemptId" = NEW."refundAttemptId";
  IF a.id IS NULL OR o.id IS NULL OR NEW."attemptStatusAfter" IS DISTINCT FROM a.status
     OR (NEW.effect = 'transitioned' AND NEW."attemptStatusAfter" IS DISTINCT FROM
           CASE o.classification WHEN 'accepted' THEN 'submitted' WHEN 'rejected' THEN 'failed' ELSE 'unknown' END) THEN
    RAISE EXCEPTION 'refund_dispatch_application: observation % does not leave attempt % in status %', NEW."observationId", NEW."refundAttemptId", NEW."attemptStatusAfter"
      USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_application_state';
  END IF;
  NEW."appliedAt" := clock_timestamp();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the recovery role's grant (audit 0003's precedent)

CREATE FUNCTION payment_grant_refund_recovery(r regrole) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles x WHERE x.oid = r AND (x.rolsuper OR x.rolbypassrls))
     OR pg_has_role(r, (SELECT nspowner FROM pg_namespace WHERE nspname = 'public'), 'MEMBER')
     OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r)
     OR has_any_column_privilege(r, 'refund_attempt_failure_finality', 'INSERT')
     OR has_any_column_privilege(r, 'refund_dispatch_send', 'INSERT')
     OR has_any_column_privilege(r, 'refund_dispatch_observation', 'INSERT') THEN
    RAISE EXCEPTION 'payment_grant_refund_recovery: % can record finality, sends or answers, or can become a role that does; the recovery role must be a separate role', r
      USING ERRCODE = '42501';
  END IF;
  -- reading is no authority: the decision and the database's own guards read across Payment's tables
  FOR t IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') LOOP
    EXECUTE format('GRANT SELECT ON %I TO %s', t, r);
  END LOOP;
  -- the row locks of 0037's order (FOR UPDATE needs an UPDATE privilege): the payment's bookkeeping column only; the attempt's decision columns
  EXECUTE format('GRANT UPDATE ("updatedAt") ON payment TO %s', r);
  EXECUTE format('GRANT UPDATE (status, "failureCode", "completedAt", "workAfter", "providerRefundId", "submittedAt") ON refund_attempt TO %s', r);
  -- what the decision writes: its application, a D-R1A preserved contradiction, and their audit intents
  EXECUTE format('GRANT INSERT ON refund_dispatch_application, refund_safety_escalation, outbox TO %s', r);
  -- registered: from now on its identity refuses it finality, sends and answers, whatever it is granted later
  INSERT INTO refund_recovery_role (role) VALUES (r::oid) ON CONFLICT (role) DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION payment_grant_refund_recovery(regrole) FROM PUBLIC;

DO $$
DECLARE x record;
BEGIN
  REVOKE ALL ON refund_recovery_role FROM PUBLIC;
  FOR x IN
    SELECT a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'refund_recovery_role'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0 AND a.privilege_type <> 'SELECT'
  LOOP
    EXECUTE format('REVOKE %s ON refund_recovery_role FROM %s', x.priv, x.role);
  END LOOP;
END $$;

-- The conventional role of `infra/postgres/init` (`payment_refund_recovery`), when it exists; otherwise the schema owner runs the function later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_refund_recovery') THEN
    PERFORM payment_grant_refund_recovery('payment_refund_recovery');
  END IF;
END $$;
