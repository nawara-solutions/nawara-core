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
--   * No SECURITY DEFINER function exists in this schema (a test pins it), so the recovery role cannot borrow another role's rights.
-- Remaining trust (recorded): the runtime role itself (the Payment service, which made the provider call) keeps the authority D-R1B gave it.

CREATE OR REPLACE FUNCTION refund_dispatch_application_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a refund_attempt%ROWTYPE; pay uuid; o refund_dispatch_observation%ROWTYPE; authority text;
BEGIN
  PERFORM refund_require_read_committed();
  -- 0040 (D-R1E): who applies an answer is the connected role's own authority, never the caller's claim
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'refund_dispatch_application: a switched role (% as %) applies no dispatch answer', session_user, current_user
      USING ERRCODE = '42501', CONSTRAINT = 'refund_dispatch_application_authority';
  END IF;
  authority := CASE WHEN has_table_privilege(current_user, 'refund_attempt_failure_finality', 'INSERT') THEN 'dispatch' ELSE 'recovery' END;
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
     OR has_table_privilege(r, 'refund_attempt_failure_finality', 'INSERT')
     OR has_table_privilege(r, 'refund_dispatch_send', 'INSERT')
     OR has_table_privilege(r, 'refund_dispatch_observation', 'INSERT') THEN
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
END $$;
REVOKE EXECUTE ON FUNCTION payment_grant_refund_recovery(regrole) FROM PUBLIC;

-- The conventional role of `infra/postgres/init` (`payment_refund_recovery`), when it exists; otherwise the schema owner runs the function later.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payment_refund_recovery') THEN
    PERFORM payment_grant_refund_recovery('payment_refund_recovery');
  END IF;
END $$;
