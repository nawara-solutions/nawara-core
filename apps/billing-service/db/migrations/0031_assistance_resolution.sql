-- Core V2 S5c beneficiary cash-return confirmation, assistance disputes and Owner timestamp corrections (register BIL-18 to BIL-22; S0
-- FC-8, DN-1.2; the Owner's decisions H-1 to H-7 and J-1 to J-6, 2026-10-28), for Core V2 DEVELOPMENT AND SIMULATION ONLY: production never
-- mounts these routes, and the services refuse there too.
--
--   * Confirmation (H-3, J-6): only the beneficiary moves a `return_reported` obligation to `confirmed_returned`, never while a dispute of
--     the request is open (J-4), and in the SAME transaction the request moves `cash_collected -> returned`, which resolves it and frees
--     the S5a D-7 slot. `resolved_by_owner` stays reserved and inactive (J-2): no state, no column, no path.
--   * assistance_dispute (H-4, J-1 to J-4): beneficiary-only, no filing cutoff, closed reason codes, at most one open dispute per request.
--     A dispute never changes a financial fact; the only resolution S5c admits (J-2, H-6) is the nonfinancial `timestamp_corrected` of a
--     timestamp dispute, bound to an Owner correction of exactly that timestamp appended after the dispute opened. A cash-not-returned or
--     collection-not-made dispute has no resolution in S5c: it stays open (J-1).
--   * assistance_dispute_response (H-5): one per dispute, by an Organization actor (never the beneficiary), `accepts | contests`;
--     evidence only, it changes no state.
--   * assistance_correction (H-2 option A): append-only Owner corrections of the two Organization-asserted times, `cashCollectedAt` and
--     `returnedAt`. The original evidence never changes; the effective value is the latest correction, derived. A correction never changes
--     `settleBy`, overdue, an obligation, a channel, a purchase or a payment (no window reopens, no violation is erased).
-- Lock order (H-7): the assistance request, then its cash-return obligation, then its dispute. Every guard below that needs more than its
-- own row takes the request row lock first.
-- Expand only: new tables, new nullable columns, widened checks every existing row satisfies, replaced guards.

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_request: returned

ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_status_valid;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_status_valid CHECK (status IN ('pending', 'declined', 'cash_collected', 'settled', 'returned'));
ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_cash_shape;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_cash_shape CHECK (
  (status IN ('cash_collected', 'settled', 'returned')) = ("cashCollectedAt" IS NOT NULL AND "reportedAt" IS NOT NULL AND "reportedBy" IS NOT NULL AND "settleBy" IS NOT NULL)
  AND (status IN ('cash_collected', 'settled', 'returned') OR ("cashCollectedAt" IS NULL AND "reportedAt" IS NULL AND "reportedBy" IS NULL AND "settleBy" IS NULL)));
ALTER TABLE assistance_request DROP CONSTRAINT assistance_request_collection_cap_shape;
ALTER TABLE assistance_request ADD CONSTRAINT assistance_request_collection_cap_shape CHECK ("collectionFeeCapVersion" IS NULL OR status IN ('cash_collected', 'settled', 'returned'));

-- J-6: a confirmed return resolves the request, so it frees the one-unresolved-request slot (D-7)
DROP INDEX assistance_request_unresolved_unique;
CREATE UNIQUE INDEX assistance_request_unresolved_unique ON assistance_request ("beneficiaryUserId", "organizationId", "productId") WHERE status NOT IN ('declined', 'settled', 'returned');

CREATE OR REPLACE FUNCTION billing_assistance_request_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap record;
BEGIN
  IF OLD.status = 'cash_collected' AND NEW.status IN ('settled', 'returned') THEN
    -- E-12: only the purchase path settles a request, in the transaction that records its purchase
    IF NEW.status = 'settled' AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = OLD.id) THEN
      RAISE EXCEPTION 'assistance request % is settled only by its purchase', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_settled_by_purchase';
    END IF;
    -- S5c J-6: only the beneficiary's confirmation returns a request, in the transaction that confirms its obligation
    IF NEW.status = 'returned' AND NOT EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = OLD.id AND o.status = 'confirmed_returned') THEN
      RAISE EXCEPTION 'assistance request % is returned only by the beneficiary''s confirmation', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_returned_by_confirmation';
    END IF;
    IF NEW."cashCollectedAt" IS DISTINCT FROM OLD."cashCollectedAt" OR NEW."reportedAt" IS DISTINCT FROM OLD."reportedAt" OR NEW."reportedBy" IS DISTINCT FROM OLD."reportedBy"
       OR NEW."settleBy" IS DISTINCT FROM OLD."settleBy" OR NEW."collectionFeeCapVersion" IS DISTINCT FROM OLD."collectionFeeCapVersion" THEN
      RAISE EXCEPTION 'assistance request %: the collection evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_collection_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('declined', 'cash_collected') THEN
    RAISE EXCEPTION 'assistance request % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_not_pending';
  END IF;
  IF NEW.status = 'declined' THEN
    NEW."declinedAt" := now();
    NEW."collectionFeeCapVersion" := NULL;
  ELSE
    NEW."reportedAt" := now();
    NEW."settleBy" := NEW."cashCollectedAt" + interval '72 hours';
    -- E-11: the frozen fee is validated against the Platform's CURRENT cap when the collection is recorded (never reduced or repriced)
    PERFORM billing_fee_lock(OLD."platformId");
    SELECT c.amount, c.version INTO cap FROM billing_current_fee_cap(OLD."platformId") c;
    IF OLD."feeAmount" > coalesce(cap.amount, 0) THEN
      RAISE EXCEPTION 'assistance request %: the frozen fee is above the platform''s current cap', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_request_fee_not_usable';
    END IF;
    NEW."collectionFeeCapVersion" := cap.version;
  END IF;
  RETURN NEW;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_dispute

CREATE TABLE assistance_dispute (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistanceRequestId" uuid NOT NULL,
  "beneficiaryUserId"   uuid NOT NULL,                        -- the disputing party: always the request's beneficiary (H-4)
  "organizationId"      uuid NOT NULL,
  "reasonCode"          text NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  "openedAt"            timestamptz NOT NULL DEFAULT now(),   -- the database's time; no filing cutoff exists
  "resolvedAt"          timestamptz,
  "resolvedBy"          uuid,                                 -- the Owner Auth verified, live
  outcome               text,
  "correctionId"        uuid,                                 -- the correction the nonfinancial resolution rests on
  CONSTRAINT assistance_dispute_request_fk FOREIGN KEY ("assistanceRequestId", "beneficiaryUserId", "organizationId")
    REFERENCES assistance_request (id, "beneficiaryUserId", "organizationId"),
  CONSTRAINT assistance_dispute_reason CHECK ("reasonCode" IN ('cash_not_returned', 'collection_not_made', 'collection_time_incorrect', 'return_time_incorrect')),
  CONSTRAINT assistance_dispute_status CHECK (status IN ('open', 'resolved')),
  -- J-2: the one resolution S5c admits is nonfinancial; no outcome discharges, confirms, pays or reverses anything
  CONSTRAINT assistance_dispute_outcome CHECK (outcome IS NULL OR outcome = 'timestamp_corrected'),
  CONSTRAINT assistance_dispute_resolution_shape CHECK (
    (status = 'resolved') = ("resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL AND outcome IS NOT NULL AND "correctionId" IS NOT NULL)
    AND (status = 'resolved' OR ("resolvedAt" IS NULL AND "resolvedBy" IS NULL AND outcome IS NULL AND "correctionId" IS NULL))),
  CONSTRAINT assistance_dispute_resolver_not_beneficiary CHECK ("resolvedBy" IS NULL OR "resolvedBy" <> "beneficiaryUserId"),
  CONSTRAINT assistance_dispute_resolution_time CHECK ("resolvedAt" IS NULL OR "resolvedAt" >= "openedAt")
);
-- H-4: at most one open dispute per request
CREATE UNIQUE INDEX assistance_dispute_open_unique ON assistance_dispute ("assistanceRequestId") WHERE status = 'open';
CREATE INDEX assistance_dispute_request_idx ON assistance_dispute ("assistanceRequestId", "openedAt");

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_correction

CREATE TABLE assistance_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "assistanceRequestId" uuid NOT NULL REFERENCES assistance_request (id),
  sequence              integer NOT NULL,                     -- per request, under its row lock: the order the corrections apply in
  field                 text NOT NULL,
  "correctedValue"      timestamptz NOT NULL,
  "supersededValue"     timestamptz NOT NULL,                 -- the effective value this correction supersedes (set by the guard)
  "reasonCode"          text NOT NULL,
  "correctedBy"         uuid NOT NULL,                        -- the Owner Auth verified, live
  "correctedAt"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistance_correction_sequence UNIQUE ("assistanceRequestId", sequence),
  CONSTRAINT assistance_correction_request_key UNIQUE (id, "assistanceRequestId"),
  CONSTRAINT assistance_correction_field CHECK (field IN ('cashCollectedAt', 'returnedAt')),
  CONSTRAINT assistance_correction_reason CHECK ("reasonCode" IN ('actor_entry_error', 'evidence_contradicts_report')),
  CONSTRAINT assistance_correction_changes CHECK ("correctedValue" <> "supersededValue")
);

ALTER TABLE assistance_dispute ADD CONSTRAINT assistance_dispute_correction_fk
  FOREIGN KEY ("correctionId", "assistanceRequestId") REFERENCES assistance_correction (id, "assistanceRequestId");

-- The effective value of an Organization-asserted time: the latest correction, else the original evidence (never stored).
CREATE FUNCTION billing_assistance_effective_time(p_request uuid, p_field text) RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT c."correctedValue" FROM assistance_correction c WHERE c."assistanceRequestId" = p_request AND c.field = p_field ORDER BY c.sequence DESC LIMIT 1),
    CASE p_field
      WHEN 'cashCollectedAt' THEN (SELECT a."cashCollectedAt" FROM assistance_request a WHERE a.id = p_request)
      WHEN 'returnedAt' THEN (SELECT o."returnedAt" FROM cash_return_obligation o WHERE o."assistanceRequestId" = p_request)
    END);
$$;

-- H-2: the field must carry asserted evidence; the corrected value keeps the FC-8 / E-9 time order against the other effective values
CREATE FUNCTION billing_assistance_correction_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; o record; collected timestamptz; returned timestamptz;
BEGIN
  IF NEW.field IS NULL OR NEW.field NOT IN ('cashCollectedAt', 'returnedAt') THEN -- H-2: nothing monetary, nothing else, is correctable
    RAISE EXCEPTION 'assistance correction: % is not correctable', NEW.field USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_field';
  END IF;
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF r.id IS NULL OR r.status NOT IN ('cash_collected', 'settled', 'returned') THEN
    RAISE EXCEPTION 'assistance request %: no Organization-asserted time to correct', NEW."assistanceRequestId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  SELECT * INTO o FROM cash_return_obligation WHERE "assistanceRequestId" = r.id;
  IF NEW.field = 'returnedAt' AND o."returnedAt" IS NULL THEN
    RAISE EXCEPTION 'assistance request %: no reported cash return to correct', r.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  IF NEW."correctedBy" = r."beneficiaryUserId" OR NEW."correctedBy" = r."reportedBy" OR NEW."correctedBy" IS NOT DISTINCT FROM o."returnReportedBy" THEN
    RAISE EXCEPTION 'a correction is never made by a party to the request' USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_not_permitted';
  END IF;
  collected := billing_assistance_effective_time(r.id, 'cashCollectedAt');
  returned := billing_assistance_effective_time(r.id, 'returnedAt');
  NEW."supersededValue" := CASE NEW.field WHEN 'cashCollectedAt' THEN collected ELSE returned END;
  IF NEW.field = 'cashCollectedAt' THEN collected := NEW."correctedValue"; ELSE returned := NEW."correctedValue"; END IF;
  IF NOT (r."consentAt" <= collected AND collected <= r."reportedAt") OR (returned IS NOT NULL AND NOT (collected <= returned AND returned <= o."returnReportedAt")) THEN
    RAISE EXCEPTION 'assistance request %: the corrected time breaks the recorded time order', r.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_correction_time_order';
  END IF;
  NEW.sequence := coalesce((SELECT max(c.sequence) FROM assistance_correction c WHERE c."assistanceRequestId" = r.id), 0) + 1;
  NEW."correctedAt" := clock_timestamp(); -- after the request lock: the recorded order is the commit order (never the transaction's start)
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_correction_05_insert_guard BEFORE INSERT ON assistance_correction FOR EACH ROW EXECUTE FUNCTION billing_assistance_correction_insert_guard();
CREATE TRIGGER assistance_correction_10_append_only BEFORE UPDATE OR DELETE ON assistance_correction FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER assistance_correction_11_no_truncate BEFORE TRUNCATE ON assistance_correction FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── dispute guards

-- H-4, J-3: the request must carry cash evidence; the reason must concern evidence that exists (a cash return needs an obligation, a
-- return time a reported return). A resolved request may be disputed: the dispute never re-takes the D-7 slot.
CREATE FUNCTION billing_assistance_dispute_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; o record;
BEGIN
  SELECT * INTO r FROM assistance_request WHERE id = NEW."assistanceRequestId" FOR UPDATE;
  IF NEW.status <> 'open' OR NEW."resolvedAt" IS NOT NULL OR NEW."resolvedBy" IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW."correctionId" IS NOT NULL THEN
    RAISE EXCEPTION 'a dispute is opened open' USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_created_open';
  END IF;
  SELECT * INTO o FROM cash_return_obligation WHERE "assistanceRequestId" = r.id;
  IF r.status NOT IN ('cash_collected', 'settled', 'returned')
     OR (NEW."reasonCode" = 'cash_not_returned' AND o.id IS NULL)
     OR (NEW."reasonCode" = 'return_time_incorrect' AND o."returnedAt" IS NULL) THEN
    RAISE EXCEPTION 'assistance request %: the % dispute concerns no recorded evidence', r.id, NEW."reasonCode" USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_not_permitted';
  END IF;
  NEW."openedAt" := clock_timestamp(); -- after the request lock: a dispute serialized after a confirmation is recorded after it
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_dispute_05_insert_guard BEFORE INSERT ON assistance_dispute FOR EACH ROW EXECUTE FUNCTION billing_assistance_dispute_insert_guard();
CREATE TRIGGER assistance_dispute_10_immutable BEFORE UPDATE ON assistance_dispute
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'resolvedAt', 'resolvedBy', 'outcome', 'correctionId');

-- J-1, J-2, H-6: open -> resolved only as `timestamp_corrected`: a timestamp dispute, closed on an Owner correction of exactly the disputed
-- time appended after the dispute opened. Nothing else resolves a dispute in S5c (a cash-not-returned or collection-not-made one stays open).
CREATE FUNCTION billing_assistance_dispute_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  IF OLD.status <> 'open' OR NEW.status <> 'resolved' THEN
    RAISE EXCEPTION 'dispute % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_not_open';
  END IF;
  PERFORM 1 FROM assistance_request WHERE id = OLD."assistanceRequestId" FOR UPDATE;
  SELECT * INTO c FROM assistance_correction WHERE id = NEW."correctionId" AND "assistanceRequestId" = OLD."assistanceRequestId";
  IF NEW.outcome IS DISTINCT FROM 'timestamp_corrected' OR c.id IS NULL OR c."correctedAt" < OLD."openedAt"
     OR NOT ((OLD."reasonCode" = 'collection_time_incorrect' AND c.field = 'cashCollectedAt') OR (OLD."reasonCode" = 'return_time_incorrect' AND c.field = 'returnedAt')) THEN
    RAISE EXCEPTION 'dispute %: no permitted nonfinancial resolution', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_resolution_not_permitted';
  END IF;
  NEW."resolvedAt" := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_dispute_20_transition BEFORE UPDATE ON assistance_dispute FOR EACH ROW EXECUTE FUNCTION billing_assistance_dispute_transition_guard();
CREATE TRIGGER assistance_dispute_90_no_delete BEFORE DELETE ON assistance_dispute FOR EACH ROW EXECUTE FUNCTION billing_no_delete();
CREATE TRIGGER assistance_dispute_91_no_truncate BEFORE TRUNCATE ON assistance_dispute FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── assistance_dispute_response

CREATE TABLE assistance_dispute_response (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "disputeId"   uuid NOT NULL UNIQUE REFERENCES assistance_dispute (id),  -- H-5: one response per dispute
  position      text NOT NULL,
  "respondedBy" uuid NOT NULL,                                            -- the Organization actor Auth verified, live
  "respondedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistance_dispute_response_position CHECK (position IN ('accepts', 'contests'))
);

CREATE FUNCTION billing_assistance_dispute_response_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  SELECT * INTO d FROM assistance_dispute WHERE id = NEW."disputeId";
  PERFORM 1 FROM assistance_request WHERE id = d."assistanceRequestId" FOR UPDATE; -- H-7: the request first, then the dispute
  SELECT * INTO d FROM assistance_dispute WHERE id = NEW."disputeId" FOR UPDATE;
  IF d.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'dispute %: only an open dispute is answered', NEW."disputeId" USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_not_open';
  END IF;
  IF NEW."respondedBy" = d."beneficiaryUserId" THEN
    RAISE EXCEPTION 'the beneficiary never answers their own dispute' USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_response_not_beneficiary';
  END IF;
  NEW."respondedAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER assistance_dispute_response_05_insert_guard BEFORE INSERT ON assistance_dispute_response FOR EACH ROW EXECUTE FUNCTION billing_assistance_dispute_response_insert_guard();
CREATE TRIGGER assistance_dispute_response_10_append_only BEFORE UPDATE OR DELETE ON assistance_dispute_response FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE TRIGGER assistance_dispute_response_11_no_truncate BEFORE TRUNCATE ON assistance_dispute_response FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── cash_return_obligation: confirmed_returned

ALTER TABLE cash_return_obligation ADD COLUMN "confirmedAt" timestamptz;  -- the database's time of the beneficiary's confirmation
ALTER TABLE cash_return_obligation ADD COLUMN "confirmedBy" uuid;         -- always the beneficiary (H-3)
ALTER TABLE cash_return_obligation DROP CONSTRAINT cash_return_obligation_status;
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_status CHECK (status IN ('open', 'return_reported', 'confirmed_returned'));
ALTER TABLE cash_return_obligation DROP CONSTRAINT cash_return_obligation_report_shape;
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_report_shape CHECK (
  (status IN ('return_reported', 'confirmed_returned')) = ("returnedAt" IS NOT NULL AND "returnReportedAt" IS NOT NULL AND "returnReportedBy" IS NOT NULL)
  AND (status IN ('return_reported', 'confirmed_returned') OR ("returnedAt" IS NULL AND "returnReportedAt" IS NULL AND "returnReportedBy" IS NULL)));
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_confirm_shape CHECK (
  (status = 'confirmed_returned') = ("confirmedAt" IS NOT NULL AND "confirmedBy" IS NOT NULL)
  AND (status = 'confirmed_returned' OR ("confirmedAt" IS NULL AND "confirmedBy" IS NULL)));
-- H-3: only the beneficiary confirms; an Owner or the Organization never manufactures the confirmation
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_confirmed_by_beneficiary CHECK ("confirmedBy" IS NULL OR "confirmedBy" = "beneficiaryUserId");
ALTER TABLE cash_return_obligation ADD CONSTRAINT cash_return_obligation_confirm_time CHECK ("confirmedAt" IS NULL OR "confirmedAt" >= "returnReportedAt");

DROP TRIGGER cash_return_obligation_10_immutable ON cash_return_obligation;
CREATE TRIGGER cash_return_obligation_10_immutable BEFORE UPDATE ON cash_return_obligation
  FOR EACH ROW EXECUTE FUNCTION billing_immutable_except('status', 'returnedAt', 'returnReportedAt', 'returnReportedBy', 'confirmedAt', 'confirmedBy');

CREATE OR REPLACE FUNCTION billing_cash_return_obligation_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'return_reported' THEN
    -- E-9 (and J-5: also while a dispute is open; the report is evidence, it closes no dispute and discharges nothing)
    IF NEW."confirmedAt" IS NOT NULL OR NEW."confirmedBy" IS NOT NULL THEN
      RAISE EXCEPTION 'cash-return obligation %: a report is not a confirmation', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_open';
    END IF;
    NEW."returnReportedAt" := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'return_reported' AND NEW.status = 'confirmed_returned' THEN
    PERFORM 1 FROM assistance_request WHERE id = OLD."assistanceRequestId" FOR UPDATE; -- H-7: the request first (a no-op when already held)
    IF NEW."returnedAt" IS DISTINCT FROM OLD."returnedAt" OR NEW."returnReportedAt" IS DISTINCT FROM OLD."returnReportedAt" OR NEW."returnReportedBy" IS DISTINCT FROM OLD."returnReportedBy" THEN
      RAISE EXCEPTION 'cash-return obligation %: the return evidence never changes', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_obligation_report_immutable';
    END IF;
    -- J-4: an open dispute blocks the confirmation
    IF EXISTS (SELECT 1 FROM assistance_dispute d WHERE d."assistanceRequestId" = OLD."assistanceRequestId" AND d.status = 'open') THEN
      RAISE EXCEPTION 'cash-return obligation %: a dispute of its request is open', OLD.id USING ERRCODE = '23514', CONSTRAINT = 'assistance_dispute_open';
    END IF;
    NEW."confirmedAt" := clock_timestamp(); -- after the request lock (see the dispute guard)
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' THEN
    RAISE EXCEPTION 'cash-return obligation % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_reported';
  END IF;
  RAISE EXCEPTION 'cash-return obligation % cannot move from % to %', OLD.id, OLD.status, NEW.status USING ERRCODE = '23514', CONSTRAINT = 'cash_return_not_open';
END $$;

-- J-6: a confirmed obligation and its returned request commit together, whatever path writes them (checked at COMMIT)
CREATE FUNCTION billing_cash_return_confirmation_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'confirmed_returned' AND NOT EXISTS (SELECT 1 FROM assistance_request a WHERE a.id = NEW."assistanceRequestId" AND a.status = 'returned') THEN
    RAISE EXCEPTION 'cash-return obligation %: its request must be returned in the same transaction', NEW.id USING ERRCODE = '23514', CONSTRAINT = 'cash_return_confirmation_returns_request';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER cash_return_obligation_95_confirmation_commit AFTER UPDATE ON cash_return_obligation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION billing_cash_return_confirmation_commit_guard();

-- ─────────────────────────────────────────────────────────────────────────────────────────────── idempotency and privileges

ALTER TABLE assistance_command_idempotency DROP CONSTRAINT assistance_command_idempotency_operation;
ALTER TABLE assistance_command_idempotency ADD CONSTRAINT assistance_command_idempotency_operation CHECK (operation IN (
  'assistance_request.create', 'assistance_request.decline', 'assistance_request.cash_collection', 'assistance_request.settlement', 'cash_return_obligation.return',
  'cash_return_obligation.confirm', 'assistance_request.dispute', 'assistance_dispute.respond', 'assistance_request.correct', 'assistance_dispute.resolve'));

-- the runtime role: INSERT, SELECT and UPDATE (the guarded resolution) on disputes; INSERT and SELECT on responses and corrections (the
-- 0018 pattern: whatever the roles are called)
DO $$
DECLARE r record; t text; privs text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistance_dispute', 'assistance_dispute_response', 'assistance_correction'] LOOP
    privs := CASE WHEN t = 'assistance_dispute' THEN 'DELETE, TRUNCATE, REFERENCES, TRIGGER' ELSE 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER' END;
    EXECUTE format('REVOKE %s ON %I FROM PUBLIC', privs, t);
    FOR r IN
      SELECT DISTINCT a.grantee::regrole::text AS role
        FROM pg_class c, aclexplode(c.relacl) a
       WHERE c.relname = t AND a.grantee <> c.relowner AND a.grantee <> 0
         AND a.privilege_type = ANY (string_to_array(replace(privs, ' ', ''), ','))
    LOOP
      EXECUTE format('REVOKE %s ON %I FROM %s', privs, t, r.role);
    END LOOP;
  END LOOP;
END $$;
