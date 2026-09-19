-- Technical tables for reliable events (ADR-0037). No business data. Applied to every service database that uses the kit.

-- OUTBOX: written in the SAME transaction as the business change; a relay publishes unsent rows (at least once).
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

-- INBOX: one row per event a consumer has already applied. Inserted in the SAME transaction as the effect, so a
-- redelivered event is recognised and skipped, and a failed effect leaves no row behind.
CREATE TABLE inbox (
  "eventId"     uuid PRIMARY KEY,
  source        text NOT NULL,
  name          text NOT NULL,
  "processedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_name_shape CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);
