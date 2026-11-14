-- 0030 — payment-service: a terminal stored notification keeps its decision (Core V2 DO-22; the Owner's decision of 2026-11-14, Option 1).
-- DEVELOPMENT AND SIMULATION ONLY. Expand only: one guard function and one trigger. No row, column, constraint, index or privilege changes.
--
-- The webhook state machine is the application's (SDD section 7, "Duplicate event"; `WebhookService.receive`, `WebhookRetriever`); this
-- migration only states its existing finality at the database boundary, as every financial status machine already does:
--
--   * `processed`, `ignored` and `conflict` are TERMINAL: a duplicate delivery of one is a no-op answered 200, and the retrier never selects
--     it. Its decision (`state`, `outcome`, `matchedAttemptId`) never changes again.
--   * `received`, `processing`, `unmatched` and `failed` are NOT terminal and are not restricted here. `failed` stays eligible for the
--     existing provider redelivery and retry, `retries_exhausted` and `malformed_body` included (they bound the retrier only; S0-C12 item 15:
--     exhaustion is not abandonment).
--   * Re-recording the SAME decision stays possible (a concurrent duplicate that reprocessed the row before seeing it terminal writes the
--     same state, outcome and matched attempt), and so does the bookkeeping: `attempts`, `lastError`, `processedAt`.
--   * Unchanged: the received evidence (`webhook_event_immutable`, 0005), the write-once evidence index (0028), no delete or truncate (0029),
--     and inserts (a row stored directly in any state is not a transition).
--
-- A refused write is `23514` with constraint `webhook_event_terminal`; the application's own answer to that error is unchanged (a webhook
-- path answers 500 and the provider redelivers, then the terminal row answers 200).

CREATE FUNCTION payment_webhook_event_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state, NEW.outcome, NEW."matchedAttemptId") IS DISTINCT FROM (OLD.state, OLD.outcome, OLD."matchedAttemptId") THEN
    RAISE EXCEPTION 'webhook event % is terminal (%): its decision never changes', OLD.id, OLD.state USING ERRCODE = '23514', CONSTRAINT = 'webhook_event_terminal';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER webhook_event_12_terminal BEFORE UPDATE ON webhook_event
  FOR EACH ROW WHEN (OLD.state IN ('processed', 'ignored', 'conflict')) EXECUTE FUNCTION payment_webhook_event_terminal_guard();
