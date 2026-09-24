-- Stage 16.4: the notification-service schema (ADR-0046; SDD notification-service §3-§5).
--
--   notification_template 1 ─< notification_template_version (immutable, published by migration)
--   notification 1 ─< notification_delivery (one per channel; pins one template version) 1 ─< notification_delivery_attempt
--
-- Conventions (Billing / Payment): camelCase quoted columns, timestamptz from the database clock, uuid ids, a CHECK on every
-- enumeration, triggers for what a CHECK cannot express. External identities (organizationId, recipientId, sourceService,
-- sourceEventId) are logical references only: no foreign key leaves this database. No ON DELETE CASCADE anywhere: delivery and
-- attempt evidence never disappears as a side effect. Trigger error messages carry ids and states only, never a destination or data.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── templates (SDD §3.4)

CREATE TABLE notification_template (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key              text NOT NULL,
  category         text NOT NULL,
  "ownerScope"     text NOT NULL DEFAULT 'platform',
  "organizationId" uuid,
  description      text NOT NULL,
  "createdAt"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_template_key_shape CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND length(key) <= 128),
  CONSTRAINT notification_template_category_valid CHECK (category IN ('SECURITY', 'TRANSACTIONAL', 'OPTIONAL')),
  -- `organization` is reserved for future overrides (no editor, no override API in Stage 16).
  CONSTRAINT notification_template_owner_scope_valid CHECK ("ownerScope" IN ('platform', 'organization')),
  CONSTRAINT notification_template_owner_scope_matches CHECK (("ownerScope" = 'platform') = ("organizationId" IS NULL)),
  CONSTRAINT notification_template_description_present CHECK (length(description) BETWEEN 1 AND 500),
  -- Target of notification's (templateId, category) foreign key: the copied category can never disagree with its template.
  CONSTRAINT notification_template_id_category_unique UNIQUE (id, category)
);
CREATE UNIQUE INDEX notification_template_platform_key_unique ON notification_template (key) WHERE "organizationId" IS NULL;

CREATE TRIGGER notification_template_immutable BEFORE UPDATE ON notification_template
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'key', 'category', 'ownerScope', 'organizationId', 'createdAt');

CREATE TABLE notification_template_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "templateId"     uuid NOT NULL REFERENCES notification_template (id),
  channel          text NOT NULL,
  locale           text NOT NULL,
  version          integer NOT NULL,
  variables        jsonb NOT NULL,
  subject          text,
  "bodyText"       text NOT NULL,
  "bodyHtml"       text,
  "smsMaxSegments" integer,
  checksum         text NOT NULL,
  "publishedAt"    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_template_version_channel_valid CHECK (channel IN ('EMAIL', 'SMS', 'IN_APP')),
  CONSTRAINT notification_template_version_locale_shape CHECK (locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length(locale) <= 35),
  CONSTRAINT notification_template_version_version_positive CHECK (version >= 1),
  CONSTRAINT notification_template_version_variables_object CHECK (jsonb_typeof(variables) = 'object'),
  CONSTRAINT notification_template_version_body_text_present CHECK (length("bodyText") BETWEEN 1 AND 16384),
  CONSTRAINT notification_template_version_body_html_bounded CHECK ("bodyHtml" IS NULL OR length("bodyHtml") BETWEEN 1 AND 65536),
  -- Email: a subject (one line: no header injection) and an optional HTML part. Other channels have neither.
  CONSTRAINT notification_template_version_email_subject CHECK (
    (channel = 'EMAIL') = (subject IS NOT NULL)
    AND (subject IS NULL OR (length(subject) BETWEEN 1 AND 255 AND subject !~ '[\r\n]'))
  ),
  CONSTRAINT notification_template_version_html_email_only CHECK ("bodyHtml" IS NULL OR channel = 'EMAIL'),
  CONSTRAINT notification_template_version_sms_segments CHECK (
    (channel = 'SMS') = ("smsMaxSegments" IS NOT NULL) AND ("smsMaxSegments" IS NULL OR "smsMaxSegments" BETWEEN 1 AND 10)
  ),
  CONSTRAINT notification_template_version_checksum_shape CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT notification_template_version_identity_unique UNIQUE ("templateId", channel, locale, version),
  -- Target of the delivery's pinned-version foreign key: a delivery's channel and locale always equal its version's.
  CONSTRAINT notification_template_version_id_channel_locale_unique UNIQUE (id, channel, locale)
);

-- A published version is immutable and permanent: past deliveries are explained by the exact version they pinned.
CREATE TRIGGER notification_template_version_immutable BEFORE UPDATE ON notification_template_version
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'templateId', 'channel', 'locale', 'version', 'variables', 'subject', 'bodyText', 'bodyHtml', 'smsMaxSegments', 'checksum', 'publishedAt');

CREATE FUNCTION notification_template_version_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification_template_version % is published and cannot be deleted', OLD.id USING ERRCODE = '23514';
END $$;
CREATE TRIGGER notification_template_version_no_delete BEFORE DELETE ON notification_template_version
  FOR EACH ROW EXECUTE FUNCTION notification_template_version_no_delete();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── notification (SDD §3.1)

-- The immutable communication intent: one template, ONE logical recipient, a locale request, data, a schedule and an expiry,
-- identified by its source. There is deliberately no status column: the status is derived from the deliveries (SDD §5.1).
CREATE TABLE notification (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sourceKind"       text NOT NULL,
  "sourceService"    text NOT NULL,
  "sourceEventId"    uuid,
  "idempotencyKey"   text,
  "requestHash"      text,
  "templateId"       uuid NOT NULL,
  category           text NOT NULL,
  "organizationId"   uuid,
  "recipientType"    text,
  "recipientId"      text,
  "requestedLocale"  text,
  data               jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secretCiphertext" bytea,
  "secretKeyId"      text,
  "scheduledAt"      timestamptz,
  "expiresAt"        timestamptz,
  "correlationId"    text,
  "cancelledAt"      timestamptz,
  "cancelledBy"      text,
  "createdAt"        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT notification_template_fk FOREIGN KEY ("templateId", category) REFERENCES notification_template (id, category),
  CONSTRAINT notification_source_kind_valid CHECK ("sourceKind" IN ('event', 'api')),
  CONSTRAINT notification_source_service_shape CHECK ("sourceService" ~ '^[a-z][a-z0-9-]{1,62}$'),
  -- Exactly the identity fields of the source kind: (sourceService, sourceEventId) for an event, (sourceService, idempotencyKey)
  -- plus the request hash for the API. Both are NOT NULL within their kind, so the partial unique indexes below have no NULL gap.
  CONSTRAINT notification_source_identity CHECK (
    ("sourceKind" = 'event' AND "sourceEventId" IS NOT NULL AND "idempotencyKey" IS NULL AND "requestHash" IS NULL)
    OR ("sourceKind" = 'api' AND "sourceEventId" IS NULL AND "idempotencyKey" IS NOT NULL AND "requestHash" IS NOT NULL)
  ),
  CONSTRAINT notification_idempotency_key_shape CHECK ("idempotencyKey" IS NULL OR "idempotencyKey" ~ '^[\x21-\x7e]{1,255}$'),
  CONSTRAINT notification_request_hash_shape CHECK ("requestHash" IS NULL OR "requestHash" ~ '^[0-9a-f]{64}$'),
  -- A generic reference (for example `user` + an Auth user id), never contact data. Both or neither.
  CONSTRAINT notification_recipient_pair CHECK (("recipientType" IS NULL) = ("recipientId" IS NULL)),
  CONSTRAINT notification_recipient_type_shape CHECK ("recipientType" IS NULL OR "recipientType" ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT notification_recipient_id_bounded CHECK ("recipientId" IS NULL OR length("recipientId") BETWEEN 1 AND 128),
  CONSTRAINT notification_requested_locale_shape CHECK (
    "requestedLocale" IS NULL OR ("requestedLocale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' AND length("requestedLocale") <= 35)
  ),
  -- The NON-secret template variables only (secret ones are sealed below), bounded.
  CONSTRAINT notification_data_object CHECK (jsonb_typeof(data) = 'object' AND octet_length(data::text) <= 8192),
  -- The secret variables, sealed together (AES-256-GCM, Stage 16.5); the key id beside them, the key never here. Purged to NULL.
  CONSTRAINT notification_secret_pair CHECK (("secretCiphertext" IS NULL) = ("secretKeyId" IS NULL)),
  CONSTRAINT notification_secret_key_id_shape CHECK ("secretKeyId" IS NULL OR "secretKeyId" ~ '^[A-Za-z0-9._-]{1,64}$'),
  CONSTRAINT notification_secret_bounded CHECK ("secretCiphertext" IS NULL OR octet_length("secretCiphertext") BETWEEN 1 AND 4096),
  CONSTRAINT notification_expiry_after_schedule CHECK ("expiresAt" IS NULL OR "scheduledAt" IS NULL OR "expiresAt" > "scheduledAt"),
  CONSTRAINT notification_correlation_id_shape CHECK ("correlationId" IS NULL OR "correlationId" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT notification_cancel_pair CHECK (("cancelledAt" IS NULL) = ("cancelledBy" IS NULL)),
  CONSTRAINT notification_cancelled_by_shape CHECK ("cancelledBy" IS NULL OR "cancelledBy" ~ '^[a-z][a-z0-9-]{1,62}$')
);

-- Exactly-once logical intent per source identity (SDD §4). Partial, so each applies only to its own kind.
CREATE UNIQUE INDEX notification_event_identity_unique ON notification ("sourceService", "sourceEventId") WHERE "sourceKind" = 'event';
CREATE UNIQUE INDEX notification_api_identity_unique ON notification ("sourceService", "idempotencyKey") WHERE "sourceKind" = 'api';
-- A caller's own notifications (per-caller reads, Stage 16.6); an organization's notifications; the secret purge scan (16.7).
CREATE INDEX notification_source_created_idx ON notification ("sourceService", "createdAt");
CREATE INDEX notification_organization_created_idx ON notification ("organizationId", "createdAt") WHERE "organizationId" IS NOT NULL;
CREATE INDEX notification_secret_expiry_idx ON notification ("expiresAt") WHERE "secretCiphertext" IS NOT NULL;

-- Immutable, except: the sealed secrets may only be PURGED (to NULL, never set or replaced), and the cancel stamp is set ONCE.
CREATE TRIGGER notification_immutable BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'sourceKind', 'sourceService', 'sourceEventId', 'idempotencyKey', 'requestHash', 'templateId', 'category', 'organizationId',
    'recipientType', 'recipientId', 'requestedLocale', 'data', 'scheduledAt', 'expiresAt', 'correlationId', 'createdAt');

CREATE FUNCTION notification_purge_and_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."secretCiphertext" IS DISTINCT FROM OLD."secretCiphertext" OR NEW."secretKeyId" IS DISTINCT FROM OLD."secretKeyId")
     AND NOT (NEW."secretCiphertext" IS NULL AND NEW."secretKeyId" IS NULL) THEN
    RAISE EXCEPTION 'notification %: sealed secrets can only be purged', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL
     AND (NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" OR NEW."cancelledBy" IS DISTINCT FROM OLD."cancelledBy") THEN
    RAISE EXCEPTION 'notification %: the cancel stamp is set once', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_purge_and_cancel_guard BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_purge_and_cancel_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────── notification_delivery (SDD §3.2)

-- One channel of one intent: the destination snapshot actually used, the pinned template version and locale, the delivery state.
-- "Scheduled", "queued" and "retry" are all PENDING with a due nextAttemptAt (SDD §5.2): one claimable state, one index.
CREATE TABLE notification_delivery (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "notificationId"    uuid NOT NULL REFERENCES notification (id),
  channel             text NOT NULL,
  destination         text,
  "templateVersionId" uuid NOT NULL,
  locale              text NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING',
  attempts            integer NOT NULL DEFAULT 0,
  "ambiguousResends"  integer NOT NULL DEFAULT 0,
  "nextAttemptAt"     timestamptz,
  "leaseUntil"        timestamptz,
  provider            text,
  "providerMessageId" text,
  "failureClass"      text,
  "failureCode"       text,
  "sentAt"            timestamptz,
  "failedAt"          timestamptz,
  "completedAt"       timestamptz,
  "createdAt"         timestamptz NOT NULL DEFAULT now(),
  "updatedAt"         timestamptz NOT NULL DEFAULT now(),

  -- Pinned at intake: the channel and locale of the delivery are those of the exact version that renders it.
  CONSTRAINT notification_delivery_version_fk FOREIGN KEY ("templateVersionId", channel, locale)
    REFERENCES notification_template_version (id, channel, locale),
  CONSTRAINT notification_delivery_channel_valid CHECK (channel IN ('EMAIL', 'SMS', 'IN_APP')),
  -- One delivery per channel per intent (one recipient per notification; a second address is a second notification).
  CONSTRAINT notification_delivery_channel_unique UNIQUE ("notificationId", channel),
  -- The snapshot, as received: an address channel needs one, IN_APP has none. Its FORMAT (E.164 for SMS, D20) is validated at
  -- intake (Stage 16.5), which records an invalid one as FAILED invalid_destination; nothing here normalizes or guesses a country.
  CONSTRAINT notification_delivery_destination_presence CHECK ((channel = 'IN_APP') = (destination IS NULL)),
  CONSTRAINT notification_delivery_destination_bounded CHECK (destination IS NULL OR (length(destination) BETWEEN 1 AND 320 AND destination !~ '[[:cntrl:]]')),
  CONSTRAINT notification_delivery_status_valid CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT notification_delivery_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT notification_delivery_ambiguous_resends_valid CHECK ("ambiguousResends" IN (0, 1)),
  -- The state fields agree with the status.
  CONSTRAINT notification_delivery_due_iff_pending CHECK ((status = 'PENDING') = ("nextAttemptAt" IS NOT NULL)),
  CONSTRAINT notification_delivery_lease_iff_sending CHECK ((status = 'SENDING') = ("leaseUntil" IS NOT NULL)),
  CONSTRAINT notification_delivery_sent_at_iff_sent CHECK ((status = 'SENT') = ("sentAt" IS NOT NULL)),
  CONSTRAINT notification_delivery_failed_at_iff_failed CHECK ((status = 'FAILED') = ("failedAt" IS NOT NULL)),
  CONSTRAINT notification_delivery_completed_iff_terminal CHECK (
    (status IN ('SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED')) = ("completedAt" IS NOT NULL)
  ),
  CONSTRAINT notification_delivery_failed_has_code CHECK (status <> 'FAILED' OR "failureCode" IS NOT NULL),
  CONSTRAINT notification_delivery_provider_shape CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT notification_delivery_provider_message_id_bounded CHECK ("providerMessageId" IS NULL OR length("providerMessageId") BETWEEN 1 AND 256),
  -- A bounded code, never provider text.
  CONSTRAINT notification_delivery_failure_class_valid CHECK ("failureClass" IS NULL OR "failureClass" IN ('retryable', 'terminal', 'ambiguous')),
  CONSTRAINT notification_delivery_failure_code_shape CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$')
);

-- The due claim (Stage 16.7: WHERE status = 'PENDING' AND "nextAttemptAt" <= now() ORDER BY "nextAttemptAt" FOR UPDATE SKIP LOCKED)
-- and the expired-lease scan. Deliveries of a notification are found through the (notificationId, channel) unique key.
CREATE INDEX notification_delivery_due_idx ON notification_delivery ("nextAttemptAt") WHERE status = 'PENDING';
CREATE INDEX notification_delivery_lease_idx ON notification_delivery ("leaseUntil") WHERE status = 'SENDING';

CREATE TRIGGER notification_delivery_immutable BEFORE UPDATE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'notificationId', 'channel', 'destination', 'templateVersionId', 'locale', 'createdAt');

-- The pinned version belongs to the notification's own template (a composite foreign key cannot reach through notification).
CREATE FUNCTION notification_delivery_template_matches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM notification n JOIN notification_template_version v ON v."templateId" = n."templateId"
    WHERE n.id = NEW."notificationId" AND v.id = NEW."templateVersionId"
  ) THEN
    RAISE EXCEPTION 'notification_delivery %: the template version does not belong to the notification''s template', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_template_matches BEFORE INSERT ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION notification_delivery_template_matches();

-- A delivery starts PENDING (SDD §5.2: intake creates it due now or at scheduledAt).
CREATE FUNCTION notification_delivery_starts_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'notification_delivery % must be created PENDING, not %', NEW.id, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_starts_pending BEFORE INSERT ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION notification_delivery_starts_pending();

-- The frozen transition matrix (SDD §5.2); every other change of status is refused, and a terminal status is final.
CREATE FUNCTION notification_delivery_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('PENDING', 'SENDING'), ('PENDING', 'CANCELLED'), ('PENDING', 'EXPIRED'),
      ('SENDING', 'SENT'), ('SENDING', 'PENDING'), ('SENDING', 'FAILED'), ('SENDING', 'UNCONFIRMED'), ('SENDING', 'EXPIRED')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'notification_delivery % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_status_transition BEFORE UPDATE OF status ON notification_delivery
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION notification_delivery_status_transition_guard();

-- A terminal delivery is final in every field, not only its status (the evidence cannot be rewritten afterwards).
CREATE FUNCTION notification_delivery_terminal_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SENT', 'FAILED', 'UNCONFIRMED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'notification_delivery % is % and final', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_terminal_final BEFORE UPDATE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION notification_delivery_terminal_final();

-- ─────────────────────────────────────────────────────────────────────────── notification_delivery_attempt (SDD §3.3, §5.3)

-- Append-oriented provider evidence: one row per provider call, inserted STARTED before the call, completed exactly once, then
-- immutable. No raw provider response, request or body.
CREATE TABLE notification_delivery_attempt (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "deliveryId"        uuid NOT NULL REFERENCES notification_delivery (id),
  "attemptNumber"     integer NOT NULL,
  provider            text NOT NULL,
  "startedAt"         timestamptz NOT NULL DEFAULT now(),
  "completedAt"       timestamptz,
  outcome             text NOT NULL DEFAULT 'STARTED',
  "providerMessageId" text,
  "failureCode"       text,
  "latencyMs"         integer,

  CONSTRAINT notification_delivery_attempt_number_positive CHECK ("attemptNumber" >= 1),
  CONSTRAINT notification_delivery_attempt_number_unique UNIQUE ("deliveryId", "attemptNumber"),
  CONSTRAINT notification_delivery_attempt_provider_shape CHECK (provider ~ '^[a-z][a-z0-9_-]{0,62}$'),
  CONSTRAINT notification_delivery_attempt_outcome_valid CHECK (outcome IN ('STARTED', 'ACCEPTED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE', 'AMBIGUOUS')),
  CONSTRAINT notification_delivery_attempt_completed_iff_final CHECK ((outcome = 'STARTED') = ("completedAt" IS NULL)),
  CONSTRAINT notification_delivery_attempt_provider_message_id_bounded CHECK ("providerMessageId" IS NULL OR length("providerMessageId") BETWEEN 1 AND 256),
  CONSTRAINT notification_delivery_attempt_failure_code_shape CHECK ("failureCode" IS NULL OR "failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT notification_delivery_attempt_latency_valid CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0)
);

CREATE TRIGGER notification_delivery_attempt_immutable BEFORE UPDATE ON notification_delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('id', 'deliveryId', 'attemptNumber', 'provider', 'startedAt');

-- STARTED at insert; then exactly one completion to a final outcome; then nothing.
CREATE FUNCTION notification_delivery_attempt_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome <> 'STARTED' THEN
      RAISE EXCEPTION 'notification_delivery_attempt % must be created STARTED, not %', NEW.id, NEW.outcome USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.outcome <> 'STARTED' THEN
    RAISE EXCEPTION 'notification_delivery_attempt % is % and final', OLD.id, OLD.outcome USING ERRCODE = '23514';
  ELSIF NEW.outcome = 'STARTED' THEN
    RAISE EXCEPTION 'notification_delivery_attempt % can only be completed to a final outcome', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notification_delivery_attempt_lifecycle BEFORE INSERT OR UPDATE ON notification_delivery_attempt
  FOR EACH ROW EXECUTE FUNCTION notification_delivery_attempt_lifecycle();
