-- Stage 17.8: the file-name constraint of 0001 listed the bidi embeddings / overrides (U+202A–202E) and isolates (U+2066–2069) but not
-- the three other Unicode bidi controls (U+061C ARABIC LETTER MARK, U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK), nor the
-- line / paragraph separators (U+2028 / U+2029) or the BOM (U+FEFF). The sanitizer removes them from this stage on; this constraint is
-- again the last line of defence. Forward-only: 0001 is not rewritten. NOT VALID: a name is immutable once written, so only new rows can
-- ever be checked (rows written before this migration keep the name they were given; none exist outside development).
ALTER TABLE file
  ADD CONSTRAINT file_original_name_no_marks
  CHECK ("originalName" IS NULL OR "originalName" !~ '[\u061c\u200e\u200f\u2028\u2029\ufeff]') NOT VALID;
