-- 0037 — payment-service: no refund replacement while an earlier attempt of the same captured money may still pay (Core V2 D-R1B; the Owner's GO of
-- 2026-11-24, OD-DR1-1, OD-DR1-3, OD-DR1-4, OD-DR1-5 NO-GO). DEVELOPMENT AND SIMULATION ONLY. Expand only: three append-only tables, functions and
-- NEW triggers beside the existing ones (no existing guard, index, column or allocation rule is edited). No existing row is changed, nothing is
-- backfilled: every attempt that `failed` before this migration has no finality evidence and therefore blocks a replacement.
--
--   * `refund_capability_certificate`, `refund_capability_revocation`: the database's own mirror of the reviewed code registry
--     (`refund-capabilities.ts`). Written by reviewed migrations only: the runtime role can read and nothing else. A certificate's content is its
--     canonical text, its fingerprint is re-computed from it and every column is bound to it. `simulation` only: a real provider's certificate
--     cannot be written without another reviewed migration.
--   * `refund_attempt_failure_finality`: at most one per attempt, for the precise attempt, key, provider observation, failure code and the exact
--     certificate (id, version, fingerprint, provider). It is accepted only while the attempt is in flight and only if the SAME transaction commits
--     the attempt as `failed` with that code, so a failure already recorded (all history) can never be given one. Not if the capture has refund
--     evidence. The row is never changed: expiry and revocation end what it PERMITS, never the evidence.
--   * A new attempt (insert) and a dispatch (`authorized` -> `dispatching`) are refused (`refund_attempt_prior_may_still_pay`, 23514) while any OTHER
--     attempt of the same capture, or ordinary attempt of the same payment for an ordinary one (the scopes of the two one-effective indexes, 0022),
--     may still pay: everything except `authorization_expired`, `authorization_refused`, and a `failed` attempt with finality evidence whose certificate
--     is in force at this instant and that has no refund fact of its own or under its exact provider reference (ambiguous: not final).
--   * The R6H-5 rule "a second capture of the settling attempt only while another stays unrefunded" counted a capture whose attempt failed as
--     unrefunded. One whose failed attempt may still pay no longer counts (`refund_attempt_last_capture_may_still_pay`).
--   * OD-DR1-1: an attempt with its OWN verified refund fact never moves to `failed` (`refund_attempt_failed_after_refund_fact`).
--
-- LOCK ORDER (always this order; all transaction-scoped): 1. the payment's refund-dispatch advisory lock (dispatch only, 0032); 2. the payment row;
-- 3. the attempt row; 4. LAST, the capability lock: SHARED for finality inserts, attempt inserts and dispatches, EXCLUSIVE for writers of the two
-- mirror tables. A mirror writer takes no payment or attempt lock, so the order has no cycle: a revocation transaction must do nothing else. A
-- revocation that committed first is always seen (each guard reads AFTER its lock, in a new READ COMMITTED snapshot; any other isolation level is
-- refused); one that comes second waits for the transaction that used the certificate. Validity is judged at `clock_timestamp()` after the locks.
--
-- BOUNDARY (recorded): the database decides before `dispatching` commits and the provider is called after it. A revocation that commits after that point
-- cannot recall the call; it stops every later insert and dispatch. Provider money not yet reported to Payment is visible to no rule. The runtime
-- role is trusted for what the provider answered (as for every provider fact), never for what a certificate says. An owner or superuser who can
-- disable a trigger can bypass it.
--
-- Supersession: none is implied. A newer version of a certificate neither ends nor widens evidence recorded under an older one; ending it takes a
-- revocation of that version.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── locks and preconditions

CREATE FUNCTION refund_capability_lock_key() RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT hashtextextended('payment-refund-capability', 0)
$$;

CREATE FUNCTION refund_require_read_committed() RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'refund finality is decided at READ COMMITTED only (a fixed snapshot could miss a committed revocation)'
      USING ERRCODE = '23514', CONSTRAINT = 'refund_finality_isolation';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the certificate and revocation mirror

CREATE TABLE refund_capability_certificate (
  id                     text NOT NULL,
  version                integer NOT NULL,
  fingerprint            text NOT NULL,
  "providerId"           text NOT NULL,
  scope                  text NOT NULL,
  "issuedAt"             timestamptz NOT NULL,
  "expiresAt"            timestamptz,
  "failureObservations"  text[] NOT NULL,          -- the failure observations `terminalFailureFinality` covers; empty when it is not granted
  content                text NOT NULL,            -- the registry's canonical content: what the fingerprint covers
  "approvalRef"          text NOT NULL,
  "recordedAt"           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CONSTRAINT refund_capability_certificate_identity UNIQUE (id, version, fingerprint, "providerId"),
  CONSTRAINT refund_capability_certificate_id_shape CHECK (id ~ '^[a-z][a-z0-9-]{2,63}$' AND version >= 1),
  -- no real provider: a reviewed migration would have to change this
  CONSTRAINT refund_capability_certificate_simulation_only CHECK ("providerId" = 'simulation' AND scope = 'simulation'),
  CONSTRAINT refund_capability_certificate_window CHECK ("expiresAt" IS NULL OR "expiresAt" > "issuedAt"),
  CONSTRAINT refund_capability_certificate_fingerprint CHECK (fingerprint = encode(sha256(convert_to(content, 'UTF8')), 'hex')),
  CONSTRAINT refund_capability_certificate_content CHECK (COALESCE(
    content::jsonb ->> 'id' = id AND (content::jsonb ->> 'version')::integer = version AND content::jsonb ->> 'providerId' = "providerId"
    AND content::jsonb ->> 'scope' = scope AND (content::jsonb ->> 'issuedAt')::timestamptz = "issuedAt"
    AND (content::jsonb ->> 'expiresAt')::timestamptz IS NOT DISTINCT FROM "expiresAt"
    AND COALESCE(content::jsonb #> '{grants,terminalFailureFinality,observations}', '[]'::jsonb) = to_jsonb("failureObservations"), false)),
  CONSTRAINT refund_capability_certificate_observations CHECK ("failureObservations" <@ ARRAY['dispatch_rejected', 'provider_failed']),
  CONSTRAINT refund_capability_certificate_approval CHECK (char_length(trim("approvalRef")) > 0)
);

CREATE TABLE refund_capability_revocation (
  "certificateId"       text NOT NULL,
  "certificateVersion"  integer NOT NULL,
  reason                text NOT NULL,
  "approvalRef"         text NOT NULL,
  "revokedAt"           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("certificateId", "certificateVersion"),
  CONSTRAINT refund_capability_revocation_certificate FOREIGN KEY ("certificateId", "certificateVersion") REFERENCES refund_capability_certificate (id, version),
  CONSTRAINT refund_capability_revocation_attributed CHECK (char_length(trim(reason)) > 0 AND char_length(trim("approvalRef")) > 0)
);

-- a writer of the mirror waits for every decision that is using it, and every later decision waits for the writer
CREATE FUNCTION refund_capability_writer_lock() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(refund_capability_lock_key());
  RETURN NULL;
END $$;
CREATE TRIGGER refund_capability_certificate_05_lock BEFORE INSERT ON refund_capability_certificate FOR EACH STATEMENT EXECUTE FUNCTION refund_capability_writer_lock();
CREATE TRIGGER refund_capability_certificate_10_append_only BEFORE UPDATE OR DELETE ON refund_capability_certificate FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_capability_certificate_11_no_truncate BEFORE TRUNCATE ON refund_capability_certificate FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_capability_revocation_05_lock BEFORE INSERT ON refund_capability_revocation FOR EACH STATEMENT EXECUTE FUNCTION refund_capability_writer_lock();
CREATE TRIGGER refund_capability_revocation_10_append_only BEFORE UPDATE OR DELETE ON refund_capability_revocation FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_capability_revocation_11_no_truncate BEFORE TRUNCATE ON refund_capability_revocation FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();

-- exactly the code registry (a test compares them both ways); neither is a real provider's guarantee
INSERT INTO refund_capability_certificate (id, version, fingerprint, "providerId", scope, "issuedAt", "expiresAt", "failureObservations", content, "approvalRef") VALUES
  ('simulation-refund-contract', 1, '083ed323872f46f1f9dbd9b2336baa5f0aa81d6b87b1acfe433fcf5d88e8eb14', 'simulation', 'simulation', '2026-11-23T00:00:00.000Z', NULL, ARRAY[]::text[],
   $c${"adapterMapping":"apps/payment-service/src/providers/simulation-provider.ts SimulationPaymentProvider.refund / fetchRefundStatus / verifyWebhook","authorization":"Owner D-R1 direction 2026-11-23 (Q1 capability model, Q5 idempotency expiry, Q6 simulation with isolation): models the simulator only","documentaryBasis":"payment-service migration 0017 simulation_refund_dispatch: one append-only row per idempotency key (FK to refund_attempt, no delete, no truncate), first answer kept for every repeat","expiresAt":null,"grants":{"idempotencyKeyRetention":{"unbounded":true},"statusAuthority":{"statusRead":true,"webhook":true}},"id":"simulation-refund-contract","issuedAt":"2026-11-23T00:00:00.000Z","providerId":"simulation","scope":"simulation","version":1}$c$,
   'OD-DR1-2, Owner, 2026-11-24'),
  ('simulation-refund-failure-finality', 1, '2a2bf9b3e8a2744c7be47e663161302a87a264c2bb7e6a0476856d23d68baf22', 'simulation', 'simulation', '2026-11-23T00:00:00.000Z', NULL,
   ARRAY['dispatch_rejected', 'provider_failed'],
   $c${"adapterMapping":"apps/payment-service/src/providers/simulation-provider.ts SimulationPaymentProvider.refund (rejected) / fetchRefundStatus (failed)","authorization":"Owner D-R1 direction 2026-11-23 (Q6): the simulation provider may explicitly model terminal failure finality; never promoted to a real provider","documentaryBasis":"modelled behaviour of the simulator; not a provider guarantee","expiresAt":null,"grants":{"terminalFailureFinality":{"observations":["dispatch_rejected","provider_failed"]}},"id":"simulation-refund-failure-finality","issuedAt":"2026-11-23T00:00:00.000Z","providerId":"simulation","scope":"simulation","version":1}$c$,
   'D-R1 Q6, Owner, 2026-11-23; D-R1B GO, 2026-11-24');

-- in force at an instant: registered, inside its window and not revoked (a revocation row ends it at once, whatever time it carries)
CREATE FUNCTION refund_capability_certificate_in_force(p_id text, p_version integer, p_fingerprint text, p_provider text, p_observation text, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM refund_capability_certificate c
    WHERE c.id = p_id AND c.version = p_version AND c.fingerprint = p_fingerprint AND c."providerId" = p_provider
      AND p_observation = ANY (c."failureObservations")
      AND p_at >= c."issuedAt" AND (c."expiresAt" IS NULL OR p_at < c."expiresAt")
      AND NOT EXISTS (SELECT 1 FROM refund_capability_revocation r WHERE r."certificateId" = c.id AND r."certificateVersion" = c.version))
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── the finality evidence

CREATE TABLE refund_attempt_failure_finality (
  "refundAttemptId"         uuid PRIMARY KEY REFERENCES refund_attempt (id),
  "paymentId"               uuid NOT NULL,          -- derived from the attempt
  "captureFactId"           uuid NOT NULL,          -- derived
  provider                  text NOT NULL,          -- derived
  "idempotencyKey"          text NOT NULL,          -- derived: the attempt id, the only key it was ever sent with
  observation               text NOT NULL,
  "observationSource"       text NOT NULL,
  "webhookEventId"          uuid REFERENCES webhook_event (id),
  "failureCode"             text NOT NULL,
  "certificateId"           text NOT NULL,
  "certificateVersion"      integer NOT NULL,
  "certificateFingerprint"  text NOT NULL,
  "recordedAt"              timestamptz NOT NULL,
  CONSTRAINT refund_failure_finality_payment_binding FOREIGN KEY ("refundAttemptId", "paymentId") REFERENCES refund_attempt (id, "paymentId"),
  CONSTRAINT refund_failure_finality_certificate_binding FOREIGN KEY ("certificateId", "certificateVersion", "certificateFingerprint", provider)
    REFERENCES refund_capability_certificate (id, version, fingerprint, "providerId"),
  CONSTRAINT refund_failure_finality_webhook_once UNIQUE ("webhookEventId"),
  CONSTRAINT refund_failure_finality_key CHECK ("idempotencyKey" = "refundAttemptId"::text),
  CONSTRAINT refund_failure_finality_code CHECK ("failureCode" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT refund_failure_finality_observation CHECK (
    (observation = 'dispatch_rejected' AND "observationSource" = 'dispatch_response' AND "webhookEventId" IS NULL)
    OR (observation = 'provider_failed' AND "observationSource" = 'status_check' AND "webhookEventId" IS NULL)
    OR (observation = 'provider_failed' AND "observationSource" = 'webhook' AND "webhookEventId" IS NOT NULL))
);

CREATE FUNCTION refund_failure_finality_insert_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a refund_attempt%ROWTYPE; pay uuid; at timestamptz;
BEGIN
  PERFORM refund_require_read_committed();
  SELECT "paymentId" INTO pay FROM refund_attempt WHERE id = NEW."refundAttemptId";
  PERFORM 1 FROM payment WHERE id = pay FOR UPDATE;
  SELECT * INTO a FROM refund_attempt WHERE id = NEW."refundAttemptId" FOR UPDATE;
  PERFORM pg_advisory_xact_lock_shared(refund_capability_lock_key());
  at := clock_timestamp();
  -- only the transaction that is failing it now (the commit check below): never a failure already recorded
  IF a.id IS NULL OR a.status NOT IN ('dispatching', 'submitted', 'unknown') THEN
    RAISE EXCEPTION 'refund_failure_finality: attempt % is not in flight', NEW."refundAttemptId" USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_finality_state';
  END IF;
  IF refund_capture_has_evidence(a."captureFactId") THEN
    RAISE EXCEPTION 'refund_failure_finality: capture % has refund evidence', a."captureFactId" USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_finality_evidence';
  END IF;
  IF NOT refund_capability_certificate_in_force(NEW."certificateId", NEW."certificateVersion", NEW."certificateFingerprint", a.provider, NEW.observation, at) THEN
    RAISE EXCEPTION 'refund_failure_finality: certificate % version % does not certify % for provider % now', NEW."certificateId", NEW."certificateVersion", NEW.observation, a.provider
      USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_finality_certificate';
  END IF;
  IF NEW."webhookEventId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_event w
       WHERE w.id = NEW."webhookEventId" AND w.provider = a.provider AND w."eventType" = 'refund.failed') THEN
    RAISE EXCEPTION 'refund_failure_finality: not a failure notification of provider %', a.provider USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_finality_webhook';
  END IF;
  NEW."paymentId" := a."paymentId";
  NEW."captureFactId" := a."captureFactId";
  NEW.provider := a.provider;
  NEW."idempotencyKey" := a.id::text;
  NEW."recordedAt" := at;
  RETURN NEW;
END $$;

CREATE FUNCTION refund_failure_finality_commit_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM refund_attempt a WHERE a.id = NEW."refundAttemptId" AND a.status = 'failed' AND a."failureCode" = NEW."failureCode") THEN
    RAISE EXCEPTION 'refund_failure_finality: attempt % was not failed with code % by this transaction', NEW."refundAttemptId", NEW."failureCode"
      USING ERRCODE = '23514', CONSTRAINT = 'refund_failure_finality_transition';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER refund_attempt_failure_finality_05_insert_guard BEFORE INSERT ON refund_attempt_failure_finality FOR EACH ROW EXECUTE FUNCTION refund_failure_finality_insert_guard();
CREATE TRIGGER refund_attempt_failure_finality_10_append_only BEFORE UPDATE OR DELETE ON refund_attempt_failure_finality FOR EACH ROW EXECUTE FUNCTION refund_append_only();
CREATE TRIGGER refund_attempt_failure_finality_11_no_truncate BEFORE TRUNCATE ON refund_attempt_failure_finality FOR EACH STATEMENT EXECUTE FUNCTION refund_append_only();
CREATE CONSTRAINT TRIGGER refund_attempt_failure_finality_20_commit AFTER INSERT ON refund_attempt_failure_finality DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION refund_failure_finality_commit_check();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── who may still pay

CREATE FUNCTION refund_attempt_may_still_pay(p_attempt uuid, p_at timestamptz) RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE((SELECT CASE
      WHEN a.status IN ('authorization_expired', 'authorization_refused') THEN false
      WHEN a.status = 'failed' THEN
        EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.kind = 'refund' AND f."refundAttemptId" = a.id)
        -- ambiguous: a refund fact under its exact provider reference, whoever it is bound to (read only; it attributes nothing, F-29)
        OR EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.kind = 'refund' AND f.provider = a.provider AND f."providerTxnId" = a."providerRefundId")
        OR NOT EXISTS (SELECT 1 FROM refund_attempt_failure_finality n
             WHERE n."refundAttemptId" = a.id AND n.provider = a.provider AND n."failureCode" = a."failureCode"
               AND refund_capability_certificate_in_force(n."certificateId", n."certificateVersion", n."certificateFingerprint", a.provider, n.observation, p_at))
      ELSE true END
    FROM refund_attempt a WHERE a.id = p_attempt), true)
$$;

-- The refusal of attempt `p_id` of this payment and capture at this instant, or NULL. The scopes are those of the two one-effective indexes (0022).
CREATE FUNCTION refund_attempt_replacement_refusal(p_id uuid, p_payment uuid, p_capture uuid, p_specific boolean, p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM refund_attempt o
           WHERE o.id <> p_id AND (o."captureFactId" = p_capture OR (o."paymentId" = p_payment AND NOT o."captureSpecific" AND NOT p_specific))
             AND refund_attempt_may_still_pay(o.id, p_at)) THEN 'refund_attempt_prior_may_still_pay'
    -- R6H-5, a second capture of the settling attempt: no other capture surely stays unrefunded, and one has a FAILED attempt that may still pay (or did)
    WHEN p_specific AND EXISTS (
           SELECT 1 FROM payment p JOIN provider_transaction_fact f ON f.id = p_capture AND f."paymentId" = p.id AND f."attemptId" = p."succeededAttemptId"
            WHERE p.id = p_payment AND p.status = 'succeeded'
              AND EXISTS (SELECT 1 FROM provider_transaction_fact g JOIN refund_attempt o ON o."captureFactId" = g.id AND o.id <> p_id AND o.status = 'failed'
                           WHERE g."paymentId" = p.id AND g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id
                             AND refund_attempt_may_still_pay(o.id, p_at))
              AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact g
                           WHERE g."paymentId" = p.id AND g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id
                             AND NOT refund_capture_has_evidence(g.id)
                             AND NOT EXISTS (SELECT 1 FROM refund_attempt o WHERE o."captureFactId" = g.id AND o.id <> p_id AND refund_attempt_may_still_pay(o.id, p_at))))
      THEN 'refund_attempt_last_capture_may_still_pay'
    END
$$;

CREATE FUNCTION refund_attempt_replacement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE refusal text;
BEGIN
  PERFORM refund_require_read_committed();
  IF TG_OP = 'UPDATE' THEN
    PERFORM pg_advisory_xact_lock(refund_dispatch_lock_key(NEW."paymentId")); -- already held by the 0032 guard; stated so this rule stands alone
  END IF;
  PERFORM 1 FROM payment WHERE id = NEW."paymentId" FOR UPDATE;               -- likewise (0022 insert guard, 0032 dispatch guard)
  PERFORM pg_advisory_xact_lock_shared(refund_capability_lock_key());
  refusal := refund_attempt_replacement_refusal(NEW.id, NEW."paymentId", NEW."captureFactId", NEW."captureSpecific", clock_timestamp());
  IF refusal IS NOT NULL THEN
    RAISE EXCEPTION 'refund_attempt %: an earlier attempt may still pay the same money (%)', NEW.id, refusal USING ERRCODE = '23514', CONSTRAINT = refusal;
  END IF;
  RETURN NEW;
END $$;
-- AFTER: the one-effective indexes keep refusing a second effective attempt first, exactly as before; this adds the failed one that may still pay
CREATE TRIGGER refund_attempt_22_prior_may_still_pay AFTER INSERT ON refund_attempt FOR EACH ROW EXECUTE FUNCTION refund_attempt_replacement_guard();
CREATE TRIGGER refund_attempt_09b_prior_may_still_pay BEFORE UPDATE OF status ON refund_attempt
  FOR EACH ROW WHEN (OLD.status = 'authorized' AND NEW.status = 'dispatching') EXECUTE FUNCTION refund_attempt_replacement_guard();

-- OD-DR1-1. A refund fact takes KEY SHARE on its attempt row (its foreign key): FOR UPDATE waits for a fact being written, so it is always seen.
CREATE FUNCTION refund_attempt_failed_after_fact_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM refund_require_read_committed();
  PERFORM 1 FROM payment WHERE id = NEW."paymentId" FOR UPDATE;
  PERFORM 1 FROM refund_attempt WHERE id = NEW.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM provider_transaction_fact f WHERE f.kind = 'refund' AND f."refundAttemptId" = NEW.id) THEN
    RAISE EXCEPTION 'refund_attempt %: it has its own verified refund fact and cannot become failed', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'refund_attempt_failed_after_refund_fact';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_attempt_07b_failed_after_fact BEFORE UPDATE OF status ON refund_attempt
  FOR EACH ROW WHEN (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION refund_attempt_failed_after_fact_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── privileges (0026's precedent)

DO $$
DECLARE r record;
BEGIN
  REVOKE ALL ON refund_capability_certificate, refund_capability_revocation, refund_attempt_failure_finality FROM PUBLIC;
  FOR r IN
    SELECT c.relname AS tbl, a.grantee::regrole::text AS role, a.privilege_type AS priv
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND a.grantee <> c.relowner AND a.grantee <> 0
       AND ((c.relname IN ('refund_capability_certificate', 'refund_capability_revocation') AND a.privilege_type <> 'SELECT')
         OR (c.relname = 'refund_attempt_failure_finality' AND a.privilege_type NOT IN ('SELECT', 'INSERT')))
  LOOP
    EXECUTE format('REVOKE %s ON %I FROM %s', r.priv, r.tbl, r.role);
  END LOOP;
END $$;
