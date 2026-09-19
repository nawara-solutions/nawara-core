-- Billing-local, append-only history of every state change with its actor and cause (SDD 8 BI-19, 36.8). Billing-local history is
-- AUTHORITATIVE for Billing state; a future audit-service receives Billing's events as a central copy and never replaces it.

CREATE TABLE billing_transition (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entityType"    text NOT NULL,
  "entityId"      uuid NOT NULL,
  "fromStatus"    text,
  "toStatus"      text NOT NULL,
  revision        integer NOT NULL,                              -- the revision the entity has AFTER this change (creation = 0)
  "actorType"     text NOT NULL,
  "actorId"       text,
  "causeType"     text NOT NULL,
  "causeId"       text,
  "correlationId" text,
  "occurredAt"    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT billing_transition_entity_valid CHECK ("entityType" IN ('invoice', 'payment_request')),
  CONSTRAINT billing_transition_status_valid CHECK ("toStatus" IN ('draft', 'open', 'paid', 'void', 'created', 'sending', 'requested', 'failed', 'cancelled', 'expired', 'rejected')),
  CONSTRAINT billing_transition_from_valid CHECK ("fromStatus" IS NULL OR "fromStatus" IN ('draft', 'open', 'paid', 'void', 'created', 'sending', 'requested', 'failed', 'cancelled', 'expired', 'rejected')),
  CONSTRAINT billing_transition_creation_shape CHECK (("fromStatus" IS NULL) = (revision = 0)),
  CONSTRAINT billing_transition_revision_nonnegative CHECK (revision >= 0),
  CONSTRAINT billing_transition_actor_valid CHECK ("actorType" IN ('user', 'service', 'system')),
  CONSTRAINT billing_transition_cause_valid CHECK ("causeType" IN ('request', 'payment_event', 'sweep', 'reconciliation', 'dispatcher')),
  CONSTRAINT billing_transition_bounded_text CHECK (
    ("actorId" IS NULL OR char_length("actorId") <= 128) AND ("causeId" IS NULL OR char_length("causeId") <= 128) AND ("correlationId" IS NULL OR char_length("correlationId") <= 128)),
  CONSTRAINT billing_transition_revision_unique UNIQUE ("entityType", "entityId", revision)
);
CREATE INDEX billing_transition_entity_idx ON billing_transition ("entityType", "entityId", revision);

CREATE TRIGGER billing_transition_10_append_only BEFORE UPDATE OR DELETE ON billing_transition
  FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- BI-19: a status change with no history row cannot commit. Checked at COMMIT so the row and the history row are written in either
-- order inside the transaction. The row's own revision (set by the touch trigger) is what the history row must carry.
CREATE FUNCTION billing_transition_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM billing_transition WHERE "entityType" = TG_ARGV[0] AND "entityId" = NEW.id AND "toStatus" = NEW.status AND revision = NEW.revision
  ) THEN
    RAISE EXCEPTION '% % moved to % without a history row (BI-19)', TG_ARGV[0], NEW.id, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoice_history_on_create AFTER INSERT ON invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_transition_required('invoice');
CREATE CONSTRAINT TRIGGER invoice_history_on_change AFTER UPDATE OF status ON invoice
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION billing_transition_required('invoice');
CREATE CONSTRAINT TRIGGER payment_request_history_on_create AFTER INSERT ON payment_request
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing_transition_required('payment_request');
CREATE CONSTRAINT TRIGGER payment_request_history_on_change AFTER UPDATE OF status ON payment_request
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION billing_transition_required('payment_request');
