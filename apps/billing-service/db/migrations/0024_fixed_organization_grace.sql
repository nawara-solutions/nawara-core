-- Core V2 S3e (ADR-0044 B13; S0 §3.9; register I-3, BIL-09): the fixed Organization grace policy.
--
--   * An Organization Subscription period has exactly 24 hours of grace after `currentPeriodEnd`, computed in UTC in the same statement
--     that establishes the period and frozen for that period. The V1 setting `SUBSCRIPTION_GRACE_DAYS` (optional, 1-365 days) is
--     retired: grace is not configurable. The frozen same-row check is `status = 'pending' OR graceUntil = currentPeriodEnd + 24 hours`.
--     `interval '24 hours'` added to a `timestamptz` is an absolute 24 hours (no calendar or time-zone arithmetic), so the rule holds
--     whatever the session's TimeZone.
--   * A Personal Subscription has no grace: its validity is the purchase ledger's spans (0022), which have no grace column at all.
--   * Grace is a lifecycle and entitlement boundary only: it never records a settlement, a purchase or a renewal. Periods still move only
--     with a same-transaction `subscription_settlement` (DB-11, 0021), unchanged here.
--
-- Existing rows are never rewritten (Billing is not in production; a backfill refuses on ambiguity rather than infer, ADR-0044): if any
-- established subscription carries a different grace, this migration stops and changes nothing, so an operator decides.
-- The lifecycle guard (0013) cleared `graceUntil` on an `active -> active` move that kept the period (a cancellation toggle), to stop a
-- stale configurable window surviving; with a grace that is a pure function of `currentPeriodEnd`, that clearing would only ever break the
-- rule (a scheduled cancellation would have removed the period's grace), so the guard is re-created without it, otherwise unchanged.

DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM subscription
   WHERE status <> 'pending' AND "graceUntil" IS DISTINCT FROM "currentPeriodEnd" + interval '24 hours';
  IF n > 0 THEN
    RAISE EXCEPTION 'S3e: % established subscription(s) carry a grace other than exactly 24 hours after their period end; nothing was changed (decide them explicitly, they are never rewritten here)', n
      USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION billing_subscription_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status = 'active')
      OR (OLD.status = 'active' AND NEW.status IN ('grace', 'expired'))
      OR (OLD.status = 'grace' AND NEW.status IN ('active', 'expired'))
      OR (OLD.status = 'expired' AND NEW.status = 'active')
    ) THEN
      RAISE EXCEPTION 'subscription % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.status <> 'active' THEN
    RAISE EXCEPTION 'subscription % has no in-place change while %', OLD.id, OLD.status USING ERRCODE = '23514';
  END IF;

  -- a rolled-forward period is always born uncancelled: cancellation is a decision about the period that is ENDING
  IF NEW."currentPeriodEnd" IS DISTINCT FROM OLD."currentPeriodEnd" THEN
    NEW."cancelAtPeriodEnd" := false;
  END IF;
  -- A PAST `effectiveTerminationAt` never survives a move into `active` (fresh period or a reactivation).
  IF NEW.status = 'active' THEN
    NEW."effectiveTerminationAt" := NULL;
  END IF;
  -- Core V2 S3e: `graceUntil` is never cleared or set here. It is exactly `currentPeriodEnd + 24 hours` for every established row
  -- (`subscription_grace_fixed`), written with the period by the settlement that establishes it.
  RETURN NEW;
END $$;

-- The frozen same-row check (S0 §3.9, BIL-09): no application or raw-SQL path can store any other grace, nor drop it. Written with an
-- explicit `IS NOT NULL`: a CHECK whose expression is NULL passes, so the literal `graceUntil = currentPeriodEnd + 24 hours` alone would
-- still admit an established subscription with no grace at all (every non-pending row has a period: `subscription_active_has_period`).
ALTER TABLE subscription
  ADD CONSTRAINT subscription_grace_fixed
  CHECK (status = 'pending' OR ("graceUntil" IS NOT NULL AND "graceUntil" = "currentPeriodEnd" + interval '24 hours'));
