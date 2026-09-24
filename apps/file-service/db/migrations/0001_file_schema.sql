-- Stage 17.3: the file-service schema (ADR-0048; SDD file-service §3, §5, §6, §10, §11.1). Metadata only: no byte ever enters
-- PostgreSQL (no bytea, no large object, no chunk table).
--
--   file 1 ─< file_access_ticket   (a download ticket names one file; an upload ticket names the one file it created, once)
--
-- Conventions (Notification / Billing / Payment): camelCase quoted columns, timestamptz from the database clock, uuid ids, a CHECK
-- on every enumeration, triggers for what a CHECK cannot express. External identities (ownerService, issuedBy, organizationId,
-- createdBy) are logical references only: no foreign key leaves this database. No ON DELETE CASCADE anywhere, and a file row is never
-- deleted (the tombstone stays after the bytes are gone). Trigger messages carry ids and states only, never a name, key or digest.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── shared guard

-- Set-once columns (TG_ARGV): NULL may become a value; a value never changes again (not even back to NULL).
CREATE FUNCTION file_set_once() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD) -> col <> 'null'::jsonb AND to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION '%.% is set once', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── file (SDD §3, §5)

-- One row per file object. Immutable identity and placement; content metadata set once (when the bytes are accepted, 17.5); the
-- lifecycle moves only along the frozen state machine (SDD §5.1).
CREATE TABLE file (
  id                    uuid PRIMARY KEY,
  "ownerService"        text NOT NULL,
  "organizationId"      uuid,
  "createdBy"           text,
  "originalName"        text,
  "mediaType"           text,
  "declaredMediaType"   text,
  "sizeBytes"           bigint,
  sha256                text,
  "storageProvider"     text NOT NULL,
  "storageKey"          text NOT NULL,
  status                text NOT NULL DEFAULT 'UPLOADING',
  "uploadExpiresAt"     timestamptz NOT NULL,
  "attachDeadline"      timestamptz,
  "attachedAt"          timestamptz,
  "idempotencyKey"      text,
  "requestHash"         text,
  "failureCode"         text,
  "createdAt"           timestamptz NOT NULL DEFAULT now(),
  "availableAt"         timestamptz,
  "deletionRequestedAt" timestamptz,
  "deletedAt"           timestamptz,
  "updatedAt"           timestamptz NOT NULL DEFAULT now(),

  -- Identity: the authenticated caller (the kit's caller grammar), never a request field.
  CONSTRAINT file_owner_service_shape CHECK ("ownerService" ~ '^[a-z][a-z0-9-]{1,62}$'),
  -- An opaque actor reference for audit, never verified here.
  CONSTRAINT file_created_by_shape CHECK ("createdBy" IS NULL OR "createdBy" ~ '^[\x21-\x7e]{1,128}$'),
  -- Presentation only (SDD §8): NFC, at most 255 UTF-8 bytes, no C0/C1 control, no bidi override or isolate, no path separator,
  -- never "." or "..". The sanitizer (17.5) produces this; the constraint is the last line of defence.
  CONSTRAINT file_original_name_safe CHECK (
    "originalName" IS NULL OR (
      octet_length("originalName") BETWEEN 1 AND 255
      AND "originalName" IS NFC NORMALIZED
      AND "originalName" !~ '[\x01-\x1f\x7f-\x9f/\\‪-‮⁦-⁩]'
      AND "originalName" NOT IN ('.', '..')
    )
  ),
  -- The VERIFIED type (from the bytes, 17.5): only the V1 allow-list (F13; extending it is a migration, deliberately).
  CONSTRAINT file_media_type_allowed CHECK (
    "mediaType" IS NULL OR "mediaType" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
  ),
  -- The caller's declaration, a hint kept for diagnosis only (it may be anything the client sent, bounded and printable).
  CONSTRAINT file_declared_media_type_bounded CHECK ("declaredMediaType" IS NULL OR "declaredMediaType" ~ '^[\x20-\x7e]{1,255}$'),
  -- Within the frozen global ceiling (F29: FILE_MAX_BYTES ≤ 100 MiB).
  CONSTRAINT file_size_bounded CHECK ("sizeBytes" IS NULL OR "sizeBytes" BETWEEN 0 AND 104857600),
  -- Lowercase hexadecimal SHA-256 (the Core digest representation; also the future ETag).
  CONSTRAINT file_sha256_shape CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_storage_provider_shape CHECK ("storageProvider" ~ '^[a-z][a-z0-9-]{0,31}$'),
  -- SDD §6: `<prefix>/<fileId>/<32 hex>` in the key grammar; the file's own id, never a name, type or organization.
  CONSTRAINT file_storage_key_shape CHECK (
    length("storageKey") <= 200
    AND "storageKey" ~ ('^[a-z0-9-]+(/[a-z0-9-]+)*/' || id::text || '/[0-9a-f]{32}$')
  ),
  CONSTRAINT file_storage_key_unique UNIQUE ("storageKey"),
  CONSTRAINT file_status_valid CHECK (status IN ('UPLOADING', 'VERIFYING', 'AVAILABLE', 'REJECTED', 'FAILED', 'DELETING', 'DELETED')),
  -- The content metadata is complete once the bytes are accepted (every state reached through VERIFYING or AVAILABLE).
  CONSTRAINT file_content_complete CHECK (
    status NOT IN ('VERIFYING', 'AVAILABLE', 'DELETING', 'DELETED')
    OR ("mediaType" IS NOT NULL AND "sizeBytes" IS NOT NULL AND sha256 IS NOT NULL)
  ),
  -- The lifecycle stamps agree with the status (DELETING and DELETED are only reachable from AVAILABLE).
  CONSTRAINT file_available_at_iff_available CHECK ((status IN ('AVAILABLE', 'DELETING', 'DELETED')) = ("availableAt" IS NOT NULL)),
  CONSTRAINT file_deletion_requested_iff_deleting CHECK ((status IN ('DELETING', 'DELETED')) = ("deletionRequestedAt" IS NOT NULL)),
  CONSTRAINT file_deleted_at_iff_deleted CHECK ((status = 'DELETED') = ("deletedAt" IS NOT NULL)),
  CONSTRAINT file_failure_code_iff_refused CHECK ((status IN ('REJECTED', 'FAILED')) = ("failureCode" IS NOT NULL)),
  CONSTRAINT file_failure_code_shape CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Temporary (a deadline) or attached (SDD §5.2); a file a service creates for itself may start attached, with no deadline.
  CONSTRAINT file_attached_or_deadline CHECK ("attachedAt" IS NOT NULL OR "attachDeadline" IS NOT NULL),
  CONSTRAINT file_timestamps_ordered CHECK (
    "uploadExpiresAt" > "createdAt"
    AND ("attachDeadline" IS NULL OR "attachDeadline" > "createdAt")
    AND ("attachedAt" IS NULL OR "attachedAt" >= "createdAt")
    AND ("availableAt" IS NULL OR "availableAt" >= "createdAt")
    AND ("deletionRequestedAt" IS NULL OR "deletionRequestedAt" >= "availableAt")
    AND ("deletedAt" IS NULL OR "deletedAt" >= "deletionRequestedAt")
  ),
  -- Service-upload idempotency (SDD §10): the key and its keyed request hash together, or neither (ticket uploads have none).
  CONSTRAINT file_idempotency_pair CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL)),
  CONSTRAINT file_idempotency_key_shape CHECK ("idempotencyKey" IS NULL OR "idempotencyKey" ~ '^[\x21-\x7e]{1,255}$'),
  CONSTRAINT file_request_hash_shape CHECK ("requestHash" IS NULL OR "requestHash" ~ '^[0-9a-f]{64}$')
);

-- One live file per (owner, Idempotency-Key). A FAILED or REJECTED attempt leaves the index, so the same key may be retried (SDD §10).
-- NOT unique on sha256: no deduplication (F33).
CREATE UNIQUE INDEX file_idempotency_unique ON file ("ownerService", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL AND status NOT IN ('FAILED', 'REJECTED');
-- The sweeps (17.5 / 17.7), each a bounded `… ORDER BY <column> FOR UPDATE SKIP LOCKED` over its own state:
--   upload-lease sweep:  status = 'UPLOADING' AND "uploadExpiresAt" <= now()
--   orphan expiry:       status = 'AVAILABLE' AND "attachedAt" IS NULL AND "attachDeadline" <= now()
--   delete worker:       status = 'DELETING' ORDER BY "deletionRequestedAt"
CREATE INDEX file_upload_lease_idx ON file ("uploadExpiresAt") WHERE status = 'UPLOADING';
CREATE INDEX file_orphan_deadline_idx ON file ("attachDeadline") WHERE status = 'AVAILABLE' AND "attachedAt" IS NULL;
CREATE INDEX file_deleting_idx ON file ("deletionRequestedAt") WHERE status = 'DELETING';

-- Identity and placement never change; the declaration and idempotency identity never change.
CREATE TRIGGER file_immutable BEFORE UPDATE ON file
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'ownerService', 'organizationId', 'createdBy', 'originalName', 'declaredMediaType', 'storageProvider', 'storageKey',
    'uploadExpiresAt', 'attachDeadline', 'idempotencyKey', 'requestHash', 'createdAt');

-- Content metadata and lifecycle stamps are set once: the same fileId always means the same bytes (ADR-0048 §3).
CREATE TRIGGER file_set_once BEFORE UPDATE ON file
  FOR EACH ROW EXECUTE FUNCTION file_set_once(
    'mediaType', 'sizeBytes', 'sha256', 'attachedAt', 'availableAt', 'deletionRequestedAt', 'deletedAt', 'failureCode');

-- Every file starts UPLOADING (service upload and ticket upload alike), with no lifecycle stamp but an optional attachment.
CREATE FUNCTION file_starts_uploading() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'UPLOADING' THEN
    RAISE EXCEPTION 'file % must be created UPLOADING, not %', NEW.id, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_starts_uploading BEFORE INSERT ON file
  FOR EACH ROW EXECUTE FUNCTION file_starts_uploading();

-- The frozen state machine (SDD §5.1). REJECTED, FAILED and DELETED are terminal.
CREATE FUNCTION file_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('UPLOADING', 'VERIFYING'), ('UPLOADING', 'AVAILABLE'), ('UPLOADING', 'REJECTED'), ('UPLOADING', 'FAILED'),
      ('VERIFYING', 'AVAILABLE'), ('VERIFYING', 'REJECTED'),
      ('AVAILABLE', 'DELETING'),
      ('DELETING', 'DELETED')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'file % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_status_transition BEFORE UPDATE OF status ON file
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION file_status_transition_guard();

-- A terminal file is final in every field; a file being deleted can no longer be attached; updatedAt follows every change.
CREATE FUNCTION file_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('REJECTED', 'FAILED', 'DELETED') THEN
    RAISE EXCEPTION 'file % is % and final', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  IF OLD."attachedAt" IS NULL AND NEW."attachedAt" IS NOT NULL AND OLD.status = 'DELETING' THEN
    RAISE EXCEPTION 'file % is DELETING and cannot be attached', OLD.id USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER file_update_guard BEFORE UPDATE ON file
  FOR EACH ROW EXECUTE FUNCTION file_update_guard();

-- Never hard-deleted (F17: the tombstone stays; tickets and audit keep pointing at it).
CREATE FUNCTION file_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'file % is never deleted (logical deletion only)', OLD.id USING ERRCODE = '23514';
END $$;
CREATE TRIGGER file_no_delete BEFORE DELETE ON file
  FOR EACH ROW EXECUTE FUNCTION file_no_delete();

-- ─────────────────────────────────────────────────────────────────────────────────────── file_access_ticket (SDD §11.1)

-- An opaque server-side ticket (F35): the token is 32 random bytes returned once to the issuing service; only its SHA-256 digest
-- is stored. A download ticket names one file; an upload ticket carries one upload intent and, later, the one file it created.
CREATE TABLE file_access_ticket (
  id               uuid PRIMARY KEY,
  operation        text NOT NULL,
  "fileId"         uuid,
  "issuedBy"       text NOT NULL,
  "organizationId" uuid,
  "tokenDigest"    text NOT NULL,
  disposition      text,
  "maxBytes"       bigint,
  "mediaTypes"     text[],
  attach           boolean,
  "singleUse"      boolean NOT NULL,
  "useCount"       integer NOT NULL DEFAULT 0,
  "usedAt"         timestamptz,
  "revokedAt"      timestamptz,
  "expiresAt"      timestamptz NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),

  -- Within File's own database only; RESTRICT by default (a file row is never deleted anyway): no cascade erases ticket evidence.
  CONSTRAINT file_access_ticket_file_fk FOREIGN KEY ("fileId") REFERENCES file (id),
  CONSTRAINT file_access_ticket_operation_valid CHECK (operation IN ('download', 'upload')),
  CONSTRAINT file_access_ticket_issued_by_shape CHECK ("issuedBy" ~ '^[a-z][a-z0-9-]{1,62}$'),
  -- A SHA-256 digest in lowercase hex: a raw token (43 base64url characters) can never be stored here.
  CONSTRAINT file_access_ticket_token_digest_shape CHECK ("tokenDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT file_access_ticket_token_digest_unique UNIQUE ("tokenDigest"),
  -- One narrowly scoped authority per operation: a download names its file and a disposition, nothing of an upload; an upload
  -- carries its intent (limit, types, attach flag), is always single-use, and has no disposition.
  CONSTRAINT file_access_ticket_download_shape CHECK (
    operation <> 'download'
    OR ("fileId" IS NOT NULL AND disposition IS NOT NULL AND "maxBytes" IS NULL AND "mediaTypes" IS NULL AND attach IS NULL)
  ),
  CONSTRAINT file_access_ticket_upload_shape CHECK (
    operation <> 'upload'
    OR (disposition IS NULL AND "maxBytes" IS NOT NULL AND "mediaTypes" IS NOT NULL AND attach IS NOT NULL AND "singleUse")
  ),
  CONSTRAINT file_access_ticket_disposition_valid CHECK (disposition IS NULL OR disposition IN ('attachment', 'inline')),
  CONSTRAINT file_access_ticket_max_bytes_bounded CHECK ("maxBytes" IS NULL OR "maxBytes" BETWEEN 1 AND 104857600),
  CONSTRAINT file_access_ticket_media_types_allowed CHECK (
    "mediaTypes" IS NULL OR (
      cardinality("mediaTypes") >= 1
      AND array_position("mediaTypes", NULL) IS NULL
      AND "mediaTypes" <@ ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']::text[]
    )
  ),
  -- Short-lived and never extended (F16: 60–300 s; the default is frozen in 17.6).
  CONSTRAINT file_access_ticket_lifetime_bounded CHECK (
    "expiresAt" >= "createdAt" + interval '60 seconds' AND "expiresAt" <= "createdAt" + interval '300 seconds'
  ),
  CONSTRAINT file_access_ticket_use_count_valid CHECK ("useCount" >= 0),
  CONSTRAINT file_access_ticket_used_at_iff_used CHECK (("useCount" = 0) = ("usedAt" IS NULL)),
  CONSTRAINT file_access_ticket_single_use_once CHECK (NOT "singleUse" OR "useCount" <= 1),
  CONSTRAINT file_access_ticket_timestamps_ordered CHECK (
    ("usedAt" IS NULL OR "usedAt" >= "createdAt") AND ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
  )
);

-- Revocation of a file's tickets (with its logical deletion, 17.7) and the retention sweep of expired rows (17.7). The redemption
-- lookup uses the unique digest index.
CREATE INDEX file_access_ticket_file_idx ON file_access_ticket ("fileId") WHERE "fileId" IS NOT NULL;
CREATE INDEX file_access_ticket_expiry_idx ON file_access_ticket ("expiresAt");

-- The bindings never change and the lifetime is never extended.
CREATE TRIGGER file_access_ticket_immutable BEFORE UPDATE ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'operation', 'issuedBy', 'organizationId', 'tokenDigest', 'disposition', 'maxBytes', 'mediaTypes', 'attach', 'singleUse',
    'expiresAt', 'createdAt');

-- An upload ticket's created file is recorded once; the first use and the revocation are stamped once.
CREATE TRIGGER file_access_ticket_set_once BEFORE UPDATE ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION file_set_once('fileId', 'usedAt', 'revokedAt');

-- The file a ticket names belongs to the ticket's issuer and organization (a cross-row rule a foreign key cannot express with a
-- nullable organization; both sides are immutable, so the check at write time holds forever). An upload ticket starts without a file.
CREATE FUNCTION file_access_ticket_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.operation = 'upload' AND NEW."fileId" IS NOT NULL THEN
    RAISE EXCEPTION 'file_access_ticket %: an upload ticket starts without a file', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW."fileId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file f
    WHERE f.id = NEW."fileId" AND f."ownerService" = NEW."issuedBy" AND f."organizationId" IS NOT DISTINCT FROM NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'file_access_ticket %: the file is not the issuer''s in this organization', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_access_ticket_binding BEFORE INSERT OR UPDATE OF "fileId" ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION file_access_ticket_binding_guard();

-- Uses only go up, one at a time, and only while the ticket is valid (not revoked, not expired): a redemption bug cannot use a dead
-- ticket even if it skipped its own conditions. Single use is the CHECK above.
CREATE FUNCTION file_access_ticket_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."useCount" < OLD."useCount" OR NEW."useCount" > OLD."useCount" + 1 THEN
    RAISE EXCEPTION 'file_access_ticket %: uses are counted one at a time', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW."useCount" > OLD."useCount" AND (OLD."revokedAt" IS NOT NULL OR OLD."expiresAt" <= now()) THEN
    RAISE EXCEPTION 'file_access_ticket % is not usable', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_access_ticket_use_guard BEFORE UPDATE ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION file_access_ticket_use_guard();
