# payment-service

- **Status:** Draft, **for review**. Phase 1 (the gateway-settlement path with the test provider, the webhook pipeline and the financial-invariant schema) is implemented in `apps/payment-service`; cash, refunds and everything `[B]`/`[X]` below are not. See `docs/tdd/payment-*.md` and `apps/payment-service/README.md` for what exists.
- **Owners:** Anwar (project owner)
- **Related ADD:** [core-architecture.md](../architecture/core-architecture.md), [financial-architecture.md](../architecture/financial-architecture.md)
  (root architecture documents). The old `docs/add/payment-service.md` is superseded in its financial parts.
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
  ADR-0007 is **amended** for this service (its cash actor model changes) and ADR-0021 is superseded in part by ADR-0033 (the forwarded admin JWT).

This document **replaces** the earlier payment SDD (superseded on 2026-09-19). The old text, including the sections earlier ADRs cite (for example the license-status contract of ADR-0004), is preserved in git history: `git show 126a52b:docs/sdd/payment-service.md`. It is the design contract
for the implementation phase. It defines what can be defined and marks what cannot be decided from the repository.

## 0. How to read this document

Every design point carries one marker:

| Marker | Meaning |
|---|---|
| **[D]** | **Decided**: fixed by a decision of the project owner (decisions D1 to D4 and E1 to E4, accepted on 2026-09-19) or by the ADR that records it. ADRs 0031 to 0038 are still marked *Proposed* until merged into an accepted state, so "decided" here rests on the owner's acceptance. Do not change without a new decision. |
| **[T]** | **Technically defined here**: a design detail derived from decided principles. It carries no business meaning and can be revised in this SDD. |
| **[B]** | **Business or legal decision required**: not decided, not invented. The document states what depends on it. |
| **[X]** | **Deferred**: consciously not part of this phase. |

### 0.1 Business-decision guardrail

The markers above are an implementation contract, not just a reading aid, for whoever builds this service, human or agent:

* **[D] Decided.** Implementation may proceed.
* **[T] Technically defined here.** Implementation may proceed, subject to any `[B]` gate it explicitly references.
* **[B] Business or legal decision required — not approved for implementation.** A `[B]` item may state a proposed behaviour, a
  default, an example, a possible option or a recommendation; none of these is approval. An implementation agent must **not**:
  select a `[B]` option itself, or infer approval from existing code, tests, fixtures, API examples, comments, implementation
  convenience, the absence of a decision, or an apparently obvious default. If a requested feature depends on an unresolved `[B]`
  decision, that part of the work is **blocked**; only the independent part may proceed.
* **[X] Deferred.** Do not implement unless a later, explicit decision activates it.

### 0.2 Implementation gate

```
[B] = do not decide                          [D] = approved, implement
[T] = technically defined, implement          [X] = deferred, do not implement
```

No implementation agent may turn an unresolved `[B]` decision into an authorization rule, financial rule, API behaviour, database
constraint, workflow, event contract or user-facing behaviour. When work reaches a `[B]` boundary, the agent must: (1) identify the
unresolved decision (by its `O-` number, section 19); (2) identify exactly which part of the requested work depends on it; (3)
implement only the independent part; (4) leave the business-dependent part blocked or explicitly isolated; (5) report which decision
is required. The agent must not choose the business outcome.

Reality check: payment-service today is a starter. The service-kit (`libs/service-kit`) provides configuration, request/correlation ids,
logging, the error filter, `/health` and `/ready`, the service-token guard, the Auth client, database access, the migration runner,
and the outbox/inbox with a RabbitMQ bus. **Everything in this SDD beyond those foundations is designed, not built.**

## 1. Responsibility

**payment-service answers: how was an obligation paid, by which method, and what is the payment state?** [D, ADR-0035]

It owns: `Payment`, `PaymentAttempt`, `CashPayment`, `Refund`, `RefundAttempt`, `WebhookEvent`, `IdempotencyKey`, and its own
`outbox` and `inbox`; the provider abstraction and the test provider; payment-domain authorization; reconciliation of payment state
with providers.

It explicitly does **not** own, and must never become: an invoice or billing service (what is owed), the accounting ledger, a tax
engine, a wallet or custody model, a subscription or entitlement service, or a copy of identity, membership or organization records.

| Concern | Owner |
|---|---|
| What is owed, why, how much, when due; entitlements | billing-service |
| How money moved; payment and refund state | **payment-service** |
| Accounting effect, ledger, tax | accounting-service |
| Identity, sessions, membership | auth-service |
| Delivery of notifications | notification-service |
| Business meaning of `sourceType`/`sourceId` | the producing product service |

## 2. Context

```
 Product service ──"a customer owes X for sourceType/sourceId"──> billing-service
                                                                     │  POST /payment/payments   (service token, payment-request snapshot)
                                                                     ▼
 end user (payer) ── user bearer ──> payment-service ── verify identity and membership ──> auth-service (live)
                                          │  │
                                          │  └── provider port ──> gateway adapter (test provider first)   ◄── provider webhook (signed)
                                          ▼
                                    outbox ──> RabbitMQ (nawara.events) ──> billing (invoice paid), accounting (journal), notification, audit
```

* payment-service **never calls billing**; billing learns outcomes from events, and may cancel a payment through the API [D, ADR-0035].
* payment-service **never verifies a user token itself** and never forwards one; the user's bearer goes to Auth only [D, ADR-0033].
* Nothing in payment-service reads another service's database or holds a foreign key into one [D].

## 3. The payment request contract

A **payment request** is the message by which an authorized producer (billing, in the architecture) asks payment-service to collect
one obligation. **Billing owns the request's own lifecycle** (open, paid, cancelled: billing's SDD); **payment-service owns the
resulting `Payment`.** Accepting the request *creates* the payment, and the payment's status is the request's status as seen by
payment-service [T].

### 3.1 Contract (request body of `POST /payment/payments`)

| Field | Type and rule | Class | Notes |
|---|---|---|---|
| `paymentRequestId` | uuid, producer-generated | **authoritative** | Identity of the request and the natural idempotency key (with the calling service) [T] |
| `sourceType` | string `^[a-z][a-z0-9_]{1,62}$` | authoritative (opaque) | The producer's vocabulary, for example `invoice`. Payment never interprets it [D, ADR-0036] |
| `sourceId` | string, 1 to 128 characters | authoritative (opaque) | Id in the producer's system; no foreign key, no lookup [D] |
| `payer` | `{ type, id }`, type in `user`, `organization`, `company` | **authoritative** | Who pays [D, ADR-0036] |
| `seller` | `{ type, id }`, same types; must differ from `payer` | **authoritative** | Who is paid (merchant / issuer) [D] |
| `organizationId` | uuid or null | **authoritative** | The organization context: the isolation boundary for access control, carried in events. If `seller.type` is `organization` it must equal `seller.id` [T] |
| `amount` | integer minor units, 1 to 9007199254740991 | **authoritative** | JSON number; validated as a safe integer; stored as `bigint` [D, ADR-0036] |
| `currency` | ISO 4217, upper case | **authoritative** | Must exist in the `currency` reference table of payment's database (section 4.8) and in the configured supported list [T]; the exponent comes from that table, never from code [D] |
| `expiresAt` | absolute timestamp with offset, or null | authoritative | Drives expiry. A null value, and any default or maximum lifetime, is a policy question **[B, O-16]**; until decided, a payment without `expiresAt` has no expiry as a **PROPOSED — NOT APPROVED fallback**, and is watched by the stuck-payment alert (section 12) |
| `description` | string, at most 140 characters | **descriptive** | Statement and display text only. Never used in a decision [T] |
| `reference` | string, at most 64 characters | descriptive | For example an invoice number. Never used in a decision [T] |

Not in the contract in this phase: line items, tax, fees, price rules, return URLs, allowed payment methods, customer contact data,
and any product-specific field [X]. Method availability per seller is decided by payment configuration and providers, not by the request.

### 3.2 Snapshot semantics [D]

At acceptance the fields above are **copied into the `payment` row and are immutable** (database trigger). Later changes at the
producer (an invoice voided, a price changed) do **not** alter an accepted payment; the producer must call `cancel` if it wants
collection to stop. Payment never re-fetches, refreshes or validates the snapshot against the producer, so it cannot be affected by
mutable billing data and never needs a synchronous call to billing during the payment lifecycle.

### 3.3 Request status and idempotency [T]

* Status = the payment's status (section 5.1). There is no second request table.
* **Natural idempotency key:** `(calling service, paymentRequestId)` is unique and permanent. The same request repeated with an identical
  snapshot returns the existing payment (`200`, header `Idempotent-Replayed: true`); the same id with a different snapshot is refused
  (`409 payment_request_conflict`). No `Idempotency-Key` header is needed for creation.
* The payment's own `createdAt` is Payment's clock (database time). The contract has no producer timestamp; a body with unknown fields is rejected (`400`).
* **What an identical replay means:** the retry must carry the **same values for every field of section 3.1** (authoritative and descriptive). Any difference, including `expiresAt` or `description`, is a different snapshot and is refused with `409 payment_request_conflict`. A producer that must send a changed request uses a **new** `paymentRequestId`. For the same reason, after a payment ends as `failed`, `cancelled` or `expired`, billing needs a **new** `paymentRequestId` to try again: the natural key is permanent.
* Version 1 restricts the schema to **one payment per payment request**. This is a **temporary technical restriction, not a policy**: whether partial payments are wanted is [B, O-7] (the architecture documents say they are "allowed by design, policy open"). If they are approved, the uniqueness is relaxed by a migration together with an invariant that the sum of succeeded payments never exceeds the request amount.

## 4. Domain model

All tables live in payment-service's **own database** and role (`payment_migrator` owns the schema, `payment_app` runs the service; ADR-0032).
Times are `timestamptz` from the database clock. Ids are uuids generated by payment-service. Cross-service references (`payer`, `seller`,
`organizationId`, `sourceType`, `sourceId`, user ids) are **opaque values with no foreign key** [D]. Foreign keys exist only inside
this database. Money is `bigint` minor units plus `currency char(3)`; CHECK constraints enforce `amount > 0` and upper-case currency [D].

### 4.1 Payment

| Aspect | Definition |
|---|---|
| Purpose | One obligation to collect, created from one payment request; the aggregate that carries state, attempts, at most one cash submission, and refunds |
| Ownership | payment-service |
| Important fields | `id`, `producer` (calling service name), `paymentRequestId`, `sourceType`, `sourceId`, `payerType`/`payerId`, `sellerType`/`sellerId`, `organizationId`, `amount`, `currency`, `description`, `reference`, `expiresAt`, `status`, `statusReason`, `settledMethod` (`gateway` or `cash`, set on success), `succeededAttemptId` (the payment attempt that succeeded, for gateway payments; it is what a refund is executed against), `revision`, `createdAt`, `updatedAt`, `closedAt` |
| Immutable | everything in the snapshot (`producer`, `paymentRequestId`, `source*`, `payer*`, `seller*`, `organizationId`, `amount`, `currency`, `description`, `reference`, `expiresAt`) and `createdAt`; enforced by trigger [D] |
| Mutable | `status`, `statusReason`, `settledMethod`, `succeededAttemptId` (set once), `revision` (incremented on every state change, carried in events), `updatedAt`, `closedAt` |
| Relationships | 1 to N `payment_attempt`; 0 or 1 active/confirmed `cash_payment`; 1 to N `refund` |
| Lifecycle | section 5.1 |
| Uniqueness | `UNIQUE (producer, paymentRequestId)` |
| Idempotency | natural key above; creation is a no-op replay when identical |
| Isolation | `organizationId`, `payer*` and `seller*` are the columns access is evaluated against (section 8); indexes on each |
| Derived (never stored) | `refundedAmount` and `refundableAmount` are computed from `refund` rows, not kept as a counter [T] |

### 4.2 PaymentAttempt

| Aspect | Definition |
|---|---|
| Purpose | One try to collect through one provider. Keeps provider history separate from the business payment |
| Fields | `id`, `paymentId`, `attemptNumber`, `provider`, `merchantReference` (= `id`, sent to the provider as its idempotency/merchant reference), `providerTransactionId` (null until the provider returns it), `status`, `failureCode`, `failureClass` (`retryable`, `terminal`, `ambiguous`), `failureInferred` (true when the failure was **inferred** by the resolver from a provider "no record" answer, false when the provider itself confirmed it), `providerData` (opaque, adapter-owned, **never a secret**), `initiatedAt`, `submittedAt`, `completedAt` |
| Immutable | `paymentId`, `attemptNumber`, `provider`, `merchantReference`, `initiatedAt` |
| Mutable | `status`, `providerTransactionId` (set once), `failure*`, `providerData`, timestamps |
| Uniqueness | `UNIQUE (paymentId, attemptNumber)`; `UNIQUE (provider, providerTransactionId)` where not null; **at most one open attempt per payment** (partial unique index on `paymentId` where `status` in `initiated`, `submitted`, `unknown`) |
| Idempotency | creation by `Idempotency-Key` (section 6); the provider call carries `merchantReference` so a repeated call cannot create a second provider transaction |
| Isolation | inherits the payment's; reached only through it |

### 4.3 CashPayment (a cash submission and its decision)

| Aspect | Definition |
|---|---|
| Purpose | The workflow for money handed over outside any provider: submitted, then confirmed or rejected by an explicitly authorized person |
| Fields | `id`, `paymentId`, `status`, `amount`, `currency` (equal to the payment's), `note` (at most 280 characters, descriptive), `submittedBy` (user id), `submittedAt`, `confirmedBy`, `confirmedAt`, `rejectedBy`, `rejectedAt`, `rejectionReason` (bounded text) |
| Immutable | `paymentId`, `amount`, `currency`, `note`, `submittedBy`, `submittedAt`; a decision, once made, is never rewritten |
| Mutable | `status` and the decision fields, once each (`submitted` to `confirmed` or `rejected`) |
| Uniqueness | at most one `submitted` or `confirmed` cash submission per payment (partial unique index). A `rejected` one does not block a new submission [T, revisit with O-5] |
| Constraints | exactly one of the confirm fields or the reject fields is set, and only in the matching status (CHECK); **PROPOSED — NOT APPROVED generic control [T, revisit with O-5]:** the confirmer differs from the payer when the payer is a `user` (trigger, because the payer lives on `payment`); "confirmer differs from submitter" and any **bound on repeated submissions after rejections** (cash resubmission is otherwise unbounded, because the attempt limit does not apply to cash) are **[B, O-5]** |
| Idempotency | submit by `Idempotency-Key`; confirm and reject are idempotent by state (section 6) |
| Isolation | inherits the payment's |

### 4.4 Refund

| Aspect | Definition |
|---|---|
| Purpose | A first-class return of money for one succeeded payment; never a flag on the payment [D] |
| Fields | `id`, `paymentId`, `clientReference`, `amount`, `currency` (equal to the payment's), `reasonCode` (opaque, bounded), `note`, `status`, `failureCode`, `requestedByType`/`requestedById`, `requestedAt`, `completedAt` |
| Immutable | `paymentId`, `clientReference`, `amount`, `currency`, `reasonCode`, `requestedBy*`, `requestedAt` |
| Mutable | `status`, `failureCode`, `completedAt` |
| Uniqueness | `UNIQUE (paymentId, clientReference)` (natural idempotency key) |
| Constraints | the payment must be `succeeded`; **the sum of refunds in `requested`, `processing` or `succeeded` never exceeds the payment amount**, enforced by a trigger that locks the payment row (so concurrent requests cannot over-refund) and is released when a refund fails [T; a consequence of refunds being first-class, ADR-0035]; the provider must declare the refund capability, otherwise the request is refused (`payment_not_refundable`) |
| Scope | partial amounts are supported by the model. **Until O-6 is decided the service accepts only a full refund** (the amount must equal the payment amount, and only one refund may succeed). Refunds of **cash** payments have no provider path and are refused (`payment_not_refundable`) until decided **[B, O-6]** |
| Isolation | inherits the payment's |

### 4.5 RefundAttempt

Same shape and rules as `PaymentAttempt`, for a refund: `id`, `refundId`, `paymentAttemptId` (the succeeded payment attempt being refunded, copied from `payment.succeededAttemptId`; it identifies the provider transaction to refund), `attemptNumber`, `provider`, `merchantReference`,
`providerRefundId` (`UNIQUE (provider, providerRefundId)` where not null), `status`, `failureCode`, `failureClass`, `providerData`,
timestamps; at most one open refund attempt per refund. Provider refund history is never merged into the `refund` row. A capture that is not tied to `succeededAttemptId` (for example a duplicate or orphan capture on a second attempt) cannot be refunded automatically: it is a reconciliation case handled by an operator, outside this phase [X], and raises an alert.

### 4.6 WebhookEvent

| Aspect | Definition |
|---|---|
| Purpose | Durable, deduplicated record of a **verified** provider notification and of how it was processed |
| Fields | `id`, `provider`, `providerEventId`, `eventType` (as sent), `rawBody` (exact bytes), `receivedAt`, `state` (`received`, `processing`, `processed`, `ignored`, `unmatched`, `conflict`, `failed`), `outcome` (bounded text), `attempts`, `lastError` (class only), `matchedAttemptId` / `matchedRefundAttemptId` (local ids), `processedAt` |
| Immutable | `provider`, `providerEventId`, `eventType`, `rawBody`, `receivedAt` |
| Uniqueness | `UNIQUE (provider, providerEventId)` (the deduplication key) |
| Not stored | requests that **fail signature verification**: they are rejected and counted, never persisted (an unauthenticated caller cannot write to the database) [T] |
| Retention | privacy and legal retention of raw bodies **[B, O-17]** |

### 4.7 IdempotencyKey

| Aspect | Definition |
|---|---|
| Purpose | Short-lived protection against a client retrying a non-natural-key operation |
| Fields | `caller` (service name, or `user:<id>`), `operation`, `key`, `requestHash` (SHA-256 of the canonical request), `status` (`completed`), `responseStatus`, `resourceType`, `resourceId`, `createdAt`, `expiresAt` |
| Uniqueness | `UNIQUE (caller, operation, key)` |
| Rules | section 6 |

### 4.8 Currency (reference table)

`currency(code char(3) primary key, exponent smallint not null)`: the ISO 4217 minor-unit exponent for each supported currency, seeded by migration and
referenced by `payment.currency` (a foreign key **inside** this database) [T, ADR-0036]. It is reference data, not a domain entity, and the only place an
exponent lives; nothing in code assumes one. Which currencies are seeded is a configuration decision: anything beyond the first is [B, O-10].

### 4.9 Outbox and Inbox

Provided by the service-kit migration `kit_0001_outbox_inbox.sql` [D]. **Outbox:** every state change that publishes an event writes it
in the same transaction (section 11). **Inbox:** the table exists; **payment-service has no event consumer in this phase** (billing
reaches it by API), so nothing writes to it yet [T]. Both belong to payment's own database; no other service reads them.

### 4.10 Financial invariants [T]

These are domain-level safety properties that must hold regardless of retries, concurrent requests, duplicate requests, provider
callbacks, provider timeouts, worker crashes, process restarts, webhook retries, or malicious client input. They restate, in one
place, invariants already implied by sections 3 to 4 and 5 to 12 below; they do not add new behaviour, states or entities.
Enforcement may come from database constraints, unique indexes, database triggers, transactions and row locking, application or
domain validation, provider verification, or tests — whichever mechanism the referenced section already assigns to it. Not every
invariant needs a database trigger.

| # | Invariant | Enforced by |
|---|---|---|
| FI-01 | A payment `amount` is strictly greater than zero | CHECK constraint (section 4) |
| FI-02 | After creation, the payment snapshot is immutable: at minimum `amount`, `currency`, `payer`, `seller`, `organizationId`, `sourceType`, `sourceId`, `paymentRequestId` never change | database trigger (section 3.2, 4.1) |
| FI-03 | A payment has at most one **successful gateway `PaymentAttempt`**. Cash settlement is not represented as a successful gateway `PaymentAttempt`; it is a separate settlement path represented by the authorized/confirmed `CashPayment` state (see FI-05) | a new attempt can only start from `created`, and `succeeded` is terminal for the payment (section 5.1, 5.2) |
| FI-04 | If `succeededAttemptId` is set, it references an attempt belonging to the **same** payment, and that attempt is itself `succeeded` | the transition that sets it, set once (section 4.1, 12.2) |
| FI-05 | A payment settles through **exactly one** of: a gateway attempt, or an authorized cash confirmation — never both | "one open collection at a time": starting an attempt and submitting cash both require status `created` (section 5.1) |
| FI-06 | A `succeeded` payment retains no other unresolved collection path capable of producing a second settlement | the existing handling of `initiated`/`submitted`/`unknown` attempts, cash awaiting review, late success and conflict/reconciliation; no new state is introduced for this (section 5.1, 5.2, 5.3) |
| FI-07 | Total refunds in `requested`, `processing` or `succeeded` never exceed the original payment amount, even under concurrent refund requests | the refund cap trigger that locks the payment row (section 4.4); scope stays full-refund-only until O-6 **[B]** approves partial refunds |
| FI-08 | A refund belongs only to a **succeeded** payment; pending, failed, cancelled or expired payments cannot be refunded | the `succeeded`-only constraint on refund creation (section 4.4, 5.4) |
| FI-09 | A provider transaction id (`provider`, `providerTransactionId`) belongs to at most one payment attempt | unique index (section 4.2) |
| FI-10 | A provider refund transaction id (`provider`, `providerRefundId`) belongs to at most one refund attempt | unique index (section 4.5) |
| FI-11 | Terminal payment states (`succeeded`, `failed`, `cancelled`, `expired`) never transition back into the lifecycle; a refund never moves the original payment out of `succeeded` | the state machine (section 5.1); refund history lives in `refund` rows only (section 5.4) |
| FI-12 | A payment becomes `succeeded` only through a verified provider webhook, a verified server-side provider status query, or an authorized cash confirmation — never a client assertion alone | section 5.1, 7, 8 |
| FI-13 | A provider success is applied only when its amount and currency match the immutable payment snapshot; a mismatch is never applied silently | treated as a `conflict`, routed to reconciliation, and raises an alert; no new payment state is introduced for this (section 5.1 "late success", 12, 13.1) |
| FI-14 | A refund's currency equals its payment's currency | field definition (section 4.4) |
| FI-15 | Financial amounts are `bigint` minor currency units against an ISO 4217 currency code; floating-point monetary arithmetic is forbidden anywhere in the service | section 4, 4.8 |
| FI-16 | For a state transition that this SDD declares event-producing, the state change and its transactional outbox event commit atomically, in the same transaction | section 4.9, 11, 12. This does **not** mean every internal transition publishes an event: `pending` and the other transitions section 11 marks as internal-only are deliberately not published |

FI-06 and FI-13 are safety nets for cases the state machine already prevents in normal operation; they do not create new payment or
attempt states.

## 5. State machines

Terminal states are never left. Every transition is applied by a **conditional update** (`WHERE status = <expected>`) inside a transaction
that holds a row lock, and a **database trigger rejects any move not in these tables** (defence in depth: application checks are not
the only guard) [T]. "Event" names refer to section 11.

### 5.1 Payment

States: `created` (accepted, no open attempt or cash submission), `pending` (exactly one open attempt or a submitted cash payment),
`succeeded`, `failed`, `cancelled`, `expired` (the last four are terminal).

| From | To | Caused by | Condition | Retryable | Event |
|---|---|---|---|---|---|
| (none) | `created` | producer service: create | valid request, new or identical | n/a | `payment.created` |
| `created` | `pending` | payer starts an attempt; or a cash submission is recorded | no open attempt | n/a | none (internal) |
| `pending` | `created` | the open attempt ended `failed` or `expired` and no rule below ends the payment; or the cash submission was rejected (**[B, O-5]**) | not expired | yes, by a new attempt | none |
| `pending` | `succeeded` | **verified** provider success (webhook or server-side sync), or an authorized cash confirmation | amount and currency equal the snapshot | no | `payment.succeeded` |
| `pending` | `failed` | the attempt limit is reached, or the adapter reports the payment itself unrecoverable (`paymentFatal`) | none | no | `payment.failed` |
| `created` | `cancelled` | producer service: cancel | none | no | `payment.cancelled` |
| `pending` | `cancelled` | producer service: cancel | **no attempt in `initiated`, `submitted` or `unknown`** (else `409 payment_has_open_attempt`) **and no cash submission in `submitted`** (else `409 cash_submission_exists`: the cash has physically changed hands and must be decided first) | no | `payment.cancelled` |
| `created` | `expired` | expiry sweep | `now() >= expiresAt` | no | `payment.expired` |
| `pending` | `expired` | expiry sweep | `now() >= expiresAt` **and no attempt in `initiated`, `submitted` or `unknown` and no cash submission in `submitted`** (money in flight, or cash awaiting review, must be resolved first; how long a cash review may stay open is **[B, O-5]**) | no | `payment.expired` |
| `created` | `succeeded` | late success only: **verified** provider success for an attempt this SDD's resolver already failed **by inference** (`failureInferred = true`), after that inferred failure had already returned the payment to `created` | amount and currency equal the snapshot; the prior failure was inferred, never provider-confirmed (see "Late success" below) | no | `payment.succeeded` |

**One open collection at a time [T]:** starting an attempt **and** submitting cash both require status `created`, so a payment can never have a gateway attempt and a cash submission open together (the second is refused with `409 payment_has_open_attempt` or `409 cash_submission_exists`). Both are also refused once `now() >= expiresAt`, even before the expiry sweep has run (`409 payment_expired`).

Forbidden, among others: any move out of a terminal state; success accepted from a client claim; cancelling or expiring while an
attempt may still succeed. `created` to `succeeded` is forbidden as a **general** transition (success is reached from `pending`,
even for the test provider) — the **only** exception is the narrow late-success case immediately below, where an attempt already
failed by inference had already returned the payment to `created`.
**Late success [T]:**

* A verified `succeeded` for an attempt that the **resolver failed by inference** (`failureInferred = true`) is accepted: the attempt moves to `succeeded` and, if the payment is not terminal, the payment moves to `succeeded` (`succeededAttemptId` is set). An inferred failure is a guess, and a later fact from the provider wins.
* A verified `succeeded` for an attempt the **provider itself confirmed as failed**, or for a payment that is already terminal in another way, is a **conflict**: the webhook is recorded (`conflict`), nothing changes silently, an alert is raised, and the case goes to manual reconciliation (money has moved and must be returned or matched by an operator, outside this phase [X]). The rules above prevent this in normal operation; it is the safety net.

**What ends a payment as `failed` is partly a business question [B, O-19]:** the table above ends a payment only on the attempt limit or an adapter-declared unrecoverable payment; a *declined* attempt on its own returns the payment to `created`, so the payer can try again until the limit or expiry. The limit's value, and whether a decline should end the payment, are for O-19. Whether a **rejected cash submission ends the payment** or returns it to `created` (PROPOSED — NOT APPROVED default shown above) is [B, O-5].

### 5.2 PaymentAttempt

States: `initiated` (row committed before the provider is called), `submitted` (provider accepted; awaiting the customer or the provider),
`succeeded`, `failed`, `expired` (terminal), `unknown` (the provider call's outcome is ambiguous, for example a timeout after sending).

| From | To | Caused by | Notes |
|---|---|---|---|
| (none) | `initiated` | payer starts an attempt (transaction 1) | payment moves `created` to `pending` in the same transaction |
| `initiated` | `submitted` | provider accepted; `providerTransactionId` recorded | adapter returned a definite acceptance |
| `initiated` | `failed` | provider definitively rejected before accepting | failure class `retryable` or `terminal` |
| `initiated` | `unknown` | ambiguous outcome (timeout, connection lost); or found stuck in `initiated` by the resolver | **never retried blindly**, to avoid a double charge. The resolver waits **longer than the provider timeout plus the provider's visibility lag** (adapter-declared) before acting |
| `submitted` | `succeeded` / `failed` | verified webhook or verified server-side status | monotonic for provider-confirmed states |
| `submitted` | `expired` | the resolver, when the attempt is older than the attempt TTL (configuration) and the adapter says the provider-side session has ended, or `fetchStatus` says so | if the provider still reports it pending and the adapter cannot say the session ended, the attempt **stays `submitted` and an alert is raised**: an attempt is never closed by guess |
| `unknown` | `submitted` / `succeeded` / `failed` | provider lookup by `merchantReference`, or a webhook | `failed` from a "no record" answer is allowed **only if the adapter declares `notFound` authoritative** (after its visibility lag); the attempt is then marked `failureInferred = true`. Otherwise it stays `unknown` and an alert is raised |

The resolver settles attempts in `initiated`, `unknown` **and long-`submitted`**; a payment therefore cannot stay `pending` forever without an alert. No new attempt may start while another is `initiated`, `submitted` or `unknown` (partial unique index). Attempt states are exposed on the
payment; **no separate attempt events are published in this phase** [T].

### 5.3 CashPayment

States: `submitted`, `confirmed`, `rejected` (the last two terminal).

| From | To | Caused by | Effect on the payment | Event |
|---|---|---|---|---|
| (none) | `submitted` | an authorized submitter [B, O-4] | `created` to `pending` | `cash_payment.submitted` |
| `submitted` | `confirmed` | an explicitly authorized person [B, O-5], who is not the payer | `pending` to `succeeded`, `settledMethod = cash` | `cash_payment.confirmed` (then `payment.succeeded`) |
| `submitted` | `rejected` | the same authority | `pending` to `created` (PROPOSED — NOT APPROVED default; [B, O-5]) | `cash_payment.rejected` |

A second confirmation or rejection is refused (`409 cash_already_confirmed` or `cash_already_rejected`), never applied twice. Withdrawal of
a submission by its submitter is [X].

### 5.4 Refund

States: `requested` (accepted; the amount is **reserved** against the payment), `processing` (an attempt is open), `succeeded`, `failed`
(terminal).

| From | To | Caused by | Event |
|---|---|---|---|
| (none) | `requested` | an authorized requester [B, O-6]; the payment is `succeeded`; the cap holds | `refund.requested` |
| `requested` | `processing` | a refund attempt is started (system, right after acceptance) | none |
| `processing` | `requested` | the attempt ended retryably | none |
| `processing` / `requested` | `succeeded` | verified provider refund success | `refund.succeeded` |
| `processing` / `requested` | `failed` | non-retryable failure, or the attempt limit; the reservation is released | `refund.failed` |

A refund retry and resolver job restarts refunds returned to `requested` and settles refund attempts in `unknown` (same rules as section 5.2). A provider without the refund capability, or a cash payment, is refused **at request time** (`payment_not_refundable`) so a reservation never sits in `requested` with no way forward. Cancelling a requested refund is [X]. The payment's own status does not change when it is refunded; refund history is the refund rows.

### 5.5 RefundAttempt

Same states and transitions as section 5.2, applied to a refund, with the same "never retry an `unknown` blindly" rule.

## 6. Idempotency

Two mechanisms, chosen by whether the operation has a natural key [T]. **This deliberately refines ADR-0034 and `financial-architecture.md` (which say resource-creating `POST`s take an `Idempotency-Key`):** creating a payment and creating a refund use a **permanent natural key** instead, which is stronger than a header that expires; ADR-0034 carries a note recording this.

| Operation | Mechanism | Same request repeated | Same key, different content | Concurrent duplicate |
|---|---|---|---|---|
| Create payment | natural key `(producer, paymentRequestId)` | `200` existing payment, `Idempotent-Replayed: true` | `409 payment_request_conflict` | one row (unique index); the loser returns the winner |
| Start attempt | `Idempotency-Key` header (required) plus "one open attempt" index | replay: the original status code and the attempt's current state | `422 idempotency_key_reused` | serialized by the unique key; a different key while one attempt is open gets `409 payment_has_open_attempt` |
| Submit cash | `Idempotency-Key` (required) plus "one submitted or confirmed" index | replay | `422 idempotency_key_reused` | same; a different key gets `409 cash_submission_exists` |
| Confirm or reject cash | `Idempotency-Key` (required) **and** state | replay of the recorded decision | `422 idempotency_key_reused` | one decision wins; the loser gets `409 cash_already_confirmed` or `cash_already_rejected` |
| Cancel | `Idempotency-Key` (required) and state | replay | `422` | state decides |
| Create refund | natural key `(paymentId, clientReference)` | `200` existing refund | `409 refund_conflict` | one row |
| Sync attempt with provider | naturally idempotent (a status query) | fresh state, no key needed | n/a | safe |
| Provider webhook | `UNIQUE (provider, providerEventId)`, then state validation | `200`, no second effect | n/a | one processed |
| Provider transaction / refund id | `UNIQUE (provider, providerTransactionId)` and `(provider, providerRefundId)` | a second attempt claiming the same provider id fails | n/a | one wins |

Rules for the `Idempotency-Key` header: 8 to 128 characters of `[A-Za-z0-9._:-]`; the scope is `(caller, operation, key)` where the caller is the
service name or the user id; `requestHash` is the SHA-256 of the canonical request (operation, path parameters, body); a missing key on a
required operation is `400 idempotency_key_required`. The key row and the business change commit in **one transaction**, so there is no
half-recorded key: a concurrent duplicate blocks on the unique index until the first transaction commits and then replays; if the first
one rolls back, the second one runs. Keys expire after a configured retention (a recommended minimum of 24 hours, configuration with no
business meaning); an expired key is treated as new, which is safe because **every money-moving creation is also protected by a permanent
natural key** above. A replay returns the **original status code with the resource's current representation**.

**Replay semantics, made explicit [T]:** when a request is replayed with the same key (the natural key of section 3.3/4.4, or the
same `Idempotency-Key` **and** the same `requestHash`), the original operation is **not executed again**: no second financial side
effect occurs, no second provider operation is initiated, and the original result is reused as-is; the response reuses the
**original status code** together with the **current representation** of the original resource, per the table above. The same key
presented with a **different** request hash or a different snapshot is always rejected as an idempotency conflict — never
partially applied and never silently resolved either way — with the codes already listed above (`422 idempotency_key_reused`,
`409 payment_request_conflict`, `409 refund_conflict`).

Provider calls are not inside these transactions (section 12); a retried request after a crash returns the attempt as it now is
(`initiated` or `unknown`), and the resolver settles it.

## 7. Webhooks

Endpoint: `POST /payment/webhooks/{provider}` (unauthenticated by user or service; authenticated **only** by the provider's signature) [T].
The route needs the **exact raw body** for signature verification: the service-kit must expose raw-body capture for this route (a
prerequisite, section 20). Provider-specific signature schemes are defined per adapter when a provider contract exists [X].

```
receive ─▶ verify signature (adapter, using the provider secret from the secret store)
        ─▶ invalid: 401, nothing persisted, counted and logged (no body in the log)
        ─▶ valid:   transaction A: INSERT webhook_event(state = received) ON CONFLICT (provider, providerEventId) DO NOTHING
                    conflict ─▶ existing row: if its state is processed, ignored or conflict ─▶ 200, no further effect;
                                otherwise (received, processing, failed, unmatched) ─▶ re-run transaction B, so a crash between A and B loses nothing
                    inserted ─▶ transaction B: lock the matching attempt and payment, validate the transition,
                                 apply it, write the outbox event, set state = processed   ─▶ 200
```

| Case | Behaviour [T] |
|---|---|
| Duplicate event | if already `processed`, `ignored` or `conflict`: `200`, a no-op (unique key). If the earlier delivery died before finishing (state `received`, `processing`, `failed`), the duplicate **re-runs processing** instead of being swallowed. Replays of an old signed event are the same case |
| Out of order | the transition is validated against the **current** state: an event that is older in the lifecycle than the current state is `processed` with outcome `ignored_stale`; states are monotonic |
| Success after a different terminal state | `conflict`: recorded, alert, no state change (section 5.1) |
| Unknown event type | stored, `ignored`, `200` |
| Matches no attempt yet | `unmatched`: retried for a bounded period (the webhook can arrive before our record is visible; matching is by `merchantReference` or `providerTransactionId`); afterwards it stays `unmatched` and raises an alert for reconciliation |
| Malformed body with a **valid** signature | stored, state `failed`, non-retryable; answer `200` so the provider stops retrying |
| Processing fails transiently | state `failed` (retryable); answer `500`, so the provider retries; the next delivery finds the row and reprocesses it |
| Provider retries | idempotent by construction; no provider-specific assumption is made [D] |

Replay protection beyond deduplication (signed timestamps, tolerance windows, source address allow-lists) is provider-specific and belongs to
each adapter [X]. A payment is **never** marked successful from a webhook that failed verification, from a client request, or from a
redirect back to the application: the only success paths are a verified webhook, a verified server-side provider status query, and an
authorized cash confirmation [D].

## 8. Authorization and organization isolation

### 8.1 Who asks whom [D]

* **Auth** answers: who is this person, and what are their memberships and their status. Payment asks it live through the kit's
  `HttpAuthClient` (`GET /auth/me`) with the user's own bearer and does not cache the answer in this phase. Auth is unavailable: `503`, fail closed. An identity with `isActive = false` is refused (`401`). Owners and operators have no memberships, so they have **no relation** to a payment in this phase (platform-scoped staff access needs a platform id that payment does not store: O-15).
* **Endpoints that accept either a service token or a user bearer** (2, 4, 11) resolve the caller in this order: try the service-token digests first; if the bearer matches one, the caller is that service and **the bearer is never sent to Auth**; otherwise treat it as a user bearer and ask Auth. The kit's `ServiceTokenGuard` throws on a non-matching bearer, so a small combined guard (service token else user identity) is part of the implementation.
* **Payment** decides whether the caller may perform *this payment operation*. Payment does **not** delegate that decision to Auth and does
  **not** treat a generic Auth capability (for example the organization-administrator flag) as authority for cash or refunds.
* **Service to service** uses a per-pair service token (`ServiceTokenGuard`); the caller is identified by service name. An end user's JWT is never
  used as, or forwarded as, a service credential; a user's bearer is sent to Auth only.
* Payment adds no organization to Auth's `User` and keeps no membership table of its own.

### 8.2 The isolation procedure for every organization-scoped request [D]

```
caller (service token, or user bearer)
  ─▶ authenticate           (401 on failure)
  ─▶ for a user: ask Auth for identity and memberships (503 if Auth cannot answer)
  ─▶ load the payment by id
  ─▶ establish the caller's RELATION to the payment (section 8.3); none ─▶ 404 (collapsed, no existence leak)
  ─▶ check the OPERATION rule for that relation (section 8.4); not allowed ─▶ 403
  ─▶ check the state machine ─▶ 409 if the transition is not allowed
  ─▶ perform, in one transaction, with the outbox event
```

A caller with **no** relation to a resource gets the same `404` as for a resource that does not exist. A caller who legitimately sees a
payment but lacks the right for the operation gets `403 operation_not_permitted`. Membership must be **`active`** (a pending, rejected or
revoked membership never counts). The organization always comes from the resource, never from a token or a client-supplied header.

### 8.3 Relations [T]

| Relation | Holds when |
|---|---|
| `producer` | the caller is the service that created the payment (`producer` equals the service token's name) |
| `payer` | the payer is a `user` and equals the caller's Auth identity |
| `payer-organization member` | the payer is an `organization` and the caller has an **active** membership in it |
| `seller-organization member` | the seller (or `organizationId`) is an organization and the caller has an **active** membership in it |
| `provider` | webhook only: a valid signature |

A `company` payer or seller has **no user relation** in this phase: it is reachable only through its `producer` service. Who acts for a company (for example platform staff acting for the seller in a Nawara-collected cash payment) needs a platform or company validation source that does not exist yet (O-15) and an authority model (O-5, O-6, O-18); until then those flows cannot be authorized through a user and are not implemented.

### 8.4 Operation rules

| Operation | Rule | Marker |
|---|---|---|
| Create payment | a **producer service** with a valid token. Which services may create obligations for which organizations (token scopes) is not decided | **[B, O-13, O-14]** |
| Validate the organization/platform/company context of a created payment | Payment stores `organizationId` as asserted by the authorized producer. The source that validates organization to platform to company when there is no user context is not decided | **[B, O-15]** |
| Read a payment or its refunds | the `producer` (only its own payments) and the `payer` [T]. **Whether members of the payer or seller organization may read** (which exposes payer, amount and reference to them, including members of the organization named in `organizationId`) is a privacy and role decision | **[B, O-20]** (until decided, organization members have no read access) |
| Start or sync an attempt | the `payer`; sync is also allowed to anyone with a read relation. For an organization payer, who may act for it is not decided | [T] for a user payer; **[B, O-18]** for an organization payer |
| Submit cash | not decided | **[B, O-4]** |
| Confirm or reject cash | not decided. **Controls proposed regardless of the model (PROPOSED — NOT APPROVED):** the confirmer is not the payer; the decision is recorded with the actor; it cannot be applied twice. Which relation and authority qualify (including for a `company` seller) is part of the decision | **[B, O-5]**; controls [T] |
| Cancel | the `producer` only in this phase | [T] |
| Request a refund | not decided | **[B, O-6]**; the refund cap is [D] |
| Process a webhook | a valid provider signature | [D] |
| Administrative or support operations | **none** in this phase: no operation edits a status directly, and no list-everything endpoint exists | [X] |

How cash and refund authority will be *modeled* is itself part of the decision: for example an explicit designation kept by payment-service,
a producer-supplied grant, or an approved use of an Auth capability. **None is chosen here** (O-5, O-6).

### 8.5 What payment never trusts [D]

Consolidating the rule stated in sections 8.1 and 16: a client-supplied `userId`, `organizationId`, `platformId`, role, permission,
amount, currency or beneficiary is never trusted as authority or as fact. Authority always comes from a **relation** the caller has
to the resource (section 8.3) plus the **operation rule** for that relation (section 8.4), never from a claim in the request body, a
header, or a forwarded token. Where the operation rule itself is `[B]` (cash and refund authorization, organization-payer
authorization, read access beyond producer and payer — O-4, O-5, O-6, O-18, O-20), the authority model is unresolved: under the
guardrail of section 0.1, an implementation must not invent or assume one, and the corresponding endpoint stays unimplemented, or
fails closed, until the decision is made.

## 9. API contract

Public prefix `/payment` [D, ADR-0034]; no version segment in v1; errors and lists follow the service-kit conventions; OpenAPI is served under
`/payment/docs` behind basic authentication (as auth-service does) and every controller method and DTO field carries `@ApiOperation`,
`@ApiResponse` and `@ApiProperty` (repository rule). `GET /health` and `GET /ready` are the kit's root paths and are not routed publicly.
There is deliberately **no generic create/update/delete of a payment, attempt, cash payment or refund**, and **no list or search endpoint** in this phase [X]: every mutation is a named domain operation and every read is by id. `/payment/docs` (rather than a root `/docs`) follows auth-service's `/auth/docs`, because the gateway routes only `/<prefix>`.

| # | Method and path | Authentication | Idempotency |
|---|---|---|---|
| 1 | `POST /payment/payments` | service token | natural key `paymentRequestId` |
| 2 | `GET /payment/payments/{paymentId}` | service token or user bearer | n/a |
| 3 | `POST /payment/payments/{paymentId}/attempts` | user bearer | `Idempotency-Key` required |
| 4 | `POST /payment/payments/{paymentId}/attempts/{attemptId}/sync` | user bearer or service token | safe by nature |
| 5 | `POST /payment/webhooks/{provider}` | provider signature | `(provider, providerEventId)` |
| 6 | `POST /payment/payments/{paymentId}/cash-submissions` | user bearer | `Idempotency-Key` required |
| 7 | `POST /payment/cash-submissions/{id}/confirm` | user bearer | `Idempotency-Key` required, plus state |
| 8 | `POST /payment/cash-submissions/{id}/reject` | user bearer | `Idempotency-Key` required, plus state |
| 9 | `POST /payment/payments/{paymentId}/cancel` | service token | `Idempotency-Key` required |
| 10 | `POST /payment/payments/{paymentId}/refunds` | user bearer | natural key `clientReference` |
| 11 | `GET /payment/refunds/{refundId}` | user bearer or service token | n/a |

### 9.1 Endpoints

**1. Create payment.** Body: the contract of section 3.1. `201` with the payment; `200` on an identical replay. Authorization: section 8.4 (**[B]** scopes).
Errors: `400 invalid_payment_request`, `401`, `403 operation_not_permitted`, `409 payment_request_conflict`, `422 unsupported_currency`.
Transition: none to `created`. Event: `payment.created`. Organization context: `organizationId` from the body, asserted by the producer (**[B, O-15]**).

**2. Get payment.** `200` with the representation below; `404` when the caller has no relation. No transition.

**3. Start attempt.** Body: `{ provider, providerOptions?, returnUrl? }` where `provider` must be an enabled provider (initially only the test provider [X]);
`providerOptions` is opaque and validated by the adapter; `returnUrl` must match a configured allow-list. `201` with the attempt
(`id`, `status`, `nextAction`: an adapter-defined instruction such as `{ "type": "redirect", "url": "..." }`, never a secret).
Errors: `404`, `403`, `409 payment_not_payable` (terminal state), `409 payment_expired`, `409 payment_has_open_attempt`, `409 cash_submission_exists` (a cash submission is open), `422 invalid_provider`,
`502 provider_error`, `503 provider_unavailable`. Transitions: payment `created` to `pending`; attempt none to `initiated` to `submitted`
(or `failed` or `unknown`). The attempt row commits **before** the provider is called (section 12).

**4. Sync attempt.** Asks payment-service to query the provider for the attempt's status and to apply the result if it is a valid transition.
The client's claim is never used: only what the adapter verifies with the provider. `200` with the attempt. Errors: `404`, `403`, `502`, `503`.
Transitions: as section 5.2.

**5. Webhook.** Section 7. `200` (processed, duplicate, ignored, stored), `401` (signature invalid), `404` (unknown provider), `413` (too large), `500` (transient).

**6. Submit cash.** Body: `{ note? }`. `201` with the cash submission. Authorization **[B, O-4]**. Errors: `404`, `403`, `409 payment_not_payable`,
`409 payment_has_open_attempt`, `409 cash_submission_exists`. Transitions: cash none to `submitted`; payment `created` to `pending`. Event: `cash_payment.submitted`.

**7. Confirm cash.** No body. `200` with the cash submission. Authorization **[B, O-5]** plus the technical conditions of section 8.4.
Errors: `404`, `403`, `409 cash_already_confirmed`, `409 cash_already_rejected`, `409 invalid_state_transition`. Transitions: cash `submitted` to `confirmed`; payment
`pending` to `succeeded`. Events: `cash_payment.confirmed`, `payment.succeeded`.

**8. Reject cash.** Body: `{ reason? }`. Same errors as 7. Transitions: cash `submitted` to `rejected`; payment `pending` to `created`
(PROPOSED — NOT APPROVED default, **[B, O-5]**). Event: `cash_payment.rejected`.

**9. Cancel payment.** No body. `200` with the payment. Errors: `404`, `403`, `409 payment_has_open_attempt`, `409 cash_submission_exists`, `409 invalid_state_transition`.
Transition: `created` or `pending` to `cancelled`. Event: `payment.cancelled`.

**10. Create refund.** Body: `{ clientReference, amount, reasonCode?, note? }`. Until O-6 is decided `amount` must equal the payment amount (full refund only; otherwise `422 refund_amount_not_allowed`). `201`, or `200` on an identical replay. Authorization **[B, O-6]**.
Errors: `404`, `403`, `409 refund_conflict`, `409 payment_not_refundable` (not succeeded, or cash [B]), `422 refund_exceeds_refundable`, `422 unsupported_currency`.
Transitions: refund none to `requested`, then `processing` when an attempt starts. Event: `refund.requested`.

**11. Get refund.** `200` or `404`.

### 9.2 Representations (excerpt)

```
Payment { id, paymentRequestId, sourceType, sourceId, payer{type,id}, seller{type,id}, organizationId, amount, currency,
          description, reference, expiresAt, status, statusReason, settledMethod, refundedAmount, refundableAmount,
          attempts[ { id, attemptNumber, provider, status, failureCode, nextAction, createdAt } ],   // newest first, bounded, no providerData
          cash { id, status, submittedAt, confirmedAt, rejectedAt } | null, createdAt, updatedAt, closedAt }
Refund  { id, paymentId, clientReference, amount, currency, reasonCode, status, failureCode, requestedAt, completedAt }
```

## 10. Error model

Reuses the kit's body `{ statusCode, message, error, requestId }`. Domain errors need a **stable machine-readable `code`**; the kit's filter
does not yet pass one through, so a small additive change to it is an implementation prerequisite (section 21; the kit's status-text table also has no `502`, which `provider_error` needs): `{ statusCode, message, error, code?, requestId }`.
Messages are generic; no stack, SQL, constraint name, provider payload or credential ever reaches a response [D].

| Code | HTTP | When |
|---|---|---|
| `invalid_payment_request` | 400 | body fails validation, unknown fields, bad party or amount |
| `idempotency_key_required` | 400 | a required `Idempotency-Key` is missing or malformed |
| `unauthorized` | 401 | missing or invalid service token or user bearer (or an inactive identity) |
| `operation_not_permitted` | 403 | the caller sees the payment but may not do this |
| `not_found` | 404 | no such resource, **or the caller has no relation to it** (collapsed) |
| `payment_request_conflict` | 409 | same `paymentRequestId`, different snapshot |
| `payment_not_payable` / `payment_expired` | 409 | the payment is terminal or expired |
| `payment_has_open_attempt` | 409 | an attempt is `initiated`, `submitted` or `unknown` |
| `invalid_state_transition` | 409 | the state machine forbids the move |
| `cash_submission_exists` / `cash_already_confirmed` / `cash_already_rejected` | 409 | duplicate or repeated cash operations |
| `refund_conflict` / `payment_not_refundable` | 409 | same `clientReference` with different content; payment not refundable |
| `idempotency_key_reused` | 422 | the same key with different content |
| `refund_exceeds_refundable` | 422 | the sum of refunds would exceed the amount paid |
| `refund_amount_not_allowed` | 422 | a partial refund while partial refunds are not approved (O-6) |
| `unsupported_currency` / `invalid_provider` | 422 | not in the configured lists |
| `provider_error` | 502 | the provider answered with an unusable result |
| `provider_unavailable` / `auth_unavailable` | 503 | provider or Auth cannot be reached; fail closed |
| `webhook_signature_invalid` | 401 | webhook route only: verification failed (generic body, distinct so operators can count forged calls) |

## 11. Event catalog

Events go through the **transactional outbox** (kit), in the same transaction as the state change, and are published at least once to the
`nawara.events` topic exchange; routing key = event name [D, ADR-0037]. Message **headers** carry `eventId`, `occurredAt`, `correlationId`,
`source` (`payment-service`) and `version` (kit `EventHeaders`). The event id is derived **deterministically** from the aggregate and the
transition (a name-based, version-5 style uuid computed in the service: Node has no built-in one), so a retried transition cannot enqueue a second event [T]. Payloads carry opaque ids and plain facts,
**never a secret, a token, provider credentials or card/bank data**. Ordering is not guaranteed; consumers use `revision` and their inbox. `correlationId` is optional in the kit's headers: it is set from the request when there is one, and **system-initiated events** (webhook processing, sweeps, resolvers) set it to the id of the webhook event or to a fresh id generated per job run, so every event has one.

Common payload for every payment event: `paymentId`, `paymentRequestId`, `sourceType`, `sourceId`, `organizationId`, `payer{type,id}`,
`seller{type,id}`, `amount`, `currency`, `status`, `revision`, `actor{type,id}` (`user`, `service`, `provider` or `system`) and
`cause{type,id}` (the request, webhook event, sweep or cash decision that caused it; the correlation id is in the header, and `cause` is the
causation reference). Amounts are JSON integers in minor units. Version `1` for all events below; a breaking payload change publishes a higher version under the same name.

| Event | Emitted on | Extra payload | Consumers | Justification |
|---|---|---|---|---|
| `payment.created` | `created` accepted | none | audit, analytics | correlation of a request with its payment; billing may confirm receipt |
| `payment.succeeded` | to `succeeded` | `settledMethod`, `succeededAt` | **billing** (invoice paid, entitlement), **accounting** (journal entry), notification (receipt), audit, analytics | the central financial fact |
| `payment.failed` | to `failed` | `failureCode` | billing, notification, audit | billing must know collection ended |
| `payment.cancelled` | to `cancelled` | none | billing, audit | closes the request from payment's side |
| `payment.expired` | to `expired` | `expiresAt` | billing, notification, audit | same |
| `cash_payment.submitted` | cash `submitted` | `cashPaymentId`, `submittedBy` | notification (reviewers), audit | a human decision is now pending |
| `cash_payment.confirmed` | cash `confirmed` | `cashPaymentId`, `confirmedBy` | audit, notification | who decided is a required audit fact |
| `cash_payment.rejected` | cash `rejected` | `cashPaymentId`, `rejectedBy`, `rejectionReasonCode` (a bounded code; the free-text reason stays in the database only, because it may contain personal data: O-17) | audit, notification | same |
| `refund.requested` | refund `requested` | `refundId`, `refundAmount`, `reasonCode` | audit, notification | money is about to move back |
| `refund.succeeded` | refund `succeeded` | `refundId`, `refundAmount` | **accounting** (reversal), billing (credit), notification, audit | the accounting-relevant refund fact |
| `refund.failed` | refund `failed` | `refundId`, `failureCode` | notification, audit | the requester must know |

Deliberately **not** emitted in this phase: `payment.pending` (an internal state; no consumer needs it; notifications about an amount owed come
from billing), `payment.processing`, per-attempt events, and `payment.refunded` (the refund events carry that fact; the earlier draft catalog
in the architecture documents is superseded by this list). Payment publishes; **who consumes is each consumer's design**: billing and accounting
SDDs do not exist yet.

## 12. Transaction boundaries, key components, flows and failure modes

**Rules [T]:** provider calls happen **outside** database transactions; every state change is one short transaction that (1) locks the
payment row `FOR UPDATE`, (2) re-checks the state, (3) applies a conditional update, (4) writes the outbox event; database time is the only
clock; no transaction spans a network call. **Lock order is fixed to prevent deadlocks: the payment row first, then its attempt, cash or refund rows** (the webhook processor follows the same order; it finds the attempt without locking, then locks the payment, then re-reads and locks the attempt). The T2 conditional update accepts the expected states `initiated` **or** `unknown`, so a resolver that got there first does not make the provider's real answer fail.

| Operation | Transactions |
|---|---|
| Create payment | one: insert payment, insert outbox `payment.created` |
| Start attempt | **T1:** idempotency row, attempt `initiated`, payment `created` to `pending` (commit). Then call the provider with `merchantReference`. **T2:** record `submitted` (with `providerTransactionId`), or `failed`, or `unknown` |
| Webhook | **A:** insert the event (dedupe). **B:** lock, transition, outbox, mark processed |
| Cash confirm | one: lock payment and cash row, transitions, outbox (`cash_payment.confirmed`, `payment.succeeded`) |
| Refund request | one: lock payment, cap check, insert refund, outbox `refund.requested`; the refund attempt then runs like an attempt |
| Expiry sweep | per payment: lock (**skipping a payment another transaction holds**: it is re-checked on the next pass, Stage 15.8), re-check no open attempt (`initiated`, `submitted`, `unknown`), no cash submission in `submitted`, and `now() >= expiresAt`; transition; outbox |

**Background work (in-process, database-clock driven) [T]:** the outbox relay (kit); an **expiry sweeper**; an **attempt resolver** that finds
attempts stuck in `initiated`, `unknown` or long-`submitted` beyond their thresholds and settles them by asking the provider (by `merchantReference`), under the rules of section 5.2 (Stage 15.8: an instance first claims the attempt with a short lease, `resolveAfter`, so N instances make one provider call per attempt per lease, not N); a **stuck-payment alert** for any payment `pending` longer than a threshold; a retry pass for
`unmatched` and `failed` webhook events **and a stuck-state sweep for events left in `received` or `processing` beyond a threshold** (a crash between transactions A and B); a refund retry and resolver job (section 5.4). Full periodic reconciliation of payment state against provider reports is [X].

| Failure | Handling |
|---|---|
| Timeout or connection loss during the provider call | attempt `unknown`; never retried blindly; resolved by lookup or webhook |
| Crash after the provider accepted but before T2 | the row stays `initiated`; the resolver finds it by `merchantReference` |
| Webhook before our T2 commit | `unmatched`, retried for a bounded time, matched by `merchantReference` |
| Duplicate, replayed or out-of-order webhook | section 7; no double effect |
| Broker unavailable | outbox keeps the event; business transactions are unaffected |
| Auth unavailable | user operations fail closed with `503`; service-token operations and webhooks continue |
| Database unavailable | `/ready` fails; requests fail; nothing is half-applied (single transactions) |
| Two concurrent operations on one payment | the row lock serializes them; the second re-checks the state and fails with `409` if no longer valid |
| Provider says success for an amount or currency that differs from the snapshot | not applied; `conflict`, alert |

### 12.1 Key interfaces and classes [T]

| Component | Responsibility |
|---|---|
| Controllers (`Payments`, `Attempts`, `Cash`, `Refunds`, `Webhooks`) | HTTP only: DTO validation (unknown fields rejected), authentication guard, call one service method, map to the error model. No business rules |
| `PaymentStateMachine` | the pure transition tables of section 5 (from, to, cause, condition); used by the services **and** by the trigger tests, so code and database cannot drift |
| `PaymentService` | create (natural idempotency), read, cancel, expiry transition; owns the payment row transitions |
| `AttemptService` | start an attempt (T1, provider call, T2), sync with the provider, record verified results; owns attempt rows |
| `CashService` | submit, confirm, reject; owns cash rows |
| `RefundService` | request (cap and capability checks), refund attempts, refund transitions |
| `WebhookService` | verify (adapter), persist, deduplicate, process (transaction B); owns `webhook_event` |
| `IdempotencyService` | `Idempotency-Key` handling (section 6); natural keys live in the services' unique constraints |
| `AuthorizationService` | the **only** place that establishes a caller's relation to a payment and applies the operation rules of section 8; uses the kit's `AuthClient` and the combined service-token-or-user guard; returns the collapsed `404` |
| `ProviderRegistry`, `PaymentProvider` adapters | the provider port of section 13; the test provider first |
| `PaymentEvents` | builds the event payloads of section 11 with deterministic ids and writes them through the kit's `OutboxService` |
| Background jobs | `ExpirySweeper`, `AttemptResolver`, `WebhookRetrier`, `RefundResolver`, `StuckPaymentMonitor`; the kit's outbox relay publishes |
| Repositories | parameterized SQL only; a `withPaymentLock(paymentId, fn)` helper applies the fixed lock order |

**Consumed contracts** (summary): the **producer contract** of section 3.1; **Auth** `GET /auth/me` returning `{ id, adminTier, isActive, memberships[ { id, organization{id}, platform{id}, status, isOrganizationAdmin } ] }`, empty for owners and operators (read through the kit's `HttpAuthClient`); each **provider's** API and webhook scheme (defined per adapter, deferred); the **broker** (`nawara.events`).

### 12.2 Important flows [T]

**Create payment.** (1) The producer sends the contract with its service token. (2) The guard identifies the caller. (3) Validate the body, currency and party rules. (4) One transaction: insert the payment (`created`) or find the identical one, and enqueue `payment.created`. (5) Return `201`, or `200` on an identical replay, or `409` on a conflicting one.

**Pay by gateway.** (1) The payer asks to start an attempt with an `Idempotency-Key`. (2) The guard asks Auth for the identity; `AuthorizationService` establishes the relation. (3) T1: lock the payment, require `created` and not expired, insert the attempt `initiated`, move the payment to `pending`, commit. (4) Call the provider with `merchantReference`. (5) T2: record `submitted` with the provider transaction id and return `nextAction`; or `failed`; or `unknown`. (6) The payer completes at the provider. (7) The provider sends a signed webhook: verify, persist, then transaction B locks the payment, checks amount and currency against the snapshot, sets the attempt and the payment to `succeeded`, records `succeededAttemptId`, and enqueues `payment.succeeded`. (8) If the webhook is late or lost, `sync` or the resolver reaches the same result from the provider's status.

**Cash.** (1) An authorized submitter posts a cash submission (`created` to `pending`; `cash_payment.submitted`). (2) An authorized person confirms: one transaction sets the cash row `confirmed`, the payment `succeeded` with `settledMethod = cash`, and enqueues `cash_payment.confirmed` and `payment.succeeded`. (3) Or rejects: the cash row becomes `rejected` and the payment returns to `created` (PROPOSED — NOT APPROVED default, O-5). A repeated decision returns `409` and changes nothing.

**Refund.** (1) An authorized requester posts `clientReference` and an amount. (2) One transaction: lock the payment, require `succeeded`, check the capability and the cap (full refund only until O-6), insert the refund `requested`, enqueue `refund.requested`. (3) The refund attempt runs like a payment attempt against `succeededAttemptId`. (4) A verified result sets `succeeded` (`refund.succeeded`) or `failed` (`refund.failed`, reservation released). The refund resolver retries `requested` refunds and settles `unknown` refund attempts.

**Expiry.** The sweeper finds payments with `expiresAt` reached, locks each, re-checks that no attempt is open and no cash is awaiting review, and moves it to `expired` with `payment.expired`. A payment blocked by an open attempt is settled by the resolver first.

**Recovery.** After a crash or timeout the resolver settles `initiated`, `unknown` and long-`submitted` attempts, and the webhook retrier reprocesses `received`, `processing`, `failed` and `unmatched` events; nothing depends on the original request being retried.

## 13. Provider port and test provider

### 13.1 The port [T]

Payment depends on an interface, never on a vendor. Provider-specific fields live in `providerData` (opaque, adapter-owned, no secrets) and in
adapter code.

```
PaymentProvider {
  id: string
  capabilities: { refunds, partialRefunds, notFoundIsAuthoritative, visibilityLagMs, timeoutMs, sessionExpiry, paymentFatalCodes }
  initiate(payment, attempt)        -> accepted{providerTransactionId, nextAction} | rejected{class, code} | ambiguous
  fetchStatus(ref)                  -> succeeded{amount, currency} | failed{class, code} | pending | notFound   // ref = providerTransactionId or merchantReference
  verifyWebhook(rawBody, headers)   -> verified{providerEventId, type, reference, amount?, currency?, data} | rejected
  refund(payment, refundAttempt)    -> accepted{providerRefundId} | rejected{class, code} | ambiguous
  fetchRefundStatus(ref)            -> succeeded | failed | pending | notFound
}
```

Adapter contract: **the amount and currency the provider reports are checked against the snapshot before any success is applied** (a mismatch is a `conflict`, section 12); the adapter declares whether a `notFound` answer is authoritative, how long the provider's records lag, its timeout, whether it can tell that a session has ended, and which codes mean the payment itself is unrecoverable; methods are safe to retry given the same `merchantReference`; failures are classified `retryable`, `terminal` or
`ambiguous`; secrets come from the secret store (`NAME_FILE`) and never appear in a table, a log or an event.

### 13.2 The deterministic test provider (defined here, **not implemented**) [T]

Purpose: exercise every path without a real gateway. It is enabled only by configuration (`PAYMENT_TEST_PROVIDER=true`) and the service **refuses
to start** with it enabled when `NODE_ENV=production`. Behaviour is selected by `providerOptions.scenario`:

| Scenario | Behaviour |
|---|---|
| `success` | accepted; a signed success callback is delivered by the test harness |
| `failure` (with a code) | rejected or a failure callback, `terminal` or `retryable` as requested |
| `timeout_before_accept` | ambiguous with no provider record: resolves to `notFound` then `failed` (retryable) |
| `timeout_after_accept` | ambiguous but the provider **did** record it: resolves by lookup or callback |
| `retry` | first attempt fails retryably; the next succeeds |
| `duplicate_callback` | the same signed event delivered twice or more |
| `delayed_callback` | the callback is delivered only when the test says so (a controllable clock) |
| `out_of_order` | a later-lifecycle event delivered before an earlier one |
| `refund_success` / `refund_failure` | refund behaviours mirroring the above |

Callbacks are signed with a test secret (HMAC) so the **real verification code path** runs; deliveries are made by an in-process harness (no
network) so tests are deterministic. A test **producer fixture** (a test service token calling `POST /payment/payments`) stands in for billing.

## 14. Billing integration boundary

```
Product service ─▶ Billing service ─▶ POST /payment/payments (payment request snapshot) ─▶ Payment service
                                          ◀── events: payment.succeeded, failed, cancelled, expired, refund.* ── (never a call back)
```

Payment does not create invoices, does not calculate product prices, does not hold entitlement state, and never calls billing to learn whether a
payment succeeded or what was owed: it operates from the snapshot. **Billing-service does not exist**, so until it does, development and tests use
the **producer fixture** described above, sending requests that conform to section 3.1 with a test service token. No billing stub *service* is built.
The billing SDD must define how it reacts to payment events and how it cancels.

## 15. Accounting integration boundary

Payment emits `payment.succeeded` and `refund.succeeded` (and the other events); the future accounting-service consumes them idempotently (by
`eventId`) into a double-entry ledger. Payment keeps **no** ledger, journal, chart of accounts or tax logic, and computes no fees. Fees are [X].

## 16. Configuration, security and observability

| Setting (environment) | Meaning |
|---|---|
| `DATABASE_URL` | runtime connection, **least-privilege role** (`payment_app`), never a superuser |
| `MIGRATION_DATABASE_URL` | schema-owner role, used only by the explicit migration step |
| `SERVICE_TOKENS` | accepted callers, `<caller>:<sha256 digest>` (kit) |
| `AUTH_SERVICE_URL`, `AUTH_TIMEOUT_MS` | live identity and membership |
| `RABBITMQ_URL` | event bus (a broker outage never blocks business work) |
| `PAYMENT_SUPPORTED_CURRENCIES` | configured list, no code default [O-10] |
| `PAYMENT_MAX_ATTEMPTS` | attempt limit, no business meaning [T] |
| `IDEMPOTENCY_TTL_HOURS` | retention of header keys |
| `PAYMENT_RETURN_URL_ALLOWLIST` | allowed `returnUrl` origins |
| `PAYMENT_TEST_PROVIDER` | test provider switch; refused in production |
| provider secrets (`PAYMENT_PROVIDER_<ID>_*` via `NAME_FILE`) | never stored in tables, logs or events |
| `PORT`, `NODE_ENV`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS` | kit base configuration (fail-closed, values never echoed) |

Security: every external input is validated (unknown fields rejected); amounts and currency come from the snapshot, never from a user request;
`userId`, `organizationId`, `platformId`, `role`, `permissions`, `amount`, `currency`, and beneficiary are never trusted from a client; rate limiting is
required on payment creation, attempts, cash operations and the webhook route (**the service-kit has no rate limiter yet: a prerequisite**);
errors are sanitized; logs carry request and correlation ids and **never** bodies of webhooks, secrets or card/bank data. Descriptive fields
(`description`, `reference`, `note`) are length-bounded and treated as untrusted text. Observability: counters for payments by status, webhook
outcomes, attempts in `unknown`, `unmatched` webhooks, expiry and resolver activity, outbox lag; alerts on stuck `unknown` attempts, `conflict`
webhooks, and outbox age.

## 17. Test strategy

Unit, integration against real PostgreSQL, API and security tests; each row below must exist before the feature is considered done.

| Area | Cases |
|---|---|
| Money and contract | invalid amount, currency, party; snapshot immutability; identical replay; conflicting replay |
| State machines | every allowed transition; every forbidden one rejected **by the database trigger** as well as by code; terminal states final |
| Recovery and stuck states | a `submitted` attempt with no webhook is settled or alerted after the TTL; a crash between webhook transactions A and B is reprocessed on the duplicate delivery; a stuck `initiated` attempt is resolved without a double charge; a success for an **inferred** failure is accepted, a success for a provider-confirmed failure is a `conflict`; cancel and expiry are refused while an attempt is open or cash is awaiting review; two payments locked in opposite orders never deadlock (fixed lock order) |
| Concurrency | 8 simultaneous identical creates give one row; two attempts at once give one open attempt; concurrent cash confirmations give one decision; concurrent refunds never exceed the cap; unique provider ids |
| Idempotency | same key same content (replay); same key different content (`422`); expired key; natural keys beyond expiry |
| Provider (test provider) | amount or currency differing from the snapshot is a `conflict`; success; failure retryable and terminal; timeout with and without a provider record; retry; delayed, duplicate and out-of-order callbacks |
| Webhooks | forged signature rejected and not persisted; duplicate; out of order; unmatched then matched; malformed; conflict; transient failure retried |
| Cash | submit, confirm, reject; confirmer is not the payer; repeated decision refused; unauthorized attempts refused |
| Refunds | request, success, failure, reservation released on failure, exceeds refundable, partial refused until approved, not-succeeded payment, provider without the refund capability, cash payment refused, refund executed against `succeededAttemptId` |
| Isolation and authorization | a user in organizations A and B cannot reach organization C; organization A cannot read B (collapsed `404`); a pending or revoked membership grants nothing; the payer of one payment cannot read another's; the organization-as-merchant and organization-as-payer flows; Auth down fails closed |
| Events | an event exists if and only if the transaction commits; duplicates absorbed by the inbox of a test consumer; no secret in any payload |
| Security | service token missing, wrong, or a user token presented as a service token; secrets never in logs or responses; oversized or unknown-field bodies |

## 18. Deferred [X]

Real gateway adapters (Flouci, Konnect, Paymee, Stripe) and their signature schemes; organization payment accounts; settlement; payouts;
fees; custody; wallet or balance; any merchant-of-record behaviour; full periodic reconciliation against provider reports; withdrawing a cash
submission; cancelling a requested refund; administrative or support tooling; caching of Auth answers; outbox and inbox pruning; consumers of
events (the inbox is unused in this phase).

## 19. Open business, legal and architecture decisions

**Resolving ADRs to be written (pointers):** O-1, O-2, O-3 to an ADR on providers, merchant of record and settlement; O-4, O-5, O-6, O-18, O-20 to an ADR on the payment-domain authorization model; O-13, O-14, O-15 to an ADR on producer service-token scopes and hierarchy validation without user context (which also touches the deferred organization-service mechanism, ADR-0031); O-7 to an ADR on partial payments; O-10 to a currencies decision; O-12 to an Auth or billing ADR. Nothing below is decided or invented. "Can implementation proceed?" refers to **the parts of the service not touched by the decision**.

| # | Decision | Why it matters | Components affected | Can implementation proceed without it? | Must be decided before |
|---|---|---|---|---|---|
| O-1 | **Provider contracts, fees, refunds and disputes** | defines what each provider can do, its signature scheme, refund and dispute rules | provider adapters, webhook verification, refund capability, chargebacks | yes, with the test provider | any real adapter |
| O-2 | **Merchant-of-record model** | who is legally the seller to the customer; who bears disputes and liability | seller semantics, refunds, disputes, receipts | yes | any organization-as-merchant flow in production |
| O-3 | **Settlement, custody, timing, currencies** | whether and how money reaches organizations | organization payment account, fees, payouts | yes (deferred) | the settlement phase |
| O-4 | **Who may submit cash** | payer, seller-side staff, or both | cash submission authorization | yes, except the submit endpoint | implementing endpoint 6 |
| O-5 | **Who may confirm or reject cash**, whether the confirmer may equal the submitter, whether a rejection ends the payment, and how the authority is modeled | the only guard against a false "paid" | cash authorization, `cash_payment` constraints, state machine | yes, except endpoints 7 and 8 | implementing endpoints 7 and 8 |
| O-6 | **Who may refund**, partial refunds, refunds of cash payments, step-up | money leaves; abuse risk | refund authorization and scope, cap logic | yes, except refunds | implementing endpoint 10 |
| O-7 | **Partial payments** | one request vs several payments | uniqueness on `(producer, paymentRequestId)`, invariants | yes (v1 is one payment per request) | if partial payments are wanted |
| O-8 | **Dunning** | reminders and retries after failure | billing more than payment; payment's attempt limit | yes | billing's dunning design |
| O-9 | **Legal issuer and tax identity** | who issues Nawara's invoices; tax content | billing and accounting; payment only carries parties | yes | billing and accounting SDDs |
| O-10 | **Supported currencies beyond TND** | exponent table and provider support | currency table, validation | yes (configured list) | adding a currency |
| O-11 | **Trials** | whether subscriptions start with a trial | billing entitlement; payment unaffected until a paid step | yes | billing SDD |
| O-12 | ~~**Auth's registration/join entitlement check**~~ **RESOLVED (Stage 12.1, ADR-0044): removed entirely, not repointed.** *Historical:* Auth called `GET /payment/licenses/:organizationId/status` (`apps/auth-service/src/payment/payment-client.ts`, now deleted); keep, repoint to billing, or remove | Auth client, billing entitlement API | yes **only while payment-service is not deployed to production**; once it is, that Auth route must exist or be repointed first | deploying payment-service to production |
| O-13 | **Which product services may create billable obligations** | who can cause payments to exist | service-token issuance and authorization | yes | enabling any producer beyond the test fixture |
| O-14 | **Service-token scopes for those producers** | limits which organizations a producer may bill | `ServiceTokenGuard` scope model (the kit guard has no scopes) | yes | endpoint 1 in production |
| O-15 | **How organization to platform to company is validated with no user context** | a producer asserts `organizationId`; nothing verifies it | endpoint 1, isolation | yes (asserted value) | production use by non-trusted producers |
| O-16 | **Maximum payment lifetime, and whether a payment may have no expiry** | unbounded open payments, stuck `pending` payments | expiry sweep, config, stuck-payment alert | yes | production |
| O-19 | **What ends a payment as failed**: the attempt limit and its value, whether a declined attempt should end the payment | a decline ending the payment forces billing to issue a new request; not ending it lets the payer retry | payment state machine, `PAYMENT_MAX_ATTEMPTS` | yes (defaults in section 5.1: retry until the limit or expiry) | production |
| O-20 | **Who may *read* a payment beyond its producer and payer** (organization members, seller staff) | privacy: payer, amount and reference become visible | read authorization, isolation tests | yes (no organization read access until decided) | any organization-facing screen |
| O-17 | **Retention and privacy of raw webhook bodies and payment records** | legal retention and data protection | `webhook_event`, pruning | yes | production |
| O-18 | **Who may pay on behalf of an organization** (for example an organization paying Nawara) | payer authorization for an organization | endpoints 3 and 4 for organization payers | yes, for user payers | implementing organization-payer flows |

## 20. Architecture consistency check

This SDD introduces none of the following, and each is checked in review:

| Must not appear | Where this SDD stands |
|---|---|
| `User.organizationId`, `User.platformId`, product-specific user roles, a second membership store | none; only opaque ids and Auth's live answer |
| Invoice ownership, an accounting ledger, a tax engine, a wallet or custody model, subscription or entitlement state | none; fees, settlement and balance are [X] |
| Cross-service foreign keys or queries | none; all foreign keys are inside payment's own database |
| Admin or user JWT forwarded between services | none; service tokens between services; the user's bearer only to Auth |
| A synchronous payment-to-billing dependency | none; snapshot in, events out |
| Payment doing Auth's job or Auth doing payment's | Auth answers identity and membership; payment decides payment operations |
| Country-specific tax logic, product names, hard-coded currencies | none; currencies are configured; only neutral examples |
| An organization anchor or copy in Auth, a new tenant layer | none; Company, Platform and Organization are untouched (ADR-0031) |

## 21. Implementation plan

**Prerequisites that live outside payment-service (small, in the service-kit):**

1. an additive `code` field in the error body, and a `502` entry in its status text (section 10), with a note in ADR-0034;
2. raw-body capture for the webhook route (section 7): verify first whether Nest's `rawBody` option together with `useBodyParser` can be set in payment-service itself, in which case no kit change is needed;
3. a baseline rate limiter (section 16);
4. a combined service-token-or-user guard, and optionally scopes in the service-token model (O-14).

**First implementation task after this SDD is approved:** *convert the payment-service starter into a kit-based service with no domain* (Stage 1):
configuration through `loadBaseConfig`, `HealthModule`, `DbModule` on the `payment` database with the runtime role, `ServiceAuthModule`, `EventsModule`
(in-memory bus for tests, RabbitMQ by configuration), OpenAPI and the basic-auth guard for `/payment/docs`, a Dockerfile, `.env.example`, a README, an
empty service migrations folder wired to the kit migrations, and tests for configuration, health versus readiness, the service-token guard and the
migration/readiness behaviour. **No table, endpoint or domain type from this document is created in that task.**

The remaining order (schema and triggers, creation, test provider and attempts, webhooks, events, isolation, then cash after O-4 and O-5 and refunds after O-6) is planned per feature in TDDs (`docs/tdd/`), not here. Real gateways and settlement stay deferred.

## 22. Implementation readiness gate

This gate applies per feature, not to the document as a whole: a feature enters domain implementation only when, for **that**
feature:

1. every `[D]` and `[T]` prerequisite it needs is satisfied (including the service-kit prerequisites of section 21);
2. no unresolved `[B]` decision is required by the code being written (section 0.1, 0.2); if one is, only the independent portion
   proceeds and the business-dependent portion stays blocked or explicitly isolated;
3. no `[X]` deferred functionality is implemented as a side effect of implementing something else;
4. the financial invariants of section 4.10 that apply to the feature have corresponding enforcement (constraint, trigger,
   transaction/lock, or application check) and a corresponding test in section 17;
5. the authorization boundary for the operations being implemented is defined (section 8.4) — not `[B]` for those operations;
6. idempotency behaviour for the operations being implemented is covered by tests (section 6, 17);
7. provider success, timeout and conflict handling relevant to the feature is covered by tests (section 12, 13, 17), where the
   feature touches a provider path;
8. transactional outbox behaviour for the events the feature emits is covered by tests (section 4.9, 11, 17), where the feature
   emits an event.

This SDD is **not** fully approved for implementation as a whole: section 19 lists decisions still open. Cash (endpoints 6 to 8),
refunds (endpoint 10), organization-payer flows, and production use of endpoint 1 by non-trusted producers each depend on at least
one unresolved `[B]` decision (O-4, O-5, O-6, O-13, O-14, O-15, O-18, O-20) and remain blocked under this gate until that decision is
recorded as `[D]`. The independent portions — the Stage 1 conversion, the schema and state machines, the test-provider gateway path
with the test producer fixture, and the webhook pipeline — are not blocked by those decisions and may proceed under section 21's
plan.
