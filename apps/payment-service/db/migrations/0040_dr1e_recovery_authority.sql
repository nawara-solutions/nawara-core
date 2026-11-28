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
-- What a recovery session may write is bound to stored evidence (F1-F4 of the Owner's 2026-11-28 GO): an attempt changes only by a status
-- transition matched at commit by its own recovery application of a stored answer of that attempt, provider and key (F2); an application's effect is
-- the one the approved decision gives (F3, both roles); its outbox rows are only its own two audit intents, byte-exact (F1); it never updates a payment
-- nor schedules work (no "workAfter", F4).
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
DECLARE a refund_attempt%ROWTYPE; pay uuid; o refund_dispatch_observation%ROWTYPE; authority text; own_fact boolean; expected text;
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
  -- 0040 F3 (both roles): the effect is the one the approved decision gives this answer from this status, never the caller's choice. A false
  -- `no_effect` cannot hide an applicable answer, and `preserved_contradiction` needs the attempt's own verified refund fact and its D-R1A row
  own_fact := EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.kind = 'refund' AND f."refundAttemptId" = a.id AND f."paymentId" = a."paymentId");
  expected := CASE
    WHEN o.classification = 'rejected' AND own_fact
         AND NEW."attemptStatusBefore" IN ('dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy', 'failed') THEN 'preserved_contradiction'
    WHEN NEW."attemptStatusBefore" IN ('dispatching', 'unknown') THEN
      CASE WHEN o.classification IN ('accepted', 'rejected') OR NEW."attemptStatusBefore" = 'dispatching' THEN 'transitioned' ELSE 'no_effect' END
    ELSE 'no_effect' END;
  IF NEW.effect IS DISTINCT FROM expected
     OR (expected = 'preserved_contradiction' AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation e
           WHERE e."refundAttemptId" = a.id AND e.kind = 'failure_after_refund_evidence')) THEN
    RAISE EXCEPTION 'refund_dispatch_application: observation % of attempt % has effect %, not %', NEW."observationId", a.id, expected, NEW.effect
      USING ERRCODE = '23514', CONSTRAINT = 'refund_dispatch_application_effect';
  END IF;
  NEW."appliedAt" := clock_timestamp();
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── what a recovery session may write (F1, F2)
-- A recovery session writes only what applying ONE stored answer produces, in that answer's own transaction, and the database checks each write
-- against the stored rows. `applied_here`: the recovery application of this attempt committed in THIS transaction (appliedAt is database time).

CREATE FUNCTION refund_recovery_applied_here(p_attempt uuid, p_effect text, p_before text, p_after text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refund_dispatch_application p
                   JOIN refund_dispatch_observation o ON o.id = p."observationId" AND o."refundAttemptId" = p."refundAttemptId"
                   JOIN refund_dispatch_send s ON s.id = o."sendId" AND s."refundAttemptId" = o."refundAttemptId"
                   JOIN refund_attempt a ON a.id = p."refundAttemptId" AND a."paymentId" = s."paymentId" AND a.provider = s.provider AND s."idempotencyKey" = a.id::text
                  WHERE p."refundAttemptId" = p_attempt AND p."appliedBy" = 'recovery' AND p."appliedAt" >= transaction_timestamp()
                    AND p.effect = p_effect AND (p_before IS NULL OR p."attemptStatusBefore" = p_before) AND (p_after IS NULL OR p."attemptStatusAfter" = p_after))
$$;

-- F2: an attempt row changes under a recovery session only as a status transition, with the columns that transition writes, at database time
CREATE FUNCTION refund_recovery_attempt_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT refund_is_recovery_session() THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW."workAfter" IS DISTINCT FROM OLD."workAfter"
     OR (NEW.status = 'failed' AND NEW."completedAt" IS DISTINCT FROM now())
     OR (NEW.status <> 'failed' AND (NEW."failureCode", NEW."completedAt") IS DISTINCT FROM (OLD."failureCode", OLD."completedAt"))
     OR (NEW.status = 'submitted' AND NEW."submittedAt" IS DISTINCT FROM now())
     OR (NEW.status <> 'submitted' AND (NEW."providerRefundId", NEW."submittedAt") IS DISTINCT FROM (OLD."providerRefundId", OLD."submittedAt")) THEN
    RAISE EXCEPTION 'refund recovery: attempt % may change only by a status transition with its own columns', OLD.id
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_attempt_update';
  END IF;
  RETURN NEW;
END $$;

-- F2, at commit: that transition is the recovery application of a stored answer of THIS attempt, its provider and key, with the answer's own values
CREATE FUNCTION refund_recovery_attempt_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT refund_is_recovery_session() THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM refund_dispatch_application p JOIN refund_dispatch_observation o ON o.id = p."observationId" AND o."refundAttemptId" = p."refundAttemptId"
                   JOIN refund_dispatch_send s ON s.id = o."sendId" AND s."refundAttemptId" = o."refundAttemptId"
                  WHERE p."refundAttemptId" = NEW.id AND p."appliedBy" = 'recovery' AND p."appliedAt" >= transaction_timestamp() AND p.effect = 'transitioned'
                    AND p."attemptStatusBefore" = OLD.status AND p."attemptStatusAfter" = NEW.status
                    AND s.provider = NEW.provider AND s."idempotencyKey" = NEW.id::text AND s."paymentId" = NEW."paymentId"
                    AND (NEW.status <> 'failed' OR o."providerCode" = NEW."failureCode")
                    AND (NEW.status <> 'submitted' OR NEW."providerRefundId" IS NOT DISTINCT FROM COALESCE(OLD."providerRefundId", o."providerRefundId"))) THEN
    RAISE EXCEPTION 'refund recovery: attempt % moved % -> % without the recovery application of its own stored answer', NEW.id, OLD.status, NEW.status
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_transition_evidence';
  END IF;
  RETURN NULL;
END $$;

-- a recovery session never updates a payment (it locks the row only)
CREATE FUNCTION refund_recovery_payment_update_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_is_recovery_session() THEN
    RAISE EXCEPTION 'refund recovery: payment % is never updated by recovery', OLD.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_payment_update';
  END IF;
  RETURN NEW;
END $$;

-- F1: a recovery session writes only the D-R1A escalation of a preserved contradiction, and only in that application's transaction
CREATE FUNCTION refund_recovery_escalation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_is_recovery_session() AND NEW.kind IS DISTINCT FROM 'failure_after_refund_evidence' THEN
    RAISE EXCEPTION 'refund recovery: escalation kind % is not recovery''s', NEW.kind USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_escalation';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION refund_recovery_escalation_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_is_recovery_session() AND NOT refund_recovery_applied_here(NEW."refundAttemptId", 'preserved_contradiction', NULL, NULL) THEN
    RAISE EXCEPTION 'refund recovery: escalation % without the preserved contradiction it records', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_escalation';
  END IF;
  RETURN NULL;
END $$;

-- F1: a recovery session's outbox rows are exactly the audit intents of its own decision, byte for byte the payload the database derives from the
-- stored rows (attempt, payment, escalation), unpublished, at database time, at most one per action and resource in the transaction. No other
-- event (never a Payment domain event such as payment.succeeded or refund.case_completed). The event id is the writer's deterministic id; it is
-- not recomputed here (no SHA-1 in core PostgreSQL), so its uniqueness per transaction is checked instead.
CREATE FUNCTION refund_recovery_outbox_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a refund_attempt%ROWTYPE; e refund_safety_escalation%ROWTYPE; org uuid; expected jsonb;
BEGIN
  IF NOT refund_is_recovery_session() THEN RETURN NEW; END IF;
  IF NEW.name NOT IN ('audit.refund_attempt.failed', 'audit.refund_safety.escalated')
     OR NEW."publishedAt" IS NOT NULL OR NEW.attempts <> 0 OR NEW."lastError" IS NOT NULL
     OR NEW."occurredAt" IS DISTINCT FROM now() OR NEW."availableAt" IS DISTINCT FROM now()
     OR (NEW."correlationId" IS NOT NULL AND NEW."correlationId" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
     OR NEW.payload->'resource'->>'type' IS DISTINCT FROM 'refund_attempt'
     OR COALESCE(NEW.payload->'resource'->>'id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'refund recovery: outbox event % is not one of its own audit intents', NEW.name USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox';
  END IF;
  SELECT * INTO a FROM refund_attempt WHERE id = (NEW.payload->'resource'->>'id')::uuid;
  SELECT "organizationId" INTO org FROM payment WHERE id = a."paymentId";
  IF NEW.name = 'audit.refund_attempt.failed' THEN
    expected := jsonb_build_object('actor', jsonb_build_object('id', 'payment_refund_worker', 'type', 'system'), 'action', 'refund_attempt.failed',
      'changes', jsonb_build_object('payment_id', a."paymentId", 'refund_case_id', a."refundCaseId"), 'outcome', 'succeeded',
      'resource', jsonb_build_object('id', a.id, 'type', 'refund_attempt'), 'companyId', a."companyId", 'organizationId', org);
    IF a.id IS NULL OR a.status <> 'failed' OR a."receiptId" IS NULL OR NEW."eventVersion" <> 2 OR NEW.payload IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'refund recovery: audit intent for attempt % does not match its stored failure', a.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox';
    END IF;
  ELSE
    SELECT * INTO e FROM refund_safety_escalation
     WHERE id::text = NEW.payload->'changes'->>'escalation_id' AND "refundAttemptId" = a.id AND kind = 'failure_after_refund_evidence';
    expected := jsonb_build_object('actor', jsonb_build_object('id', 'payment_refund_worker', 'type', 'system'), 'action', 'refund_safety.escalated',
      'changes', jsonb_build_object('escalation_id', e.id, 'kind', e.kind, 'payment_id', e."paymentId", 'attempt_status', e."attemptStatus")
                 || CASE WHEN e."factId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('fact_id', e."factId") END,
      'outcome', 'succeeded', 'resource', jsonb_build_object('id', a.id, 'type', 'refund_attempt'), 'organizationId', org);
    IF a.id IS NULL OR e.id IS NULL OR e."escalatedAt" < transaction_timestamp() OR NEW."eventVersion" <> 1 OR NEW.payload IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'refund recovery: audit intent for attempt % does not match an escalation of this transaction', a.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox';
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- F1, at commit: the intent's own decision committed with it, and it is the only one of its kind for that resource in this transaction
CREATE FUNCTION refund_recovery_outbox_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE attempt uuid;
BEGIN
  IF NOT refund_is_recovery_session() THEN RETURN NULL; END IF;
  attempt := (NEW.payload->'resource'->>'id')::uuid;
  IF NOT (CASE NEW.name WHEN 'audit.refund_attempt.failed' THEN refund_recovery_applied_here(attempt, 'transitioned', NULL, 'failed')
                        ELSE refund_recovery_applied_here(attempt, 'preserved_contradiction', NULL, NULL) END)
     OR (SELECT count(*) FROM outbox x WHERE x.name = NEW.name AND x.payload->'resource'->>'id' = NEW.payload->'resource'->>'id'
           AND x."occurredAt" = NEW."occurredAt" AND x."publishedAt" IS NULL) > 1 THEN
    RAISE EXCEPTION 'refund recovery: audit intent % for attempt % without its own decision in this transaction', NEW.name, attempt
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox_evidence';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER refund_attempt_00_recovery_update BEFORE UPDATE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_recovery_attempt_update_guard();
CREATE CONSTRAINT TRIGGER refund_attempt_30_recovery_commit AFTER UPDATE ON refund_attempt DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_recovery_attempt_commit_check();
CREATE TRIGGER payment_00_recovery_update BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION refund_recovery_payment_update_guard();
CREATE TRIGGER refund_safety_escalation_00_recovery BEFORE INSERT ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION refund_recovery_escalation_guard();
CREATE CONSTRAINT TRIGGER refund_safety_escalation_30_recovery_commit AFTER INSERT ON refund_safety_escalation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_recovery_escalation_commit_check();
CREATE TRIGGER outbox_00_refund_recovery BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION refund_recovery_outbox_guard();
CREATE CONSTRAINT TRIGGER outbox_30_refund_recovery_commit AFTER INSERT ON outbox DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_recovery_outbox_commit_check();

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
  EXECUTE format('GRANT UPDATE (status, "failureCode", "completedAt", "providerRefundId", "submittedAt") ON refund_attempt TO %s', r); -- never "workAfter" (F4)
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
