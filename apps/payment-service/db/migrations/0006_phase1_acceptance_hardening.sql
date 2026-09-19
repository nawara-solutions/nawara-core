-- Phase 1 acceptance-review hardening. Every rule below is already required by the SDD; this migration makes the database
-- enforce it instead of relying on application code alone (SDD section 5: "defence in depth: application checks are not
-- the only guard"). New migration rather than an edit of 0002/0003 so an already-migrated database upgrades cleanly.

-- FI-03: a payment has at most ONE succeeded gateway attempt. Nothing in the schema previously stopped a second one
-- (the "one open attempt" index only covers initiated/submitted/unknown, and a late success re-opens an old attempt).
CREATE UNIQUE INDEX payment_attempt_one_succeeded ON payment_attempt ("paymentId") WHERE status = 'succeeded';

-- Settlement consistency: `succeeded` always says HOW it settled, and a gateway settlement always names its attempt (FI-04
-- then makes that attempt belong to the same payment and be itself succeeded). Cash has no attempt, so only `gateway` needs one.
ALTER TABLE payment ADD CONSTRAINT payment_succeeded_has_method CHECK (status <> 'succeeded' OR "settledMethod" IS NOT NULL);
ALTER TABLE payment ADD CONSTRAINT payment_gateway_has_attempt CHECK ("settledMethod" IS DISTINCT FROM 'gateway' OR "succeededAttemptId" IS NOT NULL);

-- SDD 3.1: amount is an integer of minor units between 1 and 9007199254740991 (a JSON-safe integer); FI-15 forbids any
-- floating-point step, and events/representations carry the amount as a JSON number, so the database refuses anything a
-- JSON number could not carry exactly. (payment_amount_positive already covers the lower bound: FI-01.)
ALTER TABLE payment ADD CONSTRAINT payment_amount_safe_integer CHECK (amount <= 9007199254740991);

-- SDD 3.1: "If seller.type is organization it must equal seller.id". The original CHECK evaluated to NULL (= passes) when
-- organizationId was NULL, so an organization seller with no organizationId slipped through.
ALTER TABLE payment DROP CONSTRAINT payment_organization_matches_seller;
ALTER TABLE payment ADD CONSTRAINT payment_organization_matches_seller
  CHECK ("sellerType" <> 'organization' OR ("organizationId" IS NOT NULL AND "organizationId"::text = "sellerId"));

-- SDD 5.1: `created -> succeeded` is forbidden as a general transition; its ONLY exception is the late success of an attempt
-- the resolver failed by INFERENCE. The trigger allowed the edge unconditionally; it now requires exactly that evidence.
CREATE OR REPLACE FUNCTION payment_status_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('created', 'pending'), ('pending', 'created'), ('pending', 'succeeded'), ('pending', 'failed'),
      ('created', 'cancelled'), ('pending', 'cancelled'), ('created', 'expired'), ('pending', 'expired'),
      ('created', 'succeeded')
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status AND allowed.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'payment % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'created' AND NEW.status = 'succeeded' AND NOT EXISTS (
    SELECT 1 FROM payment_attempt
    WHERE id = NEW."succeededAttemptId" AND "paymentId" = NEW.id AND status = 'succeeded' AND "failureInferred"
  ) THEN
    RAISE EXCEPTION 'payment %: created -> succeeded is only the late success of an attempt failed by inference', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- SDD 4.1: `revision` is incremented on every state change (it orders events for consumers) and `updatedAt` follows every
-- update. Neither was ever maintained. Done in the database so no code path can forget it. Named so it fires after the
-- other BEFORE UPDATE triggers (alphabetical order), i.e. only for an update that is otherwise accepted.
CREATE FUNCTION payment_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."updatedAt" := now();
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.revision := OLD.revision + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_touch BEFORE UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION payment_touch();
