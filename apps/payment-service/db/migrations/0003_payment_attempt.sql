-- One try to collect through one provider (SDD section 4.2, 5.2).

CREATE TABLE payment_attempt (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId"             uuid NOT NULL REFERENCES payment(id),
  "attemptNumber"         integer NOT NULL,
  provider                text NOT NULL,
  "merchantReference"     uuid GENERATED ALWAYS AS (id) STORED, -- sent to the provider as its idempotency/merchant reference
  "providerTransactionId" text,
  status                  text NOT NULL DEFAULT 'initiated',
  "failureCode"           text,
  "failureClass"          text,
  "failureInferred"       boolean NOT NULL DEFAULT false,
  "providerData"          jsonb,
  "initiatedAt"           timestamptz NOT NULL DEFAULT now(),
  "submittedAt"           timestamptz,
  "completedAt"           timestamptz,

  CONSTRAINT payment_attempt_number_positive CHECK ("attemptNumber" > 0),
  CONSTRAINT payment_attempt_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT payment_attempt_status_valid CHECK (status IN ('initiated', 'submitted', 'succeeded', 'failed', 'expired', 'unknown')),
  CONSTRAINT payment_attempt_failure_class_valid CHECK ("failureClass" IS NULL OR "failureClass" IN ('retryable', 'terminal', 'ambiguous')),
  CONSTRAINT payment_attempt_number_unique UNIQUE ("paymentId", "attemptNumber")
);

-- FI-09: a provider transaction id belongs to at most one attempt.
CREATE UNIQUE INDEX payment_attempt_provider_txn_unique ON payment_attempt (provider, "providerTransactionId") WHERE "providerTransactionId" IS NOT NULL;
-- "One open collection at a time" (SDD section 5.1): at most one attempt in initiated/submitted/unknown per payment.
CREATE UNIQUE INDEX payment_attempt_one_open ON payment_attempt ("paymentId") WHERE status IN ('initiated', 'submitted', 'unknown');
CREATE INDEX payment_attempt_payment_idx ON payment_attempt ("paymentId");

CREATE TRIGGER payment_attempt_immutable BEFORE UPDATE ON payment_attempt
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('paymentId', 'attemptNumber', 'provider', 'initiatedAt');

-- Defence in depth alongside application checks (SDD section 5.2).
CREATE FUNCTION payment_attempt_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('initiated', 'submitted'), ('initiated', 'failed'), ('initiated', 'unknown'),
      ('submitted', 'succeeded'), ('submitted', 'failed'), ('submitted', 'expired'),
      ('unknown', 'submitted'), ('unknown', 'succeeded'), ('unknown', 'failed')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  )
  -- Late success (section 5.1): an attempt failed by INFERENCE (a guess) can still succeed later; one that the
  -- provider itself confirmed as failed cannot (that is a real conflict, refused by the application layer already).
  AND NOT (OLD.status = 'failed' AND NEW.status = 'succeeded' AND OLD."failureInferred") THEN
    RAISE EXCEPTION 'payment_attempt % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_status_transition BEFORE UPDATE OF status ON payment_attempt
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION payment_attempt_status_transition_guard();

-- FI-03/FI-04: succeededAttemptId, once set, must belong to the SAME payment, reference a SUCCEEDED attempt, and never change again.
ALTER TABLE payment ADD CONSTRAINT payment_succeeded_attempt_fk FOREIGN KEY ("succeededAttemptId") REFERENCES payment_attempt(id);

CREATE FUNCTION payment_succeeded_attempt_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."succeededAttemptId" IS NOT NULL AND NEW."succeededAttemptId" IS DISTINCT FROM OLD."succeededAttemptId" THEN
    RAISE EXCEPTION 'payment %: succeededAttemptId is set once and cannot change', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW."succeededAttemptId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_attempt WHERE id = NEW."succeededAttemptId" AND "paymentId" = NEW.id AND status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'payment %: succeededAttemptId % must reference a succeeded attempt of the same payment', NEW.id, NEW."succeededAttemptId" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_succeeded_attempt_integrity BEFORE UPDATE OF "succeededAttemptId" ON payment
  FOR EACH ROW WHEN (NEW."succeededAttemptId" IS DISTINCT FROM OLD."succeededAttemptId") EXECUTE FUNCTION payment_succeeded_attempt_integrity();
