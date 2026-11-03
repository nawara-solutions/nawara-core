-- Core V2 S0-C11 item 8 (register BIL-33 I, with the Owner's tenant-isolation clarification of 2026-11-03). EXPAND ONLY.
--
-- `capture_contradiction`: one visibility-only reconciliation case per contested capture fact and per observing payment, keyed by a one-way
-- identity of the two (`evidenceKey`), scoped to that payment's own seller Company. No resolution kind admits it (the resolution guard's ELSE is
-- false and it is not review-only), so it is never acknowledged, closed or resolved. No existing row changes.

ALTER TABLE reconciliation_case DROP CONSTRAINT reconciliation_case_type;
ALTER TABLE reconciliation_case ADD CONSTRAINT reconciliation_case_type CHECK ("caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'late_success',
  'unmatched_capture', 'unrouted_settlement', 'over_return', 'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect',
  'authorization_pending', 'chargeback_refund_overlap', 'capture_contradiction'));
