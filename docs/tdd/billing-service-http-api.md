# billing-service: Stage 3 HTTP API (catalog, invoices, Billing-side payment requests)

- **Status:** Implemented
- **Author:** Claude (Billing Stage 3 session), for the project owner
- **Related SDD:** [billing-service.md](../sdd/billing-service.md) (section 18 API design, 19 authorization, 25 idempotency, 26 concurrency, 34.1 Stage 3)
- **Related ADRs:** [0032](../adr/0032-database-per-service-on-a-shared-server.md), [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0034](../adr/0034-shared-service-kit-and-api-conventions.md)
- **Ticket/issue:** Billing Stage 3 (the HTTP API over the Stage 2 domain; no Payment integration)

**Note on this document's timing:** this repo's convention (`docs/tdd/README.md`) is to write a TDD *before* the
code. Stage 3 was implemented without one — a gap a later architecture review flagged. This document is written
**after the fact**, from the code and tests as they actually shipped (commit `2847557`, merged via PR #49), exactly
as the "reflect reality only" instruction that commissioned it requires. It is not a plan; it is a record.

## Problem

Stage 2 gave Billing a database and pure domain rules with no way to reach them over HTTP. Stage 3 exposes exactly
the `[T]`/`[D]` parts of the SDD's section 18 API design that don't depend on an unresolved `[B]` decision: products,
prices, invoice create/get/list/issue/discard, and Billing's own `payment_request` create/get. It decides no `[B]`
question and implements no `[X]` feature.

## Approach

**Controllers stay thin; the domain/repository layer does everything else.** Every mutating endpoint's body is
validated by a hand-written normaliser (not a class-validator DTO) that whitelists fields explicitly — an unknown
field is always `400`, so a client can never smuggle `amount`, `total`, `currency`, `status`, or `producer` into a
request. This mirrors the pattern Stage 2 already established for invoice creation (`invoice-input.ts`) rather than
importing Payment's class-validator style; the two services are allowed to differ here, since neither convention is
mandated project-wide.

Design decisions worth knowing:

- **Authorization is a relation, never a filter.** `relationTo` (invoice: producer or user-payer) and the new
  `catalogRelationTo` (product/price: producer only, via the parent product for a price) are the only places that
  decide who may see or act on a resource. A caller with no relation gets the same `404` as a missing resource
  (SDD 19.2). No generic Auth capability (`adminTier`) is ever read for a Billing decision.
- **Producer isolation needed a schema completion, not a redesign.** The SDD already documents product/price
  isolation as "reached by the producer that created it" (section 11), but Stage 2's migration never added a column
  to enforce it — no write endpoint existed yet to need one. Migration `0010_product_producer.sql` adds
  `product.producer` (immutable by the pre-existing allow-list trigger, indexed, `NOT NULL` with no default because
  the table was provably empty in every environment). A price has no producer column of its own: it is reached only
  by joining to its parent product.
- **List scope is derived from the caller, never from a filter (SDD 18.1 endpoint 9).** `InvoiceRepository.listForCaller`
  builds its `WHERE` clause starting from the caller's own scope (producer name, or `payerType='user' AND
  payerId=caller`) and ANDs every optional filter onto it — a filter can only narrow, never widen, so a mismatched
  `payerId` yields an empty page, never another caller's data.
- **Payment requests are Billing-only records in this stage.** `PaymentRequestsController` creates and reads rows in
  `payment_request` using the Stage 2 repository unchanged; nothing here calls Payment. Every created request
  therefore has `status: "created"` and `paymentId: null`, because no dispatcher exists to set anything else — this
  is a structural fact (no code path can set `paymentId`), not a policy documented only in a comment.
- **Invoice read/list for the payer, and payment-request creation, are Stage 3, not Stage 6/4.** The SDD's own
  stage table originally disagreed with itself about this (endpoint 13 dated "4" in one table and "6" in another);
  that inconsistency was corrected in a follow-up documentation-only PR (#50) once this code had already shipped —
  see billing-service.md section 18's "Stage 3 vs. Stage 4" note. The underlying relations were always `[T]`, so
  nothing was invented; only the SDD's bookkeeping was wrong.
- **The issue endpoint's locale.** SDD endpoint 10 says "no body," yet the presentation snapshot needs a locale
  (BI-20). Stage 2's own TDD flagged this as an open Stage 3 decision ("service default or an optional body").
  Resolved as: an optional body `{ locale? }` defaulting to `en`; the *template* is never client-supplied — only the
  frozen `SYSTEM_TEMPLATE_V1` default is used, since the presentation designer is deferred (SDD section 36).
- **Representations are hand-built, never a row spread.** `representInvoice`/`representInvoiceSummary`/`representProduct`/
  `representPrice`/`representPaymentRequest` each construct their output field by field, so internal columns
  (`revision`, `producer`, `requestHash`, `billing_transition` history) can never leak into an API response by
  accident when a new column is added later.

## Files/components affected

- `apps/billing-service/db/migrations/0010_product_producer.sql` — adds `product.producer` (isolation column)
- `apps/billing-service/src/catalog/**` — `ProductRepository`, `PriceRepository`, `ProductsController`, `PricesController`,
  representations, row types (new module)
- `apps/billing-service/src/invoices/invoices.controller.ts`, `payment-requests.controller.ts`,
  `invoice.representation.ts`, `payment-request.representation.ts` (new); `invoice.repository.ts` (`listForCaller`
  added), `payment-request.repository.ts` (`findActiveForInvoice` added), `invoices.module.ts` (controllers wired)
- `apps/billing-service/src/domain/product-input.ts`, `price-input.ts` (new normalisers); `invoice-input.ts`
  (list-filter and issue-body normalisers added); `relations.ts` (`catalogRelationTo` added); `errors.ts` (catalog
  error codes added)
- `apps/billing-service/src/auth/domain-caller.ts` (new) — maps the HTTP guard's `Caller` (carries `AuthIdentity`) to
  the domain layer's minimal `Caller` (carries only `userId`), so the domain stays independent of the kit's auth types
- `apps/billing-service/src/config/billing-config.ts` — adds `rateLimits` (invoice/payment-request creation, per
  authenticated caller)
- `apps/billing-service/src/app.module.ts` — wires `CatalogModule`
- `apps/billing-service/src/docs/openapi.spec.ts` (new) — builds the real Swagger document and asserts every Stage 3
  operation is present with a summary and a response, and that nothing Stage 4/6/8/blocked leaks into it
- Tests: `apps/billing-service/test/http-api.e2e-spec.ts` (new, full HTTP-layer coverage); `db/tests/invariants.sql`
  and `db/tests/fixtures.sql` (producer-column CHECKs, immutability, and fixture updates); `health.e2e-spec.ts`,
  `migrations.e2e-spec.ts`, `invoices.e2e-spec.ts`, `runtime-role.e2e-spec.ts`, `platform-currency.e2e-spec.ts`
  (updated for the new column/routes)

No change to Auth, Payment, the service-kit, or any other Core service.

## Edge cases

- A client-supplied `producer`/`amount`/`total`/`currency`/`status` field on any create body → `400` (whitelist
  rejection), never silently dropped or trusted.
- Two producers creating a product with the same `(sellerType, sellerId, code)` and identical content → the second
  gets a `200` replay of the *first* producer's row (the natural key is `(seller, code)` per the SDD's own words,
  not `(producer, seller, code)`); that second producer can then never read or archive the row it "created" (no
  relation). Documented as a known, low-impact asymmetry (production catalog writes by more than the test producer
  are already blocked by B-029/B-031).
- A payment request for a non-`user` payer → `409 payment_request_not_supported` (BI-09/B-026 restriction,
  unchanged from Stage 2).
- A payment request for a non-`open` invoice → `409 invoice_not_payable`.
- Cross-producer product/price/invoice access → collapsed `404`, verified for an unrelated user, another producer,
  and separately for an Auth identity with `adminTier: 'owner'` (a generic Auth capability grants nothing here).
- List pagination: an invalid `limit` (0, or over 100) is `400`, never silently clamped; a cursor that doesn't
  decode to the exact shape `encodeCursor` produces is `400`, never trusted as SQL.

## Data migration

`0010_product_producer.sql` is purely additive (new column, CHECK, index) against a table that has never had a
write endpoint before this stage, so it is empty in every environment — no backfill needed.

## Test plan

Unit (220, 16 files — 2 more than Stage 2's 218: one added to `billing-config.spec.ts` for the new rate-limit
defaults, and the new `openapi.spec.ts`. The two new normalisers, `product-input.ts` and `price-input.ts`, have no
dedicated unit-spec file — they are exercised only indirectly, through `http-api.e2e-spec.ts`). Integration/e2e (130 passed, 1
skipped, 8 files, real PostgreSQL): the full new `http-api.e2e-spec.ts` HTTP-layer suite (authentication,
authorization including the Auth-admin-flag negative case, product/price CRUD and isolation, invoice creation/
idempotency/lifecycle, listing/pagination/filters/isolation, payment-request creation/idempotency/Stage-boundary
honesty), plus the updated Stage 2 suites. Database suite (`npm run test:db`): 188/188 assertions (3 more than
Stage 2's 185, for the new producer column's NOT NULL/shape/immutability) and 5/5 concurrency races.

## Rollout

Deployed via PR #49 (squash-merged to `main`). No feature flag: every new route requires either a valid service
token or an active Auth-verified user bearer, so nothing is reachable without credentials that don't yet exist for
any real (non-test) producer — production use by any non-test producer remains blocked by B-029/B-031 regardless of
this code being live.
