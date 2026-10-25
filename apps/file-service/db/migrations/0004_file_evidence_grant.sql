-- Core V2 S2-File.1 (register FIL-01; OD-FILE decided by the Owner, F1 to F8): evidence grants.
--
-- A grant lets ONE named Core service (the grantee) use ONE file of another service (the grantor, the file's owner) for ONE approved
-- purpose and one case, within the file's own organization, until it expires or the grantor revokes it. It is a record, not a credential:
-- there is no grant secret (the grantee proves itself with its own service token once granted reads exist, S2-File.2). Nothing reads
-- through a grant yet. Expand only: one new table and its triggers; no existing row changes.

CREATE TABLE file_evidence_grant (
  id                uuid PRIMARY KEY,
  "fileId"          uuid NOT NULL,
  "grantorService"  text NOT NULL,
  "granteeService"  text NOT NULL,
  purpose           text NOT NULL,
  "caseRef"         uuid NOT NULL,
  "organizationId"  uuid,
  "idempotencyKey"  text NOT NULL,
  "requestHash"     text NOT NULL,
  "expiresAt"       timestamptz NOT NULL,
  "revokedAt"       timestamptz,
  "createdAt"       timestamptz NOT NULL DEFAULT now(),

  -- Within File's own database only; RESTRICT: a file row is never deleted anyway, and no cascade erases grant evidence.
  CONSTRAINT file_evidence_grant_file_fk FOREIGN KEY ("fileId") REFERENCES file (id),
  CONSTRAINT file_evidence_grant_grantor_shape CHECK ("grantorService" ~ '^[a-z][a-z0-9-]{1,62}$'),
  -- F2: the closed purpose vocabulary, each purpose with its one grantee; a service never grants to itself.
  CONSTRAINT file_evidence_grant_purpose_grantee CHECK (
       (purpose = 'dispute_evidence' AND "granteeService" = 'payment-service')
    OR (purpose = 'surplus_evidence' AND "granteeService" = 'billing-service')
    OR (purpose = 'settlement_evidence' AND "granteeService" = 'billing-service')
  ),
  CONSTRAINT file_evidence_grant_not_self CHECK ("grantorService" <> "granteeService"),
  CONSTRAINT file_evidence_grant_idempotency_key_shape CHECK ("idempotencyKey" ~ '^[\x21-\x7e]{1,255}$'),
  CONSTRAINT file_evidence_grant_request_hash_shape CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  -- Issuance is idempotent per grantor: one grant per (grantor, Idempotency-Key), the request hash tells a replay from a reuse.
  CONSTRAINT file_evidence_grant_idempotency_unique UNIQUE ("grantorService", "idempotencyKey"),
  -- F3: an explicit expiry after creation, at most 7 days; never extended (the column is immutable below).
  CONSTRAINT file_evidence_grant_lifetime_bounded CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '7 days'),
  CONSTRAINT file_evidence_grant_revoked_after_creation CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt")
);

-- A file's grants (revocation lookups, S2-File.2 granted reads by grantee).
CREATE INDEX file_evidence_grant_file_idx ON file_evidence_grant ("fileId", "granteeService");

-- Every binding is immutable and the lifetime never extended; revocation is stamped once (terminal: never back to NULL).
CREATE TRIGGER file_evidence_grant_immutable BEFORE UPDATE ON file_evidence_grant
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'fileId', 'grantorService', 'granteeService', 'purpose', 'caseRef', 'organizationId', 'idempotencyKey', 'requestHash',
    'expiresAt', 'createdAt');
CREATE TRIGGER file_evidence_grant_set_once BEFORE UPDATE ON file_evidence_grant
  FOR EACH ROW EXECUTE FUNCTION file_set_once('revokedAt');

-- F1 and the frozen "a grant never widens organization scope": a grant is created active, by the file's OWNER, in the file's OWN
-- organization, on an AVAILABLE, attached file. A cross-row rule a foreign key cannot express; the file row is locked (FOR SHARE) until
-- the issuing transaction ends, so a concurrent deletion request waits and the state checked here is the state committed. The bindings
-- are immutable, so the check at insert time holds forever.
CREATE FUNCTION file_evidence_grant_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'file_evidence_grant %: a grant is created active', NEW.id USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM file f
    WHERE f.id = NEW."fileId" AND f."ownerService" = NEW."grantorService" AND f."organizationId" IS NOT DISTINCT FROM NEW."organizationId"
      AND f.status = 'AVAILABLE' AND f."attachedAt" IS NOT NULL
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'file_evidence_grant %: the file is not the grantor''s available, attached file in this organization', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER file_evidence_grant_binding BEFORE INSERT ON file_evidence_grant
  FOR EACH ROW EXECUTE FUNCTION file_evidence_grant_binding_guard();

-- Never deleted: an expired or revoked grant stays as evidence of what was allowed (no cleanup in this slice).
CREATE FUNCTION file_evidence_grant_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'file_evidence_grant % is never deleted', OLD.id USING ERRCODE = '23514';
END $$;
CREATE TRIGGER file_evidence_grant_no_delete BEFORE DELETE ON file_evidence_grant
  FOR EACH ROW EXECUTE FUNCTION file_evidence_grant_no_delete();
