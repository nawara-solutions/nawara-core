-- Stage 17.7: durable state for the physical-delete worker (SDD §12). Forward-only; nothing in 0001 is redesigned.
--
-- A file in DELETING is inaccessible (17.6 serves AVAILABLE only) and waits for its bytes to be removed. The worker claims due rows with
-- a LEASE (a crashed worker's claim expires and the row is claimed again) and a FENCE (`deleteAttempts`, incremented at each claim: only
-- the holder of the current attempt may reschedule the row). A failed storage delete reschedules the row with backoff
-- (`deleteNextAttemptAt`); it never leaves DELETING (access is never restored). All times come from the database clock.

ALTER TABLE file
  ADD COLUMN "deleteAttempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "deleteNextAttemptAt" timestamptz,
  ADD COLUMN "deleteLeaseUntil" timestamptz,
  ADD COLUMN "deleteLastError" text;

-- Rows already DELETING (none are expected: no route could produce one before this stage) become due now.
UPDATE file SET "deleteNextAttemptAt" = now() WHERE status = 'DELETING';

ALTER TABLE file
  ADD CONSTRAINT file_delete_attempts_valid CHECK ("deleteAttempts" >= 0),
  -- Exactly the DELETING rows are scheduled; a lease exists only on a DELETING row.
  ADD CONSTRAINT file_delete_scheduled_iff_deleting CHECK ((status = 'DELETING') = ("deleteNextAttemptAt" IS NOT NULL)),
  ADD CONSTRAINT file_delete_lease_only_deleting CHECK ("deleteLeaseUntil" IS NULL OR status = 'DELETING'),
  -- A bounded machine code (a storage error code), never provider text.
  ADD CONSTRAINT file_delete_last_error_shape CHECK ("deleteLastError" IS NULL OR "deleteLastError" ~ '^[a-z][a-z0-9_]{0,63}$');

-- The worker's claim: `status = 'DELETING' AND "deleteNextAttemptAt" <= now() AND ("deleteLeaseUntil" IS NULL OR "deleteLeaseUntil" <
-- now()) ORDER BY "deleteNextAttemptAt" … FOR UPDATE SKIP LOCKED`. It replaces 0001's index on "deletionRequestedAt" (the order is now
-- the retry schedule, not the request time).
CREATE INDEX file_delete_due_idx ON file ("deleteNextAttemptAt") WHERE status = 'DELETING';
DROP INDEX file_deleting_idx;
