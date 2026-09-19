-- The counter that assigns an invoice number at issue (SDD BI-10). MECHANISM ONLY: the numbering SCOPE, format, series, reset and
-- whether a gapless series is required are B-004 and are not decided here. This is a single counter per seller with no prefix and
-- no year: a TEMPORARY RESTRICTION that a later migration replaces when B-004 is decided. It is not for real customers.

CREATE TABLE invoice_number_sequence (
  "sellerType" text NOT NULL,
  "sellerId"   text NOT NULL,
  "nextValue"  bigint NOT NULL,
  PRIMARY KEY ("sellerType", "sellerId"),
  CONSTRAINT invoice_number_sequence_next_valid CHECK ("nextValue" >= 2 AND "nextValue" <= 9007199254740991)
);

-- Allocates the next number. The row lock it takes is held until the calling transaction ends, so concurrent issues for one seller
-- are serialized (lock order: the invoice row first, then this row) and a rolled-back issue returns its number.
CREATE FUNCTION billing_allocate_invoice_number(p_seller_type text, p_seller_id text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO invoice_number_sequence ("sellerType", "sellerId", "nextValue") VALUES (p_seller_type, p_seller_id, 2)
  ON CONFLICT ("sellerType", "sellerId") DO UPDATE SET "nextValue" = invoice_number_sequence."nextValue" + 1
  RETURNING "nextValue" - 1 INTO v;
  RETURN v::text;
END $$;

-- The runtime role has UPDATE on this table, so the counter itself is guarded: it only ever moves forward by one, is only ever
-- created by the first allocation, and is never deleted (a rewind would let a number be issued twice).
CREATE FUNCTION billing_invoice_number_sequence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice number counters are never deleted' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."nextValue" <> 2 THEN RAISE EXCEPTION 'a counter starts by allocating number 1' USING ERRCODE = '23514'; END IF;
  ELSIF NEW."nextValue" <> OLD."nextValue" + 1 OR NEW."sellerType" <> OLD."sellerType" OR NEW."sellerId" <> OLD."sellerId" THEN
    RAISE EXCEPTION 'an invoice number counter only moves forward by one' USING ERRCODE = '23514';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER invoice_number_sequence_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_number_sequence
  FOR EACH ROW EXECUTE FUNCTION billing_invoice_number_sequence_guard();
