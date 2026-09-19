-- Short-lived protection against a client retrying a non-natural-key operation (SDD section 4.7, 6). Natural-key
-- idempotency (payment creation, refund creation) is enforced by the aggregate's own unique constraint instead.

CREATE TABLE idempotency_key (
  caller           text NOT NULL,
  operation        text NOT NULL,
  key              text NOT NULL,
  "requestHash"    text NOT NULL,
  status           text NOT NULL DEFAULT 'completed',
  "responseStatus" integer NOT NULL,
  "resourceType"   text NOT NULL,
  "resourceId"     uuid NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),
  "expiresAt"      timestamptz NOT NULL,

  PRIMARY KEY (caller, operation, key),
  CONSTRAINT idempotency_key_shape CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT idempotency_key_status_valid CHECK (status = 'completed'),
  CONSTRAINT idempotency_key_response_status_valid CHECK ("responseStatus" BETWEEN 100 AND 599)
);

CREATE INDEX idempotency_key_expiry_idx ON idempotency_key ("expiresAt");
