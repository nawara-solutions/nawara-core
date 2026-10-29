-- Core V2 S6c (register BIL-24, BIL-25, EVT-02; S0 FC-3, V-3; the Owner's R6C-9, R6C-10, R6C-12, 2026-10-29), for Core V2 DEVELOPMENT AND
-- SIMULATION ONLY. Billing completes a refund case, once, from Payment's authoritative financial completion: its verified
-- `refund.case_completed` event, or Payment's status read (PAY-08) when that event is lost. Expand only: one table, one widened CHECK, one
-- unique key on the relay, one replaced transition guard. No existing row changes.
--
--   * `refund_case_completion`: the durable completion evidence S6d will consume exactly once (one per case, append-only), bound to the case,
--     its payment, the relay whose refund attempt Payment authorized, Payment's refund authorization, the case's full amount and currency,
--     and Payment's completion time. `source` says how Billing learned it (`event`, with the verified event id, or `reconciliation`).
--   * The S6a transition guard reserved `open -> completed`; it is now admitted only together with this evidence and its exact time.
--   * Nothing here reverses a purchase, changes an entitlement or opens or discharges an obligation (S6d).

ALTER TABLE payment_event_origin DROP CONSTRAINT payment_event_origin_name;
ALTER TABLE payment_event_origin ADD CONSTRAINT payment_event_origin_name CHECK ("eventName" IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired',
  'refund.case_completed'));

ALTER TABLE refund_authorization_relay ADD CONSTRAINT refund_authorization_relay_case_binding UNIQUE (id, "refundCaseId");

CREATE TABLE refund_case_completion (
  "refundCaseId"            uuid PRIMARY KEY,
  "paymentId"               uuid NOT NULL,
  "refundAttemptId"         uuid NOT NULL,                  -- the relay Billing recorded (Payment's refund attempt id)
  "refundAuthorizationId"   uuid NOT NULL UNIQUE,           -- Payment's authorization that completed
  "approvedAmount"          bigint NOT NULL,
  currency                  char(3) NOT NULL,
  "completedAt"             timestamptz NOT NULL,           -- Payment's financial completion time
  source                    text NOT NULL,
  "eventId"                 uuid UNIQUE,
  "recordedAt"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_case_completion_case FOREIGN KEY ("refundCaseId", "paymentId") REFERENCES refund_case (id, "paymentId"),
  CONSTRAINT refund_case_completion_relay FOREIGN KEY ("refundAttemptId", "refundCaseId") REFERENCES refund_authorization_relay (id, "refundCaseId"),
  CONSTRAINT refund_case_completion_source CHECK ((source = 'event') = ("eventId" IS NOT NULL) AND source IN ('event', 'reconciliation')),
  CONSTRAINT refund_case_completion_amount CHECK ("approvedAmount" > 0 AND "approvedAmount" <= 9007199254740991)
);

-- the evidence is the case's own full amount and currency, for an OPEN case
CREATE FUNCTION billing_refund_case_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c refund_case%ROWTYPE;
BEGIN
  SELECT * INTO c FROM refund_case WHERE id = NEW."refundCaseId";
  IF c.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'refund case % is not open', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_completion_case_open';
  END IF;
  IF c.amount <> NEW."approvedAmount" OR c.currency <> NEW.currency THEN
    RAISE EXCEPTION 'refund case %: the completion is not its full amount and currency', NEW."refundCaseId" USING ERRCODE = '23514', CONSTRAINT = 'refund_case_completion_full_amount';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER refund_case_completion_05_guard BEFORE INSERT ON refund_case_completion FOR EACH ROW EXECUTE FUNCTION billing_refund_case_completion_guard();
CREATE TRIGGER refund_case_completion_10_append_only BEFORE UPDATE OR DELETE ON refund_case_completion FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER refund_case_completion_11_no_truncate BEFORE TRUNCATE ON refund_case_completion FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- S6a reserved completion; S6c admits it only with Payment's recorded completion, at exactly its time
CREATE OR REPLACE FUNCTION billing_refund_case_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'cancelled' AND NEW."completedAt" IS NULL THEN
    NEW."cancelledAt" := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'completed' THEN
    IF NOT EXISTS (SELECT 1 FROM refund_case_completion r WHERE r."refundCaseId" = OLD.id AND r."completedAt" = NEW."completedAt") THEN
      RAISE EXCEPTION 'refund case %: completion needs Payment''s recorded completion', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'refund_case_completion_evidence';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'refund case % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'refund_case_not_open';
END $$;

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_case_completion FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'refund_case_completion' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON refund_case_completion FROM %s', r.role);
  END LOOP;
END $$;
