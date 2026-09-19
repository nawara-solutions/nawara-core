# Financial architecture: billing, payment and accounting

- **Status:** Proposed. Decisions E1–E4 were accepted by the project owner on 2026-09-19; the ADRs that record them
  ([0035](../adr/0035-financial-service-boundaries.md), [0036](../adr/0036-money-parties-and-source-references.md),
  [0037](../adr/0037-reliable-events-outbox-inbox.md), [0038](../adr/0038-entitlement-in-billing-service.md)) are *Proposed*.
- **Date:** 2026-09-19
- **Scope:** design only. `payment-service` is an unmodified NestJS starter and no financial code, table or route exists.
  Nothing below is implemented.
- **Related:** [core-architecture.md](./core-architecture.md); this document **replaces the financial parts** of
  `docs/add/payment-service.md` and `docs/sdd/payment-service.md`, which pre-date multi-organization membership
  ([ADR-0030](../adr/0030-multi-organization-membership-and-revoked-state.md)) and the broader requirements below.

## 1. Assessment

### 1.1 Current state (inspected)

| Item | State |
|---|---|
| auth-service | Only real service; deployed; owns identity, sessions, MFA and membership. Multi-organization membership is on `main` ([ADR-0030](../adr/0030-multi-organization-membership-and-revoked-state.md)). |
| payment-service | 60-line NestJS starter. Design-only `Product`, `Charge`, `License`, `UserSubscription`. |
| billing-service, accounting-service | do not exist |
| notification-service, ai-service | starter / 8-line `/health` app |
| Events | Auth publishes to RabbitMQ (`nawara.events`) fire-and-forget; RabbitMQ runs only in the local `docker-compose.yml`, not in production; nothing consumes. |
| CI | no workflow runs typecheck or tests; only auth has a Docker build/deploy pipeline |

### 1.2 Assumptions of the old payment design that no longer hold

| # | Old assumption | Why it is invalid | Replacement |
|---|---|---|---|
| A1 | The JWT carries `organizationId` (cash-request authorization, `UserSubscription` stamp) | Tokens carry no organization; a user has many memberships | Organization comes from the request; live membership check through Auth ([ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md)) |
| A2 | `Charge` is both the purchase and the transaction | Conflates *what is owed* with *how it was paid*; no invoice, attempts, partial payments or refund history | `Invoice`/`InvoiceLine` (billing) → `Payment`/`PaymentAttempt`/`Refund` (payment) |
| A3 | `License`/`UserSubscription` live in payment | Payment is "how money moved"; entitlement is "what was bought and is it valid" | billing-service owns entitlements ([ADR-0038](../adr/0038-entitlement-in-billing-service.md)) |
| A4 | The admin's JWT is forwarded to Auth (ADR-0021) | Superseded by ADR-0033 | service token + live Auth check |
| A5 | `payerId` / `organizationId` are ambiguous | Cannot express organization → Nawara versus customer → organization | explicit typed parties ([ADR-0036](../adr/0036-money-parties-and-source-references.md)) |
| A6 | One `status`, `refunded` as a flag | Loses financial history | separate `Refund` records; database-enforced state machines |
| A7 | Events are fire-and-forget | Accounting needs exactly-once *effect* | outbox + inbox ([ADR-0037](../adr/0037-reliable-events-outbox-inbox.md)) |
| A8 | One "admin" role confirms cash | Two cases: organization-collected cash and Nawara-collected cash | authority derived from who the **seller** is |
| A9 | Gateway flow "out of scope" | Webhooks, idempotency and reconciliation are the core of a payment service | designed in section 6 |
| A10 | Auth calls `GET /payment/licenses/:org/status` at registration and joining | Entitlement moves to billing | Auth client repointed in a separate small, additive PR (not in this phase) |

## 2. Boundaries

```
Identity      → auth-service          Organization → organization-service
What is owed  → billing-service       Money moved  → payment-service
Accounting    → accounting-service    Notification → notification-service
Business      → product services (outside Core)
```

| Service | Question | Owns | Does **not** own |
|---|---|---|---|
| **billing-service** | What is owed, why, how much, when due? | product, price, invoice, invoice line, payment request, credit note, due/overdue, recurring definitions, **entitlements** (organization license, user subscription) | how money moved; accounting; product concepts |
| **payment-service** | How was it paid, by which method, and what is the payment state? | payment, payment attempt, payment method, provider transaction, cash payment workflow, refund, webhooks, idempotency, reconciliation; later organization payment account and settlement | what is owed; the ledger; entitlements |
| **accounting-service** | What accounting effect did it have? | chart of accounts, journal, journal entry and lines, ledger, fiscal period, tax, tax rate, tax transaction, reconciliation, reports | payments, invoices as source of truth |

**Not created:** `invoice-service`, `cash-service`, `tax-service`, `ledger-service`, `wallet-service`, `subscription-service`,
`organization-payment-service`, `user-service`, `membership-service`, `role-service`, `permission-service`.

**Hard rules:** no cross-service foreign keys or database access; only opaque `userId`, `organizationId`, `platformId`,
`sourceType`, `sourceId`; none of these services knows a product concept; a payment is **not** the ledger and an invoice is
**not** the ledger.

## 3. The flows

```
product service ("a customer owes 30 TND for X", sourceType/sourceId)
   → billing-service ── invoice.created ──► notification ("you owe 30 TND")
   → customer pays     → payment-service ── payment.succeeded ─┬─► billing (invoice paid; entitlement if any)
                                                               ├─► accounting (journal entry, idempotent)
                                                               └─► notification (receipt)
```

- **Nawara sells to an organization** (license): invoice (seller = Nawara's company, payer = the organization) → payment
  (gateway or cash) → `payment.succeeded` → billing activates the `OrganizationLicense`.
- **Organization sells to a user** (a service): invoice (seller = the organization, payer = the user) → payment → invoice paid.
- **Nawara processes payments for an organization** (**subject to open decisions 4 and 5**: merchant of record and custody of funds): the same payment records, with the organization as beneficiary; the
  organization's payment account and settlement are Stage 6 and **not designed in detail** (section 9).
- **Cash:** `Invoice → cash payment request → review → confirm | reject → payment succeeded`. Cash is a payment *method*, not an
  exception. Who confirms: **explicitly designated seller-side authority**, modeled in payment-service (whether that draws on an Auth capability, an
  owner or an assigned operator is undecided). **These authority rules are a proposed policy, not settled** (open decision 7); the generic controls proposed are that a payer cannot confirm their own cash payment (a CHECK `confirmer <> payer` is enforceable only when the payer is a `user`) and that confirmation cannot happen twice.

## 4. Parties, money and references ([ADR-0036](../adr/0036-money-parties-and-source-references.md))

- **Money** is `bigint` minor units plus an ISO 4217 code with the exponent from a currency table. TND has **three** decimals
  (30 TND = 30000 millimes). No floats. Currency is mandatory; amounts are validated by database CHECKs.
- **Parties:** every financial record names `payer`, `seller` (the merchant / issuer) and, when an organization is involved, the
  `organizationId` context, each as an explicit typed reference (`user`, `organization` or `company`). The two directions
  (customer → organization, organization → Nawara) are therefore unambiguous, never encoded by overloading one column.
- **Source reference:** `sourceType`/`sourceId` are opaque, format-checked strings. No foreign key to any product database.

## 5. Data model (design)

**billing-service**

| Table | Key columns and rules |
|---|---|
| `product` | id, type (`one_time`, `recurring`, `organization_license`, `user_subscription`), name, seller party, active |
| `price` | product, currency, amount (minor units), interval (nullable), effective dates |
| `invoice` | id, number (unique per seller), seller, payer, organizationId context, currency, subtotal, tax (**who computes it is open decision 10**), total, status `draft → open → paid \| void \| uncollectible`, dueAt, sourceType/sourceId; CHECK totals equal the sum of lines; `overdue` is **derived** from `dueAt`, not stored |
| `invoice_line` | invoice, description, quantity, unit amount, line total, sourceType/sourceId |
| `payment_request` | invoice, amount, status; asks payment-service to collect and carries an **immutable snapshot** (invoice id, amount, currency, payer, seller) so payment-service **never calls billing back** (no cycle); partial payments allowed by design, policy open |
| `credit_note` | invoice, amount ≤ invoiced amount, reason |
| `organization_license` | organizationId (unique active), invoice/payment refs (opaque), type `standard \| grace`, status, expiresAt |
| `user_subscription` | userId, organizationId (many per user), status `active \| suspended \| expired`, expiresAt xor frozenRemainingSeconds |
| `outbox`, `inbox` | reliable events ([ADR-0037](../adr/0037-reliable-events-outbox-inbox.md)) |

**payment-service**

| Table | Key columns and rules |
|---|---|
| `payment` | id, invoiceId (opaque), payer, seller, organizationId, currency, amount, method (`gateway`, `cash`), status `pending → processing → succeeded \| failed \| cancelled`, idempotency key unique per (caller, scope); state moves enforced by trigger |
| `payment_attempt` | payment, provider, providerTransactionId (**unique per provider**), state, error class, timestamps; one payment may have several attempts |
| `cash_payment` | payment, submittedBy, submittedAt, confirmedBy, confirmedAt, rejectedBy, rejectedAt; `pending → confirmed \| rejected`, final; CHECK confirmer ≠ payer |
| `refund`, `refund_attempt` | refund amount, provider refund reference; CHECK sum of refunds ≤ paid amount; history is never overwritten |
| `webhook_event` | provider, providerEventId (**unique**), raw body, signature verified, processing state, attempts |
| `idempotency_key` | scope, key, request hash, stored response |
| `outbox`, `inbox` | as above |
| *Stage 6 (deferred)* | `organization_payment_account`, `fee`, `settlement`, `payout`; balances are **derived from entries**, never a mutable counter |

**accounting-service**

| Table | Key columns and rules |
|---|---|
| `account`, `chart_of_accounts` | code, name, type, parent; per organization/company |
| `journal`, `journal_entry` | id, organizationId, sourceType/sourceId, `eventId` (**unique**: one entry per source event), posted time; **append-only** |
| `journal_entry_line` | entry, account, debit, credit (exactly one non-zero); a **deferred constraint trigger** requires debits = credits per currency at commit |
| `fiscal_period` | open/closed; posting into a closed period is rejected |
| `tax`, `tax_rate`, `tax_transaction`, `organization_tax_configuration` | jurisdiction, type, rate, effective dates, exemption; **nothing hardcoded** |
| `inbox` | processed events |

A correction is a **reversing entry**, never an update or delete.

## 6. Payment processing rules

- **Idempotency:** creating a payment or refund requires an `Idempotency-Key`; the same key with the same request returns the
  stored result, with a different request is rejected. Concurrent identical requests produce one row.
- **Webhooks:** a provider event is stored raw, its **signature is verified server-side**, its `providerEventId` is unique
  (duplicates are no-ops), processing is retried, and out-of-order delivery is tolerated (state moves are validated, not assumed).
  A payment is **never** marked succeeded on a client's claim; only a verified provider confirmation, a verified webhook, or an
  authorized cash confirmation can do it.
- **Providers** (Flouci, Konnect, Paymee, Stripe) sit behind one port. No adapter is built until contracts and sandbox
  credentials exist. Provider secrets are never in business tables (`NAME_FILE`/environment, like Auth).
- **Refunds** are separate records bounded by what was paid; each has provider references; accounting receives a reversal
  event. Partial refunds are supported by the model even if not built first.
- **Reconciliation:** provider records compared with payments; discrepancies are surfaced, not auto-corrected. (Deferred.)

## 7. Entitlement is not authentication ([ADR-0038](../adr/0038-entitlement-in-billing-service.md))

Identity, sessions and login (Auth) never depend on billing or payment. If a license or subscription lapses the **user stays a
valid identity**; the consuming application or service asks billing's entitlement-status API at the point of use and denies the
protected capability. Renewal restores it. A user may hold subscriptions under several organizations. The reservation and grace
rules of ADR-0006 and ADR-0008 are re-expressed on billing events in Stage 4. (Auth's registration/join check is the one
existing synchronous dependency; whether it stays is an open decision.)

## 8. Security and multi-organization authority

- **Service-to-service:** per-pair service tokens ([ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md)).
- **Never trusted from a client:** `userId`, `organizationId`, `platformId`, `amount`, `currency`, `role`, `permissions`,
  beneficiary. Amounts and currency come from the server-side payment-request snapshot, never from the client.
- **Organization-scoped operation:** request names the organization → the service asks Auth for the caller's **active**
  membership and authority for that organization (or platform access for an owner/operator) → operation. A user in organizations
  A and B cannot bill or pay for C; organization A cannot read organization B's records (collapsed 404); platform and company
  isolation as in Auth.
- **Who may do what is decided by the service that owns the operation.** Auth supplies identity, **active** membership of the
  organization, the generic user kind and security context; it is not the business-permission engine. Billing decides who may
  create or void an invoice; payment-service decides who may submit or confirm cash, and who may refund. A generic Auth
  capability (for example an organization-admin flag) may be an *input*, but it is **not automatically authority**: cash
  confirmation authority must be **explicitly modeled and enforced** in payment-service, and its policy is an open decision
  (item 7 below). What follows is the proposed shape, not settled policy.
- **Authority table (proposed; every "authorized" is an explicit payment- or billing-domain decision):**

| Operation | Proposed rule |
|---|---|
| create invoice for organization X | authorized by billing-service for the seller (who counts is open), or a trusted product service token |
| view an invoice | its payer, or someone authorized for the seller |
| pay | the payer, only for the payment-request amount |
| submit cash payment | payer or seller-side, **open** (item 7) |
| confirm / reject cash | **explicitly designated** seller-side authority only, never the payer (designation model open) |
| refund | explicitly authorized seller-side authority; step-up policy open |

- **Audit:** every financial state change records actor and time; central audit receives events asynchronously.
- **Errors are sanitized;** rate limits and request-size limits apply as in the service-kit.

## 9. Stages

1. Foundations for billing, payment, accounting on the service-kit (config, health/ready, logging, request ids, errors, OpenAPI,
   Docker, database, migrations, tests, CI, service tokens, outbox/inbox). 2. Billing. 3. Payment (test provider only).
4. Entitlement in billing. 5. Accounting. 6. **Settlement, only after the business, legal and provider decisions below.**

## 10. Unresolved business, legal and provider decisions (nothing invented)

1. **Legal issuer of Nawara invoices:** which legal entity, tax identity, invoice numbering and legal invoice content.
2. **Tax:** applicable regime, rates, exemptions, invoice and reporting obligations; whether they differ per organization.
3. **Organizations issuing invoices through Nawara:** whether that is legally valid, and whose tax identity appears.
4. **Providers:** contracts, fees, refund and dispute rules for Flouci, Konnect, Paymee and Stripe; whether Nawara is merchant of record.
5. **Settlement and payouts:** legality, custody of funds, float, timing, minimums, currencies.
6. **Chart of accounts template and fiscal year;** currencies beyond TND.
7. **Policies:** partial payments, dunning and overdue handling, who may submit cash, refund step-up, grace-period rules on the new model.
8. **Auth ⇄ billing:** whether registration/join keeps a synchronous entitlement check.
9. **Trusted product service tokens:** which product services may create invoices for which organizations.
10. **Tax computation on an invoice:** billing stores tax lines but tax rates, periods and tax transactions belong to accounting; who computes the tax (billing from its own configured rate, or a call/replicated configuration from accounting) is undecided.
11. **Trials:** the old design started a trial subscription on Auth's `user.registered` event; Auth no longer holds trial state (ADR-0026). Whether billing offers trials, and how they start, is undecided.
12. **Seller for Nawara's own sales:** `company` is proposed, but whether Nawara is represented by a Company row (the platform-owning company) or another party type is undecided.

## 11. Back-pointers and follow-up documents (back-pointers added in the same change; SDDs still to write)

| Document | Change |
|---|---|
| ADR-0004 | amended by ADR-0038 (status route moves to billing; Auth's client repointed) |
| ADR-0006, ADR-0008 | location moves to billing (ADR-0038); rules kept |
| ADR-0007 | actor model changes to seller authority (ADR-0035, ADR-0036) |
| ADR-0018 | ADR-0037 builds on it: headers, outbox, inbox; its deployment stays deferred |
| ADR-0021 | superseded in part by ADR-0033 |
| ADR-0026 | ownership statement amended by ADR-0038 |
| `docs/add/payment-service.md`, `docs/sdd/payment-service.md` | financial parts superseded by this document |
| `docs/adr/README.md`, `docs/README.md` | index rows for ADR-0031 to 0038; register `docs/architecture/` |
| SDDs | one each for billing, payment and accounting **before** their Stage 2, 3 and 5 code |

## 12. Intentionally deferred

Real gateway adapters; settlement, payout, balance and wallet; automated reconciliation; balance sheet, profit and loss, cash flow
and tax reports; multi-jurisdiction tax; recurring-billing runner and dunning; deploy workflows and server provisioning;
asymmetric token signing.
