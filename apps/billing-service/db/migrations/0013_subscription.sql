-- Subscription (Stage 12.2): the current commercial access period an Organization has purchased. Answers "what access
-- period exists right now for this Organization?" — never "is this user authorized?" (that is Auth/membership) and never
-- "was money collected?" (that is Payment/PaymentRequest). One MUTABLE row per Organization: unlike invoice/payment_request,
-- there is no history of past rows to page through — `billing_transition` (widened below) is the only history.
--
-- Scope is `organizationId` alone (Stage 11.3): an Organization has exactly one Platform, so Platform identity is always
-- derivable through Organization and is never duplicated onto this table. There is no cross-service foreign key to
-- Organization's own database (Billing does not read another service's database, and Invoice already stores
-- `organizationId` as a bare, unvalidated uuid for the same reason) — existence is trusted from the caller's own context,
-- exactly as `invoice."organizationId"` already does.

-- the composite FK below needs a unique target on (id, "productId") (mirrors `invoice_id_currency_unique`); `id` is
-- already unique on its own, so this adds no real constraint beyond naming the pair.
ALTER TABLE price ADD CONSTRAINT price_id_product_unique UNIQUE (id, "productId");

CREATE TABLE subscription (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId"         uuid NOT NULL,
  "productId"              uuid NOT NULL,
  "priceId"                uuid NOT NULL,
  status                   text NOT NULL DEFAULT 'pending',
  "currentPeriodStart"     timestamptz,
  "currentPeriodEnd"       timestamptz,
  "graceUntil"             timestamptz,
  "cancelAtPeriodEnd"      boolean NOT NULL DEFAULT false,
  "effectiveTerminationAt" timestamptz,
  revision                 integer NOT NULL DEFAULT 0,
  "createdAt"              timestamptz NOT NULL DEFAULT now(),
  "updatedAt"              timestamptz NOT NULL DEFAULT now(),

  -- one CURRENT subscription per Organization (BI-style naming kept local): the row itself IS the current state, so a
  -- plain UNIQUE is the whole invariant — there is no coexisting historical row to partial-index around, unlike
  -- `payment_request_one_active` where several non-active rows legitimately share an `invoiceId`.
  CONSTRAINT subscription_organization_unique UNIQUE ("organizationId"),
  -- product/price integrity: the referenced price must belong to the referenced product (mirrors invoice's own
  -- `(id, currency)` composite-FK pattern below); `price_id_product_unique` is added for exactly this purpose.
  CONSTRAINT subscription_price_product_fk FOREIGN KEY ("priceId", "productId") REFERENCES price (id, "productId"),

  CONSTRAINT subscription_status_valid CHECK (status IN ('pending', 'active', 'grace', 'expired')),
  CONSTRAINT subscription_revision_nonnegative CHECK (revision >= 0),
  -- born pending, with no period/grace/termination data yet (mirrors invoice's "born a draft" shape)
  CONSTRAINT subscription_pending_shape CHECK (
    status <> 'pending' OR (
      "currentPeriodStart" IS NULL AND "currentPeriodEnd" IS NULL AND "graceUntil" IS NULL
      AND "effectiveTerminationAt" IS NULL AND NOT "cancelAtPeriodEnd")),
  -- every non-pending status always carries the period that made it so (expired keeps its LAST period, never nulled)
  CONSTRAINT subscription_active_has_period CHECK (status = 'pending' OR ("currentPeriodStart" IS NOT NULL AND "currentPeriodEnd" IS NOT NULL)),
  -- half-open period [currentPeriodStart, currentPeriodEnd): section 17/18
  CONSTRAINT subscription_period_order CHECK ("currentPeriodStart" IS NULL OR "currentPeriodEnd" > "currentPeriodStart"),
  -- grace, when it exists, always extends STRICTLY beyond the period it follows (section 19)
  CONSTRAINT subscription_grace_after_period CHECK ("graceUntil" IS NULL OR "currentPeriodEnd" IS NULL OR "graceUntil" > "currentPeriodEnd"),
  -- effective termination may only SHORTEN access, never extend it (section 20): it can never sit past whichever
  -- boundary (grace, else period end) currently defines when access would otherwise end
  CONSTRAINT subscription_termination_shape CHECK ("effectiveTerminationAt" IS NULL OR "effectiveTerminationAt" <= COALESCE("graceUntil", "currentPeriodEnd"))
);

-- hot query: the one current subscription for an Organization — served by `subscription_organization_unique` itself, no
-- extra index needed. Lifecycle/background query (a future sweeper, NOT built in this stage — section 44/45): subscriptions
-- whose effective access boundary (grace if any, else period end) has elapsed. Indexed now so that query is never an
-- unindexed full scan (the N-07 pattern) on the day a sweeper is added; the partial predicate keeps it small (`pending`
-- and `expired` rows are never candidates).
CREATE INDEX subscription_expiry_idx ON subscription (COALESCE("graceUntil", "currentPeriodEnd")) WHERE status IN ('active', 'grace');

-- ---------------------------------------------------------------------------------------------------------------------------
-- Guards. BEFORE triggers fire in name order: 05 insert, 10 immutability, 20 lifecycle, 30 touch.
-- ---------------------------------------------------------------------------------------------------------------------------

-- Born pending, with no lifecycle data, and only against a RECURRING price of its own product (a one-time price has no
-- period to renew and cannot back a Subscription).
CREATE FUNCTION billing_subscription_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
  IF NEW.status <> 'pending' OR NEW.revision <> 0 OR NEW."currentPeriodStart" IS NOT NULL OR NEW."currentPeriodEnd" IS NOT NULL
     OR NEW."graceUntil" IS NOT NULL OR NEW."effectiveTerminationAt" IS NOT NULL OR NEW."cancelAtPeriodEnd" THEN
    RAISE EXCEPTION 'a subscription is created as pending with no lifecycle data' USING ERRCODE = '23514';
  END IF;
  SELECT "interval", "retiredAt" INTO p FROM price WHERE id = NEW."priceId";
  IF p."interval" <> 'recurring' THEN
    RAISE EXCEPTION 'a subscription must reference a recurring price' USING ERRCODE = '23514';
  END IF;
  IF p."retiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a subscription cannot be created against a retired price' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := now();
  NEW."updatedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_05_insert_guard BEFORE INSERT ON subscription FOR EACH ROW EXECUTE FUNCTION billing_subscription_insert_guard();

-- IMMUTABLE BY DEFAULT. `organizationId`/`productId`/`priceId` never change in V1 (no plan-change operation exists yet;
-- a later migration widens this the day one is designed, exactly like every other Billing table).
CREATE TRIGGER subscription_10_immutable BEFORE UPDATE ON subscription
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except(
    'status', 'currentPeriodStart', 'currentPeriodEnd', 'graceUntil', 'cancelAtPeriodEnd', 'effectiveTerminationAt', 'revision', 'updatedAt');

-- Unlike invoice/payment_request, a Subscription's `revision` counts EVERY meaningful mutation, not only a status change:
-- an early renewal or a cancellation toggle stays `active` but is still a real commercial event that must be auditable
-- (section 34) and must serialize correctly against a concurrent one (section 35/36). The ONLY allowed same-status move is
-- `active -> active`, which is exactly the renewal/cancellation-toggle case; every other in-place "change" (e.g. a second
-- write to an already-`expired` row) is refused, matching the transition graph having no other self-loop.
CREATE FUNCTION billing_subscription_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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

  -- No explicit "effectiveTerminationAt is set once" check is needed: within one `expired` episode no in-place update
  -- is possible at all (the self-loop guard above allows one only for `active`), and reactivation clears it below — so
  -- by the time a LATER termination could set it again, the previous value is already gone. The self-loop guard alone
  -- already makes the field fully immutable for as long as it is meaningful.

  -- a rolled-forward period is always born uncancelled: cancellation is a decision about the period that is ENDING
  IF NEW."currentPeriodEnd" IS DISTINCT FROM OLD."currentPeriodEnd" THEN
    NEW."cancelAtPeriodEnd" := false;
  END IF;
  -- A PAST `effectiveTerminationAt` never survives a move into `active` (fresh period or a reactivation): it describes
  -- an episode that is now over, and this is what lets a later, SEPARATE termination record its own timestamp instead
  -- of being permanently blocked by an old one.
  IF NEW.status = 'active' THEN
    NEW."effectiveTerminationAt" := NULL;
  END IF;
  -- `graceUntil` is a PRECOMPUTED boundary the trusted domain layer (SubscriptionRepository, from configured policy)
  -- sets in the SAME statement as `currentPeriodEnd`, at activate/renew time — never a status-transition side effect —
  -- so Stage 12.3 can derive effective access from timestamps alone without depending on a sweeper ever running
  -- `enterGrace` (section 5/8, R1 remediation). It is therefore NOT force-cleared merely by moving into `active`
  -- (that would destroy the very precomputation this exists for): `subscription_grace_after_period` (graceUntil >
  -- currentPeriodEnd) is the backstop against a STALE grace window surviving a period change, since a renewal moves
  -- currentPeriodEnd forward by at least one full billing interval — a caller that forgot to recompute `graceUntil`
  -- would leave the old value no longer satisfying that CHECK, and the write is refused rather than silently stale.
  -- The one case that CHECK cannot catch is a move into `active` with `currentPeriodEnd` UNCHANGED (no repository
  -- method ever does this — `activate`/`renew` always set a fresh period in the same statement — but the schema does
  -- not rely on that alone): here a leftover `graceUntil` from a past grace episode would still satisfy the CHECK
  -- against the (unchanged) period end, so it IS force-cleared, exactly the narrow case the CHECK cannot see.
  IF NEW.status = 'active' AND NEW."currentPeriodEnd" IS NOT DISTINCT FROM OLD."currentPeriodEnd" THEN
    NEW."graceUntil" := NULL;
  END IF;
  -- `grace -> grace` still being disallowed (above) is what stops a repeated payment failure from re-extending a
  -- window once the status has actually been normalized to `grace`.

  RETURN NEW;
END $$;
CREATE TRIGGER subscription_20_lifecycle BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION billing_subscription_lifecycle();

-- Every mutation bumps `revision` (see above) and stamps `updatedAt`, unconditionally.
CREATE FUNCTION billing_subscription_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now();
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_30_touch BEFORE UPDATE ON subscription FOR EACH ROW EXECUTE FUNCTION billing_subscription_touch();

CREATE TRIGGER subscription_90_no_delete BEFORE DELETE ON subscription FOR EACH ROW EXECUTE FUNCTION billing_no_delete();

-- ---------------------------------------------------------------------------------------------------------------------------
-- Widen the existing, shared `billing_transition` history (0008) to a third entity type. Reused, not duplicated (section 34):
-- a Subscription's history is a commercial-lifecycle audit trail of the same shape invoice/payment_request already have,
-- so it belongs in the same append-only table rather than a parallel mechanism. `pending`/`active`/`grace` are new to the
-- status vocabulary; `expired` already exists (payment_request). `causeType` needs no change: 'request' already covers an
-- explicit domain-method call and 'sweep' already exists for the day a background sweeper (not built here) applies one.
-- ---------------------------------------------------------------------------------------------------------------------------

ALTER TABLE billing_transition DROP CONSTRAINT billing_transition_entity_valid;
ALTER TABLE billing_transition ADD CONSTRAINT billing_transition_entity_valid CHECK ("entityType" IN ('invoice', 'payment_request', 'subscription'));

ALTER TABLE billing_transition DROP CONSTRAINT billing_transition_status_valid;
ALTER TABLE billing_transition ADD CONSTRAINT billing_transition_status_valid
  CHECK ("toStatus" IN ('draft', 'open', 'paid', 'void', 'created', 'sending', 'requested', 'failed', 'cancelled', 'expired', 'rejected', 'pending', 'active', 'grace'));

ALTER TABLE billing_transition DROP CONSTRAINT billing_transition_from_valid;
ALTER TABLE billing_transition ADD CONSTRAINT billing_transition_from_valid
  CHECK ("fromStatus" IS NULL OR "fromStatus" IN ('draft', 'open', 'paid', 'void', 'created', 'sending', 'requested', 'failed', 'cancelled', 'expired', 'rejected', 'pending', 'active', 'grace'));

-- BI-19 for Subscription: EVERY update (not only a status change — see the touch trigger above) needs its history row,
-- so an early renewal or a cancellation toggle is exactly as auditable as a status change.
CREATE CONSTRAINT TRIGGER subscription_history_on_create AFTER INSERT ON subscription
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_transition_required('subscription');
CREATE CONSTRAINT TRIGGER subscription_history_on_change AFTER UPDATE ON subscription
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_transition_required('subscription');
