-- Core V2 DO-43a (the Owner's DO-43 GO, decisions D43-1 to D43-8, 2026-11-20): DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY. Best-effort,
-- header-only observations of audit-service's own dead-letter transfers, and the coverage facts needed to say when those observations are
-- incomplete. Not complete evidence and not production-certified: a missing row never proves that no dead letter exists (D43-7).
-- Expand only: two new tables, their guard functions and triggers. No existing table, row, trigger or privilege changes.
--
-- `audit_dead_letter_transition` (D43-2, D43-3): one row per (transfer attempt, transition). An attempt is ONE physical attempt to copy a
-- failed delivery into `<queue>.dead`; the kit mints a fresh UUID for it (also stamped on the broker copy as `x-nawara-dead-letter-attempt`,
-- a diagnostic label, never producer identity). A replay, a duplicated publication or a crash redelivery that is transferred again is a NEW
-- attempt: nothing here is keyed by the event id, the retry count, the queue or the failure class.
--   attempted              the bus is about to send the copy
--   transfer_confirmed     the broker confirmed the copy (before the original was acknowledged)
--   transfer_unconfirmed   the copy could not be confirmed; the original was requeued (the existing deferred path)
-- An attempt has at most one outcome. An outcome without its `attempted` row is admitted: observations are best effort and either can be
-- lost (buffer saturation, a database outage, a crash), so the reader must not assume pairs. An observation that could not be stored is
-- NEVER written as a transition: it is counted in the process's coverage facts instead (observation failure is not transfer failure).
--
-- `audit_dead_letter_coverage` (D43-3, D43-8): per process instance (a fresh id at every start), `started` (seq 0), then a `heartbeat`
-- every 60 s with the instance's cumulative counters, and `stopped` after a clean final flush. Counters only grow within an instance (a
-- restart is a new instance, so a reset is always visible as an instance boundary). The reader decides coverage from these facts AND an
-- expected instance set it establishes independently; without both, coverage is unknown.
--
-- No payload, no body, no digest, no changes, no actor, no Organization, Company or Platform: identifiers, codes and counters only.
-- Append-only for every role (the 18.3 pattern); the retention grant does not cover them. No purge until DO-65 decides retention (D43-5).

CREATE TABLE audit_dead_letter_transition (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "attemptId"       uuid NOT NULL,                 -- minted by the bus per physical transfer attempt
  transition        text NOT NULL,
  "instanceId"      uuid NOT NULL,                 -- the observing process instance (its coverage facts)
  consumer          text NOT NULL,                 -- the consumer's own queue; the copy went to `<consumer>.dead`
  "eventId"         text NOT NULL,                 -- '' when the message id was absent or not a safe token
  "eventName"       text NOT NULL,                 -- the AMQP type when a safe token, else ''
  source            text NOT NULL,                 -- the delivery's source label as received ('' when absent): NOT verified identity
  failure           text NOT NULL,                 -- the kit's classification
  reason            text,                          -- a permanent failure's reason code
  "errorClass"      text NOT NULL,                 -- the error's class name (never its message)
  "retryCount"      integer NOT NULL,
  "replayCount"     integer NOT NULL,
  redelivered       boolean NOT NULL,
  "observedAt"      timestamptz NOT NULL,          -- the process's clock when observed (it may differ from the database's)
  "recordedAt"      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_dead_letter_transition_kind CHECK (transition IN ('attempted', 'transfer_confirmed', 'transfer_unconfirmed')),
  CONSTRAINT audit_dead_letter_transition_failure CHECK (failure IN ('malformed', 'permanent', 'retries_exhausted')),
  CONSTRAINT audit_dead_letter_transition_tokens CHECK (
    consumer ~ '^[A-Za-z0-9._:-]{1,200}$' AND "eventId" ~ '^[A-Za-z0-9._:-]{0,128}$' AND "eventName" ~ '^[A-Za-z0-9._:-]{0,255}$'
    AND source ~ '^[a-z0-9-]{0,63}$' AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$') AND "errorClass" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  CONSTRAINT audit_dead_letter_transition_counts CHECK ("retryCount" BETWEEN 0 AND 1000000 AND "replayCount" BETWEEN 0 AND 1000000),
  CONSTRAINT audit_dead_letter_transition_once UNIQUE ("attemptId", transition)
);
-- at most ONE outcome per attempt: confirmed and unconfirmed exclude each other
CREATE UNIQUE INDEX audit_dead_letter_transition_one_outcome ON audit_dead_letter_transition ("attemptId") WHERE transition <> 'attempted';
CREATE INDEX audit_dead_letter_transition_time ON audit_dead_letter_transition ("recordedAt", id);
CREATE INDEX audit_dead_letter_transition_event ON audit_dead_letter_transition (consumer, "eventId");

-- Every row of one attempt describes the same delivery, observed by the same instance: a later row cannot re-label an attempt.
CREATE FUNCTION audit_dead_letter_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE o audit_dead_letter_transition%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.dead_letter_attempt:' || NEW."attemptId"::text, 0));
  SELECT * INTO o FROM audit_dead_letter_transition WHERE "attemptId" = NEW."attemptId" LIMIT 1;
  IF o.id IS NOT NULL AND (o."instanceId", o.consumer, o."eventId", o."eventName", o.source, o.failure, o.reason, o."errorClass", o."retryCount", o."replayCount", o.redelivered)
     IS DISTINCT FROM (NEW."instanceId", NEW.consumer, NEW."eventId", NEW."eventName", NEW.source, NEW.failure, NEW.reason, NEW."errorClass", NEW."retryCount", NEW."replayCount", NEW.redelivered) THEN
    RAISE EXCEPTION 'dead-letter attempt %: every transition describes the same delivery', NEW."attemptId" USING ERRCODE = '23514', CONSTRAINT = 'audit_dead_letter_transition_consistent';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER audit_dead_letter_transition_05_guard BEFORE INSERT ON audit_dead_letter_transition
  FOR EACH ROW EXECUTE FUNCTION audit_dead_letter_transition_guard();

CREATE TABLE audit_dead_letter_coverage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instanceId"        uuid NOT NULL,
  kind                text NOT NULL,
  seq                 bigint NOT NULL,              -- 0 for `started`, then strictly increasing within the instance
  consumers           text[] NOT NULL,              -- the opted-in queues this instance observes (fixed for the instance)
  "observedTotal"     bigint NOT NULL,              -- observations accepted into the buffer
  "persistedTotal"    bigint NOT NULL,              -- observations the database stored
  "droppedOverflow"   bigint NOT NULL,              -- refused: the buffer was full
  "droppedSink"       bigint NOT NULL,              -- lost: a flush failed (a database outage included)
  "rejectedTotal"     bigint NOT NULL,              -- refused by this schema (a contradictory outcome, a malformed value): never stored
  buffered            integer NOT NULL,             -- waiting in the buffer when this fact was taken
  "observedAt"        timestamptz NOT NULL,
  "recordedAt"        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_dead_letter_coverage_kind CHECK (kind IN ('started', 'heartbeat', 'stopped')),
  CONSTRAINT audit_dead_letter_coverage_seq CHECK (seq >= 0 AND ((kind = 'started') = (seq = 0))),
  CONSTRAINT audit_dead_letter_coverage_consumers CHECK (cardinality(consumers) BETWEEN 1 AND 32 AND array_position(consumers, NULL) IS NULL),
  CONSTRAINT audit_dead_letter_coverage_counts CHECK (
    "observedTotal" >= 0 AND "persistedTotal" >= 0 AND "droppedOverflow" >= 0 AND "droppedSink" >= 0 AND "rejectedTotal" >= 0 AND buffered BETWEEN 0 AND 1000000),
  CONSTRAINT audit_dead_letter_coverage_once UNIQUE ("instanceId", seq)
);
CREATE UNIQUE INDEX audit_dead_letter_coverage_one_stop ON audit_dead_letter_coverage ("instanceId") WHERE kind = 'stopped';
CREATE INDEX audit_dead_letter_coverage_time ON audit_dead_letter_coverage ("recordedAt", id);

-- A process's facts form one forward sequence: started first, seq strictly increasing, the same consumers, counters never decreasing,
-- nothing after `stopped`. A counter reset can therefore only appear as a NEW instance id.
CREATE FUNCTION audit_dead_letter_coverage_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE p audit_dead_letter_coverage%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.dead_letter_instance:' || NEW."instanceId"::text, 0));
  SELECT * INTO p FROM audit_dead_letter_coverage WHERE "instanceId" = NEW."instanceId" ORDER BY seq DESC LIMIT 1;
  IF NEW.kind = 'started' THEN
    IF p.id IS NOT NULL THEN
      RAISE EXCEPTION 'dead-letter coverage %: an instance starts once', NEW."instanceId" USING ERRCODE = '23514', CONSTRAINT = 'audit_dead_letter_coverage_sequence';
    END IF;
  ELSIF p.id IS NULL OR p.kind = 'stopped' OR NEW.seq <= p.seq OR NEW.consumers IS DISTINCT FROM p.consumers
     OR NEW."observedTotal" < p."observedTotal" OR NEW."persistedTotal" < p."persistedTotal"
     OR NEW."droppedOverflow" < p."droppedOverflow" OR NEW."droppedSink" < p."droppedSink" OR NEW."rejectedTotal" < p."rejectedTotal" THEN
    RAISE EXCEPTION 'dead-letter coverage %: not the forward continuation of its instance', NEW."instanceId" USING ERRCODE = '23514', CONSTRAINT = 'audit_dead_letter_coverage_sequence';
  END IF;
  NEW."recordedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER audit_dead_letter_coverage_05_guard BEFORE INSERT ON audit_dead_letter_coverage
  FOR EACH ROW EXECUTE FUNCTION audit_dead_letter_coverage_guard();

-- Append-only for every role: UPDATE, DELETE and TRUNCATE are refused; the runtime keeps INSERT / SELECT only.
CREATE FUNCTION audit_dead_letter_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
CREATE TRIGGER audit_dead_letter_transition_10_append_only BEFORE UPDATE OR DELETE ON audit_dead_letter_transition
  FOR EACH ROW EXECUTE FUNCTION audit_dead_letter_append_only();
CREATE TRIGGER audit_dead_letter_transition_11_no_truncate BEFORE TRUNCATE ON audit_dead_letter_transition
  FOR EACH STATEMENT EXECUTE FUNCTION audit_dead_letter_append_only();
CREATE TRIGGER audit_dead_letter_coverage_10_append_only BEFORE UPDATE OR DELETE ON audit_dead_letter_coverage
  FOR EACH ROW EXECUTE FUNCTION audit_dead_letter_append_only();
CREATE TRIGGER audit_dead_letter_coverage_11_no_truncate BEFORE TRUNCATE ON audit_dead_letter_coverage
  FOR EACH STATEMENT EXECUTE FUNCTION audit_dead_letter_append_only();
SELECT audit_restrict_to_append_only('audit_dead_letter_transition');
SELECT audit_restrict_to_append_only('audit_dead_letter_coverage');
