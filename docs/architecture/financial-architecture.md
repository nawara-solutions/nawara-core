# Financial architecture: billing, payment and accounting

- **Status:** Proposed. Decisions E1–E4 were accepted by the project owner on 2026-09-19; the ADRs that record them
  ([0035](../adr/0035-financial-service-boundaries.md), [0036](../adr/0036-money-parties-and-source-references.md),
  [0037](../adr/0037-reliable-events-outbox-inbox.md), [0038](../adr/0038-entitlement-in-billing-service.md)) are *Proposed*.
- **Date:** 2026-09-19
- **Scope:** design only, **as of 2026-09-19**. `billing-service` and `payment-service` are now both implemented
  through Stage 12.7 (Stage 12.8 closure note, 2026-09-22): the "current state" and "data model" sections below
  describe the pre-implementation design and are **stale where they describe entitlement** (§5's
  `organization_license`/`user_subscription`/`product.type` shape was not built — see
  [ADR-0044](../adr/0044-subscription-entitlement-final-model.md) for what was, and
  [`docs/sdd/billing-service.md`](../sdd/billing-service.md) for the current technical contract, which is now the
  living document; this one stays as a historical snapshot of the pre-implementation design decisions).
- **Core V2 update (DOC-4, 2026-10-28):** **§0 below is the current Core V2 financial architecture**, written from the frozen
  [S0 architecture freeze](./core-v2-s0-architecture-freeze.md), the [execution roadmap](./core-v2-s-execution-roadmap.md) and the
  [D-A2 contract register](./core-v2-d-a2-contract-register.md), which stay authoritative for every detail. It removes Nawara cash
  settlement (S0 D1, FC-11; [ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md)) and records explicit settlement
  routing (S0 §6.1). Sections 1 to 12 are kept as the historical 2026-09-19 design; where they describe cash settlement of
  Nawara-sold products they are superseded (marked inline).
- **Related:** [core-architecture.md](./core-architecture.md); this document **replaces the financial parts** of
  `docs/add/payment-service.md` and `docs/sdd/payment-service.md`, which pre-date multi-organization membership
  ([ADR-0030](../adr/0030-multi-organization-membership-and-revoked-state.md)) and the broader requirements below.

## 0. Core V2 financial architecture (DOC-4, current)

This section summarizes; it decides nothing. Every rule cites its source, and the [contract register](./core-v2-d-a2-contract-register.md)
(routes, DTOs, errors, idempotency classes, the Owner's decisions) and the [Billing](../sdd/billing-service.md) and
[Payment](../sdd/payment-service.md) SDDs hold the details. Core V2 is implemented and certified against a **simulation provider only**
(S0 §1.1); nothing below is in production, and production stays blocked by B-001 / B-007 (the legal seller), a real provider and a
separate Owner activation.

**Status legend.** **IMPLEMENTED** — merged, development and simulation only (not mounted or refused in production unless stated).
**FROZEN** — required by S0 or an accepted contract, not implemented yet. **OWNER-APPROVED** — an Owner decision recorded in the register,
not implemented yet. **OPEN** — needs an Owner decision; nothing is assumed.

### 0.1 Services and boundaries

| Service | Owns in Core V2 | Never |
|---|---|---|
| billing-service | what is owed and why: products, prices, invoices, payment requests, settlement routing, the Organization Subscription and the Personal Subscription ledger with their entitlements, fees, assistance requests, cash-return obligations, restrictions, refund cases (S6a) | how money moved |
| payment-service | how money moved: payments, attempts, provider transaction facts, finality, refunds (S6b), disputes (S6e) | what is owed; entitlements |
| auth-service | identity, live membership and administrator facts, Owner step-up, authorization receipts (ADR-0067) | billing or payment authority |
| audit-service | append-only accountability records from verified producers (ADR-0069) | business state |

Payment never calls Billing (C4): Billing learns outcomes only from Payment's verified `payment.*` events (S1) or its own reconciler. No
accounting-service, ledger, wallet or cash-service exists (S0 §1.1: no wallets, seats or manual settlement).

### 0.2 Parties, purposes and immutable routing

- **Payer, beneficiary and seller are separate, typed parties.** The seller of a Nawara-sold product is the Platform's Company (a
  simulation commercial reference until B-001 / B-007 name the legal seller). The payer is a user, or an Organization only for the
  assisted and recovery purposes. The beneficiary of a personal purchase is a user. **IMPLEMENTED** (S3a, S4a, S4e; S0 S-6).
- **Purposes and targets (ADR-0044 B2):** `organization_subscription` → `organization`; `direct_purchase` and `assisted_settlement` →
  `personal`; `recovery_settlement` → `none`; plus `non_entitlement` → `none` for invoices that grant nothing (S3a Option C).
  **IMPLEMENTED** for all but `recovery_settlement`, which is FROZEN (S6f).
- **Routing is fixed when the invoice is created** (`invoice_entitlement`, register BIL-08) and never changes. Payer, purpose, beneficiary,
  amount, currency and seller of a payment are immutable (S-6); Billing and Payment each enforce the Organization-payer rule
  independently. **IMPLEMENTED** (S3a, S4a; DB-15 pairing).
- **Money:** `bigint` minor units with an ISO 4217 currency, one currency per Platform (TND first) (S3d). **IMPLEMENTED**.

### 0.3 Subscriptions and entitlement

- **Organization Subscription:** one row per Organization, activated or extended only by a verified settlement routed `organization`;
  the settlement check fires only on period start or extension (S-4); fixed 24-hour grace (S3e). **IMPLEMENTED** (S3b, S3e).
- **Personal Subscription:** owned by the named user, scoped to user + Platform + product, portable across that Platform's
  Organizations; an append-only purchase ledger (`subscription_purchase`) laid by one fold; no personal grace; at most one reversal per
  purchase, re-laid under K-3 Option D. **IMPLEMENTED** (S3c): the reversal record and its fold exist, but **no flow writes a reversal
  yet** (refund completion and final-lost chargebacks are S6d).
- **Entitlement never depends on authentication** (§7 below), and lifecycle never derives from commercial state (DN-1.5).

### 0.4 Verified settlement, uncertainty and finality

- **Only verified Payment outcomes settle.** Billing consumes `payment.succeeded` only from a verified producer through provenance-checked
  delivery (S1, ADR-0057 §13); a cash declaration, a client claim or a report never settles, pays or activates (ADR-0068, ADR-0035 C1).
  **IMPLEMENTED** (S1, S3b).
- **Uncertainty:** a payment being sent is uncertain; no second checkout while a payment is uncertain (S0 §1.1, S4c), no cash-return obligation
  while an assisted settlement is uncertain (S5b E-6), with no release timeout. **IMPLEMENTED**.
- **Finality (S4c):** `closing` and final states; once final, Payment emits no later success (F-4). A late provider success is therefore
  never a `payment.succeeded` event; it reaches reconciliation instead (S6h). **IMPLEMENTED** (S4c).
- **Provider transaction facts (FC-1):** every distinct provider money movement is an immutable `provider_transaction_fact`
  (`capture` kind today), committed in its own transaction independently of allocation, never refused, edited or deleted. **IMPLEMENTED**
  for captures (S4d), refunds (S6b) and chargebacks linked to their dispute (S6e-D), simulation only.
- **Idempotency:** money commands are class M (90 days, S0 D7) backed by permanent uniqueness keys; other commands class K. **IMPLEMENTED**
  (S4g, S3f, S5).
- **Simulation:** a non-production simulation provider and harness; production refuses them; clients never choose outcomes (FC-10).
  **IMPLEMENTED** (S4f).

### 0.5 No Nawara cash settlement

Nawara-sold products are never settled in cash, manually or on trust (S0 D1, FC-11; ADR-0068 **Proposed**; DB-16 forbids
`settledMethod = 'cash'` with a Company seller). Cash for other sellers is deferred (S0 §5). **IMPLEMENTED** as a database guard (S4b).
The cash workflow of §3 and §5 below (`cash_payment`, cash confirmation) therefore does **not** apply to Nawara-sold products.

### 0.6 Organization assistance ("Pay with School" in S0)

| Step | Rule | Status |
|---|---|---|
| Request and consent (BIL-13) | the beneficiary consents to frozen terms: the price, the Organization's approved fee (≤ the current cap), their total | IMPLEMENTED (S5a) |
| Decline (BIL-14) | the beneficiary or the Organization actor, while pending | IMPLEMENTED (S5a) |
| Cash collection report (BIL-15) | the Organization actor asserts `cashCollectedAt`; `consentAt ≤ cashCollectedAt ≤ reportedAt`; `settleBy = cashCollectedAt + 72h`; overdue is derived, never stored; evidence only, never settlement | IMPLEMENTED (S5a) |
| Electronic settlement (BIL-16) | the Organization pays Nawara the frozen **base** (never the fee) through an invoice of the reserved producer `billing-assistance`, routed `assisted_settlement` to the beneficiary; one open or uncertain channel per request; only Payment's verified success records the beneficiary's purchase (one per request, DB-12) | IMPLEMENTED (S5b) |
| Cash-return obligation (BIL-17) | opened only by Billing's sweep past `settleBy` with no purchase and no open or uncertain channel; the Organization owes the beneficiary the full frozen total (base + fee); a report by the Organization does not discharge it | IMPLEMENTED (S5b) |
| Confirmation, disputes, corrections (BIL-18 to BIL-22) | only the beneficiary confirms (the request is then `returned`); beneficiary disputes without cutoff (open disputes block confirmation); the Organization's response is evidence only; the Owner appends timestamp corrections and closes timestamp disputes with dedicated step-ups; no Owner action discharges an obligation (`resolved_by_owner` reserved) | IMPLEMENTED (S5c) |
| Late assisted settlement | a verified success that can no longer apply is kept as evidence (`assistance_late_settlement`), creates no purchase and changes no obligation (L-1 to L-3) | record IMPLEMENTED (S5b); its reconciliation, the default full refund (L-3) and the L-4 exception are FROZEN (S6g, S6h) |

### 0.7 Financial restrictions

- **T1** (a request past `settleBy`, not settled and not confirmed returned) and **T2** (a cash-return obligation not confirmed by the
  beneficiary) restrict an Organization's **new** assistance requests only, derived from durable rows, never stored, with no
  repeat-violation state (FC-9). **IMPLEMENTED** (S5d, register BIL-13 H, BIL-26 F).
- **T3** (recovery after an assisted purchase lost at final stage) is **FROZEN** (S6f). **D6 inactivity** is **FROZEN, not active** until
  V-4 supplies the authoritative effective lifecycle state (S0 DN-1.4, S-9).
- **Inactive Organizations:** existing obligations stay dischargeable by their authorized actors; new activity needs an effectively active
  Organization. **OWNER-APPROVED** policy (V5-1 to V5-9, register §7.1); runtime deferred until V-4 and OD-R6a.

### 0.8 Refunds, receipts and reversals

| Element | Rule | Status |
|---|---|---|
| Authorization receipts (ADR-0067 **Proposed**; AUTH-01 to AUTH-03) | Owner-only, factor step-up `refund.authorize`, bound to `{operation, audience, companyId, refundCaseId, paymentId, amount, currency, reason, legalOverride}`, 10 minutes, single use, consumed by payment-service | IMPLEMENTED in Auth (S2-Auth); no consumer yet |
| Refund case (BIL-23, BIL-25) | Owner of the seller Company only; a full refund of a verified personal purchase (`direct_purchase`, `assisted_settlement`) or of a verified captured payment that produced no entitlement (eligible late assisted settlements, `non_entitlement`); Organization-subscription refunds excluded; Billing computes the amount; closed reason codes; `legalOverride` grants nothing; states `open`, `cancelled`, `completed`; opening needs no step-up; no new case while a dispute on the payment is open (D3) | IMPLEMENTED (S6a, simulation only; cases only: no attempt, no money moved) |
| Refund attempt (PAY-07, PAY-08, BIL-24) | a durable intent (`consumeRef` = the attempt = the provider key) → receipt consumption at Auth → `authorized`; asynchronous provider dispatch with the stable key; only Auth's definitive answer ends an authorization (no expiry margin, Q8); a pre-attempt refusal is permanent for its id; one potentially effective attempt per payment; verified `refund` facts; mismatches are `discrepancy`; Billing relays from a durable record and mirrors Payment's state; a case is cancellable only while every relay is proven unconsumed | IMPLEMENTED (S6b, simulation only; the Owner's R6B-1 to R6B-10); no `refund.*` event, allocation, completion or reversal (S6c, S6d) |
| Allocation and completion (FC-2, FC-3) | lock order `payment` → `refund_authorization`; bounded counter and deferred sum check; `completedAt` set once; a completed case refuses every new attempt (`409 refund_case_completed`) | IMPLEMENTED (S6c, simulation only; the Owner's R6C-1 to R6C-12): cumulative allocation of verified refund facts, excess kept, contested or foreign-currency facts blocked for S6h, `refund.case_completed` from Payment, Billing completes the case once (event or PAY-08 reconciliation); no reversal (S6d) |
| Reversal (FC-4) | at most one per purchase; causes appended separately; an assisted purchase lost at final stage is never reversed | mechanism IMPLEMENTED (S3c); final-lost-chargeback flow IMPLEMENTED (S6e-D, simulation only: a direct purchase charged back in full, the dispute recorded as its cause; partial chargebacks held for review); refund-completion flow IMPLEMENTED (S6d, simulation only; the Owner's R6D-1 to R6D-6): direct and assisted purchases reversed once by Billing's refund effect worker, causes recorded; chargeback flows FROZEN (S6e) |
| Assisted refund | the base returns to the Organization's card electronically, and the Organization owes the beneficiary the full cash; that obligation arises only from a completed refund (S6c / S6d), never from opening a case | IMPLEMENTED (S6d, simulation only; R6D-2 Option A): a `refund_completion`-origin cash-return obligation for the frozen total (base + fee), a T2 restriction while unresolved, discharged by the existing report / confirmation / dispute paths |
| Scope | full refunds only; partial refunds deferred (S0 D4) | FROZEN |

### 0.9 Disputes, recovery, reconciliation and losses (S6)

**Provider disputes, evidence and decisions: IMPLEMENTED (S6e-D, simulation only; the Owner's R6E-1 to R6E-6, R6E-8, R6E-9).** Payment owns
`payment_dispute` (provider identity, bound to the verified capture, the provider's stated exposure, `open → won | lost` once, every observation
kept; conflicts preserved for S6h); a chargeback moves money only as a verified `chargeback` fact linked to its dispute (FC-1). Exposure (FC-5):
open disputes' stated amounts net of their chargebacks, plus chargebacks taken; an unresolvable exposure is never zero (no new refund case or
attempt; work in flight continues). Owner reads, File-granted evidence references and the contest-or-accept decision behind a
`payment.dispute.decide` receipt. Billing reverses a DIRECT purchase charged back in full once (cause `final_lost_chargeback`; K-3 Option D);
an assisted purchase keeps its entitlement (its verified loss recorded for S6f); a partial chargeback of a direct purchase is held for review
(no frozen threshold). **Fraud holds: IMPLEMENTED (S6e-H, simulation only; the Owner's H-1 to H-7 and C-1)**: evidence-based (File `fraud_evidence` grants), Owner
receipts with dedicated factor-only step-ups, one beneficiary and product only, ended at the earlier of release and 14 days, the denied paid time
compensated exactly after the interrupted run (derived, never a purchase; reversals remove it); holds block no financial command.
**Organization recovery: IMPLEMENTED (S6f, simulation only; the Owner's R6F-1 to R6F-8)**: a verified FULL final lost chargeback of an
assisted purchase (never refunded) opens the Organization's base-only recovery obligation and T3 (a partial chargeback or a refunded payment
is kept for review: no debt, no T3); the Organization's administrator settles the outstanding amount through one `recovery_settlement`
invoice at a time (Payment's narrow `payment.create.recovery_settlement`); only Payment's verified success is a recovery payment, split by
the database into principal and `recovery_surplus` owed to the Organization (never revenue, never offset, no expiry); T3 clears once when
principal reaches the base. A surplus is resolved by the full refund of an entirely surplus payment (refund cases) or by the Owner's
evidenced external repayment confirmed by the Organization. No `billing.recovery` event (EVT-06), no FinancialLoss.
**Late assisted settlement: IMPLEMENTED (L-1 to L-3 and L-5 in S5b and S6a to S6d; L-4 / L-6 in S6g, simulation only; the Owner's R6G-1 to R6G-9)**:
a verified late success is recorded with Payment's original instant and never applied automatically; the default is the full refund of
that payment; the Owner may apply it as the request's single purchase only with a factor-step-up receipt and the beneficiary's attestation
or File evidence that the cash was not returned, never with a purchase, a confirmed or reported return, an open dispute or any refund case;
the open deadline obligation is then superseded (kept as history; one live obligation per request), and the beneficiary's entitlement
starts at the application. **S6h-P (Payment, simulation only; register PAY-12 F, PAY-13 F, EVT-10)**: a verified movement that matches no
attempt is kept as an immutable unmatched fact after a grace window and is associated with a payment or refund authorization only by an
append-only row the Owner authorizes with a consumed Auth receipt (the fact never changes); a late success emits
`payment.late_success.recorded` once (with a Billing read for event loss); reconciliation items and signed per-currency balances
(`netRetained = captured − refundedNet − chargebackNet`, never clamped) come only from verified facts. A refund of one specific capture is
resolved by the Owner (R6H-5): a capture-specific refund case and attempt return, in full, exactly one verified capture (a late capture,
a distinct duplicate, an associated or an unrouted settling capture) under an Owner receipt that names it; uniqueness is per capture fact,
the ordinary per-payment rules are unchanged, and the completion has no commercial effect (register BIL-23 G, PAY-07 H). **Still FROZEN, not implemented**: reconciliation cases and `FinancialLoss` only from evidence
(FC-6) (S6h-B). Payment has no
dispute records before S6e-D; S6a's dispute check (R6A-3) and S6b's now read Payment's authoritative exposure.

### 0.10 Open items that block production

V-4 (effective lifecycle), V-5 activation (with OD-R6a), T3, B-001 / B-007 (the legal seller and invoice content), real providers (their
idempotency, refund and dispute formats), OD-10 to OD-12, Q8, and the Owner's production activation. §10 below keeps the original
business, legal and provider questions; items 1, 4, 5 and 12 are still open.

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
| A8 | One "admin" role confirms cash | Two cases: organization-collected cash and Nawara-collected cash | authority derived from who the **seller** is. **Superseded for Nawara-sold products (§0.5):** no cash settlement at all (S0 D1, ADR-0068) |
| A9 | Gateway flow "out of scope" | Webhooks, idempotency and reconciliation are the core of a payment service | designed in section 6 |
| A10 | Auth calls `GET /payment/licenses/:org/status` at registration and joining | Entitlement moves to billing | **Resolved, Stage 12.1 (`f1901f9`):** removed outright, never repointed — Auth makes no synchronous commercial check at all |

## 2. Boundaries

```
Identity      → auth-service          Organization → organization-service
What is owed  → billing-service       Money moved  → payment-service
Accounting    → accounting-service    Notification → notification-service
Business      → product services (outside Core)
```

| Service | Question | Owns | Does **not** own |
|---|---|---|---|
| **billing-service** | What is owed, why, how much, when due? | product, price, invoice, invoice line, payment request, credit note, due/overdue, recurring billing (via `price.interval`, no separate "recurring definition" entity), **Subscription and its derived Entitlement** (one row per Organization — not the `organization license`/`user subscription` split originally proposed here; see [ADR-0044](../adr/0044-subscription-entitlement-final-model.md)), and (future) invoice presentation: templates, template versions and document metadata ([billing SDD](../sdd/billing-service.md) section 36) | how money moved; accounting; product concepts |
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

- **Nawara sells to an organization** (its commercial access): invoice (seller = Nawara's company, payer = the organization) →
  payment (gateway or cash) → `payment.succeeded` → billing activates the Organization's Subscription (one row, not a
  separate `OrganizationLicense` entity — [ADR-0044](../adr/0044-subscription-entitlement-final-model.md)).
- **Organization sells to a user** (a service): invoice (seller = the organization, payer = the user) → payment → invoice paid.
- **Nawara processes payments for an organization** (**subject to open decisions 4 and 5**: merchant of record and custody of funds): the same payment records, with the organization as beneficiary; the
  organization's payment account and settlement are Stage 6 and **not designed in detail** (section 9).
- **Cash** *(superseded for Nawara-sold products by §0.5: no cash settlement, S0 D1; cash for other sellers deferred)*: `Invoice → payment request → cash submission → review → confirm | reject → payment succeeded`. Cash is a payment *method*, not an
  exception. Who confirms: **explicitly designated seller-side authority**, modeled in payment-service (whether that draws on an Auth capability, an
  owner or an assigned operator is undecided). **These authority rules are a proposed policy, not settled** (open decision 7); the generic controls proposed are that a payer cannot confirm their own cash payment (a CHECK `confirmer <> payer` is enforceable only when the payer is a `user`) and that confirmation cannot happen twice.

## 4. Parties, money and references ([ADR-0036](../adr/0036-money-parties-and-source-references.md))

- **Money** is `bigint` minor units plus an ISO 4217 code with the exponent from a currency table. TND has **three** decimals
  (30 TND = 30000 millimes). No floats. Currency is mandatory; amounts are validated by database CHECKs.
- **Parties:** every financial record names `payer`, `seller` (the merchant / issuer) and, when an organization is involved, the
  `organizationId` context, each as an explicit typed reference (`user`, `organization` or `company`). The two directions
  (customer → organization, organization → Nawara) are therefore unambiguous, never encoded by overloading one column.
- **Source reference:** `sourceType`/`sourceId` are opaque, format-checked strings. No foreign key to any product database.

## 5. Data model (design, pre-implementation — see below for what was actually built)

> **This section describes the pre-implementation design (2026-09-19).** As actually built (Stage 12.2, ADR-0044):
> `product` still has an `entitlementKind` column with these literal values (`none`|`organization_license`|`user_subscription`,
> migration `0002`) — it exists, accepts writes, and is **not dead code that was removed** — but it is **not what
> drives Subscription behaviour**: `linkSubscription` decides whether a settlement is a recurring obligation from
> `invoice_line.interval` (a snapshot of `price.interval`) alone, never from `entitlementKind`. There is no
> `organization_license` table and no `user_subscription` table. Instead, one `subscription` table (`organizationId`
> UNIQUE — one current row per Organization, no per-user dimension), columns `productId`, `priceId`, `status`
> (`pending`|`active`|`grace`|`expired`), `currentPeriodStart`, `currentPeriodEnd`, `graceUntil`,
> `cancelAtPeriodEnd`, `effectiveTerminationAt`, `revision`. See `docs/sdd/billing-service.md` §§15-18 (R-2 in
> particular) for the current, maintained technical contract. The rest of this table (invoice, invoice_line,
> payment_request, outbox) was built close to as designed here.

**billing-service**

| Table | Key columns and rules |
|---|---|
| `product` | id, seller party, active (no `type` enum — corrected above) |
| `price` | product, currency, amount (minor units), interval (`one_time`\|`recurring`, with `intervalUnit`/`intervalCount` when recurring), effective dates |
| `invoice` | id, number (unique per seller), seller, payer, organizationId context, currency, subtotal, tax (**who computes it is open decision 10**), total, status `draft → open → paid \| void \| uncollectible`, dueAt, sourceType/sourceId; CHECK totals equal the sum of lines; `overdue` is **derived** from `dueAt`, not stored |
| `invoice_line` | invoice, description, quantity, unit amount, line total, sourceType/sourceId |
| `payment_request` | invoice, amount, status; asks payment-service to collect and carries an **immutable snapshot** (invoice id, amount, currency, payer, seller) so payment-service **never calls billing back** (no cycle); partial payments allowed by design, policy open |
| `credit_note` | invoice, amount ≤ invoiced amount, reason (not built; B-016) |
| `subscription` | **corrected above** — one row per Organization, not the `organization_license`/`user_subscription` split this row once proposed |
| `outbox`, `inbox` | reliable events ([ADR-0037](../adr/0037-reliable-events-outbox-inbox.md)) |

**payment-service**

| Table | Key columns and rules |
|---|---|
| `payment` | id, the payment-request snapshot (paymentRequestId, sourceType/sourceId, payer, seller, organizationId, amount, currency, expiresAt, description, reference), settledMethod (`gateway` or `cash`, set on success), succeededAttemptId, status `created`, `pending`, then `succeeded`, `failed`, `cancelled` or `expired` (the state machine is defined in the [payment SDD](../sdd/payment-service.md), which is authoritative), natural idempotency key `(producer, paymentRequestId)`; state moves enforced by trigger |
| `payment_attempt` | payment, provider, providerTransactionId (**unique per provider**), state, error class, timestamps; one payment may have several attempts |
| `cash_payment` | *(not used for Nawara-sold products, §0.5; DB-16)* payment, submittedBy, submittedAt, confirmedBy, confirmedAt, rejectedBy, rejectedAt; `submitted → confirmed \| rejected`, final; confirmer ≠ payer when the payer is a user |
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

- **Idempotency:** creating a payment and creating a refund use a **permanent natural key** (`(producer, paymentRequestId)` and `(paymentId, clientReference)`); other mutating operations take an `Idempotency-Key`. The full design is in the [payment SDD](../sdd/payment-service.md), section 6, which refines the header-only wording used earlier.
- **Webhooks:** a provider event is stored raw, its **signature is verified server-side**, its `providerEventId` is unique
  (duplicates are no-ops), processing is retried, and out-of-order delivery is tolerated (state moves are validated, not assumed).
  A payment is **never** marked succeeded on a client's claim; only a verified provider confirmation, a verified webhook, or an
  authorized cash confirmation can do it (*Core V2, §0.5: never a cash confirmation for a Nawara-sold product*).
- **Providers** (Flouci, Konnect, Paymee, Stripe) sit behind one port. No adapter is built until contracts and sandbox
  credentials exist. Provider secrets are never in business tables (`NAME_FILE`/environment, like Auth).
- **Refunds** are separate records bounded by what was paid; each has provider references; accounting receives a reversal
  event. Partial refunds are supported by the model even if not built first. (*Core V2, §0.8: full refunds only, partial refunds deferred,
  S0 D4; Owner receipts per ADR-0067.*)
- **Reconciliation:** provider records compared with payments; discrepancies are surfaced, not auto-corrected. (Deferred.)

## 7. Entitlement is not authentication ([ADR-0038](../adr/0038-entitlement-in-billing-service.md))

Identity, sessions and login (Auth) never depend on billing or payment. If an Organization's Subscription lapses the **user
stays a valid identity**; the consuming application or service asks billing's entitlement-status API
(`GET /billing/organizations/:organizationId/entitlement`, implemented Stage 12.5) at the point of use and denies the
protected capability. Renewal restores it. **Resolved, corrects this section's original framing:** there is no
per-user subscription in the built system (ADR-0044 rejected ADR-0006/0008's per-user reservation model — B-021);
entitlement is Organization-scoped only. Auth's registration/join check — the "one existing synchronous dependency"
this section once called an open decision — was **removed outright** in Stage 12.1 (commit `f1901f9`), not kept and
not repointed to billing.

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
8. ~~**Auth ⇄ billing:** whether registration/join keeps a synchronous entitlement check.~~ **Resolved, Stage 12.1:** no — removed outright (see A10 above, ADR-0044).
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
| `docs/adr/README.md`, `docs/architecture/README.md` | index rows for ADR-0031 to 0038; the architecture folder is indexed by its own README (`docs/README.md` is a shared symlink and is not edited here) |
| SDDs | one each for billing, payment and accounting **before** their Stage 2, 3 and 5 code. Written so far: [payment](../sdd/payment-service.md) and [billing](../sdd/billing-service.md) (draft, for review; its section 5 records how it reconciles with this document: the invoice states and event names are kept as written here, and the product/price split is the one proposed change). Accounting: not written |

## 12. Intentionally deferred

Real gateway adapters; settlement, payout, balance and wallet; automated reconciliation; balance sheet, profit and loss, cash flow
and tax reports; multi-jurisdiction tax; recurring-billing runner and dunning; deploy workflows and server provisioning;
asymmetric token signing.
