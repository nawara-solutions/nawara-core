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
  INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose)
  VALUES ('billing-service', req, 'invoice', 'inv-1', 'user', 'user-1', 'organization', org::text, org, 1000, 'TND', 'non_entitlement')
  RETURNING id INTO pid;
  RETURN pid;
END $$;

CREATE FUNCTION pg_temp.new_attempt(pid uuid, n int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE aid uuid;
BEGIN
  INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), pid, n, 'test') RETURNING id INTO aid;
  RETURN aid;
END $$;

-- Fixture: a `pending` payment whose one attempt has genuinely succeeded (the state right before a payment settles).
CREATE FUNCTION pg_temp.pending_with_succeeded_attempt(req uuid, org uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pid uuid; aid uuid;
BEGIN
  pid := pg_temp.new_payment(req, org);
  aid := pg_temp.new_attempt(pid, 1);
  UPDATE payment SET status = 'pending' WHERE id = pid;
  UPDATE payment_attempt SET status = 'submitted' WHERE id = aid;
  UPDATE payment_attempt SET status = 'succeeded' WHERE id = aid;
  RETURN pid;
END $$;

-- Fixture: the late-success shape (SDD 5.1). The attempt failed by INFERENCE (or, when `inferred` is false, was confirmed
-- failed by the provider), the payment returned to `created`, and the attempt then succeeded (only reachable when inferred).
CREATE FUNCTION pg_temp.late_success_shape(req uuid, org uuid, inferred boolean) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE pid uuid; aid uuid;
BEGIN
  pid := pg_temp.new_payment(req, org);
  aid := pg_temp.new_attempt(pid, 1);
  UPDATE payment SET status = 'pending' WHERE id = pid;
  UPDATE payment_attempt SET status = 'failed', "failureInferred" = inferred, "failureClass" = 'terminal', "failureCode" = 'x' WHERE id = aid;
  UPDATE payment SET status = 'created' WHERE id = pid;
  IF inferred THEN UPDATE payment_attempt SET status = 'succeeded' WHERE id = aid; END IF;
  RETURN pid;
END $$;

\o

-- ============================================================================== FI-01 ----
SELECT pg_temp.expect_error('FI-01', 'zero amount is refused',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', 0, 'TND')$$, '23514');
SELECT pg_temp.expect_error('FI-01', 'negative amount is refused',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', -1, 'TND')$$, '23514');

-- ============================================================================= contract ----
SELECT pg_temp.expect_error('CONTRACT', 'payer cannot equal seller',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'same', 'user', 'same', 100, 'TND')$$, '23514');
SELECT pg_temp.expect_error('CONTRACT', 'currency must be upper case',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', 100, 'tnd')$$, '23514');
SELECT pg_temp.expect_error('CONTRACT', 'currency must exist in the reference table',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', 100, 'XXX')$$, '23503');
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
-- created -> succeeded is allowed ONLY as the late success of an attempt failed by inference (SDD 5.1); a bare UPDATE is refused.
SELECT pg_temp.late_success_shape('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', true) AS pay2 \gset
SELECT pg_temp.expect_ok('SM', 'created -> succeeded is valid (late success after an inferred failure)',
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = (SELECT id FROM payment_attempt WHERE "paymentId" = %L) WHERE id = %L$$, :'pay2', :'pay2'));
SELECT pg_temp.late_success_shape('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', false) AS pay_confirmed \gset
SELECT pg_temp.expect_error('SM', 'created -> succeeded is refused when the earlier failure was provider-CONFIRMED (no inferred success to point at)',
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = %L$$, :'pay_confirmed'), '23514');
SELECT pg_temp.expect_error('SM', 'created -> succeeded is refused with no succeeded attempt at all',
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = %L$$,
    pg_temp.new_payment('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1')), '23514');
SELECT pg_temp.expect_error('FI-11', 'created -> failed is refused (S4c: only after a CONFIRMED inferred failure; checked below)',
  format($$UPDATE payment SET status = 'failed' WHERE id = %L$$,
    pg_temp.new_payment('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a1')), '23514');
SELECT pg_temp.pending_with_succeeded_attempt('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1') AS pay3 \gset
SELECT pg_temp.expect_error('SM', 'pending -> succeeded without a settlement method is refused',
  format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-03', 'a gateway settlement must name its succeeded attempt',
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_ok('SM', 'pending -> succeeded is valid',
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = (SELECT id FROM payment_attempt WHERE "paymentId" = %L) WHERE id = %L$$, :'pay3', :'pay3'));
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> pending is refused',
  format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> cancelled is refused',
  format($$UPDATE payment SET status = 'cancelled' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> failed is refused',
  format($$UPDATE payment SET status = 'failed' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> expired is refused',
  format($$UPDATE payment SET status = 'expired' WHERE id = %L$$, :'pay3'), '23514');
SELECT pg_temp.expect_error('FI-11', 'succeeded is terminal: succeeded -> created is refused',
  format($$UPDATE payment SET status = 'created' WHERE id = %L$$, :'pay3'), '23514');

-- Terminal states other than succeeded never reopen, and a late success cannot resurrect them (SDD 5.1: a conflict, not a transition).
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1') AS pay_failed \gset
UPDATE payment SET status = 'pending' WHERE id = :'pay_failed';
UPDATE payment SET status = 'failed' WHERE id = :'pay_failed';
SELECT pg_temp.expect_error('FI-11', 'failed is terminal: failed -> succeeded is refused', format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay_failed'), '23514');
SELECT pg_temp.expect_error('FI-11', 'failed is terminal: failed -> created is refused', format($$UPDATE payment SET status = 'created' WHERE id = %L$$, :'pay_failed'), '23514');
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a1') AS pay_cancelled \gset
UPDATE payment SET status = 'cancelled' WHERE id = :'pay_cancelled';
SELECT pg_temp.expect_error('FI-11', 'cancelled is terminal: cancelled -> succeeded is refused', format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay_cancelled'), '23514');
SELECT pg_temp.expect_error('FI-11', 'cancelled is terminal: cancelled -> pending is refused', format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'pay_cancelled'), '23514');
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000a1') AS pay_expired \gset
UPDATE payment SET status = 'expired' WHERE id = :'pay_expired';
SELECT pg_temp.expect_error('FI-11', 'expired is terminal: expired -> succeeded is refused', format($$UPDATE payment SET status = 'succeeded' WHERE id = %L$$, :'pay_expired'), '23514');
SELECT pg_temp.expect_error('FI-11', 'expired is terminal: expired -> created is refused', format($$UPDATE payment SET status = 'created' WHERE id = %L$$, :'pay_expired'), '23514');

-- revision counts state changes (created = 0; created->pending->succeeded = 2) and updatedAt follows every update.
SELECT pg_temp.assert_eq('REVISION', 'revision counts state changes', (SELECT revision::text FROM payment WHERE id = :'pay3'), '2');

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
  format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway' WHERE id = %L$$, :'pay4'));
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
SELECT pg_temp.expect_error('OPENATTEMPT', 'a second open attempt on the same payment is refused (S4c: by the uncertainty guard first)',
  format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), %L, 2, 'test')$$, :'pay7'), '23514');
-- the unique index still holds on its own, beneath the guard (replica mode: no triggers, indexes enforced)
SET session_replication_role = replica;
SELECT pg_temp.expect_error('OPENATTEMPT', 'beneath the guard, the one-open-attempt index still refuses a second open attempt',
  format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), %L, 2, 'test', false)$$, :'pay7'), '23505');
SET session_replication_role = origin;

-- ==================================================================== attempt immutable ----
SELECT pg_temp.expect_error('ATTEMPT-IMMUTABLE', 'provider cannot change after creation',
  format($$UPDATE payment_attempt SET provider = 'other' WHERE id = %L$$, :'att6'), '23514');
SELECT pg_temp.expect_error('ATTEMPT-SM', 'submitted -> initiated is not a valid transition',
  format($$UPDATE payment_attempt SET status = 'initiated' WHERE id = %L$$, :'att6'), '23514');


-- ============================================================ FI-03 (database level) ----
-- A payment has at most one succeeded attempt: the second one is refused by a unique index, whatever the application does.
SELECT pg_temp.new_payment('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1') AS pay_two \gset
SELECT pg_temp.new_attempt(:'pay_two', 1) AS att_two_a \gset
UPDATE payment_attempt SET status = 'failed', "failureInferred" = true WHERE id = :'att_two_a';
-- S4c (F-6) refuses a second attempt while the first may still settle; this pre-S4c history is simulated in replica mode
SET session_replication_role = replica;
INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), :'pay_two', 2, 'test', false) RETURNING id AS att_two_b \gset
SET session_replication_role = origin;
UPDATE payment_attempt SET status = 'submitted' WHERE id = :'att_two_b';
UPDATE payment_attempt SET status = 'succeeded' WHERE id = :'att_two_b';
SELECT pg_temp.expect_error('FI-03', 'a second succeeded attempt on the same payment is refused (late success of an earlier inferred failure)',
  format($$UPDATE payment_attempt SET status = 'succeeded' WHERE id = %L$$, :'att_two_a'), '23505');

-- ==================================================================== contract (more) ----
SELECT pg_temp.expect_error('CONTRACT', 'an organization seller with NO organizationId is refused (a NULL cannot slip past the CHECK)',
  format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', %L, 100, 'TND')$$, '00000000-0000-0000-0000-0000000000a1'), '23514');
SELECT pg_temp.expect_ok('FI-01', 'the maximum safe integer amount (9007199254740991) is accepted and exact',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', 9007199254740991, 'TND', 'non_entitlement')$$);
SELECT pg_temp.expect_error('FI-15', 'an amount a JSON number cannot carry exactly (2^53) is refused',
  $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency)
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'o', 9007199254740992, 'TND')$$, '23514');
\o

-- ================================================ Core V2 S4a: purpose, beneficiary, liveMode (0010) ----
-- A statement inserting one payment from `payer` (type, id) to a Company seller with the given purpose and beneficiary.
CREATE FUNCTION pg_temp.s4a(ptype text, pid text, purpose text, beneficiary text, live text DEFAULT 'DEFAULT') RETURNS text LANGUAGE sql AS $f$
  -- Core V2 S4e: an Organization payer is the payment's Organization (0016), so the fixture names it as organizationId too
  SELECT format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, "beneficiaryUserId", "liveMode")
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', %L, %L, 'company', 'nawara', %L, 100, 'TND', %L, %L, %s)$$, ptype, pid, CASE WHEN ptype = 'organization' THEN pid END, purpose, beneficiary, live);
$f$;
\o /dev/null
SELECT pg_temp.expect_ok('S4a', 'an Organization subscription paid by a user, no beneficiary', pg_temp.s4a('user', 'u-1', 'organization_subscription', NULL));
SELECT pg_temp.expect_ok('S4a', 'a direct purchase paid by its beneficiary', pg_temp.s4a('user', 'u-1', 'direct_purchase', 'u-1'));
SELECT pg_temp.expect_ok('S4a', 'an ordinary invoice paid by a user', pg_temp.s4a('user', 'u-1', 'non_entitlement', NULL));
SELECT pg_temp.expect_ok('S4a', 'an ordinary invoice paid by a Company', pg_temp.s4a('company', 'acme', 'non_entitlement', NULL));
SELECT pg_temp.expect_ok('S4a', 'DB-15: an assisted settlement paid by an Organization (database-admitted; the API only behind payment.create.organization_payer, S4e)', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'assisted_settlement', 'u-2'));
SELECT pg_temp.expect_ok('S4a', 'DB-15: a recovery settlement paid by an Organization (database-admitted; the API only behind payment.create.organization_payer, S4e)', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'recovery_settlement', NULL));
SELECT pg_temp.expect_error('S4a', 'DB-15: an Organization never pays an ordinary invoice (the prospective B2 narrowing, P-1)', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'non_entitlement', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'DB-15: an Organization never pays an Organization subscription', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'organization_subscription', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'DB-15: an Organization never pays a direct purchase', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'direct_purchase', '00000000-0000-4000-8000-0000000000e1'), '23514');
SELECT pg_temp.expect_error('S4a', 'DB-15: a user never pays an assisted settlement', pg_temp.s4a('user', 'u-1', 'assisted_settlement', 'u-1'), '23514');
SELECT pg_temp.expect_error('S4a', 'DB-15: a Company never pays a recovery settlement', pg_temp.s4a('company', 'acme', 'recovery_settlement', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: a Company never pays an Organization subscription', pg_temp.s4a('company', 'acme', 'organization_subscription', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: a Company never pays a direct purchase', pg_temp.s4a('company', 'acme', 'direct_purchase', 'acme'), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: a direct purchase names its beneficiary', pg_temp.s4a('user', 'u-1', 'direct_purchase', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: a direct purchase''s beneficiary is its payer (never someone else)', pg_temp.s4a('user', 'u-1', 'direct_purchase', 'u-2'), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: an assisted settlement names its beneficiary', pg_temp.s4a('organization', '00000000-0000-4000-8000-0000000000e1', 'assisted_settlement', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: an ordinary invoice names no beneficiary', pg_temp.s4a('user', 'u-1', 'non_entitlement', 'u-1'), '23514');
SELECT pg_temp.expect_error('S4a', 'B2: an Organization subscription names no beneficiary', pg_temp.s4a('user', 'u-1', 'organization_subscription', 'u-1'), '23514');
SELECT pg_temp.expect_error('S4a', 'an unknown purpose is refused', pg_temp.s4a('user', 'u-1', 'gift', NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'a new payment names its purpose', pg_temp.s4a('user', 'u-1', NULL, NULL), '23514');
SELECT pg_temp.expect_error('S4a', 'P-6: a live payment is refused (simulation only)', pg_temp.s4a('user', 'u-1', 'non_entitlement', NULL, 'true'), '23514');
SELECT pg_temp.expect_error('S4a', 'a new payment carries liveMode (an explicit NULL is refused)', pg_temp.s4a('user', 'u-1', 'non_entitlement', NULL, 'NULL'), '23514');
SELECT pg_temp.assert_eq('S4a', 'a new payment is non-live by default (server-derived)',
  (SELECT "liveMode"::text FROM payment WHERE id = :'pay1'), 'false');
SELECT pg_temp.expect_error('S4a', 'S-6: the purpose is immutable', format($$UPDATE payment SET purpose = 'organization_subscription' WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.expect_error('S4a', 'S-6: the beneficiary is immutable', format($$UPDATE payment SET "beneficiaryUserId" = 'u-9' WHERE "beneficiaryUserId" = 'u-1'$$), '23514');
SELECT pg_temp.expect_error('S4a', 'P-6: liveMode is immutable', format($$UPDATE payment SET "liveMode" = NULL WHERE id = %L$$, :'pay1'), '23514');
SELECT pg_temp.new_payment(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1') AS s4a_pay \gset
SELECT pg_temp.new_payment(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1') AS s4a_pay2 \gset
SELECT pg_temp.new_attempt(:'s4a_pay', 9) AS s4a_att \gset
SELECT pg_temp.assert_eq('S4a', 'an attempt takes its payment''s mode', (SELECT "liveMode"::text FROM payment_attempt WHERE id = :'s4a_att'), 'false');
SELECT pg_temp.expect_error('S4a', 'an attempt of a different mode than its payment is refused (and no attempt is live)',
  format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), %L, 10, 'test', true)$$, :'s4a_pay2'), '23514');
SELECT pg_temp.expect_error('S4a', 'an attempt''s mode is immutable', format($$UPDATE payment_attempt SET "liveMode" = NULL WHERE id = %L$$, :'s4a_att'), '23514');
-- A payment created BEFORE S4a (simulated: the insert guard does not fire in replica mode) keeps NULL and is never re-interpreted
SET session_replication_role = replica;
INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, "liveMode")
  VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'organization', 'o-legacy', 'company', 'nawara', 100, 'TND', NULL) RETURNING id AS legacy \gset
SET session_replication_role = origin;
SELECT pg_temp.expect_ok('S4a', 'a historical payment (no purpose, no mode) still moves through its lifecycle', format($$UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = %L$$, :'legacy'));
SELECT pg_temp.expect_error('S4a', 'a historical payment is never given a purpose afterwards', format($$UPDATE payment SET purpose = 'non_entitlement' WHERE id = %L$$, :'legacy'), '23514');
SELECT pg_temp.expect_error('S4a', 'a historical payment is never given a mode afterwards', format($$UPDATE payment SET "liveMode" = false WHERE id = %L$$, :'legacy'), '23514');
SELECT pg_temp.assert_eq('S4a', 'no existing row was backfilled', (SELECT (purpose IS NULL AND "liveMode" IS NULL)::text FROM payment WHERE id = :'legacy'), 'true');
SELECT pg_temp.assert_eq('S4a', 'no Platform on Payment records (ADR-0042 DEC-5)', (SELECT count(*)::text FROM information_schema.columns WHERE table_name IN ('payment', 'payment_attempt') AND column_name ILIKE '%platform%'), '0');
\o

-- ================================================= Core V2 S4b: no cash settlement of a Company seller (0011) ----
-- Records a PASS only when the statement fails on exactly the named constraint (so another guard cannot mask the one under test).
CREATE FUNCTION pg_temp.expect_constraint(tid text, tname text, stmt text, want text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE cn text;
BEGIN
  BEGIN
    EXECUTE stmt;
    INSERT INTO results VALUES (tid, tname, false, 'the statement succeeded');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS cn = CONSTRAINT_NAME;
    INSERT INTO results VALUES (tid, tname, SQLSTATE = '23514' AND cn = want, CASE WHEN SQLSTATE = '23514' AND cn = want THEN NULL ELSE SQLSTATE||' '||coalesce(cn, '-')||': '||SQLERRM END);
  END;
END $f$;
CREATE FUNCTION pg_temp.s4b(seller_type text, seller_id text, status text, method text) RETURNS text LANGUAGE sql AS $f$
  SELECT format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, status, "settledMethod")
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u-1', %L, %L, %s, 100, 'TND', 'non_entitlement', %L, %L)$$,
    seller_type, seller_id, CASE WHEN seller_type = 'organization' THEN quote_literal(seller_id) || '::uuid' ELSE 'NULL' END, status, method);
$f$;
\o /dev/null
SELECT pg_temp.expect_constraint('S4b', 'DB-16: a Company seller''s payment is never inserted as settled in cash', pg_temp.s4b('company', 'nawara', 'succeeded', 'cash'), 'payment_no_company_cash_settlement');
SELECT pg_temp.expect_ok('S4b', 'a Company seller''s unsettled payment (no method)', pg_temp.s4b('company', 'nawara', 'created', NULL));
SELECT pg_temp.expect_ok('S4b', 'another seller type is unchanged by DB-16: an Organization seller (cash for it stays deferred, ADR-0068 d.4)', pg_temp.s4b('organization', '00000000-0000-4000-8000-00000000b4b1', 'succeeded', 'cash'));
SELECT pg_temp.expect_ok('S4b', 'another seller type is unchanged by DB-16: a user seller', pg_temp.s4b('user', 'seller-u', 'succeeded', 'cash'));
SELECT pg_temp.expect_error('S4b', 'a Company seller''s unsettled payment cannot carry cash either (DB-16 and the success-only rule both refuse it)', pg_temp.s4b('company', 'nawara', 'created', 'cash'), '23514');
-- a Company payment settled the only way Core V2 settles: a verified gateway success on its succeeded attempt
INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, "beneficiaryUserId")
  VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u-1', 'company', 'nawara', 100, 'TND', 'direct_purchase', 'u-1') RETURNING id AS s4b_gw \gset
SELECT pg_temp.new_attempt(:'s4b_gw', 1) AS s4b_att \gset
UPDATE payment SET status = 'pending' WHERE id = :'s4b_gw';
UPDATE payment_attempt SET status = 'submitted' WHERE id = :'s4b_att';
UPDATE payment_attempt SET status = 'succeeded' WHERE id = :'s4b_att';
SELECT pg_temp.expect_ok('S4b', 'a Company seller''s payment is settled through a gateway', format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = %L, "closedAt" = now() WHERE id = %L$$, :'s4b_att', :'s4b_gw'));
SELECT pg_temp.expect_constraint('S4b', 'DB-16: a settled Company payment cannot be re-labelled cash by a raw UPDATE', format($$UPDATE payment SET "settledMethod" = 'cash' WHERE id = %L$$, :'s4b_gw'), 'payment_no_company_cash_settlement');
SELECT pg_temp.expect_error('S4b', 'S4a: the same payment''s purpose stays immutable', format($$UPDATE payment SET purpose = 'non_entitlement' WHERE id = %L$$, :'s4b_gw'), '23514');
SELECT pg_temp.expect_error('S4b', 'S4a: the same payment''s seller stays immutable (a Company seller cannot become another type to take cash)', format($$UPDATE payment SET "sellerType" = 'user', "settledMethod" = 'cash' WHERE id = %L$$, :'s4b_gw'), '23514');
SELECT pg_temp.assert_eq('S4b', 'the constraint is validated: every existing row satisfies it (nothing was rewritten)',
  (SELECT convalidated::text FROM pg_constraint WHERE conname = 'payment_no_company_cash_settlement'), 'true');
SELECT pg_temp.assert_eq('S4b', 'no Company payment is settled in cash', (SELECT count(*)::text FROM payment WHERE "sellerType" = 'company' AND "settledMethod" = 'cash'), '0');
\o

-- ======================================================= Core V2 S4c: closing, uncertainty, late success (0012) ----
CREATE FUNCTION pg_temp.s4c_pay() RETURNS uuid LANGUAGE sql AS $f$ SELECT pg_temp.new_payment(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1') $f$;
\o /dev/null
-- an open attempt: uncertain
SELECT pg_temp.s4c_pay() AS c1 \gset
SELECT pg_temp.new_attempt(:'c1', 1) AS c1a \gset
UPDATE payment SET status = 'pending' WHERE id = :'c1';
SELECT pg_temp.assert_eq('S4c', 'F-2: a payment with an open attempt is uncertain', payment_is_uncertain(:'c1')::text, 'true');
SELECT pg_temp.expect_error('S4c', 'F-1: never cancelled while uncertain (raw SQL)', format($$UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: never expired while uncertain (raw SQL)', format($$UPDATE payment SET status = 'expired', "closedAt" = now() WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-3: never failed while uncertain (raw SQL)', format($$UPDATE payment SET status = 'failed', "closedAt" = now() WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: closing records its reason', format($$UPDATE payment SET status = 'closing' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: an unknown closing reason is refused', format($$UPDATE payment SET status = 'closing', "closingReason" = 'whim' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_ok('S4c', 'F-1: a cancel while uncertain starts closing', format($$UPDATE payment SET status = 'closing', "closingReason" = 'cancel' WHERE id = %L$$, :'c1'));
SELECT pg_temp.assert_eq('S4c', 'F-1: closingSince is the database time', (SELECT ("closingSince" > now() - interval '1 minute')::text FROM payment WHERE id = :'c1'), 'true');
SELECT pg_temp.expect_error('S4c', 'F-1: a closing payment never returns to created', format($$UPDATE payment SET status = 'created' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: a closing payment never returns to pending', format($$UPDATE payment SET status = 'pending' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: a closing (cancel) payment cannot end expired', format($$UPDATE payment SET status = 'expired' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: a closing payment cannot end while still uncertain', format($$UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-1: the closing reason is set once', format($$UPDATE payment SET "closingReason" = 'expiry' WHERE id = %L$$, :'c1'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-6: a closing payment takes no new attempt', format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), %L, 2, 'test')$$, :'c1'), '23514');
UPDATE payment_attempt SET status = 'submitted' WHERE id = :'c1a';
UPDATE payment_attempt SET status = 'failed', "failureCode" = 'declined', "failureClass" = 'terminal' WHERE id = :'c1a';
SELECT pg_temp.assert_eq('S4c', 'F-3: a provider-confirmed failure ends the uncertainty', payment_is_uncertain(:'c1')::text, 'false');
SELECT pg_temp.expect_ok('S4c', 'F-1: closing (cancel) ends cancelled once nothing is uncertain', format($$UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = %L$$, :'c1'));
SELECT pg_temp.assert_eq('S4c', 'F-1: the closing history is kept on the final payment', (SELECT "closingReason" FROM payment WHERE id = :'c1'), 'cancel');
-- an inferred failure: uncertain until confirmed; closing (expiry) then succeeds on a verified late success
SELECT pg_temp.s4c_pay() AS c2 \gset
SELECT pg_temp.new_attempt(:'c2', 1) AS c2a \gset
UPDATE payment_attempt SET status = 'unknown' WHERE id = :'c2a';
UPDATE payment_attempt SET status = 'failed', "failureInferred" = true, "failureCode" = 'not_found', "failureClass" = 'terminal' WHERE id = :'c2a';
SELECT pg_temp.assert_eq('S4c', 'F-2: an inferred failure keeps the payment uncertain', payment_is_uncertain(:'c2')::text, 'true');
SELECT pg_temp.expect_error('S4c', 'F-6: no second attempt after an inferred failure (no second collection)', format($$INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), %L, 2, 'test')$$, :'c2'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-3: an inferred failure never lets the payment fail', format($$UPDATE payment SET status = 'failed', "closedAt" = now() WHERE id = %L$$, :'c2'), '23514');
SELECT pg_temp.expect_ok('S4c', 'F-1: an expiry while uncertain starts closing', format($$UPDATE payment SET status = 'closing', "closingReason" = 'expiry' WHERE id = %L$$, :'c2'));
UPDATE payment_attempt SET status = 'succeeded' WHERE id = :'c2a';
SELECT pg_temp.expect_ok('S4c', 'F-4: a verified success during closing settles the payment', format($$UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = %L, "closedAt" = now() WHERE id = %L$$, :'c2a', :'c2'));
-- a confirmed inferred failure: definitive; created -> failed only then; the late-success edge closes
SELECT pg_temp.s4c_pay() AS c3 \gset
SELECT pg_temp.new_attempt(:'c3', 1) AS c3a \gset
UPDATE payment_attempt SET status = 'unknown' WHERE id = :'c3a';
UPDATE payment_attempt SET status = 'failed', "failureInferred" = true, "failureCode" = 'not_found', "failureClass" = 'terminal' WHERE id = :'c3a';
SELECT pg_temp.expect_error('S4c', 'F-3: created -> failed is refused while the failure is only inferred', format($$UPDATE payment SET status = 'failed', "closedAt" = now() WHERE id = %L$$, :'c3'), '23514');
UPDATE payment_attempt SET "failureConfirmedAt" = '2000-01-01', "confirmedFailureCode" = 'declined' WHERE id = :'c3a';
SELECT pg_temp.assert_eq('S4c', 'F-3: the confirmation time is the database time', (SELECT ("failureConfirmedAt" > now() - interval '1 minute')::text FROM payment_attempt WHERE id = :'c3a'), 'true');
SELECT pg_temp.assert_eq('S4c', 'F-3: a confirmed inferred failure ends the uncertainty', payment_is_uncertain(:'c3')::text, 'false');
SELECT pg_temp.expect_error('S4c', 'F-3: a confirmation is never rewritten', format($$UPDATE payment_attempt SET "confirmedFailureCode" = 'other' WHERE id = %L$$, :'c3a'), '23514');
SELECT pg_temp.expect_error('S4c', 'F-3: a confirmed failure has no late-success edge any more', format($$UPDATE payment_attempt SET status = 'succeeded' WHERE id = %L$$, :'c3a'), '23514');
SELECT pg_temp.expect_ok('S4c', 'F-3: created -> failed once the inferred failure is confirmed', format($$UPDATE payment SET status = 'failed', "closedAt" = now() WHERE id = %L$$, :'c3'));
SELECT pg_temp.expect_error('S4c', 'a confirmation only on an inferred failure', format($$UPDATE payment_attempt SET "failureConfirmedAt" = now(), "confirmedFailureCode" = 'x' WHERE id = %L$$, :'c1a'), '23514');
-- not uncertain: closing is refused
SELECT pg_temp.s4c_pay() AS c4 \gset
SELECT pg_temp.expect_error('S4c', 'F-1: closing is refused when nothing is uncertain', format($$UPDATE payment SET status = 'closing', "closingReason" = 'cancel' WHERE id = %L$$, :'c4'), '23514');
SELECT pg_temp.expect_ok('S4c', 'a payment with no attempt is cancelled at once (unchanged)', format($$UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = %L$$, :'c4'));
SELECT pg_temp.expect_error('S4c', 'a payment is never created closing', $$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, status, "closingReason")
  VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'company', 'n', 100, 'TND', 'non_entitlement', 'closing', 'cancel')$$, '23514');
-- F-4: the durable late-success record (append-only, once per attempt/source/webhook event)
INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus") VALUES (:'c1', :'c1a', 'status_check', 1000, 'TND', 'cancelled');
SELECT pg_temp.expect_error('S4c', 'F-4: a late-success record is recorded once per (attempt, source, webhook event)', format($$INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus") VALUES (%L, %L, 'status_check', 1000, 'TND', 'cancelled')$$, :'c1', :'c1a'), '23505');
SELECT pg_temp.expect_error('S4c', 'F-4: a late-success record is never changed', $$UPDATE payment_late_success SET amount = 1$$, '23514');
SELECT pg_temp.expect_error('S4c', 'F-4: a late-success record is never deleted', $$DELETE FROM payment_late_success$$, '23514');
SELECT pg_temp.expect_error('S4c', 'F-4: a webhook-sourced record names its stored webhook event', format($$INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus") VALUES (%L, %L, 'webhook', 1000, 'TND', 'cancelled')$$, :'c1', :'c1a'), '23514');
SELECT pg_temp.assert_eq('S4c', 'F-4: recording a late success leaves the payment final and unchanged', (SELECT status FROM payment WHERE id = :'c1'), 'cancelled');
\o

-- ======================================================= Core V2 S4d: provider transaction facts (0013) ----
\o /dev/null
SELECT pg_temp.new_payment(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1') AS f1 \gset
SELECT pg_temp.new_attempt(:'f1', 1) AS f1a \gset
SELECT pg_temp.new_payment(gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1') AS f2 \gset
SELECT pg_temp.new_attempt(:'f2', 1) AS f2a \gset
INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('test', 'evt-s4d-1', 'payment.succeeded', '\x7b7d') RETURNING id AS wh_test \gset
INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('other', 'evt-s4d-2', 'payment.succeeded', '\x7b7d') RETURNING id AS wh_other \gset
CREATE FUNCTION pg_temp.fact(p uuid, a uuid, prov text, txn text, amt bigint, src text, wh uuid, kind text DEFAULT 'capture', live text DEFAULT 'false') RETURNS text LANGUAGE sql AS $f$
  SELECT format($$INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source, "webhookEventId", "observedAt")
    VALUES (%L, %L, %L, %L, %L, %s, 'TND', %s, %L, %L, '2000-01-01')$$, prov, txn, kind, p, a, amt, live, src, wh);
$f$;
SELECT pg_temp.expect_ok('S4d', 'FC-1: a capture fact from a verified webhook of the same provider', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-1', 1000, 'webhook', :'wh_test'));
SELECT pg_temp.assert_eq('S4d', 'observedAt is the database time, never a supplied one', (SELECT ("observedAt" > now() - interval '1 minute')::text FROM provider_transaction_fact WHERE "providerTxnId" = 'ptx-s4d-1'), 'true');
SELECT pg_temp.expect_error('S4d', 'FC-1: one fact per (provider, providerTxnId, kind)', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-1', 1000, 'status_check', NULL), '23505');
SELECT pg_temp.expect_ok('S4d', 'a status-read fact (no webhook) for another transaction', pg_temp.fact(:'f2', :'f2a', 'test', 'ptx-s4d-2', 1000, 'status_check', NULL));
SELECT pg_temp.expect_error('S4d', 'a fact is bound to ITS attempt''s payment (no cross-payment association)', pg_temp.fact(:'f2', :'f1a', 'test', 'ptx-s4d-3', 1000, 'status_check', NULL), '23503');
SELECT pg_temp.expect_error('S4d', 'a fact is bound to ITS attempt''s provider (no cross-provider association)', pg_temp.fact(:'f1', :'f1a', 'other', 'ptx-s4d-4', 1000, 'status_check', NULL), '23503');
SELECT pg_temp.expect_error('S4d', 'a webhook-sourced fact names a stored webhook of the same provider', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-5', 1000, 'webhook', :'wh_other'), '23514');
SELECT pg_temp.expect_error('S4d', 'a webhook-sourced fact names its webhook', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-6', 1000, 'webhook', NULL), '23514');
SELECT pg_temp.expect_error('S4d', 'a status-read fact names no webhook', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-7', 1000, 'status_check', :'wh_test'), '23514');
SELECT pg_temp.expect_error('S4d', 'a refund fact is never free-standing: it names its refund attempt (S6b); chargebacks are S6e', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-8', 1000, 'status_check', NULL, 'refund'), '23514');
SELECT pg_temp.expect_error('S4d', 'FC-10 under P-6: a live fact is refused (simulation only)', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-9', 1000, 'status_check', NULL, 'capture', 'true'), '23514');
SELECT pg_temp.expect_error('S4d', 'a fact moves money: a zero amount is no fact', pg_temp.fact(:'f1', :'f1a', 'test', 'ptx-s4d-10', 0, 'status_check', NULL), '23514');
SELECT pg_temp.expect_error('S4d', 'FC-1: a fact is never edited', $$UPDATE provider_transaction_fact SET amount = 1$$, '23514');
SELECT pg_temp.expect_error('S4d', 'FC-1: a fact is never deleted', $$DELETE FROM provider_transaction_fact$$, '23514');
SELECT pg_temp.expect_error('S4d', 'FC-1: facts are never truncated', $$TRUNCATE provider_transaction_fact CASCADE$$, '23514');
SELECT id AS fact1 FROM provider_transaction_fact WHERE "providerTxnId" = 'ptx-s4d-1' \gset
INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", provider, amount, currency, source) VALUES (:'fact1', :'f1', :'f1a', 'test', 999, 'TND', 'status_check');
SELECT pg_temp.expect_error('S4d', 'a contradiction redelivered is recorded once', format($$INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", provider, amount, currency, source) VALUES (%L, %L, %L, 'test', 999, 'TND', 'status_check')$$, :'fact1', :'f1', :'f1a'), '23505');
SELECT pg_temp.expect_error('S4d', 'a contradiction is never edited', $$UPDATE provider_transaction_fact_conflict SET amount = 1$$, '23514');
SELECT pg_temp.expect_error('S4d', 'a contradiction is never deleted', $$DELETE FROM provider_transaction_fact_conflict$$, '23514');
SELECT pg_temp.assert_eq('S4d', 'a contradiction never changes its fact', (SELECT amount::text FROM provider_transaction_fact WHERE id = :'fact1'), '1000');
SELECT pg_temp.expect_ok('S4d', 'C2: a late success references its own fact', format($$INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus", "factId") VALUES (%L, %L, 'status_check', 1000, 'TND', 'created', %L)$$, :'f1', :'f1a', :'fact1'));
SELECT pg_temp.expect_error('S4d', 'C2: a late success never references another attempt''s fact', format($$INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus", "factId") VALUES (%L, %L, 'status_check', 1000, 'TND', 'created', %L)$$, :'f2', :'f2a', :'fact1'), '23514');
SELECT pg_temp.assert_eq('S4d', 'the runtime grants: no UPDATE or DELETE on facts for anyone but the owner',
  (SELECT count(*)::text FROM information_schema.role_table_grants g JOIN pg_tables t ON t.tablename = g.table_name
    WHERE g.table_name IN ('provider_transaction_fact', 'provider_transaction_fact_conflict') AND g.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND g.grantee <> t.tableowner), '0');
\o

-- ======================================================= Core V2 S4g: class-M idempotency retention (0014) ----
\o /dev/null
INSERT INTO idempotency_key (caller, operation, key, "requestHash", "responseStatus", "resourceType", "resourceId", "createdAt", "expiresAt")
  VALUES ('user:u-s4g', 'start_attempt', 'k-s4g-00001', repeat('a', 64), 201, 'payment_attempt', gen_random_uuid(), '2000-01-01', '2000-01-02');
SELECT pg_temp.assert_eq('S4g', 'PAY-15: a money-command record is retained exactly 90 days from the database''s own time, whatever was supplied',
  (SELECT ("expiresAt" = "createdAt" + interval '90 days' AND "createdAt" > now() - interval '1 minute')::text FROM idempotency_key WHERE key = 'k-s4g-00001'), 'true');
SELECT pg_temp.expect_error('S4g', 'a stored money-command outcome is never rewritten', $$UPDATE idempotency_key SET "responseStatus" = 200 WHERE key = 'k-s4g-00001'$$, '23514');
SELECT pg_temp.expect_error('S4g', 'its window is never shortened', $$UPDATE idempotency_key SET "expiresAt" = now() WHERE key = 'k-s4g-00001'$$, '23514');
SELECT pg_temp.expect_error('S4g', 'a record is never deleted inside its 90-day window', $$DELETE FROM idempotency_key WHERE key = 'k-s4g-00001'$$, '23514');
SELECT pg_temp.expect_error('S4g', 'the key is permanent per (caller, operation)', $$INSERT INTO idempotency_key (caller, operation, key, "requestHash", "responseStatus", "resourceType", "resourceId")
  VALUES ('user:u-s4g', 'start_attempt', 'k-s4g-00001', repeat('b', 64), 201, 'payment_attempt', gen_random_uuid())$$, '23505');
-- a record past its window (simulated: written without the retention trigger) may be removed by a later, authorized purge
SET session_replication_role = replica;
INSERT INTO idempotency_key (caller, operation, key, "requestHash", "responseStatus", "resourceType", "resourceId", "createdAt", "expiresAt")
  VALUES ('user:u-s4g', 'start_attempt', 'k-s4g-00002', repeat('a', 64), 201, 'payment_attempt', gen_random_uuid(), now() - interval '91 days', now() - interval '1 day');
SET session_replication_role = origin;
SELECT pg_temp.expect_ok('S4g', 'an expired record may be purged (nothing purges today; a later purge needs its own authorization)', $$DELETE FROM idempotency_key WHERE key = 'k-s4g-00002'$$);
\o

-- ======================================================= Core V2 S4f: the simulation provider's own records (0015) ----
\o /dev/null
SELECT pg_temp.new_payment(gen_random_uuid(), gen_random_uuid()) AS s4f_p \gset
SELECT pg_temp.new_payment(gen_random_uuid(), gen_random_uuid()) AS s4f_q \gset
INSERT INTO payment_attempt ("paymentId", "attemptNumber", provider) VALUES (:'s4f_p', 1, 'simulation') RETURNING id AS s4f_a \gset
SELECT pg_temp.new_attempt(:'s4f_q', 1) AS s4f_test_a \gset
CREATE FUNCTION pg_temp.sim(cid text, kind text, pid text, aid text, instr text, code text DEFAULT NULL, amt text DEFAULT 'NULL', cur text DEFAULT NULL,
                            txn text DEFAULT NULL, body text DEFAULT NULL, delivery text DEFAULT NULL) RETURNS text LANGUAGE sql AS $f$
  SELECT format($$INSERT INTO simulation_provider_command ("commandId", kind, "paymentId", "attemptId", instruction, "failureCode", amount, currency, "providerTxnId", "eventBody", delivery, "createdAt")
    VALUES (%L, %L, %L, %L, %L, %L, %s, %L, %L, %L::bytea, %L, '2000-01-01')$$, cid, kind, pid, aid, instr, code, amt, cur, txn, body, delivery);
$f$;
SELECT pg_temp.expect_ok('S4f', 'an initiation plan for a payment', pg_temp.sim('cmd-s4f-001', 'initiation', :'s4f_p', NULL, 'ambiguous'));
SELECT pg_temp.assert_eq('S4f', 'createdAt is the database time, never a supplied one', (SELECT ("createdAt" > now() - interval '1 minute')::text FROM simulation_provider_command WHERE "commandId" = 'cmd-s4f-001'), 'true');
SELECT pg_temp.expect_ok('S4f', 'a rejected plan carries its failure code', pg_temp.sim('cmd-s4f-002', 'initiation', :'s4f_p', NULL, 'rejected', 'do_not_honor'));
SELECT pg_temp.expect_ok('S4f', 'a success outcome: derived money, the transaction, its notification', pg_temp.sim('cmd-s4f-003', 'outcome', :'s4f_p', :'s4f_a', 'succeeded', NULL, '1000', 'TND', 'sim_x', '{}', 'immediate'));
SELECT pg_temp.expect_ok('S4f', 'a no-record outcome produces no notification', pg_temp.sim('cmd-s4f-004', 'outcome', :'s4f_p', :'s4f_a', 'no_record', NULL, 'NULL', NULL, 'sim_x'));
SELECT pg_temp.expect_error('S4f', 'F-S6: one row per command identity', pg_temp.sim('cmd-s4f-001', 'initiation', :'s4f_p', NULL, 'accepted'), '23505');
SELECT pg_temp.expect_error('S4f', 'the command identity has the Idempotency-Key shape', pg_temp.sim('short', 'initiation', :'s4f_p', NULL, 'accepted'), '23514');
SELECT pg_temp.expect_error('S4f', 'F-S3: an outcome binds to an attempt OF THE SIMULATION PROVIDER (no cross-provider reference)', pg_temp.sim('cmd-s4f-010', 'outcome', :'s4f_q', :'s4f_test_a', 'pending', NULL, 'NULL', NULL, 'sim_x'), '23503');
SELECT pg_temp.expect_error('S4f', 'F-S3: an outcome binds to its attempt''s payment (no cross-payment reference)', pg_temp.sim('cmd-s4f-011', 'outcome', :'s4f_q', :'s4f_a', 'pending', NULL, 'NULL', NULL, 'sim_x'), '23503');
SELECT pg_temp.expect_error('S4f', 'an initiation names no attempt', pg_temp.sim('cmd-s4f-012', 'initiation', :'s4f_p', :'s4f_a', 'accepted'), '23514');
SELECT pg_temp.expect_error('S4f', 'an outcome names its attempt', pg_temp.sim('cmd-s4f-013', 'outcome', :'s4f_p', NULL, 'pending', NULL, 'NULL', NULL, 'sim_x'), '23514');
SELECT pg_temp.expect_error('S4f', 'an unknown instruction is refused', pg_temp.sim('cmd-s4f-014', 'outcome', :'s4f_p', :'s4f_a', 'refunded', NULL, 'NULL', NULL, 'sim_x'), '23514');
SELECT pg_temp.expect_error('S4f', 'a failure needs its code', pg_temp.sim('cmd-s4f-015', 'outcome', :'s4f_p', :'s4f_a', 'failed', NULL, 'NULL', NULL, 'sim_x', '{}', 'held'), '23514');
SELECT pg_temp.expect_error('S4f', 'only a failure or rejection carries a code', pg_temp.sim('cmd-s4f-016', 'outcome', :'s4f_p', :'s4f_a', 'pending', 'x', 'NULL', NULL, 'sim_x'), '23514');
SELECT pg_temp.expect_error('S4f', 'a success carries its derived money', pg_temp.sim('cmd-s4f-017', 'outcome', :'s4f_p', :'s4f_a', 'succeeded', NULL, 'NULL', NULL, 'sim_x', '{}', 'held'), '23514');
SELECT pg_temp.expect_error('S4f', 'no money on a non-success', pg_temp.sim('cmd-s4f-018', 'outcome', :'s4f_p', :'s4f_a', 'expired', NULL, '1000', 'TND', 'sim_x', '{}', 'held'), '23514');
SELECT pg_temp.expect_error('S4f', 'a zero amount is no money movement', pg_temp.sim('cmd-s4f-019', 'outcome', :'s4f_p', :'s4f_a', 'succeeded', NULL, '0', 'TND', 'sim_x', '{}', 'held'), '23514');
SELECT pg_temp.expect_error('S4f', 'a notifying outcome has its notification and delivery', pg_temp.sim('cmd-s4f-020', 'outcome', :'s4f_p', :'s4f_a', 'expired', NULL, 'NULL', NULL, 'sim_x'), '23514');
SELECT pg_temp.expect_error('S4f', 'a status-only outcome has no notification', pg_temp.sim('cmd-s4f-021', 'outcome', :'s4f_p', :'s4f_a', 'pending', NULL, 'NULL', NULL, 'sim_x', '{}', 'held'), '23514');
SELECT pg_temp.expect_error('S4f', 'an unknown delivery is refused', pg_temp.sim('cmd-s4f-022', 'outcome', :'s4f_p', :'s4f_a', 'expired', NULL, 'NULL', NULL, 'sim_x', '{}', 'later'), '23514');
SELECT pg_temp.expect_error('S4f', 'an outcome names the provider transaction', pg_temp.sim('cmd-s4f-023', 'outcome', :'s4f_p', :'s4f_a', 'pending'), '23514');
SELECT pg_temp.expect_error('S4f', 'the provider is always simulation', format($$INSERT INTO simulation_provider_command ("commandId", kind, "paymentId", provider, instruction) VALUES ('cmd-s4f-024', 'initiation', %L, 'test', 'accepted')$$, :'s4f_p'), '23514');
SELECT pg_temp.expect_error('S4f', 'a command is never edited', $$UPDATE simulation_provider_command SET instruction = 'rejected'$$, '23514');
SELECT pg_temp.expect_error('S4f', 'a command is never deleted', $$DELETE FROM simulation_provider_command$$, '23514');
SELECT pg_temp.expect_error('S4f', 'commands are never truncated', $$TRUNCATE simulation_provider_command$$, '23514');
SELECT pg_temp.assert_eq('S4f', 'the runtime grants: no UPDATE or DELETE on simulation commands for anyone but the owner',
  (SELECT count(*)::text FROM information_schema.role_table_grants g JOIN pg_tables t ON t.tablename = g.table_name
    WHERE g.table_name = 'simulation_provider_command' AND g.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE') AND g.grantee <> t.tableowner), '0');
\o

-- ======================================================= Core V2 S4e: an Organization payer is the payment's Organization (0016) ----
\o /dev/null
CREATE FUNCTION pg_temp.s4e(pid text, org text, seller_type text DEFAULT 'company', seller_id text DEFAULT 'nawara') RETURNS text LANGUAGE sql AS $f$
  SELECT format($$INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, "liveMode")
    VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'organization', %L, %L, %L, %s, 100, 'TND', 'recovery_settlement', false)$$, pid, seller_type, seller_id, COALESCE(quote_literal(org), 'NULL'));
$f$;
SELECT pg_temp.expect_ok('S4e', 'A-4: an Organization payer names itself as the payment''s Organization', pg_temp.s4e('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000e4'));
SELECT pg_temp.expect_constraint('S4e', 'A-4: an Organization payer without its Organization scope is refused', pg_temp.s4e('00000000-0000-4000-8000-0000000000e4', NULL), 'payment_organization_payer_scope');
SELECT pg_temp.expect_constraint('S4e', 'A-4: an Organization payer naming another Organization is refused', pg_temp.s4e('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000e5'), 'payment_organization_payer_scope');
SELECT pg_temp.expect_error('S4e', 'A-4: an Organization never pays an Organization seller (the seller rule then contradicts the payer rule)',
  pg_temp.s4e('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-0000000000e4', 'organization', '00000000-0000-4000-8000-0000000000e5'), '23514');
SELECT id AS s4e_p FROM payment WHERE "payerId" = '00000000-0000-4000-8000-0000000000e4' AND "payerType" = 'organization' LIMIT 1 \gset
SELECT pg_temp.expect_error('S4e', 'the payer Organization scope never changes (organizationId)', format($$UPDATE payment SET "organizationId" = '00000000-0000-4000-8000-0000000000e5' WHERE id = %L$$, :'s4e_p'), '23514');
SELECT pg_temp.expect_error('S4e', 'the payer Organization scope never changes (payerId)', format($$UPDATE payment SET "payerId" = '00000000-0000-4000-8000-0000000000e5' WHERE id = %L$$, :'s4e_p'), '23514');
SELECT pg_temp.expect_ok('S4e', 'a user payer is unaffected (no organizationId needed)', pg_temp.s4a('user', 'u-s4e', 'non_entitlement', NULL));
\o

-- ======================================================= Core V2 S6b: refund attempts (0017) ----
\o /dev/null
-- a captured, Company-sold, gateway-settled simulation payment with its verified capture fact
INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, "liveMode")
  VALUES ('billing-service', gen_random_uuid(), 'invoice', 'inv-s6b', 'user', 'u-s6b', 'company', '00000000-0000-4000-8000-00000000c6b0', 1000, 'TND', 'non_entitlement', false) RETURNING id AS r1 \gset
INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), :'r1', 1, 'test', false) RETURNING id AS r1a \gset
UPDATE payment SET status = 'pending' WHERE id = :'r1';
UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx-s6b-1', "submittedAt" = now() WHERE id = :'r1a';
UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = :'r1a';
INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source)
  VALUES ('test', 'ptx-s6b-1', 'capture', :'r1', :'r1a', 1000, 'TND', false, 'status_check') RETURNING id AS r1f \gset
UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = :'r1a', "closedAt" = now() WHERE id = :'r1';
CREATE FUNCTION pg_temp.s6b(id uuid, pid uuid, amt bigint DEFAULT 1000, status text DEFAULT 'authorization_pending', company text DEFAULT '00000000-0000-4000-8000-00000000c6b0') RETURNS text LANGUAGE sql AS $f$
  SELECT format($$INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId",
      provider, "liveMode", "receiptDigest", status)
    SELECT %L, p.id, 'billing-service', gen_random_uuid(), %L, %s, 'TND', 'customer_request', false, f.id, f."attemptId", 'test', false, repeat('a', 64), %L
      FROM payment p JOIN provider_transaction_fact f ON f."paymentId" = p.id AND f.kind = 'capture' WHERE p.id = %L$$, id, company, amt, status, pid);
$f$;
SELECT pg_temp.expect_constraint('S6b', 'R6B-3: a new attempt starts as an authorization intent', pg_temp.s6b(gen_random_uuid(), :'r1', 1000, 'authorized'), 'refund_attempt_insert_state');
SELECT pg_temp.expect_constraint('S6b', 'R6B-2 / D4: a partial amount is refused', pg_temp.s6b(gen_random_uuid(), :'r1', 999), 'refund_attempt_payment_refundable');
SELECT pg_temp.expect_constraint('S6b', 'R6B-2: the attempt''s Company is the payment''s seller', pg_temp.s6b(gen_random_uuid(), :'r1', 1000, 'authorization_pending', '00000000-0000-4000-8000-00000000c6b1'), 'refund_attempt_payment_refundable');
SELECT pg_temp.expect_ok('S6b', 'a full-amount intent on a verified capture', pg_temp.s6b('00000000-0000-4000-8000-0000000006b1', :'r1'));
SELECT pg_temp.expect_error('S6b', 'R6B-3: at most one unresolved or potentially effective attempt per payment', pg_temp.s6b(gen_random_uuid(), :'r1'), '23505');
SELECT pg_temp.expect_constraint('S6b', 'R6B-3: no skipping to success', $$UPDATE refund_attempt SET status = 'dispatching' WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_transition');
SELECT pg_temp.expect_constraint('S6b', 'authorized needs ALL of Auth''s consumption (receipt, approver, time)', $$UPDATE refund_attempt SET status = 'authorized', "authorizedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_authorization_shape');
SELECT pg_temp.expect_constraint('S6b', 'authorized needs the receipt id too', $$UPDATE refund_attempt SET status = 'authorized', "approvedByUserId" = gen_random_uuid(), "consumedAt" = now(), "authorizedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_authorization_shape');
SELECT pg_temp.expect_ok('S6b', 'authorized with Auth''s consumption', $$UPDATE refund_attempt SET status = 'authorized', "receiptId" = gen_random_uuid(), "approvedByUserId" = gen_random_uuid(), "consumedAt" = now(), "authorizedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$);
SELECT pg_temp.expect_constraint('S6b', 'F-11: the consumed authorization never changes', $$UPDATE refund_attempt SET "approvedByUserId" = gen_random_uuid() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_outcome_with_status');
SELECT pg_temp.expect_error('S6b', 'the binding is immutable', $$UPDATE refund_attempt SET amount = 1 WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, '23514');
SELECT pg_temp.expect_ok('S6b', 'dispatching is durable before the provider call', $$UPDATE refund_attempt SET status = 'dispatching' WHERE id = '00000000-0000-4000-8000-0000000006b1'$$);
SELECT pg_temp.expect_constraint('S6b', 'R6B-5: success needs its own verified full-amount refund fact', $$UPDATE refund_attempt SET status = 'succeeded', "succeededFactId" = gen_random_uuid(), "completedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_success_evidence');
SELECT pg_temp.expect_error('S6b', 'FC-1: a refund fact is bound to ITS attempt''s payment', format($$INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source)
  VALUES ('test', 'rtx-s6b-x', 'refund', gen_random_uuid(), %L, '00000000-0000-4000-8000-0000000006b1', 1000, 'TND', false, 'status_check')$$, :'r1a'), '23503');
SELECT pg_temp.expect_ok('S6b', 'FC-1: a partial refund fact is recorded, never refused (D4)', format($$INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source)
  VALUES ('test', 'rtx-s6b-1', 'refund', %L, %L, '00000000-0000-4000-8000-0000000006b1', 999, 'TND', false, 'status_check')$$, :'r1', :'r1a'));
SELECT id AS rf1 FROM provider_transaction_fact WHERE "providerTxnId" = 'rtx-s6b-1' \gset
SELECT pg_temp.expect_constraint('S6b', 'R6B-5: a partial refund fact never succeeds the attempt', format($$UPDATE refund_attempt SET status = 'succeeded', "succeededFactId" = %L, "completedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, :'rf1'), 'refund_attempt_success_evidence');
SELECT pg_temp.expect_ok('S6b', 'R6B-5: a mismatch is a discrepancy', $$UPDATE refund_attempt SET status = 'discrepancy', "completedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$);
SELECT pg_temp.expect_constraint('S6b', 'a discrepancy is terminal', $$UPDATE refund_attempt SET "workAfter" = now() WHERE id = '00000000-0000-4000-8000-0000000006b1'$$, 'refund_attempt_terminal');
SELECT pg_temp.expect_constraint('S6b', 'FC-5: refund evidence for the payment refuses every new attempt', pg_temp.s6b(gen_random_uuid(), :'r1'), 'refund_attempt_no_refund_fact');
SELECT pg_temp.expect_error('S6b', 'refund attempts are never deleted', $$DELETE FROM refund_attempt$$, '23514');
-- refusals: permanent, append-only, exclusive with attempts
SELECT pg_temp.expect_ok('S6b', 'R6B-10: a pre-attempt refusal is recorded', format($$INSERT INTO refund_attempt_refusal (id, "paymentId", producer, "refundCaseId", code) VALUES ('00000000-0000-4000-8000-0000000006b2', %L, 'billing-service', gen_random_uuid(), 'refund_in_progress')$$, :'r1'));
SELECT pg_temp.expect_constraint('S6b', 'an attempt id is never also a refusal', format($$INSERT INTO refund_attempt_refusal (id, "paymentId", producer, "refundCaseId", code) VALUES ('00000000-0000-4000-8000-0000000006b1', %L, 'billing-service', gen_random_uuid(), 'refund_in_progress')$$, :'r1'), 'refund_attempt_refusal_not_attempt');
SELECT pg_temp.expect_error('S6b', 'a refusal is never changed', $$UPDATE refund_attempt_refusal SET code = 'refund_dispute_open'$$, '23514');
SELECT pg_temp.expect_error('S6b', 'a refusal is never deleted', $$DELETE FROM refund_attempt_refusal$$, '23514');
-- a second payment: the refused id never becomes an attempt; refund evidence blocks every new attempt
INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, "liveMode")
  VALUES ('billing-service', gen_random_uuid(), 'invoice', 'inv-s6b-2', 'user', 'u-s6b', 'company', '00000000-0000-4000-8000-00000000c6b0', 1000, 'TND', 'non_entitlement', false) RETURNING id AS r2 \gset
INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), :'r2', 1, 'test', false) RETURNING id AS r2a \gset
UPDATE payment SET status = 'pending' WHERE id = :'r2';
UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx-s6b-2', "submittedAt" = now() WHERE id = :'r2a';
UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = :'r2a';
INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source) VALUES ('test', 'ptx-s6b-2', 'capture', :'r2', :'r2a', 1000, 'TND', false, 'status_check');
UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = :'r2a', "closedAt" = now() WHERE id = :'r2';
SELECT pg_temp.expect_constraint('S6b', 'a refused id never becomes an attempt', pg_temp.s6b('00000000-0000-4000-8000-0000000006b2', :'r2'), 'refund_attempt_refused_id');
SELECT pg_temp.expect_ok('S6b', 'another payment takes its own attempt', pg_temp.s6b('00000000-0000-4000-8000-0000000006b3', :'r2'));
UPDATE refund_attempt SET status = 'authorization_refused', "authorizationRefusal" = 'receipt_invalid', "completedAt" = now() WHERE id = '00000000-0000-4000-8000-0000000006b3';
SELECT pg_temp.expect_constraint('S6b', 'a refused authorization is terminal', $$UPDATE refund_attempt SET "workAfter" = now() WHERE id = '00000000-0000-4000-8000-0000000006b3'$$, 'refund_attempt_terminal');
SELECT pg_temp.expect_ok('S6b', 'a refused authorization frees the payment for a new attempt', pg_temp.s6b('00000000-0000-4000-8000-0000000006b4', :'r2'));
SELECT pg_temp.assert_eq('S6b', 'no column of Payment stores a receipt secret', (SELECT count(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* 'secret'), '0');
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
