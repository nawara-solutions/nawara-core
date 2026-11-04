-- Core V2 S0-C12 correction (items 6, 7, 10, 12(6); register PAY-02, PAY-05, EVT-10): one capture fact, at most one late success. EXPAND ONLY.
--
-- The S0-C12 real-event investigation (2026-11-04, main 5370606) showed two DISTINCT authenticated notifications of the same provider capture (one
-- immutable `provider_transaction_fact`, FC-1) each recording a `payment_late_success`, each with its EVT-10 and its audit record:
-- `payment_late_success_once` identifies an OBSERVATION (attempt, source, stored webhook event), not the fact. Both concepts stay:
--   * the observation: every authenticated notification stays stored as received (`webhook_event`), and `payment_late_success_once` is unchanged;
--   * the financial fact: `payment_late_success_one_per_fact` makes a fact the subject of at most one late success. The first observation that
--     records it keeps its provenance (`source`, `webhookEventId`); a later observation of the same fact records nothing new.
-- Rows written before S4d may have no fact (NULL): they are not compared with each other and stay exactly as recorded.
--
-- Historical rows are never deleted, merged or rewritten. If a database already holds two late successes of one fact, this migration REFUSES
-- (nothing is changed, the deployment stops) so that the Owner decides what happens to that evidence; no automatic deduplication exists.

DO $$
DECLARE dup_facts integer; extra_rows integer;
BEGIN
  SELECT count(*)::int, COALESCE(sum(n - 1), 0)::int INTO dup_facts, extra_rows
    FROM (SELECT count(*) AS n FROM payment_late_success WHERE "factId" IS NOT NULL GROUP BY "factId" HAVING count(*) > 1) d;
  IF dup_facts > 0 THEN
    RAISE EXCEPTION 'payment_late_success: % capture fact(s) already have more than one late success (% extra row(s)); nothing changed — Owner decision required', dup_facts, extra_rows
      USING ERRCODE = '23505', CONSTRAINT = 'payment_late_success_one_per_fact';
  END IF;
END $$;

ALTER TABLE payment_late_success ADD CONSTRAINT payment_late_success_one_per_fact UNIQUE ("factId");
