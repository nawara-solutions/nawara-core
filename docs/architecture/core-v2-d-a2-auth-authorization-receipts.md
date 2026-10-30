# Core V2 D-A2: Auth authorization receipts (technical contract)

- **Status:** PROPOSED TECHNICAL CONTRACT, prepared 2026-10-22 under the architecture owner's D-A2 documentation authorization, on `main`
  at `42f3f8b01cc06f22ef8bc87bc4845ea62fef0f67` (the PR #321 merge of the [S1–S8 execution roadmap](./core-v2-s-execution-roadmap.md)).
- **Implements:** [ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md) (Proposed; its direction, P0 decision
  C-1, and wording approved at the [S0 freeze](./core-v2-s0-architecture-freeze.md)). It is the receipt part of documentation item DOC-2
  ([roadmap](./core-v2-s-execution-roadmap.md) §1.4, §8) and the prerequisite of the S2-Auth receipt work packages (roadmap §4.2).
- **What it is not:** an ADR, an ADR acceptance, an implementation authorization or an approval of any PROPOSED item. Documenting a
  proposal does not approve it. It changes no frozen S0 decision; where it and the S0 record or ADR-0067 differ, they govern.
  **Nothing described here as FROZEN, PROPOSED or OPEN is implemented.**
- **Not in scope:** R-6a, the correction of the organization-administrator grant facts. R-6a is a separate, unresolved S2-Auth
  dependency whose original specification was not recovered; it is recorded as **OD-R6a** in the
  [contract register](./core-v2-d-a2-contract-register.md#7-open-decision-register).

## 1. Labels and sources

Every requirement carries one label:

| Label | Meaning |
|---|---|
| **IMPLEMENTED** | exists in code on `main` today; the path is cited |
| **FROZEN** | stated by ADR-0067, the S0 record or another S0-approved ADR; the section is cited |
| **PROPOSED** | a new technical choice of this document; requires Owner approval at implementation review (S0 §3.10) |
| **OPEN** | not decided by any source and not decided here; an Owner decision is required (§16) |

A route name or a DTO is never FROZEN because the behaviour behind it is.

## 2. Existing Auth step-up behaviour (IMPLEMENTED)

| Item | Behaviour | Source |
|---|---|---|
| Step-up issuance | `POST /auth/admin/step-up` (and `POST /auth/admin/step-up/webauthn-options` for passkeys), by an authenticated Owner | `apps/auth-service/src/owner/owner.controller.ts` |
| Purpose allow-list | `STEP_UP_METHODS` lists each purpose and its accepted methods; a factor-only purpose (`totp`, `webauthn`) refuses the secret key | `apps/auth-service/src/owner/step-up.service.ts` (`STEP_UP_METHODS`) |
| Proof storage | `owner_step_up`: owner, method, factor, purpose, session family, `verifiedAt`, `expiresAt`; database checks: lifetime at most 15 minutes, consumption inside the window, factor present exactly when the method is not the secret key | `apps/auth-service/db/migrations/0002_owner_operator_hardening_and_owner_step_up.sql` |
| Lifetime | `STEP_UP_TTL_SEC`, default 300 s, maximum 900 s | `apps/auth-service/src/config/app-config.ts` |
| Consumption | one atomic statement: same owner, same session, same purpose, unconsumed, unexpired | `StepUpService.consume` |
| Verification for services | `POST /auth/step-up/verify` verifies and consumes a proof for a calling service; `hierarchy.reference.repair` is refused there without being consumed | `apps/auth-service/src/auth/auth.controller.ts`, `StepUpService.verifyForService` |
| Audit | Auth's local audit records `owner.step_up` (success, failure) and `owner.step_up.consume` (denied) | `StepUpService` |
| Reusable primitives | `hmacHex(pepper, domain, …parts)`: HMAC-SHA-256 with a pepper held outside the database, a domain label and length-prefixed parts; `canonicalJson`: sorted keys, refuses `undefined` | `apps/auth-service/src/crypto/hmac.ts`, `apps/auth-service/src/hierarchy/snapshot.ts` |
| Error codes | `step_up_required`, `step_up_unsupported`, `verification_failed` and the rest of `AuthErrorCode` | `apps/auth-service/src/errors.ts` |

**Not present today:** a `refund.authorize` purpose; any Auth route called by another service; inbound service tokens in Auth (Auth
holds only an outbound `ORGANIZATION_SERVICE_TOKEN`); `Idempotency-Key` handling in Auth; a receipts table; any refund code in
payment-service (`apps/payment-service/src/providers/provider.port.ts`: refunds are not implemented).

## 3. Frozen requirements (FROZEN)

| Id | Requirement | Source |
|---|---|---|
| F-1 | A receipt is issued to the active Owner of a Company after a factor step-up for purpose `refund.authorize` (TOTP or passkey; never the secret key) | ADR-0067 decision 1 |
| F-2 | The binding is `{operation: 'refund', audience: 'payment-service', companyId, refundCaseId, paymentId, amount, currency, reason, legalOverride}`; `companyId` must equal the Owner's Company | ADR-0067 decision 1 |
| F-3 | The receipt lives 10 minutes | ADR-0067 decision 1 |
| F-4 | Auth stores only digests of the secret and of the canonical binding, the issuer and the session; the plaintext secret is returned once and never stored | ADR-0067 decision 1 |
| F-5 | The issue request carries an idempotency key. A replay with the same key voids the receipt **only while it is `issued`** and answers `409 receipt_issued_response_lost`; the Owner then issues a new receipt with a new step-up | ADR-0067 decision 2 |
| F-6 | A consumed receipt is never voided; its replay answers `409 receipt_already_consumed`, without the secret | ADR-0067 decision 2 |
| F-7 | Only the bound audience may consume, through a new deny-by-default `AUTH_SERVICE_POLICY` (Auth's first service-callee route) | ADR-0067 decision 3 |
| F-8 | Consumption is one conditional update requiring matching digests, status `issued`, an unexpired receipt, and an issuer still active and still Owner of `companyId` | ADR-0067 decision 3; roadmap §4.2 |
| F-9 | Consumption is idempotent on a caller-supplied `consumeRef`; a different `consumeRef` on a consumed receipt answers `409` | ADR-0067 decision 3 |
| F-10 | A lookup by `consumeRef` lets the consumer recover a lost response without the secret | ADR-0067 decision 3 |
| F-11 | Consumption is the authorization commit point. A later loss of the Owner's authority does not cancel a consumed authorization; before consumption it refuses it (`authority_revoked`) | ADR-0067 decision 4 |
| F-12 | billing-service relays the secret in memory only and never persists it | ADR-0067 decision 5 |
| F-13 | payment-service first commits a durable refund intent whose `consumeRef` is the refund attempt's id, then consumes the receipt, then commits `authorized` and answers; provider dispatch is asynchronous, from the durable intent, with a stable provider idempotency key | ADR-0067 decision 5 |
| F-14 | A crash between these steps is recovered through the `consumeRef` lookup; an unconsumed, expired receipt leaves the intent `authorization_expired` and the case awaiting a new authorization | ADR-0067 decision 5 |
| F-15 | A refund case is `full_purchase`, or a full refund of a payment that produced no entitlement; partial-amount refunds are deferred. A definitive provider failure ends the attempt and a further attempt requires a new receipt. A completed refund case never accepts a new attempt (`409 refund_case_completed`). No new refund case while a dispute on the payment is open | ADR-0067 decision 6; S0 §3.1 FC-3; [OD] D3, D4 |
| F-16 | Auth records issuance, consumption and voiding as audit actions; payment-service records `approvedBy` from Auth's consumption response (verified actor), never from a request body | ADR-0067 decision 7; ADR-0069 decision 3 |
| F-17 | payment-service's only new call to auth-service is the consumption of refund authorization receipts (see §11.3) | ADR-0035 clarification C4 |
| F-18 | `consumeRef` is a permanent uniqueness key; one refund attempt per consumption | S0 §3.7 |
| F-19 | The 10-minute lifetime covers only the synchronous chain; asynchronous work runs on the consumed authorization | ADR-0067, Consequences |
| F-20 | payment-service's admission as an Auth caller is recorded with the service-token admissions (ADR-0042) when the policy is implemented | ADR-0067, Consequences; roadmap §4.2 |

## 4. Actors and end-to-end flow (PROPOSED)

The sequence below arranges F-1 to F-16 into one flow. The step order is PROPOSED except where a step cites a FROZEN requirement.

1. The Owner opens a refund case in billing-service (contract BIL-23). Billing determines `paymentId`, the full `amount` and the
   `currency` from its own records; the Owner never supplies an amount (F-15: full refunds only).
2. The Owner performs a step-up for `refund.authorize` (§2 route, new purpose; F-1).
3. The Owner calls AUTH-01 (§5.1) with the step-up proof and the binding (F-2) and receives `{receiptId, secret, expiresAt}` once.
4. The Owner calls BIL-24 with the secret and `expiresAt`. Billing holds the secret in memory only (F-12) and relays it with the
   binding to payment-service (PAY-07).
5. payment-service validates the binding against its own records **before** consuming: the payment exists, its seller Company equals
   `companyId`, `amount` and `currency` equal the full refundable amount of that payment, and the refund case admits a new attempt
   (F-15). Auth cannot perform these checks: it has no call to Billing or Payment and knows nothing of `refundCaseId` or `paymentId`
   beyond their presence in the binding.
6. payment-service commits the durable intent with `consumeRef` = the new refund attempt's id and the receipt's `expiresAt` (F-13).
7. payment-service calls AUTH-02. On success it commits `authorized` with `approvedBy` from the response (F-13, F-16) and answers
   Billing, which answers the Owner.
8. Provider dispatch runs asynchronously from the intent (F-13).

## 5. Routes and DTOs

All three route names, all DTO field names, types and response shapes are **PROPOSED**. The fields of the binding are FROZEN (F-2);
their wire types are PROPOSED except where marked OPEN.

### 5.1 AUTH-01 Issue a receipt

| Item | Contract | Label |
|---|---|---|
| Route | `POST /auth/admin/authorization-receipts` (beside the Owner's existing `/auth/admin/step-up` routes) | PROPOSED |
| Caller | the authenticated Owner, own bearer and session; F-1 | FROZEN (caller), PROPOSED (mechanism) |
| Header | `Idempotency-Key`, required (F-5); format as Payment's existing key | FROZEN (presence), PROPOSED (format) |
| Request | `{ stepUpToken: string, binding: Binding }` | PROPOSED |
| `Binding` | `operation: 'refund'`; `audience: 'payment-service'`; `companyId: uuid`; `refundCaseId: uuid`; `paymentId: uuid`; `amount: integer` in minor units, > 0 (as Payment's `bigint` amount, `apps/payment-service/db/migrations/0002_payment.sql`); `currency: string`, ISO 4217 upper case; `reason`: **type OPEN (Q2)**; `legalOverride`: **type and meaning OPEN (Q1)** | FROZEN (field set), PROPOSED (types), OPEN (two fields) |
| Response `201` | `{ receiptId: uuid, secret: string, expiresAt: timestamp }`; `secret` is a base64url encoding of 32 random bytes and appears only in this response | PROPOSED |
| Order of checks | (1) idempotency replay lookup; (2) step-up consumption; (3) Owner and `companyId` validation; (4) insert. A replay is answered before any step-up is required or consumed, so a replay never burns a proof | PROPOSED |

### 5.2 AUTH-02 Consume a receipt

| Item | Contract | Label |
|---|---|---|
| Route | `POST /auth/service/authorization-receipts/consume` | PROPOSED |
| Caller | a service token whose caller is admitted by `AUTH_SERVICE_POLICY` for operation `authorization_receipt.consume`; only the bound audience (`payment-service`) | FROZEN (audience only, F-7), PROPOSED (operation name) |
| Request | `{ secret: string, binding: Binding, consumeRef: uuid }` | PROPOSED |
| Response `200` | `{ receiptId, consumeRef, consumedAt, approvedBy: { userId }, companyId }` | PROPOSED |
| Identical repeat | the same secret, binding and `consumeRef` on a receipt already consumed under that `consumeRef` returns the same `200` (F-9) | FROZEN (idempotency), PROPOSED (shape) |

### 5.3 AUTH-03 Look up a consumption (recovery)

| Item | Contract | Label |
|---|---|---|
| Route | `POST /auth/service/authorization-receipts/consumptions/lookup` (a `POST` so the binding never travels in a URL) | PROPOSED |
| Caller | service token admitted for `authorization_receipt.lookup`; **only the caller that consumed the receipt** (which is the bound audience, F-7) may read it | FROZEN (purpose, F-10), PROPOSED (mechanism) |
| Request | `{ consumeRef: uuid, binding: Binding }`; no secret (F-10) | PROPOSED |
| Response `200` | the AUTH-02 response for that consumption, without any secret | PROPOSED |
| Response `404 not_found` | no consumption exists under that `consumeRef` **for this caller and this binding**; a mismatched caller or binding is indistinguishable from absence | PROPOSED |

The binding in the lookup ties the recovered consumption to the original durable attempt: Auth answers only when the stored
`consumeRef` **and** the stored binding digest both match, so a successful lookup can never authorize an unrelated attempt or a
different amount (§10.2).

## 6. Binding, canonical form and digests

| Item | Contract | Label |
|---|---|---|
| Canonical binding | `canonicalJson` (§2) over exactly the F-2 keys; an unknown, missing or `undefined` key is refused (`400 receipt_binding_invalid`) | PROPOSED |
| Binding digest | `hmacHex(pepper, 'nawara.auth.receipt.binding.v1', canonicalBinding)` | PROPOSED |
| Secret digest | `hmacHex(pepper, 'nawara.auth.receipt.secret.v1', secret)`, unique | PROPOSED |
| Versioning | the version tag sits in the digest domain; a change of the binding is a new domain, never a reinterpretation | PROPOSED |
| Canonical form of `reason` and `legalOverride` | depends on their types | OPEN (Q1, Q2) |
| Pepper | Auth's existing pepper or a dedicated one; custody and rotation | OPEN (Q4) |

## 7. Issuance, replay and void

### 7.1 States

`issued → consumed` (terminal) and `issued → voided` (terminal). **Expired** is derived (`status = 'issued' AND expiresAt ≤ now`) and is
never a stored transition (PROPOSED). No other transition exists (PROPOSED; enforced in §13).

### 7.2 Issue and replay outcomes

"Same key" means the same Owner and the same `Idempotency-Key`. "Same request" means the same replay hash (§12).

| Situation | Outcome | Label |
|---|---|---|
| New key, valid step-up, valid binding | insert `issued`; `201` with the secret | FROZEN (F-1 to F-4), PROPOSED (status) |
| Same key, same request, receipt `issued` and unexpired | void it; `409 receipt_issued_response_lost`; the Owner issues a new receipt with a new step-up | FROZEN (F-5) |
| Same key, same request, receipt `consumed` | `409 receipt_already_consumed`; no secret; never voided | FROZEN (F-6) |
| Same key, same request, receipt already `voided` | `409 receipt_issued_response_lost` again (the void is idempotent) | PROPOSED |
| Same key, same request, receipt `issued` but expired | **OPEN (Q6)** | OPEN |
| Same key, different request | `409 idempotency_key_reused` | PROPOSED |
| Concurrent duplicate requests with the same key | serialized by the uniqueness of (issuer, key); the loser follows the replay rules above | PROPOSED |
| Step-up proof missing, expired, reused, wrong purpose or session | the existing step-up refusal (`step_up_required` and the step-up codes) | IMPLEMENTED (mechanism) |
| Binding `companyId` is not the Owner's Company, or the binding is malformed | `400 receipt_binding_invalid` | FROZEN (rule, F-2), PROPOSED (code) |
| Caller is not an active Owner | the existing authentication and authorization refusals | IMPLEMENTED (mechanism) |
| Company lifecycle state (ADR-0060) at issue | **OPEN (Q12)** | OPEN |

A replay never returns a secret (F-4, F-6). Whether a replay of the same key **after** the issue-key retention window is treated as a
new request depends on the retention (Q3); the window must not be shorter than the receipt lifetime, or a lost-response replay could
not find its `issued` receipt (derived from F-3 and F-5; the value is OPEN).

## 8. Consumption

| Situation | Outcome | Label |
|---|---|---|
| Caller is not the bound audience, or lacks the policy operation | refused by the caller policy; no state change | FROZEN (F-7), PROPOSED (code: the service-kit caller-policy refusal) |
| Secret digest matches no receipt, or the binding digest does not match | `409 receipt_invalid`; one code for every mismatch, so the response reveals neither which field differed nor whether the secret exists | PROPOSED |
| Receipt `issued`, unexpired, issuer still active and still Owner of `companyId` | one conditional update to `consumed` recording `consumeRef`, `consumedAt` and the consuming caller; `200` | FROZEN (F-8, F-11), PROPOSED (shape) |
| Issuer no longer active, or no longer Owner of `companyId` | `403 authority_revoked`; no state change | FROZEN (refusal and code, F-11), PROPOSED (HTTP status) |
| What happens afterwards to a receipt refused for `authority_revoked` (stays `issued` until it expires, or is voided) | **OPEN (Q7)** | OPEN |
| Receipt `issued` but expired | `409 receipt_expired`; no state change | FROZEN (refusal, F-8), PROPOSED (code) |
| Receipt `voided` | `409 receipt_invalid` | PROPOSED |
| Receipt `consumed` under the same `consumeRef`, same binding | the original `200` (idempotent) | FROZEN (F-9) |
| Receipt `consumed` under a different `consumeRef` | `409 consume_ref_conflict` | FROZEN (409, F-9), PROPOSED (code name) |
| `consumeRef` already used to consume a different receipt | `409 consume_ref_conflict` | FROZEN (uniqueness, F-18), PROPOSED (code) |
| Two concurrent consumptions | exactly one conditional update succeeds; the other follows the rows above | FROZEN (F-8) |
| Company lifecycle state (ADR-0060) at consumption | **OPEN (Q12)** | OPEN |

## 9. Expiration

| Item | Contract | Label |
|---|---|---|
| Lifetime | `expiresAt = issuedAt + 10 minutes` | FROZEN (F-3) |
| Boundary | a receipt is consumable while `now < expiresAt`; at or after `expiresAt` it is refused | PROPOSED |
| Clock | Auth's database clock decides expiry at consumption | PROPOSED |
| After a consumed authorization | expiry has no effect; asynchronous work continues on the consumption (F-19) | FROZEN |
| Clock-skew margin that payment-service waits beyond `expiresAt` before a definitive recovery decision (§10.2) | **OPEN (Q8)** | OPEN |

## 10. Crash recovery

### 10.1 Auth

| Crash point | Recovery | Label |
|---|---|---|
| After the receipt insert, before the response reaches the Owner | the Owner replays the same key: the receipt is voided and `409 receipt_issued_response_lost` answers (§7.2) | FROZEN (F-5) |
| After the consumption update, before the response reaches payment-service | payment-service retries AUTH-02 with the same secret (if still in memory), or uses AUTH-03 | FROZEN (F-9, F-10) |
| Before the consumption update commits | nothing changed; the receipt stays `issued` until consumed or expired | FROZEN (F-8, single statement) |

### 10.2 payment-service

payment-service never persists the secret (PROPOSED; it extends F-12's rule for Billing to the consumer, so that no service other than
the Owner's client and the in-flight requests ever holds it). The durable intent records the binding (none of whose fields is secret),
`consumeRef` = its own attempt id, and the receipt's `expiresAt`.

| Crash point | Recovery | Label |
|---|---|---|
| Intent committed, AUTH-02 not yet sent or its answer lost | AUTH-03 with the intent's own `consumeRef` and binding: `200` → commit `authorized` with `approvedBy` from the response | FROZEN (F-13, F-14), PROPOSED (mechanism) |
| AUTH-03 answers `404` before `expiresAt` + margin | retry later; the outcome is not yet definitive (an in-flight consumption may still commit before expiry) | PROPOSED |
| AUTH-03 answers `404` after `expiresAt` + margin | definitive: Auth refuses consumption after expiry, so none can commit later; the intent becomes `authorization_expired` and the case awaits a new authorization | FROZEN (outcome, F-14), PROPOSED (rule), OPEN (margin, Q8) |
| `authorized` committed, before the answer to Billing | Billing's retry of PAY-07 with the same idempotency key returns the stored answer | PROPOSED |
| Auth unavailable | `503 auth_unavailable` (existing Payment code); the intent stays unauthorized; no `authorized` without a consumption | IMPLEMENTED (code), PROPOSED (use) |

**Association with the original attempt.** A consumption found by AUTH-03 authorizes only the attempt whose id equals its `consumeRef`
and whose recorded binding produced the matching digest. payment-service never applies a recovered consumption to another attempt,
case, payment or amount, and `consumeRef` is unique (F-18), so one consumption authorizes at most one attempt (PROPOSED mechanism,
FROZEN rule).

### 10.3 billing-service

Billing holds the secret only in memory (F-12). If Billing crashes after relaying, the Owner's retry of BIL-24 with the same
idempotency key is answered by Billing's stored outcome or, when none was stored, by a new relay that payment-service answers from its
own idempotency record or from the recovery above (PROPOSED). Billing's replay hash excludes the secret (§12).

## 11. Owner verification and Payment service authorization

### 11.1 Owner verification at issue

The issuer is verified live from current database state, never from a token claim, in the same manner as Auth's other Owner routes:
active user of kind `owner`, the step-up of F-1, and `companyId` equal to the Owner's Company (F-1, F-2; mechanism IMPLEMENTED for
other Owner routes, use PROPOSED). Company lifecycle effects are OPEN (Q12).

### 11.2 `AUTH_SERVICE_POLICY` and inbound service tokens

| Item | Contract | Label |
|---|---|---|
| Policy | deny by default; admits exactly `payment-service` | FROZEN (F-7) |
| Format | `{"callers":{"payment-service":{"operations":["authorization_receipt.consume","authorization_receipt.lookup"]}}}`, parsed by the generic service-kit caller policy (`libs/service-kit/src/service-auth/caller-policy.ts`), cross-checked against `SERVICE_TOKENS` | PROPOSED |
| Inbound `SERVICE_TOKENS` in Auth | new configuration; token provisioning and rotation | PROPOSED (need), OPEN (Q9: configuration and admission record) |
| Admission record | payment-service recorded with the ADR-0042 service-token admissions | FROZEN (F-20) |

### 11.3 Reconciliation with ADR-0035 clarification C4

ADR-0035 C4 states that payment-service's only new call to auth-service is "the consumption of refund authorization receipts".
ADR-0067 decision 3, approved at the same S0 freeze, defines consumption to include a lookup by `consumeRef` that lets the consumer
recover a lost response. This contract reads C4's "consumption" as the consumption contract of ADR-0067 decision 3 as a whole: AUTH-02
and its recovery read AUTH-03. The lookup confers no new authority: it only returns a consumption that already happened, to the caller
that performed it, for the binding it consumed. No other payment-service → auth-service call is added, and the existing live
verification of users through Auth (ADR-0033) is unchanged, as C4 states. No ADR is edited by this reading; if the Owner prefers an
explicit wording note in ADR-0035, that is a separate ADR change (G-1).

## 12. Secret-handling safeguards

| Rule | Label |
|---|---|
| The plaintext secret exists only in the AUTH-01 response, the Owner's client, and the in-flight requests BIL-24, PAY-07 and AUTH-02 | FROZEN (F-4, F-12), PROPOSED (consumer side) |
| No receipt secret and no step-up proof is ever stored in an idempotency record, in a hash intended for request replay, in a log line or in an audit event, in Auth, Billing or Payment | PROPOSED (Owner safeguard of this documentation slice) |
| AUTH-01's replay hash covers the canonical binding only; it excludes `stepUpToken`. Its idempotency record stores the receipt id and outcome, never the response body | PROPOSED |
| BIL-24's and PAY-07's replay hashes exclude the secret | PROPOSED |
| Request logging, error bodies and validation messages never echo `secret` or `stepUpToken` | PROPOSED |
| Exact replay-hash construction (algorithm, covered fields beyond the exclusions above) | PROPOSED, confirmed at implementation review |

## 13. Database enforcement (PROPOSED)

Auth table `authorization_receipt` (new migration; no existing row changes, ADR-0067 Consequences):

| Column or constraint | Purpose |
|---|---|
| `id` uuid primary key | receipt id |
| `issuerUserId` FK `user`, `sessionFamilyId` | the issuer and the session (F-4) |
| `stepUpId` FK `owner_step_up`, unique | one receipt per step-up proof |
| `idempotencyKey`, `requestHash`, `UNIQUE (issuerUserId, idempotencyKey)` | F-5 replay detection (§12 exclusions apply) |
| `secretDigest` unique, `bindingDigest` | F-4 |
| `status` CHECK `IN ('issued','consumed','voided')` | §7.1 |
| `issuedAt`, `expiresAt`, CHECK `expiresAt = issuedAt + interval '10 minutes'` | F-3 |
| `consumedAt`, `consumeRef` unique, `consumedBy` (the consuming caller) | F-9, F-18; AUTH-03 caller check |
| `voidedAt` | F-5 |
| CHECK pairing `status` with exactly its timestamps; CHECK `consumedAt < expiresAt` | state consistency |
| Row trigger: only `issued → consumed` and `issued → voided`; terminal states never change | §7.1 |
| Runtime role: INSERT, SELECT, and UPDATE of the lifecycle columns only; no DELETE; digests, issuer and session immutable | append-only discipline |

`companyId` and the other binding fields are **not** stored in clear; the consumption check (F-8) takes `companyId` from the presented
binding, whose digest proves it is the issued one. Whether lifecycle metadata (`status`, timestamps, key, `consumeRef`, `consumedBy`)
falls within F-4's "only" is **OPEN (Q4)**. Row and key retention and any purge are **OPEN (Q3)**.

## 14. Audit actions

| Item | Contract | Label |
|---|---|---|
| Obligation | issuance, consumption and voiding are recorded | FROZEN (F-16) |
| Action names | `authorization_receipt.issued`, `authorization_receipt.consumed`, `authorization_receipt.voided` (the catalog's `resource.past_verb` convention, `libs/audit-contract/src/catalog.ts`) | PROPOSED |
| Actors | issued and voided: the Owner (user kind `owner`); consumed: the service `payment-service`, with `approvedBy` the issuer | PROPOSED |
| Content | at most `receiptId`, `companyId` and `bindingDigest`; never the secret, the step-up proof or the amount | PROPOSED (exclusions FROZEN in spirit by §12) |
| Contract version | the actions need `companyId`, an [ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md) version-2 field; whether they wait for S2-Audit or are emitted in version 1 without it | OPEN (Q5) |
| Free text | catalog changes accept no free text, which constrains `reason` | OPEN (Q2) |

## 15. Error codes

Each new code needs a catalog entry and localized messages ([ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md)).

| Code | HTTP | Where | Label |
|---|---|---|---|
| `receipt_issued_response_lost` | 409 | AUTH-01 | FROZEN (ADR-0067 decision 2) |
| `receipt_already_consumed` | 409 | AUTH-01 | FROZEN (ADR-0067 decision 2) |
| `authority_revoked` | 403 | AUTH-02 | FROZEN code (ADR-0067 decision 4); PROPOSED status |
| `consume_ref_conflict` | 409 | AUTH-02 | FROZEN status (ADR-0067 decision 3); PROPOSED name |
| `receipt_invalid` | 409 | AUTH-02 | PROPOSED |
| `receipt_expired` | 409 | AUTH-02 | PROPOSED |
| `receipt_binding_invalid` | 400 | AUTH-01, AUTH-02 | PROPOSED |
| `idempotency_key_required` | 400 | AUTH-01 | PROPOSED in Auth (IMPLEMENTED in Payment and Billing) |
| `idempotency_key_reused` | 409 | AUTH-01 | PROPOSED in Auth (IMPLEMENTED in Payment) |
| `not_found` | 404 | AUTH-03 | IMPLEMENTED code, PROPOSED use |
| `step_up_required`, `step_up_unsupported`, `verification_failed` | existing | AUTH-01 (step-up) | IMPLEMENTED |
| `refund_case_completed` | 409 | BIL-24 / PAY-07 (not Auth) | FROZEN (S0 §3.1 FC-3) |

## 16. Open decisions

Each is unresolved. The [contract register](./core-v2-d-a2-contract-register.md#7-open-decision-register) holds the full register.

| Id | Question | Blocks |
|---|---|---|
| Q1 | Meaning, type and source of `legalOverride` | AUTH-01 binding type; canonical form |
| Q2 | `reason`: closed reason-code vocabulary or free text; its values | canonical form; audit content |
| Q3 | Retention of Auth issue idempotency keys and of receipt rows; purge | §13; replay behaviour after retention |
| Q4 | Scope of F-4's "only digests …, the issuer and the session" (lifecycle metadata, `consumedBy`); pepper custody and rotation | §6, §13 |
| Q5 | Audit content and contract version of the receipt actions; ordering with S2-Audit | §14 |
| Q6 | Answer to a same-key replay of an `issued` receipt that has expired | §7.2 |
| Q7 | Disposition of a receipt refused for `authority_revoked` | §8 |
| Q8 | Clock-skew margin before payment-service treats an unconsumed receipt as definitively expired | §10.2 |
| Q9 | Inbound `SERVICE_TOKENS` configuration in Auth and the admission record of payment-service | §11.2 |
| Q11 | New factor-only step-up purposes other than `refund.authorize` | register AUTH-04 |
| Q12 | Effect of Company lifecycle state (ADR-0060) on issue and consumption | §7.2, §8, §11.1 |

Q10 (the idempotency class taxonomy) concerns the register as a whole and is recorded there.

## 17. Negative tests and crash-recovery acceptance criteria (for S2-Auth and S6b certification)

Negative tests (each at the API level, and at the database level where marked "DB"):

1. A secret-key step-up for `refund.authorize` is refused.
2. A step-up proof of another purpose, another session or already consumed is refused; a proof cannot issue two receipts (DB).
3. A binding whose `companyId` is not the Owner's Company is refused; a binding with an extra, missing or `undefined` key is refused.
4. A non-Owner caller cannot issue.
5. Each binding field altered at consumption (operation, audience, companyId, refundCaseId, paymentId, amount, currency, reason,
   legalOverride) gives `receipt_invalid`.
6. A caller other than `payment-service`, or without the policy operation, cannot consume or look up.
7. A consumption at or after `expiresAt` is refused.
8. Two parallel consumptions: exactly one succeeds.
9. A different `consumeRef` on a consumed receipt gives `consume_ref_conflict`; a `consumeRef` reused for another receipt is refused (DB).
10. An issuer deactivated or no longer Owner before consumption gives `authority_revoked`; after consumption the authorization stands.
11. A lost-response replay voids the receipt; a later consumption of that receipt fails.
12. A replay of a consumed receipt answers `receipt_already_consumed` and never contains a secret.
13. AUTH-03 with the right `consumeRef` but another binding, or from another caller, answers `404`.
14. Direct SQL: updating a digest, the issuer or a terminal status, deleting a row, and an `expiresAt` other than `issuedAt + 10
    minutes` are refused (DB).
15. No secret or step-up proof appears in any idempotency row, replay hash, log line or audit event (inspection test).

Fault injection and acceptance:

1. Crash between the receipt insert and the response: the replay voids and answers `409 receipt_issued_response_lost`.
2. Crash between payment-service's intent and AUTH-02, and between AUTH-02 and `authorized`: recovery through AUTH-03 reaches
   `authorized` exactly once, or `authorization_expired` after expiry and the margin.
3. Auth unavailable during consumption: `503`, no `authorized`.
4. Acceptance: no path yields two consumptions of one receipt, two attempts for one consumption, an `authorized` intent without a
   consumption, a consumption applied to an attempt other than its `consumeRef`, or a persisted plaintext secret.

## 17a. S6e amendment: dispute-decision receipts (the Owner's R6E-3, 2026-10-29; IMPLEMENTED)

A second receipt operation authorizes an Owner's contest-or-accept decision on one Payment dispute (PAY-11). Every rule of §5 to §15 applies
unchanged (one receipt per proof, 10 minutes by the database clock, digest-only storage, the secret once, the replay rules, single
consumption by `payment-service`, live authority at consumption, recovery lookup); only the binding and the step-up purpose differ.

| Item | Contract |
|---|---|
| `Binding` | `operation: 'dispute_decision'`; `audience: 'payment-service'`; `companyId: uuid` (the Owner's own Company); `disputeId: uuid`; `paymentId: uuid`; `decision: 'contest' \| 'accept'`. Exactly these fields; a refund field in it, or a dispute field in a refund binding, is `receipt_binding_invalid` |
| Step-up | the dedicated factor-only purpose `payment.dispute.decide` (TOTP or passkey, never the secret key). Auth-local like `refund.authorize`: consumed only by issuance, refused without consumption by `POST /auth/step-up/verify`. Each operation consumes only its own purpose, so a refund proof never yields a decision receipt and the reverse |
| Separation | the canonical binding (so every digest) includes the operation, Company, dispute, payment and decision: a receipt never authorizes another decision, dispute, payment, Company or a refund (one indistinguishable `receipt_invalid`) |
| Audit | the Auth-local `authorization_receipt.issued` record adds `operation` (`refund` or `dispute_decision`); the central audit actions are unchanged and carry no binding |
| Database | no migration: `authorization_receipt` stores digests only and is operation-agnostic |
| Consumer | Payment's PAY-11 (S6e dispute slice) consumes it after this prerequisite is merged; until then nothing issues an Owner decision |

## 17b. S6e-H amendment: fraud-hold receipts (the Owner's H-2, 2026-10-29; IMPLEMENTED)

Two more receipt operations authorize an Owner's placement and release of one fraud hold (BIL-27). Every rule of §5 to §15 applies unchanged;
only the binding, the step-up purpose and the audience differ.

| Item | Contract |
|---|---|
| `Binding` | `fraud_hold_place`: `audience: 'billing-service'`, `companyId`, `holdId` (chosen before placement), `beneficiaryUserId`, `productId`, `reason` (bounded code). `fraud_hold_release`: the same without `reason`. Exactly these fields |
| Step-up | `billing.fraud_hold.place` and `billing.fraud_hold.release`, factor-only, Auth-local, each consumed only by its own operation's issuance; refused without consumption by `POST /auth/step-up/verify` |
| Audience (F-7, amended) | each binding names its one audience; `AUTH_SERVICE_POLICY` may now admit `billing-service`, and AUTH-02 / AUTH-03 serve a caller only for bindings naming it: billing-service can consume no refund or dispute receipt, payment-service no fraud-hold receipt |
| Separation | the canonical binding includes the operation, Company, hold, beneficiary, product and reason: one receipt never authorizes another hold, beneficiary, product, reason, Company or the other action |
| Database | no migration |

## 17c. S6f amendment: external recovery-surplus receipts (the Owner's R6F-5, 2026-10-29; IMPLEMENTED)

| Item | Contract |
|---|---|
| `Binding` | `recovery_surplus_external`: `audience: 'billing-service'`, `companyId`, `surplusId`, `organizationId`, `amount` (minor units, > 0), `currency` (ISO 4217). Exactly these fields |
| Step-up | `billing.recovery_surplus.record_external`, factor-only, Auth-local, consumed only by this operation's issuance |
| Separation | the canonical binding separates Company, surplus, Organization, amount and currency; billing-service alone consumes it (F-7 as amended in §17b) |
| Meaning | the Owner's authorization to RECORD an external repayment; it moves no money and is not a provider fact. Billing still requires File evidence and the Organization's confirmation (R-3b) |

## 17d. S6g amendment: late-settlement application receipts (the Owner's R6G-1, R6G-3, 2026-10-30; IMPLEMENTED)

| Item | Contract |
|---|---|
| `Binding` | `late_settlement_apply`: `audience: 'billing-service'`, `companyId`, `lateSettlementId`, `assistanceRequestId`, `beneficiaryUserId`, `reasonCode` ∈ `cash_not_returned_attested` \| `cash_not_returned_evidenced` (closed; no free text, no override). Exactly these fields |
| Step-up | `billing.late_settlement.apply`, factor-only, Auth-local, consumed only by this operation's issuance |
| Separation | the canonical binding separates Company, late settlement, request, beneficiary and reason code; billing-service alone consumes it (F-7 as amended in §17b) |
| Meaning | S0 §3.4 L-4 condition 1 only: the Owner's authorization to APPLY one verified late assisted settlement as its request's single purchase. It moves no money and proves no evidence: Billing still checks the attestation or evidence, the absence of a purchase, the unconfirmed cash return and every contradiction rule (L-4 conditions 2 to 5, L-6) |

## 18. Related documents

- [ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md), [ADR-0035](../adr/0035-financial-service-boundaries.md)
  (C4), [ADR-0025](../adr/0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) (Owner step-up),
  [ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md),
  [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md),
  [ADR-0054](../adr/0054-localized-error-messages-and-stable-error-codes.md),
  [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md),
  [ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md).
- [S0 architecture freeze](./core-v2-s0-architecture-freeze.md) §3.1 (FC-3, FC-7), §3.7, §3.10, §8;
  [S1–S8 execution roadmap](./core-v2-s-execution-roadmap.md) §1.4, §4.2 (S2-Auth), §4.6 (S6b), §8 (DOC-2).
- [Core V2 D-A2 contract register](./core-v2-d-a2-contract-register.md): entries AUTH-01 to AUTH-09, BIL-23 to BIL-25, PAY-07, PAY-08.
