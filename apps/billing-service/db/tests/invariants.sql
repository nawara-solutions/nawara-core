-- Database-level invariant tests for billing-service's migrations (Stage 2). Run via db/tests/run.sh on a fresh scratch database.
-- Proves what the DATABASE refuses regardless of application code: the Billing financial invariants BI-01 .. BI-21 of
-- docs/sdd/billing-service.md section 8 that the schema enforces. Each assertion targets ONE rule.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE TEMP TABLE results (id text, name text, ok boolean, detail text);

-- expect_error: the statement(s) must fail with exactly this SQLSTATE (and, when given, this constraint). Runs in a subtransaction that
-- is ALWAYS rolled back (also when it unexpectedly succeeds), so a broken invariant shows up as one FAIL row, not as corrupted fixture state.
-- Deferred constraint triggers are exercised with `SET CONSTRAINTS ALL IMMEDIATE` as the last statement.
CREATE FUNCTION pg_temp.expect_error(tid text, tname text, stmt text, want text, want_constraint text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE cn text;
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'statement unexpectedly succeeded' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    IF SQLSTATE = 'XX999' THEN
      INSERT INTO results VALUES (tid, tname, false, 'expected SQLSTATE '||want||' but the statement succeeded');
    ELSIF SQLSTATE <> want THEN
      INSERT INTO results VALUES (tid, tname, false, 'wanted '||want||' got '||SQLSTATE||': '||SQLERRM);
    ELSIF want_constraint IS NOT NULL AND cn IS DISTINCT FROM want_constraint THEN
      INSERT INTO results VALUES (tid, tname, false, 'wanted constraint '||want_constraint||' got '||coalesce(cn, 'none')||': '||SQLERRM);
    ELSE
      INSERT INTO results VALUES (tid, tname, true, NULL);
    END IF;
  END;
END $$;

CREATE FUNCTION pg_temp.expect_ok(tid text, tname text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (tid, tname, true, NULL);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (tid, tname, false, SQLSTATE||': '||SQLERRM);
  END;
END $$;

CREATE FUNCTION pg_temp.assert_eq(tid text, tname text, got text, want text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO results VALUES (tid, tname, got IS NOT DISTINCT FROM want,
    CASE WHEN got IS NOT DISTINCT FROM want THEN NULL ELSE 'wanted '||coalesce(want,'NULL')||' got '||coalesce(got,'NULL') END);
$$;

\o /dev/null
\i fixtures.sql
\o

-- =================================================================================================================== BI-01
SELECT t_mk_price(1000) AS seed_price \gset
SELECT pg_temp.expect_error('BI-01', 'a price above 2^53-1 is refused (exact rule)', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'big-2', 'TND', 9007199254740992, 'one_time' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_amount_safe');
SELECT pg_temp.expect_ok('BI-01', 'a price of exactly 2^53-1 is accepted and exact', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'max-1', 'TND', 9007199254740991, 'one_time' FROM price WHERE id = %L$$, :'seed_price'));
SELECT pg_temp.assert_eq('BI-01', 'no money column is anything but bigint',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public'
    AND ((table_name = 'price' AND column_name = 'unitAmount') OR (table_name = 'invoice' AND column_name IN ('subtotal', 'taxTotal', 'total'))
      OR (table_name = 'invoice_line' AND column_name IN ('unitAmount', 'lineTotal', 'taxAmount')) OR (table_name = 'payment_request' AND column_name = 'amount'))
    AND data_type <> 'bigint'), '0');
SELECT pg_temp.assert_eq('BI-01', 'the money columns that exist are exactly the eight the SDD defines',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'bigint'
    AND table_name NOT IN ('invoice_number_sequence')), '8');
SELECT pg_temp.expect_error('BI-01', 'an invoice above 2^53-1 is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 9007199254740992, 9007199254740992, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_amounts_safe');

-- =================================================================================================================== BI-02
SELECT pg_temp.expect_error('BI-02', 'a zero price is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'z-1', 'TND', 0, 'one_time' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_amount_positive');
SELECT pg_temp.expect_error('BI-02', 'a negative price is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'z-2', 'TND', -1, 'one_time' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_amount_positive');
SELECT t_mk_invoice() AS d1 \gset
SELECT pg_temp.expect_error('BI-02', 'a zero line quantity is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 0, "unitAmount", 0, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514', 'invoice_line_quantity_positive');
SELECT pg_temp.expect_error('BI-02', 'a zero line unit amount is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 1, 0, 0, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-02', 'a negative line tax is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "taxAmount", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 1, 5, 5, -1, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514', 'invoice_line_tax_nonnegative');
SELECT pg_temp.expect_error('BI-02', 'a negative invoice tax is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, "taxTotal", total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, -1, 99, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_tax_nonnegative');
SELECT pg_temp.expect_error('BI-02', 'a zero invoice total is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 0, 0, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514');
SELECT t_mk_open() AS o1 \gset
SELECT pg_temp.expect_error('BI-02', 'a zero payment request amount is refused (the request is for the full total)', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType") VALUES (%L, 0, 'TND', 'user')$$, :'o1'), '23514');

-- =================================================================================================================== BI-03
SELECT pg_temp.expect_error('BI-03', 'a draft invoice''s currency cannot change', format($$UPDATE invoice SET currency = 'USD' WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-03', 'an open invoice''s currency cannot change', format($$UPDATE invoice SET currency = 'USD' WHERE id = %L$$, :'o1'), '23514');

-- =================================================================================================================== BI-04
SELECT pg_temp.expect_error('BI-04', 'a line whose currency is not its invoice''s is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", 'USD', 2, "priceId", "productId", "productCode", 'x', 1, 5, 5, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23503', 'invoice_line_invoice_fk');
SELECT pg_temp.expect_error('BI-04', 'a payment request whose currency is not its invoice''s is refused', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType")
  SELECT id, total, 'USD', 'user' FROM invoice WHERE id = %L$$, :'o1'), '23503', 'payment_request_invoice_fk');

-- =================================================================================================================== BI-05
SELECT pg_temp.expect_error('BI-05', 'a header total that is not subtotal + tax is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, "taxTotal", total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 1000, 0, 1500, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_total_is_subtotal_plus_tax');
SELECT pg_temp.expect_error('BI-05', 'a line total that is not quantity x unit amount is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 3, 100, 301, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514', 'invoice_line_total_is_quantity_times_unit');
SELECT pg_temp.expect_error('BI-05', 'an invoice with NO lines is refused at commit', $q$DO $do$ DECLARE i uuid; BEGIN
  INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
  VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1', 'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}') RETURNING id INTO i;
  PERFORM t_hist('invoice', i, NULL, 'draft', 0);
  SET CONSTRAINTS ALL IMMEDIATE;
END $do$$q$, '23514');
SELECT pg_temp.expect_error('BI-05', 'a header that disagrees with the sum of its lines is refused at commit', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 1, 5, 5, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L; SET CONSTRAINTS ALL IMMEDIATE$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-05', 'a 101st line is refused (at most 100 lines per invoice)', $q$DO $do$
  DECLARE i uuid := t_mk_invoice(); pr uuid; pd uuid; pc text; n int;
  BEGIN
    SELECT "priceId", "productId", "productCode" INTO pr, pd, pc FROM invoice_line WHERE "invoiceId" = i;
    FOR n IN 2..101 LOOP
      INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
      VALUES (i, 'TND', n, pr, pd, pc, 'x', 1, 1000, 1000, 'none', 'one_time');
    END LOOP;
  END $do$$q$, '23514');
SELECT pg_temp.assert_eq('BI-05', 'a well-formed invoice (header = sum of its lines) commits', (SELECT (subtotal = total)::text FROM invoice WHERE id = :'d1'), 'true');

-- =================================================================================================================== BI-06
SELECT id AS d1_line_price FROM (SELECT "priceId" AS id FROM invoice_line WHERE "invoiceId" = :'d1') x \gset
SELECT pg_temp.expect_error('BI-06', 'a price amount cannot be changed', format($$UPDATE price SET "unitAmount" = 1 WHERE id = %L$$, :'d1_line_price'), '23514');
SELECT pg_temp.expect_error('BI-06', 'a price currency cannot be changed', format($$UPDATE price SET currency = 'TND', "clientReference" = 'changed' WHERE id = %L$$, :'d1_line_price'), '23514');
SELECT pg_temp.expect_ok('BI-06', 'a price can be retired', format($$UPDATE price SET "retiredAt" = now() WHERE id = %L$$, :'d1_line_price'));
SELECT pg_temp.expect_error('BI-06', 'a price retirement is set once and cannot change', format($$UPDATE price SET "retiredAt" = now() + interval '1 day' WHERE id = %L$$, :'d1_line_price'), '23514');
SELECT pg_temp.assert_eq('BI-06', 'retiring the price leaves the invoice line exactly as charged', (SELECT ("unitAmount"::text || '/' || quantity::text || '/' || "lineTotal"::text) FROM invoice_line WHERE "invoiceId" = :'d1'), '1000/2/2000');
SELECT "productId" AS d1_product FROM price WHERE id = :'d1_line_price' \gset
UPDATE product SET status = 'archived' WHERE id = :'d1_product';
SELECT pg_temp.assert_eq('BI-06', 'archiving the product leaves the invoice line and total exactly as charged', (SELECT l."productCode" || '/' || i.total::text FROM invoice_line l JOIN invoice i ON i.id = l."invoiceId" WHERE i.id = :'d1'), (SELECT p.code || '/2000' FROM product p WHERE p.id = :'d1_product'));
SELECT pg_temp.expect_error('BI-06', 'a product name cannot be edited (only archived)', format($$UPDATE product SET name = 'renamed' WHERE id = %L$$, :'d1_product'), '23514');
SELECT pg_temp.expect_error('BI-06', 'archiving is one way', format($$UPDATE product SET status = 'active' WHERE id = %L$$, :'d1_product'), '23514');
SELECT pg_temp.expect_error('BI-06', 'a product is never deleted', format($$DELETE FROM product WHERE id = %L$$, :'d1_product'), '23514');
SELECT pg_temp.expect_error('BI-06', 'a price is never deleted', format($$DELETE FROM price WHERE id = %L$$, :'d1_line_price'), '23514');

-- =================================================================================================================== BI-07
SELECT pg_temp.expect_error('BI-07', 'a line cannot be updated', format($$UPDATE invoice_line SET quantity = 5 WHERE "invoiceId" = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'a line cannot be deleted', format($$DELETE FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'invoice totals cannot be updated', format($$UPDATE invoice SET total = 1, subtotal = 1 WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'a line cannot be added to an OPEN invoice', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 1, 5, 5, "entitlementKind", "interval" FROM invoice_line WHERE "invoiceId" = %L$$, :'o1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'an invoice is never deleted', format($$DELETE FROM invoice WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'a COLUMN ADDED LATER is immutable by default (the allow-list, not a deny-list)', format($$ALTER TABLE invoice ADD COLUMN zz_future text; UPDATE invoice SET zz_future = 'x' WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'the producer cannot be changed', format($$UPDATE invoice SET producer = 'someone-else' WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'the payer cannot be changed', format($$UPDATE invoice SET "payerId" = 'someone-else' WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'the due date cannot be changed', format($$UPDATE invoice SET "dueAt" = now() WHERE id = %L$$, :'d1'), '23514');
SELECT pg_temp.expect_error('BI-07', 'the request hash cannot be changed', format($$UPDATE invoice SET "requestHash" = repeat('c', 64) WHERE id = %L$$, :'d1'), '23514');

-- =================================================================================================================== BI-08 / BI-09
SELECT pg_temp.expect_error('BI-08', 'a payment request above the invoice total is refused (amount due can never go negative)', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType")
  SELECT id, total + 1, currency, 'user' FROM invoice WHERE id = %L$$, :'o1'), '23514');
SELECT pg_temp.expect_error('BI-09', 'a PARTIAL payment request is refused until B-010 is decided', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType")
  SELECT id, total - 1, currency, 'user' FROM invoice WHERE id = %L$$, :'o1'), '23514');
SELECT pg_temp.expect_error('BI-09', 'a second PAID request for one invoice is refused', format($q$DO $do$
  DECLARE r1 uuid := t_mk_request(%L); r2 uuid;
  BEGIN
    PERFORM t_advance(r1, 'sending'); PERFORM t_advance(r1, 'requested'); PERFORM t_advance(r1, 'paid');
    r2 := t_mk_request(%L);
    PERFORM t_advance(r2, 'sending'); PERFORM t_advance(r2, 'requested'); PERFORM t_advance(r2, 'paid');
  END $do$$q$, :'o1', :'o1'), '23505', 'payment_request_one_paid');
SELECT pg_temp.expect_error('BI-09', 'a payment request for a draft invoice is refused', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType")
  SELECT id, total, currency, 'user' FROM invoice WHERE id = %L$$, :'d1'), '23514');
SELECT t_mk_invoice('organization', 'org-payer-1') AS org_payer_draft \gset
SELECT t_issue(:'org_payer_draft'::uuid) AS org_payer_no \gset
SELECT pg_temp.expect_error('BI-09', 'a payment request for an ORGANIZATION payer is refused until B-026 is decided (it could never be closed)', format($$INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType")
  SELECT id, total, currency, 'user' FROM invoice WHERE id = %L$$, :'org_payer_draft'), '23514');

-- =================================================================================================================== BI-10
SELECT t_mk_invoice() AS n1 \gset
SELECT t_mk_invoice() AS n2 \gset
SELECT t_mk_invoice() AS n3 \gset
SELECT t_issue(:'n1'::uuid)::bigint AS num1 \gset
SELECT t_issue(:'n2'::uuid)::bigint AS num2 \gset
SELECT pg_temp.assert_eq('BI-10', 'consecutive issues for one seller get consecutive numbers', (:num2 - :num1)::text, '1');
SELECT pg_temp.expect_error('BI-10', 'a number cannot be changed after issue', format($$UPDATE invoice SET number = '999' WHERE id = %L$$, :'n1'), '23514');
SELECT pg_temp.expect_error('BI-10', 'a number cannot be set on a draft without issuing it', format($$UPDATE invoice SET number = '999' WHERE id = %L$$, :'n3'), '23514');
SELECT t_mk_invoice() AS nx \gset
SELECT pg_temp.expect_ok('BI-10', 'issuing with a caller-supplied number succeeds', format($$UPDATE invoice SET status = 'open', number = '7777', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}' WHERE id = %L; SELECT t_hist('invoice', %L, 'draft', 'open', 1)$$, :'nx', :'nx'));
SELECT pg_temp.assert_eq('BI-10', 'a caller-supplied number is discarded at issue: the counter decides', (SELECT (number <> '7777')::text FROM invoice WHERE id = :'nx'), 'true');
SELECT pg_temp.expect_error('BI-10', 'a duplicate number for one seller is refused by the unique index', format($$SELECT set_config('session_replication_role', 'replica', true);
  UPDATE invoice SET number = (SELECT number FROM invoice WHERE id = %L) WHERE id = %L$$, :'n2', :'n1'), '23505', 'invoice_number_unique');
SELECT pg_temp.expect_error('BI-10', 'a number longer than 64 characters is refused (Payment''s reference limit)', format($$SELECT set_config('session_replication_role', 'replica', true);
  UPDATE invoice SET number = repeat('9', 65) WHERE id = %L$$, :'n1'), '23514', 'invoice_number_length');
-- an issue that rolls back returns its number
SELECT (SELECT "nextValue" FROM invoice_number_sequence WHERE "sellerType" = 'organization' AND "sellerId" = '00000000-0000-4000-8000-0000000000a1') AS seq_before \gset
SELECT pg_temp.expect_error('BI-10', 'an issue that is rolled back (fixture)', format($q$DO $do$ BEGIN PERFORM t_issue(%L::uuid); RAISE EXCEPTION 'rollback' USING ERRCODE = 'XX998'; END $do$$q$, :'n3'), 'XX998');
SELECT pg_temp.assert_eq('BI-10', 'a rolled-back issue returns its number to the counter',
  (SELECT "nextValue"::text FROM invoice_number_sequence WHERE "sellerType" = 'organization' AND "sellerId" = '00000000-0000-4000-8000-0000000000a1'), :'seq_before'::text);
SELECT pg_temp.expect_error('BI-10', 'the counter cannot be rewound', $$UPDATE invoice_number_sequence SET "nextValue" = "nextValue" - 1$$, '23514');
SELECT pg_temp.expect_error('BI-10', 'the counter cannot jump', $$UPDATE invoice_number_sequence SET "nextValue" = "nextValue" + 5$$, '23514');
SELECT pg_temp.expect_error('BI-10', 'a counter is never deleted', $$DELETE FROM invoice_number_sequence$$, '23514');
SELECT pg_temp.expect_error('BI-10', 'a counter cannot be created ahead of its first allocation', $$INSERT INTO invoice_number_sequence ("sellerType", "sellerId", "nextValue") VALUES ('user', 'someone', 500)$$, '23514');

-- =================================================================================================================== BI-11
SELECT pg_temp.expect_error('BI-11', 'an invoice in an unknown currency is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'XXX', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23503');
SELECT pg_temp.expect_error('BI-11', 'a price in an unknown currency is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'cur-1', 'XXX', 5, 'one_time' FROM price WHERE id = %L$$, :'seed_price'), '23503');
SELECT pg_temp.assert_eq('BI-11', 'the only seeded currency is TND with three decimals', (SELECT string_agg(code || ':' || exponent, ',' ORDER BY code) FROM currency), 'TND:3');

-- =================================================================================================================== BI-13
SELECT t_mk_open() AS o2 \gset
SELECT t_mk_request(:'o2'::uuid) AS o2_req \gset
SELECT pg_temp.expect_error('BI-13', 'a second ACTIVE payment request for one invoice is refused', format($$SELECT t_mk_request(%L)$$, :'o2'), '23505', 'payment_request_one_active');
SELECT pg_temp.expect_ok('BI-13', 'a new request is allowed once the previous one has ended', format($q$DO $do$ BEGIN
  PERFORM t_advance(%L, 'sending'); PERFORM t_advance(%L, 'requested'); PERFORM t_advance(%L, 'failed'); PERFORM t_mk_request(%L); END $do$$q$, :'o2_req', :'o2_req', :'o2_req', :'o2'));

-- =================================================================================================================== BI-14
SELECT t_mk_open() AS o3 \gset
SELECT pg_temp.expect_error('BI-14', 'a bare UPDATE to paid, with no paid payment request, is refused', format($$UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-14', 'paid without paidAt is refused', format($$UPDATE invoice SET status = 'paid' WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-14', 'paidAt on an invoice that is not paid is refused', format($$UPDATE invoice SET "paidAt" = now() WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-14', 'a request that is only `requested` does not make the invoice payable', format($q$DO $do$ DECLARE r uuid := t_mk_request(%L); BEGIN
  PERFORM t_advance(r, 'sending'); PERFORM t_advance(r, 'requested'); UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = %L; END $do$$q$, :'o3', :'o3'), '23514');
SELECT t_mk_paid() AS p1 \gset
SELECT pg_temp.assert_eq('BI-14', 'an invoice paid through a paid request for its full total is paid', (SELECT status FROM invoice WHERE id = :'p1'), 'paid');
SELECT pg_temp.assert_eq('BI-14', 'the single paid request of a paid invoice is discoverable', (SELECT count(*)::text FROM payment_request WHERE "invoiceId" = :'p1' AND status = 'paid'), '1');
SELECT pg_temp.expect_error('BI-14', 'a payment request cannot become paid for an invoice that is not open', format($q$DO $do$ DECLARE r uuid := t_mk_request(%L); BEGIN
  PERFORM t_advance(r, 'sending'); PERFORM t_advance(r, 'requested');
  PERFORM set_config('session_replication_role', 'replica', true);
  UPDATE invoice SET status = 'void', "voidedAt" = now() WHERE id = %L;
  PERFORM set_config('session_replication_role', 'origin', true);
  PERFORM t_advance(r, 'paid');
END $do$$q$, :'o3', :'o3'), '23514');

-- =================================================================================================================== BI-15
SELECT t_mk_open() AS o4 \gset
SELECT t_mk_request(:'o4'::uuid) AS o4_req \gset
SELECT pg_temp.expect_error('BI-15', 'a payment request amount cannot change', format($$UPDATE payment_request SET amount = amount - 1 WHERE id = %L$$, :'o4_req'), '23514');
SELECT pg_temp.expect_error('BI-15', 'a payment request expiry cannot change', format($$UPDATE payment_request SET "expiresAt" = now() WHERE id = %L$$, :'o4_req'), '23514');
SELECT pg_temp.expect_error('BI-15', 'a payment request mapping version cannot change', format($$UPDATE payment_request SET "mappingVersion" = 2 WHERE id = %L$$, :'o4_req'), '23514');
SELECT pg_temp.expect_error('BI-15', 'a payment request invoice cannot change', format($$UPDATE payment_request SET "invoiceId" = %L WHERE id = %L$$, :'o3', :'o4_req'), '23514');
SELECT pg_temp.expect_error('BI-15', 'a payment request is never deleted', format($$DELETE FROM payment_request WHERE id = %L$$, :'o4_req'), '23514');

-- =================================================================================================================== BI-16 (every forbidden move) and the allowed ones
SELECT pg_temp.expect_ok('BI-16', 'draft -> open is allowed', format($$SELECT t_issue(%L::uuid)$$, :'n3'));
SELECT pg_temp.expect_ok('BI-16', 'draft -> void is allowed (discard)', $$SELECT t_mk_void()$$);
SELECT pg_temp.expect_ok('BI-16', 'open -> paid is allowed (through a paid request)', $$SELECT t_mk_paid()$$);
SELECT t_mk_void() AS v1 \gset
SELECT t_mk_invoice() AS dr \gset
SELECT pg_temp.expect_error('BI-16', 'draft -> paid is refused', format($$UPDATE invoice SET status = 'paid', "paidAt" = now() WHERE id = %L$$, :'dr'), '23514');
SELECT pg_temp.expect_error('BI-16', 'open -> draft is refused', format($$UPDATE invoice SET status = 'draft', number = NULL, "issuedAt" = NULL, presentation = NULL WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-16', 'open -> void is refused until B-015 is decided', format($$UPDATE invoice SET status = 'void' WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-16', 'paid -> open is refused', format($$UPDATE invoice SET status = 'open', "paidAt" = NULL WHERE id = %L$$, :'p1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'paid -> draft is refused', format($$UPDATE invoice SET status = 'draft', "paidAt" = NULL, number = NULL, "issuedAt" = NULL, presentation = NULL WHERE id = %L$$, :'p1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'paid -> void is refused', format($$UPDATE invoice SET status = 'void', "paidAt" = NULL WHERE id = %L$$, :'p1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'void -> draft is refused', format($$UPDATE invoice SET status = 'draft', "voidedAt" = NULL WHERE id = %L$$, :'v1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'void -> open is refused', format($$UPDATE invoice SET status = 'open', "voidedAt" = NULL WHERE id = %L$$, :'v1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'void -> paid is refused', format($$UPDATE invoice SET status = 'paid', "voidedAt" = NULL, "paidAt" = now() WHERE id = %L$$, :'v1'), '23514');
SELECT pg_temp.expect_error('BI-16', 'a row cannot be created already issued', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, status, number, "issuedAt", "issuerSnapshot", "billToSnapshot", presentation) VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization',
  '00000000-0000-4000-8000-0000000000a1', 'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, 'open', '1', now(), '{"schemaVersion":1}', '{"schemaVersion":1}',
  '{"schemaVersion":1,"template":"system:1","locale":"fr"}')$$, '23514');
-- payment request moves
SELECT t_mk_request(t_mk_open()) AS rq \gset
SELECT pg_temp.expect_error('BI-16', 'a payment request cannot jump created -> requested', format($$UPDATE payment_request SET status = 'requested', "paymentId" = gen_random_uuid() WHERE id = %L$$, :'rq'), '23514');
SELECT pg_temp.expect_error('BI-16', 'a payment request cannot jump created -> paid', format($$UPDATE payment_request SET status = 'paid' WHERE id = %L$$, :'rq'), '23514');
SELECT pg_temp.expect_error('BI-16', 'a paymentId cannot be set without becoming requested', format($$UPDATE payment_request SET "paymentId" = gen_random_uuid() WHERE id = %L$$, :'rq'), '23514');
SELECT pg_temp.expect_error('BI-16', 'a closed payment request never reopens', format($q$DO $do$ BEGIN PERFORM t_advance(%L, 'cancelled'); UPDATE payment_request SET status = 'sending' WHERE id = %L; END $do$$q$, :'rq', :'rq'), '23514');

-- =================================================================================================================== BI-17 (blocked by B-016)
SELECT pg_temp.assert_eq('BI-17', 'BLOCKED by B-016: no credit note table exists yet', (SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'credit_note'), '0');

-- =================================================================================================================== BI-18 (Payment's contract, one rule per assertion)
SELECT pg_temp.expect_error('BI-18', 'a payer type outside user/organization/company is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'robot', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_payer_type_valid');
SELECT pg_temp.expect_error('BI-18', 'a payer id of 129 characters is refused', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', %L, '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, repeat('p', 129)), '23514', 'invoice_payer_id_length');
SELECT pg_temp.expect_error('BI-18', 'an empty payer id is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', '', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_payer_id_length');
SELECT pg_temp.expect_error('BI-18', 'a payer equal to the seller is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'organization', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_payer_seller_distinct');
SELECT pg_temp.expect_error('BI-18', 'an organization seller with a NULL organizationId is refused (a NULL cannot slip past the CHECK)', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_organization_matches_seller');
SELECT pg_temp.expect_error('BI-18', 'an organization seller whose organizationId differs from the seller id is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a2', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_organization_matches_seller');
SELECT pg_temp.expect_error('BI-18', 'a lower-case currency is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'tnd', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_currency_shape');
SELECT pg_temp.expect_error('BI-18', 'a description of 141 characters is refused', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, description, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, %L, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, repeat('d', 141)), '23514', 'invoice_description_length');
SELECT pg_temp.expect_error('BI-18', 'a source type with a capital letter is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'Contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_source_type_shape');
SELECT pg_temp.expect_error('BI-18', 'a source id of 129 characters is refused', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', %L, 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, repeat('s', 129)), '23514', 'invoice_source_id_length');
SELECT pg_temp.expect_ok('BI-18', 'an invoice at every documented maximum is accepted (128-character payer and source id, 140-character description, uuid organization seller)', format($q$DO $do$
  DECLARE i uuid; pr uuid := t_mk_price(1000); pd uuid; pc text;
  BEGIN
    SELECT "productId" INTO pd FROM price WHERE id = pr; SELECT code INTO pc FROM product WHERE id = pd;
    INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, description, "issuerSnapshot", "billToSnapshot")
    VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1', 'user', %L, '00000000-0000-4000-8000-0000000000a1', 'contract', %L, 'TND', 1000, 1000, %L, '{"schemaVersion":1}', '{"schemaVersion":1}') RETURNING id INTO i;
    INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval") VALUES (i, 'TND', 1, pr, pd, pc, 'x', 1, 1000, 1000, 'none', 'one_time');
    PERFORM t_hist('invoice', i, NULL, 'draft', 0);
    SET CONSTRAINTS ALL IMMEDIATE;
  END $do$$q$, repeat('p', 128), repeat('s', 128), repeat('d', 140)));

-- =================================================================================================================== BI-19
SELECT pg_temp.assert_eq('BI-19', 'revision counts state changes (draft 0, open 1, paid 2)', (SELECT revision::text FROM invoice WHERE id = :'p1'), '2');
UPDATE invoice SET revision = 99 WHERE id = :'p1';
SELECT pg_temp.assert_eq('BI-19', 'a caller-supplied revision is overwritten by the trigger', (SELECT revision::text FROM invoice WHERE id = :'p1'), '2');
SELECT pg_temp.assert_eq('BI-19', 'updatedAt follows the last change', (SELECT ("updatedAt" >= "createdAt")::text FROM invoice WHERE id = :'p1'), 'true');
SELECT pg_temp.expect_error('BI-19', 'a status change with no history row cannot commit', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}'::jsonb WHERE id = %L; SET CONSTRAINTS ALL IMMEDIATE$$, :'dr'), '23514');
SELECT pg_temp.expect_error('BI-19', 'an invoice created with no creation history row cannot commit', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}'); SET CONSTRAINTS invoice_history_on_create IMMEDIATE$$, '23514');
SELECT pg_temp.expect_error('BI-19', 'a history row cannot be changed', $$UPDATE billing_transition SET "actorType" = 'user'$$, '23514');
SELECT pg_temp.expect_error('BI-19', 'a history row cannot be deleted', $$DELETE FROM billing_transition$$, '23514');
SELECT pg_temp.expect_error('BI-19', 'a creation history row must carry revision 0', format($$INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType")
  VALUES ('invoice', %L, NULL, 'draft', 5, 'system', 'request')$$, :'dr'), '23514', 'billing_transition_creation_shape');
SELECT pg_temp.expect_error('BI-19', 'two history rows for one revision are refused', format($$INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType")
  VALUES ('invoice', %L, NULL, 'draft', 0, 'system', 'request')$$, :'dr'), '23505', 'billing_transition_revision_unique');
SELECT pg_temp.assert_eq('BI-19', 'every committed status change has a history row', (SELECT count(*)::text FROM invoice i WHERE NOT EXISTS (SELECT 1 FROM billing_transition t WHERE t."entityType" = 'invoice' AND t."entityId" = i.id AND t."toStatus" = i.status AND t.revision = i.revision)), '0');

-- =================================================================================================================== BI-20
SELECT pg_temp.expect_error('BI-20', 'the issuer snapshot cannot change', format($$UPDATE invoice SET "issuerSnapshot" = '{"schemaVersion":1,"name":"Other"}' WHERE id = %L$$, :'dr'), '23514');
SELECT pg_temp.expect_error('BI-20', 'the bill-to snapshot cannot change', format($$UPDATE invoice SET "billToSnapshot" = '{"schemaVersion":1,"name":"Other"}' WHERE id = %L$$, :'p1'), '23514');
SELECT pg_temp.expect_error('BI-20', 'the presentation cannot be set on a draft without issuing it', format($$UPDATE invoice SET presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}' WHERE id = %L$$, :'dr'), '23514');
SELECT pg_temp.expect_error('BI-20', 'the presentation cannot change after issue', format($$UPDATE invoice SET presentation = '{"schemaVersion":1,"template":"system:1","locale":"ar"}' WHERE id = %L$$, :'o3'), '23514');
SELECT pg_temp.expect_error('BI-20', 'issuing without a presentation is refused', format($$UPDATE invoice SET status = 'open' WHERE id = %L$$, :'dr'), '23514', 'invoice_issued_has_presentation');
SELECT pg_temp.expect_error('BI-20', 'a snapshot that is not a JSON object is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '[1]', '{"schemaVersion":1}')$$, '23514', 'invoice_issuer_snapshot_shape');
SELECT pg_temp.expect_error('BI-20', 'a snapshot with no schemaVersion is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"schemaVersion":1}', '{"name":"x"}')$$, '23514', 'invoice_bill_to_snapshot_shape');
SELECT pg_temp.expect_error('BI-20', 'a snapshot larger than 8 KB is refused', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, %L::jsonb, '{"schemaVersion":1}')$$, '{"schemaVersion":1,"pad":"' || repeat('x', 9000) || '"}'), '23514', 'invoice_issuer_snapshot_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation carrying an amount is refused (it can hold no financial value)', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr","total":1}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation carrying markup as a key is refused (closed vocabulary)', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr","html":"<b>x</b>"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a template reference that is not an identifier is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"<script>alert(1)</script>","locale":"fr"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a locale that is not a language tag is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr; drop"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation with an unknown schemaVersion is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":2,"template":"system:1","locale":"fr"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation with no locale is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation with no template is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"locale":"fr"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'a presentation with no schemaVersion is refused', format($$UPDATE invoice SET status = 'open', presentation = '{"template":"system:1","locale":"fr"}' WHERE id = %L$$, :'dr'), '23514', 'invoice_presentation_shape');
SELECT pg_temp.expect_error('BI-20', 'an issuer snapshot with no schemaVersion is refused', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot") VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'organization', '00000000-0000-4000-8000-0000000000a1',
  'user', 'u', '00000000-0000-4000-8000-0000000000a1', 'contract', 's', 'TND', 100, 100, '{"name":"x"}', '{"schemaVersion":1}')$$, '23514', 'invoice_issuer_snapshot_shape');
SELECT pg_temp.expect_ok('BI-20', 'a valid presentation (template reference and locale) is accepted at issue', format($$SELECT t_issue(%L::uuid)$$, :'dr'));

-- =================================================================================================================== BI-21
SELECT pg_temp.expect_error('BI-21', 'a currency exponent cannot change', $$UPDATE currency SET exponent = 2 WHERE code = 'TND'$$, '23514');
SELECT pg_temp.expect_error('BI-21', 'a currency code cannot change', $$UPDATE currency SET code = 'TNX' WHERE code = 'TND'$$, '23514');
SELECT pg_temp.expect_error('BI-21', 'a currency row cannot be deleted', $$DELETE FROM currency WHERE code = 'TND'$$, '23514');
SELECT pg_temp.assert_eq('BI-21', 'TND still has three decimals (historical amounts are not re-scaled)', (SELECT exponent::text FROM currency WHERE code = 'TND'), '3');

-- =================================================================================================================== catalog, receipts and structural rules
SELECT pg_temp.expect_error('CATALOG', 'a duplicate product code for one seller is refused', format($$INSERT INTO product ("sellerType", "sellerId", code, name)
  SELECT "sellerType", "sellerId", code, 'dup' FROM product WHERE id = %L$$, :'d1_product'), '23505', 'product_code_unique');
SELECT pg_temp.expect_error('CATALOG', 'a duplicate price reference for one product is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", "clientReference", currency, "unitAmount", "interval" FROM price WHERE id = %L$$, :'d1_line_price'), '23505', 'price_reference_unique');
SELECT pg_temp.expect_error('CATALOG', 'a recurring price needs its interval unit and count', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT "productId", 'rec-1', 'TND', 5, 'recurring' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_interval_shape');
SELECT pg_temp.expect_error('CATALOG', 'a recurring price with a unit but no count is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit")
  SELECT "productId", 'rec-2', 'TND', 5, 'recurring', 'month' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_interval_shape');
SELECT pg_temp.expect_error('CATALOG', 'a line with a source type but no source id is refused', format($$INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval", "sourceType")
  SELECT "invoiceId", currency, 2, "priceId", "productId", "productCode", 'x', 1, 5, 5, "entitlementKind", "interval", 'contract' FROM invoice_line WHERE "invoiceId" = %L$$, :'d1'), '23514', 'invoice_line_source_pair');
SELECT pg_temp.expect_error('CATALOG', 'a one-time price cannot carry an interval', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  SELECT "productId", 'ot-1', 'TND', 5, 'one_time', 'month', 1 FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_interval_shape');
SELECT pg_temp.expect_error('CATALOG', 'tiered or usage pricing cannot be stored (deferred)', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "pricingModel")
  SELECT "productId", 'tier-1', 'TND', 5, 'one_time', 'tiered' FROM price WHERE id = %L$$, :'seed_price'), '23514', 'price_model_flat_only');
INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", outcome, "causeType") VALUES (gen_random_uuid(), 'payment.succeeded', gen_random_uuid(), 'ignored', 'payment_event');
SELECT pg_temp.expect_error('RECEIPT', 'a payment event receipt cannot be changed', $$UPDATE payment_event_receipt SET outcome = 'applied'$$, '23514');
SELECT pg_temp.expect_error('RECEIPT', 'a payment event receipt cannot be deleted', $$DELETE FROM payment_event_receipt$$, '23514');
SELECT pg_temp.expect_error('RECEIPT', 'an outcome outside applied/ignored/conflict/deferred is refused', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType") VALUES (gen_random_uuid(), 'payment.succeeded', 'bound', 'payment_event')$$, '23514', 'payment_event_receipt_outcome_valid');
SELECT pg_temp.expect_error('RECEIPT', 'an event that is not one of the four consumed is refused', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType") VALUES (gen_random_uuid(), 'payment.created', 'ignored', 'payment_event')$$, '23514', 'payment_event_receipt_event_name_valid');
SELECT pg_temp.expect_error('RECEIPT', 'one receipt per event: a second receipt for the same event id is refused', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType")
  SELECT "eventId", "eventName", 'ignored', "causeType" FROM payment_event_receipt LIMIT 1$$, '23505', 'payment_event_receipt_event_unique');
SELECT pg_temp.expect_ok('RECEIPT', 'a `deferred` receipt is recorded with no paymentId bound', $$INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", outcome, "causeType") VALUES (gen_random_uuid(), 'payment.succeeded', gen_random_uuid(), 'deferred', 'payment_event')$$);
SELECT pg_temp.expect_error('IDEMPOTENCY', 'the same (producer, invoiceRequestId) twice is refused at the database', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
  SELECT producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot" FROM invoice WHERE id = %L$$, :'d1'), '23505', 'invoice_request_unique');

-- ------------------------------------------------------------------------------------------------------------- verdict
\o
SELECT id, name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail
  FROM results ORDER BY ok, id, name;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM results WHERE NOT ok) THEN
    RAISE EXCEPTION 'invariant test failures';
  END IF;
END $$;
