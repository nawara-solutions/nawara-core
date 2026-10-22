# 0035. Financial service boundaries: billing, payment and accounting

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Supersedes** the financial model of `docs/add/payment-service.md` and `docs/sdd/payment-service.md` (`Product`, `Charge`,
> `License`, `UserSubscription` inside one payment-service), **amends the ownership statement of [ADR-0026](./0026-authentication-is-not-entitlement.md)** (payment-service as owner of licenses and subscriptions) and narrows [ADR-0006](./0006-per-user-subscription-reservation-on-license-lapse.md),
> [ADR-0007](./0007-out-of-band-cash-payment-confirmation.md) and [ADR-0008](./0008-automatic-grace-license-on-license-lapse.md),
> whose *rules* survive but whose *location* and *actor model* change (see ADR-0038 and ADR-0036). Back-pointers to be added
> (added; the full list is in section 11 of [financial-architecture.md](../architecture/financial-architecture.md)).

## Context

`payment-service` is only a starter; its design conflated *what is owed*, *how it was paid* and *what the customer may use*
in one `Charge`, assumed a single-organization JWT, and had no invoice, attempts, refunds with history, webhooks, idempotency
or accounting. The requirements now include Nawara billing organizations and users, organizations billing their own customers,
cash and gateway payments, refunds, tax and a double-entry ledger, without coupling Core to any product concept.

## Options considered

1. **Three bounded contexts: billing (what is owed), payment (how money moved), accounting (financial effect).** Chosen.
2. *One payment-service for everything.* Rejected: it becomes an accounting and invoicing monolith, and every change risks money movement.
3. *More services (invoice, cash, tax, ledger, wallet, subscription, organization-payment).* Rejected: each would split one
   bounded context and multiply cross-service consistency problems without a business need.

## Decision

- **billing-service** owns product, price, invoice, invoice line, payment request, credit note, due and overdue state,
  recurring definitions and (ADR-0038) entitlements. It never moves money and never posts to a ledger.
- **payment-service** owns payment, payment attempt, payment method, provider transaction, cash workflow, refund, webhooks,
  idempotency and reconciliation. It is **not** an accounting system and not the ledger.
- **accounting-service** owns chart of accounts, journal, entries and lines, ledger, fiscal periods, tax and reports. It is the
  only source for accounting reports; payments and invoices are never used as the ledger.
- Communication is by API and events (ADR-0037) with opaque identifiers; no cross-service foreign key or database access.
- **No billing/payment cycle:** billing asks payment to collect through a payment request that carries an immutable snapshot
  (invoice id, amount, currency, payer, seller); payment never calls billing back and reports only through events.
- **Tax:** billing stores tax on an invoice; rates, periods and tax transactions belong to accounting. Who computes the tax on an
  invoice is an open decision (financial-architecture.md, item 10).
- The services **not** to create are listed in the financial architecture document; a later review may justify a split.

### Clarifications (Core V2 S0, 2026-10-21)

The architecture owner approved these clarifications at the Core V2 S0 freeze
([S0 record](../architecture/core-v2-s0-architecture-freeze.md)). They clarify, and do not change, the boundaries above; this ADR's
status stays `Proposed`.

- **C1. Cash obligations.** payment-service's *cash workflow* covers cash received by an invoice's seller as a payment method. Cash
  collected by a school from a student under Pay with School is a commercial obligation between school and student; billing-service
  owns its records (collection time, report time, deadline, corrections, disputes, return obligation, violations). Those records
  never create, settle or modify a payment. For Nawara-sold products no cash settlement path exists
  ([ADR-0068](./0068-no-cash-settlement-for-nawara-sold-products.md)).
- **C2. Provider transactions.** payment-service records every provider-reported money movement as an immutable provider transaction
  fact, committed independently of any commercial processing. Commercial meaning (allocation to an approved refund, excess,
  reconciliation) is layered on top by append-only records and never alters the fact.
- **C3. FinancialLoss is not a ledger.** billing-service's `FinancialLoss` is an operational record of money Nawara did not retain or
  recover, evidenced by recorded provider facts or an owner write-off ([ADR-0044](./0044-subscription-entitlement-final-model.md)
  B11). It drives reconciliation. It is not a journal entry; a future accounting service would derive entries from events. "Payments
  and invoices are never used as the ledger" stands.
- **C4. No back-calls.** "Payment never calls billing back" stands. payment-service's only new call to auth-service is the consumption of
  refund authorization receipts (its existing live verification of users through Auth, ADR-0033, is unchanged) ([ADR-0067](./0067-auth-authorization-receipts-for-owner-approved-refunds.md)).

## Consequences

- Each service can be reasoned about, tested and secured on its own; accounting failures cannot block payments.
- More moving parts and eventual consistency between three databases; reliable events are mandatory (ADR-0037).
- The old payment ADD/SDD must be marked superseded in their financial parts; payment-service is rebuilt on the new model
  (it has no code to migrate).
