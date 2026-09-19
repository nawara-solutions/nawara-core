-- The Payment aggregate (SDD section 4.1, 5.1). Gateway settlement only in this phase: no cash or refund tables exist
-- yet (blocked by O-4/O-5/O-6, SDD section 19) — see docs/tdd/payment-service-foundation.md.

CREATE TABLE payment (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producer             text NOT NULL,
  "paymentRequestId"   uuid NOT NULL,
  "sourceType"         text NOT NULL,
  "sourceId"           text NOT NULL,
  "payerType"          text NOT NULL,
  "payerId"            text NOT NULL,
  "sellerType"         text NOT NULL,
  "sellerId"           text NOT NULL,
  "organizationId"     uuid,
  amount               bigint NOT NULL,
  currency             char(3) NOT NULL REFERENCES currency(code),
  description          text,
  reference            text,
  "expiresAt"          timestamptz,
  status               text NOT NULL DEFAULT 'created',
  "statusReason"       text,
  "settledMethod"      text,
  "succeededAttemptId" uuid,
  revision             integer NOT NULL DEFAULT 0,
  "createdAt"          timestamptz NOT NULL DEFAULT now(),
  "updatedAt"          timestamptz NOT NULL DEFAULT now(),
  "closedAt"           timestamptz,

  CONSTRAINT payment_amount_positive CHECK (amount > 0),                                          -- FI-01
  CONSTRAINT payment_currency_upper CHECK (currency = upper(currency)),
  CONSTRAINT payment_source_type_shape CHECK ("sourceType" ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT payment_source_id_length CHECK (char_length("sourceId") BETWEEN 1 AND 128),
  CONSTRAINT payment_payer_type_valid CHECK ("payerType" IN ('user', 'organization', 'company')),
  CONSTRAINT payment_seller_type_valid CHECK ("sellerType" IN ('user', 'organization', 'company')),
  CONSTRAINT payment_payer_seller_distinct CHECK (("payerType", "payerId") IS DISTINCT FROM ("sellerType", "sellerId")),
  CONSTRAINT payment_organization_matches_seller CHECK ("sellerType" <> 'organization' OR "organizationId"::text = "sellerId"),
  CONSTRAINT payment_description_length CHECK (description IS NULL OR char_length(description) <= 140),
  CONSTRAINT payment_reference_length CHECK (reference IS NULL OR char_length(reference) <= 64),
  CONSTRAINT payment_status_valid CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  CONSTRAINT payment_settled_method_valid CHECK ("settledMethod" IS NULL OR "settledMethod" IN ('gateway', 'cash')),
  CONSTRAINT payment_settled_method_only_when_succeeded CHECK ("settledMethod" IS NULL OR status = 'succeeded'),
  CONSTRAINT payment_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT payment_request_id_unique UNIQUE (producer, "paymentRequestId")
);

CREATE INDEX payment_organization_idx ON payment ("organizationId");
CREATE INDEX payment_payer_idx ON payment ("payerType", "payerId");
CREATE INDEX payment_seller_idx ON payment ("sellerType", "sellerId");

-- FI-02: the snapshot is immutable after creation (uses the kit's generic trigger, kit_0003_generic_triggers.sql).
CREATE TRIGGER payment_snapshot_immutable BEFORE UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'producer', 'paymentRequestId', 'sourceType', 'sourceId', 'payerType', 'payerId', 'sellerType', 'sellerId',
    'organizationId', 'amount', 'currency', 'description', 'reference', 'expiresAt', 'createdAt'
  );

-- Defence in depth alongside application checks (SDD section 5.1): only the transitions the state machine allows.
-- Gateway-settlement scope only in this phase (no cash rows exist yet to move a payment through a cash path).
CREATE FUNCTION payment_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('created', 'pending'), ('pending', 'created'), ('pending', 'succeeded'), ('pending', 'failed'),
      ('created', 'cancelled'), ('pending', 'cancelled'), ('created', 'expired'), ('pending', 'expired'),
      -- Late success (section 5.1): an attempt that was failed by INFERENCE can still succeed later; if the failed
      -- attempt already returned the payment to `created` (below the attempt limit) before the late success arrives,
      -- the payment moves directly from `created` to `succeeded`.
      ('created', 'succeeded')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'payment % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_status_transition BEFORE UPDATE OF status ON payment
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION payment_status_transition_guard();
