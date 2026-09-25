-- Rollback of 0010. Refuses while the outbox holds an unpublished event: dropping it would lose audit evidence that has not yet left
-- the service (let the relay drain first).
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM outbox WHERE "publishedAt" IS NULL) THEN
    RAISE EXCEPTION 'down/0010 refused: the outbox holds unpublished audit events; let the relay publish them first.';
  END IF;
END $$;

DROP TABLE outbox;
DROP FUNCTION outbox_immutable();

COMMIT;
