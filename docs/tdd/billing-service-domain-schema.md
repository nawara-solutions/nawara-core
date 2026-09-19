# billing-service: Stage 2 domain schema, financial invariants and state-transition foundation

- **Status:** Implemented
- **Author:** Claude (Billing Stage 2 session), for the project owner
- **Related SDD:** [billing-service.md](../sdd/billing-service.md) (sections 8 BI-01..BI-21, 9, 10, 13, 17, 21.4, 25, 28, 34.1 Stage 2, 36)
- **Related ADRs:** [0032](../adr/0032-database-per-service-on-a-shared-server.md), [0036](../adr/0036-money-parties-and-source-references.md), [0037](../adr/0037-reliable-events-outbox-inbox.md)
- **Ticket/issue:** Billing Stage 2 (schema, invariants and transition foundation only; no HTTP API)

## Problem

Stage 1 gave Billing a foundation with no domain. Stage 2 gives it the database and the pure rules that make a wrong financial state
impossible to store, before any endpoint can be written. It decides no `[B]` question: every rule that depends on an open decision is
a labelled **TEMPORARY RESTRICTION** in the migration.

## Approach

**The database is the authority; TypeScript mirrors it and is tested against it.** Each invariant is enforced where it cannot be
bypassed, and the mapping is in the table below. Guards are trigger-based and immutable by default: `billing_immutable_except(...)`
allows only a named list of lifecycle columns to change, so a column added later is immutable until it is deliberately listed.

Design decisions worth knowing:

- **Currency (BI-21):** `currency(code, exponent)` is seeded by migration and immutable and undeletable. Every money-bearing row
  references it, and lines and payment requests reference the invoice through a composite `(id, currency)` foreign key, so a line
  can never carry another currency. Which currencies are *supported* is configuration (`BILLING_SUPPORTED_CURRENCIES`, no default, B-005).
- **Totals (BI-05):** computed only by `computeTotals`; a deferred constraint trigger re-checks `sum(lines) = subtotal`, tax and
  total at commit, so an invoice cannot commit with inconsistent lines. Sums are done in `numeric` so the check cannot itself overflow.
- **Numbering (BI-10):** assigned only by the `draft -> open` trigger from a per-seller counter row; the lock order is invoice, then
  counter, so concurrent issues serialize without deadlock and a rollback returns the number. Gaplessness is not assumed.
- **History (BI-19):** `billing_transition` is append-only. A status change with no matching history row cannot commit (deferred
  constraint trigger), so history cannot be skipped by any writer. `revision` and `updatedAt` are overwritten by trigger.
- **Payment events (SDD 21.4):** `decidePaymentEvent` is pure and evaluated under the invoice lock; `payment_event_receipt` is the
  durable twin of the inbox. An unknown request is ignored; a request with no `paymentId` **defers** and nothing is bound from the
  event; a snapshot, amount or source mismatch is a recorded `conflict`. No consumer exists yet (Stage 4).
- **Persistence layer:** `InvoiceRepository` and `PaymentRequestRepository` are the only writers. They compute nothing the database
  does not re-check, and map refusals to the SDD's stable error codes.
- **Lock order:** `invoice -> payment_request -> sequence row`. The dispatcher's transitions never lock the invoice.

## Invariant map (BI-01 .. BI-21)

| BI | Enforcement (database first) | Tests |
|---|---|---|
| 01 integer minor units, capped 2^53-1 | `bigint` columns, `*_amounts_safe` CHECKs; `money.ts` refuses floats and out-of-range | `invariants.sql`, `money.spec.ts`, `no-floating-point.spec.ts` |
| 02 amounts valid per field | `*_positive` / `*_nonnegative` CHECKs on every column | `invariants.sql`, `totals.spec.ts` |
| 03 invoice currency never changes | `invoice_10_immutable` allow-list (currency is not on it) | `invariants.sql`, runtime-role suite |
| 04 line currency = invoice currency | composite FK `(invoiceId, currency)`; the same FK on `payment_request` | `invariants.sql` |
| 05 totals derivable from lines | CHECKs plus a deferred totals trigger summing `numeric` at commit; 1..100 lines | `invariants.sql`, `totals.spec.ts`, `invoices.e2e-spec.ts` |
| 06 a historical invoice never changes with the catalog | immutable price and product, lines copy what was sold | `invariants.sql`, `invoices.e2e-spec.ts` |
| 07 totals cannot become inconsistent after creation | no line insert into a non-draft invoice, lines immutable and undeletable, allow-list on `invoice` | `invariants.sql`, runtime-role suite |
| 08 amount due never negative | a request is for exactly the total and only one may be `paid`, so no sum can exceed the total (credit notes are blocked, B-016) | `invariants.sql` |
| 09 allocation within the approved model (B-010) | insert guard `amount = total`, `payment_request_one_paid` partial unique index | `invariants.sql`, races, `invoices.e2e-spec.ts` |
| 10 unique, once-assigned number (scope B-004) | counter trigger at `draft -> open`, unique index, counter row cannot be rewound | `invariants.sql`, race, `invoices.e2e-spec.ts` |
| 11 supported currency | `currency` FK and the configured list (`422 unsupported_currency`) | `invariants.sql`, `invoices.e2e-spec.ts`, `billing-config.spec.ts` |
| 12 event atomic with the transition | same transaction, deterministic event id, `ON CONFLICT DO NOTHING` | `invoices.e2e-spec.ts` (failure injection), runtime-role suite |
| 13 one active payment request | `payment_request_one_active` partial unique index | `invariants.sql`, race, `invoices.e2e-spec.ts` |
| 14 paid only through a paid request for the full total | lifecycle triggers on both tables, `paidAt` iff paid | `invariants.sql`, `invoices.e2e-spec.ts` |
| 15 request mapping never changes | `forbid_column_change` on the mapped fields | `invariants.sql`, `payment-request-mapping.spec.ts` |
| 16 exact transitions, no reopen | lifecycle triggers, `open -> void` absent until B-015 | `state-machine-agreement.e2e-spec.ts` (every pair), `invariants.sql` |
| 17 credit notes within the total | **not applicable in Stage 2**: credit notes are blocked (B-016) and no table exists | exact-table-set test |
| 18 Payment-compatible parties and limits | CHECKs copied from Payment's contract | `invariants.sql`, `payment-request-mapping.spec.ts`, `invoice-input.spec.ts` |
| 19 revision, `updatedAt` and a history row per change | revision trigger, deferred history trigger | `invariants.sql`, `invoices.e2e-spec.ts` |
| 20 snapshots are historical truth | allow-list, shape CHECKs, `presentation` set once at issue | `invariants.sql`, `snapshots.spec.ts` |
| 21 currency reference immutable | immutability trigger on `currency`, FK protects referenced rows | `invariants.sql`, runtime-role suite |

Not a numbered invariant but tested throughout: **ownership and isolation.** A caller's relation is derived from the invoice itself
(the producer service, or a user who is the payer); anything else is a `404`. There is no user, organization or membership table in
Billing, and an Auth administrator has no Billing relation (`relations.spec.ts`, `invoices.e2e-spec.ts`).

## Currency: three layers (Stage 2 amendment)

| Layer | Where | Owner | Rule |
|---|---|---|---|
| Global currency reference | `currency` (code, exponent) | Core reference data. **The exact owner is not established (B-036 g)**; Billing holds the table today, and no other service does | immutable, undeletable, never edited through Platform configuration; the only place an exponent lives (a test scans the source for any hard-coded code, exponent or decimal count) |
| Platform-supported currencies | `platform_currency (platformId, currency, enabled, revision, createdAt, updatedAt)` | Platform-level configuration; `platformId` is an **opaque** reference (no Platform table and no cross-service FK in Billing) | may only name an existing global currency (FK); the platform and currency of a row never change; disabling is a flag, rows are never deleted; no column can carry an exponent |
| Historical invoice currency | `invoice.currency`, `invoice_line.currency` | Billing financial truth | immutable (BI-03); no foreign key from any financial table to `platform_currency`, so configuration cannot reach a historical record |

`billing_currency_permitted(platformId, currency)` (and `PlatformCurrencyRepository.isPermitted/assertPermitted`) answers "may this Platform
use this currency for NEW work": the currency exists globally **and** the Platform enabled it; no configuration means no. Enable, disable and
list are repository primitives for a future administrative API; **no HTTP API, no authorization and no UI exists**, and nothing in invoice creation calls the
check yet. This keeps the deployment list `BILLING_SUPPORTED_CURRENCIES` (SDD 7) unchanged: today a currency must exist globally and be in that list.

A later **Organization-level restriction** needs no change here: it would be its own table referencing `(platformId, currency)`.

**Deliberately not built, open as B-036:** how an invoice determines its Platform (so invoice creation cannot yet enforce the Platform
set), who may administer it, a Platform default currency, an Organization restriction, how the Platform set combines with the deployment
list and with Payment's enabled currencies, whether an existing invoice in a disabled currency may still be issued or collected, the
owner of the global reference and its seed (only TND is seeded; EUR and USD exponents wait for B-005), and whether changes are audited (the row keeps
only `revision` and `updatedAt`; there is no history table).

## Files/components affected

`apps/billing-service/db/migrations/0001..0009`, `db/tests/**`, `src/domain/**`, `src/invoices/**`, `src/currencies/**`, `src/app.module.ts`
(`InvoicesModule`), `src/config/billing-config.ts` (`supportedCurrencies`), tests, `README.md`, `package.json` (`test:db`),
`.github/workflows/core-ci.yml` (`database-tests: true` for billing), `docs/tdd/README.md`. No change to Auth, Payment or the service-kit.

## Notes for the SDD owner (additive details; none changes the architecture)

1. `invoice.requestHash` is stored so an identical replay is a database fact and a changed replay a conflict, without re-deriving
   from prices that may have changed since. The SDD names the natural key but not this column.
2. The SDD's issue endpoint takes no body, yet the presentation snapshot needs a template and locale. The repository takes them as a
   parameter; Stage 3 must decide where they come from (service default or an optional body). Nothing is invented here.
3. `invoice_line` snapshots the price interval as `interval`, `intervalUnit`, `intervalCount`.
4. Numbering is a decimal counter per `(sellerType, sellerId)` (a TEMPORARY RESTRICTION until B-004). No format, series, reset,
   time zone or issue-date rule exists.
5. The contract test against Payment's real DTO is deferred to Stage 4; the limits are mirrored, not imported.

## Edge cases

- A CHECK that evaluates to NULL passes in PostgreSQL, so every arm names its NULLs (`IS NOT NULL`, `?`); regression tests cover each.
- Row-level guards cannot fire on an empty table; the runtime-role test seeds a row before asserting a guard refuses a change.
- `set_config(..., true)` reverts on a subtransaction rollback, so no guard relies on transaction-local settings.

## Data migration

New database, no data to migrate. Nine forward-only migrations after the kit's.

## Test plan

Unit (218): money, totals, state machines, canonical hash, snapshots, relations, input normalisation, payment mapping, event decision,
no-float scan. Integration (99, real PostgreSQL): repositories, idempotency (identical, changed, concurrent), issue and numbering
races, atomicity with the outbox, ownership and isolation, payment request and event handling races, TS-versus-trigger agreement on every
pair, runtime role, Platform currency configuration (enable, disable, re-enable, unknown currency, historical invoices unchanged). Database suite (`npm run test:db`): 185 assertions and 5 concurrency races.

## Rollout

Not deployed. The migrations are applied by the explicit `npm run migrate` step as `billing_migrator`.
