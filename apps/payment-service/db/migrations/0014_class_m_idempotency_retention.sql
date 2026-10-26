-- Core V2 S4g (register PAY-15; S0 §3.7; [OD] D7): class-M money-command idempotency. Every header-based idempotency record payment-service
-- keeps belongs to a money command (starting an attempt, cancelling a payment's collection), so every one is class M: retained for 90
-- days, set by the database and never shortened. This replaces the configurable `IDEMPOTENCY_TTL_HOURS` ceiling (default 24, max 720).
--
--   * Retention: `expiresAt` is exactly `createdAt + 90 days`, both the database's own clock, whatever an INSERT supplies.
--   * A record is never rewritten (its stored outcome, hash and window are what a replay answers), and never deleted inside its window.
--     Nothing deletes records today; a later, separately authorized purge may remove only expired ones.
--   * Permanent uniqueness behind it (PAY-15 A): a payment by `(producer, paymentRequestId)` (0002, permanent); a collection by one open
--     attempt per payment, no new attempt while one may still settle it, and one succeeded attempt per payment (0003, 0006, 0012) — so a
--     key that ages out can never yield a second collection.
--   * Records written before S4g keep their stored window: nothing is backfilled (the replay lookup never reads `expiresAt` anyway).
-- Expand only: two triggers.

CREATE FUNCTION idempotency_key_class_m_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := now();
  NEW."expiresAt" := NEW."createdAt" + interval '90 days';
  RETURN NEW;
END $$;
CREATE TRIGGER idempotency_key_05_class_m_retention BEFORE INSERT ON idempotency_key FOR EACH ROW EXECUTE FUNCTION idempotency_key_class_m_retention();

CREATE FUNCTION idempotency_key_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'idempotency_key: a stored money-command outcome is never rewritten' USING ERRCODE = '23514', CONSTRAINT = 'idempotency_key_immutable';
  END IF;
  IF OLD."expiresAt" > now() THEN
    RAISE EXCEPTION 'idempotency_key: a money-command record is kept for its whole 90-day window' USING ERRCODE = '23514', CONSTRAINT = 'idempotency_key_retained';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER idempotency_key_10_retained BEFORE UPDATE OR DELETE ON idempotency_key FOR EACH ROW EXECUTE FUNCTION idempotency_key_retained();
