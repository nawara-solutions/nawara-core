-- Core V2 S2-Audit.2 (ADR-0069 decisions 2 and 3; Owner decision D5): the storage of `approvedBy`, the verified human who approved a fact,
-- as the RECORDING service verified it (today only `authorization_receipt.consumed`: the issuing Owner, from Auth's own consumption).
--
-- EXPAND ONLY. Two nullable columns with no default: no existing row changes (NULL = no approver, which is what every earlier record is).
-- `approvedBy` is always a user reference (`{type:'user', id, userKind}`), so the type is implied and only the id and kind are stored.
-- A CHECK keeps both NULL on version-1 records and pairs them (both or neither, a known user kind).
-- (The runner applies the file in one transaction with its bookkeeping row.)

ALTER TABLE audit_record
  ADD COLUMN "approvedByUserId"   uuid,
  ADD COLUMN "approvedByUserKind" text;

ALTER TABLE audit_record ADD CONSTRAINT audit_record_approved_by_valid CHECK (
  ("approvedByUserId" IS NULL AND "approvedByUserKind" IS NULL)
  -- every term NOT NULL explicitly: a CHECK passes on NULL, so `kind IN (...)` alone would admit a NULL kind
  OR ("schemaVersion" >= 2 AND "approvedByUserId" IS NOT NULL AND "approvedByUserKind" IS NOT NULL
      AND "approvedByUserKind" IN ('member', 'owner', 'operator')));
