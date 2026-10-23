-- Core V2 S1b-3 (ADR-0057 §13.2 with its S0-C2 revision, §13.3; observe-only; SDD §12.4): the provenance of every event delivered to the
-- intake (`notification.events`) through the event exchange, committed in a transaction of its own BEFORE the intake runs (the kit's
-- `PgKeyedProvenanceStore` writes it). Additive only: two new tables; no existing table, row, constraint or trigger changes.
--
-- S0-C2: three of the consumed Auth events carry a six-digit one-time code, and every other field of their bodies is already in this
-- database, so an unkeyed digest of a body would give a reader of this database the code in 10^6 tries. The body is therefore recorded
-- ONLY as `bodyMac`: HMAC-SHA-256 of the complete raw delivered bytes under the provenance key `bodyMacKeyId` (construction
-- `bodyCommitmentVersion` = 1). The keys live in configuration (`NOTIFICATION_PROVENANCE_KEYS`), never in this database; there is no
-- unkeyed body digest column, and none may be added.
--
-- `event_provenance`: at most one VERIFIED and one UNVERIFIED observation per (consumer, source, eventId); only a delivery meeting every
-- §13.2 criterion creates the verified row (the shape check below makes the database refuse anything else), so an unverified first
-- arrival can never occupy, block or discredit it. Never backfilled (§13.6).
-- `event_provenance_conflict`: every later observation that differs from a stored one (compared under the stored row's key), with a
-- reference to the row it differs from.
-- Both are append-only for every role (triggers), and the runtime holds INSERT and SELECT only. Retention: no purge in S1b-3 (§13.8 is a
-- minimum; Notification history retention is an open product / legal decision; production gate NP-K). Growth is visible in
-- `nawara_event_provenance_total`.

CREATE TABLE event_provenance (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer                text NOT NULL,          -- the consumer's own queue
  source                  text NOT NULL,          -- '' when the header was absent or not a service name
  "eventId"               text NOT NULL,          -- '' when the message id was absent or not a safe token
  name                    text NOT NULL,          -- the AMQP type (the envelope name)
  "routingKey"            text NOT NULL,          -- the routing key the broker delivered ('' when not an event name)
  exchange                text NOT NULL,          -- the exchange the broker delivered through (always the event exchange here)
  "bodyCommitmentVersion" smallint NOT NULL,      -- 1: HMAC-SHA-256 of the raw body bytes
  "bodyMacKeyId"          text NOT NULL,          -- the (non-secret) id of the provenance key the MAC was made with
  "bodyMac"               text NOT NULL,          -- the keyed body commitment, lowercase hex (never an unkeyed digest)
  "producerUserId"        text,                   -- the AMQP user_id the broker delivered; null when absent
  verified                boolean NOT NULL,
  reason                  text NOT NULL,          -- the first failed §13.2 criterion, or 'verified'
  "firstSeenAt"           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_provenance_lengths CHECK (
    char_length(consumer) BETWEEN 1 AND 255 AND char_length(source) <= 63 AND char_length("eventId") <= 128 AND char_length(name) <= 255
    AND char_length("routingKey") <= 255 AND char_length(exchange) <= 255 AND ("producerUserId" IS NULL OR char_length("producerUserId") BETWEEN 1 AND 64)),
  CONSTRAINT event_provenance_body_commitment CHECK (
    "bodyCommitmentVersion" = 1 AND "bodyMacKeyId" ~ '^[A-Za-z0-9_-]{1,32}$' AND "bodyMac" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_provenance_reason_valid CHECK (reason IN ('verified', 'missing_user_id', 'source_mismatch', 'unknown_event', 'not_family_owner', 'routing_key_mismatch', 'invalid_event_id')),
  CONSTRAINT event_provenance_verified_iff_reason CHECK (verified = (reason = 'verified')),
  -- §13.2: broker user_id = source, routing key = name, a canonical event id. The catalog-owner criterion is checked by the consumer.
  CONSTRAINT event_provenance_verified_shape CHECK (NOT verified OR (
    "producerUserId" IS NOT NULL AND "producerUserId" = source AND name <> '' AND "routingKey" = name AND "eventId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
  CONSTRAINT event_provenance_once UNIQUE (consumer, source, "eventId", verified),
  CONSTRAINT event_provenance_key UNIQUE (id, consumer, source, "eventId")
);

CREATE TABLE event_provenance_conflict (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "provenanceId"          uuid NOT NULL,          -- the stored observation this one differs from
  consumer                text NOT NULL,
  source                  text NOT NULL,
  "eventId"               text NOT NULL,
  name                    text NOT NULL,
  "routingKey"            text NOT NULL,
  exchange                text NOT NULL,
  "bodyCommitmentVersion" smallint NOT NULL,
  "bodyMacKeyId"          text NOT NULL,
  "bodyMac"               text NOT NULL,
  "producerUserId"        text,
  verified                boolean NOT NULL,       -- whether THIS observation met every §13.2 criterion
  reason                  text NOT NULL,
  "observedAt"            timestamptz NOT NULL DEFAULT now(),

  -- the conflict is about the same (consumer, source, eventId) as the row it references
  CONSTRAINT event_provenance_conflict_of FOREIGN KEY ("provenanceId", consumer, source, "eventId") REFERENCES event_provenance (id, consumer, source, "eventId"),
  CONSTRAINT event_provenance_conflict_lengths CHECK (
    char_length(name) <= 255 AND char_length("routingKey") <= 255 AND char_length(exchange) <= 255
    AND ("producerUserId" IS NULL OR char_length("producerUserId") BETWEEN 1 AND 64)),
  CONSTRAINT event_provenance_conflict_body_commitment CHECK (
    "bodyCommitmentVersion" = 1 AND "bodyMacKeyId" ~ '^[A-Za-z0-9_-]{1,32}$' AND "bodyMac" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT event_provenance_conflict_reason_valid CHECK (reason IN ('verified', 'missing_user_id', 'source_mismatch', 'unknown_event', 'not_family_owner', 'routing_key_mismatch', 'invalid_event_id')),
  CONSTRAINT event_provenance_conflict_verified_iff_reason CHECK (verified = (reason = 'verified')),
  CONSTRAINT event_provenance_conflict_verified_shape CHECK (NOT verified OR (
    "producerUserId" IS NOT NULL AND "producerUserId" = source AND name <> '' AND "routingKey" = name AND "eventId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
);
-- the store de-duplicates evidence by comparing under each evidence row's own key; under one key this index is the backstop
CREATE UNIQUE INDEX event_provenance_conflict_once ON event_provenance_conflict
  ("provenanceId", name, "routingKey", exchange, "bodyMacKeyId", "bodyMac", COALESCE("producerUserId", ''), verified, reason);

CREATE FUNCTION notification_event_provenance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;

CREATE TRIGGER event_provenance_10_append_only BEFORE UPDATE OR DELETE ON event_provenance
  FOR EACH ROW EXECUTE FUNCTION notification_event_provenance_append_only();
CREATE TRIGGER event_provenance_11_no_truncate BEFORE TRUNCATE ON event_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION notification_event_provenance_append_only();
CREATE TRIGGER event_provenance_conflict_10_append_only BEFORE UPDATE OR DELETE ON event_provenance_conflict
  FOR EACH ROW EXECUTE FUNCTION notification_event_provenance_append_only();
CREATE TRIGGER event_provenance_conflict_11_no_truncate BEFORE TRUNCATE ON event_provenance_conflict
  FOR EACH STATEMENT EXECUTE FUNCTION notification_event_provenance_append_only();

-- The Core provisioning's DEFAULT PRIVILEGES give the runtime SELECT / INSERT / UPDATE / DELETE on every table the migrator creates: take
-- back every mutating privilege from every role but the owner (whatever the roles are called), so the runtime holds INSERT and SELECT only.
DO $$
DECLARE r record;
BEGIN
  REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON event_provenance, event_provenance_conflict FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT c.relname AS tbl, a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname IN ('event_provenance', 'event_provenance_conflict') AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM %s', r.tbl, r.role);
  END LOOP;
END $$;
