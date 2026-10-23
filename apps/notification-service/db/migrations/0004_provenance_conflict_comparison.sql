-- Core V2 S1c-1 (ADR-0057 §13.2 S0-C2 and §13.4 S0-C3; observe-only): conflict evidence records WHY it was kept. Additive only: one
-- nullable column and its check; no existing row, constraint or trigger changes, and no earlier migration is edited.
--
-- `comparison`:
--   * `differs`      the delivery was compared with the stored observation (a difference in the verified facts, or its body under the
--                    stored observation's OWN key) and found different;
--   * `unverifiable` the stored observation's key was deliberately retired, so its body could not be compared: this is never evidence that
--                    the content changed, and never a match.
--   * NULL           evidence recorded before this migration, whose reason was not recorded: it is left exactly as it is, never interpreted
--                    as either value, and never rewritten (the table stays append-only; adding a column fires no row trigger).
-- A key that is merely unavailable, or an unknown commitment version, never produces evidence at all (the commit fails, §13.3).
ALTER TABLE event_provenance_conflict ADD COLUMN comparison text;
ALTER TABLE event_provenance_conflict ADD CONSTRAINT event_provenance_conflict_comparison_valid CHECK (comparison IS NULL OR comparison IN ('differs', 'unverifiable'));
