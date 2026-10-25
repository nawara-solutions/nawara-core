-- Core V2 S2-Audit.1 (ADR-0069 decisions 1, 2 and 4; register AUD-01, AUD-02): the storage of audit contract version 2 and of trusted scope.
--
-- EXPAND ONLY. History is never rewritten: every new column is nullable with no default (no existing row changes; NULL = "not recorded",
-- which is what every earlier record is), and the one new table is insert-only. Nothing reads the new columns or the table yet (the human
-- reads of ADR-0069 decision 5 are a later slice).
--
--   * `audit_record."companyId"`, `"platformId"`, `"liveMode"`: the version-2 facts as the producer ASSERTED them. Only a version-2 record
--     can carry them (a CHECK; every existing row is version 1 with them NULL, so it holds for all history).
--   * `audit_record."producerIdentityVerified"`: whether the delivery that created the record was broker-verified (ADR-0057 §13: broker
--     user = source = the catalog owner); `"replayed"`: whether it was a replay. Delivery facts, decided by the consumer's trust decision;
--     NULL for every earlier record and for Audit's own records (never delivered over the bus). Never upgraded later (append-only).
--   * `audit_record_scope`: the TRUSTED scope rows (decision 4). One per record at most, written in the SAME statement as its record, and
--     only when the producer is verified and asserted a Company or Platform its catalog entry allows. The trigger below makes the database
--     refuse anything else, for every role: a row for a record of another transaction (no retroactive trust), for an unverified record, or
--     with ids other than the record's own assertion. The basis "organization_reference" of decision 4 is not created here (Audit has no
--     Organization reference yet); ownership is never inferred.
--   * No foreign key (as `audit_record` and the provenance tables): the Stage 18.8 retention purge of `audit_record` is unchanged. A scope
--     row whose record was purged is never read (reads join the record). Its own retention and legal holds are a later decision (OD-13, P-A2).
-- (The runner applies the file in one transaction with its bookkeeping row.)

ALTER TABLE audit_record
  ADD COLUMN "companyId"                uuid,
  ADD COLUMN "platformId"               uuid,
  ADD COLUMN "liveMode"                 boolean,
  ADD COLUMN "producerIdentityVerified" boolean,
  ADD COLUMN replayed                   boolean;

ALTER TABLE audit_record ADD CONSTRAINT audit_record_v2_fields_need_v2
  CHECK ("schemaVersion" >= 2 OR ("companyId" IS NULL AND "platformId" IS NULL AND "liveMode" IS NULL));
-- one id never names two scope levels (Company, Platform, Organization are distinct entities): compared only where both are present
ALTER TABLE audit_record ADD CONSTRAINT audit_record_scope_levels_distinct CHECK (
      ("companyId" IS NULL OR "platformId" IS NULL OR "companyId" <> "platformId")
  AND ("companyId" IS NULL OR "organizationId" IS NULL OR "companyId" <> "organizationId")
  AND ("platformId" IS NULL OR "organizationId" IS NULL OR "platformId" <> "organizationId"));
ALTER TABLE audit_record ADD CONSTRAINT audit_record_replayed_needs_assessment
  CHECK (replayed IS NULL OR "producerIdentityVerified" IS NOT NULL);

CREATE TABLE audit_record_scope (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "recordId"   bigint NOT NULL,
  basis        text NOT NULL,
  "companyId"  uuid,
  "platformId" uuid,
  "createdAt"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_record_scope_basis_valid CHECK (basis IN ('verified_producer')),
  CONSTRAINT audit_record_scope_not_empty CHECK ("companyId" IS NOT NULL OR "platformId" IS NOT NULL),
  CONSTRAINT audit_record_scope_once UNIQUE ("recordId", basis)
);
CREATE INDEX audit_record_scope_company_idx ON audit_record_scope ("companyId", "recordId") WHERE "companyId" IS NOT NULL;
CREATE INDEX audit_record_scope_platform_idx ON audit_record_scope ("platformId", "recordId") WHERE "platformId" IS NOT NULL;

-- Insert-time proof (every role, the owner included, except a superuser who can disable triggers): the record exists, was inserted by THIS
-- transaction, is producer-verified, and asserted exactly these ids.
CREATE FUNCTION audit_record_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'audit_record_scope is append-only (% refused)', TG_OP USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM audit_record r
        WHERE r.id = NEW."recordId"
          AND r.xmin = pg_current_xact_id()::xid
          AND r."producerIdentityVerified" IS TRUE
          AND r."companyId" IS NOT DISTINCT FROM NEW."companyId"
          AND r."platformId" IS NOT DISTINCT FROM NEW."platformId") THEN
    RAISE EXCEPTION 'audit_record_scope: only the verified record''s own assertion, in the transaction that stores it' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_record_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON audit_record_scope
  FOR EACH ROW EXECUTE FUNCTION audit_record_scope_guard();
CREATE TRIGGER audit_record_scope_no_truncate BEFORE TRUNCATE ON audit_record_scope
  FOR EACH STATEMENT EXECUTE FUNCTION audit_event_provenance_append_only();
SELECT audit_restrict_to_append_only('audit_record_scope');
