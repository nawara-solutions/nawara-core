-- 0029 — payment-service: a stored provider notification is never deleted or truncated (Core V2 DO-70; S0 FC-1: "Raw webhooks stay in the
-- existing `webhook_event`"). DEVELOPMENT AND SIMULATION ONLY. Expand only: one guard function, two triggers, a privilege revocation.
--
-- Before this migration only UPDATE was guarded (0005 freezes the received evidence; 0028 writes the evidence index once). A notification that
-- no fact, observation or quarantine record references (an `ignored`, `failed` or `unmatched` row, a malformed dispute notification, DO-55)
-- could be deleted, and a referenced one was protected only by its foreign key. A stored notification is the signed evidence itself: losing it
-- loses the only record of what the provider said.
--
--   * DELETE and TRUNCATE are refused for every role, the owner included (a trigger), with `23514`, like the fact tables (0013).
--   * The runtime role (and any other non-owner grantee) also loses DELETE, TRUNCATE, REFERENCES and TRIGGER, so it fails on privilege
--     first. INSERT, SELECT and UPDATE stay: delivery and processing bookkeeping (`state`, `outcome`, `attempts`, `lastError`,
--     `matchedAttemptId`, `processedAt`, the 0028 evidence index) keep their existing rules.
--
-- Not decided here: retention and privacy of raw bodies (Payment SDD O-17) stays OPEN. A future approved retention policy that removes or
-- redacts stored notifications needs its own migration and authority; this guard makes that an explicit decision rather than an ad hoc
-- statement. No read route is added.

CREATE FUNCTION payment_webhook_event_retained() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is retained evidence: % is refused (a stored provider notification is never deleted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514', CONSTRAINT = 'webhook_event_retained';
END $$;
CREATE TRIGGER webhook_event_10_no_delete BEFORE DELETE ON webhook_event FOR EACH ROW EXECUTE FUNCTION payment_webhook_event_retained();
CREATE TRIGGER webhook_event_11_no_truncate BEFORE TRUNCATE ON webhook_event FOR EACH STATEMENT EXECUTE FUNCTION payment_webhook_event_retained();

DO $$
DECLARE r record;
BEGIN
  REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON webhook_event FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole::text AS role
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relname = 'webhook_event' AND a.grantee <> c.relowner AND a.grantee <> 0
       AND a.privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON webhook_event FROM %s', r.role);
  END LOOP;
END $$;
