-- Core V2 S4b (register PAY-06; S0 §3.2 DB-16, §3.8 FC-11; safeguard S-7; ADR-0068 decision 3): no cash settlement of a Company
-- seller. In Core V2 the only Company seller is the Nawara operating Company (ADR-0068 decision 1), and only verified electronic
-- settlement may settle what it sells: a manual, trust-based or out-of-band confirmation never does.
--
--   * A same-row CHECK on `payment`: `settledMethod = 'cash'` is refused when `sellerType = 'company'`, on every INSERT and UPDATE and
--     whatever path writes it (raw SQL included). It reads the seller TYPE only: it neither infers nor asserts any legal identity.
--   * No route, DTO or error code: no code path sets `cash` (only `gateway`, on a verified provider success), so this is a database guard
--     only (PAY-06 B, C). Cash for any other seller type stays as it is in the schema and is deferred (ADR-0068 decision 4): nothing here
--     enables a cash workflow.
--   * Every existing row satisfies it (nothing has ever set `cash`), so it is added VALIDATED, rewriting no row (roadmap §4.4).

ALTER TABLE payment ADD CONSTRAINT payment_no_company_cash_settlement CHECK ("settledMethod" IS DISTINCT FROM 'cash' OR "sellerType" <> 'company');
