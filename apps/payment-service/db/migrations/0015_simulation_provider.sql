-- Core V2 S4f (register PAY-14; S0 §1.1, FC-10; the Owner's OD-06 decisions F-S1 to F-S7), for Core V2 DEVELOPMENT AND SIMULATION
-- CERTIFICATION ONLY. The `simulation` provider's OWN records: what the simulated provider was told to answer, by the authorized harness.
-- This is provider-side state, not Payment's evidence: Payment still learns every outcome only through its existing authenticated paths (a
-- signature-verified webhook, the provider status read), and only those become attempt state and S4d provider facts.
--
--   * One row per harness command (F-S6), its `commandId` the caller's stable identity: an identical replay is answered from the row and
--     changes nothing; reusing an identity with other content is refused by the application; distinct commands may follow one another on
--     one attempt (sequential observations). A notification's provider event id is `sim_<commandId>`, so redelivering it is deduplicated by
--     the existing permanent `webhook_event (provider, providerEventId)` key.
--   * An outcome command is bound to an attempt OF THE SIMULATION PROVIDER and its payment (one composite key); amounts, currency and the
--     provider transaction reference are derived by Payment from that payment's snapshot, never supplied by the caller.
--   * Nothing writes this table in production: the harness route is not mounted there, the provider cannot be enabled there, and the
--     service refuses the operation if reached. Append-only; the runtime role holds INSERT and SELECT only.
-- Expand only: one table, its triggers and grants. No existing row changes.

CREATE TABLE simulation_provider_command (
  "commandId"      text PRIMARY KEY,
  kind             text NOT NULL,                 -- `initiation` (how the provider answers a payment's attempts) or `outcome` (one attempt)
  "paymentId"      uuid NOT NULL REFERENCES payment (id),
  "attemptId"      uuid,
  provider         text NOT NULL DEFAULT 'simulation',
  instruction      text NOT NULL,
  "failureCode"    text,
  amount           bigint,                        -- server-derived: the snapshot amount (for amount_mismatch, one minor unit away from it)
  currency         text,
  "providerTxnId"  text,
  "eventBody"      bytea,                         -- the notification this command produced, when it produces one (signed at delivery)
  delivery         text,                          -- `immediate` (delivered when recorded) or `held` (delivered later, on request)
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  seq              bigint GENERATED ALWAYS AS IDENTITY UNIQUE, -- the order the provider saw its commands in

  CONSTRAINT simulation_provider_command_id_shape CHECK ("commandId" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT simulation_provider_command_provider CHECK (provider = 'simulation'),
  CONSTRAINT simulation_provider_command_binding FOREIGN KEY ("attemptId", "paymentId", provider) REFERENCES payment_attempt (id, "paymentId", provider),
  CONSTRAINT simulation_provider_command_kind CHECK (
       (kind = 'initiation' AND "attemptId" IS NULL AND instruction IN ('accepted', 'ambiguous', 'rejected') AND amount IS NULL AND "eventBody" IS NULL)
    OR (kind = 'outcome' AND "attemptId" IS NOT NULL
        AND instruction IN ('succeeded', 'amount_mismatch', 'failed', 'expired', 'no_record', 'pending'))),
  CONSTRAINT simulation_provider_command_failure_code CHECK (("failureCode" IS NOT NULL) = (instruction IN ('rejected', 'failed'))
    AND ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$')),
  CONSTRAINT simulation_provider_command_money CHECK ((instruction IN ('succeeded', 'amount_mismatch')) = (amount IS NOT NULL AND currency IS NOT NULL)
    AND (amount IS NULL OR (amount > 0 AND amount <= 9007199254740991))),
  CONSTRAINT simulation_provider_command_event CHECK ((instruction IN ('succeeded', 'amount_mismatch', 'failed', 'expired')) = ("eventBody" IS NOT NULL)
    AND ("eventBody" IS NULL) = (delivery IS NULL) AND (delivery IS NULL OR delivery IN ('immediate', 'held'))),
  CONSTRAINT simulation_provider_command_txn CHECK ((kind = 'outcome') = ("providerTxnId" IS NOT NULL))
);
CREATE INDEX simulation_provider_command_attempt_idx ON simulation_provider_command ("attemptId", seq);
CREATE INDEX simulation_provider_command_payment_idx ON simulation_provider_command ("paymentId", seq);

CREATE FUNCTION simulation_provider_command_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER simulation_provider_command_05_insert_guard BEFORE INSERT ON simulation_provider_command FOR EACH ROW EXECUTE FUNCTION simulation_provider_command_insert_guard();

CREATE FUNCTION simulation_provider_command_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'simulation_provider_command is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER simulation_provider_command_10_append_only BEFORE UPDATE OR DELETE ON simulation_provider_command FOR EACH ROW EXECUTE FUNCTION simulation_provider_command_append_only();
CREATE TRIGGER simulation_provider_command_11_no_truncate BEFORE TRUNCATE ON simulation_provider_command FOR EACH STATEMENT EXECUTE FUNCTION simulation_provider_command_append_only();

DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON simulation_provider_command FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'simulation_provider_command' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON simulation_provider_command FROM %s', r.role);
  END LOOP;
END $$;
