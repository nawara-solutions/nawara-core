-- Generic, reusable trigger functions for any service's own tables. No business data, no business meaning: the column
-- list a table applies these to is entirely up to that table's own migration.

-- Rejects any UPDATE that changes one of the given columns (TG_ARGV). A service makes a column immutable with:
--   CREATE TRIGGER x_immutable BEFORE UPDATE ON x FOR EACH ROW EXECUTE FUNCTION forbid_column_change('col1', 'col2');
CREATE FUNCTION forbid_column_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, col USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
