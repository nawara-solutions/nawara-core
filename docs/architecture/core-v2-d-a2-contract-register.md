# Core V2 D-A2: contract register (proposed)

- **Status:** PROPOSED CONTRACT REGISTER, prepared 2026-10-22 under the architecture owner's D-A2 documentation authorization, on `main`
  at `42f3f8b01cc06f22ef8bc87bc4845ea62fef0f67` (the PR #321 merge of the [S1–S8 execution roadmap](./core-v2-s-execution-roadmap.md)).
- **Scope:** the eight Core services (Auth, Organization, Billing, Payment, File, Notification, Audit, Release) and the event families
  of the S1–S8 stages.
- **What it is:** documentation item DOC-2 ([roadmap](./core-v2-s-execution-roadmap.md) §1.4, §8): a **newly proposed** technical
  register of routes, events, DTOs, error codes and idempotency mechanics for the frozen Core V2 architecture.
- **What it is not:** a recovery of the original AR-04.6 register. That register exists only in the architecture-review packages,
  which are not in the repository ([S0 record](./core-v2-s0-architecture-freeze.md), labels note); its route, DTO, error and
  idempotency details could not be recovered and are **not** presented here as historical facts. It is not an ADR, an approval of any
  PROPOSED item, an implementation authorization or a change to S0. Documenting a proposal does not approve it. Where this register and
  the S0 record or an ADR differ, they govern. **No Core V2 contract in this register is implemented unless its entry says so.**
- **Companion:** the full Auth receipt contract is in
  [`core-v2-d-a2-auth-authorization-receipts.md`](./core-v2-d-a2-auth-authorization-receipts.md); entries AUTH-01 to AUTH-03 summarize
  it.

## 1. How to read an entry

Every entry has a stable identifier (`AUTH-nn`, `ORG-nn`, `BIL-nn`, `PAY-nn`, `FIL-nn`, `NOT-nn`, `AUD-nn`, `REL-nn`, `EVT-nn`) and five
parts:

| Part | Content |
|---|---|
| **A. Frozen behaviour** | what S0 or an S0-approved ADR requires, with its source; FROZEN |
| **B. Route and DTO** | caller and scope, route or event name, request and response; PROPOSED unless marked IMPLEMENTED or FROZEN |
| **C. Errors and idempotency** | stable error codes and the idempotency class with its permanent uniqueness guard |
| **D. Existing implementation** | what exists on `main` today, with its path; "none" when nothing exists |
| **E. Open decisions and gates** | open decisions (§7), implementation gates, planned stage, confidence |

Labels: **IMPLEMENTED** (in code on `main`), **FROZEN** (S0 or S0-approved ADR wording), **PROPOSED** (new here; Owner approval at
implementation review, S0 §3.10), **OPEN** (not safely definable from the sources; an Owner decision is required). A route is never
FROZEN because the behaviour behind it is; the only route named in a frozen source is BIL-11 (ADR-0044 B6).

Confidence: **H**, the source fixes both behaviour and shape; **M**, the behaviour is frozen and the shape proposed; **L**, the source
gives only a capability label, so most of the entry is OPEN.

Common rules, not repeated per entry:

- Every new error code needs a catalog entry and localized messages ([ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md)).
- Every route documents itself in OpenAPI (repository convention, `CLAUDE.md`).
- Every human authority is verified live through Auth per request; if it cannot be verified the request fails closed with `503` and
  no mutation (S0 §3.6, §8; [ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md)). Billing and Payment use
  the existing code `auth_unavailable` (IMPLEMENTED in Payment) or a Billing equivalent (PROPOSED).
- No receipt secret or step-up proof is ever stored in an idempotency record, a replay hash, a log line or an audit event (receipt
  contract §12).
- Production refuses non-live records and events: every money record and event carries `liveMode` (S0 §3.8 FC-10).

## 2. Idempotency classes

Only class M and the event rules are FROZEN. The taxonomy itself is **PROPOSED** and its approval is **OPEN (Q10)**.

| Class | Use | Mechanics | Label |
|---|---|---|---|
| **M** | money commands: anything that creates a payment, a settlement channel, a refund attempt or a money-bearing invoice | retention **90 days**, always backed by a permanent business or financial uniqueness key | FROZEN ([OD] D7; S0 §3.7) |
| | | `Idempotency-Key` required; record scoped by (caller, operation, key) with a replay hash; an identical replay returns the stored outcome; a different request under the same key `409 idempotency_key_reused`; a concurrent duplicate `409 idempotency_key_in_use` | PROPOSED (precedent IMPLEMENTED: Payment `apps/payment-service/src/idempotency/`, File `idempotency_key_in_use`) |
| **K** | administrative and authorization commands that move no money (decisions, corrections, configuration) | as M, without a money record; **retention OPEN (Q10)** | PROPOSED / OPEN |
| **N** | commands idempotent by a permanent natural key; no header (fact ingestion, consumption by `consumeRef`, a projection keyed by its id) | an identical repeat converges on the same row; a conflicting repeat is refused or recorded as a conflict | PROPOSED |
| **R** | reads | none | PROPOSED |
| **E** | events | deterministic event id; per-consumer provenance; broker-verified producer | FROZEN ([ADR-0057](../adr/0057-messaging-conventions.md) §13; S0 §3.7) |
| **X** | AUTH-01 only | the ADR-0067 replay rule: no stored response is ever returned, because the secret is never stored | FROZEN (ADR-0067 decision 2) |

Payment's current ceiling (`IDEMPOTENCY_TTL_HOURS`, default 24, maximum 720 hours, `apps/payment-service/src/config/payment-config.ts`)
is replaced by class M at implementation (S0 §3.7; roadmap S4g).

## 3. Frozen invariants preserved by every entry

| # | Invariant | Source |
|---|---|---|
| I-1 | Explicit, immutable routing: `organization_subscription → organization`, `direct_purchase → personal`, `assisted_settlement → personal`, `recovery_settlement → none`; the target is independent of `entitlementKind` | [ADR-0044](../adr/0044-subscription-entitlement-final-model.md) B1, B2; S0 §3.2 (DB-3, DB-4, DB-9); S-5 |
| I-2 | A recovery settlement has target `none` and never creates or changes a subscription or a purchase | S0 §1.4; ADR-0044 B2, B8 |
| I-3 | Organization Subscription grace exactly 24 hours, computed in UTC and frozen per period; Personal Subscription grace none | S0 §1.4, §3.9; ADR-0044 B13 |
| I-4 | Direct and assisted personal purchases are separate from the Organization Subscription: a personal or recovery invoice never changes `subscription` on any path; an Organization pays only for assisted or recovery purposes | ADR-0044 B3, B4, B7; S0 DB-9, DB-11, DB-15; S-4, S-6; roadmap §4.3 |
| I-5 | Full-purchase refunds only in initial Core V2; at most one entitlement reversal per purchase, causes appended separately | [OD] D4; S0 FC-4, V-1; ADR-0044 B5 |
| I-6 | Every distinct provider money movement is an immutable fact committed independently of allocation; facts are never refused, edited or deleted; raw webhooks stay in `webhook_event` | S0 FC-1, V-2; [ADR-0035](../adr/0035-financial-service-boundaries.md) C2 |
| I-7 | Late assisted settlement L-1 to L-6 | S0 §3.4; ADR-0044 B14 |
| I-8 | Recovery surplus R-1 to R-5: owed to the school, never revenue, loss or access, no expiry, never re-opens or extends T3 | S0 §3.5; ADR-0044 B8 |
| I-9 | `FinancialLoss` only from provider-fact evidence or an owner write-off of an unrecoverable recovery obligation | S0 §1.4, FC-6; ADR-0044 B11; ADR-0035 C3 |
| I-10 | No second checkout while a payment is uncertain | S0 §1.1 |
| I-11 | T1 (overdue settlement), T2 (overdue cash return), T3 (recovery after an assisted final-lost chargeback) and inactivity (D6) block **new** assistance requests only; discharge stays available | S0 §1.2, FC-9; [OD] D6; DN-1 |
| I-12 | Actual physical cash collection starts the 72-hour deadline (`settleBy = cashCollectedAt + 72h`); report time is separate | S0 §1.2 (D-6), FC-8 |
| I-13 | No manual or trust-based cash settlement of Nawara-sold products | [ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md); S0 DB-16, S-7, FC-11 |
| I-14 | Core V2 is implemented and certified against a simulation provider only; production refuses the test or simulation provider | S0 §1.1, FC-10 |
| I-15 | Broker-verified producer provenance and per-family topic permissions for every event family | ADR-0057 §13; [ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md) decision 1; S0 §1.2 (D-2/D-3) |
| I-16 | No new refund case while a payment dispute is open; a completed refund case refuses every new attempt (`409 refund_case_completed`) | [OD] D3; S0 FC-3, V-3 |
| I-17 | A provisional dispute never cancels Premium; a direct purchase lost at final stage reverses only that purchase and is written off; an assisted purchase lost at final stage keeps the student protected and opens a school recovery obligation for the base amount only | S0 §1.1; ADR-0044 B10; [OD] D5 |
| I-18 | Fee caps set and approved by the Owner; delegated operators propose; operators never approve | S0 §1.1 |
| I-19 | One currency per Platform | S0 §1.1 |
| I-20 | Payment never calls Billing back | ADR-0035 C4 |

**Provider authenticity (I-6 with existing behaviour).** Today payment-service accepts a provider webhook only with a valid provider
signature (`401 webhook_signature_invalid` otherwise) and stores unparseable signed bodies without processing them
(`apps/payment-service/src/webhooks/webhook.service.ts`) (IMPLEMENTED). PROPOSED for S4d: a `provider_transaction_fact` is created only
from an authenticated provider message (a signature-verified, parsed webhook, or a provider status read over the provider's
authenticated channel); a malformed, unverified or forged input never becomes a verified financial fact, and an authenticated message
is preserved as evidence even when its commercial processing fails.

## 4. Contract index

| Id | Service | Route or event (label) | Stage | Conf. |
|---|---|---|---|---|
| AUTH-01 | Auth | `POST /auth/admin/authorization-receipts` (P) | S2-Auth | M |
| AUTH-02 | Auth | `POST /auth/service/authorization-receipts/consume` (P) | S2-Auth | M |
| AUTH-03 | Auth | `POST /auth/service/authorization-receipts/consumptions/lookup` (P) | S2-Auth | M |
| AUTH-04 | Auth | `POST /auth/admin/step-up`, new purposes (route I, purposes P) | S2-Auth | M |
| AUTH-05 | Auth | `POST /auth/step-up/verify` for new purposes (I) | S2-Auth | H |
| AUTH-06 | Auth | `AUTH_SERVICE_POLICY` and inbound service tokens (configuration, P) | S2-Auth | M |
| AUTH-07 | Auth | `GET /auth/me`, `GET /auth/platform-access/:platformId` (I) | S3d, S5 | H |
| AUTH-08 | Auth | `GET /auth/grants`: R-6a (I route; correction OPEN) | S2-Auth | L |
| AUTH-09 | Auth | Administrator tenure during suspension (OPEN, conditional) | S7 | L |
| ORG-00 | Organization | none in Core V2 | — | H |
| BIL-01 | Billing | `POST /billing/admin/platforms/:platformId` (P) | S3d | M |
| BIL-02 | Billing | `POST /billing/admin/products` (P) | S3a, S3g | M |
| BIL-03 | Billing | `POST /billing/admin/prices` (P) | S3g | L |
| BIL-04 | Billing | `PUT /billing/admin/platforms/:platformId/fee-caps` (P) | S3f | L |
| BIL-05 | Billing | `POST /billing/admin/platforms/:platformId/fee-delegations` (P) | S3f | L |
| BIL-06 | Billing | `POST /billing/platforms/:platformId/fee-proposals` (P) | S3f | L |
| BIL-07 | Billing | `POST /billing/admin/fee-proposals/:id/approve` (P) | S3f | L |
| BIL-08 | Billing | `POST /billing/invoices/:id/issue` + routing record (route I) | S3a | M |
| BIL-09 | Billing | Organization settlement guard and fixed grace; `GET /billing/organizations/:organizationId/entitlement` (route I) | S3b, S3e | H |
| BIL-10 | Billing | `POST /billing/checkout/direct` (P) | S3f | M |
| BIL-11 | Billing | `GET /billing/users/:userId/platforms/:platformId/products/:productId/entitlement` (F, ADR-0044 B6) | S3c | H |
| BIL-12 | Billing | `GET /billing/me/personal-subscriptions` (P) | S3c | L |
| BIL-13 | Billing | `POST /billing/assistance-requests` (P) | S5a | M |
| BIL-14 | Billing | `POST /billing/assistance-requests/:id/decline` (P) | S5a | L |
| BIL-15 | Billing | `POST /billing/assistance-requests/:id/cash-collection` (P) | S5a | M |
| BIL-16 | Billing | `POST /billing/assistance-requests/:id/settlement` (P) | S5b | M |
| BIL-17 | Billing | `POST /billing/cash-return-obligations/:id/return` (P) | S5b | M |
| BIL-18 | Billing | `POST /billing/cash-return-obligations/:id/confirm` (P) | S5c | M |
| BIL-19 | Billing | `POST /billing/admin/assistance-requests/:id/corrections` (P) | S5c | M |
| BIL-20 | Billing | `POST /billing/assistance-requests/:id/disputes` (P) | S5c | M |
| BIL-21 | Billing | `POST /billing/assistance-disputes/:id/responses` (P) | S5c | M |
| BIL-22 | Billing | `POST /billing/admin/assistance-disputes/:id/resolution` (P) | S5c | M |
| BIL-23 | Billing | `POST /billing/admin/refund-cases` (P) | S6a | M |
| BIL-24 | Billing | `POST /billing/admin/refund-cases/:id/authorizations` (P) | S6b | M |
| BIL-25 | Billing | `GET /billing/admin/refund-cases/:id` (P) | S6a | M |
| BIL-26 | Billing | `GET /billing/organizations/:organizationId/restrictions` (P) | S5d | M |
| BIL-27 | Billing | `POST /billing/admin/fraud-holds` (P) | S6e | L |
| BIL-28 | Billing | `GET /billing/recovery-obligations/:id` (P) | S6f | M |
| BIL-29 | Billing | `POST /billing/recovery-obligations/:id/settlement` (P) | S6f | M |
| BIL-30 | Billing | `POST /billing/admin/recovery-surpluses/:id/resolution` (P) | S6f | M |
| BIL-31 | Billing | `POST /billing/recovery-surpluses/:id/recipient-confirmation` (P) | S6f | M |
| BIL-32 | Billing | `POST /billing/admin/reconciliation-cases/:id/late-settlement-application` (P) | S6g | M |
| BIL-33 | Billing | `GET` / `POST /billing/admin/reconciliation-cases…` (P) | S6h | M |
| BIL-34 | Billing | `POST /billing/admin/recovery-obligations/:id/write-off`; `GET /billing/admin/financial-losses` (P) | S6h | M |
| BIL-35 | Billing | Legal remedies record (OPEN) | S6 | L |
| PAY-01 | Payment | `POST /payment/payments` extended (route I) | S4a | M |
| PAY-02 | Payment | `GET /payment/payments/:id` extended (route I) | S4c | M |
| PAY-03 | Payment | `POST /payment/payments/:paymentId/attempts` for an Organization payer (route I) | S4e | M |
| PAY-04 | Payment | No second checkout under uncertainty (cross-cutting) | S4c | M |
| PAY-05 | Payment | `POST /payment/webhooks/:provider` → provider facts (route I) | S4d | H |
| PAY-06 | Payment | No cash settlement of a Company seller (database guard) | S4b | H |
| PAY-07 | Payment | `POST /payment/payments/:paymentId/refunds` (P) | S6b, S6c | M |
| PAY-08 | Payment | `GET /payment/payments/:paymentId/refunds` (P) | S6b | M |
| PAY-09 | Payment | `GET /payment/admin/disputes`, `GET /payment/admin/disputes/:id` (P) | S6e | L |
| PAY-10 | Payment | `POST /payment/admin/disputes/:id/evidence` (P) | S6e | L |
| PAY-11 | Payment | `POST /payment/admin/disputes/:id/decision` (P) | S6e | M |
| PAY-12 | Payment | `GET /payment/admin/reconciliation-items` (P) | S6h | M |
| PAY-13 | Payment | `POST /payment/admin/provider-facts/:id/associations` (P) | S6h | M |
| PAY-14 | Payment | Simulation adapter and harness; production refusal (OPEN route) | S4f | L |
| PAY-15 | Payment | Class-M idempotency of 90 days (cross-cutting) | S4g | H |
| FIL-01 | File | Evidence grant creation (OPEN) | S2-File | L |
| FIL-02 | File | Granted read (OPEN) | S2-File | L |
| FIL-03 | File | Ticket from a grant (OPEN) | S2-File | L |
| FIL-04 | File | Hold placement (OPEN) | S2-File | L |
| FIL-05 | File | Hold release (OPEN) | S2-File | L |
| FIL-06 | File | `DELETE /file/files/:id` refused while held (route I) | S2-File | M |
| FIL-07 | File | Ticket reservation lease (OPEN) | S2-File | L |
| NOT-00 | Notification | none in Core V2 | — | H |
| NOT-01 | Notification | Commercial IN_APP (excluded unless C-3) | S7 | L |
| AUD-01 | Audit | Audit contract v2 envelope | S2-Audit | H |
| AUD-02 | Audit | Verified-producer classification and non-live refusal (ingestion) | S2-Audit | H |
| AUD-03 | Audit | `GET /audit/owner/company/records` (P) | S2-Audit | M |
| AUD-04 | Audit | `GET /audit/operator/platforms/:platformId/records` (P) | S2-Audit | M |
| AUD-05 | Audit | Legal holds (OPEN route) | S2-Audit | L |
| AUD-06 | Audit | `GET /audit/platform/records` (I, unchanged) | — | H |
| AUD-07 | Audit | `GET /audit/owner/organizations/:organizationId/records` (I, scope rules) | S2-Audit | H |
| REL-01 | Release | `GET /release/admin/products` (P) | S2-Rel | M |
| REL-02 | Release | `GET /release/admin/products/:product/components/:component/releases` (P) | S2-Rel | M |
| REL-03 | Release | `GET /release/admin/products/:product/components/:component/compatibility-policy/history` (P) | S2-Rel | M |
| EVT-01 | Payment | `payment.*` version 1 plus additive fields | S4 | H |
| EVT-02 | Payment | `refund.*` | S6 | M |
| EVT-03 | Payment | dispute and chargeback events | S6e | L |
| EVT-04 | Billing | `invoice.created` version 1 | S3 | H |
| EVT-05 | Billing | `billing.subscription.*` | S3 | M |
| EVT-06 | Billing | `billing.recovery.*` | S6f | M |
| EVT-07 | all producers | `audit.*` version 1 and 2 | S1, S2-Audit | H |
| EVT-08 | Auth | Auth domain events | S1 | H |
| EVT-09 | producers | Owner-authorized re-emission of one outbox row (Payment-first mechanism decided, S0-C4; other producers OPEN) | S1c | M |

## 5. Contracts by service

### 5.1 Auth

#### AUTH-01 Issue an authorization receipt

| Part | Contract |
|---|---|
| A. Frozen | Active Owner of `companyId`; factor-only `refund.authorize` step-up; binding of ADR-0067 decision 1; 10 minutes; digest-only storage; secret returned once; idempotency key; lost-response replay voids an `issued` receipt (`409 receipt_issued_response_lost`); a consumed receipt is never voided (`409 receipt_already_consumed`, no secret) ([ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md) decisions 1, 2) |
| B. Route and DTO | PROPOSED: Owner bearer; `Idempotency-Key`; `{stepUpToken, binding}` → `201 {receiptId, secret, expiresAt}` (receipt contract §5.1) |
| C. Errors, idempotency | FROZEN codes above; PROPOSED `receipt_binding_invalid`, `idempotency_key_required`, `idempotency_key_reused`; IMPLEMENTED step-up codes. Class X; guards `UNIQUE(issuerUserId, idempotencyKey)`, `UNIQUE(secretDigest)`, `UNIQUE(stepUpId)` (PROPOSED) |
| D. Existing | Owner step-up only (`apps/auth-service/src/owner/step-up.service.ts`); no receipt code |
| E. Open, gates | Q1, Q2, Q3, Q4, Q5, Q6, Q12; G-1 naming ADR-0067; G-7 for production. Stage S2-Auth. Confidence M |

#### AUTH-02 Consume a receipt

| Part | Contract |
|---|---|
| A. Frozen | Bound audience only, under deny-by-default `AUTH_SERVICE_POLICY`; one conditional update (digests, `issued`, unexpired, issuer still active Owner of `companyId`); idempotent on `consumeRef`; a different `consumeRef` → `409`; consumption is the commit point; `authority_revoked` before it (ADR-0067 decisions 3, 4); `consumeRef` permanent (S0 §3.7) |
| B. Route and DTO | PROPOSED: service token; `{secret, binding, consumeRef}` → `200 {receiptId, consumeRef, consumedAt, approvedBy:{userId}, companyId}` (receipt contract §5.2) |
| C. Errors, idempotency | FROZEN `authority_revoked`, 409 on a different `consumeRef`; PROPOSED `consume_ref_conflict`, `receipt_invalid`, `receipt_expired`, `receipt_binding_invalid`. Class N on `consumeRef`; guard `UNIQUE(consumeRef)` |
| D. Existing | none; Auth has no service-callee route today |
| E. Open, gates | Q4, Q7, Q9, Q12. Stage S2-Auth. Confidence M |

#### AUTH-03 Look up a consumption

| Part | Contract |
|---|---|
| A. Frozen | A lookup by `consumeRef` recovers a lost consumption response without the secret (ADR-0067 decision 3) |
| B. Route and DTO | PROPOSED: service token of the consuming caller only; `{consumeRef, binding}` → `200` (the AUTH-02 response) or `404 not_found` when no consumption matches this `consumeRef`, caller and binding (receipt contract §5.3); a successful lookup never authorizes an attempt other than the one whose id is `consumeRef` |
| C. Errors, idempotency | `not_found` (IMPLEMENTED code); class R |
| D. Existing | none |
| E. Open, gates | Q8 (margin used by the caller), Q9; ADR-0035 C4 reading in receipt contract §11.3. Stage S2-Auth. Confidence M |

#### AUTH-04 New factor-only step-up purposes

| Part | Contract |
|---|---|
| A. Frozen | `refund.authorize`, factor only (ADR-0067 decision 1). A step-up is frozen for: cash corrections (S0 FC-8), the L-4 late-settlement application with factor step-up (S0 §3.4; ADR-0044 B14), fraud holds (S0 §1.1), refund authorization |
| B. Route and DTO | IMPLEMENTED route `POST /auth/admin/step-up`. PROPOSED purpose names: `refund.authorize` (name FROZEN), `billing.assistance.correct`, `billing.late_settlement.apply`, `billing.fraud_hold.place`, all factor-only |
| C. Errors, idempotency | IMPLEMENTED `step_up_unsupported`, `verification_failed`; class: existing step-up behaviour |
| D. Existing | `STEP_UP_METHODS` (`apps/auth-service/src/owner/step-up.service.ts`) |
| E. Open, gates | **Q11**: whether any other Owner action (fee caps, fee approval, Platform configuration, catalog changes, write-off, surplus resolution, dispute decision, fact association, legal hold, event re-emission) requires a step-up, and its purpose name. Stage S2-Auth. Confidence M |

#### AUTH-05 Step-up verification for services

| Part | Contract |
|---|---|
| A. Frozen | Verified human authority through Auth; no delegation of a reusable credential ([ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md); ADR-0067 Context) |
| B. Route and DTO | IMPLEMENTED `POST /auth/step-up/verify`; PROPOSED use by Billing and Payment for the AUTH-04 purposes they enforce |
| C. Errors, idempotency | IMPLEMENTED codes; the proof is single-use |
| D. Existing | `apps/auth-service/src/auth/auth.controller.ts`, `StepUpService.verifyForService` |
| E. Open, gates | Q11. Stage S2-Auth. Confidence H |

#### AUTH-06 `AUTH_SERVICE_POLICY` and inbound service tokens

| Part | Contract |
|---|---|
| A. Frozen | Deny by default; Auth's first service-callee route; payment-service admitted and recorded with the ADR-0042 admissions (ADR-0067 decision 3 and Consequences) |
| B. Route and DTO | PROPOSED configuration `{"callers":{"payment-service":{"operations":["authorization_receipt.consume","authorization_receipt.lookup"]}}}` through the generic service-kit caller policy (`libs/service-kit/src/service-auth/caller-policy.ts`); a new inbound `SERVICE_TOKENS` in Auth |
| C. Errors, idempotency | the service-kit caller-policy refusal (IMPLEMENTED mechanism); configuration errors at boot |
| D. Existing | none in Auth; the mechanism exists in other services (for example `RELEASE_SERVICE_POLICY`) |
| E. Open, gates | **Q9**. Stage S2-Auth. Confidence M |

#### AUTH-07 Live membership and Platform checks used by Billing

| Part | Contract |
|---|---|
| A. Frozen | Billing checks memberships live through `/auth/me`; `billing_platform` is written only after a live `/auth/platform-access` check; failures are closed (`503`) (S0 §3.6) |
| B. Route and DTO | IMPLEMENTED `GET /auth/me`, `GET /auth/platform-access/:platformId`; PROPOSED Billing clients |
| C. Errors, idempotency | class R; an unavailable Auth gives `503` at the consumer with no mutation |
| D. Existing | `apps/auth-service/src/auth/auth.controller.ts`, `apps/auth-service/src/platform/platform.controller.ts` |
| E. Open, gates | OD-07 (which membership facts identify a school actor). Stage S3d, S5. Confidence H |

#### AUTH-08 Organization-administrator grant facts (R-6a)

| Part | Contract |
|---|---|
| A. Frozen | S0 §3.10 lists "the R-6a correction of the organization-administrator grant facts" in the Auth group; the roadmap makes its specification (DOC-1) a prerequisite of S2-Auth's R-6a work package (roadmap §1.4, G-3). Nothing else about R-6a is recoverable |
| B. Route and DTO | IMPLEMENTED `GET /auth/grants` → `GrantFacts {userId, kind, companyId, platformAssignments, organizationAdminMemberships}`; no change is proposed here |
| C. Errors, idempotency | class R; unchanged |
| D. Existing | `apps/auth-service/src/auth/grants.service.ts`: `organizationAdminMemberships` lists the member's `active`, admin-flagged memberships and does not consult Organization, Platform or Company lifecycle state. This observation is evidence only; it is **not** authority to define the correction |
| E. Open, gates | **OD-R6a**. Blocks the R-6a work package of S2-Auth only. Confidence L |

#### AUTH-09 Administrator tenure during suspension

| Part | Contract |
|---|---|
| A. Frozen | Gate C-6, decided with C-3 (S0 §6); S7 conditional (roadmap §4.7) |
| B. Route and DTO | none proposed |
| C. Errors, idempotency | — |
| D. Existing | none |
| E. Open, gates | C-3, C-6. Excluded from initial Core V2 unless approved. Confidence L |

### 5.2 Organization

#### ORG-00 No Core V2 contract

| Part | Contract |
|---|---|
| A. Frozen | No Organization route in Core V2; human hierarchy reads deferred until authority activation; organization-service stays non-authoritative; G6 and F7 unchanged (S0 §3.6, §3.10, §5) |
| B. Route and DTO | none |
| C. Errors, idempotency | — |
| D. Existing | unchanged |
| E. Open, gates | S8 only if authorized (PR #319 reconciliation, C-5, A5.4-G1). Confidence H |

### 5.3 Billing

Callers named "Owner" are the active Owner of the Company that owns the Platform, verified live (S0 §3.6). "School actor" is the
Organization-side actor of an assistance request: its identity in an active Organization is **OD-07**, and in an inactive one gate
**V-5** (S0 §6).

#### BIL-01 Platform commercial configuration (`billing_platform`)

| Part | Contract |
|---|---|
| A. Frozen | A commercial-configuration projection with an immutable `companyId`, written only by the Owner after a live `/auth/platform-access` check; fail closed `503`; one currency per Platform (S0 §3.6, §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/admin/platforms/:platformId`; Owner bearer; `{currency}` → `201 {platformId, companyId, currency, createdAt}` (`companyId` taken from Auth, never from the body) |
| C. Errors, idempotency | PROPOSED `billing_platform_exists` (409); `503` when Auth is unavailable. Class N; guard primary key `platformId`; `companyId` immutable (trigger) |
| D. Existing | Billing has a Platform currency configuration (`apps/billing-service/db/migrations/0009_platform_currency.sql`) |
| E. Open, gates | OD-02 (relation to the existing configuration), Q11 (step-up). Stage S3d. Confidence M |

#### BIL-02 Owner product catalog

| Part | Contract |
|---|---|
| A. Frozen | Every recurring product declares `platformId` and `subscriptionTarget ∈ {none, organization, personal}`, immutable after its first sale, independent of `entitlementKind` (ADR-0044 B1; S-5; [ADR-0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md)); no product for recovery (DB-4) |
| B. Route and DTO | PROPOSED `POST /billing/admin/products`; Owner; existing product fields plus `platformId`, `subscriptionTarget` → product |
| C. Errors, idempotency | IMPLEMENTED `product_conflict`, `invalid_product_request`; PROPOSED `product_target_immutable` (409). Class K; guard DB-4 composite key `(id, subscriptionTarget)` |
| D. Existing | `POST /billing/products`, producer service only (`apps/billing-service/src/catalog/products.controller.ts`) |
| E. Open, gates | Catalog gate (S0 §6); Q10, Q11. Stage S3a (fields), S3g (Owner route). Confidence M |

#### BIL-03 Owner price catalog

| Part | Contract |
|---|---|
| A. Frozen | Prices and plan durations are decided at the catalog gate before any catalog configuration (S0 §6) |
| B. Route and DTO | PROPOSED `POST /billing/admin/prices`; Owner; existing price fields |
| C. Errors, idempotency | IMPLEMENTED `price_conflict`, `invalid_price_request`, `unsupported_currency`. Class K |
| D. Existing | `POST /billing/prices`, producer service only |
| E. Open, gates | Catalog gate (values); Q10, Q11. Stage S3g. Confidence L |

#### BIL-04 Fee caps

| Part | Contract |
|---|---|
| A. Frozen | The Owner sets caps and approves; the school fee is optional, approved, student-funded and ≥ 0 (S0 §1.1) |
| B. Route and DTO | PROPOSED `PUT /billing/admin/platforms/:platformId/fee-caps`; Owner; DTO **OPEN** |
| C. Errors, idempotency | OPEN; class K |
| D. Existing | none |
| E. Open, gates | **OD-03**, Q10, Q11. Stage S3f. Confidence L |

#### BIL-05 Fee delegations

| Part | Contract |
|---|---|
| A. Frozen | Delegated operators propose; operators never approve in Core V2 (S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/admin/platforms/:platformId/fee-delegations`; Owner; DTO **OPEN** |
| C. Errors, idempotency | OPEN; class K |
| D. Existing | none |
| E. Open, gates | **OD-03**. Stage S3f. Confidence L |

#### BIL-06 Fee proposals

| Part | Contract |
|---|---|
| A. Frozen | A delegated operator proposes a fee within the Owner's caps (S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/platforms/:platformId/fee-proposals`; operator with an active Platform assignment and a delegation; DTO **OPEN** |
| C. Errors, idempotency | PROPOSED `fee_above_cap` (422); class K |
| D. Existing | none |
| E. Open, gates | **OD-03**. Stage S3f. Confidence L |

#### BIL-07 Fee proposal approval

| Part | Contract |
|---|---|
| A. Frozen | Only the Owner approves (S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/admin/fee-proposals/:id/approve`; Owner |
| C. Errors, idempotency | PROPOSED `fee_proposal_not_pending` (409); class K |
| D. Existing | none |
| E. Open, gates | **OD-03**, Q11. Stage S3f. Confidence L |

#### BIL-08 Invoice routing record at issue

| Part | Contract |
|---|---|
| A. Frozen | When an invoice leaves `draft`, Billing records an immutable `invoice_entitlement` with a server-determined purpose and target; at most one entitlement-bearing line; malformed routing refused at issue; settled money on a malformed invoice changes no entitlement and opens reconciliation (ADR-0044 B2, B9; S0 DB-1 to DB-3, DB-9, DB-10) |
| B. Route and DTO | IMPLEMENTED `POST /billing/invoices/:id/issue`; PROPOSED: the routing record is internal and never client-supplied; the invoice representation gains `purpose` and `target` |
| C. Errors, idempotency | IMPLEMENTED `ambiguous_subscription_obligation`, `invalid_state_transition`; PROPOSED `invoice_routing_invalid` (422). Guards DB-1 to DB-3, DB-9, DB-10 |
| D. Existing | invoices and lines (`apps/billing-service/db/migrations/0003_invoice.sql`, `0004_invoice_line.sql`); no routing record |
| E. Open, gates | none beyond G-1, G-2 (DOC-3). Stage S3a. Confidence M |

#### BIL-09 Organization settlement guard and fixed grace

| Part | Contract |
|---|---|
| A. Frozen | The Organization Subscription starts or extends a period only with a same-transaction `subscription_settlement` of an `organization_subscription` routing record; the direct `activate()` / `renew()` are retired first (B3, S-4, DB-11). Grace exactly 24 hours after `currentPeriodEnd`, UTC, frozen per period; same-row check `status = 'pending' OR graceUntil = currentPeriodEnd + interval '24 hours'`; `SUBSCRIPTION_GRACE_DAYS` replaced (B13; S0 §3.9) |
| B. Route and DTO | IMPLEMENTED `GET /billing/organizations/:organizationId/entitlement` → `{valid, expiresAt}` (service token), shape unchanged; no new route |
| C. Errors, idempotency | IMPLEMENTED `subscription_grace_unavailable` becomes unreachable for Organization Subscriptions (PROPOSED disposition at review). Guard DB-11 |
| D. Existing | `apps/billing-service/src/subscriptions/`; optional `SUBSCRIPTION_GRACE_DAYS` (`apps/billing-service/src/config/billing-config.ts`) |
| E. Open, gates | DOC-5 before S3e (roadmap §8). Stage S3b, S3e. Confidence H |

#### BIL-10 Direct checkout of personal Premium

| Part | Contract |
|---|---|
| A. Frozen | An authenticated, active, eligible member buys an active Platform-scoped product of a configured Platform; no membership required; no authorization granted; no school fee; purpose `direct_purchase`, payer = beneficiary (FC-12; [OD] D2; ADR-0044 B2); no second checkout while a payment is uncertain (I-10) |
| B. Route and DTO | PROPOSED `POST /billing/checkout/direct`; member bearer; `{platformId, productId, priceId}` → `201 {invoiceId, paymentRequestId, paymentId}` |
| C. Errors, idempotency | PROPOSED `product_not_available` (409), `platform_not_configured` (409), `checkout_uncertain` (409), `member_not_eligible` (403); IMPLEMENTED-style `503` when Auth is unavailable. Class M; guards `(producer, paymentRequestId)`, DB-3, DB-10 |
| D. Existing | none (invoice and payment-request creation exist for service producers) |
| E. Open, gates | **OD-01** (eligibility). Stage S3f; S3/S4 joint checkpoint (roadmap §4.4). Confidence M |

#### BIL-11 Personal entitlement read

| Part | Contract |
|---|---|
| A. Frozen | `GET /billing/users/:userId/platforms/:platformId/products/:productId/entitlement`, service-token only, `200 {valid, expiresAt}`; consumers treat an unavailable answer as not entitled; no Personal grace (ADR-0044 B6, B13.2) |
| B. Route and DTO | FROZEN route and response (ADR-0044 B6); caller policy operation name PROPOSED |
| C. Errors, idempotency | IMPLEMENTED-style `not_found` collapse; class R |
| D. Existing | none |
| E. Open, gates | none. Stage S3c. Confidence H |

#### BIL-12 A member's own personal subscriptions

| Part | Contract |
|---|---|
| A. Frozen | Personal Subscriptions are owned by the named user, per user + Platform + product, portable across that Platform's Organizations (S0 §1.1; ADR-0044 B4) |
| B. Route and DTO | PROPOSED `GET /billing/me/personal-subscriptions`; member bearer → list of `{platformId, productId, validUntil}` |
| C. Errors, idempotency | class R |
| D. Existing | none |
| E. Open, gates | whether this read is in initial scope (S0 §3.10 lists "personal subscriptions" without a shape). Stage S3c. Confidence L |

#### BIL-13 Assistance request (Pay with School)

| Part | Contract |
|---|---|
| A. Frozen | Student-initiated with consent; blocked while T1, T2, T3 or inactivity applies (new requests only); no wallets, seats or manual settlement (S0 §1.1, FC-9; [OD] D6; DN-1) |
| B. Route and DTO | PROPOSED `POST /billing/assistance-requests`; student bearer; `{organizationId, productId, priceId, consent: true}` → `201 {id, status, consentAt}` |
| C. Errors, idempotency | PROPOSED `assistance_restricted` (409, with `restriction ∈ {T1, T2, T3, inactive}`), `product_not_available` (409). Class K (no money moves until BIL-16); guard: one purchase per request later (DB-12) |
| D. Existing | none |
| E. Open, gates | **OD-04** (fee selection), V-4 (inactivity source). Stage S5a. Confidence M |

#### BIL-14 Assistance request decline

| Part | Contract |
|---|---|
| A. Frozen | S0 §3.10 lists "decline" in the assistance group |
| B. Route and DTO | PROPOSED `POST /billing/assistance-requests/:id/decline`; actor **OPEN** |
| C. Errors, idempotency | PROPOSED `assistance_request_not_pending` (409); class K |
| D. Existing | none |
| E. Open, gates | **OD-09**. Stage S5a. Confidence L |

#### BIL-15 Cash collection report

| Part | Contract |
|---|---|
| A. Frozen | `cashCollectedAt` asserted by the school, `reportedAt` server time, `consentAt ≤ cashCollectedAt ≤ reportedAt`; `settleBy = cashCollectedAt + 72h`; a late report is born overdue; cash alone never activates and never settles a payment (FC-8; S0 §1.2 D-6; ADR-0035 C1; ADR-0068) |
| B. Route and DTO | PROPOSED `POST /billing/assistance-requests/:id/cash-collection`; school actor; `{cashCollectedAt}` → `{reportedAt, settleBy, overdue}` |
| C. Errors, idempotency | PROPOSED `cash_collection_time_invalid` (422), `cash_collection_already_reported` (409). Class K; one report per request (corrections only through BIL-19) |
| D. Existing | none |
| E. Open, gates | **OD-07**, V-5. Stage S5a. Confidence M |

#### BIL-16 Assisted settlement

| Part | Contract |
|---|---|
| A. Frozen | The school pays Nawara the full base price electronically; purpose `assisted_settlement`, target `personal`, Organization payer, beneficiary the consenting student; at most one open or uncertain channel per request; one purchase per request; verified settlement activates (ADR-0044 B2, B7, B14; S0 DB-5, DB-12, DB-13; S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/assistance-requests/:id/settlement`; school actor → `201 {invoiceId, paymentRequestId, paymentId}`; amount and beneficiary server-determined |
| C. Errors, idempotency | PROPOSED `settlement_channel_open` (409), `assistance_request_not_settleable` (409). Class M; guards DB-5, DB-12, DB-13, `(producer, paymentRequestId)` |
| D. Existing | none |
| E. Open, gates | **OD-07**, **OD-08**, V-5. Stage S5b. Confidence M |

#### BIL-17 Cash return recorded by the school

| Part | Contract |
|---|---|
| A. Frozen | A failed settlement opens a full cash-return obligation including the school's fee (FC-8; S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/cash-return-obligations/:id/return`; school actor; `{returnedAt}` → obligation `{status}` |
| C. Errors, idempotency | PROPOSED `cash_return_not_open` (409). Class K; append-only |
| D. Existing | none |
| E. Open, gates | **OD-07**, V-5. Stage S5b. Confidence M |

#### BIL-18 Cash return confirmation by the student

| Part | Contract |
|---|---|
| A. Frozen | The student's confirmation or dispute is a discharge action that stays available (DN-1.2) |
| B. Route and DTO | PROPOSED `POST /billing/cash-return-obligations/:id/confirm`; student bearer → obligation `{status: 'confirmed_returned'}` |
| C. Errors, idempotency | PROPOSED `cash_return_not_reported` (409). Class K |
| D. Existing | none |
| E. Open, gates | none beyond S5. Stage S5c. Confidence M |

#### BIL-19 Owner correction of an assistance record

| Part | Contract |
|---|---|
| A. Frozen | Corrections are append-only, Owner-only, with step-up; violations are never erased (`superseded_by_correction`) (FC-8) |
| B. Route and DTO | PROPOSED `POST /billing/admin/assistance-requests/:id/corrections`; Owner with step-up (AUTH-04 `billing.assistance.correct`); `{field, value, reasonCode}` → correction |
| C. Errors, idempotency | PROPOSED `correction_not_permitted` (409). Class K; append-only |
| D. Existing | none |
| E. Open, gates | Q11 (purpose name), correctable field set **OPEN** (OD-04 for fees). Stage S5c. Confidence M |

#### BIL-20 Student dispute

| Part | Contract |
|---|---|
| A. Frozen | Student disputes have no cutoff; 7 days is an escalation target only (FC-8) |
| B. Route and DTO | PROPOSED `POST /billing/assistance-requests/:id/disputes`; student bearer; `{reasonCode}` → dispute |
| C. Errors, idempotency | class K |
| D. Existing | none |
| E. Open, gates | dispute reason vocabulary **OPEN**. Stage S5c. Confidence M |

#### BIL-21 School dispute response

| Part | Contract |
|---|---|
| A. Frozen | The school's dispute response is a discharge action (DN-1.2) |
| B. Route and DTO | PROPOSED `POST /billing/assistance-disputes/:id/responses`; school actor → response |
| C. Errors, idempotency | class K |
| D. Existing | none |
| E. Open, gates | **OD-07**, V-5. Stage S5c. Confidence M |

#### BIL-22 Owner dispute resolution

| Part | Contract |
|---|---|
| A. Frozen | Owner resolutions are part of the discharge set (DN-1.2) |
| B. Route and DTO | PROPOSED `POST /billing/admin/assistance-disputes/:id/resolution`; Owner → resolution |
| C. Errors, idempotency | class K |
| D. Existing | none |
| E. Open, gates | Q11 (step-up). Stage S5c. Confidence M |

#### BIL-23 Refund case

| Part | Contract |
|---|---|
| A. Frozen | Owner-only; full purchase, or a full refund of a payment that produced no entitlement; no new case while a dispute on the payment is open (ADR-0067 decision 6; [OD] D3, D4; S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/admin/refund-cases`; Owner; `{paymentId, reason}` → `201 {id, paymentId, companyId, amount, currency, status}` (amount server-computed) |
| C. Errors, idempotency | PROPOSED `refund_dispute_open` (409), `refund_case_exists` (409). Class K; guard: one open case per payment (PROPOSED) |
| D. Existing | none |
| E. Open, gates | Q1, Q2 (`reason`, `legalOverride` origin). Stage S6a. Confidence M |

#### BIL-24 Refund authorization relay

| Part | Contract |
|---|---|
| A. Frozen | Billing relays the receipt secret in memory only; a completed case refuses every new attempt (`409 refund_case_completed`) (ADR-0067 decision 5; FC-3) |
| B. Route and DTO | PROPOSED `POST /billing/admin/refund-cases/:id/authorizations`; Owner; `{receiptSecret, expiresAt}` → `{refundAttemptId, status: 'authorized'}`; Billing calls PAY-07 |
| C. Errors, idempotency | FROZEN `refund_case_completed`; relayed PAY-07 errors. Class M; replay hash excludes the secret; guard one attempt per consumption (S0 §3.7) |
| D. Existing | none |
| E. Open, gates | receipt contract §10.3. Stage S6b. Confidence M |

#### BIL-25 Refund case read

| Part | Contract |
|---|---|
| A. Frozen | — (supports FC-3 completion visibility) |
| B. Route and DTO | PROPOSED `GET /billing/admin/refund-cases/:id`; Owner → case with attempts and `completedAt` |
| C. Errors, idempotency | `not_found`; class R |
| D. Existing | none |
| E. Open, gates | none. Stage S6a. Confidence M |

#### BIL-26 Restrictions read

| Part | Contract |
|---|---|
| A. Frozen | Restrictions are derived from open T1, T2, T3 and inactivity; each clears on verified resolution when no other applies; no persistent repeat-violation state (FC-9) |
| B. Route and DTO | PROPOSED `GET /billing/organizations/:organizationId/restrictions`; Owner, school actor or service token → `{restrictions: [{kind, sourceId, since}]}` |
| C. Errors, idempotency | class R |
| D. Existing | none |
| E. Open, gates | **OD-07**, V-4. Stage S5d (T3 source in S6f). Confidence M |

#### BIL-27 Fraud hold

| Part | Contract |
|---|---|
| A. Frozen | Evidence-based, Owner step-up, 14-day review, exact-duration compensation; the Owner decides contest or accept (S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /billing/admin/fraud-holds`; Owner with step-up; DTO **OPEN** |
| C. Errors, idempotency | OPEN; class K |
| D. Existing | none |
| E. Open, gates | **OD-10**, Q11. Stage S6e. Confidence L |

#### BIL-28 Recovery obligation read

| Part | Contract |
|---|---|
| A. Frozen | An assisted purchase lost at final stage opens a school recovery obligation for the base amount only; T3 clears only when verified recoveries reach the base amount (ADR-0044 B8, B10; [OD] D5; S0 §3.5) |
| B. Route and DTO | PROPOSED `GET /billing/recovery-obligations/:id`; Owner or school actor → `{baseAmount, recovered, outstanding, currency, status}` |
| C. Errors, idempotency | `not_found`; class R |
| D. Existing | none |
| E. Open, gates | **OD-07**. Stage S6f. Confidence M |

#### BIL-29 Recovery settlement

| Part | Contract |
|---|---|
| A. Frozen | Purpose `recovery_settlement`, target `none`; one open or uncertain channel per obligation; a new channel only after definitive closure, for the then-outstanding amount and the obligation's currency; the invoice amount equals the outstanding amount at issue and is never client-supplied; every verified success, including a late one, is a `RecoveryPayment`; never creates a purchase or touches entitlement (S0 §1.4, §3.5; ADR-0044 B2, B8; DB-6, DB-8, DB-13) |
| B. Route and DTO | PROPOSED `POST /billing/recovery-obligations/:id/settlement`; school actor → `201 {invoiceId, paymentRequestId, paymentId, amount}` |
| C. Errors, idempotency | PROPOSED `settlement_channel_open` (409), `recovery_obligation_closed` (409). Class M; guards DB-6, DB-8, DB-13 |
| D. Existing | none |
| E. Open, gates | **OD-07**, **OD-08**, V-5. Stage S6f. Confidence M |

#### BIL-30 Recovery surplus resolution

| Part | Contract |
|---|---|
| A. Frozen | An excess is a `recovery_surplus` `owed_to_school`; an owner reconciliation case; no expiry; resolution by a full refund of an entirely surplus payment (receipt flow) or by external repayment recorded as `external_execution_evidenced`; no offsetting in Core V2; the electronic partial-refund deferral never limits the obligation (R-1 to R-4) |
| B. Route and DTO | PROPOSED `POST /billing/admin/recovery-surpluses/:id/resolution`; Owner; `{kind: 'full_refund' \| 'external_execution_evidenced', evidenceFileId?}` |
| C. Errors, idempotency | PROPOSED `surplus_not_owed` (409), `surplus_refund_requires_entire_payment` (409). Class K |
| D. Existing | none |
| E. Open, gates | Q11; evidence through FIL-01 (**OD-FILE**). Stage S6f. Confidence M |

#### BIL-31 Surplus recipient confirmation

| Part | Contract |
|---|---|
| A. Frozen | External repayment is recorded `external_execution_evidenced` then `recipient_confirmed` (R-3b) |
| B. Route and DTO | PROPOSED `POST /billing/recovery-surpluses/:id/recipient-confirmation`; school actor |
| C. Errors, idempotency | PROPOSED `surplus_not_evidenced` (409). Class K |
| D. Existing | none |
| E. Open, gates | **OD-07**. Stage S6f. Confidence M |

#### BIL-32 Late assisted settlement application (L-4)

| Part | Contract |
|---|---|
| A. Frozen | L-1 to L-6: every verified success recorded; no purchase and no entitlement change on a definitively closed channel; default resolution a full refund to the school's card; the L-4 exception only with all five conditions (Owner authorization with factor step-up; student attestation or reliable independent evidence that cash was not returned; no existing purchase; cash return not confirmed; an auditable decision with reason code and evidence); refused when the cash return is confirmed or a purchase exists; closes the cash-return obligation `superseded_by_settlement`, keeps violations, clears T1 for that request only (S0 §3.4; ADR-0044 B14) |
| B. Route and DTO | PROPOSED `POST /billing/admin/reconciliation-cases/:id/late-settlement-application`; Owner with factor step-up (AUTH-04 `billing.late_settlement.apply`); `{reasonCode, attestationRef?, evidenceFileIds[]}` |
| C. Errors, idempotency | PROPOSED `late_settlement_refused` (409, with `reason ∈ {purchase_exists, cash_return_confirmed, evidence_insufficient}`). Class K; guard DB-12 |
| D. Existing | none |
| E. Open, gates | **OD-FILE** (evidence), Q11, the L-4 reason-code vocabulary **OPEN**. Stage S6g. Confidence M |

#### BIL-33 Reconciliation cases

| Part | Contract |
|---|---|
| A. Frozen | Reconciliation opens on a second reversal cause, a malformed invoice with settled money, a late settlement, a surplus, or an unmatched fact; no financial fact is discarded (S0 §3.1, §3.4, §3.5; ADR-0044 B5, B9) |
| B. Route and DTO | PROPOSED `GET /billing/admin/reconciliation-cases`, `GET …/:id`, `POST …/:id/resolution`; Owner |
| C. Errors, idempotency | class R (reads), K (resolution) |
| D. Existing | none |
| E. Open, gates | resolution kinds per case type **OPEN**. Stage S6h. Confidence M |

#### BIL-34 Write-off and financial losses

| Part | Contract |
|---|---|
| A. Frozen | A loss only from recorded facts showing money not retained or from an owner write-off of an unrecoverable recovery obligation; keyed per evidence fact and kind; corrected by append-only adjustments; a cause alone opens reconciliation, not a loss (FC-6; ADR-0044 B11; ADR-0035 C3) |
| B. Route and DTO | PROPOSED `POST /billing/admin/recovery-obligations/:id/write-off` (Owner) and `GET /billing/admin/financial-losses` (Owner) |
| C. Errors, idempotency | PROPOSED `write_off_not_permitted` (409). Class K; guard one loss per (evidence fact, kind) |
| D. Existing | none |
| E. Open, gates | Q11. Stage S6h. Confidence M |

#### BIL-35 Legal remedies

| Part | Contract |
|---|---|
| A. Frozen | S0 §3.10 lists legal remedies in the Billing group; their execution is deferred (S0 §5) |
| B. Route and DTO | **OPEN** |
| C. Errors, idempotency | OPEN |
| D. Existing | none |
| E. Open, gates | **OD-12**. Stage S6. Confidence L |

### 5.4 Payment

#### PAY-01 Payment creation with payer, purpose and scope

| Part | Contract |
|---|---|
| A. Frozen | Payer, purpose, beneficiary, amount, currency and seller immutable once requested; an Organization payer only for `assisted_settlement` or `recovery_settlement`, enforced by Payment independently of Billing; every money record carries `liveMode` (ADR-0044 B7; S-6; DB-15; FC-10) |
| B. Route and DTO | IMPLEMENTED `POST /payment/payments` (producer service only); PROPOSED additive fields `payerType`, `purpose`, `beneficiaryUserId?`, `platformId`; `liveMode` server-derived, never client-supplied |
| C. Errors, idempotency | IMPLEMENTED `invalid_payment_request`, `payment_request_conflict`, `unsupported_currency`; PROPOSED `payer_purpose_mismatch` (422). Class M; guards `(producer, paymentRequestId)` (S0 §3.7), DB-15 and the immutability trigger |
| D. Existing | `apps/payment-service/src/payments/` |
| E. Open, gates | DOC-6 before S4 review. Stage S4a. Confidence M |

#### PAY-02 Payment read with finality

| Part | Contract |
|---|---|
| A. Frozen | Payment finality and a `closing` state; no second checkout while a payment is uncertain (S0 §3.10, §1.1) |
| B. Route and DTO | IMPLEMENTED `GET /payment/payments/:id`; PROPOSED representation fields `finality ∈ {open, uncertain, final}`, `purpose`, `payerType`, `liveMode` |
| C. Errors, idempotency | IMPLEMENTED collapsed `not_found`; class R |
| D. Existing | `apps/payment-service/src/payments/payment.representation.ts` |
| E. Open, gates | exact `closing` semantics at S4 review. Stage S4c. Confidence M |

#### PAY-03 Attempts for an Organization payer

| Part | Contract |
|---|---|
| A. Frozen | Organization-payer attempts for assisted and recovery purposes only (B7; roadmap S4e) |
| B. Route and DTO | IMPLEMENTED `POST /payment/payments/:paymentId/attempts` (payer only, `Idempotency-Key`); PROPOSED: for an Organization payer, the acting school actor verified live |
| C. Errors, idempotency | IMPLEMENTED `idempotency_key_required`, `payment_has_open_attempt`, `payment_not_payable`; PROPOSED `payment_uncertain` (409). Class M |
| D. Existing | `apps/payment-service/src/attempts/` |
| E. Open, gates | **OD-08**, V-5. Stage S4e. Confidence M |

#### PAY-04 No second checkout under uncertainty

| Part | Contract |
|---|---|
| A. Frozen | No second checkout while a payment is uncertain (S0 §1.1); one open or uncertain settlement channel per request or obligation (DB-13) |
| B. Route and DTO | PROPOSED rule applied by BIL-10, BIL-16, BIL-29 (Billing) and PAY-03 (Payment) |
| C. Errors, idempotency | PROPOSED `checkout_uncertain` (Billing), `payment_uncertain` (Payment), both 409 |
| D. Existing | `payment_has_open_attempt` covers one payment only (IMPLEMENTED) |
| E. Open, gates | the definition of "uncertain" at S4 review. Stage S4c. Confidence M |

#### PAY-05 Provider webhooks and provider transaction facts

| Part | Contract |
|---|---|
| A. Frozen | Every distinct provider money movement is an immutable `provider_transaction_fact` (identity `(provider, providerTxnId, kind)`) in its own transaction, independent of allocation; identical redeliveries are the same fact; facts are never refused, edited or deleted; raw webhooks stay in `webhook_event` (FC-1; V-2; ADR-0035 C2) |
| B. Route and DTO | IMPLEMENTED `POST /payment/webhooks/:provider`, authenticated only by the provider signature; PROPOSED: a fact only from an authenticated provider message (§3, provider authenticity) |
| C. Errors, idempotency | IMPLEMENTED `webhook_signature_invalid` (401). Class N; guard `UNIQUE(provider, providerTxnId, kind)` |
| D. Existing | `apps/payment-service/src/webhooks/`; `webhook_event` (`0005_webhook_event.sql`); no fact table |
| E. Open, gates | real-provider formats deferred (S0 §5). Stage S4d. Confidence H |

#### PAY-06 No cash settlement of a Company seller

| Part | Contract |
|---|---|
| A. Frozen | A same-row CHECK refusing `settledMethod = 'cash'` with a Company seller (ADR-0068 decision 3; DB-16; S-7) |
| B. Route and DTO | no route; database guard only |
| C. Errors, idempotency | a check-constraint violation (no API path sets `cash`) |
| D. Existing | `settledMethod ∈ {gateway, cash}` (`apps/payment-service/db/migrations/0002_payment.sql`); no code path sets `cash` |
| E. Open, gates | none. Stage S4b. Confidence H |

#### PAY-07 Refund attempt

| Part | Contract |
|---|---|
| A. Frozen | Durable intent with `consumeRef` = attempt id → receipt consumption → `authorized`; asynchronous dispatch with a stable provider key; `authorization_expired` recovery; `approvedBy` only from Auth; allocation in its own transaction with lock order `payment → refund_authorization`, `0 ≤ allocatedIntended ≤ approvedAmount`, a deferred sum check; `completedAt` set once; a completed case refuses new attempts (ADR-0067 decisions 5 to 7; FC-2, FC-3; DB-17; V-3) |
| B. Route and DTO | PROPOSED `POST /payment/payments/:paymentId/refunds`; service token `billing-service`; `{refundCaseId, amount, currency, reason, legalOverride, receiptSecret, expiresAt}` → `201 {refundAttemptId, status: 'authorized', approvedBy: {userId}}` |
| C. Errors, idempotency | FROZEN `refund_case_completed` (409); PROPOSED `refund_amount_not_full` (422), `refund_authorization_invalid` (409), `refund_authorization_expired` (409); IMPLEMENTED `auth_unavailable` (503). Class M (replay hash excludes the secret); guards `UNIQUE(consumeRef)`, one allocation per fact |
| D. Existing | none (`apps/payment-service/src/providers/provider.port.ts`: refunds not implemented) |
| E. Open, gates | Q1, Q2, Q8. Stage S6b, S6c. Confidence M |

#### PAY-08 Refund read

| Part | Contract |
|---|---|
| A. Frozen | — |
| B. Route and DTO | PROPOSED `GET /payment/payments/:paymentId/refunds`; producer service or payer → attempts with status and allocation |
| C. Errors, idempotency | IMPLEMENTED collapsed `not_found`; class R |
| D. Existing | read authorization already names "a payment or its refunds" (`apps/payment-service/src/authorization/authorization.service.ts`) |
| E. Open, gates | none. Stage S6b. Confidence M |

#### PAY-09 Dispute reads

| Part | Contract |
|---|---|
| A. Frozen | A provisional dispute never cancels Premium; Owner reads (S0 §1.1, §3.10) |
| B. Route and DTO | PROPOSED `GET /payment/admin/disputes`, `GET /payment/admin/disputes/:id`; Owner |
| C. Errors, idempotency | class R |
| D. Existing | none |
| E. Open, gates | **OD-11**. Stage S6e. Confidence L |

#### PAY-10 Dispute evidence

| Part | Contract |
|---|---|
| A. Frozen | Evidence is part of the dispute group (S0 §3.10) |
| B. Route and DTO | PROPOSED `POST /payment/admin/disputes/:id/evidence`; Owner; `{fileId}` through an FIL-01 grant |
| C. Errors, idempotency | OPEN; class K |
| D. Existing | none |
| E. Open, gates | **OD-11**, **OD-FILE**. Stage S6e. Confidence L |

#### PAY-11 Dispute decision

| Part | Contract |
|---|---|
| A. Frozen | The Owner decides contest or accept (S0 §1.1) |
| B. Route and DTO | PROPOSED `POST /payment/admin/disputes/:id/decision`; Owner; `{decision: 'contest' \| 'accept'}` |
| C. Errors, idempotency | PROPOSED `dispute_not_open` (409). Class K |
| D. Existing | none |
| E. Open, gates | Q11, **OD-11**. Stage S6e. Confidence M |

#### PAY-12 Reconciliation items

| Part | Contract |
|---|---|
| A. Frozen | A failed allocation leaves the fact `pending` with a reconciliation item (FC-2) |
| B. Route and DTO | PROPOSED `GET /payment/admin/reconciliation-items`; Owner |
| C. Errors, idempotency | class R |
| D. Existing | none |
| E. Open, gates | none. Stage S6h. Confidence M |

#### PAY-13 Provider fact association

| Part | Contract |
|---|---|
| A. Frozen | An unmatched fact is associated later only by an append-only association row; the fact itself never changes (FC-2; ADR-0035 C2) |
| B. Route and DTO | PROPOSED `POST /payment/admin/provider-facts/:id/associations`; Owner; `{paymentId}` or `{refundAuthorizationId}` |
| C. Errors, idempotency | PROPOSED `fact_already_associated` (409). Class N; guard one association per fact |
| D. Existing | none |
| E. Open, gates | Q11. Stage S6h. Confidence M |

#### PAY-14 Simulation adapter and harness

| Part | Contract |
|---|---|
| A. Frozen | Core V2 is certified on simulation only; production refuses to boot with the test or simulation provider or harness; production refuses non-live events; no client-chosen outcomes (S0 §1.1, FC-10) |
| B. Route and DTO | **OPEN**: whether the adapter is new beside the `test` provider or replaces it; the harness caller and shape |
| C. Errors, idempotency | OPEN |
| D. Existing | the `test` provider only (`apps/payment-service/src/providers/test-provider.ts`) |
| E. Open, gates | **OD-06** (simulation-adapter gate, roadmap §7). Stage S4f. Confidence L |

#### PAY-15 Money-command idempotency

| Part | Contract |
|---|---|
| A. Frozen | Class M retention of 90 days, backed by permanent uniqueness (S0 §3.7; [OD] D7) |
| B. Route and DTO | applies to PAY-01, PAY-03, PAY-07 |
| C. Errors, idempotency | IMPLEMENTED `idempotency_key_required`, `idempotency_key_reused` |
| D. Existing | `IDEMPOTENCY_TTL_HOURS` (default 24, maximum 720 hours), to be replaced |
| E. Open, gates | none. Stage S4g. Confidence H |

### 5.5 File

S0 §3.10 lists "evidence grants, granted reads and tickets; holds; the ticket reservation lease" and the roadmap fixes three invariants:
a grant never widens Organization scope, a held file cannot be deleted, and tickets are single-purpose and bounded (roadmap §4.2
S2-File). [ADR-0048](../adr/0048-file-service-architecture.md) contains no grant, hold or lease design. The authorization model of
these contracts is therefore **OPEN (OD-FILE)** and no route or DTO is proposed beyond FIL-06.

| Id | Contract | A. Frozen | B. Route and DTO | C. Errors, idempotency | D. Existing | E. Open, gates |
|---|---|---|---|---|---|---|
| FIL-01 | Evidence grant creation | a grant never widens Organization scope | OPEN | OPEN | none | OD-FILE; S2-File; L |
| FIL-02 | Granted read | as FIL-01 | OPEN | OPEN | `GET /file/files/:id`, `GET /file/files/:id/content` (IMPLEMENTED, ungranted) | OD-FILE; S2-File; L |
| FIL-03 | Ticket from a grant | tickets single-purpose and bounded | OPEN | OPEN | `POST /file/files/:id/tickets`, `GET /file/t/:token` (IMPLEMENTED) | OD-FILE; S2-File; L |
| FIL-04 | Hold placement | a held file cannot be deleted | OPEN (caller: Billing, Payment, Owner or Audit) | OPEN | none | OD-FILE; S2-File; L |
| FIL-05 | Hold release | append-only history (roadmap §2.1) | OPEN | OPEN | none | OD-FILE; S2-File; L |
| FIL-06 | Deletion refused while held | a held file cannot be deleted | IMPLEMENTED `DELETE /file/files/:id`; PROPOSED refusal | PROPOSED `file_held` (409) | `apps/file-service/src/deletion/` | S2-File; M |
| FIL-07 | Ticket reservation lease | tickets bounded | OPEN | OPEN | none | OD-FILE; S2-File; L |

### 5.6 Notification

| Id | Contract | A. Frozen | B. Route and DTO | C. Errors, idempotency | D. Existing | E. Open, gates |
|---|---|---|---|---|---|---|
| NOT-00 | No Core V2 contract | Notification receives no route in Core V2 (S0 §3.10) | none | — | unchanged | none; H |
| NOT-01 | Commercial IN_APP notifications | excluded from initial V2; additive later (inbox, Auth tenure, an [ADR-0046](../adr/0046-notification-service-architecture.md) amendment) (S0 §5) | none proposed | — | none | **C-3**, C-6; S7 conditional; L |

### 5.7 Audit

#### AUD-01 Audit contract v2

| Part | Contract |
|---|---|
| A. Frozen | Additive optional fields `platformId`, `companyId`, `liveMode`, `requestedBy`, `approvedBy`, `verifiedBy {service, mechanism, ref}`, `via`; stored `producerIdentityVerified`, `replayed`; versions 1 and 2 accepted; a version-1 event for a version-2 action refused; history never rewritten; new columns nullable (ADR-0069 decision 2) |
| B. Route and DTO | event envelope in `libs/audit-contract`; field names FROZEN, encodings PROPOSED |
| C. Errors, idempotency | class E; existing event-id deduplication |
| D. Existing | contract version 1 (`libs/audit-contract/src/catalog.ts`, `contract.ts`) |
| E. Open, gates | S1b. Stage S2-Audit. Confidence H |

#### AUD-02 Verified-producer classification and non-live refusal

| Part | Contract |
|---|---|
| A. Frozen | An `audit.*` event is producer-verified only if broker user = `sourceService` = the catalog owner, under ADR-0057 §13; topic-write permission limited to each producer's own actions; a human appears as `approvedBy` only from the recording service's own verification; production refuses `liveMode = false` (ADR-0069 decisions 1, 3, 7) |
| B. Route and DTO | ingestion behaviour; no route |
| C. Errors, idempotency | refusals are recorded per ADR-0057 §13 (dead letter, `provenance_conflict`) |
| D. Existing | asserted `source` header only (ADR-0049) |
| E. Open, gates | S1, C-4 before enforcement. Stage S2-Audit. Confidence H |

#### AUD-03 Owner Company timeline

| Part | Contract |
|---|---|
| A. Frozen | Scope applied before any limit; cursors bound to actor, scope, filters and window; `correlationId` and resource filters never widen scope; only records with a trusted scope row; ownership never inferred; every read recorded, `503` when it cannot be (ADR-0069 decisions 4, 5) |
| B. Route and DTO | PROPOSED `GET /audit/owner/company/records`; Owner bearer verified live; query `{from, to, action?, correlationId?, cursor?, limit?}` → `{records, nextCursor}` |
| C. Errors, idempotency | IMPLEMENTED-style `503` on an unrecordable read; PROPOSED `invalid_cursor` (400). Class R |
| D. Existing | Organization-scoped Owner read (AUD-07) |
| E. Open, gates | **OD-14**. Stage S2-Audit. Confidence M |

#### AUD-04 Operator Platform view

| Part | Contract |
|---|---|
| A. Frozen | As AUD-03, for an operator over a Platform (ADR-0069 decision 5) |
| B. Route and DTO | PROPOSED `GET /audit/operator/platforms/:platformId/records`; operator with an active assignment to the Platform, verified live; DTO as AUD-03 |
| C. Errors, idempotency | as AUD-03; class R |
| D. Existing | none |
| E. Open, gates | **OD-14**. Stage S2-Audit. Confidence M |

#### AUD-05 Legal holds

| Part | Contract |
|---|---|
| A. Frozen | Legal holds are append-only events; the retention role skips held records; no normal role can delete (ADR-0069 decision 6) |
| B. Route and DTO | **OPEN** (caller and route) |
| C. Errors, idempotency | OPEN; class N on the hold event id (PROPOSED) |
| D. Existing | retention (`apps/audit-service/db/migrations/0003_retention.sql`); no holds |
| E. Open, gates | **OD-13**, Q11. Stage S2-Audit. Confidence L |

#### AUD-06 Service platform read (unchanged)

| Part | Contract |
|---|---|
| A. Frozen | Records without a trusted scope row stay readable only by service callers with `read_platform` (ADR-0069 decision 4) |
| B. Route and DTO | IMPLEMENTED `GET /audit/platform/records` (`read_platform`; each page recorded as `platform_query.executed`) |
| C. Errors, idempotency | unchanged; class R |
| D. Existing | `apps/audit-service/src/query/` |
| E. Open, gates | none. Confidence H |

#### AUD-07 Owner Organization read (scope rules)

| Part | Contract |
|---|---|
| A. Frozen | Human-facing reads select only records with a trusted scope row (ADR-0069 decision 4) |
| B. Route and DTO | IMPLEMENTED `GET /audit/owner/organizations/:organizationId/records`; shape unchanged |
| C. Errors, idempotency | unchanged; class R |
| D. Existing | `apps/audit-service/src/owner/owner-query.controller.ts` |
| E. Open, gates | none. Stage S2-Audit (scope rows). Confidence H |

### 5.8 Release

S0 §3.10 lists three Owner reads (products, releases, policy history), verified live under ADR-0050 (roadmap §4.2 S2-Rel). They are
reads: no step-up is proposed, and no receipt or idempotency applies. Production enablement stays MOVE V3 (roadmap G-2).

| Id | A. Frozen | B. Route and DTO (PROPOSED) | C. Errors, idempotency | D. Existing | E. Open, gates |
|---|---|---|---|---|---|
| REL-01 | Owner read of products | `GET /release/admin/products` → `[{product, components[]}]`; Owner of the operating Company, own bearer | existing Owner verification refusals; class R | Owner writes only (`apps/release-service/src/admin/admin.controller.ts`) | S2-Rel; M |
| REL-02 | Owner read of releases | `GET /release/admin/products/:product/components/:component/releases` → releases with state and timestamps | as REL-01 | as REL-01 | S2-Rel; M |
| REL-03 | Owner read of policy history | `GET /release/admin/products/:product/components/:component/compatibility-policy/history` → append-only policy entries | as REL-01 | append-only `CompatibilityPolicy` ([ADR-0051](../adr/0051-release-management-and-client-compatibility.md)) | S2-Rel; M |

### 5.9 Events

Every family follows ADR-0057 §13: publisher `user_id` = its broker user; per-consumer provenance committed before the handler;
default-exchange deliveries only against a stored row; financial consumers never process an unverified event; no backfilled
verification; production financial and notification consumers refuse missing or false `liveMode` (FROZEN). Existing version-1
`invoice.created` and `payment.*` stay compatible: additive fields only (S0 §3.7, FROZEN).

| Id | Event | A. Frozen | B. Names and payload | D. Existing | E. Open, gates; stage; conf. |
|---|---|---|---|---|---|
| EVT-01 | `payment.created`, `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired` | version 1 compatible; `liveMode` on every event | names IMPLEMENTED; PROPOSED additive `payerType`, `purpose`, `platformId`, `liveMode` | `apps/payment-service/src/events/` | S1, S4; H |
| EVT-02 | `refund.*` | `refund.case_completed` emitted once (FC-3) | `refund.case_completed` FROZEN; `refund.authorized`, `refund.succeeded`, `refund.failed` PROPOSED | none | S6; M |
| EVT-03 | dispute and chargeback facts to Billing | Billing applies B10 from verified Payment events only (§13.5) | names PROPOSED (`payment.dispute.opened`, `payment.dispute.closed`); payload **OPEN** (OD-11) | none | S6e; L |
| EVT-04 | `invoice.created` | version 1 compatible; still flows after S1 (S0 §8) | IMPLEMENTED (the only event Billing publishes today) | `apps/billing-service/src/events/event-catalog.ts` | S1, S3; H |
| EVT-05 | `billing.subscription.*` | produced only by B3 and B4/B5 effects; idempotent by deterministic identity (ADR-0044 B12) | family FROZEN; names PROPOSED (`billing.subscription.period_started`, `billing.subscription.period_extended`, `billing.personal_subscription.purchase_recorded`, `billing.personal_subscription.purchase_reversed`) | none | S3; M |
| EVT-06 | `billing.recovery.*` | recovery produces only `billing.recovery.*` (ADR-0044 B12) | names PROPOSED (`billing.recovery.payment_recorded`, `billing.recovery.completed`, `billing.recovery.surplus_recorded`) | none | S6f; M |
| EVT-07 | `audit.*` | version 1 and 2 (AUD-01); broker-verified producers (AUD-02) | catalog-governed (`libs/audit-contract/src/catalog.ts`); new actions such as `authorization_receipt.issued` PROPOSED | version 1 | S1, S2-Audit; H |
| EVT-08 | Auth domain events (`user.*`, `membership.*`) | §13 applies (S0 §3.7) | IMPLEMENTED names unchanged | `apps/auth-service/src/events/event-catalog.ts`, `domain-events.ts` | S1; H |
| EVT-09 | Owner-authorized re-emission of one named outbox row | deterministic event ids; Owner authorization; an audit record (ADR-0057 §13.7) | mechanism **decided for payment-service** (S0-C4): a restricted command inside the producer, no route; Owner only, bound to the exact event; `payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired` version 1; serialization pipeline version 1; durable intent and producer audit evidence (PROPOSED action `payment.event_reemitted`) before publication; **OPEN** for every other producer | none | **OD-15** (resolved for Payment), Q11; S1c (R1, R2); M |

## 6. New error codes proposed by this register

All are PROPOSED except those marked FROZEN or IMPLEMENTED; each needs ADR-0054 catalog and localization entries.

| Service | Codes |
|---|---|
| Auth | FROZEN `receipt_issued_response_lost`, `receipt_already_consumed`, `authority_revoked`; PROPOSED `consume_ref_conflict` (status FROZEN), `receipt_invalid`, `receipt_expired`, `receipt_binding_invalid`, `idempotency_key_required`, `idempotency_key_reused` (both new in Auth) |
| Billing | FROZEN `refund_case_completed`; PROPOSED `billing_platform_exists`, `product_target_immutable`, `fee_above_cap`, `fee_proposal_not_pending`, `invoice_routing_invalid`, `product_not_available`, `platform_not_configured`, `checkout_uncertain`, `member_not_eligible`, `assistance_restricted`, `assistance_request_not_pending`, `cash_collection_time_invalid`, `cash_collection_already_reported`, `settlement_channel_open`, `assistance_request_not_settleable`, `cash_return_not_open`, `cash_return_not_reported`, `correction_not_permitted`, `refund_dispute_open`, `refund_case_exists`, `recovery_obligation_closed`, `surplus_not_owed`, `surplus_refund_requires_entire_payment`, `surplus_not_evidenced`, `late_settlement_refused`, `write_off_not_permitted` |
| Payment | FROZEN `refund_case_completed`; PROPOSED `payer_purpose_mismatch`, `payment_uncertain`, `refund_amount_not_full`, `refund_authorization_invalid`, `refund_authorization_expired`, `dispute_not_open`, `fact_already_associated` |
| File | PROPOSED `file_held` |
| Audit | PROPOSED `invalid_cursor` |
| Release | none |

## 7. Open decision register

Nothing in this section is decided. Documenting a proposal elsewhere in this register does not resolve any item here.

| Id | Decision required | Blocks |
|---|---|---|
| **OD-R6a** | R-6a concerns Auth's organization-administrator grant facts (S0 §3.10). Its original behavioural contract was not recovered. The observed `GET /auth/grants` behaviour (AUTH-08 D) is evidence, not authority to define the correction. The Owner restates the requirement before any specification (DOC-1) is written | S2-Auth R-6a work package |
| **OD-FILE** | The authorization design of evidence grants, granted reads, grant tickets, holds and the ticket reservation lease: grantor, grantee, scope, lifetime, revocation, hold callers; whether it needs a new ADR or a decision recorded against ADR-0048 | S2-File; S5/S6 evidence (BIL-30, BIL-32, PAY-10) |
| Q1 | `legalOverride`: meaning, type and source | AUTH-01, PAY-07, BIL-23 |
| Q2 | `reason`: closed reason-code vocabulary or free text, and its values | AUTH-01 canonical form; audit content; BIL-23 |
| Q3 | Retention of Auth issue idempotency keys and receipt rows; purge | AUTH-01 |
| Q4 | Scope of ADR-0067's "only digests …, the issuer and the session"; pepper custody and rotation | AUTH-01, AUTH-02 storage |
| Q5 | Content and contract version of the receipt audit actions; ordering with S2-Audit | AUTH-01 to AUTH-03 audit |
| Q6 | Answer to a same-key replay of an expired `issued` receipt | AUTH-01 |
| Q7 | Disposition of a receipt refused for `authority_revoked` | AUTH-02 |
| Q8 | Clock-skew margin before an unconsumed receipt is definitively expired for payment-service | AUTH-03, PAY-07 recovery |
| Q9 | Inbound `SERVICE_TOKENS` in Auth and payment-service's admission record | AUTH-02, AUTH-03, AUTH-06 |
| Q10 | Approval of the idempotency taxonomy of §2, including the retention of the new administrative class K | every class K entry |
| Q11 | Step-up purposes beyond `refund.authorize` and those frozen by S0: which Owner actions require a step-up, and the purpose names | AUTH-04 and every Owner command |
| Q12 | Effect of Company lifecycle state (ADR-0060) on receipt issue and consumption | AUTH-01, AUTH-02 |
| OD-01 | Meaning of "eligible member" for direct purchase (FC-12, [OD] D2) | BIL-10 |
| OD-02 | Relation of `billing_platform` to the existing Platform currency configuration (`0009_platform_currency.sql`) | BIL-01 |
| OD-03 | Fee cap, delegation and proposal model: scope (Platform or Organization), units, limits | BIL-04 to BIL-07 |
| OD-04 | How an assistance request selects and freezes its approved school fee | BIL-13, BIL-19 |
| OD-05 | Premium catalog products, plan durations and prices (the catalog gate, S0 §6) | BIL-02, BIL-03 configuration |
| OD-06 | Simulation adapter: new beside the `test` provider or replacing it; harness caller and shape (the simulation-adapter gate, roadmap §7) | PAY-14 |
| OD-07 | School actor set for assistance, settlement, cash return, dispute response, restrictions and recovery in an **active** Organization; V-5 covers inactive Organizations only | BIL-15 to BIL-17, BIL-21, BIL-26, BIL-28, BIL-29, BIL-31 |
| OD-08 | The actor who starts an Organization-payer attempt | BIL-16, BIL-29, PAY-03 |
| OD-09 | Who may decline an assistance request | BIL-14 |
| OD-10 | Fraud-hold mechanics: what is held, the review clock, compensation computation | BIL-27 |
| OD-11 | Dispute and chargeback lifecycle, evidence formats and event payloads (real-provider formats are deferred, S0 §5) | PAY-09 to PAY-11, EVT-03 |
| OD-12 | Legal-remedy record shape (execution deferred, S0 §5) | BIL-35 |
| OD-13 | Audit legal-hold caller and route | AUD-05 |
| OD-14 | Audit human-read cursor format, window limits and page size | AUD-03, AUD-04 |
| OD-15 | Re-emission mechanism (route or command) and its caller. **Resolved for payment-service (S0-C4, 2026-10-23): a command, Owner only; OPEN for every other producer** | EVT-09 |

Every route name, DTO, error code and idempotency class marked PROPOSED in §4 to §6 also awaits Owner approval at implementation
review (S0 §3.10), even when it is not listed here.

## 8. Gates and dependencies

The gates are those of the [roadmap](./core-v2-s-execution-roadmap.md) §7; this register adds only the open decisions of §7 above.

| Stage | Register entries | Open decisions | Roadmap gates |
|---|---|---|---|
| S1 | EVT-01, EVT-04, EVT-07 to EVT-09 | OD-15 | G-1, C-4 (before enforcement) |
| S2-Auth | AUTH-01 to AUTH-08 | Q1 to Q9, Q11, Q12, OD-R6a | G-1, G-3, G-7 (production) |
| S2-Audit | AUD-01 to AUD-05, AUD-07 | Q5, OD-13, OD-14 | S1b, G-1 |
| S2-File | FIL-01 to FIL-07 | OD-FILE | G-1 |
| S2-Rel | REL-01 to REL-03 | none | G-1 |
| S3 | BIL-01 to BIL-12, EVT-05 | OD-01 to OD-03, OD-05, Q10, Q11 | S1, G-2 (DOC-3), DOC-5, catalog |
| S4 | PAY-01 to PAY-06, PAY-14, PAY-15, EVT-01 | OD-06, OD-08 | S1, G-2 (DOC-3), DOC-6, simulation adapter |
| S5 | BIL-13 to BIL-22, BIL-26 | OD-04, OD-07 to OD-09 | V-4, V-5 |
| S6 | BIL-23 to BIL-25, BIL-27 to BIL-35, PAY-07 to PAY-13, EVT-02, EVT-03, EVT-06 | Q1, Q2, Q8, OD-10 to OD-12, OD-FILE | S2-Auth, S2-Audit, S2-File, S3 to S5, DOC-4 |
| S7 | AUTH-09, NOT-01 | — | C-3, C-6, DG-3 |
| S8 | ORG-00 (no Core V2 contract) | — | PR #319, C-5, A5.4-G1, F7 |

## 9. Related documents

- [S0 architecture freeze](./core-v2-s0-architecture-freeze.md) and [S1–S8 execution roadmap](./core-v2-s-execution-roadmap.md).
- [Auth authorization receipts](./core-v2-d-a2-auth-authorization-receipts.md) (companion contract).
- ADRs: [0035](../adr/0035-financial-service-boundaries.md), [0036](../adr/0036-money-parties-and-source-references.md),
  [0044](../adr/0044-subscription-entitlement-final-model.md), [0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md),
  [0046](../adr/0046-notification-service-architecture.md), [0048](../adr/0048-file-service-architecture.md),
  [0049](../adr/0049-audit-trail-architecture.md), [0050](../adr/0050-platform-administration-and-verified-human-authority.md),
  [0051](../adr/0051-release-management-and-client-compatibility.md),
  [0054](../adr/0054-localized-error-messages-and-stable-error-codes.md), [0057](../adr/0057-messaging-conventions.md),
  [0060](../adr/0060-company-platform-organization-lifecycle.md),
  [0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md),
  [0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md),
  [0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md).
