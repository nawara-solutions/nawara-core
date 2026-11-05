-- Core V2 S0-C12 item 16 (register PAY-05). DEVELOPMENT AND SIMULATION ONLY. EXPAND ONLY: one new table; no existing row changes; nothing is backfilled or repaired.
--
-- An authenticated capture observation whose currency no fact can hold is quarantined: durable evidence, NOT a fact. It has no financial effect: no settlement,
-- late success, refund route, entitlement or recovery allocation reads this table. The authenticated notification itself stays immutable in `webhook_event`
-- (`rawBody`, the source of truth); this row states what was wrong with it and keeps the exact JSON values. They are bytes because PostgreSQL `text` and `jsonb`
-- can't hold every value a provider can send (U+0000): nothing is truncated, normalized or invented. A status read has no stored notification, so here this
-- row is its only evidence. `investigationState` has one value because no contract yet lets anyone act on one: Owner visibility and reconciliation need a separately
-- approved policy (O-2; S0-C12 item 19, B4). The row is append-only: reconciling it later adds a record, it never edits this one.

CREATE TABLE provider_observation_quarantine (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider             text NOT NULL,
  source               text NOT NULL,
  "webhookEventId"     uuid UNIQUE REFERENCES webhook_event (id),   -- the stored, authenticated notification: one record per notification, whatever the redeliveries
  "providerEventId"    text,                                        -- the provider's own event identity, as authenticated
  "attemptId"          uuid REFERENCES payment_attempt (id),        -- only when the reference names one of this provider's attempts
  "paymentId"          uuid REFERENCES payment (id),
  "providerTxnId"      text,
  classification       text NOT NULL,
  "currencyShape"      text NOT NULL,
  "currencyEvidence"   bytea,                                       -- the exact JSON value; NULL only when the message has none
  "amountShape"        text NOT NULL,
  "amountEvidence"     bytea,                                       -- the exact JSON value; NULL only when the message has none. Both defects are kept (item 18)
  "evidenceDigest"     text NOT NULL,
  "investigationState" text NOT NULL DEFAULT 'held',
  "observedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_observation_quarantine_source CHECK (source IN ('webhook', 'status_check')),
  CONSTRAINT provider_observation_quarantine_event CHECK ((source = 'webhook') = ("webhookEventId" IS NOT NULL) AND (source = 'webhook') = ("providerEventId" IS NOT NULL)),
  CONSTRAINT provider_observation_quarantine_status_read CHECK (source = 'webhook' OR "attemptId" IS NOT NULL),
  CONSTRAINT provider_observation_quarantine_classification CHECK (classification = 'invalid_currency'),
  CONSTRAINT provider_observation_quarantine_currency_shape CHECK ("currencyShape" IN ('missing', 'null', 'non_string', 'empty', 'overlength', 'unstorable')),
  CONSTRAINT provider_observation_quarantine_currency_evidence CHECK (("currencyShape" = 'missing') = ("currencyEvidence" IS NULL)),
  CONSTRAINT provider_observation_quarantine_amount_shape CHECK ("amountShape" IN ('present', 'missing', 'invalid')),
  CONSTRAINT provider_observation_quarantine_amount_evidence CHECK (("amountShape" = 'missing') = ("amountEvidence" IS NULL)),
  CONSTRAINT provider_observation_quarantine_digest CHECK ("evidenceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provider_observation_quarantine_state CHECK ("investigationState" = 'held')
);
-- A status read has no notification id, and the resolver may ask again: the same answer for one attempt is one record; a different answer is its own
CREATE UNIQUE INDEX provider_observation_quarantine_status_read_once ON provider_observation_quarantine ("attemptId", "evidenceDigest") WHERE source = 'status_check';
CREATE INDEX provider_observation_quarantine_payment_idx ON provider_observation_quarantine ("paymentId") WHERE "paymentId" IS NOT NULL;
CREATE TRIGGER provider_observation_quarantine_10_append_only BEFORE UPDATE OR DELETE ON provider_observation_quarantine FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER provider_observation_quarantine_11_no_truncate BEFORE TRUNCATE ON provider_observation_quarantine FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON provider_observation_quarantine FROM PUBLIC;
  FOR r IN
    SELECT a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'provider_observation_quarantine' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE %s ON provider_observation_quarantine FROM %s', r.priv, r.role);
  END LOOP;
END $$;
