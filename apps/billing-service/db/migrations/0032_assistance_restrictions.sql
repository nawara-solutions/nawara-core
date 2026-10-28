-- Core V2 S5d Organization financial restrictions T1 and T2 (register BIL-13 C, BIL-26; S0 FC-9, I-11, §1.2 T1/T2; the Owner's decisions
-- S5D-1 to S5D-8, 2026-10-28), for Core V2 DEVELOPMENT AND SIMULATION ONLY (the assistance routes are never mounted in production).
--
--   * ONE authoritative model, `billing_assistance_restrictions(organization, at)`, derived from durable financial rows only (no restriction
--     ledger, no repeat-violation state; FC-9). It is what the creation guard below, Billing's admission check and the BIL-26 read all use.
--       T1 (S5D-1): a request of the Organization still `cash_collected` whose `settleBy` is past `at`. It stays while its cash-return
--          obligation is unresolved and clears with the request: a verified settlement (`settled`) or the beneficiary's confirmation
--          (`returned`). Its violation evidence (`settleBy`, the obligation) is never erased. L-4 is not implemented.
--       T2 (S5D-2): a cash-return obligation of the Organization still `open` or `return_reported` (a report is not a confirmation); it
--          clears with the beneficiary's confirmation only. No return deadline is invented.
--     Organization scope only (S5D-3). `sourceId`: the request (T1) or the obligation (T2); `since`: `settleBy` (T1) or `openedAt` (T2).
--     Kinds in a deterministic order (T1, T2), then `since`, then `sourceId`. T3 (S6f) and `inactive` (D6, after V-4) are RESERVED kinds this
--     function never returns: no source exists for either, and none is fabricated (S5D-7).
--   * Admission (S5D-4, S5D-5): a new assistance request is refused while ANY restriction applies to its Organization, re-evaluated inside
--     PostgreSQL at the protected decision: after the Organization lock, at the database's CURRENT clock (`clock_timestamp()`, not the
--     transaction's start), so a deadline that passes while the request waits for the lock counts. Only creation is restricted (FC-9,
--     S5D-8): no discharge, read or cash-collection path checks restrictions.
--   * The Organization lock (S5D-5): `billing_assistance_organization_lock(organization)`, a transaction advisory lock, is the FIRST lock of
--     every path that can create or clear T1 or T2 or that admits a request; the documented order is
--       (payment rows) -> Organization -> assistance request -> cash-return obligation -> dispute.
--     The creation guard and the obligation insert guard take it themselves (re-entrant when the service already holds it), so a SQL path
--     that skips the service still serializes against creation.
-- Expand only: new functions, a new index, a new trigger, one replaced guard. No table and no column.

CREATE FUNCTION billing_assistance_organization_lock(p_organization uuid) RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('billing.assistance_organization:' || p_organization::text, 0));
$$;

CREATE FUNCTION billing_assistance_restrictions(p_organization uuid, p_at timestamptz)
  RETURNS TABLE (kind text, "sourceId" uuid, since timestamptz) LANGUAGE sql STABLE AS $$
  SELECT r.kind, r."sourceId", r.since FROM (
    SELECT 'T1'::text AS kind, a.id AS "sourceId", a."settleBy" AS since
      FROM assistance_request a
     WHERE a."organizationId" = p_organization AND a.status = 'cash_collected' AND a."settleBy" IS NOT NULL AND p_at > a."settleBy"
    UNION ALL
    SELECT 'T2'::text, o.id, o."openedAt"
      FROM cash_return_obligation o
     WHERE o."organizationId" = p_organization AND o.status IN ('open', 'return_reported')
  ) r
  ORDER BY r.kind, r.since, r."sourceId";
$$;

-- T1 reads the Organization's collected requests (T2 uses cash_return_obligation_organization_idx)
CREATE INDEX assistance_request_organization_collected_idx ON assistance_request ("organizationId", "settleBy") WHERE status = 'cash_collected';

-- S5D-4, S5D-5: the creation decision, enforced by the database whatever path inserts
CREATE FUNCTION billing_assistance_request_restriction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kinds text;
BEGIN
  PERFORM billing_assistance_organization_lock(NEW."organizationId");
  SELECT string_agg(DISTINCT x.kind, ',' ORDER BY x.kind) INTO kinds FROM billing_assistance_restrictions(NEW."organizationId", clock_timestamp()) x;
  IF kinds IS NOT NULL THEN
    RAISE EXCEPTION 'assistance request: the Organization is restricted (%)', kinds USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_restricted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_request_04_restriction_guard BEFORE INSERT ON assistance_request FOR EACH ROW EXECUTE FUNCTION billing_assistance_request_restriction_guard();

-- S5D-5: the obligation (T2) opens under the Organization lock first, then the request row lock (E-6, unchanged otherwise)
CREATE OR REPLACE FUNCTION billing_cash_return_obligation_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  PERFORM billing_assistance_organization_lock(NEW."organizationId");
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."returnedAt" IS NOT NULL OR NEW."returnReportedAt" IS NOT NULL OR NEW."returnReportedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'a cash-return obligation is opened open' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_created_open';
  END IF;
  IF r.status IS DISTINCT FROM 'cash_collected' OR NOT (now() > r."settleBy")
     OR EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = r.id)
     OR EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = r.id AND c.status IN ('open', 'uncertain')) THEN
    RAISE EXCEPTION 'assistance request %: no cash-return obligation may open', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_not_due';
  END IF;
  IF NEW.amount <> r."totalAmount" OR NEW.currency <> r.currency OR NEW."cashCollectedAt" <> r."cashCollectedAt" THEN
    RAISE EXCEPTION 'cash-return obligation: the frozen total, currency and collection time of its request' USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_terms';
  END IF;
  NEW."openedAt" := now();
  RETURN NEW;
END $$;
