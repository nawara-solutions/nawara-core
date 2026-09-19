-- Billing's record of asking Payment to collect ONE invoice (SDD sections 13 and 17.3). Billing owns this lifecycle; Payment owns the
-- resulting Payment and its state. Nothing here stores attempts, providers, methods or provider data, and there is no foreign key
-- to Payment: `paymentId` is an opaque reference assigned by Payment.

CREATE TABLE payment_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),           -- IS the `paymentRequestId` Payment receives, never regenerated
  "invoiceId"         uuid NOT NULL,
  amount              bigint NOT NULL,
  currency            char(3) NOT NULL,
  status              text NOT NULL DEFAULT 'created',
  "paymentId"         uuid,
  "expiresAt"         timestamptz,                                           -- null: no policy exists (B-009); Billing chooses nothing
  "mappingVersion"    integer NOT NULL DEFAULT 1,                            -- pins the pure invoice -> Payment request mapping (13.2)
  "sendAttempts"      integer NOT NULL DEFAULT 0,
  "sendingSince"      timestamptz,
  "cancelRequestedAt" timestamptz,
  "failureCode"       text,
  "createdByType"     text NOT NULL,
  "createdById"       text,
  revision            integer NOT NULL DEFAULT 0,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "closedAt"          timestamptz,
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),

  -- BI-04 for payment requests: the currency is the invoice's
  CONSTRAINT payment_request_invoice_fk FOREIGN KEY ("invoiceId", currency) REFERENCES invoice (id, currency),
  CONSTRAINT payment_request_amount_positive CHECK (amount > 0),                                   -- BI-02
  CONSTRAINT payment_request_amount_safe CHECK (amount <= 9007199254740991),                        -- BI-01
  CONSTRAINT payment_request_status_valid CHECK (status IN ('created', 'sending', 'requested', 'paid', 'failed', 'cancelled', 'expired', 'rejected')),
  -- a request that has not been acknowledged by Payment (or was refused) has no `paymentId`
  CONSTRAINT payment_request_unacknowledged_has_no_payment_id CHECK (status NOT IN ('created', 'sending', 'rejected') OR "paymentId" IS NULL),
  -- acknowledged and ended-after-sending states always carry the paymentId Payment assigned
  CONSTRAINT payment_request_acknowledged_has_payment_id CHECK (status NOT IN ('requested', 'paid', 'failed', 'expired') OR "paymentId" IS NOT NULL),
  CONSTRAINT payment_request_closed_iff_terminal CHECK ((status IN ('paid', 'failed', 'cancelled', 'expired', 'rejected')) = ("closedAt" IS NOT NULL)),
  CONSTRAINT payment_request_sending_since CHECK (status <> 'sending' OR "sendingSince" IS NOT NULL),
  CONSTRAINT payment_request_send_attempts_nonnegative CHECK ("sendAttempts" >= 0),
  CONSTRAINT payment_request_mapping_version_positive CHECK ("mappingVersion" >= 1),
  CONSTRAINT payment_request_failure_code_length CHECK ("failureCode" IS NULL OR char_length("failureCode") BETWEEN 1 AND 64),
  CONSTRAINT payment_request_creator_valid CHECK ("createdByType" IN ('user', 'service', 'system')),
  CONSTRAINT payment_request_revision_nonnegative CHECK (revision >= 0)
);
-- BI-13: at most one ACTIVE request per invoice; the partial unique index is the authority
CREATE UNIQUE INDEX payment_request_one_active ON payment_request ("invoiceId") WHERE status IN ('created', 'sending', 'requested');
-- BI-09 / BI-14: at most one PAID request per invoice
CREATE UNIQUE INDEX payment_request_one_paid ON payment_request ("invoiceId") WHERE status = 'paid';
CREATE UNIQUE INDEX payment_request_payment_id_unique ON payment_request ("paymentId") WHERE "paymentId" IS NOT NULL;
CREATE INDEX payment_request_dispatch_idx ON payment_request (status, "createdAt") WHERE status IN ('created', 'sending');
CREATE INDEX payment_request_invoice_idx ON payment_request ("invoiceId", "createdAt" DESC);

-- A request is BORN `created`. It takes the INVOICE lock first (lock order: invoice, then payment_request), and it exists only for
-- an `open` invoice whose payer Payment can collect from, for exactly the invoice total (BI-08, BI-09).
CREATE FUNCTION billing_payment_request_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv record;
BEGIN
  IF NEW.status <> 'created' OR NEW."paymentId" IS NOT NULL OR NEW.revision <> 0 OR NEW."sendAttempts" <> 0
     OR NEW."sendingSince" IS NOT NULL OR NEW."cancelRequestedAt" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."failureCode" IS NOT NULL THEN
    RAISE EXCEPTION 'a payment request is created as `created` with no lifecycle data' USING ERRCODE = '23514';
  END IF;
  SELECT status, total, "payerType" INTO inv FROM invoice WHERE id = NEW."invoiceId" FOR UPDATE;
  IF inv.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'a payment request needs an open invoice' USING ERRCODE = '23514';
  END IF;
  -- v1 TEMPORARY RESTRICTION (B-026): Payment can start an attempt only for a `user` payer and has no cancel route yet, so a request
  -- for any other payer could never be completed or closed.
  IF inv."payerType" <> 'user' THEN
    RAISE EXCEPTION 'payment requests are supported only for a user payer until B-026 is decided' USING ERRCODE = '23514';
  END IF;
  -- v1 TEMPORARY RESTRICTION (B-010): the request is for exactly the invoice total (no partial payments)
  IF NEW.amount <> inv.total THEN
    RAISE EXCEPTION 'a payment request is for the full invoice total until B-010 is decided' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER payment_request_05_insert_guard BEFORE INSERT ON payment_request FOR EACH ROW EXECUTE FUNCTION billing_payment_request_insert_guard();

-- BI-15: the mapped fields never change (deny-list from the kit; every other column is a lifecycle column by design)
CREATE TRIGGER payment_request_10_immutable BEFORE UPDATE ON payment_request
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('invoiceId', 'amount', 'currency', 'expiresAt', 'mappingVersion', 'createdAt', 'createdByType', 'createdById');

-- SDD 17.3: exactly these transitions. The dispatcher's moves (created -> sending -> requested | rejected) never read or lock the
-- invoice; only the move to `paid` does, and its caller already holds the invoice lock (lock order: invoice, then payment_request).
CREATE FUNCTION billing_payment_request_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv_status text;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'created' AND NEW.status IN ('sending', 'cancelled'))
      OR (OLD.status = 'sending' AND NEW.status IN ('requested', 'rejected'))
      OR (OLD.status = 'requested' AND NEW.status IN ('paid', 'failed', 'expired', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'payment request % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('paid', 'failed', 'cancelled', 'expired', 'rejected') THEN
      NEW."closedAt" := now();
    END IF;
    IF NEW.status = 'sending' THEN
      NEW."sendingSince" := now();
    END IF;
    IF NEW.status = 'paid' THEN
      SELECT status INTO inv_status FROM invoice WHERE id = NEW."invoiceId";
      IF inv_status IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'a payment request can become paid only for an open invoice' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  -- `paymentId` is set once, and only by the move to `requested` (Billing's own call, or the reconciler), never bound from an event
  IF NEW."paymentId" IS DISTINCT FROM OLD."paymentId" AND NOT (OLD."paymentId" IS NULL AND OLD.status = 'sending' AND NEW.status = 'requested') THEN
    RAISE EXCEPTION 'payment request %: paymentId is set once, when it becomes requested', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD."cancelRequestedAt" IS NOT NULL AND NEW."cancelRequestedAt" IS DISTINCT FROM OLD."cancelRequestedAt" THEN
    RAISE EXCEPTION 'payment request %: cancelRequestedAt is set once', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD."closedAt" IS NOT NULL AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'payment request % is closed', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := now();
  NEW.revision := OLD.revision + CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_request_20_lifecycle BEFORE UPDATE ON payment_request FOR EACH ROW EXECUTE FUNCTION billing_payment_request_lifecycle();
CREATE TRIGGER payment_request_90_no_delete BEFORE DELETE ON payment_request FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
