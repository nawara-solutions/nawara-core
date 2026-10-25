-- Core V2 S2-File.3 (register FIL-04 to FIL-06; ADR-0048 Amendment 1, OD-FILE F4): File evidence holds.
--
-- A hold is placed by the file's OWNER service on one of its files, in the file's own organization, under that service's hold reference
-- (a uuid naming its preservation obligation); it lasts until that same service releases it (never automatically). Several independent
-- holds may coexist on one file. While ANY hold is active, the file cannot leave AVAILABLE for deletion: not by the owner's request, not
-- by the unattached-file expiry, not by the delete worker.
--
-- Append-only history: a placement row (`file_hold`) and, later, at most one release row (`file_hold_release`). Neither is ever updated
-- or deleted, so a release can never be undone (a released reference is never resurrected) and one hold's release can never touch
-- another's. Active = a placement without a release.
-- Expand only: two new tables and their triggers, plus one guard trigger on `file`; no existing row changes.

CREATE TABLE file_hold (
  id               uuid PRIMARY KEY,
  "fileId"         uuid NOT NULL,
  "holderService"  text NOT NULL,
  "holdRef"        uuid NOT NULL,
  "organizationId" uuid,
  "placedAt"       timestamptz NOT NULL DEFAULT now(),

  -- Within File's own database only; RESTRICT: a file row is never deleted anyway, and no cascade erases hold history.
  CONSTRAINT file_hold_file_fk FOREIGN KEY ("fileId") REFERENCES file (id),
  CONSTRAINT file_hold_holder_shape CHECK ("holderService" ~ '^[a-z][a-z0-9-]{1,62}$'),
  -- One hold per (service, reference), for ever: placing it again is idempotent, reusing it for another file is refused, and a released
  -- reference can never be placed again.
  CONSTRAINT file_hold_ref_unique UNIQUE ("holderService", "holdRef")
);
CREATE INDEX file_hold_file_idx ON file_hold ("fileId");

CREATE TABLE file_hold_release (
  "holdId"     uuid PRIMARY KEY,
  "releasedAt" timestamptz NOT NULL DEFAULT now(),
  -- At most one release per hold (the primary key): two concurrent releases cannot both succeed.
  CONSTRAINT file_hold_release_hold_fk FOREIGN KEY ("holdId") REFERENCES file_hold (id)
);

-- Placement: by the file's owner, in the file's organization, on an AVAILABLE file (attached or not: a held unattached file is kept). A
-- cross-row rule; the file row is locked (`FOR SHARE`) until the placing transaction ends, so a concurrent deletion either committed
-- first (the file is no longer AVAILABLE: refused here) or waits and then meets this hold in `file_hold_guard`.
CREATE FUNCTION file_hold_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM file f
    WHERE f.id = NEW."fileId" AND f."ownerService" = NEW."holderService" AND f."organizationId" IS NOT DISTINCT FROM NEW."organizationId"
      AND f.status = 'AVAILABLE'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_hold %: the file is not the holder''s AVAILABLE file in this organization', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_hold_binding BEFORE INSERT ON file_hold
  FOR EACH ROW EXECUTE FUNCTION file_hold_binding_guard();

-- Append-only, both tables: never updated, never deleted.
CREATE FUNCTION file_hold_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% refused)', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;
CREATE TRIGGER file_hold_append_only BEFORE UPDATE OR DELETE ON file_hold
  FOR EACH ROW EXECUTE FUNCTION file_hold_append_only();
CREATE TRIGGER file_hold_release_append_only BEFORE UPDATE OR DELETE ON file_hold_release
  FOR EACH ROW EXECUTE FUNCTION file_hold_append_only();

-- Preservation (frozen: a held file cannot be deleted), whatever path tries it: no move to DELETING or DELETED while a hold is active.
-- A statement-fresh read in READ COMMITTED: a deletion that waited for a placing transaction's share lock sees the committed hold. A
-- release that has not committed (or rolled back) is not seen, so the hold still protects the file. The error names the constraint
-- `file_held` so the application can answer `409 file_held`.
CREATE FUNCTION file_hold_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM file_hold h WHERE h."fileId" = NEW.id AND NOT EXISTS (SELECT 1 FROM file_hold_release r WHERE r."holdId" = h.id)
  ) THEN
    RAISE EXCEPTION 'file % is held', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'file_held';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_hold_guard BEFORE UPDATE OF status ON file
  FOR EACH ROW WHEN (NEW.status IN ('DELETING', 'DELETED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION file_hold_guard();
