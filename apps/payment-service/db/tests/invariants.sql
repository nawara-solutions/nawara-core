-- Database-level invariant tests for payment-service's migrations. Run via db/tests/run.sh (fresh scratch DB).
-- Proves what the DATABASE refuses regardless of application code — the financial invariants of
-- docs/sdd/payment-service.md section 4.10 that this phase enforces at the schema level.
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

CREATE TEMP TABLE results (id text, name text, ok boolean, detail text);

-- expect_error: stmt must fail with exactly this SQLSTATE. Runs in a subtransaction that is ALWAYS rolled back
-- (also when it unexpectedly succeeds), so a broken invariant shows up as one FAIL row, not corrupted fixture state.
CREATE FUNCTION pg_temp.expect_error(tid text, tname text, stmt text, want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE EXCEPTION 'statement unexpectedly succeeded' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = 'XX999' THEN
      INSERT INTO results VALUES (tid, tname, false, 'expected SQLSTATE '||want||' but statement succeeded');
    ELSE
      INSERT INTO results VALUES (tid, tname, SQLSTATE = want,
        CASE WHEN SQLSTATE = want THEN NULL ELSE 'wanted '||want||' got '||SQLSTATE||': '||SQLERRM END);
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

-- Fixture: a valid payment (gateway settlement, user payer, organization seller). Runs in the caller's transaction.
CREATE FUNCTION pg_temp.new_payment(req uuid, org uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
  INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency)
  VALUES ('billing-service', req, 'invoice', 'inv-1', 'user', 'user-1', 'organization', org::text, org, 1000, 'TND')
  RETURNING id INTO pid;
  RETURN pid;
END $$;

CREATE FUNCTION pg_temp.new_attempt(pid uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE aid uuid;
BEGIN
  INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), pid, n, 'test') RETURNING id INTO aid;
  RETURN aid;
END $$;

\o

-- ============================================================================== FI-01 ----
SELECT pg_temp.expect_error('FI-01', 'zero amount is refused',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', 'o', 0, 'TND')$$, '23514');
SELECT pg_temp.expect_error('FI-01', 'negative amount is refused',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', 'o', -1, 'TND')$$, '23514');

-- ============================================================================= contract ----
SELECT pg_temp.expect_error('CONTRACT', 'payer cannot equal seller',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'same', 'user', 'same', 100, 'TND')$$, '23514');
SELECT pg_temp.expect_error('CONTRACT', 'currency must be upper case',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', 'o', 100, 'tnd')$$, '23514');
SELECT pg_temp.expect_error('CONTRACT', 'currency must exist in the reference table',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', 'o', 100, 'XXX')$$, '23503');
SELECT pg_temp.expect_error('CONTRACT', 'organizationId must equal sellerId when the seller is an organization',
  format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', %L, %L, 100, 'TND')$$,
    '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a2'), '23514');

-- =================================================================== natural key (3.3) ----
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1') AS pay1 \gset
SELECT pg_temp.expect_error('NATKEY', 'the same (producer, paymentRequestId) twice is refused, not silently replayed at the DB level',
  format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency)
    VALUES ('billing-service', %L, 'invoice', 'inv-1', 'user', 'user-1', 'organization', %L, %L, 1000, 'TND')$$,
    '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1'), '23505');

-- ==================================================================== FI-02: immutability ----
SELECT pg_temp.expect_error('FI-02', 'amount cannot change after creation',
  format($$UPDATE payment SET amount = 2000 WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.expect_error('FI-02', 'currency cannot change after creation',
  format($$UPDATE payment SET currency = 'USD' WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.expect_error('FI-02', 'payerId cannot change after creation',
  format($$UPDATE payment SET "payerId" = 'someone-else' WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.expect_error('FI-02', 'paymentRequestId cannot change after creation',
  format($$UPDATE payment SET "paymentRequestId" = gen_random_uuid() WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.expect_ok('FI-02', 'status (a mutable field) can still change',
  format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'pay1'));

-- ============================================================ FI-11 / state machine (5.1) ----
SELECT pg_temp.expect_error('FI-11', 'created -> succeeded is not a valid transition (success only from pending)',
  format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$,
    pg_temp.new_payment('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1')), '23514');
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1') AS pay3 \gset
SELECT pg_temp.expect_ok('SM', 'created -> pending is valid', format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'pay3'));
SELECT pg_temp.expect_ok('SM', 'pending -> succeeded is valid', format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay3'));
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> pending is refused',
  format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> cancelled is refused',
  format($$UPDATE payment SET status = 'cancelled' WHERE id = %L$$, :'pay3'), '23514');

-- ======================================================= FI-03/FI-04: succeededAttemptId ----
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1') AS pay4 \gset
SELECT pg_temp.new_attempt(:'pay4', 1) AS att4 \gset
SELECT pg_temp.expect_error('FI-04', 'succeededAttemptId cannot reference an attempt that has not succeeded yet',
  format($$UPDATE payment SET "succeededAttemptId" = %L WHERE id = %L$$, :'att4', :'pay4'), '23514');
SELECT pg_temp.expect_ok('SM', 'the attempt itself can move initiated -> submitted -> succeeded',
  format($$UPDATE payment_attempt SET status = 'submitted' WHERE id = %L$$, :'att4'));
SELECT pg_temp.expect_ok('SM', 'submitted -> succeeded', format($$UPDATE payment_attempt SET status = 'succeeded' WHERE id = %L$$, :'att4'));
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1') AS pay5 \gset
SELECT pg_temp.new_attempt(:'pay5', 1) AS att5_other_payment \gset
SELECT pg_temp.expect_error('FI-04', 'succeededAttemptId cannot reference an attempt belonging to ANOTHER payment',
  format($$UPDATE payment SET "succeededAttemptId" = %L WHERE id = %L$$, :'att5_other_payment', :'pay4'), '23514');
SELECT pg_temp.expect_ok('FI-04', 'succeededAttemptId CAN reference a succeeded attempt of the same payment',
  format($$UPDATE payment SET status = 'pending', "succeededAttemptId" = %L WHERE id = %L$$, :'att4', :'pay4'));
SELECT pg_temp.expect_ok('FI-11-EFFECT', 'setting succeededAttemptId together with status=succeeded is the normal path',
  format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay4'));
SELECT pg_temp.expect_error('FI-04', 'succeededAttemptId is set once and cannot change',
  format($$UPDATE payment SET "succeededAttemptId" = %L WHERE id = %L$$, :'att5_other_payment', :'pay4'), '23514');

-- =========================================================== FI-09 / attempt uniqueness ----
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000a1') AS pay6 \gset
SELECT pg_temp.new_attempt(:'pay6', 1) AS att6 \gset
SELECT pg_temp.expect_ok('FI-09-SETUP', 'an attempt can record its provider transaction id',
  format($$UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx-1' WHERE id = %L$$, :'att6'));
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000a1') AS pay7 \gset
SELECT pg_temp.new_attempt(:'pay7', 1) AS att7 \gset
SELECT pg_temp.expect_error('FI-09', 'the same (provider, providerTransactionId) cannot belong to a second attempt',
  format($$UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx-1' WHERE id = %L$$, :'att7'), '23505');

-- ================================================= "one open attempt per payment" (5.1) ----
SELECT pg_temp.expect_error('OPENATTEMPT', 'a second open attempt on the same payment is refused',
  format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), %L, 2, 'test')$$, :'pay7'), '23505');

-- ==================================================================== attempt immutable ----
SELECT pg_temp.expect_error('ATTEMPT-IMMUTABLE', 'provider cannot change after creation',
  format($$UPDATE payment_attempt SET provider = 'other' WHERE id = %L$$, :'att6'), '23514');
SELECT pg_temp.expect_error('ATTEMPT-SM', 'submitted -> initiated is not a valid transition',
  format($$UPDATE payment_attempt SET status = 'initiated' WHERE id = %L$$, :'att6'), '23514');

\o

-- ---------------------------------------------------------------------------- verdict ----
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
