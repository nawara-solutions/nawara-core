-- Core V2 S2-File.2 (register FIL-02 / FIL-03; ADR-0048 Amendment 1): a download ticket issued FROM an evidence grant.
--
-- The grantee service (the ticket's issuer) is not the file's owner, so such a ticket names its grant: the binding becomes "the grant
-- names this file, this grantee and this organization, and is active", instead of "the issuer owns the file". The grant's lifetime is
-- never extended through a ticket: a grant ticket expires no later than its grant. Redemption re-checks the grant (not revoked, not
-- expired) in the same statement that claims the use; revoking a grant revokes its tickets in the same transaction (application).
-- Expand only: one nullable column, its index and immutability, and the binding rule widened for that column alone; an owner's ticket
-- (`grantId` NULL) keeps exactly the 0001 rule.

ALTER TABLE file_access_ticket ADD COLUMN "grantId" uuid;
ALTER TABLE file_access_ticket
  -- Within File's own database; RESTRICT: grants are never deleted, and a ticket row's retention purge does not touch its grant.
  ADD CONSTRAINT file_access_ticket_grant_fk FOREIGN KEY ("grantId") REFERENCES file_evidence_grant (id),
  ADD CONSTRAINT file_access_ticket_grant_download_only CHECK ("grantId" IS NULL OR operation = 'download');

CREATE INDEX file_access_ticket_grant_idx ON file_access_ticket ("grantId") WHERE "grantId" IS NOT NULL;

-- The grant a ticket was issued from never changes (the 0001 immutability trigger predates the column).
CREATE TRIGGER file_access_ticket_grant_immutable BEFORE UPDATE ON file_access_ticket
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change('grantId');

-- The 0001 binding rule, unchanged for an owner's ticket; for a grant ticket: the grant names this file, this issuer as its grantee and
-- this organization, and at creation it is active and outlives the ticket. Both sides are immutable, so the check at write time holds.
CREATE OR REPLACE FUNCTION file_access_ticket_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.operation = 'upload' AND NEW."fileId" IS NOT NULL THEN
    RAISE EXCEPTION 'file_access_ticket %: an upload ticket starts without a file', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW."grantId" IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM file_evidence_grant g JOIN file f ON f.id = g."fileId"
      WHERE g.id = NEW."grantId" AND g."fileId" = NEW."fileId" AND g."granteeService" = NEW."issuedBy"
        AND g."organizationId" IS NOT DISTINCT FROM NEW."organizationId" AND f."ownerService" = g."grantorService"
        AND g."revokedAt" IS NULL AND g."expiresAt" > now() AND NEW."expiresAt" <= g."expiresAt"
    ) THEN
      RAISE EXCEPTION 'file_access_ticket %: the grant does not cover this file, issuer and organization, or ends first', NEW.id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."fileId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM file f
    WHERE f.id = NEW."fileId" AND f."ownerService" = NEW."issuedBy" AND f."organizationId" IS NOT DISTINCT FROM NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'file_access_ticket %: the file is not the issuer''s in this organization', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
