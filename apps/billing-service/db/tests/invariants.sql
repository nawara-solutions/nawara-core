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
    AND table_name NOT IN ('invoice_number_sequence')
    AND NOT (table_name = 'subscription_purchase' AND column_name = 'ledgerSeq') -- S3c: the ledger's ORDER, not money
    AND NOT (table_name IN ('fee_cap', 'fee_proposal') AND column_name = 'amount') -- S3f: school-fee configuration, checked below
    AND NOT (table_name = 'assistance_request' AND column_name IN ('baseAmount', 'feeAmount', 'totalAmount')) -- S5a: frozen assistance terms, checked below
    AND NOT (table_name = 'cash_return_obligation' AND column_name = 'amount') -- S5b: the frozen total owed back, checked below
    AND NOT (table_name = 'refund_case' AND column_name = 'amount') -- S6a: the full captured amount, equal to the payment request's (guard, e2e)
    AND NOT (table_name = 'refund_case_completion' AND column_name = 'approvedAmount') -- S6c: Payment's approved amount, equal to the case's (guard, e2e)
    AND NOT (table_name = 'payment_dispute_loss' AND column_name IN ('disputeAmount', 'chargebackAmount')) -- S6e-D
    AND NOT (table_name = 'fraud_hold_compensation' AND column_name = 'deniedMs') -- S6e-H: a duration (ms), not money
    -- S6f: the recovery base, a channel's outstanding amount at issue, a verified recovery payment and its split, a surplus (checked below)
    AND NOT (table_name = 'recovery_obligation' AND column_name = 'baseAmount') AND NOT (table_name = 'recovery_settlement_channel' AND column_name = 'amount')
    AND NOT (table_name = 'recovery_payment' AND column_name IN ('amount', 'principalAmount', 'surplusAmount')) AND NOT (table_name = 'recovery_surplus' AND column_name = 'amount')
    -- S6h-B: Payment's verified late success, a case's evidence amount, a FinancialLoss and its signed adjustment (CHECKed, guarded)
    AND NOT (table_name IN ('payment_late_success', 'reconciliation_case', 'financial_loss', 'financial_loss_adjustment') AND column_name = 'amount')), '8'); -- S6e-D: Payment's verified statements, as reported (CHECKed safe, positive)
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
-- Core V2 S4a (P-1): an Organization-paid ordinary invoice can no longer be issued (its routing record is refused), so the request guard is
-- exercised on an invoice moved to `open` inside the refused statement itself (rolled back with it, before any commit-time check)
SELECT pg_temp.expect_error('S4a', 'an Organization never pays an ordinary invoice: its non_entitlement routing record is refused (B2 narrowed, P-1)',
  format($$SELECT t_issue(%L::uuid)$$, :'org_payer_draft'), '23514', 'invoice_entitlement_non_entitlement_payer');
SELECT pg_temp.expect_error('BI-09', 'a payment request for an ORGANIZATION payer is refused until B-026 is decided (it could never be closed)', format($$
  UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}'::jsonb WHERE id = %L;
  INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType") SELECT id, total, currency, 'user' FROM invoice WHERE id = %L$$, :'org_payer_draft', :'org_payer_draft'), '23514');

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
SELECT pg_temp.expect_ok('BI-10', 'issuing with a caller-supplied number succeeds', format($$SELECT t_route(%L); UPDATE invoice SET status = 'open', number = '7777', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}' WHERE id = %L; SELECT t_hist('invoice', %L, 'draft', 'open', 1)$$, :'nx', :'nx', :'nx'));
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
SELECT pg_temp.expect_error('BI-15', 'a payment request mapping version cannot change', format($$UPDATE payment_request SET "mappingVersion" = 1 WHERE id = %L$$, :'o4_req'), '23514');
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
SELECT pg_temp.expect_error('CATALOG', 'a duplicate product code for one seller is refused', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name)
  SELECT producer, "sellerType", "sellerId", code, 'dup' FROM product WHERE id = %L$$, :'d1_product'), '23505', 'product_code_unique');
-- Stage 3 addition: the producer isolation column (SDD section 11, migration 0010), mirroring invoice.producer (BI-07 above).
SELECT pg_temp.expect_error('CATALOG', 'a product with no producer is refused', $$INSERT INTO product ("sellerType", "sellerId", code, name) VALUES ('organization', '00000000-0000-4000-8000-0000000000a1', 'no-producer', 'X')$$, '23502');
SELECT pg_temp.expect_error('CATALOG', 'a producer of the wrong shape is refused', $$INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('Not Valid!', 'organization', '00000000-0000-4000-8000-0000000000a1', 'bad-producer', 'X')$$, '23514', 'product_producer_shape');
SELECT pg_temp.expect_error('CATALOG', 'a product producer cannot be changed', format($$UPDATE product SET producer = 'someone-else' WHERE id = %L$$, :'d1_product'), '23514');
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
-- V2 A3M.3 (finding G11, migration 0016): only an APPLIED receipt claims an event id. A second applied receipt for one event id is refused
-- by the applied-only unique index; ignored, deferred and conflict receipts for that id are all recorded and claim nothing, and an
-- applied receipt may still follow them (exactly once). Fixed ids, used nowhere else; the receipt has no foreign key.
INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType") VALUES ('00000000-0000-4000-8000-0000000a3301', 'payment.succeeded', 'applied', 'payment_event');
SELECT pg_temp.expect_error('RECEIPT', 'one applied receipt per event: a second applied receipt for the same event id is refused', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType")
  VALUES ('00000000-0000-4000-8000-0000000a3301', 'payment.succeeded', 'applied', 'payment_event')$$, '23505', 'payment_event_receipt_applied_event_unique');
SELECT pg_temp.expect_ok('RECEIPT', 'a non-applied receipt claims nothing: ignored, deferred and conflict receipts for one event id are all recorded', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType")
  VALUES ('00000000-0000-4000-8000-0000000a3302', 'payment.succeeded', 'ignored', 'payment_event'),
         ('00000000-0000-4000-8000-0000000a3302', 'payment.succeeded', 'deferred', 'payment_event'),
         ('00000000-0000-4000-8000-0000000a3302', 'payment.succeeded', 'conflict', 'payment_event')$$);
SELECT pg_temp.expect_ok('RECEIPT', 'an applied receipt may follow non-applied receipts of the same event id', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType")
  VALUES ('00000000-0000-4000-8000-0000000a3302', 'payment.succeeded', 'applied', 'payment_event')$$);
SELECT pg_temp.expect_error('RECEIPT', 'once applied after non-applied receipts, a second applied receipt for that event id is refused', $$INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType")
  VALUES ('00000000-0000-4000-8000-0000000a3302', 'payment.succeeded', 'applied', 'payment_event')$$, '23505', 'payment_event_receipt_applied_event_unique');
SELECT pg_temp.expect_ok('RECEIPT', 'a `deferred` receipt is recorded with no paymentId bound', $$INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", outcome, "causeType") VALUES (gen_random_uuid(), 'payment.succeeded', gen_random_uuid(), 'deferred', 'payment_event')$$);
SELECT pg_temp.expect_error('IDEMPOTENCY', 'the same (producer, invoiceRequestId) twice is refused at the database', format($$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId",
  "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
  SELECT producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot" FROM invoice WHERE id = %L$$, :'d1'), '23505', 'invoice_request_unique');

-- =================================================================================================================== CURRENCY (three layers)
-- Global reference (currency) / Platform configuration (platform_currency) / historical invoice currency (invoice, invoice_line).
SELECT pg_temp.expect_ok('CURRENCY', 'a platform can enable a currency that exists globally', $$INSERT INTO platform_currency ("platformId", currency) VALUES ('platform-1', 'TND')$$);
SELECT pg_temp.expect_error('CURRENCY', 'a platform cannot enable an UNKNOWN currency', $$INSERT INTO platform_currency ("platformId", currency) VALUES ('platform-1', 'XXX')$$, '23503', 'platform_currency_currency_fkey');
SELECT pg_temp.expect_error('CURRENCY', 'a currency is configured once per platform', $$INSERT INTO platform_currency ("platformId", currency) VALUES ('platform-1', 'TND')$$, '23505', 'platform_currency_pkey');
SELECT pg_temp.expect_error('CURRENCY', 'an empty platform id is refused', $$INSERT INTO platform_currency ("platformId", currency) VALUES ('', 'TND')$$, '23514', 'platform_currency_platform_id_shape');
SELECT pg_temp.expect_error('CURRENCY', 'a blank platform id is refused', $$INSERT INTO platform_currency ("platformId", currency) VALUES ('   ', 'TND')$$, '23514', 'platform_currency_platform_id_shape');
SELECT pg_temp.expect_error('CURRENCY', 'a 129-character platform id is refused', $$INSERT INTO platform_currency ("platformId", currency) VALUES (repeat('p', 129), 'TND')$$, '23514', 'platform_currency_platform_id_shape');
SELECT pg_temp.expect_error('CURRENCY', 'a platform currency is created at revision 0', $$INSERT INTO platform_currency ("platformId", currency, revision) VALUES ('platform-2', 'TND', 5)$$, '23514');
SELECT pg_temp.assert_eq('CURRENCY', 'the platform is an OPAQUE reference: no foreign key leaves this table except the currency reference',
  (SELECT string_agg(confrelid::regclass::text, ',' ORDER BY confrelid::regclass::text) FROM pg_constraint WHERE conrelid = 'platform_currency'::regclass AND contype = 'f'), 'currency');
SELECT pg_temp.assert_eq('CURRENCY', 'global currency metadata cannot be reached through platform configuration: it has no exponent column',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'platform_currency' AND column_name ~* 'expon|decimal|scale|precision'), '0');
SELECT pg_temp.assert_eq('CURRENCY', 'no financial table references platform configuration, so configuration cannot reach a historical record',
  (SELECT count(*)::text FROM pg_constraint WHERE contype = 'f' AND confrelid = 'platform_currency'::regclass), '0');

SELECT pg_temp.assert_eq('CURRENCY', 'permitted: enabled for the platform', billing_currency_permitted('platform-1', 'TND')::text, 'true');
SELECT pg_temp.assert_eq('CURRENCY', 'not permitted: no configuration for another platform', billing_currency_permitted('platform-other', 'TND')::text, 'false');
SELECT pg_temp.assert_eq('CURRENCY', 'not permitted: a currency the platform never enabled', billing_currency_permitted('platform-1', 'EUR')::text, 'false');
SELECT pg_temp.assert_eq('CURRENCY', 'not permitted: an unknown currency', billing_currency_permitted('platform-1', 'XXX')::text, 'false');

SELECT pg_temp.expect_error('CURRENCY', 'a platform currency cannot be re-pointed to another currency', $$UPDATE platform_currency SET currency = 'TND', "platformId" = 'platform-9' WHERE "platformId" = 'platform-1'$$, '23514');
SELECT pg_temp.expect_error('CURRENCY', 'a platform currency cannot be moved to another platform', $$UPDATE platform_currency SET "platformId" = 'platform-9' WHERE "platformId" = 'platform-1'$$, '23514');
SELECT pg_temp.expect_error('CURRENCY', 'creation time cannot be rewritten', $$UPDATE platform_currency SET "createdAt" = now() - interval '1 year' WHERE "platformId" = 'platform-1'$$, '23514');
SELECT pg_temp.expect_error('CURRENCY', 'a platform currency is never deleted (it is disabled)', $$DELETE FROM platform_currency$$, '23514');
SELECT pg_temp.expect_error('CURRENCY', 'the global exponent cannot be changed', $$UPDATE currency SET exponent = 2 WHERE code = 'TND'$$, '23514');
SELECT pg_temp.expect_error('CURRENCY', 'a globally referenced currency cannot be deleted', $$DELETE FROM currency WHERE code = 'TND'$$, '23514');

-- disabling: a flag on a row, with a revision; caller-supplied revision and timestamps are overwritten
SELECT pg_temp.expect_ok('CURRENCY', 'a platform can disable a currency for future use', $$UPDATE platform_currency SET enabled = false, revision = 99, "updatedAt" = '2001-01-01' WHERE "platformId" = 'platform-1' AND currency = 'TND'$$);
SELECT pg_temp.assert_eq('CURRENCY', 'a disabled currency is not permitted for new billing operations', billing_currency_permitted('platform-1', 'TND')::text, 'false');
SELECT pg_temp.assert_eq('CURRENCY', 'disabling advanced the revision by exactly one; a supplied revision is ignored',
  (SELECT revision::text FROM platform_currency WHERE "platformId" = 'platform-1' AND currency = 'TND'), '1');
UPDATE platform_currency SET enabled = false WHERE "platformId" = 'platform-1' AND currency = 'TND';
SELECT pg_temp.assert_eq('CURRENCY', 'a no-op update changes neither the revision nor the update time',
  (SELECT revision::text FROM platform_currency WHERE "platformId" = 'platform-1' AND currency = 'TND'), '1');
UPDATE platform_currency SET enabled = true WHERE "platformId" = 'platform-1' AND currency = 'TND';
SELECT pg_temp.assert_eq('CURRENCY', 'a platform can re-enable a disabled currency', billing_currency_permitted('platform-1', 'TND')::text, 'true');
SELECT pg_temp.assert_eq('CURRENCY', 're-enabling advanced the revision', (SELECT revision::text FROM platform_currency WHERE "platformId" = 'platform-1' AND currency = 'TND'), '2');

-- historical invoices: configuration controls FUTURE operations and never a historical record
CREATE TEMP TABLE hist AS
  SELECT i.id, i.currency, i.subtotal, i."taxTotal", i.total, i.status, i.number, i.revision, i."issuedAt",
         (SELECT string_agg(l."lineNumber" || ':' || l.currency || ':' || l."unitAmount" || ':' || l."lineTotal", ',' ORDER BY l."lineNumber") FROM invoice_line l WHERE l."invoiceId" = i.id) AS lines,
         (SELECT c.exponent FROM currency c WHERE c.code = i.currency) AS exponent
    FROM invoice i WHERE i.status = 'open' AND i.currency = 'TND' LIMIT 1;
SELECT pg_temp.assert_eq('CURRENCY', '(fixture) a historical open TND invoice exists', (SELECT count(*)::text FROM hist), '1');
UPDATE platform_currency SET enabled = false WHERE "platformId" = 'platform-1' AND currency = 'TND';
SELECT pg_temp.assert_eq('CURRENCY', 'disabling the platform currency leaves every historical invoice and line exactly as it was',
  (SELECT count(*)::text FROM hist h JOIN invoice i ON i.id = h.id
     WHERE i.currency = h.currency AND i.subtotal = h.subtotal AND i."taxTotal" = h."taxTotal" AND i.total = h.total AND i.status = h.status
       AND i.number IS NOT DISTINCT FROM h.number AND i.revision = h.revision AND i."issuedAt" IS NOT DISTINCT FROM h."issuedAt"
       AND (SELECT string_agg(l."lineNumber" || ':' || l.currency || ':' || l."unitAmount" || ':' || l."lineTotal", ',' ORDER BY l."lineNumber") FROM invoice_line l WHERE l."invoiceId" = i.id) = h.lines), '1');
SELECT pg_temp.assert_eq('CURRENCY', 'a historical invoice still resolves its currency and exponent from the global reference after the platform disabled it',
  (SELECT c.exponent::text FROM invoice i JOIN currency c ON c.code = i.currency JOIN hist h ON h.id = i.id), (SELECT exponent::text FROM hist));
SELECT pg_temp.assert_eq('CURRENCY', 'the exponent an invoice sees is the immutable reference value (TND has three decimals)', (SELECT exponent::text FROM hist), '3');
SELECT pg_temp.expect_error('CURRENCY', 'an invoice currency cannot be changed after creation, whatever the platform configuration says', format($$UPDATE invoice SET currency = 'TND' , subtotal = subtotal + 1 WHERE id = %L$$, (SELECT id FROM hist)), '23514');
SELECT pg_temp.expect_error('CURRENCY', 'an invoice cannot be created in an unknown currency', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
  VALUES ('billing-test', gen_random_uuid(), repeat('a', 64), 'company', 'c1', 'user', 'u1', 'contract', 's', 'XXX', 1, 1, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23503');

-- =================================================================================================================== SUB (Stage 12.2)
-- Creation shape: born pending, with no lifecycle data, and only against a recurring, non-retired price of its own product.
SELECT pg_temp.expect_error('SUB', 'cannot be created with a period already set', format($$INSERT INTO subscription ("organizationId", "productId", "priceId", "currentPeriodStart")
  SELECT gen_random_uuid(), "productId", id, now() FROM price WHERE id = %L$$, t_mk_recurring_price()), '23514');
SELECT pg_temp.expect_error('SUB', 'cannot be created already active', format($$INSERT INTO subscription ("organizationId", "productId", "priceId", status)
  SELECT gen_random_uuid(), "productId", id, 'active' FROM price WHERE id = %L$$, t_mk_recurring_price()), '23514');
SELECT t_mk_price(1000) AS one_time_price \gset
SELECT pg_temp.expect_error('SUB', 'cannot reference a one-time price: a subscription always needs a recurring interval', format($$INSERT INTO subscription ("organizationId", "productId", "priceId")
  SELECT gen_random_uuid(), "productId", id FROM price WHERE id = %L$$, :'one_time_price'), '23514');
SELECT t_mk_recurring_price() AS retiring_price \gset
UPDATE price SET "retiredAt" = now() WHERE id = :'retiring_price';
SELECT pg_temp.expect_error('SUB', 'cannot be created against a retired price', format($$INSERT INTO subscription ("organizationId", "productId", "priceId")
  SELECT gen_random_uuid(), "productId", id FROM price WHERE id = %L$$, :'retiring_price'), '23514');
SELECT t_mk_subscription() AS ok_created \gset
SELECT pg_temp.assert_eq('SUB', 'created pending, against a recurring price, with a default-false cancellation flag', (SELECT "cancelAtPeriodEnd"::text FROM subscription WHERE id = :'ok_created'), 'false');

-- one current subscription per Organization (a plain UNIQUE, not a partial index: section 13 — this row IS the current state)
SELECT '00000000-0000-4000-8000-0000000000b1'::uuid AS sub_org \gset
SELECT t_mk_subscription(:'sub_org') AS first_sub \gset
SELECT pg_temp.expect_error('SUB', 'a second subscription for the SAME organization is refused', format($$INSERT INTO subscription ("organizationId", "productId", "priceId")
  SELECT %L, "productId", id FROM price WHERE id = %L$$, :'sub_org', t_mk_recurring_price()), '23505', 'subscription_organization_unique');
SELECT pg_temp.expect_ok('SUB', 'a DIFFERENT organization can hold its own subscription against the very same price', format($$
  WITH ins AS (INSERT INTO subscription ("organizationId", "productId", "priceId")
    SELECT gen_random_uuid(), "productId", "priceId" FROM subscription WHERE id = %L RETURNING id, revision)
  SELECT t_hist('subscription', id, NULL, 'pending', revision) FROM ins$$, :'first_sub'));

-- product/price integrity: the composite FK refuses a price that does not belong to the given product
SELECT t_mk_recurring_price() AS mismatched_price \gset
SELECT pg_temp.expect_error('SUB', 'the priceId must belong to the productId (composite FK, mirrors invoice''s own pattern)', format($$INSERT INTO subscription ("organizationId", "productId", "priceId")
  VALUES (gen_random_uuid(), gen_random_uuid(), %L)$$, :'mismatched_price'), '23503');

-- lifecycle: activation, period order, grace, termination
SELECT t_mk_subscription() AS pend \gset
SELECT pg_temp.expect_error('SUB', 'activation refuses currentPeriodEnd <= currentPeriodStart', format($$UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-01-01', "graceUntil" = '2026-01-01'::timestamptz + interval '24 hours', "billingAnchorAt" = '2026-01-01' WHERE id = %L$$, :'pend'), '23514', 'subscription_period_order');
SELECT pg_temp.expect_error('SUB', 'activation refuses currentPeriodEnd < currentPeriodStart', format($$UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-02', "currentPeriodEnd" = '2026-01-01', "graceUntil" = '2026-01-01'::timestamptz + interval '24 hours', "billingAnchorAt" = '2026-01-02' WHERE id = %L$$, :'pend'), '23514', 'subscription_period_order');
SELECT pg_temp.expect_error('SUB', 'a status cannot move straight from pending to grace', format($$UPDATE subscription SET status = 'grace', "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01', "graceUntil" = '2026-02-08', "billingAnchorAt" = '2026-01-01' WHERE id = %L$$, :'pend'), '23514');
SELECT pg_temp.expect_error('SUB', 'a status cannot move straight from pending to expired', format($$UPDATE subscription SET status = 'expired', "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01', "billingAnchorAt" = '2026-01-01' WHERE id = %L$$, :'pend'), '23514');
-- Success-path UPDATEs pair the mutation with its history row in ONE multi-statement EXECUTE (mirrors line ~320's own
-- "UPDATE ...; SET CONSTRAINTS ALL IMMEDIATE" pattern): every subscription mutation needs a matching `billing_transition`
-- row at COMMIT (BI-19, deferred), so a bare UPDATE with no paired history insert would abort this whole script at the
-- statement's own commit, outside any handler here — never something `expect_ok`/`expect_error` could turn into a clean result.
SELECT pg_temp.expect_ok('SUB', 'pending -> active with a valid period', format($$
  SELECT t_settle(%L, '2026-01-01');
  UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01', "graceUntil" = '2026-02-01'::timestamptz + interval '24 hours', "billingAnchorAt" = '2026-01-01' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'pending', 'active', (SELECT revision FROM subscription WHERE id = %L))$$, :'pend', :'pend', :'pend', :'pend'));
SELECT pg_temp.assert_eq('SUB', 'activation advanced the revision to 1', (SELECT revision::text FROM subscription WHERE id = :'pend'), '1');
SELECT pg_temp.expect_error('SUB', 'a self-loop is refused for any status OTHER than active (no in-place change while pending/grace/expired)',
  format($$UPDATE subscription SET "cancelAtPeriodEnd" = false WHERE id = %L$$, t_mk_subscription()), '23514');

SELECT pg_temp.expect_error('SUB', 'graceUntil at or before currentPeriodEnd is refused', format($$UPDATE subscription SET status = 'grace', "graceUntil" = '2026-02-01' WHERE id = %L$$, :'pend'), '23514', 'subscription_grace_after_period');
SELECT pg_temp.expect_error('SUB', 'graceUntil before currentPeriodEnd is refused', format($$UPDATE subscription SET status = 'grace', "graceUntil" = '2026-01-15' WHERE id = %L$$, :'pend'), '23514', 'subscription_grace_after_period');
SELECT pg_temp.expect_error('SUB', 'active -> grace cannot widen the grace (S3e: exactly 24 hours)', format($$UPDATE subscription SET status = 'grace', "graceUntil" = '2026-02-08' WHERE id = %L$$, :'pend'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_ok('SUB', 'active -> grace keeps the period''s fixed grace (only the label changes)', format($$
  UPDATE subscription SET status = 'grace' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'grace', (SELECT revision FROM subscription WHERE id = %L))$$, :'pend', :'pend', :'pend'));
SELECT pg_temp.expect_error('SUB', 'grace cannot re-extend itself: grace -> grace is not an allowed move (never keep extending a grace window)',
  format($$UPDATE subscription SET "graceUntil" = '2026-02-20' WHERE id = %L$$, :'pend'), '23514');
SELECT pg_temp.expect_error('SUB', 'grace -> active cannot drop the grace (S3e)', format($$UPDATE subscription SET status = 'active', "graceUntil" = NULL WHERE id = %L$$, :'pend'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_ok('SUB', 'grace -> active with the period unchanged keeps the fixed grace (S3e: no longer cleared)', format($$
  UPDATE subscription SET status = 'active' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'grace', 'active', (SELECT revision FROM subscription WHERE id = %L))$$, :'pend', :'pend', :'pend'));
SELECT pg_temp.assert_eq('SUB', 'the grace is still exactly 24 hours after the period end', (SELECT ("graceUntil" = "currentPeriodEnd" + interval '24 hours')::text FROM subscription WHERE id = :'pend'), 'true');

SELECT pg_temp.expect_ok('SUB', 'active -> expired (natural expiry, no effectiveTerminationAt)', format($$
  UPDATE subscription SET status = 'expired' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'expired', (SELECT revision FROM subscription WHERE id = %L))$$, :'pend', :'pend', :'pend'));
SELECT pg_temp.assert_eq('SUB', 'a naturally expired subscription has no effectiveTerminationAt', (SELECT "effectiveTerminationAt"::text FROM subscription WHERE id = :'pend'), NULL);
SELECT pg_temp.expect_ok('SUB', 'expired -> active: a late renewal can always reactivate', format($$
  SELECT t_settle(%L, '2026-03-01');
  UPDATE subscription SET status = 'active', "currentPeriodStart" = '2026-03-01', "currentPeriodEnd" = '2026-04-01', "graceUntil" = '2026-04-01'::timestamptz + interval '24 hours', "billingAnchorAt" = '2026-03-01' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'expired', 'active', (SELECT revision FROM subscription WHERE id = %L))$$, :'pend', :'pend', :'pend', :'pend'));

-- effective termination: may only SHORTEN access, and never survives past its own `expired` episode (a later
-- reactivation clears it — see the migration comment on why no separate "set once" check is needed)
SELECT t_mk_active_subscription('2026-06-01'::timestamptz) AS term_sub \gset
SELECT pg_temp.expect_error('SUB', 'effectiveTerminationAt after the access boundary (the period end plus its 24-hour grace) would EXTEND access: refused', format($$UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = "graceUntil" + interval '1 millisecond' WHERE id = %L$$, :'term_sub'), '23514', 'subscription_termination_shape');
SELECT pg_temp.expect_ok('SUB', 'effectiveTerminationAt at or before currentPeriodEnd shortens access: accepted', format($$
  UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = '2026-05-15' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'expired', (SELECT revision FROM subscription WHERE id = %L))$$, :'term_sub', :'term_sub', :'term_sub'));
SELECT pg_temp.expect_error('SUB', 'an already-expired subscription accepts no in-place change at all, so its effectiveTerminationAt cannot be revised either',
  format($$UPDATE subscription SET "effectiveTerminationAt" = '2026-05-16' WHERE id = %L$$, :'term_sub'), '23514');

-- a rolled-forward period always starts uncancelled, even if the caller tries to keep cancelAtPeriodEnd set
SELECT t_mk_active_subscription('2026-07-01'::timestamptz) AS cancel_sub \gset
SELECT pg_temp.assert_eq('SUB', '(fixture) cancelAtPeriodEnd defaults to false', (SELECT "cancelAtPeriodEnd"::text FROM subscription WHERE id = :'cancel_sub'), 'false');
SELECT t_set_cancel(:'cancel_sub', true);
SELECT pg_temp.assert_eq('SUB', 'cancelAtPeriodEnd can be scheduled while active (an active->active self-loop, auditable)', (SELECT "cancelAtPeriodEnd"::text FROM subscription WHERE id = :'cancel_sub'), 'true');
SELECT t_set_period_end(:'cancel_sub', '2026-08-01', true);
SELECT pg_temp.assert_eq('SUB', 'a period change (renewal) force-clears cancelAtPeriodEnd, even though the statement tried to set it true', (SELECT "cancelAtPeriodEnd"::text FROM subscription WHERE id = :'cancel_sub'), 'false');

-- BI-19 for subscription: every mutation (not only a status change) needs its history row, checked at COMMIT
SELECT pg_temp.expect_error('SUB', 'a mutation with no matching history row cannot commit (BI-19)',
  format($$UPDATE subscription SET "cancelAtPeriodEnd" = true WHERE id = %L; SET CONSTRAINTS ALL IMMEDIATE$$, t_mk_active_subscription()), '23514');

-- immutability: organizationId/productId/priceId/createdAt never change
SELECT pg_temp.expect_error('SUB', 'organizationId is immutable', format($$UPDATE subscription SET "organizationId" = gen_random_uuid() WHERE id = %L$$, t_mk_active_subscription()), '23514');
SELECT pg_temp.expect_error('SUB', 'productId is immutable (no plan-change operation exists yet)', format($$UPDATE subscription SET "productId" = gen_random_uuid() WHERE id = %L$$, t_mk_active_subscription()), '23514');
SELECT pg_temp.expect_error('SUB', 'a subscription is never deleted', format($$DELETE FROM subscription WHERE id = %L$$, t_mk_active_subscription()), '23514');

-- renewal (the database half, mirroring SubscriptionRepository.renew exactly): the frozen anchor rule
SELECT t_mk_active_subscription('2026-11-01T00:00:00Z'::timestamptz) AS early_sub \gset
SELECT t_try_renew(:'early_sub');
-- compared as VALUES, not text: the session's display timezone (not necessarily UTC) would otherwise show a different offset
SELECT pg_temp.assert_eq('SUB', 'early renewal anchors on the ORIGINAL currentPeriodEnd', (SELECT ("currentPeriodStart" = '2026-11-01T00:00:00Z'::timestamptz)::text FROM subscription WHERE id = :'early_sub'), 'true');
SELECT pg_temp.assert_eq('SUB', 'early renewal extends by exactly one recurring interval', (SELECT ("currentPeriodEnd" = '2026-12-01T00:00:00Z'::timestamptz)::text FROM subscription WHERE id = :'early_sub'), 'true');
SELECT pg_temp.assert_eq('SUB', 'the renewal is its own auditable revision', (SELECT revision::text FROM subscription WHERE id = :'early_sub'), '2');

-- billing anchor (0015, ADR-0044 B-025): a month/year cadence keeps its anchor; a short month clamps only that period end
CREATE FUNCTION pg_temp.ends(sub uuid) RETURNS text LANGUAGE sql AS $$
  SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' anchor ' || coalesce(to_char("billingAnchorAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), 'none')
    FROM subscription WHERE id = sub $$;
-- `n` early renewals (each settled well before the period it extends ends), returning every resulting period end
CREATE FUNCTION pg_temp.renew_early(sub uuid, n int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE out text := ''; i int;
BEGIN
  FOR i IN 1..n LOOP
    PERFORM t_try_renew(sub, (SELECT "currentPeriodStart" FROM subscription WHERE id = sub));
    out := out || CASE WHEN i > 1 THEN ' ' ELSE '' END || (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = sub);
  END LOOP;
  RETURN out;
END $$;

SELECT t_mk_anchored_subscription('month', 1, '2027-01-31T09:30:00Z') AS a31 \gset
SELECT pg_temp.assert_eq('ANCHOR', 'first activation on Jan 31 2027: the period ends Feb 28 (clamped), the anchor stays Jan 31', pg_temp.ends(:'a31'), '2027-02-28 09:30 anchor 2027-01-31 09:30');
SELECT pg_temp.assert_eq('ANCHOR', 'Jan 31 anchor: Feb 28 -> Mar 31 (recovered) -> Apr 30 -> May 31 -> Jun 30 -> Jul 31 -> Aug 31', pg_temp.renew_early(:'a31', 6), '03-31 04-30 05-31 06-30 07-31 08-31');
SELECT pg_temp.assert_eq('ANCHOR', 'six early renewals never move the Jan 31 anchor', pg_temp.ends(:'a31'), '2027-08-31 09:30 anchor 2027-01-31 09:30');

SELECT t_mk_anchored_subscription('month', 1, '2027-01-28T09:30:00Z') AS a28 \gset
SELECT pg_temp.assert_eq('ANCHOR', 'Jan 28 anchor: Feb 28 -> Mar 28 -> Apr 28 (a genuine 28th stays the 28th)', pg_temp.renew_early(:'a28', 2), '03-28 04-28');
SELECT t_mk_anchored_subscription('month', 1, '2027-01-29T09:30:00Z') AS a29 \gset
SELECT pg_temp.assert_eq('ANCHOR', 'Jan 29 2027 anchor: Feb 28 (clamped) -> Mar 29 -> Apr 29', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'a29') || ' ' || pg_temp.renew_early(:'a29', 2), '02-28 03-29 04-29');
SELECT t_mk_anchored_subscription('month', 1, '2027-01-30T09:30:00Z') AS a30 \gset
SELECT pg_temp.assert_eq('ANCHOR', 'Jan 30 2027 anchor: Feb 28 (clamped) -> Mar 30 -> Apr 30', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'a30') || ' ' || pg_temp.renew_early(:'a30', 2), '02-28 03-30 04-30');
SELECT t_mk_anchored_subscription('month', 1, '2028-01-31T09:30:00Z') AS aleap \gset
SELECT pg_temp.assert_eq('ANCHOR', 'Jan 31 2028 (leap year) anchor: Feb 29 -> Mar 31', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'aleap') || ' ' || pg_temp.renew_early(:'aleap', 1), '02-29 03-31');
SELECT t_mk_anchored_subscription('month', 1, '2026-08-31T09:30:00Z') AS aaug \gset
SELECT pg_temp.assert_eq('ANCHOR', 'Aug 31 anchor across 30-day months: Sep 30 -> Oct 31 -> Nov 30 -> Dec 31', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'aaug') || ' ' || pg_temp.renew_early(:'aaug', 3), '09-30 10-31 11-30 12-31');

SELECT t_mk_anchored_subscription('month', 2, '2027-01-31T09:30:00Z') AS a2m \gset
SELECT pg_temp.assert_eq('ANCHOR', 'every 2 months from Jan 31 2027: Mar 31 -> May 31 -> Jul 31 -> Sep 30 -> Nov 30 -> Jan 31 2028', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'a2m') || ' ' || pg_temp.renew_early(:'a2m', 4), '03-31 05-31 07-31 09-30 11-30');
SELECT pg_temp.renew_early(:'a2m', 1);
SELECT pg_temp.assert_eq('ANCHOR', 'every 2 months: the 31st survives two 30-day clamps', pg_temp.ends(:'a2m'), '2028-01-31 09:30 anchor 2027-01-31 09:30');

SELECT t_mk_anchored_subscription('year', 1, '2028-02-29T09:30:00Z') AS aly \gset
SELECT pg_temp.assert_eq('ANCHOR', 'yearly from Feb 29 2028: Feb 28 2029 -> Feb 28 2030 -> Feb 28 2031 -> Feb 29 2032',
  (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM subscription WHERE id = :'aly') || ' ' || pg_temp.renew_early(:'aly', 3), '2029-02-28 02-28 02-28 02-29');
SELECT pg_temp.assert_eq('ANCHOR', 'the yearly Feb 29 anchor is kept through the clamped years', pg_temp.ends(:'aly'), '2032-02-29 09:30 anchor 2028-02-29 09:30');

-- renewal modes, on the frozen renewal-anchor rule: exactly at the boundary is still on time; strictly after it is late
SELECT t_mk_anchored_subscription('month', 1, '2027-01-31T09:30:00Z') AS aedge \gset
SELECT t_try_renew(:'aedge', '2027-02-28T09:30:00Z');
SELECT pg_temp.assert_eq('ANCHOR', 'a renewal exactly at the period end is on time: starts at Feb 28, ends Mar 31, keeps the anchor', pg_temp.ends(:'aedge'), '2027-03-31 09:30 anchor 2027-01-31 09:30');
SELECT t_mk_anchored_subscription('month', 1, '2027-01-31T09:30:00Z') AS alate \gset
SELECT t_try_renew(:'alate', '2027-04-12T15:00:00Z');
SELECT pg_temp.assert_eq('ANCHOR', 'a genuinely late renewal (Apr 12, past Feb 28, no grace) starts at the settlement and RESETS the anchor to it', pg_temp.ends(:'alate'), '2027-05-12 15:00 anchor 2027-04-12 15:00');
SELECT pg_temp.assert_eq('ANCHOR', 'after the reset the new cadence holds: May 12 -> Jun 12 -> Jul 12', pg_temp.renew_early(:'alate', 2), '06-12 07-12');

SELECT t_mk_anchored_subscription('week', 2, '2027-01-31T09:30:00Z') AS awk \gset
SELECT pg_temp.assert_eq('ANCHOR', 'a 2-week price has no billing anchor and keeps start + interval: Feb 14 -> Feb 28 -> Mar 14', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'awk') || ' ' || pg_temp.renew_early(:'awk', 2) || ' ' || pg_temp.ends(:'awk'), '02-14 02-28 03-14 2027-03-14 09:30 anchor none');
SELECT t_mk_anchored_subscription('day', 10, '2027-01-31T09:30:00Z') AS aday \gset
SELECT pg_temp.assert_eq('ANCHOR', 'a 10-day price has no billing anchor and keeps start + interval: Feb 10 -> Feb 20 -> Mar 2', (SELECT to_char("currentPeriodEnd" AT TIME ZONE 'UTC', 'MM-DD') FROM subscription WHERE id = :'aday') || ' ' || pg_temp.renew_early(:'aday', 2), '02-10 02-20 03-02');

-- the guard: the anchor exists exactly for non-pending month/year rows, and moves only as the start of a new period
SELECT pg_temp.expect_error('ANCHOR', 'a pending subscription has no billing anchor', format($$INSERT INTO subscription ("organizationId", "productId", "priceId", "billingAnchorAt")
  SELECT gen_random_uuid(), "productId", id, now() FROM price WHERE id = %L$$, t_mk_recurring_price()), '23514', 'subscription_pending_no_billing_anchor');
SELECT pg_temp.expect_error('ANCHOR', 'a month subscription cannot be activated without its billing anchor',
  format($$UPDATE subscription SET status = 'active', "currentPeriodStart" = '2027-01-01', "currentPeriodEnd" = '2027-02-01' WHERE id = %L$$, t_mk_subscription()), '23514');
SELECT pg_temp.expect_error('ANCHOR', 'a week subscription cannot carry a billing anchor',
  format($$UPDATE subscription SET "currentPeriodStart" = '2027-03-01', "currentPeriodEnd" = '2027-03-15', "billingAnchorAt" = '2027-03-01' WHERE id = %L$$, :'awk'), '23514');
SELECT pg_temp.expect_error('ANCHOR', 'the anchor cannot move without a new period (a clamp never rewrites it)',
  format($$UPDATE subscription SET "billingAnchorAt" = '2027-02-28T09:30:00Z' WHERE id = %L$$, :'a31'), '23514');
SELECT pg_temp.expect_error('ANCHOR', 'a new period cannot set the anchor to anything but its own start',
  format($$UPDATE subscription SET "currentPeriodStart" = '2027-08-31T09:30:00Z', "currentPeriodEnd" = '2027-09-30T09:30:00Z', "billingAnchorAt" = '2027-02-28T09:30:00Z' WHERE id = %L$$, :'a31'), '23514');
SELECT pg_temp.expect_error('ANCHOR', 'a month subscription cannot drop its anchor',
  format($$UPDATE subscription SET "billingAnchorAt" = NULL WHERE id = %L$$, :'a31'), '23514');

-- ======================================================================================== Core V2 S3b: DB-9, DB-10, DB-11
SELECT t_mk_active_subscription('2030-01-31T09:30:00Z') AS s3b \gset
SELECT pg_temp.expect_error('DB-11', 'a period extension with no settlement in its transaction cannot commit',
  format($$UPDATE subscription SET "currentPeriodStart" = "currentPeriodEnd", "currentPeriodEnd" = "currentPeriodEnd" + interval '1 month', "graceUntil" = "currentPeriodEnd" + interval '1 month 24 hours' WHERE id = %L;
          SELECT t_hist('subscription', %L, 'active', 'active', (SELECT revision FROM subscription WHERE id = %L)); SET CONSTRAINTS ALL IMMEDIATE$$, :'s3b', :'s3b', :'s3b'), '23514', 'subscription_period_settled');
SELECT t_mk_subscription() AS s3b_pend \gset
SELECT pg_temp.expect_error('DB-11', 'a NEW period start (an activation) with no settlement cannot commit',
  format($$UPDATE subscription SET status = 'active', "currentPeriodStart" = '2031-01-01', "currentPeriodEnd" = '2031-02-01', "graceUntil" = '2031-02-01'::timestamptz + interval '24 hours', "billingAnchorAt" = '2031-01-01' WHERE id = %L;
          SELECT t_hist('subscription', %L, 'pending', 'active', 1); SET CONSTRAINTS ALL IMMEDIATE$$, :'s3b_pend', :'s3b_pend'), '23514', 'subscription_period_settled');
SELECT pg_temp.expect_ok('DB-11', 'shortening (termination) or a status change needs no settlement', format($$
  UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = least(now(), "currentPeriodEnd") WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'expired', (SELECT revision FROM subscription WHERE id = %L)); SET CONSTRAINTS ALL IMMEDIATE$$, :'s3b', :'s3b', :'s3b'));
SELECT "invoiceId" AS s3b_inv, "receiptId" AS s3b_rcpt, "paymentRequestId" AS s3b_req, "subscriptionId" AS s3b_sub, "organizationId" AS s3b_org, "productId" AS s3b_prod
  FROM subscription_settlement WHERE "subscriptionId" = :'s3b' \gset
SELECT pg_temp.expect_error('DB-10', 'a second settlement of the same invoice is refused', format($$
  INSERT INTO subscription_settlement ("invoiceId", purpose, "organizationId", "productId", "subscriptionId", "paymentRequestId", "receiptId", "settledAt", "transactionId")
  VALUES (%L, 'organization_subscription', %L, %L, %L, %L, %L, now(), pg_current_xact_id())$$, :'s3b_inv', :'s3b_org', :'s3b_prod', :'s3b_sub', :'s3b_req', :'s3b_rcpt'), '23505');
SELECT * FROM t_paid_org_invoice(:'s3b') \gset fresh_
SELECT pg_temp.expect_error('DB-9', 'a settlement may only be of an organization_subscription purpose', format($$
  INSERT INTO subscription_settlement ("invoiceId", purpose, "organizationId", "productId", "subscriptionId", "paymentRequestId", "receiptId", "settledAt", "transactionId")
  VALUES (%L, 'direct_purchase', %L, %L, %L, %L, %L, now(), pg_current_xact_id())$$, :'fresh_iid', :'s3b_org', :'s3b_prod', :'s3b_sub', :'fresh_rid', :'fresh_rcpt'), '23514', 'subscription_settlement_purpose');
SELECT pg_temp.expect_error('DB-9', 'a settlement cannot name another Organization than its invoice was routed to', format($$
  INSERT INTO subscription_settlement ("invoiceId", purpose, "organizationId", "productId", "subscriptionId", "paymentRequestId", "receiptId", "settledAt", "transactionId")
  VALUES (%L, 'organization_subscription', gen_random_uuid(), %L, %L, %L, %L, now(), pg_current_xact_id())$$, :'fresh_iid', :'s3b_prod', :'s3b_sub', :'fresh_rid', :'fresh_rcpt'), '23503', 'subscription_settlement_routing_fk');
SELECT t_mk_paid() AS ne_inv \gset
SELECT t_receipt(:'ne_inv') AS ne_rcpt \gset
SELECT pg_temp.expect_error('DB-9', 'a verified settlement of a non_entitlement invoice can never be a subscription settlement (no organization_subscription routing)', format($$
  INSERT INTO subscription_settlement ("invoiceId", purpose, "organizationId", "productId", "subscriptionId", "paymentRequestId", "receiptId", "settledAt", "transactionId")
  VALUES (%L, 'organization_subscription', %L, %L, %L, (SELECT id FROM payment_request WHERE "invoiceId" = %L), %L, now(), pg_current_xact_id())$$,
  :'ne_inv', :'s3b_org', :'s3b_prod', :'s3b_sub', :'ne_inv', :'ne_rcpt'), '23503', 'subscription_settlement_routing_fk');
SELECT pg_temp.expect_error('S3b', 'a settlement without verified evidence (no applied receipt for its request) is refused', format($$
  INSERT INTO subscription_settlement ("invoiceId", purpose, "organizationId", "productId", "subscriptionId", "paymentRequestId", "receiptId", "settledAt", "transactionId")
  VALUES (%L, 'organization_subscription', %L, %L, %L, %L, %L, now(), pg_current_xact_id())$$, :'fresh_iid', :'s3b_org', :'s3b_prod', :'s3b_sub', :'fresh_rid', :'ne_rcpt'), '23514', 'subscription_settlement_verified');
SELECT pg_temp.expect_error('S3b', 'a settlement record is append-only', format($$UPDATE subscription_settlement SET "settledAt" = now() WHERE "invoiceId" = %L$$, :'s3b_inv'), '23514');
SELECT pg_temp.expect_error('S3b', 'a settlement record is never deleted', format($$DELETE FROM subscription_settlement WHERE "invoiceId" = %L$$, :'s3b_inv'), '23514');

-- ------------------------------------------------------------------------------------------------------------- S3d billing_platform (BIL-01)
-- A second currency exists in THIS scratch database only, so a mismatch can be expressed (the reference table is insert-only data).
INSERT INTO currency (code, exponent) VALUES ('EUR', 2) ON CONFLICT DO NOTHING;
\set s3d_p '00000000-0000-4000-8000-00000000d3d1'
\set s3d_free '00000000-0000-4000-8000-00000000d3d2'
\set s3d_legacy '00000000-0000-4000-8000-00000000d3d3'
INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy", "createdAt")
  VALUES (:'s3d_p', '00000000-0000-4000-8000-00000000c3d1', 'TND', '00000000-0000-4000-8000-00000000a3d1', '2000-01-01');
SELECT pg_temp.assert_eq('S3d', 'createdAt is the database clock, never a supplied value',
  (SELECT ("createdAt" > '2020-01-01')::text FROM billing_platform WHERE "platformId" = :'s3d_p'), 'true');
SELECT pg_temp.expect_error('S3d', 'one configuration per Platform', format($$INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy")
  VALUES (%L, gen_random_uuid(), 'TND', gen_random_uuid())$$, :'s3d_p'), '23505');
SELECT pg_temp.expect_error('S3d', 'the Company of a Platform is immutable', format($$UPDATE billing_platform SET "companyId" = gen_random_uuid() WHERE "platformId" = %L$$, :'s3d_p'), '23514');
SELECT pg_temp.expect_error('S3d', 'the currency of a Platform is immutable', format($$UPDATE billing_platform SET currency = 'EUR' WHERE "platformId" = %L$$, :'s3d_p'), '23514');
SELECT pg_temp.expect_error('S3d', 'a Platform configuration is never deleted', format($$DELETE FROM billing_platform WHERE "platformId" = %L$$, :'s3d_p'), '23514');
SELECT pg_temp.expect_error('S3d', 'a Platform configuration is never truncated', $$TRUNCATE billing_platform CASCADE$$, '23514');
SELECT pg_temp.expect_error('S3d', 'an unknown currency cannot be configured', format($$INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy")
  VALUES (%L, gen_random_uuid(), 'XXX', gen_random_uuid())$$, :'s3d_free'), '23503');
SELECT pg_temp.expect_error('S3d', 'a new organization subscription product needs its Platform configured', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-test', 'company', 'acme', 's3d-org', 'X', 'organization', %L)$$, :'s3d_free'), '23514', 'product_platform_configured');
SELECT pg_temp.expect_error('S3d', 'a new personal subscription product needs its Platform configured', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-test', 'company', 'acme', 's3d-pers', 'X', 'personal', %L)$$, :'s3d_free'), '23514', 'product_platform_configured');
SELECT pg_temp.expect_ok('S3d', 'an ordinary product needs no Platform configuration',
  $$INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('billing-test', 'company', 'acme', 's3d-none', 'X')$$);
INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-test', 'company', 'acme', 's3d-ok', 'X', 'personal', :'s3d_p') RETURNING id AS s3d_prod \gset
SELECT pg_temp.expect_error('S3d', 'a subscription price in another currency than its Platform''s is refused', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 's3d-eur', 'EUR', 100, 'recurring', 'month', 1)$$, :'s3d_prod'), '23514', 'price_platform_currency');
SELECT pg_temp.expect_ok('S3d', 'a subscription price in its Platform''s currency is accepted', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 's3d-tnd', 'TND', 100, 'recurring', 'month', 1)$$, :'s3d_prod'));
SELECT pg_temp.expect_ok('S3d', 'an ordinary product''s price is not bound to a Platform currency', $$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval")
  SELECT id, 's3d-none-eur', 'EUR', 100, 'one_time' FROM product WHERE code = 's3d-none'$$);
-- A subscription product created BEFORE S3d on a Platform that was never configured (simulated: the guard does not fire in replica mode)
-- keeps working as before, and is bound to the currency once its Platform is configured. Nothing is backfilled or rewritten.
SET session_replication_role = replica;
INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-test', 'company', 'acme', 's3d-legacy', 'X', 'personal', :'s3d_legacy') RETURNING id AS s3d_legacy_prod \gset
SET session_replication_role = DEFAULT;
SELECT pg_temp.expect_ok('S3d', 'a pre-S3d subscription product on an unconfigured Platform keeps its price behaviour', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 's3d-legacy-eur', 'EUR', 100, 'recurring', 'month', 1)$$, :'s3d_legacy_prod'));
INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES (:'s3d_legacy', gen_random_uuid(), 'TND', gen_random_uuid());
SELECT pg_temp.expect_error('S3d', 'once its Platform is configured, a pre-S3d subscription product''s new prices use that currency', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 's3d-legacy-eur-2', 'EUR', 100, 'recurring', 'month', 1)$$, :'s3d_legacy_prod'), '23514', 'price_platform_currency');
SELECT pg_temp.assert_eq('S3d', 'a configured Platform rewrites no existing price', (SELECT count(*)::text FROM price WHERE "productId" = :'s3d_legacy_prod' AND currency = 'EUR'), '1');

-- ------------------------------------------------------------------------------------------------------------- S3e fixed grace (B13)
-- Organization: exactly 24 hours after currentPeriodEnd, on the same row, whatever path writes it; Personal: none.
SELECT t_mk_active_subscription('2026-09-01T00:00:00Z'::timestamptz) AS g_sub \gset
SELECT pg_temp.assert_eq('S3e', 'an activation by settlement carries exactly 24 hours of grace',
  (SELECT extract(epoch FROM "graceUntil" - "currentPeriodEnd")::text FROM subscription WHERE id = :'g_sub'), '86400.000000');
SELECT pg_temp.expect_error('S3e', 'a wider grace (the V1 7 days) is refused', format($$UPDATE subscription SET "graceUntil" = "currentPeriodEnd" + interval '7 days' WHERE id = %L$$, :'g_sub'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_error('S3e', 'one millisecond less than 24 hours is refused', format($$UPDATE subscription SET "graceUntil" = "currentPeriodEnd" + interval '24 hours' - interval '1 millisecond' WHERE id = %L$$, :'g_sub'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_error('S3e', 'one millisecond more than 24 hours is refused', format($$UPDATE subscription SET "graceUntil" = "currentPeriodEnd" + interval '24 hours 1 millisecond' WHERE id = %L$$, :'g_sub'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_error('S3e', 'an established subscription cannot drop its grace (NULL)', format($$UPDATE subscription SET "graceUntil" = NULL WHERE id = %L$$, :'g_sub'), '23514', 'subscription_grace_fixed');
SELECT pg_temp.expect_error('S3e', 'a period moved by raw SQL with its grace is still refused without a settlement (DB-11 unchanged)', format($$
  UPDATE subscription SET "currentPeriodEnd" = "currentPeriodEnd" + interval '1 month', "graceUntil" = "currentPeriodEnd" + interval '1 month 24 hours' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'active', (SELECT revision FROM subscription WHERE id = %L)); SET CONSTRAINTS ALL IMMEDIATE$$, :'g_sub', :'g_sub', :'g_sub'), '23514', 'subscription_period_settled');
SELECT t_set_cancel(:'g_sub', true);
SELECT pg_temp.assert_eq('S3e', 'a cancellation toggle (active -> active, period unchanged) keeps the grace (V1 cleared it)',
  (SELECT ("graceUntil" = "currentPeriodEnd" + interval '24 hours')::text FROM subscription WHERE id = :'g_sub'), 'true');
SELECT count(*) AS g_settlements FROM subscription_settlement WHERE "subscriptionId" = :'g_sub' \gset
SELECT pg_temp.expect_ok('S3e', 'entering grace is a label change only', format($$
  UPDATE subscription SET status = 'grace' WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'grace', (SELECT revision FROM subscription WHERE id = %L)); SET CONSTRAINTS ALL IMMEDIATE$$, :'g_sub', :'g_sub', :'g_sub'));
SELECT pg_temp.assert_eq('S3e', 'grace records no settlement (no payment, no renewal)', (SELECT count(*)::text FROM subscription_settlement WHERE "subscriptionId" = :'g_sub'), :'g_settlements');
SELECT pg_temp.assert_eq('S3e', 'grace leaves the paid period as it was', (SELECT ("currentPeriodEnd" = '2026-09-01T00:00:00Z'::timestamptz)::text FROM subscription WHERE id = :'g_sub'), 'true');
SELECT pg_temp.expect_ok('S3e', 'a settled renewal during grace writes the next period with its own 24 hours', format($$SELECT t_try_renew(%L, '2026-09-01T12:00:00Z'); SET CONSTRAINTS ALL IMMEDIATE$$, :'g_sub'));
SELECT pg_temp.assert_eq('S3e', 'the renewal during grace anchors on the original period end and moves the grace with the period',
  (SELECT ("currentPeriodStart" = '2026-09-01T00:00:00Z'::timestamptz AND "graceUntil" = "currentPeriodEnd" + interval '24 hours')::text FROM subscription WHERE id = :'g_sub'), 'true');
SELECT pg_temp.expect_ok('S3e', 'termination during grace keeps the row consistent (expired, the grace unchanged, access cut by effectiveTerminationAt)', format($$
  UPDATE subscription SET status = 'expired', "effectiveTerminationAt" = "currentPeriodEnd" WHERE id = %L;
  SELECT t_hist('subscription', %L, 'active', 'expired', (SELECT revision FROM subscription WHERE id = %L)); SET CONSTRAINTS ALL IMMEDIATE$$, :'g_sub', :'g_sub', :'g_sub'));
-- Time zones: 24 hours is absolute. In New York, 2026-03-08 is a 23-hour day (DST starts): a "next day, same wall-clock time" grace is
-- only 23 hours and is refused; the exact 24 hours (13:00 the next day, local) is accepted. UTC throughout for the rest of the suite.
SET TimeZone = 'America/New_York';
SELECT t_mk_active_subscription('2026-03-07 12:00:00'::timestamptz) AS tz_sub \gset
SELECT pg_temp.assert_eq('S3e', 'across a DST change the stored grace is still exactly 24 hours of elapsed time',
  (SELECT (extract(epoch FROM "graceUntil" - "currentPeriodEnd") = 86400 AND "graceUntil" = '2026-03-08 13:00:00'::timestamptz)::text FROM subscription WHERE id = :'tz_sub'), 'true');
SELECT pg_temp.expect_error('S3e', 'a calendar "+1 day" across DST (23 hours) is refused', format($$UPDATE subscription SET "graceUntil" = '2026-03-08 12:00:00'::timestamptz WHERE id = %L$$, :'tz_sub'), '23514', 'subscription_grace_fixed');
RESET TimeZone;
SELECT pg_temp.assert_eq('S3e', 'every established subscription in this database satisfies the fixed grace',
  (SELECT count(*)::text FROM subscription WHERE status <> 'pending' AND "graceUntil" IS DISTINCT FROM "currentPeriodEnd" + interval '24 hours'), '0');
-- Personal: the ledger's spans carry no grace (no grace column exists on personal_subscription or subscription_purchase)
SELECT pg_temp.assert_eq('S3e', 'no Personal table has a grace column',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('personal_subscription', 'subscription_purchase', 'subscription_purchase_reversal') AND column_name ILIKE '%grace%'), '0');

-- ------------------------------------------------------------------------------------------------------------- S3f fee caps, delegations, proposals
\set f_p '00000000-0000-4000-8000-00000000f3f1'
\set f_owner '00000000-0000-4000-8000-00000000f3a0'
\set f_op '00000000-0000-4000-8000-00000000f3a1'
\set f_org '00000000-0000-4000-8000-00000000f3b1'
\set f_company '00000000-0000-4000-8000-00000000f3c0'
INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES (:'f_p', :'f_company', 'TND', :'f_owner');
-- S3g (D-CAT-8): a fee is proposed on an Owner product only (the S3g section below pins the refusal for any other)
INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId") VALUES ('billing-owner', 'company', :'f_company', 's3f-p', 'P', 'personal', :'f_p') RETURNING id AS f_prod \gset
SELECT pg_temp.assert_eq('S3f', 'fee money columns are bigint', (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('fee_cap', 'fee_proposal') AND column_name = 'amount' AND data_type = 'bigint'), '2');
INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (:'f_p', 99, 500, 'TND', :'f_owner');
INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (:'f_p', 99, 300, 'TND', :'f_owner');
SELECT pg_temp.assert_eq('S3f', 'cap versions are the database''s: 1, 2 whatever was supplied', (SELECT string_agg(version::text, ',' ORDER BY version) FROM fee_cap WHERE "platformId" = :'f_p'), '1,2');
SELECT pg_temp.expect_error('S3f', 'a negative cap is refused', format($$INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (%L, 1, -1, 'TND', %L)$$, :'f_p', :'f_owner'), '23514', 'fee_cap_amount_range');
SELECT pg_temp.expect_error('S3f', 'a cap in another currency than the Platform''s is refused', format($$INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (%L, 1, 1, 'EUR', %L)$$, :'f_p', :'f_owner'), '23503');
SELECT pg_temp.expect_error('S3f', 'a cap version is never changed', format($$UPDATE fee_cap SET amount = 1 WHERE "platformId" = %L$$, :'f_p'), '23514');
INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES (:'f_p', :'f_op', :'f_owner') RETURNING id AS f_del \gset
SELECT pg_temp.expect_error('S3f', 'one active delegation per (Platform, operator)', format($$INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES (%L, %L, %L)$$, :'f_p', :'f_op', :'f_owner'), '23505', 'fee_delegation_active_unique');
SELECT pg_temp.expect_error('S3f', 'an Owner cannot delegate to themselves', format($$INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES (%L, %L, %L)$$, :'f_p', :'f_owner', :'f_owner'), '23514', 'fee_delegation_not_self');
SELECT pg_temp.expect_error('S3f', 'a proposal above the CURRENT cap (300, not the earlier 500) is refused', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (%L, %L, %L, 301, 'TND', %L, %L)$$, :'f_p', :'f_org', :'f_prod', :'f_del', :'f_op'), '23514', 'fee_above_cap');
SELECT pg_temp.expect_error('S3f', 'a proposal cannot be created already approved', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy", status, "decidedBy", "decidedAt") VALUES (%L, %L, %L, 1, 'TND', %L, %L, 'approved', %L, now())$$, :'f_p', :'f_org', :'f_prod', :'f_del', :'f_op', :'f_owner'), '23514', 'fee_proposal_created_pending');
SELECT pg_temp.expect_error('S3f', 'a proposal for an Organization subscription or a non-subscription product is refused', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy", target) VALUES (%L, %L, %L, 1, 'TND', %L, %L, 'organization')$$, :'f_p', :'f_org', :'f_prod', :'f_del', :'f_op'), '23514', 'fee_proposal_target');
INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (:'f_p', :'f_org', :'f_prod', 300, 'TND', :'f_del', :'f_op') RETURNING id AS f_prop \gset
SELECT pg_temp.expect_error('S3f', 'one pending proposal per (Organization, product)', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (%L, %L, %L, 1, 'TND', %L, %L)$$, :'f_p', :'f_org', :'f_prod', :'f_del', :'f_op'), '23505');
INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (:'f_p', 0, 200, 'TND', :'f_owner');
SELECT pg_temp.expect_error('S3f', 'approval re-checks the CURRENT cap (now 200 < 300)', format($$UPDATE fee_proposal SET status = 'approved', "decidedBy" = %L WHERE id = %L$$, :'f_owner', :'f_prop'), '23514', 'fee_above_cap');
INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (:'f_p', 0, 300, 'TND', :'f_owner');
SELECT pg_temp.expect_ok('S3f', 'approval within the current cap', format($$UPDATE fee_proposal SET status = 'approved', "decidedBy" = %L WHERE id = %L$$, :'f_owner', :'f_prop'));
SELECT pg_temp.assert_eq('S3f', 'the approval records the cap version it satisfied and the database clock', (SELECT ("capVersion" = 4 AND "decidedAt" IS NOT NULL)::text FROM fee_proposal WHERE id = :'f_prop'), 'true');
SELECT pg_temp.expect_error('S3f', 'a decision is final', format($$UPDATE fee_proposal SET status = 'rejected' WHERE id = %L$$, :'f_prop'), '23514', 'fee_proposal_not_pending');
SELECT pg_temp.expect_error('S3f', 'an approved fee''s amount is immutable', format($$UPDATE fee_proposal SET amount = 1 WHERE id = %L$$, :'f_prop'), '23514');
SELECT pg_temp.expect_error('S3f', 'a proposal is never deleted', format($$DELETE FROM fee_proposal WHERE id = %L$$, :'f_prop'), '23514');
SELECT pg_temp.assert_eq('S3f', 'the fee for use is the latest approval, usable under the current cap', (SELECT (amount = 300 AND usable)::text FROM billing_fee_for_use(:'f_org', :'f_prod')), 'true');
INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES (:'f_p', 0, 100, 'TND', :'f_owner');
SELECT pg_temp.assert_eq('S3f', 'at the point of use a since-lowered cap makes the approved fee unusable (never rewritten)', (SELECT (amount = 300 AND NOT usable)::text FROM billing_fee_for_use(:'f_org', :'f_prod')), 'true');
INSERT INTO fee_delegation_revocation ("delegationId", "revokedBy") VALUES (:'f_del', :'f_owner');
SELECT pg_temp.expect_error('S3f', 'a revoked delegation proposes nothing', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (%L, gen_random_uuid(), %L, 0, 'TND', %L, %L)$$, :'f_p', :'f_prod', :'f_del', :'f_op'), '23514', 'fee_proposal_delegation_active');
SELECT pg_temp.expect_error('S3f', 'a revocation is final (one per delegation)', format($$INSERT INTO fee_delegation_revocation ("delegationId", "revokedBy") VALUES (%L, %L)$$, :'f_del', :'f_owner'), '23505');
SELECT pg_temp.expect_ok('S3f', 'after a revocation the operator may be delegated again (a new delegation)', format($$INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES (%L, %L, %L)$$, :'f_p', :'f_op', :'f_owner'));
INSERT INTO fee_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (:'f_owner', 'k-s3f-0001', 'fee_cap.set', repeat('a', 64), 201, '{}');
SELECT pg_temp.expect_error('S3f', 'an idempotency record is never changed', $$UPDATE fee_command_idempotency SET "responseStatus" = 200$$, '23514');
SELECT pg_temp.expect_error('S3f', 'an idempotency record is never deleted', $$DELETE FROM fee_command_idempotency$$, '23514');
SELECT pg_temp.expect_error('S3f', 'only a success is recorded for replay', format($$INSERT INTO fee_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s3f-0002', 'x', repeat('a', 64), 409, '{}')$$, :'f_owner'), '23514', 'fee_command_idempotency_status');

-- ------------------------------------------------------------------------------------------------------------- S3f direct checkout (0026)
-- The reserved producer `billing-checkout` may only commit a complete direct checkout (simulation reference shape); anything else is
-- refused at COMMIT. Other producers are untouched.
SELECT pg_temp.expect_error('S3f-CO', 'a bare draft under the reserved producer cannot commit', $$
  WITH i AS (INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
             VALUES ('billing-checkout', gen_random_uuid(), repeat('a', 64), 'company', gen_random_uuid()::text, 'user', 'u-co', NULL, 'direct_checkout', 's', 'TND', 1, 1, '{"schemaVersion":2}', '{"schemaVersion":2}') RETURNING id)
  INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") SELECT 'invoice', id, NULL, 'draft', 0, 'system', 'request' FROM i;
  SET CONSTRAINTS ALL IMMEDIATE$$, '23514', 'checkout_invoice_shape');
SELECT pg_temp.expect_ok('S3f-CO', 'another producer''s invoice is not subject to the checkout guard', $$SELECT t_mk_invoice(); SET CONSTRAINTS ALL IMMEDIATE$$);
SELECT pg_temp.expect_error('S3f-CO', 'a checkout idempotency record is never changed', $$
  INSERT INTO checkout_idempotency ("buyerUserId", "idempotencyKey", "requestHash", "responseStatus", "responseBody") VALUES ('u-co', 'k-co-00001', repeat('a', 64), 201, '{}');
  UPDATE checkout_idempotency SET "responseStatus" = 200 WHERE "buyerUserId" = 'u-co'$$, '23514');

-- ------------------------------------------------------------------------------------------------------------- S3g Owner catalog (0027)
-- The reserved provenance `billing-owner` is an Owner product: personal, on a configured Platform, sold by that Platform's Company
-- reference. Checkout lines and new fee proposals require it; nothing existing is re-judged; producer products are untouched.
\set g_p '00000000-0000-4000-8000-00000000a3a1'
\set g_p2 '00000000-0000-4000-8000-00000000a3a2'
\set g_free '00000000-0000-4000-8000-00000000a3a3'
\set g_company '00000000-0000-4000-8000-00000000a3c1'
\set g_company2 '00000000-0000-4000-8000-00000000a3c2'
INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES (:'g_p', :'g_company', 'TND', gen_random_uuid()), (:'g_p2', :'g_company2', 'TND', gen_random_uuid());
SELECT pg_temp.expect_error('S3g', 'an Owner product is personal (not an Organization subscription product)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'company', %L, 'g-org', 'P', 'organization', %L)$$, :'g_company', :'g_p'), '23514', 'product_owner_shape');
SELECT pg_temp.expect_error('S3g', 'an Owner product is a subscription product (not an ordinary one)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'company', %L, 'g-none', 'P', 'none', %L)$$, :'g_company', :'g_p'), '23514', 'product_owner_shape');
SELECT pg_temp.expect_error('S3g', 'an Owner product is sold by its Platform''s Company reference (not another Company''s)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'company', %L, 'g-other', 'P', 'personal', %L)$$, :'g_company2', :'g_p'), '23514', 'product_owner_shape');
SELECT pg_temp.expect_error('S3g', 'an Owner product is sold by a Company (not an Organization or a user)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'user', %L, 'g-user', 'P', 'personal', %L)$$, :'g_company', :'g_p'), '23514', 'product_owner_shape');
SELECT pg_temp.expect_error('S3g', 'an Owner product needs a configured Platform', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'company', %L, 'g-free', 'P', 'personal', %L)$$, :'g_company', :'g_free'), '23514');
INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId") VALUES ('billing-owner', 'company', :'g_company', 'g-monthly', 'P', 'personal', :'g_p') RETURNING id AS g_prod \gset
SELECT pg_temp.expect_ok('S3g', 'a second Owner personal product on the same Platform (several Personal offerings)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-owner', 'company', %L, 'g-second', 'P2', 'personal', %L)$$, :'g_company', :'g_p'));
SELECT pg_temp.expect_error('S3g', 'a product code is unique per Company, across its Platforms (D-CAT-10)', format($$INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId")
  VALUES ('billing-test', 'company', %L, 'g-monthly', 'P', 'personal', %L)$$, :'g_company', :'g_p'), '23505', 'product_code_unique');
SELECT pg_temp.expect_error('S3g', 'an Owner product''s provenance is immutable', format($$UPDATE product SET producer = 'billing-test' WHERE id = %L$$, :'g_prod'), '23514');
SELECT pg_temp.expect_error('S3g', 'an Owner product''s target is immutable', format($$UPDATE product SET "subscriptionTarget" = 'organization' WHERE id = %L$$, :'g_prod'), '23514');
SELECT pg_temp.expect_error('S3g', 'a producer product cannot become an Owner product', format($$UPDATE product SET producer = 'billing-owner' WHERE id = (SELECT id FROM product WHERE producer <> 'billing-owner' LIMIT 1)$$), '23514');
SELECT pg_temp.expect_ok('S3g', 'several active recurring prices coexist on one product (monthly and yearly)', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 'g-m', 'TND', 900, 'recurring', 'month', 1), (%L, 'g-y', 'TND', 9000, 'recurring', 'year', 1)$$, :'g_prod', :'g_prod'));
SELECT pg_temp.expect_ok('S3g', 'a future-dated price coexists with the current one of the same period (scheduled successor)', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
  VALUES (%L, 'g-m2', 'TND', 990, 'recurring', 'month', 1, now() + interval '30 days')$$, :'g_prod'));
SELECT pg_temp.expect_error('S3g', 'a price identity is unique per product', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 'g-m', 'TND', 1, 'recurring', 'month', 1)$$, :'g_prod'), '23505', 'price_reference_unique');
SELECT pg_temp.expect_error('S3g', 'an Owner price is in its Platform''s currency', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
  VALUES (%L, 'g-eur', 'EUR', 900, 'recurring', 'month', 1)$$, :'g_prod'), '23514', 'price_platform_currency');
SELECT pg_temp.expect_error('S3g', 'an Owner price recurs', format($$INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES (%L, 'g-once', 'TND', 900, 'one_time')$$, :'g_prod'), '23514', 'price_subscription_recurring');
SELECT pg_temp.expect_error('S3g', 'an Owner price''s terms are immutable', format($$UPDATE price SET "unitAmount" = 1 WHERE "productId" = %L AND "clientReference" = 'g-m'$$, :'g_prod'), '23514');
SELECT pg_temp.expect_error('S3g', 'the reserved provenance never produces an invoice', $$INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
  VALUES ('billing-owner', gen_random_uuid(), repeat('a', 64), 'company', 'c', 'user', 'u', 's', 's', 'TND', 1, 1, '{"schemaVersion":1}', '{"schemaVersion":1}')$$, '23514', 'invoice_producer_not_owner');
-- a producer's personal product on the same Platform, with the same Company reference: still a valid producer product
INSERT INTO product (producer, "sellerType", "sellerId", code, name, "subscriptionTarget", "platformId") VALUES ('billing-test', 'company', :'g_company', 'g-producer', 'P', 'personal', :'g_p') RETURNING id AS g_pprod \gset
INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES (:'g_pprod', 'g-pm', 'TND', 900, 'recurring', 'month', 1) RETURNING id AS g_pprice \gset
SELECT id AS g_oprice FROM price WHERE "productId" = :'g_prod' AND "clientReference" = 'g-m' \gset
SELECT pg_temp.expect_error('S3g', 'a direct-checkout line of a producer product is refused at insert', format($$
  WITH i AS (INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
             VALUES ('billing-checkout', gen_random_uuid(), repeat('a', 64), 'company', %L, 'user', 'u-g', 'direct_checkout', 's', 'TND', 900, 900, '{"schemaVersion":2}', '{"schemaVersion":2}') RETURNING id)
  INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval", "intervalUnit", "intervalCount")
  SELECT id, 'TND', 1, %L, %L, 'g-producer', 'P', 1, 900, 900, 'none', 'recurring', 'month', 1 FROM i$$, :'g_company', :'g_pprice', :'g_pprod'), '23514', 'checkout_owner_product');
SELECT pg_temp.expect_error('S3g', 'a direct-checkout line of an Owner product passes the provenance guard (only S3f''s commit-time shape guard then judges it)', format($$
  WITH i AS (INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
             VALUES ('billing-checkout', gen_random_uuid(), repeat('a', 64), 'company', %L, 'user', 'u-g', 'direct_checkout', 's', 'TND', 900, 900, '{"schemaVersion":2}', '{"schemaVersion":2}') RETURNING id)
  INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal", "entitlementKind", "interval", "intervalUnit", "intervalCount")
  SELECT id, 'TND', 1, %L, %L, 'g-monthly', 'P', 1, 900, 900, 'none', 'recurring', 'month', 1 FROM i;
  SET CONSTRAINTS ALL IMMEDIATE$$, :'g_company', :'g_oprice', :'g_prod'), '23514', 'checkout_invoice_shape');
SELECT pg_temp.expect_ok('S3g', 'another producer''s invoice line of a producer product is untouched by the checkout provenance guard', $$SELECT t_mk_invoice()$$);
INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES (:'g_p', gen_random_uuid(), gen_random_uuid()) RETURNING id AS g_del, "operatorUserId" AS g_op \gset
SELECT pg_temp.expect_error('S3g', 'a new fee proposal on a producer product is refused', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (%L, gen_random_uuid(), %L, 0, 'TND', %L, %L)$$, :'g_p', :'g_pprod', :'g_del', :'g_op'), '23514', 'fee_proposal_owner_product');
SELECT pg_temp.expect_ok('S3g', 'a new fee proposal on an Owner product is accepted', format($$INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (%L, gen_random_uuid(), %L, 0, 'TND', %L, %L)$$, :'g_p', :'g_prod', :'g_del', :'g_op'));
-- a proposal submitted on a producer product BEFORE S3g (simulated: the insert guard does not fire in replica mode) is never re-judged
SET session_replication_role = replica;
INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES (:'g_p', gen_random_uuid(), :'g_pprod', 0, 'TND', :'g_del', :'g_op') RETURNING id AS g_legacy_prop \gset
SET session_replication_role = origin;
SELECT pg_temp.expect_ok('S3g', 'a pre-S3g proposal on a producer product can still be decided by the Owner (nothing invalidated)', format($$UPDATE fee_proposal SET status = 'rejected', "decidedBy" = gen_random_uuid() WHERE id = %L$$, :'g_legacy_prop'));
SELECT pg_temp.expect_ok('S3g', 'archiving an Owner product is the one-way status change', format($$UPDATE product SET status = 'archived' WHERE id = %L$$, :'g_prod'));
SELECT pg_temp.expect_error('S3g', 'an archived Owner product is never re-activated', format($$UPDATE product SET status = 'active' WHERE id = %L$$, :'g_prod'), '23514');

-- ------------------------------------------------------------------------------------------------------------- S4a mapping v2 (0028)
SELECT t_mk_open() AS s4a_open \gset
SELECT t_mk_request(:'s4a_open') AS s4a_req \gset
SELECT pg_temp.assert_eq('S4a', 'a new payment request pins mapping version 2', (SELECT "mappingVersion"::text FROM payment_request WHERE id = :'s4a_req'), '2');
SELECT pg_temp.expect_error('S4a', 'a new payment request cannot pin mapping version 1', format($$
  INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType", "mappingVersion") SELECT id, total, currency, 'user', 1 FROM invoice WHERE id = %L$$, :'s4a_open'), '23514', 'payment_request_mapping_v2');
SELECT pg_temp.expect_error('S4a', 'an unknown mapping version is refused', format($$
  INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType", "mappingVersion") SELECT id, total, currency, 'user', 3 FROM invoice WHERE id = %L$$, :'s4a_open'), '23514');
-- a legacy invoice: open without a routing record (issued before S3a). Simulated inside the refused statement itself: the invoice leaves
-- draft with no routing record (DB-2 would refuse that only at commit) and the request is refused at once, rolling both back
SELECT t_mk_invoice() AS s4a_legacy \gset
SELECT pg_temp.expect_error('S4a', 'a legacy invoice without a routing record cannot start a new payment request (P-2)', format($$
  UPDATE invoice SET status = 'open', presentation = '{"schemaVersion":1,"template":"system:1","locale":"fr"}'::jsonb WHERE id = %L;
  SELECT t_mk_request(%L)$$, :'s4a_legacy', :'s4a_legacy'), '23514', 'payment_request_routing_required');
SELECT pg_temp.assert_eq('S4a', 'no existing routing record was re-judged by the B2 narrowing (NOT VALID)',
  (SELECT convalidated::text FROM pg_constraint WHERE conname = 'invoice_entitlement_non_entitlement_payer'), 'false');
SELECT pg_temp.assert_eq('S4a', 'existing payment requests keep their mapping version (no backfill)',
  (SELECT count(*)::text FROM payment_request WHERE "mappingVersion" NOT IN (1, 2)), '0');

-- ------------------------------------------------------------------------------------------------------------- S5a Organization assistance (0029)
-- Frozen terms (D-1), consent (D-3), one transition from pending (D-4, D-6), the FC-8 time order and deadline, one unresolved request
-- (D-7), immutability and the derived overdue, whatever path writes. Reuses the S3f Platform, Owner product and (approved) fee above.
\set a_org '00000000-0000-4000-8000-00000000a5a1'
\set a_ben '00000000-0000-4000-8000-00000000a5b1'
\set a_act '00000000-0000-4000-8000-00000000a5c1'
INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom") VALUES (:'f_prod', 's5a-r', 'TND', 9000, 'recurring', 'month', 1, '2020-01-01') RETURNING id AS a_price \gset
SELECT version AS a_cap FROM billing_current_fee_cap(:'f_p') \gset
-- the S3f Organization's approved fee (300) is above the current cap (100): unusable, so a request there is refused, never reduced
SELECT pg_temp.expect_error('S5a', 'an approved fee above the current cap is refused, not reduced', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeProposalId", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 100, 9100, %L, %L, true)$$, :'a_ben', :'f_org', :'f_p', :'f_prod', :'a_price', :'f_prop', :'a_cap'), '23514', 'assistance_request_fee_not_usable');
SELECT pg_temp.expect_error('S5a', 'a fee where none is approved is refused', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 50, 9050, %L, true)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23514');
SELECT pg_temp.expect_error('S5a', 'a base amount that is not the price is refused', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 8000, 0, 8000, %L, true)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23514', 'assistance_request_offering');
SELECT pg_temp.expect_error('S5a', 'a stale cap version is refused', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, 1, true)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price'), '23514', 'assistance_request_fee_terms');
SELECT pg_temp.expect_error('S5a', 'a total that is not base + fee is refused', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9001, %L, true)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23514', 'assistance_request_amounts');
SELECT pg_temp.expect_error('S5a', 'no implicit consent', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, false)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23514', 'assistance_request_consent');
SELECT pg_temp.expect_error('S5a', 'a request is never created cash_collected', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent, status, "cashCollectedAt", "reportedAt", "reportedBy", "settleBy")
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, true, 'cash_collected', now(), now(), %L, now() + interval '72 hours')$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap', :'a_act'), '23514', 'assistance_request_created_pending');
INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent, "consentAt")
  VALUES (:'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', 'TND', 9000, 0, 9000, :'a_cap', true, '2000-01-01') RETURNING id AS a_req \gset
SELECT pg_temp.assert_eq('S5a', 'consentAt is the database''s time, never a supplied one', (SELECT ("consentAt" > '2020-01-01')::text FROM assistance_request WHERE id = :'a_req'), 'true');
SELECT pg_temp.expect_error('S5a', 'one unresolved request per (beneficiary, Organization, product)', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, true)$$, :'a_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23505', 'assistance_request_unresolved_unique');
SELECT pg_temp.expect_error('S5a', 'frozen terms never change', format($$UPDATE assistance_request SET "feeAmount" = 0, "totalAmount" = 9000 WHERE id = %L$$, :'a_req'), '23514');
SELECT pg_temp.expect_error('S5a', 'a collection before the consent is refused', format($$UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = "consentAt" - interval '1 millisecond', "reportedBy" = %L WHERE id = %L$$, :'a_act', :'a_req'), '23514', 'assistance_request_cash_time_order');
SELECT pg_temp.expect_error('S5a', 'a collection after the report time is refused', format($$UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = now() + interval '1 second', "reportedBy" = %L WHERE id = %L$$, :'a_act', :'a_req'), '23514', 'assistance_request_cash_time_order');
SELECT pg_temp.expect_error('S5a', 'the beneficiary never reports their own collection', format($$UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = now(), "reportedBy" = %L WHERE id = %L$$, :'a_ben', :'a_req'), '23514', 'assistance_request_reporter_not_beneficiary');
SELECT pg_temp.expect_error('S5a', 'a decline must name its role consistently', format($$UPDATE assistance_request SET status = 'declined', "declinedBy" = %L, "declinedByRole" = 'organization_actor' WHERE id = %L$$, :'a_ben', :'a_req'), '23514', 'assistance_request_decline_role');
SELECT pg_temp.expect_ok('S5a', 'a report at the consent instant is admissible (consentAt <= cashCollectedAt <= reportedAt)', format($$UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = "consentAt", "reportedBy" = %L, "reportedAt" = '2000-01-01', "settleBy" = '2000-01-01' WHERE id = %L$$, :'a_act', :'a_req'));
SELECT pg_temp.assert_eq('S5a', 'reportedAt is the database time and settleBy exactly cashCollectedAt + 72 hours, whatever was supplied',
  (SELECT ("reportedAt" > '2020-01-01' AND "reportedAt" <= now() AND "settleBy" = "cashCollectedAt" + interval '72 hours' AND extract(epoch FROM "settleBy" - "cashCollectedAt") = 259200)::text FROM assistance_request WHERE id = :'a_req'), 'true');
SELECT pg_temp.expect_error('S5a', 'a reported collection is final in S5a (no decline, no second report)', format($$UPDATE assistance_request SET status = 'declined', "declinedBy" = %L, "declinedByRole" = 'beneficiary', "cashCollectedAt" = NULL, "reportedAt" = NULL, "reportedBy" = NULL, "settleBy" = NULL WHERE id = %L$$, :'a_ben', :'a_req'), '23514');
SELECT pg_temp.expect_error('S5a', 'the reported time is immutable once recorded', format($$UPDATE assistance_request SET "cashCollectedAt" = "cashCollectedAt" + interval '1 second' WHERE id = %L$$, :'a_req'), '23514', 'assistance_request_not_pending');
SELECT pg_temp.expect_error('S5a', 'an assistance request is never deleted', format($$DELETE FROM assistance_request WHERE id = %L$$, :'a_req'), '23514');
SELECT pg_temp.expect_error('S5a', 'an assistance request is never truncated (S5b tables reference it: CASCADE reaches their own no-truncate guards)', $$TRUNCATE assistance_request CASCADE$$, '23514');
SELECT pg_temp.assert_eq('S5a', 'overdue is derived: unresolved and past settleBy at the database''s current time; never for pending or declined',
  (SELECT (billing_assistance_overdue('cash_collected', now() - interval '1 millisecond') AND NOT billing_assistance_overdue('cash_collected', now() + interval '1 hour')
           AND NOT billing_assistance_overdue('pending', now() - interval '1 hour') AND NOT billing_assistance_overdue('declined', now() - interval '1 hour'))::text), 'true');
SELECT pg_temp.assert_eq('S5a', 'no overdue column is stored', (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'assistance_request' AND column_name ILIKE '%overdue%'), '0');
SELECT pg_temp.assert_eq('S5a', 'an assistance request references no invoice, payment or purchase (a cash report is never settlement)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'assistance_request' AND column_name ~* '(invoice|payment|purchase|subscription|settled)'), '0');
SELECT pg_temp.expect_error('S5a', 'an assistance idempotency record is never changed', format($$
  INSERT INTO assistance_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s5a-0001', 'assistance_request.create', repeat('a', 64), 201, '{}');
  UPDATE assistance_command_idempotency SET "responseStatus" = 200 WHERE "actorUserId" = %L$$, :'a_ben', :'a_ben'), '23514');
SELECT pg_temp.expect_error('S5a', 'an unknown assistance command is refused', format($$
  INSERT INTO assistance_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s5a-0002', 'assistance_request.settle', repeat('a', 64), 201, '{}')$$, :'a_ben'), '23514', 'assistance_command_idempotency_operation');

-- ------------------------------------------------------------------------------------------------------------- S5b assisted settlement and cash return (0030)
-- Reuses the S5a request above (cash_collected at its consent instant; settleBy 72 hours later, in the future).
SELECT pg_temp.expect_error('S5b', 'no cash-return obligation before the deadline (E-6)', format($$INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
  SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = %L$$, :'a_req'), '23514', 'cash_return_obligation_not_due');
SELECT pg_temp.expect_error('S5b', 'a request is settled only by its purchase (E-12)', format($$UPDATE assistance_request SET status = 'settled' WHERE id = %L$$, :'a_req'), '23514', 'assistance_request_settled_by_purchase');
SELECT pg_temp.assert_eq('S5b', 'overdue never applies to a settled request', (SELECT (NOT billing_assistance_overdue('settled', now() - interval '1 hour'))::text), 'true');
SELECT t_mk_invoice() AS s5b_inv \gset
INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES ('00000000-0000-4000-8000-00000000b5b1', :'a_org', :'f_p', :'f_prod', :'a_price', 'TND', 9000, 0, 9000, :'a_cap', true) RETURNING id AS s5b_pending \gset
SELECT pg_temp.expect_error('S5b', 'no settlement channel for a request without recorded cash collection (E-1)', format($$INSERT INTO assistance_settlement_channel ("assistanceRequestId", "invoiceId", "startedBy") VALUES (%L, %L, %L)$$, :'s5b_pending', :'s5b_inv', :'a_act'), '23514', 'assistance_request_not_settleable');
SELECT pg_temp.expect_error('S5b', 'a channel is created open, never closed or settled', format($$INSERT INTO assistance_settlement_channel ("assistanceRequestId", "invoiceId", "startedBy", status, "closedAt") VALUES (%L, %L, %L, 'closed', now())$$, :'a_req', :'s5b_inv', :'a_act'), '23514', 'assistance_settlement_channel_created_open');
SELECT pg_temp.expect_error('S5b', 'an assisted routing record names its assistance request (DB-5)', format($$INSERT INTO invoice_entitlement ("invoiceId", purpose, target, "payerType", "payerId", "beneficiaryUserId", "organizationId", "productId")
  VALUES (%L, 'assisted_settlement', 'personal', 'user', 'u', 'u', %L, %L)$$, :'s5b_inv', :'a_org', :'f_prod'), '23514', 'invoice_entitlement_combination');
SELECT pg_temp.expect_error('S5b', 'no other purpose may name an assistance request', format($$INSERT INTO invoice_entitlement ("invoiceId", purpose, target, "payerType", "payerId", "beneficiaryUserId", "organizationId", "productId", "assistanceRequestId")
  SELECT %L, 'non_entitlement', 'none', "payerType", "payerId", NULL, NULL, NULL, %L FROM invoice WHERE id = %L$$, :'s5b_inv', :'a_req', :'s5b_inv'), '23514', 'invoice_entitlement_combination');
SELECT pg_temp.expect_error('S5b', 'a cash-return obligation is never created confirmed (nor in any later state)', $$INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", status)
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'TND', now(), 'confirmed_returned')$$, '23514');
SELECT pg_temp.expect_error('S5b', 'a late settlement needs a verified settlement of its request', format($$INSERT INTO assistance_late_settlement ("assistanceRequestId", "invoiceId", "paymentRequestId", "receiptId", reason)
  VALUES (%L, %L, gen_random_uuid(), gen_random_uuid(), 'channel_closed')$$, :'a_req', :'s5b_inv'), '23514', 'assistance_late_settlement_verified');
SELECT pg_temp.assert_eq('S5b', 'no settlement, late-settlement or obligation row ever references a subscription grant column (a cash report never settles)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('cash_return_obligation', 'assistance_late_settlement') AND column_name ~* '(entitlement|subscription)'), '0');
SELECT pg_temp.expect_error('S5b', 'an assistance idempotency record admits the known commands only (no discharge command)', format($$
  INSERT INTO assistance_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s5b-0001', 'cash_return_obligation.discharge', repeat('a', 64), 200, '{}')$$, :'a_ben'), '23514', 'assistance_command_idempotency_operation');

-- ------------------------------------------------------------------------------------------------------------- S5c confirmation, disputes, corrections (0031)
-- Disputes and corrections on the S5a request above (cash_collected at its consent instant, no obligation).
SELECT pg_temp.expect_error('S5c', 'a dispute is opened open', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode", status) VALUES (%L, %L, %L, 'collection_not_made', 'resolved')$$,
  :'a_req', :'a_ben', :'a_org'), '23514', 'assistance_dispute_created_open');
SELECT pg_temp.expect_error('S5c', 'only the request''s beneficiary disputes it', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (%L, %L, %L, 'collection_not_made')$$,
  :'a_req', :'a_act', :'a_org'), '23503');
SELECT pg_temp.expect_error('S5c', 'no cash-not-returned dispute without a cash-return obligation (J-3)', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (%L, %L, %L, 'cash_not_returned')$$,
  :'a_req', :'a_ben', :'a_org'), '23514', 'assistance_dispute_not_permitted');
SELECT pg_temp.expect_error('S5c', 'no dispute of a request without cash evidence', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") SELECT id, "beneficiaryUserId", "organizationId", 'collection_not_made' FROM assistance_request WHERE id = %L$$,
  :'s5b_pending'), '23514', 'assistance_dispute_not_permitted');
SELECT pg_temp.expect_error('S5c', 'no free-form dispute reason', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (%L, %L, %L, 'other')$$,
  :'a_req', :'a_ben', :'a_org'), '23514', 'assistance_dispute_reason');
INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode", "openedAt") VALUES (:'a_req', :'a_ben', :'a_org', 'collection_time_incorrect', '2000-01-01') RETURNING id AS c_dispute \gset
SELECT pg_temp.assert_eq('S5c', 'openedAt is the database''s time', (SELECT ("openedAt" > '2020-01-01')::text FROM assistance_dispute WHERE id = :'c_dispute'), 'true');
SELECT pg_temp.expect_error('S5c', 'one open dispute per request', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (%L, %L, %L, 'collection_not_made')$$,
  :'a_req', :'a_ben', :'a_org'), '23505', 'assistance_dispute_open_unique');
SELECT pg_temp.expect_error('S5c', 'a dispute''s reason and parties never change', format($$UPDATE assistance_dispute SET "reasonCode" = 'collection_not_made' WHERE id = %L$$, :'c_dispute'), '23514');
SELECT pg_temp.expect_error('S5c', 'no resolution outcome but the nonfinancial one (J-2)', format($$UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = %L, outcome = 'resolved_by_owner', "correctionId" = gen_random_uuid() WHERE id = %L$$, :'a_act', :'c_dispute'), '23514');
SELECT pg_temp.expect_error('S5c', 'the beneficiary never answers their own dispute', format($$INSERT INTO assistance_dispute_response ("disputeId", position, "respondedBy") VALUES (%L, 'accepts', %L)$$, :'c_dispute', :'a_ben'), '23514', 'assistance_dispute_response_not_beneficiary');
SELECT pg_temp.expect_ok('S5c', 'the Organization answers once', format($$INSERT INTO assistance_dispute_response ("disputeId", position, "respondedBy") VALUES (%L, 'contests', %L)$$, :'c_dispute', :'a_act'));
SELECT pg_temp.expect_error('S5c', 'a second answer is refused', format($$INSERT INTO assistance_dispute_response ("disputeId", position, "respondedBy") VALUES (%L, 'accepts', %L)$$, :'c_dispute', :'a_act'), '23505');
SELECT pg_temp.expect_error('S5c', 'an answer is append-only', format($$UPDATE assistance_dispute_response SET position = 'accepts' WHERE "disputeId" = %L$$, :'c_dispute'), '23514');
SELECT pg_temp.expect_error('S5c', 'a correction needs the time it corrects to be reported', format($$INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") VALUES (%L, 'returnedAt', now(), 'actor_entry_error', gen_random_uuid())$$, :'a_req'),
  '23514', 'assistance_correction_not_permitted');
SELECT pg_temp.expect_error('S5c', 'a correction keeps consentAt <= cashCollectedAt <= reportedAt', format($$INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") VALUES (%L, 'cashCollectedAt', now() + interval '1 hour', 'actor_entry_error', gen_random_uuid())$$, :'a_req'),
  '23514', 'assistance_correction_time_order');
SELECT pg_temp.expect_error('S5c', 'a party to the request never corrects it', format($$INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") SELECT id, 'cashCollectedAt', "reportedAt", 'actor_entry_error', %L FROM assistance_request WHERE id = %L$$, :'a_act', :'a_req'),
  '23514', 'assistance_correction_not_permitted');
SELECT pg_temp.expect_error('S5c', 'an unchanged value is no correction', format($$INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") SELECT id, 'cashCollectedAt', "cashCollectedAt", 'actor_entry_error', gen_random_uuid() FROM assistance_request WHERE id = %L$$, :'a_req'),
  '23514', 'assistance_correction_changes');
SELECT pg_temp.expect_error('S5c', 'no free-form correction field or reason', format($$INSERT INTO assistance_correction ("assistanceRequestId", field, "correctedValue", "reasonCode", "correctedBy") SELECT id, 'totalAmount', "reportedAt", 'actor_entry_error', gen_random_uuid() FROM assistance_request WHERE id = %L$$, :'a_req'), '23514', 'assistance_correction_field');
SELECT pg_temp.expect_error('S5c', 'a dispute closes only on a correction (J-1, J-2)', format($$UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = gen_random_uuid(), outcome = 'timestamp_corrected', "correctionId" = NULL WHERE id = %L$$, :'c_dispute'), '23514');
INSERT INTO assistance_correction ("assistanceRequestId", sequence, field, "correctedValue", "supersededValue", "reasonCode", "correctedBy", "correctedAt")
  SELECT id, 99, 'cashCollectedAt', "reportedAt", '2000-01-01', 'actor_entry_error', gen_random_uuid(), '2000-01-01' FROM assistance_request WHERE id = :'a_req' RETURNING id AS c_corr \gset
SELECT pg_temp.assert_eq('S5c', 'the guard sets the sequence, the superseded value and the time (never supplied ones)',
  (SELECT (c.sequence = 1 AND c."supersededValue" = a."cashCollectedAt" AND c."correctedAt" > '2020-01-01')::text FROM assistance_correction c JOIN assistance_request a ON a.id = c."assistanceRequestId" WHERE c.id = :'c_corr'), 'true');
SELECT pg_temp.assert_eq('S5c', 'the original evidence is unchanged; the effective time is the correction''s',
  (SELECT (a."cashCollectedAt" = a."consentAt" AND billing_assistance_effective_time(a.id, 'cashCollectedAt') = a."reportedAt" AND a."settleBy" = a."cashCollectedAt" + interval '72 hours')::text FROM assistance_request a WHERE a.id = :'a_req'), 'true');
SELECT pg_temp.expect_error('S5c', 'a correction is never changed', format($$UPDATE assistance_correction SET "reasonCode" = 'evidence_contradicts_report' WHERE id = %L$$, :'c_corr'), '23514');
SELECT pg_temp.expect_error('S5c', 'a correction is never deleted', format($$DELETE FROM assistance_correction WHERE id = %L$$, :'c_corr'), '23514');
SELECT pg_temp.expect_ok('S5c', 'a timestamp dispute closes on a later correction of exactly that time', format($$UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = gen_random_uuid(), outcome = 'timestamp_corrected', "correctionId" = %L WHERE id = %L$$, :'c_corr', :'c_dispute'));
SELECT pg_temp.expect_error('S5c', 'a resolved dispute is final', format($$UPDATE assistance_dispute SET status = 'open', "resolvedAt" = NULL, "resolvedBy" = NULL, outcome = NULL, "correctionId" = NULL WHERE id = %L$$, :'c_dispute'), '23514');
SELECT pg_temp.expect_error('S5c', 'a dispute is never deleted', format($$DELETE FROM assistance_dispute WHERE id = %L$$, :'c_dispute'), '23514');
INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (:'a_req', :'a_ben', :'a_org', 'collection_time_incorrect') RETURNING id AS c_dispute2 \gset
SELECT pg_temp.expect_error('S5c', 'a correction older than the dispute never closes it', format($$UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = gen_random_uuid(), outcome = 'timestamp_corrected', "correctionId" = %L WHERE id = %L$$, :'c_corr', :'c_dispute2'),
  '23514', 'assistance_dispute_resolution_not_permitted');

-- The cash-return side: a request past its deadline with a reported return (fixture written with the triggers off, as a superuser).
\set c_ben '00000000-0000-4000-8000-00000000c5c1'
INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (:'c_ben', :'a_org', :'f_p', :'f_prod', :'a_price', 'TND', 9000, 0, 9000, :'a_cap', true) RETURNING id AS c_req \gset
SET session_replication_role = replica;
UPDATE assistance_request SET "consentAt" = now() - interval '200 hours', status = 'cash_collected', "cashCollectedAt" = now() - interval '100 hours', "reportedAt" = now() - interval '100 hours',
  "reportedBy" = :'a_act', "settleBy" = now() - interval '28 hours' WHERE id = :'c_req';
INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", status, "returnedAt", "returnReportedAt", "returnReportedBy")
  SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt", 'return_reported', now() - interval '1 hour', now(), :'a_act' FROM assistance_request WHERE id = :'c_req' RETURNING id AS c_ob \gset
SET session_replication_role = origin;
SELECT pg_temp.expect_error('S5c', 'only the beneficiary confirms (H-3)', format($$UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = %L WHERE id = %L$$, :'a_act', :'c_ob'), '23514', 'cash_return_obligation_confirmed_by_beneficiary');
SELECT pg_temp.expect_error('S5c', 'a confirmation commits only with the returned request (J-6)', format($$UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = %L WHERE id = %L; SET CONSTRAINTS ALL IMMEDIATE$$, :'c_ben', :'c_ob'),
  '23514', 'cash_return_confirmation_returns_request');
SELECT pg_temp.expect_error('S5c', 'a request is returned only by the confirmation', format($$UPDATE assistance_request SET status = 'returned' WHERE id = %L$$, :'c_req'), '23514', 'assistance_request_returned_by_confirmation');
SELECT pg_temp.expect_error('S5c', 'an open dispute blocks the confirmation (J-4)', format($$INSERT INTO assistance_dispute ("assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode") VALUES (%L, %L, %L, 'cash_not_returned');
  UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = %L WHERE id = %L$$, :'c_req', :'c_ben', :'a_org', :'c_ben', :'c_ob'), '23514', 'assistance_dispute_open');
SELECT pg_temp.expect_error('S5c', 'the report''s evidence never changes on confirmation', format($$UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = %L, "returnedAt" = now() - interval '2 hours' WHERE id = %L$$, :'c_ben', :'c_ob'),
  '23514', 'cash_return_obligation_report_immutable');
SELECT pg_temp.expect_error('S5c', 'resolved_by_owner stays reserved and inactive (J-2)', format($$UPDATE cash_return_obligation SET status = 'resolved_by_owner' WHERE id = %L$$, :'c_ob'), '23514');
SELECT pg_temp.expect_ok('S5c', 'the beneficiary''s confirmation and the returned request commit together', format($$UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = %L, "confirmedAt" = '2000-01-01' WHERE id = %L;
  UPDATE assistance_request SET status = 'returned' WHERE id = %L; SET CONSTRAINTS ALL IMMEDIATE$$, :'c_ben', :'c_ob', :'c_req'));
SELECT pg_temp.assert_eq('S5c', 'confirmedAt is the database''s time', (SELECT ("confirmedAt" > '2020-01-01')::text FROM cash_return_obligation WHERE id = :'c_ob'), 'true');
SELECT pg_temp.expect_error('S5c', 'a confirmed obligation is final', format($$UPDATE cash_return_obligation SET status = 'return_reported', "confirmedAt" = NULL, "confirmedBy" = NULL WHERE id = %L$$, :'c_ob'), '23514');
SELECT pg_temp.expect_error('S5c', 'a returned request is final', format($$UPDATE assistance_request SET status = 'cash_collected' WHERE id = %L$$, :'c_req'), '23514');
SELECT pg_temp.assert_eq('S5c', 'a returned request is resolved: never overdue', (SELECT (NOT billing_assistance_overdue(status, "settleBy"))::text FROM assistance_request WHERE id = :'c_req'), 'true');
SELECT pg_temp.expect_ok('S5c', 'a returned request frees the one-unresolved-request slot (J-6)', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, true)$$, :'c_ben', :'a_org', :'f_p', :'f_prod', :'a_price', :'a_cap'));
SELECT pg_temp.assert_eq('S5c', 'no S5c table references a subscription, payment or purchase (no Owner or dispute action pays, grants or reverses)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('assistance_dispute', 'assistance_dispute_response', 'assistance_correction') AND column_name ~* '(entitlement|subscription|payment|purchase|invoice|amount)'), '0');

-- ------------------------------------------------------------------------------------------------------------- S5d restrictions T1/T2 (0032)
-- A fresh Organization: one request past its deadline (T1), then its obligation (T1 + T2); fixtures written as a superuser.
\set d_org '00000000-0000-4000-8000-00000000d5d0'
\set d_ben '00000000-0000-4000-8000-00000000d5d1'
SELECT pg_temp.assert_eq('S5d', 'an Organization with no assistance has no restriction', (SELECT count(*)::text FROM billing_assistance_restrictions(:'d_org', now())), '0');
INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (:'d_ben', :'d_org', :'f_p', :'f_prod', :'a_price', 'TND', 9000, 0, 9000, :'a_cap', true) RETURNING id AS d_req \gset
SELECT pg_temp.assert_eq('S5d', 'a pending request restricts nothing', (SELECT count(*)::text FROM billing_assistance_restrictions(:'d_org', now() + interval '1000 hours')), '0');
SET session_replication_role = replica;
UPDATE assistance_request SET "consentAt" = now() - interval '200 hours', status = 'cash_collected', "cashCollectedAt" = now() - interval '100 hours', "reportedAt" = now() - interval '100 hours',
  "reportedBy" = :'a_act', "settleBy" = now() - interval '28 hours' WHERE id = :'d_req';
SET session_replication_role = origin;
SELECT pg_temp.assert_eq('S5d', 'T1 at settleBy does not apply; one microsecond later it does (strictly after)',
  (SELECT (NOT EXISTS (SELECT 1 FROM billing_assistance_restrictions(:'d_org', a."settleBy")) AND EXISTS (SELECT 1 FROM billing_assistance_restrictions(:'d_org', a."settleBy" + interval '1 microsecond')))::text
     FROM assistance_request a WHERE a.id = :'d_req'), 'true');
SELECT pg_temp.assert_eq('S5d', 'T1: the request is the source and settleBy the since',
  (SELECT (r.kind = 'T1' AND r."sourceId" = a.id AND r.since = a."settleBy")::text FROM billing_assistance_restrictions(:'d_org', now()) r, assistance_request a WHERE a.id = :'d_req'), 'true');
SELECT pg_temp.expect_error('S5d', 'the database refuses a new request into a T1-restricted Organization', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (gen_random_uuid(), %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, true)$$, :'d_org', :'f_p', :'f_prod', :'a_price', :'a_cap'), '23514', 'assistance_request_restricted');
SELECT pg_temp.expect_ok('S5d', 'another Organization is unaffected (S5D-3)', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, gen_random_uuid(), %L, %L, %L, 'TND', 9000, 0, 9000, %L, true)$$, :'d_ben', :'f_p', :'f_prod', :'a_price', :'a_cap'));
INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
  SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = :'d_req' RETURNING id AS d_ob \gset
SELECT pg_temp.assert_eq('S5d', 'T1 and T2 coexist, in the deterministic order T1, T2', (SELECT string_agg(kind, ',') FROM billing_assistance_restrictions(:'d_org', now())), 'T1,T2');
SELECT pg_temp.assert_eq('S5d', 'T2: the obligation is the source and openedAt the since',
  (SELECT (r."sourceId" = o.id AND r.since = o."openedAt")::text FROM billing_assistance_restrictions(:'d_org', now()) r, cash_return_obligation o WHERE r.kind = 'T2' AND o.id = :'d_ob'), 'true');
UPDATE cash_return_obligation SET status = 'return_reported', "returnedAt" = now() - interval '1 hour', "returnReportedBy" = :'a_act' WHERE id = :'d_ob';
SELECT pg_temp.assert_eq('S5d', 'a reported (unconfirmed) return keeps T1 and T2 (S5D-1, S5D-2)', (SELECT string_agg(kind, ',') FROM billing_assistance_restrictions(:'d_org', now())), 'T1,T2');
BEGIN;
UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = :'d_ben' WHERE id = :'d_ob';
UPDATE assistance_request SET status = 'returned' WHERE id = :'d_req';
COMMIT;
SELECT pg_temp.assert_eq('S5d', 'the beneficiary''s confirmation clears T1 and T2; the missed deadline stays on record',
  (SELECT (NOT EXISTS (SELECT 1 FROM billing_assistance_restrictions(:'d_org', now())) AND a."settleBy" < now())::text FROM assistance_request a WHERE a.id = :'d_req'), 'true');
SELECT pg_temp.expect_ok('S5d', 'an unrestricted Organization admits a new request again', format($$INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
  VALUES (%L, %L, %L, %L, %L, 'TND', 9000, 0, 9000, %L, true)$$, :'d_ben', :'d_org', :'f_p', :'f_prod', :'a_price', :'a_cap'));
-- Core V2 S6f (R6F-6 / FC-9): T3 now has its source (an open recovery obligation); D6 inactivity stays reserved (V-4)
SELECT pg_temp.assert_eq('S5d', 'the reserved kind (inactive) has no source in the model; T3 is sourced from open recovery obligations only (S6f)',
  (SELECT (prosrc NOT LIKE '%''inactive''%' AND prosrc LIKE '%''T3''%' AND prosrc LIKE '%recovery_obligation%')::text FROM pg_proc WHERE proname = 'billing_assistance_restrictions'), 'true');
SELECT pg_temp.assert_eq('S5d', 'no restriction or violation state is stored (FC-9)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND (table_name ~* '(restriction|violation)' OR column_name ~* '(restrict|violation|repeat)')), '0');

-- ------------------------------------------------------------------------------------------------------------- S6a refund cases (0033)
-- The eligible-capture paths are exercised end to end by test/refund-cases.e2e-spec.ts; here, the guards that need no capture fixture.
SELECT pg_temp.expect_error('S6a', 'a refund case is opened open, never cancelled or completed', $$INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "companyId", "platformId", amount, currency, reason, "openedBy", status, "completedAt")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'non_entitlement', gen_random_uuid(), gen_random_uuid(), 100, 'TND', 'customer_request', gen_random_uuid(), 'completed', now())$$, '23514', 'refund_case_created_open');
SELECT pg_temp.expect_error('S6a', 'no case without a verified capture of a paid payment request', $$INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "companyId", "platformId", amount, currency, reason, "openedBy")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'non_entitlement', gen_random_uuid(), gen_random_uuid(), 100, 'TND', 'customer_request', gen_random_uuid())$$, '23514', 'refund_case_capture_unverified');
SELECT pg_temp.assert_eq('S6a', 'one live case per payment: open or completed (FC-3), a cancelled case frees it',
  (SELECT (indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%("paymentId")%' AND indexdef LIKE '%open%' AND indexdef LIKE '%completed%' AND indexdef NOT LIKE '%cancelled%')::text
     FROM pg_indexes WHERE indexname = 'refund_case_payment_active_unique'), 'true');
SELECT pg_temp.assert_eq('S6a', 'the case amount is bigint, positive and at most 2^53-1',
  (SELECT (c.data_type = 'bigint' AND pg_get_constraintdef(k.oid) LIKE '%amount > 0%' AND pg_get_constraintdef(k.oid) LIKE '%9007199254740991%')::text
     FROM information_schema.columns c, pg_constraint k WHERE c.table_name = 'refund_case' AND c.column_name = 'amount' AND k.conname = 'refund_case_amount'), 'true');
SELECT pg_temp.assert_eq('S6a', 'a refund case holds no attempt, provider or allocation state (S6b, S6c)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'refund_case' AND column_name ~* '(attempt|provider|allocat|receiptSecret|consume)'), '0');
SELECT pg_temp.expect_error('S6a', 'a refund idempotency record admits the two refund-case commands only', format($$
  INSERT INTO refund_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s6a-0001', 'refund_case.complete', repeat('a', 64), 200, '{}')$$, :'a_ben'),
  '23514', 'refund_command_idempotency_operation');
SELECT pg_temp.expect_error('S6a', 'a refund idempotency record is never changed', format($$
  INSERT INTO refund_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES (%L, 'k-s6a-0002', 'refund_case.open', repeat('a', 64), 201, '{}');
  UPDATE refund_command_idempotency SET "responseStatus" = 200 WHERE "idempotencyKey" = 'k-s6a-0002'$$, :'a_ben'), '23514');

-- ------------------------------------------------------------------------------------------------------------- S6b authorization relays (0034)
-- The relay, mirror, reconciliation and cancellation paths run end to end in test/refund-authorizations.e2e-spec.ts and, with the real Auth and
-- Payment, in test/e2e-real-broker/s6b-refund-processing.e2e-spec.ts; here, the guards that need no case fixture.
SELECT pg_temp.expect_error('S6b', 'a relay starts unconfirmed (Payment alone decides its status)', $$INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash", "attemptStatus", "statusAt")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'k-s6b-0001', repeat('a', 64), 'authorized', now())$$, '23514', 'refund_authorization_relay_created_unconfirmed');
SELECT pg_temp.expect_error('S6b', 'a relay needs an open case', $$INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'k-s6b-0002', repeat('a', 64))$$, '23514', 'refund_authorization_relay_case_open');
SELECT pg_temp.assert_eq('S6b', 'R6B-10: one relay per case while it may still refund (only the unconsumed endings and failed free it)',
  (SELECT (indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%("refundCaseId")%' AND indexdef LIKE '%authorization_expired%' AND indexdef LIKE '%authorization_refused%'
      AND indexdef LIKE '%failed%' AND indexdef LIKE '%rejected%' AND indexdef NOT LIKE '%succeeded%')::text
     FROM pg_indexes WHERE indexname = 'refund_authorization_relay_one_live'), 'true');
SELECT pg_temp.assert_eq('S6b', 'R6B-10: the cancellation guard runs on every refund case update',
  (SELECT count(*)::text FROM pg_trigger WHERE tgname = 'refund_case_15_cancel_guard' AND tgrelid = 'refund_case'::regclass AND NOT tgisinternal), '1');
SELECT pg_temp.assert_eq('S6b', 'F-12: no Billing column stores a receipt secret',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'secret'), '0');
SELECT pg_temp.assert_eq('S6b', 'a relay holds no money: the binding is the case''s own',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'refund_authorization_relay' AND column_name ~* '(amount|currency|total)'), '0');

-- ------------------------------------------------------------------------------------------------------------- S6c refund case completion (0035)
-- Completion from Payment's verified event or read runs end to end in test/refund-authorizations.e2e-spec.ts and over a real broker in
-- test/e2e-real-broker/s6b-refund-processing.e2e-spec.ts; here, the guards that need no case fixture.
SELECT pg_temp.expect_error('S6c', 'completion evidence names a real case of the same payment', $$INSERT INTO refund_case_completion ("refundCaseId", "paymentId", "refundAttemptId", "refundAuthorizationId", "approvedAmount", currency, "completedAt", source)
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 100, 'TND', now(), 'reconciliation')$$, '23514', 'refund_case_completion_case_open');
SELECT pg_temp.assert_eq('S6c', 'an event-sourced completion records its verified event id, a reconciled one none',
  (SELECT (pg_get_constraintdef(oid) LIKE '%eventId%')::text FROM pg_constraint WHERE conname = 'refund_case_completion_source'), 'true');
SELECT pg_temp.assert_eq('S6c', 'V-3: one completion per case (primary key) and per Payment authorization (unique)',
  (SELECT count(*)::text FROM pg_constraint WHERE conrelid = 'refund_case_completion'::regclass AND contype IN ('p', 'u')), '3');
SELECT pg_temp.assert_eq('S6c', 'the completion is bound to a relay of the same case (composite key)',
  (SELECT count(*)::text FROM pg_constraint WHERE conname = 'refund_case_completion_relay' AND contype = 'f'), '1');
SELECT pg_temp.assert_eq('S6c', 'the refund_case.completed transition requires the recorded completion',
  (SELECT (prosrc LIKE '%refund_case_completion_evidence%')::text FROM pg_proc WHERE proname = 'billing_refund_case_transition_guard'), 'true');
SELECT pg_temp.assert_eq('S6c', 'R6C-10: completion adds no reversal, entitlement or obligation column',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'refund_case_completion' AND column_name ~* '(reversal|entitlement|obligation|purchase)'), '0');

-- ------------------------------------------------------------------------------------------------------------- S6d commercial effects (0036)
-- The effects run end to end in test/refund-cases.e2e-spec.ts (Core V2 S6d block); here, the guards that need no completed-case fixture.
SELECT pg_temp.assert_eq('S6d', 'R6D-2: every existing obligation keeps origin deadline; a refund origin always names its case',
  (SELECT (pg_get_constraintdef(oid) LIKE '%refund_completion%' AND pg_get_constraintdef(oid) LIKE '%refundCaseId%')::text FROM pg_constraint WHERE conname = 'cash_return_obligation_origin'), 'true');
SELECT pg_temp.expect_error('S6d', 'R6D-3: an effect needs a completed case', $$INSERT INTO refund_case_effect ("refundCaseId", outcome, reason) VALUES (gen_random_uuid(), 'none', 'no_entitlement_basis')$$, '23514', 'refund_case_effect_completed');
SELECT pg_temp.assert_eq('S6d', 'R6D-3: the effect outcomes are exactly the three approved ones, with their shapes',
  (SELECT (pg_get_constraintdef(oid) LIKE '%reversed_purchase_and_obligation_opened%')::text FROM pg_constraint WHERE conname = 'refund_case_effect_outcome'), 'true');
SELECT pg_temp.assert_eq('S6d', 'V-1: one reversal per purchase (its primary key) and every cause recorded once',
  (SELECT count(*)::text FROM pg_constraint WHERE conname IN ('subscription_purchase_reversal_pkey', 'subscription_purchase_reversal_cause_once')), '2');
SELECT pg_temp.expect_error('S6d', 'a refund cause names a completed case', $$INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "refundCaseId") VALUES (gen_random_uuid(), 'refund_completion', NULL)$$, '23514');
SELECT pg_temp.assert_eq('S6d', 'one refund-origin obligation per completed case (and one per request, unchanged)',
  (SELECT count(*)::text FROM pg_indexes WHERE indexname IN ('cash_return_obligation_refund_case_unique') AND indexdef LIKE '%UNIQUE%'), '1');
SELECT pg_temp.assert_eq('S6d', 'no artificial deadline: a refund-origin obligation adds no settleBy or overdue column',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name = 'cash_return_obligation' AND column_name ~* '(settleby|deadline|overdue|due)'), '0');
SELECT pg_temp.assert_eq('S6d', 'T2 is the S5d model, unchanged: it counts every unresolved obligation, whatever its origin',
  (SELECT (prosrc NOT LIKE '%origin%')::text FROM pg_proc WHERE proname = 'billing_assistance_restrictions'), 'true');

-- ------------------------------------------------------------------------------------------------------------- S6e-D dispute losses (0037)
-- The effects run end to end in test/refund-cases.e2e-spec.ts (Core V2 S6e-D block); here, the guards that need no purchase fixture.
SELECT pg_temp.expect_error('S6e-D', 'R6E-5: a loss names a payment request Billing issued for that payment', $$INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency,
  "chargebackFactId", "chargebackAmount", "chargebackCurrency", "lostAt", source) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'TND', gen_random_uuid(), 1, 'TND', now(), 'reconciliation')$$, '23514', 'payment_dispute_loss_payment');
SELECT pg_temp.assert_eq('S6e-D', 'R6E-5: loss amounts are safe positive integers',
  (SELECT (pg_get_constraintdef(oid) LIKE '%9007199254740991%')::text FROM pg_constraint WHERE conname = 'payment_dispute_loss_amounts'), 'true');
SELECT pg_temp.assert_eq('S6e-D', 'R6E-5: a loss is recorded only with its verified chargeback fact (NOT NULL, unique)',
  (SELECT (a.attnotnull AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = a.attrelid AND c.contype = 'u' AND a.attnum = ANY (c.conkey)))::text
     FROM pg_attribute a WHERE a.attrelid = 'payment_dispute_loss'::regclass AND a.attname = 'chargebackFactId'), 'true');
SELECT pg_temp.assert_eq('S6e-D', 'R6E-6: an event-sourced loss names its verified event; a reconciled one does not',
  (SELECT (pg_get_constraintdef(oid) LIKE '%eventId%')::text FROM pg_constraint WHERE conname = 'payment_dispute_loss_source'), 'true');
SELECT pg_temp.expect_error('S6e-D', 'an effect needs a recorded loss', $$INSERT INTO dispute_loss_effect ("disputeId", outcome, reason) VALUES (gen_random_uuid(), 'none', 'not_a_personal_purchase')$$, '23503');
SELECT pg_temp.assert_eq('S6e-D', 'R6E-5: the effect outcomes are exactly reversed_purchase and none (assisted preserved, already reversed, no Personal purchase)',
  (SELECT (pg_get_constraintdef(oid) LIKE '%assisted_purchase_preserved%' AND pg_get_constraintdef(oid) LIKE '%already_reversed%' AND pg_get_constraintdef(oid) LIKE '%not_a_personal_purchase%')::text
     FROM pg_constraint WHERE conname = 'dispute_loss_effect_shape'), 'true');
SELECT pg_temp.expect_error('S6e-D', 'FC-4: a chargeback cause names its verified loss (never a refund case)', $$INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "refundCaseId") VALUES (gen_random_uuid(), 'final_lost_chargeback', NULL)$$, '23514');
SELECT pg_temp.expect_error('S6e-D', 'FC-4: a refund cause never names a dispute', $$INSERT INTO subscription_purchase_reversal_cause ("purchaseId", cause, "disputeId") VALUES (gen_random_uuid(), 'refund_completion', gen_random_uuid())$$, '23514');
SELECT pg_temp.assert_eq('S6e-D', 'V-1: every cause (refund case or dispute) recorded once per purchase',
  (SELECT (pg_get_constraintdef(oid) LIKE '%disputeId%' AND pg_get_constraintdef(oid) LIKE '%refundCaseId%')::text FROM pg_constraint WHERE conname = 'subscription_purchase_reversal_cause_once'), 'true');
SELECT pg_temp.assert_eq('S6e-D', 'no S6f: a dispute loss opens no obligation and no restriction (T2/T3 unchanged)',
  (SELECT (prosrc NOT LIKE '%dispute%')::text FROM pg_proc WHERE proname = 'billing_assistance_restrictions'), 'true');
SELECT pg_temp.assert_eq('S6e-D', 'FC-6: the only financial-loss tables are S6h-B''s loss and its append-only adjustments',
  (SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public' AND tablename ~ 'financial_loss'), 'financial_loss,financial_loss_adjustment');
SELECT pg_temp.assert_eq('S6e-D', 'the verified-origin record admits payment.dispute.lost (and no other dispute event; S6h-B: and the late success)',
  (SELECT (pg_get_constraintdef(oid) LIKE '%payment.dispute.lost%' AND pg_get_constraintdef(oid) NOT LIKE '%payment.dispute.opened%' AND pg_get_constraintdef(oid) LIKE '%payment.late_success.recorded%')::text FROM pg_constraint WHERE conname = 'payment_event_origin_name'), 'true');

-- ------------------------------------------------------------------------------------------------------------- S6e-H fraud holds (0038)
-- The lifecycle and C-1 compensation run end to end in test/refund-cases.e2e-spec.ts (Core V2 S6e-H block); here, the schema's own rules.
SELECT pg_temp.assert_eq('S6e-H', 'H-4: the review window is exactly 14 days after placement (CHECK)',
  (SELECT (pg_get_constraintdef(oid) LIKE '%14 days%')::text FROM pg_constraint WHERE conname = 'fraud_hold_review_window'), 'true');
SELECT pg_temp.assert_eq('S6e-H', 'H-1: a hold names one personal subscription of exactly its beneficiary and product (composite FK)',
  (SELECT (contype = 'f' AND pg_get_constraintdef(oid) LIKE '%personal_subscription(id, "userId", "productId")%')::text FROM pg_constraint WHERE conname = 'fraud_hold_subscription'), 'true');
SELECT pg_temp.expect_error('S6e-H', 'H-1: a hold of an unknown subscription is refused', $$INSERT INTO fraud_hold (id, "personalSubscriptionId", "companyId", "platformId", "productId", "beneficiaryUserId", reason, "placedByUserId", "receiptId", "placedAt", "expiresAt")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'u', 'account_takeover', gen_random_uuid(), gen_random_uuid(), now(), now() + interval '14 days')$$, '23514', 'fraud_hold_scope');
SELECT pg_temp.assert_eq('S6e-H', 'H-3: a hold commits only with evidence (deferred constraint trigger)',
  (SELECT (tgdeferrable AND tginitdeferred)::text FROM pg_trigger WHERE tgname = 'fraud_hold_06_evidence'), 'true');
SELECT pg_temp.assert_eq('S6e-H', 'H-3: one hold per evidence grant; one placement per Auth receipt; one release per hold and per receipt',
  (SELECT count(*)::text FROM pg_constraint WHERE conname IN ('fraud_hold_evidence_grantId_key', 'fraud_hold_receiptId_key', 'fraud_hold_release_pkey', 'fraud_hold_release_receiptId_key')), '4');
SELECT pg_temp.assert_eq('S6e-H', 'H-5 / C-1: compensation evidence never exceeds the 14-day window, one per hold',
  (SELECT (pg_get_constraintdef(oid) LIKE '%1209600000%')::text FROM pg_constraint WHERE conname = 'fraud_hold_compensation_denied'), 'true');
SELECT pg_temp.assert_eq('S6e-H', 'C-1: no compensation becomes a purchase, a reversal or an obligation (no fraud-hold reference in the ledger tables)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('subscription_purchase', 'subscription_purchase_reversal', 'cash_return_obligation', 'payment_request') AND column_name ~* 'hold'), '0');
SELECT pg_temp.assert_eq('S6e-H', 'H-6: the K-3 fold is unchanged: billing_personal_spans knows nothing of holds',
  (SELECT (prosrc NOT LIKE '%fraud%')::text FROM pg_proc WHERE proname = 'billing_personal_spans'), 'true');
SELECT pg_temp.assert_eq('S6e-H', 'every fraud-hold table is append-only (an update/delete guard on each)',
  (SELECT count(DISTINCT tgrelid)::text FROM pg_trigger WHERE tgname LIKE '%_10_append_only' AND tgrelid::regclass::text IN ('fraud_hold', 'fraud_hold_evidence', 'fraud_hold_release', 'fraud_hold_expiry', 'fraud_hold_compensation')), '5');

-- ------------------------------------------------------------------------------------------------------------- S6f recovery (0039)
-- Obligations, settlement, recovery payments, surplus and both resolution paths run end to end in test/recovery.e2e-spec.ts; here, the schema's own rules.
SELECT pg_temp.expect_error('S6f', 'R6F-3 / R6F-8: an obligation needs the verified loss of an assisted purchase', $$INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 100, 'TND')$$, '23514', 'recovery_obligation_basis');
SELECT pg_temp.assert_eq('S6f', 'R6F-8: one obligation per verified loss; one review per loss; one recovery per payment request and per receipt (S6h-B: and per late success)',
  (SELECT count(*)::text FROM pg_constraint WHERE conname IN ('recovery_obligation_disputeId_key', 'recovery_review_pkey', 'recovery_payment_receiptId_key', 'recovery_payment_lateSuccessId_key')), '4');
SELECT pg_temp.assert_eq('S6f', 'R6F-8 (S6h-B): one recovery payment per payment request''s APPLIED success (a late success is its own)',
  (SELECT (indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%receiptId%')::text FROM pg_indexes WHERE indexname = 'recovery_payment_request_success'), 'true');
SELECT pg_temp.assert_eq('S6f', 'R6F-3 Option A / R6F-4: review reasons are the two approved exclusions only',
  (SELECT (pg_get_constraintdef(oid) LIKE '%partial_chargeback%' AND pg_get_constraintdef(oid) LIKE '%refund_completed%')::text FROM pg_constraint WHERE conname = 'recovery_review_reason'), 'true');
SELECT pg_temp.assert_eq('S6f', 'B8: the database splits a recovery payment into principal (never above the outstanding) and surplus',
  (SELECT (prosrc LIKE '%LEAST(NEW.amount, outstanding)%')::text FROM pg_proc WHERE proname = 'billing_recovery_payment_insert_guard'), 'true');
SELECT pg_temp.assert_eq('S6f', 'B8: a recovery payment is only the applied, verified payment.succeeded of its paid request',
  (SELECT (prosrc LIKE '%payment.succeeded%' AND prosrc LIKE '%applied%' AND prosrc LIKE '%paid%')::text FROM pg_proc WHERE proname = 'billing_recovery_payment_insert_guard'), 'true');
SELECT pg_temp.assert_eq('S6f', 'DB-13: a channel is open or uncertain until its request is paid, failed, cancelled, expired or rejected (derived, never stored)',
  (SELECT (prosrc LIKE '%paid%' AND prosrc LIKE '%failed%' AND prosrc LIKE '%expired%')::text FROM pg_proc WHERE proname = 'billing_recovery_channel_active'), 'true');
SELECT pg_temp.assert_eq('S6f', 'BIL-26: T3 is derived from open recovery obligations; inactive stays reserved',
  (SELECT (prosrc LIKE '%recovery_obligation%' AND prosrc LIKE '%''T3''%' AND prosrc NOT LIKE '%''inactive''%')::text FROM pg_proc WHERE proname = 'billing_assistance_restrictions'), 'true');
SELECT pg_temp.assert_eq('S6f', 'R-1: a surplus is never revenue, offset or expiring (no such column on any recovery table)',
  (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name ~ '^recovery_' AND column_name ~* '(expir|offset|revenue|writeoff|write_off)'), '0');
SELECT pg_temp.assert_eq('S6f', 'R6F-5: one external record and one confirmation per surplus; one Auth receipt and one File grant per record; one refund per surplus',
  (SELECT count(*)::text FROM pg_constraint WHERE conname IN ('recovery_surplus_external_pkey', 'recovery_surplus_external_receiptId_key', 'recovery_surplus_external_grantId_key',
    'recovery_surplus_confirmation_pkey', 'recovery_surplus_refund_pkey', 'recovery_surplus_refund_refundCaseId_key')), '6');
SELECT pg_temp.assert_eq('S6f', 'R-3b: a confirmation needs the external record (FK); the recorder never confirms (guard)',
  (SELECT (contype = 'f')::text FROM pg_constraint WHERE conrelid = 'recovery_surplus_confirmation'::regclass AND contype = 'f' LIMIT 1), 'true');
SELECT pg_temp.assert_eq('S6f', 'R6F-7 / FC: no recovery or FinancialLoss table beyond the approved eight',
  (SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ~ '^recovery_' OR table_name ~* 'financial_loss|write_?off')), '10'); -- + S6h-B: financial_loss, financial_loss_adjustment
SELECT pg_temp.assert_eq('S6f', 'every recovery ledger table is append-only (an update/delete guard on each)',
  (SELECT count(DISTINCT tgrelid)::text FROM pg_trigger WHERE tgname LIKE '%_10_append_only' AND tgrelid::regclass::text IN ('recovery_review', 'recovery_payment', 'recovery_surplus',
    'recovery_surplus_external', 'recovery_surplus_confirmation', 'recovery_surplus_refund')), '6');
SELECT pg_temp.assert_eq('S6f', 'obligations and channels are never deleted (no-delete guards)',
  (SELECT count(DISTINCT tgrelid)::text FROM pg_trigger WHERE tgname LIKE '%_90_no_delete' AND tgrelid::regclass::text IN ('recovery_obligation', 'recovery_settlement_channel')), '2');

-- ------------------------------------------------------------------------------------------------------------- S6g late settlement application (0040)
-- Attestation, application (both evidence paths), refusals, the refund after an application and the obligation history run end to end in
-- test/late-settlements.e2e-spec.ts; here, the schema's own rules.
SELECT pg_temp.assert_eq('S6g', 'Option A: the absolute one-obligation-per-request rule is gone; one LIVE obligation per request remains (partial unique index)',
  (SELECT (NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_return_obligation_assistanceRequestId_key')
           AND pg_get_indexdef('cash_return_obligation_live_unique'::regclass) LIKE '%UNIQUE%WHERE%open%return_reported%')::text), 'true');
SELECT pg_temp.assert_eq('S6g', 'L-4: superseded_by_settlement is a terminal state reached only from open, only by an application (the transition guard)',
  (SELECT (prosrc LIKE '%superseded_by_settlement%' AND prosrc LIKE '%late_settlement_application%' AND prosrc LIKE '%OLD.status <> ''open''%')::text
     FROM pg_proc WHERE proname = 'billing_cash_return_obligation_transition_guard'), 'true');
SELECT pg_temp.assert_eq('S6g', 'L-5: one application per late settlement and per request; one per Auth receipt; one per superseded obligation and attestation',
  (SELECT count(*)::text FROM pg_constraint WHERE conname IN ('late_settlement_application_lateSettlementId_key', 'late_settlement_application_assistanceRequestId_key',
    'late_settlement_application_receiptId_key', 'late_settlement_application_obligationId_key', 'late_settlement_application_attestationId_key')), '5');
SELECT pg_temp.assert_eq('S6g', 'R6G-3: the closed reason codes; the attested one needs its attestation',
  (SELECT (pg_get_constraintdef(oid) LIKE '%cash_not_returned_attested%' AND pg_get_constraintdef(oid) LIKE '%cash_not_returned_evidenced%')::text
     FROM pg_constraint WHERE conname = 'late_settlement_application_reason'), 'true');
SELECT pg_temp.assert_eq('S6g', 'L-4 / L-6 / R6G-2 / R6G-7: the application guard refuses a purchase, a confirmed or reported return, a dispute, a refund, a contrary attestation and an unknown instant',
  (SELECT (prosrc LIKE '%late_settlement_purchase_exists%' AND prosrc LIKE '%late_settlement_cash_return_confirmed%' AND prosrc LIKE '%late_settlement_cash_return_reported%'
       AND prosrc LIKE '%late_settlement_dispute_open%' AND prosrc LIKE '%late_settlement_refund_exists%' AND prosrc LIKE '%late_settlement_evidence_contradictory%'
       AND prosrc LIKE '%late_settlement_time_unavailable%')::text FROM pg_proc WHERE proname = 'billing_late_settlement_application_guard'), 'true');
SELECT pg_temp.assert_eq('S6g', 'an application commits only with its purchase, settled request and superseded obligation (deferred)',
  (SELECT (tgdeferrable AND tginitdeferred)::text FROM pg_trigger WHERE tgname = 'late_settlement_application_95_commit'), 'true');
SELECT pg_temp.assert_eq('S6g', 'R6G-5: only an assisted purchase carries an application instant, never before Payment''s instant; the K-3 fold anchors it there',
  (SELECT ((SELECT pg_get_constraintdef(oid) LIKE '%assisted_settlement%' FROM pg_constraint WHERE conname = 'subscription_purchase_applied')
       AND (SELECT prosrc LIKE '%coalesce(sp."appliedAt", sp."settledAt")%' FROM pg_proc WHERE proname = 'billing_personal_spans'))::text), 'true');
SELECT pg_temp.assert_eq('S6g', 'every S6g evidence table is append-only (an update/delete guard on each)',
  (SELECT count(DISTINCT tgrelid)::text FROM pg_trigger WHERE tgname LIKE '%_10_append_only' AND tgrelid::regclass::text IN ('late_settlement_attestation', 'late_settlement_application', 'late_settlement_evidence')), '3');
SELECT pg_temp.assert_eq('S6g', 'new late settlements keep Payment''s original instant (insert guard)',
  (SELECT (prosrc LIKE '%assistance_late_settlement_settled_at%')::text FROM pg_proc WHERE proname = 'billing_assistance_late_settlement_guard'), 'true');

-- ======================================================= Core V2 R6H-5: capture-specific refund cases (0041) ----
-- The eligible capture-specific paths are exercised end to end by test/refund-cases.e2e-spec.ts; here, the guards that need no fixture.
SELECT pg_temp.expect_error('R6H-5', 'a capture-specific case needs its payment''s own request and a capture basis', $$INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", eligibility,
    "companyId", "platformId", amount, currency, reason, "openedBy", "captureFactId", "captureBasis")
  VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'capture_specific', gen_random_uuid(), gen_random_uuid(), 100, 'TND', 'duplicate_charge', gen_random_uuid(), gen_random_uuid(), 'late_capture')$$, '23514');
SELECT pg_temp.assert_eq('R6H-5', 'one live ORDINARY case per payment (FC-3, S6a name kept); one live case per capture fact',
  (SELECT string_agg(indexname || ':' || (indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%open%' AND indexdef LIKE '%completed%')::text
      || ':' || (indexdef LIKE '%capture_specific%')::text, ',' ORDER BY indexname)
     FROM pg_indexes WHERE indexname IN ('refund_case_payment_active_unique', 'refund_case_capture_active_unique')),
  'refund_case_capture_active_unique:true:false,refund_case_payment_active_unique:true:true');
SELECT pg_temp.assert_eq('R6H-5', 'a capture-specific case names one capture and a basis; an ordinary one never does and keeps its receipt',
  (SELECT (pg_get_constraintdef(oid) LIKE '%captureFactId%' AND pg_get_constraintdef(oid) LIKE '%unrouted_capture%')::text FROM pg_constraint WHERE conname = 'refund_case_capture_shape'), 'true');
SELECT pg_temp.assert_eq('R6H-5', 'its only commercial effect is none / capture_refunded',
  (SELECT count(*)::text FROM pg_trigger WHERE tgname = 'refund_case_effect_06_capture_basis'), '1');

-- ======================================================= Core V2 S6h-B: reconciliation cases, late successes, FinancialLoss (0042) ----
-- The financial paths are exercised end to end by test/recovery.e2e-spec.ts and test/late-settlements.e2e-spec.ts; here, the guards alone.
\o /dev/null
INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", detail) VALUES ('refund_discrepancy', '00000000-0000-4000-8000-0000000b6a01', gen_random_uuid(), 'x') RETURNING id AS rc1 \gset
INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId") VALUES ('late_success', '00000000-0000-4000-8000-0000000b6a02', gen_random_uuid()) RETURNING id AS rc2 \gset
\o
SELECT pg_temp.expect_error('S6h-B', 'R6H-1: one case per (type, evidence)', $$INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId") VALUES ('refund_discrepancy', '00000000-0000-4000-8000-0000000b6a01', gen_random_uuid())$$, '23505');
SELECT pg_temp.expect_error('S6h-B', 'a case is append-only (no edit)', format($$UPDATE reconciliation_case SET detail = 'y' WHERE id = %L$$, :'rc1'), '23514');
SELECT pg_temp.expect_error('S6h-B', 'a case is never deleted', format($$DELETE FROM reconciliation_case WHERE id = %L$$, :'rc1'), '23514');
SELECT pg_temp.expect_error('S6h-B', 'R6H-2: a financial case is never acknowledged away', format($$INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason)
  VALUES (%L, 'acknowledged', gen_random_uuid(), 'reviewed_no_financial_effect')$$, :'rc2'), '23514', 'reconciliation_case_resolution_evidence');
SELECT pg_temp.expect_error('S6h-B', 'R6H-2: a resolution needs the evidence its kind names', format($$INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId")
  VALUES (%L, 'refund_completed', gen_random_uuid())$$, :'rc2'), '23514', 'reconciliation_case_resolution_evidence');
SELECT pg_temp.expect_error('S6h-B', 'R6H-2: an acknowledgement is the Owner''s, with a bounded reason', format($$INSERT INTO reconciliation_case_resolution ("caseId", kind)
  VALUES (%L, 'acknowledged')$$, :'rc1'), '23514', 'reconciliation_case_resolution_acknowledged');
SELECT pg_temp.expect_ok('S6h-B', 'R6H-2: a review-only case acknowledged by the Owner', format($$INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason)
  VALUES (%L, 'acknowledged', gen_random_uuid(), 'provider_statement_reviewed')$$, :'rc1'));
SELECT pg_temp.expect_error('S6h-B', 'resolved once', format($$INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason)
  VALUES (%L, 'acknowledged', gen_random_uuid(), 'provider_statement_reviewed')$$, :'rc1'), '23505');
SELECT pg_temp.expect_error('S6h-B', 'a resolution is append-only', format($$UPDATE reconciliation_case_resolution SET reason = 'duplicate_evidence_reviewed' WHERE "caseId" = %L$$, :'rc1'), '23514');
SELECT pg_temp.expect_error('S6h-B', 'R6H-4: a late success only of a payment Billing requested', $$INSERT INTO payment_late_success ("lateSuccessId", "paymentId", "paymentRequestId", amount, currency, "paymentStatus", "recordedAt", source)
  SELECT gen_random_uuid(), gen_random_uuid(), id, 100, 'TND', 'failed', now(), 'reconciliation' FROM payment_request LIMIT 1$$, '23514', 'payment_late_success_payment');
SELECT pg_temp.expect_error('S6h-B', 'FC-6: a write-off only of an open obligation''s outstanding principal', $$INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "obligationId", amount, currency, "recordedByUserId", "receiptId", "consumeRef")
  SELECT 'recovery_write_off', gen_random_uuid(), gen_random_uuid(), NULL, 1, 'TND', gen_random_uuid(), gen_random_uuid(), gen_random_uuid()$$, '23514', 'financial_loss_write_off');
SELECT pg_temp.expect_error('S6h-B', 'FC-6: a direct chargeback loss needs its verified loss', $$INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", "disputeId", amount, currency)
  VALUES ('direct_chargeback_write_off', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, 1, 'TND')$$, '23514', 'financial_loss_evidence');
SELECT pg_temp.expect_error('S6h-B', 'FC-6: an over-return only of this Company''s payment', $$INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", amount, currency)
  VALUES ('over_return', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'TND')$$, '23514', 'financial_loss_evidence');
SELECT pg_temp.assert_eq('S6h-B', 'a recovery payment is evidenced by exactly one of: the applied success, a late success',
  (SELECT (pg_get_constraintdef(oid) LIKE '%receiptId%' AND pg_get_constraintdef(oid) LIKE '%lateSuccessId%')::text FROM pg_constraint WHERE conname = 'recovery_payment_evidence'), 'true');
SELECT pg_temp.assert_eq('S6h-B', 'one ordinary recovery payment per request; one per late success (so per provider fact)',
  (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'recovery_payment' AND indexdef LIKE '%UNIQUE%' AND indexname IN ('recovery_payment_request_success', 'recovery_payment_lateSuccessId_key')),
  'recovery_payment_lateSuccessId_key,recovery_payment_request_success');
SELECT pg_temp.assert_eq('S6h-B', 'losses and adjustments are append-only',
  (SELECT count(*)::text FROM pg_trigger WHERE tgname IN ('financial_loss_10_append_only', 'financial_loss_adjustment_10_append_only', 'payment_late_success_10_append_only')), '3');

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
