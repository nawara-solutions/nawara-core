-- Durable actor record for administrative writers (ADR-0042 decision 9): "organization-service needs a
-- durable actor record (user, session family where available, calling service) before it accepts writers
-- in production." This is the prerequisite the human-admin module (Phase 4) writes to on every mutation
-- and every denial. Reuses the append-only pattern of ownership_event (0004): forbid_ownership_change()
-- is a generic "this table is append-only" trigger function, already defined there, reused as-is here.
--
-- Audit minimum per ADR-0042 decision 9: caller identity, the capability, the outcome and reason class,
-- the correlation id, the asserted scope and the target id. Policy version, token fingerprint and central
-- forwarding are future work, not decided here.

CREATE TABLE admin_actor_event (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid NOT NULL,                                        -- Auth's userId; opaque here, no FK (database-per-service)
  actor_kind      text NOT NULL CHECK (actor_kind IN ('owner', 'operator', 'member')),
  session_family  text,                                                 -- Auth's sid, where available (owner/operator step-up binding)
  operation       text NOT NULL CHECK (btrim(operation) <> ''),         -- e.g. 'platform.create', 'organization.update'
  target_type     text NOT NULL CHECK (target_type IN ('company', 'platform', 'organization')),
  target_id       uuid,                                                 -- null only for a create that was denied before an id existed
  correlation_id  text,
  outcome         text NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
  reason          text,                                                 -- a reason CLASS (e.g. 'no_active_assignment'), never a secret
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TRIGGER admin_actor_event_append_only BEFORE UPDATE OR DELETE ON admin_actor_event FOR EACH ROW EXECUTE FUNCTION forbid_ownership_change();
CREATE TRIGGER admin_actor_event_no_truncate BEFORE TRUNCATE ON admin_actor_event FOR EACH STATEMENT EXECUTE FUNCTION forbid_ownership_change();
CREATE INDEX admin_actor_event_actor_idx ON admin_actor_event (actor_user_id);
CREATE INDEX admin_actor_event_target_idx ON admin_actor_event (target_type, target_id);

-- organization_app has DML by default (infra/postgres/init); it needs INSERT (the running service writes
-- this table) but never UPDATE/DELETE/TRUNCATE — the trigger above is the primary enforcement, this is
-- belt-and-suspenders at the privilege level, matching 0004's pattern for the ownership tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organization_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON admin_actor_event FROM organization_app;
  END IF;
END $$;
