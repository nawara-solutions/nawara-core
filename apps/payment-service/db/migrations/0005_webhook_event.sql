-- Durable, deduplicated record of a VERIFIED provider notification and how it was processed (SDD section 4.6).
-- A request that fails signature verification is never persisted here (an unauthenticated caller cannot write to
-- the database) — only ever inserted by application code after `PaymentProvider.verifyWebhook` succeeds.

CREATE TABLE webhook_event (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,
  "providerEventId"  text NOT NULL,
  "eventType"        text NOT NULL,
  "rawBody"          bytea NOT NULL,
  "receivedAt"       timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL DEFAULT 'received',
  outcome            text,
  attempts           integer NOT NULL DEFAULT 0,
  "lastError"        text,
  "matchedAttemptId" uuid REFERENCES payment_attempt(id),
  "processedAt"      timestamptz,

  CONSTRAINT webhook_event_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT webhook_event_state_valid CHECK (state IN ('received', 'processing', 'processed', 'ignored', 'unmatched', 'conflict', 'failed')),
  CONSTRAINT webhook_event_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT webhook_event_provider_id_unique UNIQUE (provider, "providerEventId")
);

-- The retrier looks for stuck deliveries; a partial index keeps that query cheap regardless of table size.
CREATE INDEX webhook_event_retry_idx ON webhook_event ("receivedAt") WHERE state IN ('received', 'processing', 'failed', 'unmatched');

-- The received fact never changes; only delivery/processing bookkeeping may.
CREATE TRIGGER webhook_event_immutable BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('provider', 'providerEventId', 'eventType', 'rawBody', 'receivedAt');
