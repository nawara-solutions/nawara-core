-- Subscription billing anchor (ADR-0044 B-025, persistent-anchor amendment). A monthly or yearly subscription keeps the
-- calendar cadence it was established with: a period end falls on the anchor's day of month (and, for a yearly price, its
-- month), at the anchor's UTC time of day, clamped to the last day of a month that does not have that day. The clamp
-- applies to that ONE occurrence only: the next month that has the day recovers it (Jan 31 -> Feb 28 -> Mar 31), and a
-- Feb 29 anchor recovers Feb 29 in the next leap year. Before this migration each renewal added the interval to the
-- previous, possibly clamped, period end, so a 29th/30th/31st cadence ratcheted down for good (Jan 31 -> Feb 28 -> Mar 28).
--
-- `billingAnchorAt` is the ONE new piece of state, and it has to be stored: a period end on the 28th cannot tell a 28th
-- anchor from a 29th/30th/31st one clamped by February. It is an instant, not a day number, because the cadence also needs
-- the anchor's time of day (period ends keep the settlement's UTC time) and, for a yearly price, its month. It is:
--   * NULL while `pending`, and always NULL for a `day`/`week` price (no calendar-month cadence: those periods stay
--     start + interval, exactly as before);
--   * set for every non-pending `month`/`year` subscription, to the start of the period that established it: the first
--     activation's instant, or a genuinely late renewal's settlement instant (ADR-0044: the paid and grace window has fully
--     elapsed, so the new period starts at the settlement and the cadence restarts from it);
--   * unchanged by every other write, including an early, on-time or in-grace renewal.
-- The responsibility is split. The trigger below enforces only the shape: no anchor while `pending` or for a `day`/`week`
-- price, an anchor always present on a non-pending `month`/`year` subscription, and an anchor that moves only together
-- with a new period and only to that period's own `currentPeriodStart`. It cannot tell an early, on-time, in-grace or
-- late renewal apart. WHEN the anchor is (re)set is `SubscriptionRepository`'s decision: the first activation establishes
-- it, an early, exact-boundary or in-grace renewal keeps it, and a genuinely late renewal (`isLateRenewal`) resets it to
-- the settlement instant. The calendar arithmetic itself is `billing_subscription_period_end`. The first
-- period is on the cadence too: `SubscriptionRepository.activate` refuses a month/year first period whose end is not that
-- function's result for its start (no off-cadence trial, introductory or prorated first period exists in V1).

ALTER TABLE subscription ADD COLUMN "billingAnchorAt" timestamptz;

-- Backfill (Billing is not deployed to production: this only reaches development and CI databases). An existing row's
-- original anchor is NOT recoverable: `currentPeriodStart`/`currentPeriodEnd` and the history cannot tell a genuine 28th
-- from a clamped 29th/30th/31st. The deterministic fallback is the row's `currentPeriodStart`: the start of the period
-- in force, the instant the renewal rule already counts from. A row whose true anchor was clamped before this migration
-- keeps the clamped day. This is a schema backfill, not a commercial event: it bypasses the guard, lifecycle, revision and
-- history triggers for this one statement (no revision bump, no transition row), then restores every one of them.
ALTER TABLE subscription
  DISABLE TRIGGER subscription_10_immutable, DISABLE TRIGGER subscription_20_lifecycle,
  DISABLE TRIGGER subscription_30_touch, DISABLE TRIGGER subscription_history_on_change;
UPDATE subscription s SET "billingAnchorAt" = s."currentPeriodStart"
  FROM price p
 WHERE p.id = s."priceId" AND s.status <> 'pending' AND p."intervalUnit" IN ('month', 'year');
ALTER TABLE subscription
  ENABLE TRIGGER subscription_10_immutable, ENABLE TRIGGER subscription_20_lifecycle,
  ENABLE TRIGGER subscription_30_touch, ENABLE TRIGGER subscription_history_on_change;

-- a pending subscription has no cadence yet (mirrors subscription_pending_shape)
ALTER TABLE subscription ADD CONSTRAINT subscription_pending_no_billing_anchor CHECK (status <> 'pending' OR "billingAnchorAt" IS NULL);

-- the immutability guard (0013) now lets the anchor change; the rules for WHEN it may change are the trigger below
DROP TRIGGER subscription_10_immutable ON subscription;
CREATE TRIGGER subscription_10_immutable BEFORE UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except(
    'status', 'currentPeriodStart', 'currentPeriodEnd', 'graceUntil', 'cancelAtPeriodEnd', 'effectiveTerminationAt', 'revision', 'updatedAt',
    'billingAnchorAt');

-- Fires after the lifecycle guard (20), before the touch (30). The price (and so its unit) is immutable, as is `priceId`.
CREATE FUNCTION billing_subscription_billing_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unit text;
BEGIN
  IF NEW.status = 'pending' THEN
    RETURN NEW; -- subscription_pending_no_billing_anchor
  END IF;
  SELECT "intervalUnit" INTO unit FROM price WHERE id = NEW."priceId";
  IF unit IN ('month', 'year') AND NEW."billingAnchorAt" IS NULL THEN
    RAISE EXCEPTION 'subscription %: a month/year subscription always keeps its billing anchor', NEW.id USING ERRCODE = '23514';
  END IF;
  IF unit NOT IN ('month', 'year') AND NEW."billingAnchorAt" IS NOT NULL THEN
    RAISE EXCEPTION 'subscription %: a % subscription has no billing anchor', NEW.id, unit USING ERRCODE = '23514';
  END IF;
  -- The anchor moves only together with a new period and only to that period's own start. SubscriptionRepository
  -- establishes it on first activation and resets it on a genuinely late renewal (`isLateRenewal`); early, on-time and
  -- in-grace renewal behavior is decided by the repository, not by this guard.
  IF NEW."billingAnchorAt" IS DISTINCT FROM OLD."billingAnchorAt"
     AND (NEW."currentPeriodStart" IS NOT DISTINCT FROM OLD."currentPeriodStart" OR NEW."billingAnchorAt" <> NEW."currentPeriodStart") THEN
    RAISE EXCEPTION 'subscription %: the billing anchor is set only as the start of the new period that establishes it', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_25_billing_anchor BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION billing_subscription_billing_anchor();

-- The end of a period starting at `p_start`, for a price of `p_count` x `p_unit`, all in UTC wall-clock time (no session
-- TimeZone, no DST: section 17).
--   day/week:   p_start + the interval, unchanged from 0013 (p_anchor is NULL and ignored).
--   month/year: the anchor's day of month and time of day, in the month p_count months (x 12 for a year) after p_start's
--               month; PostgreSQL's month addition from the ANCHOR clamps that one result to the target month's last day,
--               so a clamp never carries into the next period. When p_start is itself an anchor occurrence (every period
--               this service writes), this is exactly "p_count intervals after p_start, on the anchor's cadence".
-- The repository computes every renewed period end with this function and checks every month/year activation against it
-- (p_start = p_anchor = the activation's start), so the SQL invariant suite tests the real arithmetic.
-- STABLE, not IMMUTABLE: the day/week branch casts text to interval, and interval input is STABLE in PostgreSQL (it reads
-- the IntervalStyle setting). No index or constraint uses this function, so the label changes nothing else.
CREATE FUNCTION billing_subscription_period_end(p_start timestamptz, p_anchor timestamptz, p_unit text, p_count integer)
  RETURNS timestamptz LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN p_unit IN ('month', 'year') THEN
      ((p_anchor AT TIME ZONE 'UTC') + make_interval(months => (
          (extract(year FROM p_start AT TIME ZONE 'UTC')::int * 12 + extract(month FROM p_start AT TIME ZONE 'UTC')::int)
        - (extract(year FROM p_anchor AT TIME ZONE 'UTC')::int * 12 + extract(month FROM p_anchor AT TIME ZONE 'UTC')::int)
        + p_count * CASE p_unit WHEN 'year' THEN 12 ELSE 1 END))) AT TIME ZONE 'UTC'
    ELSE ((p_start AT TIME ZONE 'UTC') + (p_count || ' ' || p_unit)::interval) AT TIME ZONE 'UTC'
  END
$$;
