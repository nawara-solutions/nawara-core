-- Core V2 S4a (register PAY-01; S0 §3.2 DB-15, S-6, FC-10; ADR-0044 B2 and B7; the Owner's S4a decisions P-1 to P-8), for Core V2
-- DEVELOPMENT AND SIMULATION ONLY. Additive only: new nullable columns, CHECKs every existing row satisfies, insert guards and
-- immutability triggers. No existing row is changed or backfilled.
--
--   * purpose (P-1): the producer's immutable settlement purpose, the Billing routing purpose of ADR-0044 B2. DB-15: an Organization pays
--     if and only if the purpose is `assisted_settlement` or `recovery_settlement` (both enforced here; the API does not accept them yet,
--     P-5). B2's payer column: an Organization subscription and a direct purchase are paid by a user; `non_entitlement` by a user or a
--     Company (never an Organization: the Owner's prospective B2 narrowing, P-1).
--   * beneficiaryUserId (P-3): present exactly for `direct_purchase` (the payer) and `assisted_settlement`; absent otherwise.
--   * liveMode (P-6): every NEW payment and attempt carries it; Core V2 is simulation only, so the only admitted value is `false`. A later
--     real-provider stage widens this under its own authorization and migration. An attempt has its payment's mode.
--   * Historical rows (before S4a) keep NULL in all three: they are never re-interpreted as purpose-bearing records, and every new row
--     must carry purpose and liveMode (insert guards).
--   * Immutable once requested (S-6): purpose, beneficiaryUserId and liveMode join payer, seller, amount and currency (0002).
-- No `platformId` (ADR-0042 Amendment 1 DEC-5: no Platform on Payment records).

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────────────── payment

ALTER TABLE payment
  ADD COLUMN purpose             text,
  ADD COLUMN "beneficiaryUserId" text,
  ADD COLUMN "liveMode"          boolean;

-- the default is set AFTER the column exists, so every existing row keeps NULL (never backfilled) and every new row is simulation
ALTER TABLE payment ALTER COLUMN "liveMode" SET DEFAULT false;

ALTER TABLE payment
  ADD CONSTRAINT payment_purpose_valid CHECK (purpose IS NULL OR purpose IN
    ('organization_subscription', 'direct_purchase', 'assisted_settlement', 'recovery_settlement', 'non_entitlement')),
  -- DB-15: payerType = 'organization' <=> purpose in {assisted_settlement, recovery_settlement}
  ADD CONSTRAINT payment_payer_purpose_pairing CHECK (purpose IS NULL
    OR (("payerType" = 'organization') = (purpose IN ('assisted_settlement', 'recovery_settlement')))),
  -- ADR-0044 B2: an Organization subscription and a direct purchase are paid by a user
  ADD CONSTRAINT payment_purpose_user_payer CHECK (purpose IS NULL OR purpose NOT IN ('organization_subscription', 'direct_purchase') OR "payerType" = 'user'),
  -- ADR-0044 B2: a beneficiary exactly for a direct purchase (the buyer, who pays) and an assisted settlement (the consenting member)
  ADD CONSTRAINT payment_beneficiary_pairing CHECK (purpose IS NULL
    OR ((purpose IN ('direct_purchase', 'assisted_settlement')) = ("beneficiaryUserId" IS NOT NULL))),
  ADD CONSTRAINT payment_direct_purchase_beneficiary CHECK (purpose IS DISTINCT FROM 'direct_purchase' OR "beneficiaryUserId" = "payerId"),
  ADD CONSTRAINT payment_beneficiary_length CHECK ("beneficiaryUserId" IS NULL OR char_length("beneficiaryUserId") BETWEEN 1 AND 128),
  -- a purpose-less row has no beneficiary (a historical row has neither)
  ADD CONSTRAINT payment_beneficiary_needs_purpose CHECK (purpose IS NOT NULL OR "beneficiaryUserId" IS NULL),
  -- FC-10 under P-6: Core V2 admits simulation only
  ADD CONSTRAINT payment_live_mode_simulation_only CHECK ("liveMode" IS NULL OR "liveMode" = false);

CREATE FUNCTION payment_s4a_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.purpose IS NULL OR NEW."liveMode" IS NULL THEN
    RAISE EXCEPTION 'a new payment carries its purpose and liveMode' USING ERRCODE = '23514', CONSTRAINT = 'payment_s4a_required';
  END IF;
  RETURN NULL;
END $$;
-- AFTER the row's own CHECKs (each still reports its own violation first); in the inserting statement, so nothing commits without it
CREATE TRIGGER payment_95_s4a_insert_guard AFTER INSERT ON payment FOR EACH ROW EXECUTE FUNCTION payment_s4a_insert_guard();

-- S-6: immutable once requested, like the 0002 snapshot (a historical NULL stays NULL)
CREATE TRIGGER payment_s4a_immutable BEFORE UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('purpose', 'beneficiaryUserId', 'liveMode');

-- ───────────────────────────────────────────────────────────────────────────────────────────────────────── payment_attempt

ALTER TABLE payment_attempt ADD COLUMN "liveMode" boolean; -- existing attempts keep NULL
ALTER TABLE payment_attempt ADD CONSTRAINT payment_attempt_live_mode_simulation_only CHECK ("liveMode" IS NULL OR "liveMode" = false);

-- A new attempt has its payment's mode: taken from the payment when not given (a historical payment, NULL, takes simulation attempts),
-- and a different one is refused
CREATE FUNCTION payment_attempt_live_mode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pm boolean;
BEGIN
  SELECT "liveMode" INTO pm FROM payment WHERE id = NEW."paymentId";
  NEW."liveMode" := COALESCE(NEW."liveMode", pm, false);
  IF pm IS NOT NULL AND pm <> NEW."liveMode" THEN
    RAISE EXCEPTION 'attempt %: an attempt carries its payment''s liveMode', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'payment_attempt_live_mode';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempt_05_live_mode BEFORE INSERT ON payment_attempt FOR EACH ROW EXECUTE FUNCTION payment_attempt_live_mode_guard();
CREATE TRIGGER payment_attempt_s4a_immutable BEFORE UPDATE ON payment_attempt
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('liveMode');
