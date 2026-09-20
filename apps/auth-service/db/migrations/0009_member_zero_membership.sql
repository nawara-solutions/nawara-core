-- Owner decision (2026-09-20, docs/architecture/stage-10/member-membership-invariant-owner-decision.md):
-- member -> OrganizationMembership [0..N] (was [1..N]). A member may now exist with zero memberships.
-- This is a database-integrity relaxation only: no authorization check anywhere reads "does this member
-- have >=1 membership" as a precondition (organizationAuthority/memberBelongsTo already re-derive live,
-- per request, per resource, whether a member has zero, one, or many memberships), so zero memberships
-- continues to grant zero organization authority, unchanged. owner/operator subtype requirements
-- (an owner row / an operator row must exist) are untouched.
BEGIN;

CREATE OR REPLACE FUNCTION user_require_subtype() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'owner' AND NOT EXISTS (SELECT 1 FROM owner WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=owner but no owner row', NEW.id USING ERRCODE = '23514';
  ELSIF NEW.kind = 'operator' AND NOT EXISTS (SELECT 1 FROM operator WHERE "userId" = NEW.id) THEN
    RAISE EXCEPTION 'user % has kind=operator but no operator row', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

COMMIT;
