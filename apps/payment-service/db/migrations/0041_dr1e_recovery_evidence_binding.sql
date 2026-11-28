-- 0041 — payment-service: every write of a refund-recovery session is bound to stored evidence (Core V2 D-R1E F1-F6; the Owner's GO of 2026-11-28
-- after the acceptance review of PR #553, whose migration 0040 is merged unchanged). DEVELOPMENT AND SIMULATION ONLY. AUTHORITY ONLY: no refund,
-- dispatch, replacement, finality-eligibility, allocation, case, hold or release rule changes; no existing row is rewritten; nothing is backfilled;
-- no event type or event contract changes.
--
-- 0040 separated the recovery identity (registry, derived "appliedBy", no finality, send or answer authority) but still let a recovery session:
-- insert ANY outbox event (Payment domain events Billing consumes), apply a false `no_effect`, change an attempt's state without a stored answer, and
-- write "workAfter". The acceptance review and Codex round 3 found more. This migration binds every recovery write to stored evidence:
--   * F2: a recovery session changes an attempt only by a status transition, with that transition's own columns at database time, matched AT COMMIT
--     by its own recovery application of a stored answer of that attempt, provider and key (failure code and provider reference included). A
--     recovered failure must also write its audit intent in the same transaction.
--   * F3 (both roles): an application's effect is the one the approved decision gives this answer from this status; `transitioned` needs the attempt
--     row updated by the same transaction; `preserved_contradiction` needs the attempt's own verified refund fact and its D-R1A row.
--   * F1: a recovery session's outbox rows are only its two audit intents (audit.refund_attempt.failed, audit.refund_safety.escalated), byte-exact to
--     the payload derived from the stored rows, unpublished, at database time, one per resource per transaction, with their own decision; never a
--     domain event; never updated, deleted or truncated. Its escalations are only the D-R1A kind, with the stored answer's code and their own intent.
--     The writer's deterministic event id is not recomputed (no SHA-1 in core PostgreSQL); its uniqueness per transaction is checked instead.
--   * F4: a recovery session never updates a payment and never writes "workAfter" (the column grant is withdrawn from every registered role).
--   * "This transaction" is proven by row ownership (xmin = this transaction's id), never by a time comparison (Codex round 3). Rows written in a
--     subtransaction carry another id and fail closed; the recovery process uses none.
--   * Codex review of b954a3e: every row a recovery session writes must belong to the top-level transaction (no subtransaction duplicates); a
--     session that switched INTO a recovery role writes nothing; a `transitioned` application names a real status change of the same transaction,
--     recorded by trigger in the append-only `refund_attempt_status_change` (both roles).
-- Remaining trust (recorded): the runtime role (the service that made the provider call), the schema owner and superusers.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── identity at write time and real transitions

-- Codex review of b954a3e (P2): a login that is NOT a registered recovery role but switches INTO one (SET ROLE, a later membership) could write as
-- recovery and RESET ROLE before commit, so the commit checks would no longer see a recovery session. Recovery writes are therefore refused at
-- write time unless the LOGIN itself is the registered role (session_user cannot change inside a session without superuser rights).
CREATE FUNCTION refund_recovery_switched_into() RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refund_recovery_role r WHERE r.role = (SELECT oid FROM pg_roles WHERE rolname = current_user))
     AND NOT EXISTS (SELECT 1 FROM refund_recovery_role r WHERE r.role = (SELECT oid FROM pg_roles WHERE rolname = session_user))
$$;
CREATE FUNCTION refund_recovery_refuse_switched() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_recovery_switched_into() THEN
    RAISE EXCEPTION 'refund recovery: a session switched into a recovery role (% as %) writes nothing', session_user, current_user
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_switched_role';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Codex review of b954a3e (P2): a `transitioned` application must name a REAL status change of this transaction, not any update of the row (a
-- bookkeeping update such as "workAfter" proved only that the row changed). Every status change is recorded here by trigger, append-only, and
-- nothing else may write a row: a direct insert runs this table's guard at trigger depth 1, the recording trigger's insert at depth 2.
CREATE TABLE refund_attempt_status_change (
  "refundAttemptId"  uuid NOT NULL REFERENCES refund_attempt (id),
  "fromStatus"       text NOT NULL,
  "toStatus"         text NOT NULL,
  "changedAt"        timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX refund_attempt_status_change_attempt ON refund_attempt_status_change ("refundAttemptId");
CREATE FUNCTION refund_attempt_status_change_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'refund_attempt_status_change: recorded only by the status trigger' USING ERRCODE = '42501', CONSTRAINT = 'refund_attempt_status_change_origin';
  END IF;
  NEW."changedAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE FUNCTION refund_attempt_record_status_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO refund_attempt_status_change ("refundAttemptId", "fromStatus", "toStatus") VALUES (NEW.id, OLD.status, NEW.status);
  RETURN NULL;
END $$;
CREATE TRIGGER refund_attempt_status_change_05_guard BEFORE INSERT ON refund_attempt_status_change FOR EACH ROW EXECUTE FUNCTION refund_attempt_status_change_guard();
CREATE TRIGGER refund_attempt_status_change_10_append_only BEFORE UPDATE OR DELETE ON refund_attempt_status_change FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_attempt_status_change_11_no_truncate BEFORE TRUNCATE ON refund_attempt_status_change FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_attempt_40_record_status_change AFTER UPDATE OF status ON refund_attempt
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION refund_attempt_record_status_change();
DO $$
DECLARE x record;
BEGIN
  REVOKE ALL ON refund_attempt_status_change FROM PUBLIC;
  FOR x IN SELECT a.grantee::regrole::text AS role, a.privilege_type AS priv FROM pg_class c, aclexplode(c.relacl) a
            WHERE c.oid = 'refund_attempt_status_change'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0 AND a.privilege_type NOT IN ('SELECT', 'INSERT')
  LOOP
    EXECUTE format('REVOKE %s ON refund_attempt_status_change FROM %s', x.priv, x.role);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── F3: the application guard (replaces 0040's)

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
     -- Codex round 3 / review of b954a3e: a `transitioned` application names a REAL status change of THIS transaction, from and to its statuses
     OR (NEW.effect = 'transitioned' AND NOT EXISTS (SELECT 1 FROM refund_attempt_status_change m WHERE m."refundAttemptId" = a.id
           AND m.xmin = pg_current_xact_id()::xid AND m."fromStatus" = NEW."attemptStatusBefore" AND m."toStatus" = NEW."attemptStatusAfter"))
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
-- against the stored rows. `applied_here`: the recovery application of this attempt was written by THIS
-- transaction: its row version's xmin is this transaction's id (Codex round 3: a time comparison orders, it does not prove ownership). Rows written
-- in a subtransaction carry another id, so they fail closed.

CREATE FUNCTION refund_recovery_applied_here(p_attempt uuid, p_effect text, p_before text, p_after text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refund_dispatch_application p
                   JOIN refund_dispatch_observation o ON o.id = p."observationId" AND o."refundAttemptId" = p."refundAttemptId"
                   JOIN refund_dispatch_send s ON s.id = o."sendId" AND s."refundAttemptId" = o."refundAttemptId"
                   JOIN refund_attempt a ON a.id = p."refundAttemptId" AND a."paymentId" = s."paymentId" AND a.provider = s.provider AND s."idempotencyKey" = a.id::text
                  WHERE p."refundAttemptId" = p_attempt AND p."appliedBy" = 'recovery' AND p.xmin = pg_current_xact_id()::xid -- written by THIS transaction
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
  -- review of b954a3e (P2): a recovery write in a subtransaction is refused (its row carries another id than this transaction's)
  IF (SELECT u.xmin FROM refund_attempt u WHERE u.id = NEW.id) IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'refund recovery: attempt % was changed in a subtransaction', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_subtransaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM refund_dispatch_application p JOIN refund_dispatch_observation o ON o.id = p."observationId" AND o."refundAttemptId" = p."refundAttemptId"
                   JOIN refund_dispatch_send s ON s.id = o."sendId" AND s."refundAttemptId" = o."refundAttemptId"
                  WHERE p."refundAttemptId" = NEW.id AND p."appliedBy" = 'recovery' AND p.xmin = pg_current_xact_id()::xid AND p.effect = 'transitioned'
                    AND p."attemptStatusBefore" = OLD.status AND p."attemptStatusAfter" = NEW.status
                    AND s.provider = NEW.provider AND s."idempotencyKey" = NEW.id::text AND s."paymentId" = NEW."paymentId"
                    AND (NEW.status <> 'failed' OR o."providerCode" = NEW."failureCode")
                    AND (NEW.status <> 'submitted' OR NEW."providerRefundId" IS NOT DISTINCT FROM COALESCE(OLD."providerRefundId", o."providerRefundId"))) THEN
    RAISE EXCEPTION 'refund recovery: attempt % moved % -> % without the recovery application of its own stored answer', NEW.id, OLD.status, NEW.status
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_transition_evidence';
  END IF;
  -- Codex round 3: a recovered failure is never silent: its own audit intent was written by this transaction (both directions are bound)
  IF NEW.status = 'failed' AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.name = 'audit.refund_attempt.failed' AND x.payload->'resource'->>'id' = NEW.id::text
                                             AND x.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'refund recovery: attempt % failed without its audit intent', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_transition_audit';
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
  IF refund_is_recovery_session() AND (SELECT w.xmin FROM refund_safety_escalation w WHERE w.id = NEW.id) IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'refund recovery: escalation % was written in a subtransaction', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_subtransaction';
  END IF;
  IF refund_is_recovery_session() AND NOT EXISTS (SELECT 1 FROM refund_dispatch_application p
       JOIN refund_dispatch_observation o ON o.id = p."observationId" AND o."refundAttemptId" = p."refundAttemptId"
      WHERE p."refundAttemptId" = NEW."refundAttemptId" AND p."appliedBy" = 'recovery' AND p.effect = 'preserved_contradiction'
        AND p.xmin = pg_current_xact_id()::xid AND o."providerCode" IS NOT DISTINCT FROM NEW."observedFailureCode") THEN
    RAISE EXCEPTION 'refund recovery: escalation % without the preserved contradiction (and its code) it records', NEW.id
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_escalation';
  END IF;
  -- Codex round 3: and its audit intent, written by this transaction
  IF refund_is_recovery_session() AND NOT EXISTS (SELECT 1 FROM outbox x WHERE x.name = 'audit.refund_safety.escalated'
       AND x.payload->'changes'->>'escalation_id' = NEW.id::text AND x.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'refund recovery: escalation % without its audit intent', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_escalation_audit';
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
    IF a.id IS NULL OR e.id IS NULL OR NOT EXISTS (SELECT 1 FROM refund_safety_escalation w WHERE w.id = e.id AND w.xmin = pg_current_xact_id()::xid)
       OR NEW."eventVersion" <> 1 OR NEW.payload IS DISTINCT FROM expected THEN
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
  IF (SELECT x.xmin FROM outbox x WHERE x.id = NEW.id) IS DISTINCT FROM pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'refund recovery: outbox row % was written in a subtransaction', NEW.id USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_subtransaction';
  END IF;
  attempt := (NEW.payload->'resource'->>'id')::uuid;
  IF NOT (CASE NEW.name WHEN 'audit.refund_attempt.failed' THEN refund_recovery_applied_here(attempt, 'transitioned', NULL, 'failed')
                        ELSE refund_recovery_applied_here(attempt, 'preserved_contradiction', NULL, NULL) END)
     OR (SELECT count(*) FROM outbox x WHERE x.name = NEW.name AND x.payload->'resource'->>'id' = NEW.payload->'resource'->>'id'
           AND x.xmin = pg_current_xact_id()::xid) > 1 THEN
    RAISE EXCEPTION 'refund recovery: audit intent % for attempt % without its own decision in this transaction', NEW.name, attempt
      USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox_evidence';
  END IF;
  RETURN NULL;
END $$;

-- Codex round 3: whatever it is later granted, a recovery session never rewrites, re-schedules, marks published or erases an outbox row
CREATE FUNCTION refund_recovery_outbox_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF refund_is_recovery_session() THEN
    RAISE EXCEPTION 'refund recovery: outbox rows are never % by recovery', lower(TG_OP) USING ERRCODE = '42501', CONSTRAINT = 'refund_recovery_outbox';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER outbox_00_refund_recovery_immutable BEFORE UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION refund_recovery_outbox_immutable();
CREATE TRIGGER outbox_01_refund_recovery_no_truncate BEFORE TRUNCATE ON outbox FOR EACH STATEMENT EXECUTE FUNCTION refund_recovery_outbox_immutable();

CREATE TRIGGER refund_attempt_000_recovery_switched BEFORE UPDATE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_recovery_refuse_switched();
CREATE TRIGGER payment_000_recovery_switched BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION refund_recovery_refuse_switched();
CREATE TRIGGER refund_safety_escalation_000_recovery_switched BEFORE INSERT ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION refund_recovery_refuse_switched();
CREATE TRIGGER refund_dispatch_application_000_recovery_switched BEFORE INSERT ON refund_dispatch_application FOR EACH ROW EXECUTE FUNCTION refund_recovery_refuse_switched();
CREATE TRIGGER outbox_000_refund_recovery_switched BEFORE INSERT OR UPDATE OR DELETE ON outbox FOR EACH ROW EXECUTE FUNCTION refund_recovery_refuse_switched();

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

-- ─────────────────────────────────────────────────────────────────────────────────────────────── F4: the grant without scheduling (replaces 0040's)

CREATE OR REPLACE FUNCTION payment_grant_refund_recovery(r regrole) RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
  EXECUTE format('GRANT INSERT ON refund_dispatch_application, refund_safety_escalation, outbox, refund_attempt_status_change TO %s', r);
  -- registered: from now on its identity refuses it finality, sends and answers, whatever it is granted later
  INSERT INTO refund_recovery_role (role) VALUES (r::oid) ON CONFLICT (role) DO NOTHING;
END $$;
REVOKE EXECUTE ON FUNCTION payment_grant_refund_recovery(regrole) FROM PUBLIC;

-- the column grant 0040 gave every role registered so far is withdrawn (a registered role is refused it by identity in any case)
DO $$
DECLARE x record;
BEGIN
  FOR x IN SELECT r.rolname FROM refund_recovery_role g JOIN pg_roles r ON r.oid = g.role LOOP
    EXECUTE format('REVOKE UPDATE ("workAfter") ON refund_attempt FROM %I', x.rolname);
    EXECUTE format('GRANT SELECT, INSERT ON refund_attempt_status_change TO %I', x.rolname); -- its status changes are recorded as it writes them
  END LOOP;
END $$;
