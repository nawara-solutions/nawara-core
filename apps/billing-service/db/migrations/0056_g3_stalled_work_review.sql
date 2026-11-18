-- Core V2 G3 (DO-31, DO-33, DO-41, DO-42; the Owner's G3 GO, 2026-11-18): durable, ESCALATION-ONLY review evidence for Billing work that can stay in
-- a state with no exit. Additive only: no existing table, row, rule, status or retry changes.
--
--   * stalled_work_review: ONE append-only row per stay ("episode") of a subject in a qualifying state past its threshold. The caller supplies only
--     the kind and the subject; the database derives everything else from Billing's own rows and REFUSES the row unless the subject is, right now,
--     in the qualifying state and past the threshold (database-enforced provenance). (kind, episodeKey) is unique, so a repeated or concurrent
--     sweep writes one row.
--   * stalled_work_exit: at most ONE append-only row per review, once its subject has left the qualifying state; refused while it is still in it.
--   * Neither table is read by any financial path. Nothing here closes a case, stops or caps a retry, releases a hold, changes a status, assigns
--     liability or moves money.
--
-- Kinds, subjects, episodes and thresholds (code constants of this migration, never configuration):
--   assistance_dispute_open      DO-31  an open `cash_not_returned` / `collection_not_made` dispute (J-1)   episode = the dispute     30 days after openedAt
--   settlement_channel_uncertain DO-33  an uncertain settlement channel (its request is `sending`, E-6)    episode = the channel     settleBy + 7 days
--   payment_request_sending      DO-41  a payment request in `sending`                                    episode = the request     20 send attempts, or 24 h
--                                       (`sending` is entered once per request; the clock is its append-only billing_transition row, never
--                                       `sendingSince`, which every claim re-stamps)                                                 after that transition
--   payment_request_auth_fault   DO-41  Payment refused Billing's own service token while the request is `sending` (immediate; Billing-internal)
--   payment_event_conflict       DO-42  a `conflict` payment-event receipt                                  episode = the event id    immediate (next sweep)
--                                       (every delivery, and every reconciler pass, leaves its own receipt row: the event id is the episode)
--
-- Scope (derived here, never from a caller): assistance kinds take the request's Platform, its Company (billing_platform) and Organization;
-- payment-request kinds take the invoice's Company ONLY when the seller is a Company, the Platform only when the invoice has exactly one, and the
-- invoice's Organization. A conflict receipt has a scope only when it names an existing Billing payment request AND its paymentId equals that
-- request's paymentId (the Owner's DO-42 rule); otherwise it stays Billing-internal (no request, no Company, no Platform, no Organization).
-- payment_request_auth_fault is ALWAYS Billing-internal: its scope columns are NULL whatever the request (the Owner's G3 rule 3).

CREATE FUNCTION billing_stalled_work_threshold(p_kind text) RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_kind
    WHEN 'assistance_dispute_open' THEN interval '30 days'
    WHEN 'settlement_channel_uncertain' THEN interval '7 days'
    WHEN 'payment_request_sending' THEN interval '24 hours'
    WHEN 'payment_request_auth_fault' THEN interval '0'
    WHEN 'payment_event_conflict' THEN interval '0'
  END
$$;

-- DO-41: the send-attempt threshold (a count; reaching it escalates earlier than the 24 hours). It caps nothing: the dispatcher keeps retrying.
CREATE FUNCTION billing_stalled_work_send_attempts() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 20 $$;

-- The subject of a review, as Billing's own rows state it now. No row: the subject does not exist (or is not of this kind).
--   inState: the subject is in the kind's qualifying state; due: inState and past the threshold (database time); reason: why it is due.
CREATE FUNCTION billing_stalled_work_subject(p_kind text, p_subject uuid)
RETURNS TABLE ("episodeKey" uuid, "inState" boolean, "observedState" text, "anchorAt" timestamptz, due boolean, reason text, "sendAttempts" integer,
               "paymentRequestId" uuid, "companyId" uuid, "platformId" uuid, "organizationId" uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE thr interval := billing_stalled_work_threshold(p_kind);
BEGIN
  IF p_kind = 'assistance_dispute_open' THEN
    RETURN QUERY
      SELECT d.id, (d.status = 'open' AND d."reasonCode" IN ('cash_not_returned', 'collection_not_made')), d.status, d."openedAt",
             (d.status = 'open' AND d."reasonCode" IN ('cash_not_returned', 'collection_not_made') AND now() >= d."openedAt" + thr), 'elapsed'::text, NULL::integer,
             NULL::uuid, bp."companyId", a."platformId", a."organizationId"
        FROM assistance_dispute d JOIN assistance_request a ON a.id = d."assistanceRequestId" JOIN billing_platform bp ON bp."platformId" = a."platformId"
       WHERE d.id = p_subject;
  ELSIF p_kind = 'settlement_channel_uncertain' THEN
    RETURN QUERY
      SELECT c.id, c.status = 'uncertain', c.status, a."settleBy",
             (c.status = 'uncertain' AND a."settleBy" IS NOT NULL AND now() >= a."settleBy" + thr), 'elapsed'::text, NULL::integer,
             c."paymentRequestId", bp."companyId", a."platformId", a."organizationId"
        FROM assistance_settlement_channel c JOIN assistance_request a ON a.id = c."assistanceRequestId" JOIN billing_platform bp ON bp."platformId" = a."platformId"
       WHERE c.id = p_subject;
  ELSIF p_kind IN ('payment_request_sending', 'payment_request_auth_fault') THEN
    RETURN QUERY
      SELECT pr.id, pr.status = 'sending', pr.status, t."occurredAt",
             CASE WHEN pr.status <> 'sending' OR t."occurredAt" IS NULL THEN false
                  WHEN p_kind = 'payment_request_auth_fault' THEN true
                  ELSE pr."sendAttempts" >= billing_stalled_work_send_attempts() OR now() >= t."occurredAt" + thr END,
             CASE WHEN p_kind = 'payment_request_auth_fault' THEN 'auth_fault'
                  WHEN pr."sendAttempts" >= billing_stalled_work_send_attempts() THEN 'send_attempts' ELSE 'elapsed' END,
             pr."sendAttempts", pr.id,
             CASE WHEN p_kind = 'payment_request_sending' AND i."sellerType" = 'company' THEN i."sellerId"::uuid END,
             CASE WHEN p_kind = 'payment_request_sending' THEN (SELECT CASE WHEN count(DISTINCT p."platformId") = 1 THEN min(p."platformId"::text)::uuid END
                                                                  FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = i.id) END,
             CASE WHEN p_kind = 'payment_request_sending' THEN i."organizationId" END
        FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId"
        LEFT JOIN LATERAL (SELECT min(bt."occurredAt") AS "occurredAt" FROM billing_transition bt
                            WHERE bt."entityType" = 'payment_request' AND bt."entityId" = pr.id AND bt."toStatus" = 'sending') t ON true
       WHERE pr.id = p_subject;
  ELSIF p_kind = 'payment_event_conflict' THEN
    RETURN QUERY
      SELECT COALESCE(r."eventId", r.id), r.outcome = 'conflict', r.outcome, r."receivedAt", r.outcome = 'conflict', 'conflict_observed'::text, NULL::integer,
             pr.id,
             CASE WHEN pr.id IS NOT NULL AND i."sellerType" = 'company' THEN i."sellerId"::uuid END,
             CASE WHEN pr.id IS NOT NULL THEN (SELECT CASE WHEN count(DISTINCT p."platformId") = 1 THEN min(p."platformId"::text)::uuid END
                                                 FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = i.id) END,
             CASE WHEN pr.id IS NOT NULL THEN i."organizationId" END
        FROM payment_event_receipt r
        -- the Owner's DO-42 rule: a trustworthy request only (it exists, and the receipt's paymentId is that request's); nothing is inferred otherwise
        LEFT JOIN payment_request pr ON pr.id = r."paymentRequestId" AND r."paymentId" IS NOT NULL AND pr."paymentId" = r."paymentId"
        LEFT JOIN invoice i ON i.id = pr."invoiceId"
       WHERE r.id = p_subject;
  END IF;
END $$;

CREATE TABLE stalled_work_review (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL,
  "subjectId"        uuid NOT NULL,                       -- the dispute, the channel, the payment request, or the first conflict receipt seen
  "episodeKey"       uuid NOT NULL,                       -- derived: the dispute, the channel, the request, or the conflict's event id
  "observedState"    text NOT NULL,                       -- derived: the subject's state when escalated
  "anchorAt"         timestamptz NOT NULL,                -- derived: the instant the threshold counts from (openedAt, settleBy, the sending transition, receivedAt)
  "thresholdSeconds" integer NOT NULL,                    -- derived: the threshold in force (a snapshot of this migration's constant)
  reason             text NOT NULL,                       -- derived: elapsed | send_attempts | auth_fault | conflict_observed
  "sendAttempts"     integer,                             -- derived (payment-request kinds): the attempt count when escalated
  "paymentRequestId" uuid REFERENCES payment_request (id), -- derived: the related request (DO-33's channel request; DO-41; a TRUSTED DO-42 request only)
  "companyId"        uuid,                                -- derived scope (NULL: Billing-internal)
  "platformId"       uuid,
  "organizationId"   uuid,
  "escalatedAt"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stalled_work_review_kind CHECK (kind IN ('assistance_dispute_open', 'settlement_channel_uncertain', 'payment_request_sending',
    'payment_request_auth_fault', 'payment_event_conflict')),
  CONSTRAINT stalled_work_review_reason CHECK (reason IN ('elapsed', 'send_attempts', 'auth_fault', 'conflict_observed')),
  CONSTRAINT stalled_work_review_once UNIQUE (kind, "episodeKey"),
  -- auth_fault is Billing-internal: never a Company, Platform or Organization (the Owner's G3 rule 3)
  CONSTRAINT stalled_work_review_auth_fault_internal CHECK (kind <> 'payment_request_auth_fault' OR ("companyId" IS NULL AND "platformId" IS NULL AND "organizationId" IS NULL))
);
CREATE INDEX stalled_work_review_company_idx ON stalled_work_review ("companyId", id) WHERE "companyId" IS NOT NULL;
CREATE INDEX stalled_work_review_platform_idx ON stalled_work_review ("platformId", id) WHERE "platformId" IS NOT NULL;

-- The insert guard: the caller's kind and subject only; every other column is derived here, and the row is refused unless the subject is in the
-- qualifying state and past its threshold NOW. It runs before ON CONFLICT's arbiter, so a duplicate episode is a no-op, not an error.
CREATE FUNCTION billing_stalled_work_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM billing_stalled_work_subject(NEW.kind, NEW."subjectId");
  IF NOT FOUND OR s."episodeKey" IS NULL OR NOT s.due OR s."anchorAt" IS NULL THEN
    RAISE EXCEPTION 'stalled work review: % % is not in its qualifying state past its threshold', NEW.kind, NEW."subjectId"
      USING ERRCODE = '23514', CONSTRAINT = 'stalled_work_review_not_due';
  END IF;
  NEW."episodeKey" := s."episodeKey";
  NEW."observedState" := s."observedState";
  NEW."anchorAt" := s."anchorAt";
  NEW."thresholdSeconds" := extract(epoch FROM billing_stalled_work_threshold(NEW.kind))::integer;
  NEW.reason := s.reason;
  NEW."sendAttempts" := s."sendAttempts";
  NEW."paymentRequestId" := s."paymentRequestId";
  NEW."companyId" := s."companyId";
  NEW."platformId" := s."platformId";
  NEW."organizationId" := s."organizationId";
  NEW."escalatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER stalled_work_review_05_guard BEFORE INSERT ON stalled_work_review FOR EACH ROW EXECUTE FUNCTION billing_stalled_work_review_guard();
CREATE TRIGGER stalled_work_review_10_append_only BEFORE UPDATE OR DELETE ON stalled_work_review FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER stalled_work_review_11_no_truncate BEFORE TRUNCATE ON stalled_work_review FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

CREATE TABLE stalled_work_exit (
  "reviewId"     uuid PRIMARY KEY REFERENCES stalled_work_review (id),
  "exitedState"  text NOT NULL,                           -- derived: the subject's state when the exit was observed
  "observedAt"   timestamptz NOT NULL DEFAULT now()
);

-- The exit guard: refused while the subject is still in the qualifying state. A conflict receipt is append-only and never leaves `conflict`, so a
-- payment_event_conflict review has no exit.
CREATE FUNCTION billing_stalled_work_exit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r stalled_work_review%ROWTYPE; s record;
BEGIN
  SELECT * INTO r FROM stalled_work_review WHERE id = NEW."reviewId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stalled work exit: review % does not exist', NEW."reviewId" USING ERRCODE = '23503', CONSTRAINT = 'stalled_work_exit_not_exited';
  END IF;
  SELECT * INTO s FROM billing_stalled_work_subject(r.kind, r."subjectId");
  IF r.kind = 'payment_event_conflict' OR NOT FOUND OR s."inState" THEN
    RAISE EXCEPTION 'stalled work exit: the subject of review % has not left its qualifying state', NEW."reviewId"
      USING ERRCODE = '23514', CONSTRAINT = 'stalled_work_exit_not_exited';
  END IF;
  NEW."exitedState" := s."observedState";
  NEW."observedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER stalled_work_exit_05_guard BEFORE INSERT ON stalled_work_exit FOR EACH ROW EXECUTE FUNCTION billing_stalled_work_exit_guard();
CREATE TRIGGER stalled_work_exit_10_append_only BEFORE UPDATE OR DELETE ON stalled_work_exit FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER stalled_work_exit_11_no_truncate BEFORE TRUNCATE ON stalled_work_exit FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();
