-- 0031 — payment-service: an attempt that holds Auth's consumption has its refund authorization row (Core V2 DO-76 S2; the Owner's D-76-3).
-- DEVELOPMENT AND SIMULATION ONLY. Expand only: one pre-check, one function and two deferred constraint triggers. No row, column, index or
-- privilege changes, and nothing is backfilled.
--
-- I-76 (register §7.2.6): `refund_authorization` (0018) is written by `RefundAttemptService.commitAuthorized` in the SAME transaction as the
-- attempt's move to `authorized` (the consumption: `receiptId`, `approvedByUserId`, `consumedAt`, `authorizedAt`), and 0018 backfilled every earlier
-- attempt. The attempt shape CHECK (0017) ties `receiptId` to every state from `authorized` on, and `refund_authorization_from_attempt` (0018, 0022)
-- already refuses an authorization row that is not the attempt's own consumption. What the database did NOT state was the forward direction: an
-- attempt could hold a consumption with no authorization row (only the application's one transaction coupled them; the DO-76 LIMITATION case). The
-- allocation then blocks its refund facts as `no_authorization`, and a dispatched refund would have no authorization to count against.
--
--   * At COMMIT (deferred, so the application's order — the attempt first, then its row — is unchanged), every attempt whose `receiptId` was set must
--     have a `refund_authorization` row for that attempt and that same receipt. Otherwise the whole transaction is refused: `23514`, constraint
--     `refund_attempt_authorization_row`.
--   * `receiptId` is written once (0017 `refund_attempt_authorization_immutable`), so checking the write that sets it is checking every state after it.
--   * The migration refuses to run over history that already violates the rule: it never invents an authorization for an existing attempt (the 0018
--     backfill is the only one, and it ran). An operator must reconcile such a row first.
--
-- Limits (recorded, not hidden): a superuser can still disable triggers or set `session_replication_role = replica`; the runtime role cannot
-- (it owns nothing: `runtime-role.e2e-spec.ts`). This rule does nothing about refund evidence arriving from outside Payment: that is DO-76 S1.

DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing FROM refund_attempt a
   WHERE a."receiptId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM refund_authorization z WHERE z."refundAttemptId" = a.id AND z."receiptId" = a."receiptId");
  IF missing > 0 THEN
    RAISE EXCEPTION '0031: % refund attempt(s) hold a consumption without their refund authorization row; reconcile them before this migration', missing
      USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_authorization_row';
  END IF;
END $$;

CREATE FUNCTION refund_attempt_authorization_row_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."receiptId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM refund_authorization z WHERE z."refundAttemptId" = NEW.id AND z."receiptId" = NEW."receiptId") THEN
    RAISE EXCEPTION 'refund_attempt %: an authorized attempt needs its refund authorization row', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_authorization_row';
  END IF;
  RETURN NULL;
END $$;

-- an INSERT never carries a consumption (0017 insert guard and shape); stated anyway, so the rule does not depend on another guard
CREATE CONSTRAINT TRIGGER refund_attempt_20_authorization_row_on_insert AFTER INSERT ON refund_attempt DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."receiptId" IS NOT NULL) EXECUTE FUNCTION refund_attempt_authorization_row_check();
CREATE CONSTRAINT TRIGGER refund_attempt_21_authorization_row AFTER UPDATE OF "receiptId" ON refund_attempt DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."receiptId" IS NOT NULL AND OLD."receiptId" IS DISTINCT FROM NEW."receiptId") EXECUTE FUNCTION refund_attempt_authorization_row_check();
