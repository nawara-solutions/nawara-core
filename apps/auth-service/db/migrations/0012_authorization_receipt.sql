-- 0012 — auth-service: authorization receipts (Core V2 S2-Auth.1; ADR-0067; D-A2 receipt contract §13, as approved for S2-Auth.1).
--
-- An Owner who passed a factor-only `refund.authorize` step-up gets a receipt: a one-time secret bound to one exact refund. Auth stores
-- only HMAC digests (pepper outside the database) of the secret and of the canonical binding, plus the minimal lifecycle metadata the
-- Owner approved for correctness (Q4): status, timestamps, issuer and session, the issue idempotency key and its request hash, and, once
-- consumed, the consumption reference and the consuming service. The plaintext secret and the binding are never stored.
--
-- EXPAND ONLY: one new table, its trigger function and trigger; no existing table, column or row changes.
--
-- Lifecycle (enforced here, for every role, including the table owner):
--   * a row is inserted `issued`, with no consumption or void data;
--   * the only transitions are `issued -> consumed` and `issued -> voided`; both are terminal;
--   * identity, digests, idempotency data and the issue timestamps never change; rows are never deleted;
--   * the receipt lives exactly 10 minutes (F-3) and is consumed strictly before it expires.
BEGIN;

CREATE TABLE authorization_receipt (
  id                 uuid        PRIMARY KEY,
  "issuerUserId"     uuid        NOT NULL REFERENCES owner ("userId") ON DELETE RESTRICT,
  "sessionFamilyId"  uuid        NOT NULL,
  -- one receipt per step-up proof
  "stepUpId"         uuid        NOT NULL REFERENCES owner_step_up (id) ON DELETE RESTRICT,
  "idempotencyKey"   text        NOT NULL CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  "requestHash"      text        NOT NULL CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  "secretDigest"     text        NOT NULL CHECK ("secretDigest" ~ '^[0-9a-f]{64}$'),
  "bindingDigest"    text        NOT NULL CHECK ("bindingDigest" ~ '^[0-9a-f]{64}$'),
  status             text        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'consumed', 'voided')),
  "issuedAt"         timestamptz NOT NULL,
  "expiresAt"        timestamptz NOT NULL,
  "consumedAt"       timestamptz,
  "consumeRef"       uuid,
  "consumedBy"       text        CHECK ("consumedBy" ~ '^[a-z][a-z0-9-]{0,62}$'),
  "voidedAt"         timestamptz,

  CONSTRAINT authorization_receipt_step_up_uk UNIQUE ("stepUpId"),
  CONSTRAINT authorization_receipt_idempotency_uk UNIQUE ("issuerUserId", "idempotencyKey"),
  CONSTRAINT authorization_receipt_secret_digest_uk UNIQUE ("secretDigest"),
  CONSTRAINT authorization_receipt_consume_ref_uk UNIQUE ("consumeRef"),
  CONSTRAINT authorization_receipt_lifetime CHECK ("expiresAt" = "issuedAt" + interval '10 minutes'),
  CONSTRAINT authorization_receipt_state_pairing CHECK (
       (status = 'issued'   AND "consumedAt" IS NULL     AND "consumeRef" IS NULL     AND "consumedBy" IS NULL     AND "voidedAt" IS NULL)
    OR (status = 'consumed' AND "consumedAt" IS NOT NULL AND "consumeRef" IS NOT NULL AND "consumedBy" IS NOT NULL AND "voidedAt" IS NULL)
    OR (status = 'voided'   AND "consumedAt" IS NULL     AND "consumeRef" IS NULL     AND "consumedBy" IS NULL     AND "voidedAt" IS NOT NULL)
  ),
  CONSTRAINT authorization_receipt_consumed_in_time CHECK ("consumedAt" IS NULL OR ("consumedAt" >= "issuedAt" AND "consumedAt" < "expiresAt")),
  CONSTRAINT authorization_receipt_voided_after_issue CHECK ("voidedAt" IS NULL OR "voidedAt" >= "issuedAt")
);

CREATE FUNCTION authorization_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authorization_receipt rows cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'issued' THEN
      RAISE EXCEPTION 'an authorization_receipt is always inserted issued' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: terminal states never change; identity, digests and issue data never change; the only transitions are issued -> consumed
  -- and issued -> voided.
  IF OLD.status <> 'issued' THEN
    RAISE EXCEPTION 'authorization_receipt % is % (terminal)', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW."issuerUserId", NEW."sessionFamilyId", NEW."stepUpId", NEW."idempotencyKey", NEW."requestHash", NEW."secretDigest",
      NEW."bindingDigest", NEW."issuedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD.id, OLD."issuerUserId", OLD."sessionFamilyId", OLD."stepUpId", OLD."idempotencyKey", OLD."requestHash", OLD."secretDigest",
      OLD."bindingDigest", OLD."issuedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'authorization_receipt rows are immutable except for their single transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status NOT IN ('consumed', 'voided') THEN
    RAISE EXCEPTION 'authorization_receipt: the only transitions are issued -> consumed and issued -> voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authorization_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON authorization_receipt
  FOR EACH ROW EXECUTE FUNCTION authorization_receipt_guard();

COMMIT;
