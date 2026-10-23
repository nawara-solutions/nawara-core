-- Core V2 S1b-2 (ADR-0057 §13.2 with its "Audit admission" clarification S0-C1, §13.3; observe-only): the provenance of every ADMITTED
-- `audit.*` delivery that reaches Audit's consumer through the event exchange, committed in a transaction of its own BEFORE ingestion (the
-- kit's `PgProvenanceStore` writes it). A delivery refused at admission (non-canonical bytes, the Stage 18.8 confidentiality screen, the
-- full audit contract) never gets a row or a body digest. Additive only: two new tables; no existing table, row, trigger or privilege
-- changes. Nothing reads these tables to decide anything yet: whether a delivery was verified, or differed from what was stored, never
-- changes ingestion (enforcement is S1c/S1e, separately gated).
--
-- `event_provenance`: at most one VERIFIED and one UNVERIFIED observation per (consumer, source, eventId). Only a delivery meeting every
-- §13.2 criterion creates the verified row (the shape check below makes the database refuse anything else), so an unverified first
-- arrival can never occupy, block or discredit it. Never backfilled (§13.6).
-- `event_provenance_conflict`: every later observation that differs from a stored one, with a reference to the row it differs from; the
-- same differing evidence is stored once.
-- Both are append-only for EVERY role, the retention role included: `audit_grant_retention` grants DELETE on `audit_record` only. No purge
-- (S1b-2): retention, erasure and legal holds of provenance need an explicit policy (P-A2, open), and the production gate AP-R of the
-- execution roadmap holds Audit provenance out of any environment with an `audit_retention_policy` row until then. This migration does
-- not enforce AP-R. Growth is visible in `nawara_event_provenance_total`.

CREATE TABLE event_provenance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer         text NOT NULL,                -- the consumer's own queue (`audit-service.audit`)
  source           text NOT NULL,                -- '' when the header was absent or not a service name
  "eventId"        text NOT NULL,                -- '' when the message id was absent or not a safe token
  name             text NOT NULL,                -- the AMQP type (the envelope name, `audit.<action>`)
  "routingKey"     text NOT NULL,                -- the routing key the broker delivered ('' when not an event name)
  exchange         text NOT NULL,                -- the exchange the broker delivered through (always the event exchange here)
  "bodySha256"     text NOT NULL,                -- SHA-256 of the raw delivered (admitted, canonical) body bytes
  "producerUserId" text,                         -- the AMQP user_id the broker delivered; null when absent
  verified         boolean NOT NULL,
  reason           text NOT NULL,                -- the first failed §13.2 criterion, or 'verified'
  "firstSeenAt"    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_provenance_lengths CHECK (
    char_length(consumer) BETWEEN 1 AND 255 AND char_length(source) <= 63 AND char_length("eventId") <= 128 AND char_length(name) <= 255
    AND char_length("routingKey") <= 255 AND char_length(exchange) <= 255 AND ("producerUserId" IS NULL OR char_length("producerUserId") BETWEEN 1 AND 64)),
  CONSTRAINT event_provenance_body_sha256 CHECK ("bodySha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_provenance_reason_valid CHECK (reason IN ('verified', 'missing_user_id', 'source_mismatch', 'unknown_event', 'not_family_owner', 'routing_key_mismatch', 'invalid_event_id')),
  CONSTRAINT event_provenance_verified_iff_reason CHECK (verified = (reason = 'verified')),
  -- §13.2: broker user_id = source, routing key = name, a canonical event id. The catalog-owner criterion is checked by the consumer.
  CONSTRAINT event_provenance_verified_shape CHECK (NOT verified OR (
    "producerUserId" IS NOT NULL AND "producerUserId" = source AND name <> '' AND "routingKey" = name AND "eventId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CONSTRAINT event_provenance_once UNIQUE (consumer, source, "eventId", verified),
  CONSTRAINT event_provenance_key UNIQUE (id, consumer, source, "eventId")
);

CREATE TABLE event_provenance_conflict (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provenanceId"   uuid NOT NULL,                -- the stored observation this one differs from
  consumer         text NOT NULL,
  source           text NOT NULL,
  "eventId"        text NOT NULL,
  name             text NOT NULL,
  "routingKey"     text NOT NULL,
  exchange         text NOT NULL,
  "bodySha256"     text NOT NULL,
  "producerUserId" text,
  verified         boolean NOT NULL,             -- whether THIS observation met every §13.2 criterion
  reason           text NOT NULL,
  "observedAt"     timestamptz NOT NULL DEFAULT now(),

  -- the conflict is about the same (consumer, source, eventId) as the row it references
  CONSTRAINT event_provenance_conflict_of FOREIGN KEY ("provenanceId", consumer, source, "eventId") REFERENCES event_provenance (id, consumer, source, "eventId"),
  CONSTRAINT event_provenance_conflict_lengths CHECK (
    char_length(name) <= 255 AND char_length("routingKey") <= 255 AND char_length(exchange) <= 255
    AND ("producerUserId" IS NULL OR char_length("producerUserId") BETWEEN 1 AND 64)),
  CONSTRAINT event_provenance_conflict_body_sha256 CHECK ("bodySha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_provenance_conflict_reason_valid CHECK (reason IN ('verified', 'missing_user_id', 'source_mismatch', 'unknown_event', 'not_family_owner', 'routing_key_mismatch', 'invalid_event_id')),
  CONSTRAINT event_provenance_conflict_verified_iff_reason CHECK (verified = (reason = 'verified')),
  CONSTRAINT event_provenance_conflict_verified_shape CHECK (NOT verified OR (
    "producerUserId" IS NOT NULL AND "producerUserId" = source AND name <> '' AND "routingKey" = name AND "eventId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
-- the same differing evidence against the same stored row is kept once (a redelivery adds nothing)
CREATE UNIQUE INDEX event_provenance_conflict_once ON event_provenance_conflict
  ("provenanceId", name, "routingKey", exchange, "bodySha256", COALESCE("producerUserId", ''), verified, reason);

-- Append-only for every role (the 18.3 pattern): the triggers refuse UPDATE, DELETE and TRUNCATE; the runtime keeps INSERT / SELECT only.
CREATE FUNCTION audit_event_provenance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER event_provenance_no_update_delete BEFORE UPDATE OR DELETE ON event_provenance
  FOR EACH ROW EXECUTE FUNCTION audit_event_provenance_append_only();
CREATE TRIGGER event_provenance_no_truncate BEFORE TRUNCATE ON event_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_provenance_append_only();
CREATE TRIGGER event_provenance_conflict_no_update_delete BEFORE UPDATE OR DELETE ON event_provenance_conflict
  FOR EACH ROW EXECUTE FUNCTION audit_event_provenance_append_only();
CREATE TRIGGER event_provenance_conflict_no_truncate BEFORE TRUNCATE ON event_provenance_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_provenance_append_only();
SELECT audit_restrict_to_append_only('event_provenance');
SELECT audit_restrict_to_append_only('event_provenance_conflict');
