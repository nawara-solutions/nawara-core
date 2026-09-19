-- Currency reference data (SDD section 7, BI-11, BI-21) and the shared guard functions every later Billing table uses.
-- Reference data, not a domain entity: the ONLY place a currency exponent lives; nothing in code assumes one.

-- ---------------------------------------------------------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------------------------------------------------------

-- BI-07 / BI-20: immutable BY DEFAULT. Refuses a change to ANY column that is not named in the trigger's arguments (the mutable
-- allow-list). The kit's forbid_column_change is a DENY-list: a column added by a later migration and forgotten would be silently
-- mutable. Here it is immutable until someone deliberately allows it.
CREATE FUNCTION billing_immutable_except() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  k text;
BEGIN
  FOR k IN SELECT jsonb_object_keys(o) LOOP
    IF k = ANY (TG_ARGV) THEN CONTINUE; END IF;
    IF o -> k IS DISTINCT FROM n -> k THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, k USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- Append-only records (history, receipts, invoice lines): no UPDATE and no DELETE, ever.
CREATE FUNCTION billing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;

-- Financial and reference records are never deleted (the runtime role has DELETE through default privileges).
CREATE FUNCTION billing_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------
-- currency
-- ---------------------------------------------------------------------------------------------------------------------------

CREATE TABLE currency (
  code     char(3) PRIMARY KEY,
  exponent smallint NOT NULL,
  CONSTRAINT currency_code_shape CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT currency_exponent_range CHECK (exponent BETWEEN 0 AND 4)
);

-- Only the currency the architecture names (TND has three decimals, ADR-0036). Any other currency is B-005 and arrives in its own
-- migration once decided. Which currencies a deployment ACCEPTS is configuration (BILLING_SUPPORTED_CURRENCIES), not this table.
INSERT INTO currency (code, exponent) VALUES ('TND', 3);

-- BI-21: a changed exponent would silently re-scale every historical amount, and a referenced row is never deleted.
CREATE FUNCTION billing_currency_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'currency reference rows are immutable (BI-21): % is refused', TG_OP USING ERRCODE = '23514';
END $$;
CREATE TRIGGER currency_immutable BEFORE UPDATE OR DELETE ON currency
  FOR EACH ROW EXECUTE FUNCTION billing_currency_immutable();
