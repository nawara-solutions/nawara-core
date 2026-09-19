# billing-service

- **Status:** Draft, **for review**. Nothing here is implemented: there is no `apps/billing-service` (the local PostgreSQL only provisions the `billing` database and its two roles).
- **Owners:** Anwar (project owner)
- **Related ADD:** [core-architecture.md](../architecture/core-architecture.md), [financial-architecture.md](../architecture/financial-architecture.md) (root architecture documents)
- **Related SDD:** [payment-service.md](./payment-service.md) (Billing's only outbound API dependency and its main event source; **not redesigned here**)
- **Related ADRs:** [0018](../adr/0018-rabbitmq-as-async-message-broker.md) (broker),
  [0026](../adr/0026-authentication-is-not-entitlement.md) (authentication is not entitlement),
  [0030](../adr/0030-multi-organization-membership-and-revoked-state.md) (memberships; no organization in tokens),
  [0032](../adr/0032-database-per-service-on-a-shared-server.md) (database per service),
  [0033](../adr/0033-service-to-service-authentication-and-user-identity.md) (service tokens, identity asked of Auth),
  [0034](../adr/0034-shared-service-kit-and-api-conventions.md) (service-kit and API conventions),
  [0035](../adr/0035-financial-service-boundaries.md) (billing, payment, accounting),
  [0036](../adr/0036-money-parties-and-source-references.md) (money, parties, source references),
  [0037](../adr/0037-reliable-events-outbox-inbox.md) (outbox and inbox),
  [0038](../adr/0038-entitlement-in-billing-service.md) (entitlement lives in billing).
  ADR-0004, 0006 and 0008 are **amended in location** by ADR-0038; whether their *rules* carry over is a decision (B-020, B-021, section 5, R-8).

This document is the design contract for the Billing implementation phase. It defines what can be defined and marks what cannot be decided from the repository. It reuses the structure, markers and guardrail of the [payment SDD](./payment-service.md) so both services are implemented and reviewed the same way.

## 0. How to read this document

Every design point carries one marker:

| Marker | Meaning |
|---|---|
| **[D]** | **Decided**: fixed by a decision of the project owner (D1 to D4 and E1 to E4, accepted 2026-09-19) or by the ADR that records it. ADRs 0031 to 0038 are still marked *Proposed*, so "decided" here rests on the owner's acceptance. Do not change without a new decision. |
| **[T]** | **Technically defined here**: a design detail derived from decided principles. It carries no business meaning and can be revised in this SDD. |
| **[B]** | **Business or legal decision required**: not decided, not invented. The document states what depends on it. |
| **[X]** | **Deferred**: consciously not part of this phase. |

### 0.1 Business-decision guardrail

The markers are an implementation contract, not a reading aid, for whoever builds this service, human or agent:

* **[D]** Implementation may proceed. **[T]** Implementation may proceed, subject to any `[B]` gate it references.
* **[B]** is **not approved for implementation.** A `[B]` item may state a proposed behaviour, a default, an example or a recommendation; **none of these is approval**, and each is labelled **PROPOSED — NOT APPROVED**. An implementation agent must not select a `[B]` option, nor infer approval from existing code, tests, fixtures, API examples, comments, common SaaS practice, convenience or the absence of a decision. If a requested feature depends on an unresolved `[B]` decision, that part is **blocked**; only the independent part proceeds.
* **[X]** Do not implement unless a later, explicit decision activates it.
* **Temporary technical restriction.** A `[B]` decision may be *deferred* by restricting the schema to the **smaller, safe behaviour that makes no business choice**, exactly as the payment SDD does for "one payment per payment request" (its section 3.3: "a temporary technical restriction, not a policy"). Such a restriction is allowed, is labelled **TEMPORARY RESTRICTION**, names its `B-` decision, and is relaxed by a migration when that decision is recorded. It never selects a business option. Every database rule below that is tied to a `[B]` decision is of this kind (BI-05, BI-09, BI-10 scope, BI-14, the `taxTreatment` CHECK), and passing a value through unchanged (`dueAt`, `expiresAt` null) is *not deciding*, not a chosen default.

### 0.2 Implementation gate

No implementation agent may turn an unresolved `[B]` decision into an authorization rule, financial rule, API behaviour, database constraint, workflow, event contract or user-facing behaviour. When work reaches a `[B]` boundary the agent must (1) identify the decision by its `B-` number (section 32), (2) identify exactly which part of the work depends on it, (3) implement only the independent part, (4) leave the dependent part blocked or explicitly isolated, and (5) report which decision is required. Section 34.3 applies this gate per feature.

## 1. Purpose

**billing-service answers: what is owed, why, how much, in which currency, by whom, to whom, when is it due, and what billing-derived entitlement state follows?** [D, ADR-0035, ADR-0038]

It is the authoritative source of the *obligation*. It never moves money, never posts to a ledger, never decides how a payment happens, never authenticates anyone and never knows what a product means.

## 2. Scope

**In scope for this SDD (design):** the billing domain model; the money model and its invariants; the invoice state machine; the payment-request handoff to payment-service; consumption of payment events; billing-derived entitlement (shape only, rules `[B]`); credit notes (shape only, rules `[B]`); the API, authorization, events, idempotency, concurrency, failure model, database design, security, tests, decision register and the staged plan.

**In scope for the first implementation** (sections 34.1 and 34.3): Stages 1 to 6, with the test producer fixture, for the parts not touched by a `[B]` decision.

## 3. Non-goals

Billing must never become, and this document does not design: the payment service, the ledger or journal, a tax engine, a wallet or custody model, an ERP, an authentication or membership store, a permission service, or any product's domain. Not created: `invoice-service`, `subscription-service`, `tax-service`, `permission-service`, `user-service`, `organization-service` (all listed in [financial-architecture.md](../architecture/financial-architecture.md) section 2). Also out of scope: real payment gateways, settlement, payouts, fees, merchant-of-record behaviour, cash workflow, refunds (Payment), the Organization Service and the Company → Platform → Organization ownership migration (ADR-0031: a separate future decision), and any product-specific logic or role.

## 4. Architecture

```
 product service ──"customer C owes X for sourceType/sourceId"──► billing-service            (service token)
                                                                       │  Invoice (+ immutable lines)
                                                                       │  PaymentRequest  ── POST /payment/payments ──► payment-service   (service token,
 payer (user bearer) ─ asks live ─► auth-service                       │                                                  billing-service as producer)
        │  POST /billing/invoices/{id}/payment-requests                │
        │  then pays at payment-service (POST /payment/payments/{id}/attempts, user bearer)
                                                                       ▼
   payment-service ── payment.succeeded / failed / cancelled / expired ──► billing (inbox) ──► invoice paid / request closed
   billing ── invoice.created / paid / voided / overdue ── outbox ──► RabbitMQ (nawara.events) ──► accounting, notification, audit
   platform services ── GET /billing/licenses/... (service token) ──► entitlement status                       (Stage 8)
```

| Concern | Owner |
|---|---|
| What is owed, why, how much, in which currency, by whom, to whom, when due; billing-derived entitlement | **billing-service** |
| How it was paid, method, attempts, provider, payment state, refunds | payment-service |
| Accounting effect, ledger, tax, fiscal periods, reports | accounting-service |
| Identity, sessions, membership, is-the-identity-active | auth-service |
| Company / Platform / Organization hierarchy | auth-service today; organization-service later (ADR-0031) |
| What a product *means*, what an entitled user may *do* in it | the product service (outside Core) |
| Delivery of notifications | notification-service |

* Billing **calls** payment-service (create a payment request, and cancel one) and **consumes** its events. Payment **never** calls Billing [D, ADR-0035]. Payment reaches Billing only through events.
* Billing **never verifies a user token itself** and never forwards one: a user's bearer goes to Auth only; Billing to Payment uses Billing's own service token [D, ADR-0033].
* Nothing in Billing reads another service's database or holds a foreign key into one [D]. Payer, seller, organization, user and payment ids are **opaque values**.
* Every financial state change writes its event to the outbox **in the same transaction** [D, ADR-0037].

### 4.1 Key components [T]

| Component | Responsibility |
|---|---|
| Controllers (`Products`, `Prices`, `Invoices`, `PaymentRequests`, `Entitlements`) | HTTP only: DTO validation (unknown fields rejected), the guard, one service call, the error model. **No business rules** |
| `InvoiceStateMachine` | the pure transition tables of section 17, used by the services **and** by the trigger-agreement test |
| `InvoiceService` | create (natural-key idempotency, totals computed from prices), issue (counter lock), discard, read, list; **the only writer of `invoice`**; owns the transition function that writes `billing_transition` and the outbox event in one transaction |
| `CatalogService` | products and prices; enforces price availability at read time for new invoices |
| `PaymentRequestService` | create (state-idempotent), cancel, and the single **consumption procedure** (21.4) used by the event consumer and the reconciler |
| `PaymentDispatcher` | claims `created`/stale `sending` requests, calls Payment outside any transaction, records the result |
| `PaymentReconciler` | settles stranded `requested` requests from `GET /payment/payments/{id}` |
| `PaymentEventConsumer` | subscribes to the four `payment.*` events; runs the consumption procedure through `InboxService.handle` |
| `PaymentClient` (port) | Billing to Payment over the service token; a test double and the real HTTP adapter; classifies answers (21.2) |
| `AuthorizationService` | **the only place** that establishes a caller's relation to a resource and applies the operation rules of 19; returns the collapsed `404` |
| `BillingEvents` | builds the event payloads of section 23 with deterministic ids and enqueues them through the kit's `OutboxService` |
| `OverdueSweeper` | emits `invoice.overdue` once per overdue invoice |
| Repositories | parameterized SQL only; a `withInvoiceLock(invoiceId, fn)` helper applies the fixed lock order of section 26 |

### 4.2 Important flows [T]

**Create and issue.** (1) The producer sends the request with its service token. (2) The guard identifies it; validation rejects unknown fields. (3) One transaction: resolve every price server-side, compute totals, insert the invoice and lines (`draft`); a replay returns the existing one. (4) The producer issues: one transaction locks the invoice, then the seller's counter, assigns the number, moves `draft → open` and enqueues `invoice.created`.

**Pay.** (1) The `user` payer asks for a payment request (Auth is asked live; relation is `payer`). (2) One transaction inserts the request (`created`) under the invoice lock and answers. (3) The dispatcher claims it, calls Payment with the mapped body, and records `requested` with `paymentId`. (4) The payer starts an attempt **at Payment** with their own bearer and pays. (5) Payment emits `payment.succeeded`; the consumer runs the procedure of 21.4 and, in one transaction, marks the request and the invoice `paid` and enqueues `invoice.paid`. (6) If the event is lost or dead-lettered, the reconciler reaches the same result from Payment's status.

**Failure of collection.** `payment.failed`, `payment.expired` or `payment.cancelled` closes the request; the invoice stays `open`; a new request (new id) may follow (B-012 governs limits).

**Overdue.** The sweeper finds `open` invoices whose `dueAt` has passed and emits `invoice.overdue` once; nothing else changes (B-013).

## 5. Existing repository state and reconciliations

What was inspected on `main` (merge of PR #43) and what it means for Billing. **Nothing in another service was changed by this document.**

| # | Finding | Consequence for Billing |
|---|---|---|
| R-1 | **Canonical invoice vocabulary.** The only existing statement of invoice states is `financial-architecture.md` section 5: `draft → open → paid \| void \| uncollectible`, with `overdue` **derived** from `dueAt`. `core-architecture.md` (events) uses the past-participle forms `invoice.paid` and `invoice.voided`, which name the same `paid` and `void` states and do not conflict with it. The words `issued`, `voided` (as a state), `cancelled` (for an invoice) and `partially_paid` appear in **no** existing document; they came from the brief this SDD was commissioned from (not stored in the repository). | The **canonical states are the architecture's**: `draft`, `open`, `paid`, `void`; `overdue` stays derived. "Issued" is the *operation* that moves `draft → open` (endpoint 10), not a state. `partially_paid` needs partial payments (**B-010**; Payment v1 is one payment per request) and `uncollectible` needs a write-off decision (**B-014**): both stay reserved and unimplemented. A separate `cancelled` adds nothing (discarding a draft is `draft → void`, 17.1). **No behaviour was invented and no owner approval is needed for the vocabulary.** |
| R-2 | The architecture's `product.type` (`one_time`, `recurring`, `organization_license`, `user_subscription`) mixes *billing interval* with *entitlement kind*. | Split: the **interval belongs to the price**, the **entitlement kind to the product** (`none` \| `organization_license` \| `user_subscription`, Stage 8). |
| R-3 | **Invoice event names.** `core-architecture.md` lists `invoice.created/due/overdue/paid/voided` and draws `invoice.created` going to notification as "you owe 30 TND". That flow only makes sense when the invoice becomes owed. The documents do not say whether a draft is announced. | This SDD **keeps the documented name `invoice.created`** and defines its *timing* as the transition `draft → open` (a draft is never announced), which is the only reading under which the documented flow is correct. The name is therefore slightly misleading (it fires at "open", not at row creation). Renaming it (an earlier draft of this SDD used `invoice.issued`) would change a documented contract and is **not adopted**; it is an optional owner decision (section 35, item 1). `invoice.due` has no defined semantics in any document and is **B-013**. No edit to `core-architecture.md` is needed. |
| R-4 | ADR-0034 says resource-creating `POST`s take `Idempotency-Key`. | As the payment SDD already does (its section 6), Billing uses a **permanent natural key** where one exists and **state-based** idempotency elsewhere (section 25). **No `Idempotency-Key` header and no `idempotency_key` table exist in Billing.** |
| R-5 | **Auth still depends on a payment route that does not exist.** `apps/auth-service/src/payment/payment-client.ts` calls `GET {PAYMENT_SERVICE_URL}/payment/licenses/{organizationId}/status` with `PAYMENT_SERVICE_TOKEN`, expects `{ "valid": boolean }`, treats **404 as "not licensed"** and anything else non-2xx as `503`. It is used at registration and when joining an organization only (`AuthService`, ADR-0004 as narrowed by ADR-0026). Payment Phase 1 on `main` has no such route. Auth's own tests use a **stub** payment client (`test/members-payment.e2e-spec.ts`, 10 passing), so the real client's 404 mapping is **not covered by any test**. The join-code migration also carries a stale comment ("Entitlement is owned by payment-service"), superseded by ADR-0038. | If Auth were pointed at payment-service today, every organization would read as "not licensed" (fail closed, silently wrong). See section 16.4 for ownership, migration and the compatibility contract. Payment SDD O-12 already gates this before payment-service reaches production. |
| R-6 | Payment events on `main` (`payment.created/succeeded/failed/cancelled/expired`) carry `paymentRequestId`, `sourceType`, `sourceId`, parties, `amount`, `currency`, `status`, `revision`, `actor`, `cause` and correlation id, but **not `producer`**. Payment's natural key is `(producer, paymentRequestId)`. | Another producer with a valid token could create a payment reusing Billing's `paymentRequestId`; its event would then look like Billing's. Billing therefore **verifies more than the id** (section 21.4): the `paymentId` recorded from Billing's own call (assigned by Payment, unforgeable) plus full snapshot equality, and it **never binds a `paymentId` from an event**. **Recommended additive Payment change (not made here):** carry `producer` in the payment event payload. |
| R-7 | Payment on `main` has **no cancel route** (endpoint 9 exists only at the service layer), **cannot start an attempt for an organization payer** (O-18), and has **no cash path** (O-4, O-5). Production use of payment creation by a non-test producer needs O-13, O-14, O-15. | Billing can create and issue invoices for any payer, but **can only complete a gateway collection for a `user` payer**, and cannot cancel a payment request that already reached Payment until Payment ships cancel. Combined with a null `expiresAt` (B-009) and BI-13, a request that Payment can never complete would be **unclosable**, which is why v1 refuses requests for non-`user` payers (13.1) and why **enabling payment requests outside the test fixture requires Payment's cancel route** (34.3). The headline flow "Nawara invoices an organization for a license" is **not completable** until B-001, B-026 (= Payment O-18) and the cash decisions are made. |
| R-8 | ADR-0006 (per-user subscription reservation) and ADR-0008 (automatic 24-hour grace license) are **Accepted**, and ADR-0038 says their rules are "kept". `financial-architecture.md` section 10, item 7 nevertheless lists "grace-period rules on the new model" as **unresolved**. | The two documents disagree. This SDD treats the ADRs as evidence of intent, **not** as approval for the invoice-driven model, and marks re-expression **[B]** (B-020, B-021). The owner should say which one governs. |
| R-9 | Kit gaps for Billing: no pagination helper (ADR-0034 lists one; `libs/service-kit` has none); the combined service-token-or-user guard, the deterministic event id and the test-app harness (the kit only ships the throwaway-database helper) live **inside payment-service**; a failed consumer goes straight to the dead-letter queue (no retry delay); no metrics facility. | None of the three is *required*: each can be implemented **locally in Billing** (section 34.1, Stage 0). Extracting the guard and the deterministic id into the kit is an optional, separate kit change with its own review; not done here. |
| R-10 | `apps/payment-service` obeys `scripts/lib/checks.mjs`: product terms (student, teacher, driver, lesson, classroom, instructor, vehicle) are forbidden in `apps/billing-service/src/`, and no service may import another's source. | Applies to Billing code from Stage 1; `check:repo` enforces it. |

## 6. Domain model and entity ownership

All tables live in billing-service's **own database** and role (`billing_migrator` owns the schema, `billing_app` runs the service; ADR-0032). The roles and the empty `billing` database already exist in `infra/postgres/init` and `docker-compose.yml`.

```
Product 1───N Price                       (catalog: what can be sold, at what reusable price)
Invoice 1───N InvoiceLine ───► Price      (line = immutable SNAPSHOT of a price at invoicing time; the link is provenance only)
Invoice 1───N PaymentRequest ──(paymentId, opaque)──► payment-service Payment
Invoice 1───N CreditNote                  (shape only, gated: B-016)
Invoice line ─(entitlement snapshot)─► OrganizationLicense | UserSubscription   (Stage 8, gated)
```

| Entity | Purpose | Status |
|---|---|---|
| `currency` | reference data: ISO 4217 code and exponent | [T] |
| `product` | a generic billable thing a seller offers | [T] |
| `price` | a reusable, **immutable** price of a product | [T] |
| `invoice` | the authoritative obligation, with an immutable financial snapshot | [T] |
| `invoice_line` | one immutable line of an invoice | [T] |
| `invoice_number_sequence` | the counter that assigns a number at issue | [T] mechanism; scope and format **[B, B-004]** |
| `payment_request` | one attempt by Billing to have Payment collect an invoice | [T] |
| `payment_event_receipt` | how each consumed Payment event was applied (applied, ignored, conflict, deferred) | [T] |
| `billing_transition` | append-only history of every state change with actor and cause | [T] |
| `credit_note` | a document reducing what is owed on an invoice | shape [T], behaviour **[B, B-016]** |
| `organization_license`, `user_subscription` | billing-derived entitlement | structure [D, ADR-0038], rules **[B]** |
| `outbox`, `inbox` | reliable events (kit migration `kit_0001`) | [D] |
| `recurring_definition` | schedules that create invoices | **[X]** until B-018 |

Billing owns **none** of: payments, attempts, refunds, journal entries, tax ledgers, identities, memberships, organizations, product concepts.

## 7. Money model [D, ADR-0036]

* Amounts are `bigint` **minor units** plus a mandatory ISO 4217 `currency char(3)`. TND has three decimals (30 TND = 30000). The exponent comes from the `currency` table, never from code. **No floating point anywhere** (columns, DTOs, calculations, events).
* JSON carries amounts as **integers** and validates them as safe integers. Every Billing amount is capped at **9007199254740991** (2^53 − 1) by a CHECK: Payment's contract caps `amount` there, so a Billing amount Payment would refuse **cannot exist**, and no event or representation can lose precision.
* Arithmetic is done in the database or with `bigint` in code; multiplication uses checked arithmetic and refuses results above the cap.
* Which currencies are supported is **configuration** (`BILLING_SUPPORTED_CURRENCIES`, no code default) and must also be enabled in Payment for collection: **[B, B-005]** (Payment O-10). A currency present in Billing but not in Payment fails only at payment-request time (`422`, section 21.2).
* Quantities are positive **integers** in v1. Fractional or metered quantities are **[X]** (B-034).
* Negative amounts do not exist in v1: there are no discounts, adjustments or credit lines (**[X]**, B-033); a credit is a `credit_note` (**[B]**, B-016).
* Cross-currency comparison or arithmetic is impossible by design: every invoice is single-currency.

## 8. Billing financial invariants [T]

These are safety properties that must hold under retries, concurrent requests, duplicate events, crashes and hostile input. IDs BI-01 to BI-12 follow the commissioning brief; BI-13 onward are added by the architecture. "DB" is the database mechanism, "App" is application enforcement, "Test" is the test each row requires (section 31). Not every invariant needs a trigger.

| ID | Rule | DB enforcement | App enforcement | Test |
|---|---|---|---|---|
| BI-01 | Every monetary amount is an integer in minor units; no floating point | `bigint` columns; no `numeric`/`float` money column; CHECK `<= 9007199254740991` | DTO `@IsInt`, safe-integer check; `bigint` arithmetic; a source scan finds no `parseFloat`, `toFixed`, or float money math | DB: fractional and 2^53 refused; API: `1.5`, `"100"`, `1e21`, `null`, 2^53 refused; unit: line and invoice arithmetic at the cap |
| BI-02 | Each amount is valid for its field: price `unitAmount > 0`; line `quantity >= 1`, `unitAmount > 0`, `lineTotal > 0`, `taxAmount >= 0`; invoice `total > 0`, `subtotal > 0`, `taxTotal >= 0`; payment request `amount > 0`; credit note `amount > 0` | CHECK constraints on every column | DTO validation | DB: zero and negative refused per column; API: same |
| BI-03 | Invoice currency never changes after creation | `forbid_column_change('currency', …)` on `invoice` (kit trigger) | none needed (no update path) | DB: UPDATE refused in every status; API: no route can change it |
| BI-04 | Every line's currency equals its invoice's | composite FK `invoice_line (invoiceId, currency) → invoice (id, currency)` | line built from the invoice currency | DB: a mismatching line INSERT refused |
| BI-05 | Invoice totals are derivable from lines: `subtotal = Σ lineTotal`, `taxTotal = Σ taxAmount`, `total = subtotal + taxTotal`, `lineTotal = quantity × unitAmount`; at least one line, at most 100; no approved adjustments exist (B-033) | CHECK `lineTotal = quantity * unitAmount`, CHECK `total = subtotal + taxTotal`; a **deferred constraint trigger** (at commit) compares the header with `Σ` of its lines, summed as `numeric` so the check itself cannot overflow | totals computed **server-side** from lines and never accepted from the client | DB: header edited to disagree is refused at commit; a missing line, an extra line, a zero-line invoice refused; API: forged totals ignored/rejected |
| BI-06 | A historical invoice never changes because a product or price changed: prices are immutable, and each line **copies** the price's amount, currency, quantity basis, description, product code and entitlement snapshot | `price` commercial columns immutable (trigger); `invoice_line` fully immutable (trigger); line values are stored, never joined at read time | representations read the line row only | DB + API: change/retire a price, archive a product, then read the old invoice: identical |
| BI-07 | An invoice total cannot become inconsistent with its lines after creation | `invoice_line` rows cannot be inserted into a non-`draft` invoice, nor updated or deleted ever; amount columns of `invoice` immutable (`forbid_column_change`) | no update path exists | DB: UPDATE/DELETE of a line, UPDATE of totals, INSERT of a line into an `open` invoice all refused |
| BI-08 | Amount due never becomes negative: `amountDue = total − Σ paid payment requests` (minus `Σ issued credit notes` **only if B-016 unlocks them**) is **derived, never stored** | trigger on `payment_request` and `credit_note` locks the invoice and refuses a sum above `total` | consumer refuses (records `conflict`) rather than over-applying | DB + integration: an over-application is refused and recorded, never applied |
| BI-09 | Payment allocation cannot exceed what the approved model permits. **v1 TEMPORARY RESTRICTION (no partial payments approved, B-010, B-011):** a payment request's `amount` equals the invoice `total`, and at most **one** payment request can be `paid` | CHECK-by-trigger `amount = invoice.total` at INSERT (relaxed by a migration only when B-010 is decided); partial unique index: one `paid` request per invoice | request creation refuses otherwise | DB: partial amount refused; a second `paid` request refused; integration: duplicate success is a recorded conflict |
| BI-10 | An issued invoice's number is unique in its numbering scope and assigned once. The counter is transactional, so an issue that rolls back consumes no number; whether a gapless series is *required* is **B-004** | `UNIQUE (sellerType, sellerId, number)` (**TEMPORARY RESTRICTION**, scope is B-004); number set once (trigger); counter row locked and incremented in the issue transaction (a rollback returns the number) | the number is assigned only by the issue transition | DB: duplicate number, renumbering refused; concurrency: N parallel issues for one seller give N distinct consecutive numbers |
| BI-11 | An invoice currency exists in the `currency` table and in the configured supported list | FK `invoice.currency → currency.code`, `price.currency → currency.code` | config check at creation (`422 unsupported_currency`) | DB: unknown code refused; API: unconfigured code `422` |
| BI-12 | A state transition and its outbox event commit atomically | same transaction; deterministic event id (`ON CONFLICT DO NOTHING`); `revision` maintained by a trigger | every transition goes through one transition function that enqueues in the same `Queryable` | integration: force the outbox insert to fail, state and history roll back; retry commits both once |
| BI-13 | **At most one active payment request per invoice** (`created`, `sending`, `requested`) | partial unique index on `payment_request (invoiceId)` for those statuses | request creation is state-idempotent (section 25) | DB race: 8 concurrent creates give one row; API: the loser gets the winner |
| BI-14 | An invoice becomes `paid` only through a payment request that is `paid` for the full `total` (v1 **TEMPORARY RESTRICTION**, B-010), and the single `paid` request for a `paid` invoice is always discoverable | CHECK `status <> 'paid' OR paidAt IS NOT NULL`; trigger: `open → paid` requires a `paid` request with `amount = total` in the same transaction; `paid` is terminal | only the payment-event consumer and the reconciler set it | DB: bare `UPDATE … status = 'paid'` refused; integration: no route or job sets `paid` (source scan, like the one in Payment's `review-matrix.e2e-spec.ts`) |
| BI-15 | A payment request's amount, currency and mapped fields never change after insert | `forbid_column_change` on `payment_request` (`invoiceId`, `amount`, `currency`, `expiresAt`, `mappingVersion`, `createdAt`) | none | DB: UPDATE refused |
| BI-16 | A `paid` or `void` invoice never reopens; a `paid` invoice is never rewritten by a refund | transition trigger whose allowed set is the section 17.1 table **without `open → void`** until B-015 is decided (**TEMPORARY RESTRICTION**; a migration adds it then) | consumer ignores `refund.*` in v1 (B-017) | DB: every forbidden pair refused (matrix test); integration: `refund.succeeded` changes nothing |
| BI-17 | Credit notes for one invoice never exceed its `total` (shape only; gated by B-016) | trigger locking the invoice, summing `numeric` | — | DB (when unlocked): concurrent credit notes cannot exceed the cap |
| BI-18 | **A Billing invoice can never yield a payment request Payment would refuse.** Payment's contract is copied onto the columns Billing sends: `payerType`/`sellerType` in (`user`, `organization`, `company`); `payerId`/`sellerId` **1 to 128 characters**; payer differs from seller; if `sellerType = 'organization'` then `sellerId` is a uuid and `organizationId = sellerId` (never NULL); `currency` matches `^[A-Z]{3}$`; `description` at most **140** characters; `number` at most **64** characters (Payment's `reference`); `sourceType`/`sourceId` (the producer's own) keep Payment's formats so they can be echoed; every amount `<= 2^53 − 1`. The request body is built from **stored canonical values** (a `uuid` column prints lower-case, which is what Payment stores and echoes for organization ids), so the echoed snapshot always compares equal | CHECK constraints copied from Payment's `payment` table and DTOs (including `char_length` bounds, the organization CHECK that also refuses a NULL `organizationId`, and a `number` length bound) | DTO validation with the same limits | DB: each violating row refused, one constraint per assertion; **contract test:** every valid invoice's mapped body (13.2) passes Payment's `CreatePaymentDto` validation |
| BI-19 | `revision` and `updatedAt` advance on every state change; every state change has a history row with actor and cause | trigger (`revision`, `updatedAt`); deferred constraint trigger requiring a `billing_transition` row per status change | the transition function writes it | DB: revision counts changes; a status change without a history row refused at commit |

## 9. Invoice model [T]

An invoice is the **authoritative obligation** and its snapshot is **immutable from creation** (BI-06, BI-07): it is created complete (header and lines in one transaction), so there is no editable half-state. To change an obligation before issue, discard the draft and create a new one.

| Field | Type and rule | Notes |
|---|---|---|
| `id` | uuid, generated by Billing | |
| `producer`, `invoiceRequestId` | calling service name, producer-generated uuid | **natural idempotency key** `UNIQUE (producer, invoiceRequestId)` |
| `seller` | `{ type, id }`, type in `user`, `organization`, `company` | the issuer / merchant. **Who is the legal issuer is [B, B-001]; whether an organization may issue through Nawara is [B, B-002]** |
| `payer` | `{ type, id }`, same types; must differ from `seller` | **Who may be a payer, and organization vs user billing, is [B, B-003]** |
| `organizationId` | uuid or null | the isolation boundary; **server-asserted by an authorized producer** (scopes **[B, B-029]**); equals `seller.id` when the seller is an organization (BI-18) |
| `sourceType`, `sourceId` | opaque strings: `sourceType` matches `^[a-z][a-z0-9_]{1,62}$`, `sourceId` is 1 to 128 characters | the **producer's** reference (what the customer owes for). Billing never interprets or looks them up |
| `currency`, `subtotal`, `taxTotal`, `total` | section 7; totals **computed by Billing** | `taxTreatment = not_determined` in v1 (below) |
| `description` | at most 140 characters, descriptive only | never used in a decision |
| `dueAt` | absolute timestamp or null, **supplied at creation** | Billing computes no payment terms (**[B, B-008]**); null means "no due date" (never overdue) as a **PROPOSED — NOT APPROVED** fallback |
| `number` | assigned at issue | provisional counter, **[B, B-004]**, **[B, B-007]** |
| `status`, `revision` | section 17.1 | |
| `createdAt`, `issuedAt`, `paidAt`, `voidedAt`, `overdueAt`, `updatedAt` | database clock (`paidAt` = the time Payment reports: the event's `succeededAt`, or Payment's `closedAt` when settled by the reconciler; every decision uses Billing's database time) | `overdueAt` only marks that `invoice.overdue` was emitted |
| `voidReasonCode` | bounded code (at most 64 characters) | free text stays out of events (personal data, **B-032**) |

**Tax [B, B-006].** No tax rule is invented and no rate is hardcoded. Every invoice carries `taxTreatment`, whose only value in v1 is `not_determined`, and a CHECK requires `taxTotal = 0` while it is. This states honestly that *no tax determination was made*; it does **not** assert that no tax is due. Issuing invoices to real customers is blocked until B-006 and B-007 are decided (section 34.3). The `taxAmount` line field and `taxTotal` exist so the decision can be added without a redesign; who computes them (Billing from configuration, Accounting, or the producer) is the open question.

**Representation (excerpt):**

```
Invoice { id, invoiceRequestId, number, status, isOverdue,           // isOverdue = status open AND dueAt < now(), computed
          seller{type,id}, payer{type,id}, organizationId, sourceType, sourceId, description,
          currency, subtotal, taxTotal, total, amountPaid, amountDue, taxTreatment,   // amountPaid/amountDue derived (BI-08)
          dueAt, issuedAt, paidAt, voidedAt, createdAt, updatedAt,
          lines[ InvoiceLine ], activePaymentRequest { id, status, paymentId } | null }
InvoiceLine { id, lineNumber, productCode, description, quantity, unitAmount, lineTotal, taxAmount, currency, sourceType, sourceId }
```

## 10. InvoiceLine model [T]

| Field | Rule |
|---|---|
| `id`, `invoiceId`, `lineNumber` | `UNIQUE (invoiceId, lineNumber)`, 1 to 100 |
| `currency` | equals the invoice's (BI-04, composite FK) |
| `priceId`, `productId` | provenance within Billing's own database. **In v1 every line references a catalog price**; the amount comes from that price, server-side |
| `productCode`, `description`, `unitAmount` | **snapshots copied from the price/product at creation** (BI-06) |
| `entitlementKind`, `entitlementInterval` | snapshot of the product's kind and the price's interval, so an entitlement decision at payment time uses **what was sold**, not what the catalog says later (Stage 8) |
| `quantity` | integer, `>= 1` |
| `lineTotal` | `quantity × unitAmount`, CHECKed |
| `taxAmount` | `>= 0`, `0` while `taxTreatment = not_determined` |
| `sourceType`, `sourceId` | optional opaque per-line reference from the producer |

Lines have **no lifecycle**: insert once, never updated or deleted (BI-07). A line whose amount is asserted by the producer instead of read from a price ("ad hoc" line) is **[B, B-030]**: whether a trusted producer may assert prices at all, or only catalog prices count, is a trust decision (the same shape as Payment's O-14) and is **not implemented**.

## 11. Product model [T]

| Aspect | Definition |
|---|---|
| Purpose | A generic billable thing a seller offers. **Not a Nawara software product**: it may be any service. Billing knows nothing about what it means |
| Fields | `id`, `seller{type,id}`, `code` (`^[a-z][a-z0-9_-]{1,62}$`), `name` (at most 140), `description` (at most 280, nullable), `entitlementKind` (`none` \| `organization_license` \| `user_subscription`, default `none`; only meaningful in Stage 8), `status` (`active` \| `archived`), `revision`, timestamps |
| Uniqueness | `UNIQUE (sellerType, sellerId, code)` (natural key; creation is a replay when identical, `409` when different) |
| Immutable | everything except `status` (`active → archived`, one way) and the descriptive `name`/`description` are **[X]** to edit in v1 (no edit route; archive and create a new one) |
| Isolation | reached by the producer that created it (scopes **[B, B-029]**, **B-031**) |

Archiving a product never touches existing invoices (BI-06). New invoices cannot use a price of an archived product.

## 12. Price model [T]

| Aspect | Definition |
|---|---|
| Purpose | A **reusable, immutable** price: a change is a **new price**, never an edit (BI-06) |
| Fields | `id`, `productId`, `clientReference` (natural key), `currency`, `unitAmount` (`> 0`), `interval` (`one_time` \| `recurring`), `intervalUnit` (`day`, `week`, `month`, `year`) and `intervalCount` (both null for `one_time`, both required for `recurring`), `pricingModel` (`flat` only), `effectiveFrom`, `retiredAt` (null until retired, set once), `revision` |
| Uniqueness | `UNIQUE (productId, clientReference)` |
| Immutable | every commercial column; only `retiredAt` may be set, once (`forbid_column_change` plus a set-once trigger) |
| Availability | usable at time *t* iff `effectiveFrom <= t` and (`retiredAt` is null or `t < retiredAt`) and its product is `active`, decided by database time |
| Not in v1 **[X]** | usage-based, tiered, volume pricing; discounts, coupons, promotions (**B-033**, **B-034**); `pricingModel` has a CHECK for `'flat'` so nothing else can be stored |

A `recurring` price is **data only** in v1: it describes an interval that an invoice line can snapshot. It causes **no renewal, no schedule and no subscription** (section 15).

## 13. PaymentRequest boundary [T]

A **payment request** is Billing's record of asking Payment to collect one invoice. Billing owns the request's lifecycle; **Payment owns the resulting `Payment`** and its state. Billing never stores payment attempts, providers, methods, or provider data.

### 13.1 Rules

* Created by an explicit business operation (`POST /billing/invoices/{id}/payment-requests`), **never automatically at issue** (automatic creation is **[X]**; **B-009** covers policy). Only an `open` invoice with no active request and `amountDue > 0` can have one.
* **v1: payment requests are created only for a `user` payer.** Payment can start an attempt only for a `user` payer (its O-18), and has no cancel route yet (R-7), so a request for an organization or company payer would sit `requested` forever, block new requests and block voiding, with nothing able to close it. Creation for any other payer type is refused with `409 payment_request_not_supported` until B-026 is decided (**TEMPORARY RESTRICTION**). The invoice itself can still be issued and shown.
* **v1: the request `amount` equals the invoice `total`** (BI-09). A smaller amount is partial payment, **[B, B-010]**.
* The request id **is** `paymentRequestId`, generated by Billing when the row is inserted, and **never regenerated for a retry**. The row is committed **before** Payment is called ("persist before call"), so every Payment event that can ever exist finds its row already there.
* After a request ends `failed`, `cancelled` or `expired`, a **new** request (new id) may be created while the invoice is `open`, because Payment's natural key is permanent (Payment SDD 3.3). How many retries, and what a failure means for the invoice, is **[B, B-012]**.
* The request's `expiresAt` is **not defaulted**: it is null unless a policy exists (**[B, B-009]**, Payment O-16). Null is Payment's own *PROPOSED — NOT APPROVED* fallback; Billing does not choose it, it only declines to choose.

### 13.2 Mapping into Payment's contract (exact)

The body of `POST /payment/payments` is a **pure function** of `(invoice, payment_request)`, both immutable, so any retry is byte-for-byte the same request and Payment's natural-key replay (`200`, `Idempotent-Replayed: true`) is guaranteed (BI-15, `mappingVersion` pins the function).

| Payment field (SDD 3.1) | Billing source | Rule |
|---|---|---|
| `paymentRequestId` | `payment_request.id` | uuid, permanent |
| `sourceType` | the constant `invoice` | **Billing's own vocabulary**, not the invoice's `sourceType` (the payment's producer is Billing) |
| `sourceId` | `invoice.id` | `<= 128` characters |
| `payer` | `invoice.payer` | copied |
| `seller` | `invoice.seller` | copied, must differ from `payer` |
| `organizationId` | `invoice.organizationId` | uuid or null; equals `seller.id` for an organization seller (BI-18) |
| `amount` | `payment_request.amount` | integer minor units, `1 … 2^53 − 1` |
| `currency` | `invoice.currency` | must be enabled in Payment's configuration |
| `expiresAt` | `payment_request.expiresAt` | null unless policy (B-009) |
| `description` | `invoice.description` | `<= 140` |
| `reference` | `invoice.number` | `<= 64` |

Unknown fields are rejected by Payment (`400`), so Billing sends **exactly** these.

### 13.3 What Billing does not put in the request

Line items, tax, fees, return URLs, payment methods, customer contact data (Payment SDD 3.1 lists all of them as not in the contract). The customer chooses the method at Payment.

## 14. CreditNote boundary [B, B-016]

The architecture lists a `credit_note` (invoice, amount `<=` invoiced amount, reason). Its **existence is decided as a direction; its behaviour is not**, so it is specified as a **shape** only and **implementation is blocked** until B-014 to B-017 are decided.

| Aspect | Shape [T], behaviour [B] |
|---|---|
| Purpose | A document that reduces what is owed on an issued invoice. **Refunds belong to Payment**; a credit note is not a refund and moves no money |
| Fields | `id`, `invoiceId`, `number`, `amount` (`> 0`), `currency` (equal to the invoice's, composite FK), `reasonCode` (bounded), `status` (`issued`; terminal), `issuedBy` actor, `createdAt`, `revision` |
| Immutable | everything (a correction is another document, never an edit) |
| Invariant | `Σ credit notes <= invoice total` (BI-17), enforced by a trigger that locks the invoice; interacts with BI-08 (`amountDue`) |
| Event | `credit_note.issued` (section 23), consumed by Accounting |
| **Open** | full vs partial (B-016); credit against an **unpaid** vs a **paid** invoice, and how a paid one relates to a refund (B-016, B-017); legal numbering and content (B-007); who may issue and void (B-016, B-028); whether the invoice moves to `paid` when credit reduces due to zero (B-011, B-016); effect on entitlement (B-025) |

## 15. Subscription and recurring billing boundary [X until B-018]

The architecture assigns "recurring definitions" and a "recurring-billing runner and dunning" to Billing but **defers them** (financial-architecture section 12). **No recurring behaviour is designed for implementation.**

What *is* fixed, so a later decision cannot force a redesign:

* A recurring definition, if approved, is a **separate entity** (`recurring_definition`), not a state of `invoice` and **not** the entitlement `user_subscription` (which is *what was bought and is it valid*, not *when do we bill*).
* Cycle invoices use a **natural key** `UNIQUE (recurringDefinitionId, periodStart)`, so a crashed or duplicated runner cannot bill a period twice (section 25).
* **Lock order** for the runner and manual actions is fixed in section 26 (definition first; no path locks a definition after an invoice), so "recurring job vs manual cancellation" cannot deadlock.
* The price's `interval` fields already carry the cadence.

Every behavioural question is **[B]** and none is decided: whether recurring billing exists (B-018), trials (B-019), grace (B-020), retry/dunning after failure (B-012, B-013), cancellation timing (B-022), proration (B-023), upgrade/downgrade (B-023), pause/resume (B-024), automatic renewal (B-018), payment-retry count (B-012).

## 16. Entitlement boundary

### 16.1 What Billing owns and does not own [D, ADR-0038]

```
Billing:  "Is this organization / user ENTITLED according to billing?"      → { valid, expiresAt }
Product:  "What does an entitled organization / user actually get to DO?"   → the product's own authorization
Auth:     "Who is this, are they active, what memberships do they have?"    → identity only
```

Billing stores **whether something bought is still valid**. It stores no product role, no permission, no capability list, and never product-role concepts (for example a role or permission named after a product). Authentication **never** depends on entitlement (ADR-0026, ADR-0038): a lapsed license leaves the user a valid identity; the consuming service asks Billing at the point of use and denies the protected capability.

### 16.2 Structure [D, ADR-0038], rules [B]

| Table | Structure [D] | Rules |
|---|---|---|
| `organization_license` | `organizationId` (**one active per organization**), `type` (`standard` \| `grace`), `status`, `expiresAt`, opaque `invoiceId` / `paymentId` references | activation and extension math, grace, expiry: **B-020, B-025** |
| `user_subscription` | `userId` **and** `organizationId` (a user may hold subscriptions under many organizations), `status` (`active` \| `suspended` \| `expired`), `expiresAt` xor `frozenRemainingSeconds` | reservation on lapse, resume: **B-021** |

Entitlement changes **only from events**: a `payment.succeeded` applied to an invoice whose line snapshot has an `entitlementKind` activates or extends it. It uses the **line snapshot** (BI-06), never today's catalog. **How much time a payment buys and whether renewals stack from the old expiry or from the payment date is [B, B-025].**

### 16.3 Status API [D shape, T route]

Platform services call, with a **service token** (Stage 8):

| Route | Answer |
|---|---|
| `GET /billing/licenses/{organizationId}/status` | `200 { "valid": boolean, "expiresAt": string \| null }` |
| `GET /billing/subscriptions/{userId}/status?organizationId=…` | same shape |

"None" and "expired" give the **same answer** (`valid: false`), so the API is not an existence oracle [D, ADR-0038]. An unknown organization is `200 { valid: false }`, **never a 404** (a 404 must mean "no such route", see 16.4). Each consumer documents whether it fails open or closed when Billing is unreachable [D]. The path deliberately mirrors the route Auth already calls, so the repointing is a host, path and credential change (16.4).

### 16.4 Auth entitlement cleanup (documentation only; nothing is changed by this phase)

| Item | State |
|---|---|
| Current behaviour | See R-5. Auth's `HttpPaymentClient.isOrganizationLicensed()` calls `GET /payment/licenses/{organizationId}/status`, sends `PAYMENT_SERVICE_TOKEN` as a bearer, requires `{ valid: true }`, maps 404 to "no license" and any other failure to `503`. Called only at registration and when joining an organization. |
| Payment reality | payment-service (`main`) **implements no such route**; per Payment SDD O-12 this is acceptable **only while payment-service is not deployed to production**. |
| Desired ownership | Auth = identity, security, membership. **Billing = billing-derived entitlement.** Whether Auth keeps a synchronous check at all is **[B, B-035]** (financial-architecture section 10, item 8). |
| Migration strategy | (1) Stage 8 ships the status route above in Billing, registering `auth-service` as a caller (digest in `SERVICE_TOKENS`). (2) A **separate, additive Auth PR** adds `BILLING_SERVICE_URL` / `BILLING_SERVICE_TOKEN` and a client for the Billing path, selected by configuration; the old client stays until cutover. (3) Cutover is a configuration change; (4) the Payment reference is removed in a later Auth PR. No behaviour of Auth's own API changes at any step. |
| Compatibility requirement | Billing's answer keeps Auth's parsed shape (`valid: boolean`); fail-closed behaviour is unchanged; unknown organization is `200 valid:false`. A **contract test** (Billing route against Auth's client parsing) is required at Stage 8. |
| Documentation debt | Auth's SDD and the `requiresSubscription` migration comment still name payment-service as the entitlement owner (ADR-0026 wording); they are updated with the Auth PR, not here. |
| Dependency | Billing Stage 8, which is itself gated by B-020, B-025 for real activation logic. Until then nothing changes and nothing is moved silently. |
| Risk to check before any production deploy | The production value of `PAYMENT_SERVICE_URL` in Auth was **not inspected** (no production access). If it points at payment-service, org registration is already reading as "not licensed". |

## 17. State machines

Every transition is a **conditional update** (`WHERE status = <expected>`) inside a transaction holding the row lock, writes a `billing_transition` row, and enqueues its event. A **database trigger** refuses any move not in these tables (defence in depth), and a **matrix test** proves the TypeScript table and the trigger agree on every pair (the lesson of Payment's transition-matrix tests). Reversal of a terminal state is never possible.

### 17.1 Invoice

States: `draft` (created, immutable snapshot, no number, not announced), `open` (issued: has a number, owed), `paid` (terminal), `void` (terminal). **Derived, not stored:** `overdue` = `open` and `dueAt < now()` (database clock). **Reserved, not implemented:** `uncollectible` (**B-014**), `partially_paid` (**B-010**).

| From | To | Caused by | Precondition | Event | Reversal | Payment / accounting consequence |
|---|---|---|---|---|---|---|
| (none) | `draft` | producer service: create | valid, natural key new or identical | none | n/a | none |
| `draft` | `open` | producer service: **issue** (state-idempotent) | at least one line; totals consistent; currency supported; number assigned under the counter lock | `invoice.created` | no (only `open → void`, B-015) | Accounting may recognise the obligation (its decision); no payment yet |
| `draft` | `void` | producer service: **discard** | none | none (a draft was never announced) | no | none; no number consumed |
| `open` | `paid` | **system**: payment-event consumer or reconciler | a payment request `paid` for `total` (v1); amount and currency equal the snapshot | `invoice.paid` | **never** (refunds are Payment's; credit is B-016) | `payment.succeeded` is the cash fact; `invoice.paid` is informational (section 22) |
| `open` | `void` | producer service: **void** — **[B, B-015]** | **no active payment request** (else `409 invoice_has_active_payment_request`); not `paid` | `invoice.voided` | no | The accounting effect is Accounting's decision; whether an issued invoice may be voided at all, or must be credited, is **B-015** |
| `open` | `uncollectible` | — | — | — | — | **not implemented** (B-014) |

**Forbidden, among others:** any move out of `paid` or `void`; `draft → paid`; `open → draft`; `paid → open`; success accepted from a client claim; voiding while a payment can still succeed. Repeated `issue` on an `open` invoice is **not** an error: it replays (`200`, `Idempotent-Replayed: true`); on `paid`/`void` it is `409 invalid_state_transition`.

`invoice.overdue` is emitted **once** by a sweep when an `open` invoice's `dueAt` has passed (stamping `overdueAt`, deterministic event id). It changes no state. What overdue *does* (notifications, escalation, suspension) is **B-013**.

### 17.2 InvoiceLine

No lifecycle. **Insert-only, immutable** (section 10). Included for completeness because the brief asks for it.

### 17.3 PaymentRequest

States: `created` (row committed, not yet sent), `sending` (claimed by the dispatcher), `requested` (Payment acknowledged; `paymentId` stored), and terminal `paid`, `failed`, `cancelled`, `expired`, `rejected`.

| From | To | Caused by | Precondition |
|---|---|---|---|
| (none) | `created` | payer or producer: create | invoice `open`, no active request, `amountDue > 0` |
| `created` | `sending` | dispatcher claim (`FOR UPDATE SKIP LOCKED`) | none; increments `sendAttempts`, stamps `sendingSince` |
| `sending` | `sending` | dispatcher retry after a timeout, 5xx, 429, `401`/`403` (a configuration fault, alerted) or crash | `sendingSince` older than the send timeout; **same request, same id** |
| `sending` | `requested` | Payment answered `201` or `200 Idempotent-Replayed` (the reconciler may also record it from `GET`) | stores `paymentId`; verifies the echoed snapshot. **The only ways a `paymentId` is ever stored** |
| `sending` | `rejected` | Payment answered `400`, `409 payment_request_conflict` or `422 unsupported_currency` | a definitive refusal that a retry cannot change; raises an alert (it is a Billing or configuration defect) |
| `requested` | `paid` | `payment.succeeded` consumed (or reconciler) | all checks of 21.4 pass; invoice `open`; amount = request amount |
| `requested` | `failed` / `expired` / `cancelled` | `payment.failed` / `payment.expired` / `payment.cancelled` consumed (or reconciler) | invoice unchanged; a **new** request may follow |
| `created` | `cancelled` | producer: cancel a request **never sent** | `sendAttempts = 0` and not `sending` (else use the flag below) |
| `sending` \| `requested` | (cancel requested) | producer: cancel | stamps `cancelRequestedAt`; Billing calls Payment cancel; the terminal state arrives by `payment.cancelled`. **Requires Payment to ship its cancel route (R-7).** Payment refuses cancel while an attempt is open (`409`), which Billing surfaces as `409 payment_request_in_flight` (also for `cash_submission_exists`; see 21.2) |

A `sending` request whose dispatch finishes after `cancelRequestedAt` is set is cancelled at Payment by the dispatcher itself, so a cancelled request can never leave a collectible payment behind.

### 17.4 CreditNote **[B, B-016]**

Shape only: `(none) → issued` (terminal). Nothing else is defined until B-016 is decided.

### 17.5 Entitlement **[B]**

`organization_license`: `active(standard)` → (expiry) → `active(grace)` → `expired`, and back to `active(standard)` on renewal; `user_subscription`: `active` ⇄ `suspended` → `expired`. These are the **ADR-0006/0008 shapes** (R-8) and are **not approved for the invoice-driven model**: every transition, its trigger, and its timing is **[B, B-020, B-021, B-025]**. Only the *structure* of section 16.2 and the read-only status API can be built without them.

### 17.6 Subscription **[X]**

Not designed (section 15).

## 18. API design

Public prefix `/billing` [D, ADR-0034]; no version segment in v1; errors and lists follow the service-kit conventions; OpenAPI is served at `/billing/docs` behind basic authentication (as Auth and Payment do) and **every controller method and DTO field carries `@ApiOperation`, `@ApiResponse` and `@ApiProperty`** (repository rule). `GET /health` and `GET /ready` are the kit's root paths and are not routed publicly. There is deliberately **no generic create/update/delete** of any entity, and **no route that sets a status directly**: every mutation is a named business operation.

| # | Method and path | Authentication | Idempotency | Stage / gate |
|---|---|---|---|---|
| 1 | `POST /billing/products` | service token | natural key `(seller, code)` | 3; production scopes **B-029, B-031** |
| 2 | `GET /billing/products/{id}` | service token | n/a | 3 |
| 3 | `POST /billing/products/{id}/archive` | service token | by state | 3 |
| 4 | `POST /billing/prices` | service token | natural key `(productId, clientReference)` | 3 |
| 5 | `GET /billing/prices/{id}` | service token | n/a | 3 |
| 6 | `POST /billing/prices/{id}/retire` | service token | by state | 3 |
| 7 | `POST /billing/invoices` | service token | natural key `(producer, invoiceRequestId)` | 3; production scopes **B-029**, prices **B-030** |
| 8 | `GET /billing/invoices/{id}` | service token or user bearer | n/a | 3 / 6 |
| 9 | `GET /billing/invoices` | service token or user bearer | n/a | 6 |
| 10 | `POST /billing/invoices/{id}/issue` | service token | by state | 3; real customers **B-004, B-006, B-007** |
| 11 | `POST /billing/invoices/{id}/discard` | service token | by state | 3 |
| 12 | `POST /billing/invoices/{id}/void` | service token | by state and reason | **blocked: B-015** |
| 13 | `POST /billing/invoices/{id}/payment-requests` | user bearer or service token | by state (BI-13) | 4; org payers **B-026** |
| 14 | `GET /billing/payment-requests/{id}` | service token or user bearer | n/a | 4 |
| 15 | `POST /billing/payment-requests/{id}/cancel` | service token | by state | 4; needs Payment cancel (R-7) |
| 16 | `POST /billing/credit-notes` | — | — | **blocked: B-016** |
| 17 | `GET /billing/licenses/{organizationId}/status` | service token | n/a | 8; **B-020, B-025** for activation |
| 18 | `GET /billing/subscriptions/{userId}/status` | service token | n/a | 8; **B-021, B-025** |

### 18.1 Endpoints

**1. Create product.** Body `{ seller, code, name, description?, entitlementKind? }`. `201`; `200` + `Idempotent-Replayed: true` on an identical replay; `409 product_conflict` when the `(seller, code)` exists with different content. No event.

**2. Get product.** `200`, or `404` when the caller has no relation to it.

**3. Archive product.** No body. `active → archived`, one way; `200` replay if already archived. Existing invoices are untouched (BI-06).

**4. Create price.** Body `{ productId, clientReference, currency, unitAmount, interval, intervalUnit?, intervalCount?, effectiveFrom }`. `201` / `200` replay / `409 price_conflict`. `pricingModel` is not an input (`flat` only). `422 unsupported_currency`.

**5. Get price.** `200`, or `404`.

**6. Retire price.** No body. Sets `retiredAt` once; `200` replay. Existing invoices are untouched (BI-06).

**7. Create invoice.** Body: `{ invoiceRequestId, seller, payer, organizationId?, sourceType, sourceId, description?, dueAt?, lines: [ { priceId, quantity, description?, sourceType?, sourceId? } ] }`. **There is no `amount`, `total`, `currency`, `tax` or `status` field: unknown fields are `400`** (mass assignment). Currency, `unitAmount` and the description snapshot are read from the price server-side; every line must share one currency; all totals are computed. `201` (or `200` with `Idempotent-Replayed: true` on an identical replay). Errors: `400 invalid_invoice_request`, `401`, `403 operation_not_permitted`, `409 invoice_request_conflict`, `422 unsupported_currency`, `422 price_not_available` (unknown, retired, not yet effective, archived product, or mixed currency). Creates `draft`; **no event**.

**8. Get invoice.** `200` with the representation of section 9; `404` when the caller has no relation. No transition.

**9. List invoices.** `?limit=&cursor=&status=&sourceType=&sourceId=&payerType=&payerId=&dueBefore=`, `sort` fixed to `createdAt` descending, returning `{ items, nextCursor }` (ADR-0034). **The scope is derived from the caller, never from a filter:** a service token lists only invoices it produced; a user bearer lists only invoices whose payer is that user. A client-supplied `organizationId` or `payerId` that does not match the caller yields an **empty list**, never data. `limit` is capped at 100. Organization-member listing is **[B, B-027]**.

**10. Issue.** No body. Locks the invoice, then the seller's number counter; assigns the number; `draft → open`; enqueues `invoice.created`. `200` with the invoice. `200 Idempotent-Replayed` if already `open`. `409 invalid_state_transition` if `paid`/`void`.

**11. Discard.** No body. `draft → void`, no number consumed, no event.

**12. Void.** Body `{ voidReasonCode }`. **Blocked (B-015).** Specified for completeness: refused while a payment request is active (`409 invoice_has_active_payment_request`).

**13. Create payment request.** No body in v1 (amount is the invoice's; `expiresAt` is null, B-009). `201` with the request; `200` with the **current active** request if one exists (state idempotency). The response carries `paymentId` once Payment has acknowledged, so the payer can start an attempt at Payment with their own bearer. `202` is never used: the request is durable before the call, and a `requested` state may follow asynchronously (`status: created \| sending`). Errors: `404`, `403`, `409 invoice_not_payable` (not `open`), `409 payment_request_not_supported` (payer is not a `user`, B-026). A Payment outage is **never** an error here: the row is durable and the dispatcher retries. A client that retries after its first request already *finished* (failed, expired, cancelled) creates a **new** request; that is at worst an extra collection attempt on an invoice that is still `open`, never a double payment, because an invoice can be `paid` only once (BI-09, BI-13).

**14. Get payment request.** `200` with `{ id, invoiceId, status, amount, currency, paymentId }`; `404` when the caller has no relation to the invoice.

**15. Cancel payment request.** `200` when a request that was **never sent** is cancelled locally; `202` when a cancel was requested of Payment (the terminal state then arrives as `payment.cancelled`); `409 payment_request_in_flight` when Payment refuses because an attempt is open or cash is awaiting review (21.2). Needs Payment's cancel route for any request that reached Payment (R-7).

**16. Create credit note.** **Blocked (B-016).** No behaviour is defined.

**17. License status.** Section 16.3. Service token only; `200 { valid, expiresAt }`, never `404` for an unknown organization.

**18. Subscription status.** Section 16.3. Service token only; same shape.

### 18.2 Error model

Reuses the kit body `{ statusCode, message, error, code?, requestId }`. Messages are generic; **no stack, SQL, constraint name, payment payload or credential ever reaches a response** [D].

| Code | HTTP | When |
|---|---|---|
| `invalid_invoice_request` / `invalid_price_request` / `invalid_product_request` | 400 | validation, unknown fields, bad party, amount, quantity |
| `unauthorized` | 401 | missing or invalid service token or user bearer, or an inactive identity |
| `operation_not_permitted` | 403 | the caller sees the resource but may not do this |
| `not_found` | 404 | no such resource **or the caller has no relation to it** (collapsed) |
| `invoice_request_conflict` / `product_conflict` / `price_conflict` | 409 | same natural key, different content |
| `invalid_state_transition` | 409 | the state machine forbids the move |
| `invoice_not_payable` | 409 | a payment request on an invoice that is not `open` or has nothing due |
| `payment_request_not_supported` | 409 | a payment request for a payer type Payment cannot collect from yet (B-026) |
| `invoice_has_active_payment_request` | 409 | void while a payment request is active (a draft cannot have one) |
| `payment_request_in_flight` | 409 | cancel refused by Payment |
| `unsupported_currency` / `price_not_available` | 422 | not in the configured list / price cannot be used |
| `rate_limited` | 429 | baseline limit (section 29) |
| `auth_unavailable` | 503 | Auth cannot be asked; fail closed |

## 19. Authorization

### 19.1 Who asks whom [D]

* **Auth** answers who the person is, whether the identity is active, and their memberships (`GET /auth/me`, through the kit's `HttpAuthClient`, live, uncached, `503` when Auth cannot answer). **An inactive identity is refused (`401`).**
* **Billing** decides whether the caller may perform *this billing operation*. Billing does **not** delegate that decision to Auth and does **not** treat a generic Auth capability (for example the organization-administrator flag) as billing authority: **Auth admin ≠ Billing administrator** unless a decision says so (**B-028**). Billing keeps no membership table of its own and adds nothing to Auth's `User`.
* **Service to service** uses a per-pair service token; the caller is identified by service name. Endpoints accepting **either** a service token or a user bearer try the service digests first; on a match the bearer is **never** sent to Auth. This is the combined guard Payment already implements (R-9).
* There is no permission service, and no Billing operation edits a status directly.

### 19.2 Isolation procedure for every request [D]

```
authenticate (401) → for a user: ask Auth (503 if unavailable, 401 if inactive)
  → load the resource by id → establish the caller's RELATION to it → none: 404 (collapsed)
  → check the OPERATION rule for that relation → not allowed: 403
  → check the state machine → 409 → perform, in one transaction, with the outbox event
```

The organization always comes **from the resource**, never from a token or a client-supplied header. A caller with no relation gets the same `404` as for a missing resource. Membership must be `active`.

### 19.3 Relations [T]

| Relation | Holds when |
|---|---|
| `producer` | the caller is the service that created the invoice / product / price (service token name equals `producer`) |
| `payer` | the payer is a `user` and equals the caller's Auth identity |
| `payer-organization member`, `seller-organization member`, `platform staff` | **[B]** (B-026, B-027, B-028): no relation is granted in v1 |

A `company` payer or seller has **no user relation** in v1: it is reachable only through its `producer`.

### 19.4 Operation rules

| Operation | Rule | Marker |
|---|---|---|
| Create / archive product; create / retire price | a **producer service** with a valid token, for its own sellers. Which services may do this for which sellers (token scopes; the kit guard has none) | **[B, B-029, B-031]** |
| Create invoice | a producer service with a valid token. Scopes, and whether it may assert an organization it cannot be checked against | **[B, B-029]** (asserted `organizationId`: same gap as Payment O-15) |
| Issue / discard | the `producer` of that invoice | [T] |
| Void | not decided | **[B, B-015, B-028]** |
| Read an invoice or payment request | the `producer` (only its own) and the `payer` when a `user` | [T]. Members of the payer or seller organization: **[B, B-027]** (until decided, **no** organization read access) |
| List invoices | the caller's own scope only (18.1) | [T] |
| Create a payment request | the user `payer`, or the `producer` | [T] for a user payer; **[B, B-026]** for an organization payer |
| Cancel a payment request | the `producer` | [T] |
| Issue a credit note | not decided | **[B, B-016, B-028]** |
| Entitlement status | a service token | [D] |
| Administrative or support operations | **none** | [X] |

### 19.5 What Billing never trusts [D]

A client-supplied `userId`, `organizationId`, `platformId`, role, permission, amount, currency, tax, total, price, payer or beneficiary is never authority or fact. Authority is a **relation to the resource** plus the **operation rule**. Amounts come from **catalog prices**; totals from lines; currency from the price; organization from the invoice. Where an operation rule is `[B]`, an implementation must not invent one, and the endpoint stays unimplemented or **fails closed**.

## 20. Service authentication [D, ADR-0033]

* **Inbound:** the kit's per-caller service tokens (`SERVICE_TOKENS=<caller>:<sha256 digest>`, at most two per caller, constant-time comparison). Callers: each producer service, `auth-service` (Stage 8), and any platform service that reads entitlement.
* **Outbound to Payment:** Billing holds **one token for the pair billing → payment** (`PAYMENT_SERVICE_TOKEN`, 32+ random bytes, from a secret store or `NAME_FILE`, never in source control, never logged, never in events). Payment stores its digest under the caller name `billing-service`, which is the `producer` Payment sees.
* **A user's JWT is never forwarded to Payment, or to anything but Auth.** The user who caused an action appears only as an **actor reference** in `billing_transition` and in event `actor`/`cause`, never as a credential.
* **No new authentication mechanism is introduced.** Billing does **not** need Payment to be up to authenticate anyone.

## 21. Payment integration

### 21.1 Direction and shape

```
Billing ── (service token) POST /payment/payments ─────────► Payment      (create; natural-key idempotent)
Billing ── (service token) POST /payment/payments/{id}/cancel ► Payment   (needs Payment endpoint 9, R-7; sends Idempotency-Key)
Billing ── (service token) GET  /payment/payments/{id} ───────► Payment   (recovery only, 21.5)
Payment ── payment.succeeded | failed | cancelled | expired ──► Billing   (events; consumed idempotently)
```

Payment **never** calls Billing to learn whether a payment exists: it operates from the snapshot. There is **no synchronous Payment → Billing dependency** anywhere, and none is invented.

### 21.2 Request and response contract

The request is section 13.2. Payment's answers and Billing's handling:

| Payment answer | Meaning | Billing |
|---|---|---|
| `201`, or `200` + `Idempotent-Replayed: true` | accepted / already accepted | `sending → requested`, store `paymentId` (verify the echoed `amount`, `currency`, `sourceId`) |
| `400 invalid_payment_request` | Billing built an invalid request (a defect) | `rejected`, alert |
| `409 payment_request_conflict` | same id, different snapshot (a defect, or another producer's id collision) | `rejected`, alert |
| `422 unsupported_currency` | Payment does not accept this currency | `rejected`, alert (B-005) |
| `401`, `403` | service token / producer authorization (O-13, O-14) | retry with backoff; alert (a configuration fault, not the invoice's) |
| `429`, `5xx`, timeout, connection lost | transient | retry the **same** request (safe by the natural key) |

**Cancel.** Payment's cancel requires an `Idempotency-Key` (Payment SDD 6 and 9). Billing sends the deterministic key `billing-cancel-{paymentRequestId}` (8 to 128 characters of `[A-Za-z0-9._:-]`), so a retried cancel is a replay. Payment's answers: `200` cancelled (the terminal state still arrives as `payment.cancelled`); `409 payment_has_open_attempt` or `409 cash_submission_exists` mean money may be in flight, surfaced as `409 payment_request_in_flight` with nothing changed; `409 invalid_state_transition` means Payment already reached a terminal state, which Billing settles from the terminal event or the reconciler (no error to the caller); `404` means the payment does not exist (an alert).

### 21.3 Events consumed

Queue `billing.payment-events`, bindings `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired` (`payment.created` and everything else are **not** subscribed). `cash_payment.*` and `refund.*` are **not** consumed in v1 (`refund.*`: **B-017**). The payload is Payment's: `paymentId`, `paymentRequestId`, `sourceType`, `sourceId`, `organizationId`, `payer`, `seller`, `amount`, `currency`, `status`, `revision`, `actor`, `cause`, plus `settledMethod`, `succeededAt` (succeeded), `failureCode` (failed) and `expiresAt` (expired). Amounts are JSON integers; Billing reads them as `bigint`.

### 21.4 Consumption procedure (one transaction, kit `InboxService.handle`)

```
insert inbox(eventId)  ── duplicate ──► stop (nothing happens twice)
find payment_request by paymentRequestId
   ─ none  ──► receipt: ignored            (someone else's payment: Payment events carry no `producer` (R-6), and another
                                            producer may legitimately use the same sourceType, so an unknown id is never an alert)
lock the INVOICE first, then the payment_request        (section 26 lock order)
   ─ payment_request.paymentId is NULL (dispatch not yet recorded) ──► receipt: deferred, NO state change.
        A paymentId is NEVER bound from an event: only Billing's own authenticated call to Payment (21.2) or the reconciler
        (which reads it with Billing's service token) may set it. The reconciler settles the request afterwards (21.5).
verify: header source = payment-service; paymentId = payment_request.paymentId; sourceType = 'invoice'; sourceId = invoice.id;
        payer, seller, organizationId, currency and amount = the stored snapshot
   ─ any mismatch ──► receipt: conflict + alert, NO state change
apply by event:
   succeeded: request must be requested (or sending with paymentId set), invoice open → request paid, invoice paid (BI-14), invoice.paid event
              invoice void / request already terminal in another way → receipt: conflict + alert, no change (money moved: reconciliation, out of scope [X])
   failed | expired | cancelled: request → that terminal state; invoice unchanged
   an event for a request already in that terminal state → receipt: ignored (idempotent)
write receipt(outcome, paymentRevision) + billing_transition rows + outbox events, commit.
```

`revision` is **recorded** in the receipt but not used to order events: Payment emits **at most one terminal event per payment** (`payment.succeeded`, `.failed`, `.cancelled` or `.expired`; its state machine makes them mutually exclusive, and a late success after a terminal state is a Payment-side conflict that emits no `payment.succeeded`), so `succeeded → failed → succeeded` and `failed → succeeded` cannot be produced by Payment. If one ever arrived it would be handled by the state checks above (a recorded `conflict`), never by inventing a payment state. The `deferred` outcome is safe because the inbox row is committed with it and the **reconciler, not a redelivery,** completes the request.

### 21.5 Recovery: dispatcher, reconciler and DLQ

* **Dispatcher** (background, in-process, database-clock driven): claims `created` and stale `sending` requests in batches (`ORDER BY createdAt LIMIT n FOR UPDATE SKIP LOCKED`), calls Payment **outside any transaction**, then records the result in a short transaction. **Per-item failure isolation**: one request that cannot be sent never blocks the ones behind it (the resolver-blocking defect in `docs/tdd/payment-phase1-acceptance-fixes.md`, problem 3).
* **Reconciler:** a `sending` request with a `deferred` receipt, and a `requested` request older than a threshold with no terminal event, are settled by `GET /payment/payments/{id}` (Payment lets a producer read only its **own** payments, so a foreign payment can never be read this way; `paidAt` is then Payment's `closedAt`, since the representation has no `succeededAt`) and applies the **same** consumption procedure with `cause = reconciliation`. This is **mandatory**, not optional: the kit sends a failed consumer to the dead-letter queue **without retry** (R-9), so a transient database error while consuming would otherwise strand the invoice.
* **DLQ handling:** a dead-lettered Payment event is an operational alert; replaying it is safe (the inbox dedupes).
* Payment's event ordering is not guaranteed; the procedure validates **state**, not order. Payment emits **one terminal event per payment**, so the only ordering that matters is between Payment's terminal event and Billing's own transitions (cancel, void), covered by the lock and the state checks.

## 22. Accounting integration

Billing emits business events; **Accounting decides the entries** (its SDD does not exist yet, and none is designed here). Billing keeps no ledger, journal, chart of accounts, debit/credit, fiscal period or tax ledger.

| Event | Semantic (what Accounting may rely on) |
|---|---|
| `invoice.created` | an obligation now exists (receivable), with lines, totals and tax snapshot |
| `payment.succeeded` (Payment's event) | **money was received**. This, not `invoice.paid`, is the cash fact |
| `invoice.paid` | the invoice is settled. **Informational for Accounting: it must not create a second journal entry for the same money** |
| `invoice.voided` | an issued obligation was annulled (only if B-015 allows it) |
| `credit_note.issued` | the obligation was reduced (only if B-016 unlocks it) |

Consumers dedupe by `eventId` through their inbox. Tax accounting, revenue recognition and reports are Accounting's. Billing's `taxAmount` is a **snapshot for presentation and accounting input**, never a tax computation (B-006).

## 23. Events [D, ADR-0037]

Events go through the transactional outbox and are published at least once to `nawara.events`; routing key = event name. Headers carry `eventId`, `occurredAt`, `correlationId`, `source` (`billing-service`) and `version` (kit `EventHeaders`). The event id is **deterministic** from `(aggregate id, event name)` (name-based version-5 uuid, as Payment does), so a retried transition cannot enqueue a second event. **Ordering is not guaranteed**; consumers use `revision` and their inbox. Payloads carry **opaque ids and plain facts, never a secret, a token, provider or payment-method data, or free text that may be personal** (descriptions and note text stay in the database).

**Common payload** (every invoice event): `invoiceId`, `invoiceNumber`, `sourceType`, `sourceId`, `organizationId`, `payer{type,id}`, `seller{type,id}`, `currency`, `subtotal`, `taxTotal`, `total`, `taxTreatment`, `status`, `revision`, `dueAt`, `issuedAt`, `actor{type,id}` (`user`, `service`, `system`), `cause{type,id}` (the request, payment event, sweep or reconciliation), and `aggregateType: "invoice"`. The correlation id is in the header; **system-initiated** events set it to the causing event id or a fresh id per job run, so **every event has one**. Amounts are JSON integers. Version `1` for all events below.

| Event | Emitted on | Extra payload | Consumers |
|---|---|---|---|
| `invoice.created` (emitted at `draft → open`, R-3) | `draft → open` | `lines[ { lineId, lineNumber, productCode, priceId, quantity, unitAmount, lineTotal, taxAmount, entitlementKind } ]` (at most 100; **no description text**; about 300 bytes per line, so at most about 30 KB, inside the kit's 64 KB payload cap) | accounting, notification, audit, analytics |
| `invoice.paid` | `open → paid` | `paymentId`, `paymentRequestId`, `paidAt` | notification, audit, analytics, accounting (informational) |
| `invoice.voided` | `open → void` (**B-015**) | `voidReasonCode` | accounting, notification, audit |
| `invoice.overdue` | sweep, once | `overdueAt` | notification, audit (**B-013** for what happens next) |
| `credit_note.issued` | credit note `issued` (**B-016**) | `creditNoteId`, `amount`, `reasonCode` | accounting, notification, audit |
| `license.*`, `subscription.*` | Stage 8 (**B-020, B-021, B-025**) | as designed then | notification, audit, analytics |

**Deliberately not emitted:** draft creation and discard, payment-request lifecycle (payment events already carry it), `invoice.due` (B-013), product and price events (no consumer; **[X]**).

## 24. Outbox and inbox [D]

* **Outbox:** every event-producing transition writes its row in the same `Queryable` as the state change (BI-12); the kit relay publishes with `FOR UPDATE SKIP LOCKED` (several instances are safe). A broker outage never blocks a business transaction.
* **Inbox:** the Payment consumer records `eventId` in the same transaction as its effect (`InboxService.handle`): a redelivered event is skipped, and a failed effect leaves no row.
* Pruning of both tables is **[X]** (Foundations section 4) and is listed as a hardening risk.
* **Atomicity is proven by a test that makes the outbox insert fail** and asserts the state change rolled back (`apps/payment-service/test/review-adversarial.e2e-spec.ts`, the two outbox-failure cases), not by inspection.

## 25. Idempotency

Two mechanisms, chosen by whether the operation has a natural key [T]. **Every Billing operation has one of them; there is no `Idempotency-Key` header (R-4).**

| Operation | Mechanism | Same request repeated | Same key, different content | Concurrent duplicate |
|---|---|---|---|---|
| Create product | natural key `(seller, code)` | `200` existing | `409 product_conflict` | one row (unique index) |
| Create price | natural key `(productId, clientReference)` | `200` existing | `409 price_conflict` | one row |
| **Create invoice** | natural key `(producer, invoiceRequestId)`, permanent | `200`, `Idempotent-Replayed: true` | `409 invoice_request_conflict` | one row; the loser returns the winner |
| **Issue** | state (`open` already) | `200`, `Idempotent-Replayed: true`, no second number, no second event | `409` if `paid`/`void` | serialized by the invoice row lock |
| Discard / archive / retire | state | `200` replay | `409` if not applicable | same |
| Void (B-015) | state and `reasonCode` | `200` replay when the reason matches | `409` when it differs | same |
| **Create payment request** | state: at most one active (BI-13) | `200` the current active request | n/a (no body) | partial unique index; the loser reads the winner |
| **Send to Payment** | Payment's natural key `(billing-service, paymentRequestId)` | `200 Idempotent-Replayed` | `409` (a defect) | Payment guarantees one payment |
| **Payment event** | `eventId` (inbox) **and** request/invoice state | no second effect | n/a | one processed |
| Cycle invoice (**[X]**) | `(recurringDefinitionId, periodStart)` | replay | — | one row |
| Credit note (**B-016**) | to be defined with the decision | — | — | — |

An "identical replay" of creation means **every field** of the request matches the stored snapshot; any difference (including `dueAt`, `description`, a line's quantity) is a different snapshot and is a conflict. A producer that must send a changed obligation uses a **new** `invoiceRequestId`. A replay does **not** re-execute the operation: no second event, no second number, no second payment request.

## 26. Concurrency

**Lock order is fixed** (a deadlock is a design defect): **`recurring_definition` → `invoice` → `payment_request` → `credit_note` → sequence rows (`invoice_number_sequence` and any credit-note counter) → `organization_license` → `user_subscription`**. Nothing locks an earlier entry after a later one. Invoice lines are immutable and need no lock. Conditional updates (`WHERE status = …`) apply every change; **the database, not application code alone,** is the referee (partial unique indexes, CHECKs, triggers).

Why this order (each edge is a real path, none is inherited from Payment):

* `recurring_definition → invoice`: the runner locks the definition, then **inserts** new invoices (new rows have no contenders). Nothing locks a definition after an invoice.
* `invoice → payment_request`: every path that touches both (create request, cancel, the consumer, the reconciler) locks the invoice first. The consumer reads the request **unlocked** only to learn its invoice id (immutable), then locks in order.
* `payment_request → credit_note`, then `→ license → subscription`: a payment success locks invoice, request, then any entitlement rows it extends; a credit note (B-016), if it ever affects entitlement, locks invoice, credit note, then the same entitlement rows. A license lapse locks the license before its subscriptions (ADR-0006).
* `invoice → sequence`: only `issue` takes a counter, after the invoice.
* **Rule for cross-table triggers:** a trigger that locks the invoice (BI-08, BI-09, BI-14, BI-17) may fire only on `INSERT` and on the transition to `paid`, and those writers already hold the invoice lock. The **dispatcher's** transitions (`created → sending → requested | rejected`, retries) **never fire such a trigger and never lock the invoice**, so a dispatcher holding a request row can never wait on an invoice held by the consumer. The dispatcher's claim (`FOR UPDATE SKIP LOCKED`) is its own short transaction and locks only the request row.
* There is no path from any later entry back to an earlier one, so no cycle exists. A **deterministic `NOWAIT` test** (as in Payment's `review-adversarial.e2e-spec.ts`, the lock-order case) must prove the `invoice → payment_request` edge, and a mixed-race storm must show no `40P01`.

| Scenario | Mechanism | Deterministic result |
|---|---|---|
| Two invoice creations, same `(producer, invoiceRequestId)` | unique index; loser catches `23505` in a savepoint and returns the winner | one row |
| Two `issue` requests | invoice row lock; second sees `open` | one number, one `invoice.created`; the second is a replay |
| Many issues for one seller | the seller's counter row locked in the issue transaction (after the invoice) | distinct, consecutive numbers (BI-10) |
| Payment event vs void | invoice locked first; void requires no active request, so a `requested` request blocks the void | either the void is refused, or (a `cancelled` request) the event is a no-op |
| Payment event vs manual cancel of the request | same lock; the terminal state that arrives first wins; the other is a recorded no-op or conflict | one terminal state |
| Duplicate payment events | inbox; a second delivery is skipped | one effect |
| Payment event vs reconciler | both use the consumption procedure under the invoice lock | one effect |
| Two payment-request creations | partial unique index (BI-13) | one active request |
| Dispatcher instances | `FOR UPDATE SKIP LOCKED` claim; the natural key makes a duplicate send harmless | one Payment payment |
| Recurring job vs manual cancellation (**[X]**) | definition row locked first by both | serialized |
| Credit note vs payment (**B-016**) | invoice locked first; the cap trigger sums under the lock | never above `total` |

Lessons from Payment's acceptance review that are **requirements here**: a domain conflict (a duplicate or late event) must be a **recorded conflict, not a database error surfacing as `500`** (a 500 makes the broker or provider retry forever); every background job **isolates per-item failures**, is batched and ordered; **T2-style updates are conditional**; "the row is locked in the same order everywhere" is proven by a **deterministic `NOWAIT` test**, not asserted.

## 27. Failure and recovery

| Failure | Handling |
|---|---|
| Database unavailable | `/ready` fails; requests fail; nothing is half-applied (single transactions) |
| Payment unavailable or slow | the payment request is **already committed**; the dispatcher retries the identical request with backoff; the API answers immediately; nothing waits on Payment inside a transaction |
| Timeout during the call to Payment | the request stays `sending`; the next attempt is a byte-identical replay (safe) |
| Crash after Payment accepted, before Billing stored `paymentId` | `sending` is retried; Payment answers `200 Idempotent-Replayed` and Billing records `paymentId`; an event that arrives first is `deferred` (21.4) and the reconciler completes it |
| Duplicate payment event | inbox; no second effect |
| Delayed or out-of-order event | state and snapshot are validated, not order; a terminal event for a request already terminal is ignored |
| Payment event lost or dead-lettered | the reconciler settles the request from `GET /payment/payments/{id}` |
| Broker unavailable | the outbox keeps events; business transactions are unaffected |
| Billing crash mid-consumption | one transaction: the inbox row and the effect commit together or not at all |
| Recurring job crash (**[X]**) | natural key per period makes the re-run safe |
| Invoice creation / issue retry | natural key / state idempotency |
| Stuck records | alerts (section 30): `sending` older than a threshold, `requested` older than a threshold, dead-lettered events, `conflict` receipts and `deferred` receipts not settled, unpublished outbox age |
| Auth unavailable | user operations fail closed with `503`; service-token operations and event consumption continue |
| Payment amount or snapshot differs from the request | not applied; recorded `conflict`, alert |

**No financial operation depends on in-memory state.** Timers only *trigger* work; every decision reads durable rows.

## 28. Database design [T]

* **Own database and roles:** `billing` database; `billing_migrator` owns the schema and is used **only** by the explicit migration step; `billing_app` runs the service with DML only (default privileges in `infra/postgres/init`). No superuser at runtime. Nothing migrates at startup; `/ready` fails while a migration is pending.
* **Migrations:** the kit's `kit_0001` (outbox, inbox), `kit_0002` (rate limit), `kit_0003` (generic triggers), then `apps/billing-service/db/migrations/` in the order: `0001_currency`, `0002_product_price`, `0003_invoice`, `0004_invoice_line`, `0005_invoice_number_sequence`, `0006_payment_request`, `0007_payment_event_receipt`, `0008_billing_transition`, then triggers/constraints in the same file as their table so a table never exists without its guard. Credit-note and entitlement tables are separate later migrations (gated).
* **Conventions carried from Payment:** camelCase quoted columns, `timestamptz` from the database clock, uuid ids generated by the service, `revision`/`updatedAt` by trigger from the first migration, `forbid_column_change` for immutability, kit-level generic triggers only (no business logic in the kit).
* **No cross-service foreign keys or queries.** Foreign keys exist only **inside** this database. `paymentId`, `payer*`, `seller*`, `organizationId`, `sourceType/sourceId` are opaque.
* **Least privilege check:** a test runs the whole flow as a **non-owner DML-only role** and asserts DDL, `DISABLE TRIGGER`, `TRUNCATE` and function replacement are refused (Payment's `runtime-role.e2e-spec.ts` is the model). `payment_app`-style default privileges also grant `DELETE`: append-only tables (`billing_transition`, `payment_event_receipt`, `outbox`) additionally get a **trigger refusing DELETE and content UPDATE**.
* **Indexes:** `invoice (producer, invoiceRequestId)` unique; `invoice (sellerType, sellerId, number)` unique where not null; `invoice (payerType, payerId, createdAt DESC)`; `invoice (organizationId)`; `invoice (status, dueAt)` partial where `status = 'open' AND overdueAt IS NULL` (the sweep); `payment_request (invoiceId)` unique for active statuses; `payment_request (status, createdAt)` partial for `created`/`sending`; `payment_request (paymentId)` unique where not null; `product (sellerType, sellerId, code)` unique; `price (productId, clientReference)` unique.

## 29. Security

| Threat | Protection |
|---|---|
| Cross-organization access / IDOR (guess an invoice id) | authorization by **relation to the resource**; collapsed `404` with the same message as "missing"; ids are uuids; tested with an unrelated user, another producer, an inactive identity |
| Forged `organizationId`, `payerId`, seller | never trusted as authority; organization is asserted only by an authorized **producer** (B-029) and copied to the invoice; a user's request derives everything from the invoice |
| Forged amount, currency, total, tax, status | **no such input fields**; unknown fields are `400`; amounts come from catalog prices, totals are computed |
| Forged price id | price must exist, be effective, unretired, product active, currency consistent (`422 price_not_available`); a price of another seller is refused (scopes **B-029, B-031**) |
| Forged invoice / payment-request id | relation check; a request id is never accepted from a client |
| Mass assignment | whitelist DTOs (`forbidNonWhitelisted`), no generic update route |
| Replay / duplicate requests | natural keys and state idempotency (section 25); the same key with different content is a conflict |
| Event replay / forged event | inbox by `eventId`; source header, `paymentId` and full snapshot check (R-6); **a `paymentId` is never bound from an event**; a mismatch is a recorded conflict, never applied |
| Service token theft | digest-only storage, constant-time compare, two tokens per caller for rotation, one token per pair, never logged |
| Sensitive logging | no service token, bearer, payment payload, description, or raw event body is ever logged; ids and codes only (kit redaction) |
| Secret handling | `NAME_FILE`/environment, never a table or event |
| Rate limiting | the kit's DB-backed limiter on **authenticated** keys only: invoice creation (per producer), payment-request creation (per payer). An **unauthenticated** route must never write limiter rows (Payment's README records this for its webhook route); Billing has none. The event consumer is not rate limited (the broker controls flow) |
| Error disclosure | sanitized bodies; no SQL, constraint or payload |
| Over-broad DB privileges | append-only triggers on history tables; a runtime-role test |
| Cross-service impersonation by a producer | R-6 mitigations; recommended `producer` in Payment events |
| Personal data in events | no free text in events (B-032) |

## 30. Observability

The kit provides structured logs with request and correlation ids and redaction, `/health` and `/ready`; it provides **no metrics facility** (Payment lists the same gap in its README, "Known limitations"). Required signals (implementation is Stage 9, and the metrics mechanism itself is a prerequisite decision): counters of invoices by status; payment requests by status; **payment events by receipt outcome** (`applied`, `ignored`, `conflict`, `deferred`); dispatcher sends, retries and `rejected`; reconciler settlements; outbox lag and unpublished age; DLQ depth; overdue sweep lag; rate-limit rejections. **Alerts:** any `conflict` or `rejected`, and a `deferred` receipt not settled within a threshold; a request `sending` or `requested` longer than a threshold; a dead-lettered event; outbox age. Until a metrics mechanism exists these are structured log lines with stable names, not silent.

## 31. Testing strategy

Unit, database, integration, concurrency and security tests against a **real PostgreSQL**; every row below must exist before the feature is considered done (section 34.3). Every test must fail on the defect it is named for **before** the fix (Payment's acceptance lesson: 16 of 24 first adversarial tests failed).

| Area | Cases |
|---|---|
| **Unit** | money arithmetic at 0, 1 and the cap, overflow refused; line and invoice totals; TND three-decimal handling; the transition table; DTO validation (unknown fields, `1.5`, `"100"`, `1e21`); the pure Payment-request mapping (13.2), including that it is deterministic; authorization relations; natural-key replay comparison |
| **Database** (SQL, each assertion targets **one** constraint) | every BI row; immutability of price, line, header totals, payment-request snapshot; composite currency FK; deferred totals trigger (disagreeing header, missing line, extra line, zero lines); one active request; one paid request; number uniqueness and set-once; state-transition matrix; append-only tables; a NULL `organizationId` for an organization seller refused; cap at 2^53 − 1 |
| **Agreement** | the TypeScript state tables and the database triggers agree on **every** `(from, to)` pair (`apps/payment-service/test/review-matrix.e2e-spec.ts`, the transition-matrix cases) |
| **Integration** | create → issue → payment request → (Payment test provider) → `payment.succeeded` → invoice paid; against Payment on `main` with its test provider and a producer fixture; catalog immutability (change a price, old invoice identical); replay of create and issue; `payment.failed`/`expired`/`cancelled` followed by a new request; duplicate event; **event before Billing's own commit is impossible** (persist before call); out-of-order event; conflicting snapshot event; reconciler settles a stranded request; broker outage and DLQ; **outbox failure rolls back state** (BI-12) |
| **Concurrency** | duplicate invoice creation; concurrent issue (one number); N issues, N consecutive numbers; payment event vs void; duplicate payment events; event vs reconciler; two dispatchers; two payment-request creations; a deterministic lock-order `NOWAIT` proof; a mixed storm over several invoices with no `5xx` and no deadlock |
| **Security** | cross-organization read/list; unrelated user, other producer, inactive identity; forged organization, payer, amount, currency, price, invoice and request ids; mass assignment; replay; a user bearer as a service token and the reverse; service token never sent to Auth; no secret or payload in logs/responses; oversized and unknown-field bodies; rate limit per authenticated key and **none** on unauthenticated routes |
| **Runtime role** | the whole flow as a non-owner DML-only role; DDL, `DISABLE TRIGGER`, `TRUNCATE` refused |
| **Contract** | Billing's status route against Auth's client parsing (Stage 8); Billing's payment-request body against Payment's DTO validation |
| **Test hygiene** | scratch databases are dropped; no test depends on order or on shared limiter buckets; timing tests are repeated (Payment ran its e2e suite four times) |

## 32. Business decision register

Nothing below is decided or invented. Every entry is `[B]` (B-033 and B-034 stay `[X]` until decided). "Blocked?" refers to **the parts of the service not touched by the decision**, which proceed. Payment's own `O-` decisions are referenced where a Billing decision depends on them.

**Resolving ADRs to be written (pointers, none written here):** B-001, B-002, B-003, B-004, B-006, B-007 to an ADR on the legal issuer, numbering and tax; B-005 to the currencies decision (with Payment O-10); B-008 to B-014 and B-018 to B-024 to an ADR on payment terms, failed-payment, dunning and recurring policy; B-015 to B-017 to an ADR on voiding, credit notes and refunds; B-020, B-021, B-025 to an ADR that re-expresses ADR-0006/0008 on the billing model (or retires them); B-026 to B-031 to the payment- and billing-domain authorization ADR (shared with Payment O-4, O-5, O-6, O-13, O-14, O-15, O-18, O-20); B-032 to a retention decision (with Payment O-17); B-035 to an Auth-and-billing ADR (Payment O-12).

| ID | Question | Why it matters | Affected (entities · APIs · events · services) | Implementation blocked? |
|---|---|---|---|---|
| B-001 | Who is the **legal issuer** of Nawara's invoices; is Nawara represented by a `company` row (the platform-owning company) or another party type? | issuer identity, legal/tax fields, numbering scope, Accounting | `invoice.seller` · 7, 10 · `invoice.created` · billing, accounting, auth (Company) | Issuing **to real customers** and any Nawara-as-seller flow. Test producer fixtures proceed |
| B-002 | May **organizations issue invoices through Nawara**, and whose legal and tax identity appears? (fin-arch 10.3) | validity of seller = organization in production | seller, `organizationId` · 7, 10 · events · accounting | issuing **to real customers** with an organization seller; the seller relation for organization members (19.3) |
| B-003 | **Organization vs user billing:** which parties may be payers of what; how a `company` acts | who owes, who may pay | `payer` · 7, 13 · events | organization/company payer flows (also Payment O-18); user payer proceeds |
| B-004 | **Invoice numbering:** scope (seller, legal entity, platform), format, series, reset, gapless requirement | legal validity, uniqueness | `invoice.number`, `invoice_number_sequence` · 10 | the **format**; the counter mechanism and the provisional uniqueness proceed but are not for real customers |
| B-005 | **Supported currencies** beyond the first; the seed of the currency table (Payment O-10) | validation, exponent, Payment support | `currency`, `price`, `invoice` · 4, 7 | adding a currency; config default is **not** chosen here |
| B-006 | **Tax:** who is responsible; who computes (Billing from configuration, Accounting, the producer); inclusive vs exclusive; rounding; exemptions | totals, `taxAmount`, legal validity | `invoice_line.taxAmount`, `taxTotal`, `taxTreatment` · 7 · `invoice.created` · accounting | any nonzero tax; issuing to real customers |
| B-007 | **Legal invoice requirements:** mandatory content, language, retention | legality of issuing | `invoice` fields, presentation · events | issuing to real customers |
| B-008 | **Payment terms and due dates:** default terms, whether Billing computes `dueAt`, whether null is allowed | overdue, dunning | `invoice.dueAt` · 7 · `invoice.overdue` | terms computation; explicit `dueAt` proceeds |
| B-009 | **Payment-request lifetime**, and whether a request is created automatically at issue (Payment O-16) | stuck open payments, UX | `payment_request.expiresAt` · 13 | any default lifetime; auto-creation is **[X]** |
| B-010 | **Partial payments** (Payment O-7): allowed, minimum, allocation; `partially_paid` | BI-08, BI-09, state machine, Payment schema | `payment_request.amount`, invoice states · 13 | partial amounts; full-payment v1 proceeds |
| B-011 | **Overpayments / credit balance model** | BI-08 (`amountDue >= 0`) | invoice, credit · events | any negative or credit balance |
| B-012 | **Failed-payment behaviour and retry limits** (Payment O-19): how many new requests, what a failure does to the invoice | dunning, state | `payment_request`, invoice · 13 | limits and automatic retry; manual new request proceeds |
| B-013 | **Dunning and overdue actions**; whether `invoice.due` exists | reminders, escalation, suspension | `invoice.overdue` consumers · events · notification | anything beyond emitting `invoice.overdue` |
| B-014 | **Uncollectible / write-off:** whether, when, by whom, accounting effect | state, accounting | invoice state · events | the `uncollectible` state |
| B-015 | **Voiding an issued invoice vs crediting it;** who may void; conditions | legality, accounting, payment in flight | `open → void` · 12 · `invoice.voided` | endpoint 12; draft discard proceeds |
| B-016 | **Credit notes:** authority to issue, full/partial, numbering, effect on paid and unpaid invoices, relation to refunds | `amountDue`, accounting | `credit_note` · 16 · `credit_note.issued` | the whole feature |
| B-017 | **Refund vs credit note vs invoice/entitlement effect of `refund.succeeded`** | what Billing does when Payment returns money | `refund.*` consumption · invoice · entitlement | consuming `refund.*` |
| B-018 | **Does recurring billing exist,** and its model: interval anchor, renewal date, automatic renewal | a whole subsystem | `recurring_definition` · events | Stage 7 (not planned) |
| B-019 | **Trials** (fin-arch 10.11) | entitlement start | entitlement · events | trial behaviour |
| B-020 | **Grace periods** on the new model (re-expressing ADR-0008; R-8) | when access lapses | `organization_license` · `license.grace_issued` | grace behaviour |
| B-021 | **Reservation / suspension** of user subscriptions on license lapse (re-expressing ADR-0006; R-8) | paid time preserved or lost | `user_subscription` · `subscription.suspended/resumed` | reservation behaviour |
| B-022 | **Cancellation rules** (immediate vs at period end; refund) | access and money | subscription, invoice | cancellation behaviour |
| B-023 | **Proration, upgrades and downgrades** | amounts | invoice lines | any proration |
| B-024 | **Pause and resume** | access | entitlement | pause/resume |
| B-025 | **Entitlement expiry and stacking:** how much time a payment buys; renewals extend from old expiry or from payment date; what "valid" means at the boundary | correctness of `{ valid, expiresAt }` | entitlement · 17, 18 · `license.*` | activation and extension logic; structure and read API proceed |
| B-026 | **Who may pay on behalf of an organization** (Payment O-18) | collection for organization payers | 13 · `payer` | organization-payer collection |
| B-027 | **Read access beyond producer and user payer:** organization members, seller staff (Payment O-20) | privacy | 8, 9, 14 | any organization-facing read |
| B-028 | **Write authority via a user bearer:** who may create, issue, void, credit; whether any Auth capability counts | who can create financial obligations | 7, 10, 12, 16 (endpoint 13 is **not** included: a `user` payer requesting collection of their own invoice is the `payer` relation, [T]) | every user-bearer write except endpoint 13; producer writes proceed |
| B-029 | **Producer token scopes:** which services may create products, prices and invoices for which sellers and organizations (Payment O-13, O-14, O-15) | who can cause obligations to exist | 1, 4, 7 | production use by a non-test producer |
| B-030 | **Price authority:** may a trusted producer assert an ad hoc line amount, or only catalog prices count | forged/inflated amounts | `invoice_line.priceId`, 7 | ad hoc lines (not built) |
| B-031 | **Catalog governance:** who defines products and prices; per-seller or platform-wide; read access to the catalog | catalog trust | 1 to 6 | production catalog writes |
| B-032 | **Personal data and retention:** which invoice data is personal, retention periods, deletion (Payment O-17) | privacy, law | descriptions, notes, events, history | retention/pruning and free-text fields |
| B-033 | **Discounts, coupons, promotions, adjustments** | BI-05 currently has none | invoice lines, totals | **[X]**; BI-05 changes with the decision |
| B-034 | **Fractional and usage-based quantities and pricing** | integer quantities, `flat` only | price, line | **[X]** |
| B-035 | **Does Auth keep a synchronous entitlement check** at registration/join (fin-arch 10.8; Payment O-12) | Auth ⇄ Billing coupling | 17 · Auth client | the Auth PR (16.4); Billing's route proceeds |

### 32.1 Which stage each decision blocks

A stage is blocked **only in the named part**; everything else in it proceeds.

| Decision | Blocks (stage: part) |
|---|---|
| B-001, B-002, B-007 | 3: issuing to real customers (`issue` with a real seller); 8: nothing |
| B-003 | 4 and 6: payment requests and reads for organization or company payers |
| B-004 | 3: the number **format** and real-customer issuing (counter and uniqueness proceed) |
| B-005 | 2 and 3: adding any currency (the currency table seed is config) |
| B-006 | 3: any nonzero tax and real-customer issuing |
| B-008 | 3: computing `dueAt` from terms (explicit `dueAt` proceeds); 5: overdue actions |
| B-009 | 4: any request `expiresAt` default and automatic request creation |
| B-010, B-011 | 4: partial amounts, credit balance, `partially_paid` |
| B-012 | 4: retry limits and automatic re-requests |
| B-013 | 5: everything beyond emitting `invoice.overdue`; `invoice.due` |
| B-014 | 3: the `uncollectible` state |
| B-015 | 7: void (endpoint 12); draft discard proceeds |
| B-016, B-017 | 7: credit notes; consuming `refund.*` |
| B-018 to B-024 | 7: recurring billing, trials, grace, reservation, cancellation, proration, pause (not planned) |
| B-020, B-021, B-025 | 8: entitlement activation, extension, grace, reservation (structure and read API proceed) |
| B-026 | 4 and 6: organization-payer collection |
| B-027 | 6: organization-facing reads and lists |
| B-028 | 3, 6: user-bearer writes except endpoint 13 |
| B-029, B-031 | 3 and 4 in production: any non-test producer, catalog writes |
| B-030 | 3: ad hoc lines |
| B-032 | 9: retention, pruning, free-text fields |
| B-033, B-034 | 3: any adjustment, discount, fractional or usage pricing (`[X]`) |
| B-035 | 8: the Auth client PR |

## 33. Deferred [X]

Recurring billing runner, subscriptions and dunning (until B-018, B-013); trials; proration; usage-based, tiered and volume pricing; discounts, coupons, promotions and adjustments; fractional quantities; ad hoc (producer-priced) lines; automatic payment-request creation at issue; invoice rendering, PDF, numbering templates, localization and delivery; a tax engine; bundles; multi-currency conversion; write-off (`uncollectible`); administrative or support tooling; product and price edits and their events; consumer retry policy beyond the dead-letter queue; caching of Auth answers; outbox, inbox and history pruning; periodic reconciliation beyond the stuck-request poll; reporting; any Accounting, Organization Service, settlement, payout, wallet, custody, fee, merchant-of-record, cash or gateway behaviour; any product-specific logic.

## 34. Implementation plan, readiness gate and acceptance criteria

### 34.1 Stages

Only justified stages are listed. Each stage ends with its tests green **including the runtime-role and agreement tests**, and enters only when its gate (34.3) holds. **No `[B]` item is pulled in by any stage.**

| Stage | Content | Depends on |
|---|---|---|
| **0 Prerequisites and dependencies** | **Not blockers for Stage 1.** (a) the combined service-token-or-user guard and the deterministic event id: **implemented locally in Billing** by default [T]; extracting them into the kit is an optional separate change (R-9); (b) cursor pagination (`{ items, nextCursor }`, ADR-0034): **service-local** by default [T], because the kit has none; (c) the `billing` CI matrix entry is a **Stage 1 deliverable**, not a prerequisite; (d) **Payment follow-ups** (separate Payment work, not done here): a `producer` field in payment events (R-6, hardens Stage 4 but is not required for it, because of the `deferred` rule in 21.4) and Payment's **cancel route** (required before payment requests are enabled outside the test fixture, 34.3) | none |
| **1 Foundation** | convert to a kit-based service **with no domain** (this stage also adds the CI entry, the local guard, the local event-id helper and the local pagination helper): `loadBaseConfig`, `HealthModule`, `DbModule` on the `billing` database with the runtime role, `ServiceAuthModule`, `AuthClientModule`, `EventsModule` (in-memory bus for tests, RabbitMQ by configuration), `RateLimitModule`, OpenAPI with the basic-auth guard, Dockerfile, `.env.example`, README, migrations wired to the kit's, tests for configuration, health vs readiness, the service-token guard, the runtime role. **No table, endpoint or domain type from this SDD is created.** | none |
| **2 Schema and invariants** | migrations `0001` to `0008` with every trigger and CHECK of section 8; the SQL invariant suite (one constraint per assertion); the TypeScript-vs-trigger agreement test; concurrency races in SQL (issue numbers, one active request) | Stage 1 |
| **3 Catalog and invoices** | products, prices, create/get/list/issue/discard invoices, natural-key idempotency, totals computed server-side, events (`invoice.created`) through the outbox, with the **test producer fixture**; authorization for producer only | Stage 2 |
| **4 Payment integration** | `payment_request`, the dispatcher, the Payment client (a port with a test double and an integration run against Payment `main` with its test provider), the event consumer with inbox and receipts, the reconciler, `invoice.paid` | Stage 3; Payment on `main`; production needs Payment O-13, O-14, O-15 |
| **5 Events and sweep** | completes the event catalog: `invoice.overdue` sweep, DLQ handling and alerts, correlation ids for system events; outbox-atomicity failure-injection tests | Stage 4 |
| **6 Authorization and isolation** | user-bearer read and list (payer only), the collapsed `404`, the isolation and IDOR test set, payment-request creation by the payer; **organization relations remain blocked** | Stage 4; B-026, B-027, B-028 for the rest |
| **7 Recurring billing, credit notes, void** | **not planned.** Each unlocks only when B-018/B-013, B-016/B-017, B-015 are decided, with its own TDD | the owner |
| **8 Entitlement** | the structure of 16.2 and the read-only status routes (`{ valid, expiresAt }`), with the compatibility contract test for Auth; activation/extension/grace/reservation **only after B-020, B-021, B-025**; the Auth client PR is separate (16.4) | Stage 4; B-020, B-021, B-025, B-035 |
| **9 Hardening** | observability (a metrics mechanism, alerts of section 30), load and concurrency soak, a security review of the consumer and authorization, pruning policy (B-032), CI and least-privilege verification (`infra/postgres/verify.sh`), production readiness review | Stages 1 to 6 |

Each feature is planned in its own TDD (`docs/tdd/`) before code, as for Payment.

### 34.2 Reality check

Today: the kit provides configuration, request and correlation ids, the error filter with a `code` field, health and readiness, the service-token guard, the Auth client, database access, the migration runner, outbox, inbox and the RabbitMQ bus, a fixed-window rate limiter, and generic immutability triggers. Payment on `main` (Phase 1: create, get, start and sync an attempt, webhooks, resolver, expiry sweeper, events, test provider only) is the integration target. **Everything in this SDD is designed, not built.**

### 34.3 Implementation readiness gate

Per feature, not for the document as a whole: a feature enters implementation only when, for **that** feature:

1. every `[D]` and `[T]` prerequisite it needs is satisfied (Stage 0 items are local by default and do not block);
2. no unresolved `[B]` decision is required by the code being written; if one is, only the independent portion proceeds and the rest stays blocked or isolated;
3. no `[X]` functionality is implemented as a side effect;
4. every invariant of section 8 that applies has its database mechanism **and** its test row of section 31;
5. its authorization boundary (19.4) is not `[B]` for the operations built;
6. its idempotency (section 25) and concurrency (section 26) behaviour is covered by tests;
7. its Payment integration (success, timeout, conflict, duplicate, out-of-order) is covered where it touches Payment;
8. its outbox behaviour is covered by a **failure-injection** test where it emits an event.

**Blocked under this gate until the named decision is recorded as `[D]` or the named dependency exists:** **payment requests outside the test fixture until Payment ships its cancel route** (a request Payment cannot complete or cancel would be unclosable, R-7; 13.1); issuing invoices to real customers (B-001, B-002, B-004, B-006, B-007); any organization-payer collection (B-003, B-026); production use by any non-test producer (B-029); user-bearer writes **other than a payer creating their own payment request** (B-028); void (B-015); credit notes (B-016); recurring billing (B-018); entitlement activation, grace and reservation (B-020, B-021, B-025); payment lifetime, retries and dunning (B-009, B-012, B-013). **Independent and not blocked:** Stage 1; the schema and state machines with the provisional numbering counter; catalog and invoice creation, issue and discard with the test producer; the Payment integration for **user payers** through Payment's test provider; the read-only entitlement status shape.

### 34.4 Acceptance criteria

**Stage 1 (foundation, no domain) may begin when criteria 1 to 9 hold**, which this document makes true. Criteria 10 to 12 gate *later* stages and are recorded so they are not forgotten:

| # | Criterion | State |
|---|---|---|
| 1 | All `[D]`/`[T]` requirements are technically specified | met (sections 6 to 31) |
| 2 | No `[B]` decision has been silently resolved | met: 35 open decisions, each with a marker; database restrictions tied to a `[B]` decision are labelled **TEMPORARY RESTRICTION** (0.1); fallbacks are labelled PROPOSED — NOT APPROVED |
| 3 | No `[X]` feature is included | met (section 33) |
| 4 | Every financial invariant has an enforcement strategy | met (section 8: DB, app, test) |
| 5 | Every state transition is defined | met (section 17) |
| 6 | The Payment integration contract is explicit and matches Payment on `main` | met (sections 13, 21; reviewed against the code) |
| 7 | The Accounting boundary is explicit | met (section 22) |
| 8 | Authorization, idempotency, concurrency, failure and recovery, and tests are explicit | met (sections 19, 25, 26, 27, 31) |
| 9 | Cross-service database access is prohibited | met (sections 4, 28; `check:repo` also blocks source imports) |
| 10 | Payment's cancel route exists before payment requests are enabled outside the test fixture | open (Payment work); gates Stage 4 in production |
| 11 | ADR-0006/0008 vs `financial-architecture.md` 10.7 is ruled on (R-8) | open (owner); gates Stage 8 only |
| 12 | The `[B]` decisions of a feature are recorded as `[D]` (section 32.1) | open per feature; gates that feature only |

## 35. Open questions for the owner (not `[B]` business decisions)

1. **Optional:** rename `invoice.created` (emitted at `draft → open`) to something clearer such as `invoice.issued`. This SDD keeps the documented name (R-3); a rename changes `core-architecture.md` and every consumer.
2. Say whether ADR-0006/0008 (Accepted) or `financial-architecture.md` section 10.7 (open) governs grace and reservation (R-8). Gates Stage 8 only.
3. Optional: extract the combined guard and the deterministic id into the kit (R-9). Billing copies them locally otherwise.
4. Ask for the additive Payment changes as separate Payment work: the cancel route (needed before production payment requests) and a `producer` field in events (R-6, R-7).
5. Confirm the production value of Auth's `PAYMENT_SERVICE_URL` (R-5, 16.4).
