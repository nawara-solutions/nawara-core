-- Core V2 S4e (register PAY-03; ADR-0044 B7; S0 DB-15; the Owner's A-4): an Organization payer IS the payment's Organization scope.
-- A new payment whose payer is an Organization names that Organization as its `organizationId` (the scope the producer's Platforms are
-- checked against at creation and the Organization actor's membership is bound to at attempt, sync and read time). With
-- `payment_organization_matches_seller` (0002) this also means an Organization never pays an Organization seller.
--
-- Checked on INSERT only, so rows written before S4e (a purpose-less historical row included) are never re-judged; `payerType`, `payerId`
-- and `organizationId` were already immutable (0002 `payment_snapshot_immutable`), so the binding can never change afterwards.
-- Expand only: one function and one trigger. No existing row changes.

CREATE FUNCTION payment_organization_payer_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payerType" = 'organization' AND (NEW."organizationId" IS NULL OR NEW."organizationId"::text <> NEW."payerId") THEN
    RAISE EXCEPTION 'payment %: an Organization payer is the payment''s Organization (organizationId = payerId)', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'payment_organization_payer_scope';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payment_96_organization_payer_scope AFTER INSERT ON payment FOR EACH ROW EXECUTE FUNCTION payment_organization_payer_scope_guard();
