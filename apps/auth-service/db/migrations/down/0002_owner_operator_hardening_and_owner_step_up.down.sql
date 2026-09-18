-- Rollback of 0002. Restores the schema SHAPE of 0001; it cannot restore dropped VALUES
-- ("user"."trialEndsAt" is re-added empty — the data now lives in payment-service).
-- Not run automatically; never part of the forward migration chain.
--
-- Refuses if owner_auth_factor / owner_step_up contain rows, so enrolled factors and the step-up
-- audit trail are never destroyed silently. Archive them first if you really mean to roll back.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM owner_auth_factor) OR EXISTS (SELECT 1 FROM owner_step_up) THEN
    RAISE EXCEPTION 'down/0002 refused: owner_auth_factor / owner_step_up hold data (enrolled factors, step-up audit). Archive it first.';
  END IF;
  -- Re-adding the old email rule must not fail half-way: every non-operator needs an email again.
  IF EXISTS (SELECT 1 FROM "user" WHERE kind <> 'operator' AND email IS NULL) THEN
    RAISE EXCEPTION 'down/0002 refused: phone-only members/owners exist and 0001 requires an email for them.';
  END IF;
END $$;

DROP TABLE owner_step_up;
DROP TABLE owner_auth_factor;
DROP TYPE step_up_method;
DROP TYPE owner_factor_type;
DROP FUNCTION owner_step_up_guard();

DROP INDEX platform_company_idx;

ALTER TABLE "user" ADD COLUMN "trialEndsAt" timestamptz;
ALTER TABLE "user" ADD CONSTRAINT user_email_unless_operator CHECK (kind = 'operator' OR email IS NOT NULL);

DROP TRIGGER refresh_token_session_ceiling_by_kind ON refresh_token;
DROP FUNCTION refresh_token_session_ceiling_by_kind();
ALTER TABLE refresh_token DROP CONSTRAINT refresh_token_within_session_ceiling;

ALTER TABLE owner DROP CONSTRAINT owner_secret_key_hash_format;
ALTER TABLE admin_operator_code DROP CONSTRAINT aoc_code_hash_format, DROP CONSTRAINT aoc_consumed_before_expiry, DROP CONSTRAINT aoc_consumed_not_locked_out;

DROP TRIGGER operator_row_required ON operator;
DROP TRIGGER owner_row_required ON owner;
DROP FUNCTION subtype_row_still_required();

DROP TRIGGER operator_company_immutable ON operator;
DROP TRIGGER owner_company_immutable ON owner;

COMMIT;
