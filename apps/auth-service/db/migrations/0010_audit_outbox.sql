-- Stage 18.7.5 (ADR-0049, ADR-0037): Auth's transactional outbox, the durable path of its central audit intent. Written in the SAME
-- transaction as the Auth change (and its local auth_audit_event row); the service-kit relay publishes unsent rows to RabbitMQ (at
-- least once, publisher confirms, retry with backoff). The table, its index and its immutability rule are EXACTLY the service-kit
-- outbox (libs/service-kit/migrations/kit_0001_outbox_inbox.sql), which the kit relay is written against; nothing else of the kit
-- schema (inbox, rate limit) is added: Auth consumes nothing. No business data: identifiers and codes only (the audit contract).
BEGIN;

CREATE TABLE outbox (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  payload         jsonb NOT NULL,
  "correlationId" text,
  "eventVersion"  integer NOT NULL DEFAULT 1,
  "occurredAt"    timestamptz NOT NULL DEFAULT now(),
  "availableAt"   timestamptz NOT NULL DEFAULT now(),
  "publishedAt"   timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  "lastError"     text,
  CONSTRAINT outbox_name_shape CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT outbox_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT outbox_version_positive CHECK ("eventVersion" >= 1),
  CONSTRAINT outbox_attempts_nonnegative CHECK (attempts >= 0)
);
CREATE INDEX outbox_unpublished_idx ON outbox ("availableAt", "occurredAt") WHERE "publishedAt" IS NULL;

-- An event is a historical fact: only its delivery bookkeeping may change.
CREATE FUNCTION outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId" OR NEW."eventVersion" IS DISTINCT FROM OLD."eventVersion"
     OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" THEN
    RAISE EXCEPTION 'outbox events are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
    RAISE EXCEPTION 'a published outbox event cannot be republished or unpublished' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_immutable BEFORE UPDATE ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_immutable();

COMMIT;
