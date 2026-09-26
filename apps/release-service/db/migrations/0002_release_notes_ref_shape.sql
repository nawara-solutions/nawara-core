-- release-service 0002: repair the release-notes reference shape check (Stage 20.3).
--
-- 0001's `release_notes_ref_shape` wrote the rule as the regular expression '^[!-~]{1,512}$'. PostgreSQL's regular-expression engine
-- refuses a repetition count above 255 (RE_DUPMAX), and it compiles the expression when the check is first EVALUATED, not when the
-- constraint is created: so 0001 applied cleanly, and then every release with a non-null "notesRef" failed with "invalid regular
-- expression: invalid repetition count(s)" (found by the Stage 20.3 registration tests, the first code to store one).
--
-- The rule itself is unchanged (1 to 512 printable ASCII characters, no space, the service's NOTES_REF); only its spelling is: an
-- unbounded character class plus an explicit length bound. No row can hold a non-null value today (it could never be written), so the
-- new constraint validates trivially. 0001 is not edited: an applied migration is immutable.

ALTER TABLE release DROP CONSTRAINT release_notes_ref_shape;
ALTER TABLE release ADD CONSTRAINT release_notes_ref_shape
  CHECK ("notesRef" IS NULL OR (length("notesRef") BETWEEN 1 AND 512 AND "notesRef" ~ '^[!-~]+$'));
