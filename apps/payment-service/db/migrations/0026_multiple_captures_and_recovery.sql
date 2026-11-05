-- Core V2 S0-C12 items 14 and 15 and FN-2 Option A (register PAY-02, PAY-05, PAY-07, PAY-12). DEVELOPMENT AND SIMULATION ONLY. EXPAND ONLY.
--
--   * Item 14(b), (c): a late success of an ambiguous attempt (more than one capture fact, contested or not) is refused, so direct SQL can't bypass it.
--   * FN-2: a late success is recorded only at terminal finality: the payment holds that status now, and it is `failed`, `cancelled` or `expired`, or
--     `succeeded` for another attempt's capture (S4c F-4). A capture seen while the payment is non-final stays a fact; the finality writer decides it.
--   * Item 14(d), (e): a provider permission record, default-deny. Only `refund_independent`, only `simulation` and `test`: a late-success permission or a
--     real provider can't even be written without a reviewed migration, and the runtime role can't write here at all.
--   * Item 14(d): a capture-specific refund attempt of an ambiguous attempt without that permission is refused.
--   * Item 15: durable per-fact recovery state. Exhaustion stops retries; it never touches or abandons the fact.
--
-- Every guard runs on insert only: no existing row is changed, deleted or reinterpreted, and nothing is backfilled. A late success already recorded with a
-- non-final status (before this migration) stays exactly as it is: see the S0-C12 record for its disposition.

CREATE TABLE provider_capture_permission (
  seq            bigserial PRIMARY KEY,
  provider       text NOT NULL,
  permission     text NOT NULL,
  effect         text NOT NULL,
  "approvalRef"  text NOT NULL,
  scope          text NOT NULL,
  "recordedAt"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_capture_permission_provider CHECK (provider IN ('simulation', 'test')),
  CONSTRAINT provider_capture_permission_kind CHECK (permission = 'refund_independent'),
  CONSTRAINT provider_capture_permission_effect CHECK (effect IN ('grant', 'withdraw')),
  CONSTRAINT provider_capture_permission_scope CHECK (scope = 'simulation')
);
CREATE INDEX provider_capture_permission_latest_idx ON provider_capture_permission (provider, seq DESC);
CREATE TRIGGER provider_capture_permission_10_append_only BEFORE UPDATE OR DELETE ON provider_capture_permission
  FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER provider_capture_permission_11_no_truncate BEFORE TRUNCATE ON provider_capture_permission
  FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
INSERT INTO provider_capture_permission (provider, permission, effect, "approvalRef", scope) VALUES
  ('simulation', 'refund_independent', 'grant', 'S0-C12 item 14(e), Owner P2, 2026-11-04', 'simulation'),
  ('test', 'refund_independent', 'grant', 'S0-C12 item 14(e), Owner P2, 2026-11-04', 'simulation');

-- Default-deny: no row, or a latest row that withdraws, is no permission.
CREATE FUNCTION payment_provider_refund_permitted(p_provider text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT effect = 'grant' FROM provider_capture_permission WHERE provider = p_provider AND permission = 'refund_independent'
                    ORDER BY seq DESC LIMIT 1), false);
$$;

CREATE OR REPLACE FUNCTION payment_late_success_fact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status text;
BEGIN
  IF NEW."factId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM provider_transaction_fact f
     WHERE f.id = NEW."factId" AND f.kind = 'capture' AND f."attemptId" = NEW."attemptId" AND f."paymentId" = NEW."paymentId"
       AND f.amount = NEW.amount AND trim(f.currency) = trim(NEW.currency)
       AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
  ) THEN
    RAISE EXCEPTION 'payment_late_success: its fact is missing, for another attempt or payment, different or contested'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_fact_binding';
  END IF;
  SELECT status INTO current_status FROM payment WHERE id = NEW."paymentId";
  IF current_status NOT IN ('succeeded', 'failed', 'cancelled', 'expired') OR NEW."paymentStatus" IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'payment_late_success: recorded only at terminal finality, with the status the payment holds'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_not_final';
  END IF;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact g WHERE g."attemptId" = NEW."attemptId" AND g.kind = 'capture' AND g.id <> NEW."factId") THEN
    RAISE EXCEPTION 'payment_late_success: its attempt holds more than one capture fact'
      USING ERRCODE = '23514', CONSTRAINT = 'payment_late_success_ambiguous_attempt';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION refund_attempt_ambiguous_capture_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."captureSpecific" AND (SELECT count(*) FROM provider_transaction_fact g
       WHERE g."attemptId" = NEW."capturedAttemptId" AND g."paymentId" = NEW."paymentId" AND g.kind = 'capture') > 1
     AND NOT payment_provider_refund_permitted(NEW.provider) THEN
    RAISE EXCEPTION 'refund_attempt: a capture of an ambiguous attempt needs the provider''s refund permission'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_ambiguous_capture';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_05b_ambiguous_capture BEFORE INSERT ON refund_attempt
  FOR EACH ROW EXECUTE FUNCTION refund_attempt_ambiguous_capture_guard();

-- Item 14(d): an intent that met an ambiguity before its receipt was consumed ends refused, with this reason
ALTER TABLE refund_attempt DROP CONSTRAINT refund_attempt_refusal_shape;
ALTER TABLE refund_attempt ADD CONSTRAINT refund_attempt_refusal_shape CHECK (
  (status IN ('authorization_expired', 'authorization_refused')) = ("authorizationRefusal" IS NOT NULL)
  AND ("authorizationRefusal" IS NULL OR "authorizationRefusal" IN ('receipt_invalid', 'receipt_binding_invalid', 'receipt_expired', 'refund_capture_not_eligible'))
  AND (status <> 'authorization_expired' OR "authorizationRefusal" = 'receipt_expired')
  AND (status <> 'authorization_refused' OR "authorizationRefusal" <> 'receipt_expired'));

CREATE TABLE capture_recovery_state (
  "factId"       uuid PRIMARY KEY REFERENCES provider_transaction_fact (id),
  attempts       integer NOT NULL,
  "workAfter"    timestamptz,
  "lastFailure"  text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  "firstFailedAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt"    timestamptz NOT NULL DEFAULT now(),
  "endedAt"      timestamptz,
  CONSTRAINT capture_recovery_state_attempts CHECK (attempts BETWEEN 1 AND 12),
  CONSTRAINT capture_recovery_state_status CHECK (status IN ('active', 'exhausted', 'refused')),
  CONSTRAINT capture_recovery_state_failure CHECK ("lastFailure" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT capture_recovery_state_shape CHECK ((status = 'active') = ("workAfter" IS NOT NULL) AND (status = 'active') = ("endedAt" IS NULL))
);
CREATE INDEX capture_recovery_state_due_idx ON capture_recovery_state ("workAfter") WHERE status = 'active';
-- Terminal states are terminal here: no route or worker reactivates them (reactivation needs a separate security contract decision, item 15)
CREATE FUNCTION capture_recovery_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'capture_recovery_state is never deleted' USING ERRCODE = '23514', CONSTRAINT = 'capture_recovery_state_kept';
  END IF;
  IF OLD.status <> 'active' OR NEW.attempts < OLD.attempts OR NEW."firstFailedAt" <> OLD."firstFailedAt" OR NEW."factId" <> OLD."factId" THEN
    RAISE EXCEPTION 'capture_recovery_state: history only moves forward' USING ERRCODE = '23514', CONSTRAINT = 'capture_recovery_state_kept';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_recovery_state_10_guard BEFORE UPDATE OR DELETE ON capture_recovery_state FOR EACH ROW EXECUTE FUNCTION capture_recovery_state_guard();
CREATE TRIGGER capture_recovery_state_11_no_truncate BEFORE TRUNCATE ON capture_recovery_state FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON provider_capture_permission FROM PUBLIC;
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON capture_recovery_state FROM PUBLIC;
  FOR r IN
    SELECT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE a.grantee <> c.relowner AND a.grantee <> 0
       AND ((c.relname = 'provider_capture_permission' AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'))
         OR (c.relname = 'capture_recovery_state' AND a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
