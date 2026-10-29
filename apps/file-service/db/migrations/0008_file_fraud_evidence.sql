-- Core V2 S6e-H File prerequisite (register FIL-01; BIL-27; the Owner's H-3, 2026-10-29): the `fraud_evidence` grant purpose.
--
-- A fraud hold cannot be placed without evidence (H-3). Its evidence is a file its owner service grants to billing-service, the purpose's
-- one grantee, through the existing grant architecture: one file, one purpose, one case (`caseRef`, the hold's id), the file's own
-- organization, a bounded lifetime, revocable, never deleted. A `fraud_evidence` grant ALSO names the Company and the subject (the
-- beneficiary) it is evidence about, so the grantee can bind it to exactly that hold, Company and beneficiary; no other purpose carries
-- them. Expand only: the closed vocabulary gains one purpose, two nullable columns appear; every existing row keeps its values.

ALTER TABLE file_evidence_grant DROP CONSTRAINT file_evidence_grant_purpose_grantee;
ALTER TABLE file_evidence_grant ADD CONSTRAINT file_evidence_grant_purpose_grantee CHECK (
     (purpose = 'dispute_evidence' AND "granteeService" = 'payment-service')
  OR (purpose = 'surplus_evidence' AND "granteeService" = 'billing-service')
  OR (purpose = 'settlement_evidence' AND "granteeService" = 'billing-service')
  OR (purpose = 'fraud_evidence' AND "granteeService" = 'billing-service')
);

ALTER TABLE file_evidence_grant ADD COLUMN "companyId" uuid;
ALTER TABLE file_evidence_grant ADD COLUMN "subjectUserId" uuid;
-- exactly a `fraud_evidence` grant names its Company and subject; no other purpose may carry either
ALTER TABLE file_evidence_grant ADD CONSTRAINT file_evidence_grant_fraud_subject CHECK (
  (purpose = 'fraud_evidence') = ("companyId" IS NOT NULL) AND (purpose = 'fraud_evidence') = ("subjectUserId" IS NOT NULL)
);

-- the bindings stay immutable, the new ones included
DROP TRIGGER file_evidence_grant_immutable ON file_evidence_grant;
CREATE TRIGGER file_evidence_grant_immutable BEFORE UPDATE ON file_evidence_grant
  FOR EACH ROW EXECUTE FUNCTION forbid_column_change(
    'id', 'fileId', 'grantorService', 'granteeService', 'purpose', 'caseRef', 'organizationId', 'idempotencyKey', 'requestHash',
    'expiresAt', 'createdAt', 'companyId', 'subjectUserId');
