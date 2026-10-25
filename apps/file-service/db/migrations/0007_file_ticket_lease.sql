-- Core V2 S2-File.4 (register FIL-07; ADR-0048 Amendment 1, OD-FILE F5): the reservation lease of a single-use DOWNLOAD ticket.
--
-- Before: redeeming a single-use ticket consumed it at once, so a transfer that failed before sending anything lost the ticket. Now a
-- redemption RESERVES it (one reservation at a time, under a short lease); the outcome then settles it:
--
--   NULL (unused) ──reserve──▶ reserved ──commit──────▶ committed   (the server finished writing the response; final)
--                                │   └────uncertain──▶ uncertain   (bytes may have been sent, or nobody settled it before the lease
--                                │                        │          ran out: a crash, a failed write; consumed, never reusable)
--                                │                        └─commit─▶ committed (the same lease finished after all)
--                                └──release──▶ NULL      (ONLY when the server proved nothing was sent: no header left the process)
--
-- A lease that runs out is never returned to the pool: it becomes `uncertain` (fail closed), so neither a crash nor a slow transfer can
-- ever produce a second redemption. Multi-use tickets and upload tickets are unchanged (no redemption state).
-- Expand only: three nullable columns, their checks and guards; existing rows keep NULL (an already-used single-use ticket keeps its
-- `useCount` = 1 and stays consumed).

ALTER TABLE file_access_ticket
  ADD COLUMN redemption   text,
  ADD COLUMN "leaseId"    uuid,
  ADD COLUMN "leaseUntil" timestamptz;

ALTER TABLE file_access_ticket
  ADD CONSTRAINT file_access_ticket_redemption_valid CHECK (redemption IS NULL OR redemption IN ('reserved', 'committed', 'uncertain')),
  -- Only a single-use download ticket is ever reserved.
  ADD CONSTRAINT file_access_ticket_redemption_single_use_download CHECK (redemption IS NULL OR (operation = 'download' AND "singleUse")),
  -- Unused: no lease. Reserved: a lease, not counted as a use yet, ending no later than the ticket. Settled: counted as its one use.
  ADD CONSTRAINT file_access_ticket_redemption_shape CHECK (
       (redemption IS NULL AND "leaseId" IS NULL AND "leaseUntil" IS NULL)
    OR (redemption = 'reserved' AND "leaseId" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "useCount" = 0 AND "leaseUntil" <= "expiresAt")
    OR (redemption IN ('committed', 'uncertain') AND "leaseId" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "useCount" = 1)
  );

-- Reservations past their lease, for the settling sweep (the cleanup pass) and the lazy settle at redemption.
CREATE INDEX file_access_ticket_lease_idx ON file_access_ticket ("leaseUntil") WHERE redemption = 'reserved';

-- The redemption state machine above, and a lease that never changes once taken.
CREATE FUNCTION file_access_ticket_redemption_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.redemption IS NOT DISTINCT FROM NEW.redemption THEN
    IF OLD."leaseId" IS DISTINCT FROM NEW."leaseId" OR OLD."leaseUntil" IS DISTINCT FROM NEW."leaseUntil" THEN
      RAISE EXCEPTION 'file_access_ticket %: a lease never changes', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.redemption IS NULL AND NEW.redemption = 'reserved' THEN
    -- Reserving is a use of the ticket: only while it is valid (not revoked, not expired), never after its one use.
    IF OLD."revokedAt" IS NOT NULL OR OLD."expiresAt" <= now() OR OLD."useCount" <> 0 THEN
      RAISE EXCEPTION 'file_access_ticket % is not usable', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.redemption = 'reserved' AND NEW.redemption IS NULL THEN
    RETURN NEW; -- released: proven unexposed (the application's decision, by the lease holder)
  END IF;
  IF (OLD.redemption = 'reserved' AND NEW.redemption IN ('committed', 'uncertain')) OR (OLD.redemption = 'uncertain' AND NEW.redemption = 'committed') THEN
    IF OLD."leaseId" IS DISTINCT FROM NEW."leaseId" OR OLD."leaseUntil" IS DISTINCT FROM NEW."leaseUntil" THEN
      RAISE EXCEPTION 'file_access_ticket %: a lease never changes', OLD.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'file_access_ticket %: redemption % cannot become %', OLD.id, coalesce(OLD.redemption, 'unused'), coalesce(NEW.redemption, 'unused')
    USING ERRCODE = '23514';
END $$;
CREATE TRIGGER file_access_ticket_redemption_guard BEFORE UPDATE ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION file_access_ticket_redemption_guard();

-- A ticket is created unused.
CREATE FUNCTION file_access_ticket_created_unused() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.redemption IS NOT NULL THEN
    RAISE EXCEPTION 'file_access_ticket %: a ticket is created unused', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_access_ticket_created_unused BEFORE INSERT ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION file_access_ticket_created_unused();

-- The 0001 use rule, with one addition: settling a reservation counts its use even if the ticket was revoked or expired meanwhile (the
-- use was authorized when the reservation was taken; the transfer it covers has happened or may have).
CREATE OR REPLACE FUNCTION file_access_ticket_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."useCount" < OLD."useCount" OR NEW."useCount" > OLD."useCount" + 1 THEN
    RAISE EXCEPTION 'file_access_ticket %: uses are counted one at a time', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW."useCount" > OLD."useCount" AND OLD.redemption IS DISTINCT FROM 'reserved' AND (OLD."revokedAt" IS NOT NULL OR OLD."expiresAt" <= now()) THEN
    RAISE EXCEPTION 'file_access_ticket % is not usable', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
