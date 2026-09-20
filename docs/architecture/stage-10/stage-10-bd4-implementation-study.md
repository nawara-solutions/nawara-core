# Stage 10: BD-4 implementation architecture study (ADR-0042)

- **Status:** implementation architecture study. **Nothing here is implemented, and nothing here changes ADR-0042.** It designs *how* the accepted decisions could be built, and it separates four kinds of statement so that no unresolved policy is decided by accident.
- **Date:** 2026-09-20
- **Baseline:** `main` at `6e7ddcc`, plus the uncommitted Stage 10 documents. ADR-0042 is **Accepted** (architecture only). Runtime, migrations and configuration are unchanged.
- **Update (OPEN-1 and OPEN-2, 2026-09-20):** the owner accepted ADR-0040 decisions 5 and 6 and the production-readiness and cutover gates (BD-7a to BD-7e). **Section 16** records the resolution and the readiness for *starting* Stage 10.1. It supersedes the verdict of section 15. **Wherever sections 1 to 15 call ADR-0040 "Proposed", that was its status when they were written; it is now Accepted.**
- **Update (owner direction on DEC-1 to DEC-5, 2026-09-20):** the five decisions of sections 12 to 14 are now **resolved** by the owner's direction and recorded in [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) Amendment 1, [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) Amendment 1 and the [owner sheet](./stage-10-bd4-owner-decisions.md) section 7. **Section 15** is the resolution and the current readiness. Where sections 12 to 14 call DEC-1 to DEC-5 open, section 15 governs.
- **Update (owner answers recorded):** the architecture owner answered AD-1 to AD-5. The answers are recorded as given in **section 11**, together with the questions they leave open (RQ-1 to RQ-4) and an updated readiness statement. Sections 1 to 10 are the study as first written and are kept as history; where they call AD-1 to AD-5 "needed", section 11 governs.
- **Inputs:** [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md), the [owner-decision sheet](./stage-10-bd4-owner-decisions.md) (the owner's D1 to D4 answers), the [BD-4 study](./stage-10-bd4-service-authorization-study.md), [ADR-0033](../../adr/0033-service-to-service-authentication-and-user-identity.md), [ADR-0039](../../adr/0039-organization-ownership-and-cross-service-migration-authority.md), [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) (Proposed), [ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Proposed).

**Vocabulary used in every table and heading**

| Label | Meaning |
|---|---|
| **ACCEPTED** | decided in ADR-0042 or by the owner's D1 to D4 answers; the design must not change it |
| **EXISTING** | read from source in this study (file and line named); not a decision |
| **IC-n** (implementation choice) | a design detail this study *proposes*; it needs architecture-owner approval before it is built, but it does not change what ADR-0042 decided |
| **AD-n** (architecture decision needed) | a policy question the accepted decisions do **not** answer and this study will **not** answer; options are listed neutrally, with no recommendation |

---

## 1. Summary of what the source check found

Nine findings drive the design. Each was verified in source (section 3).

1. **Auth's service token in Payment reaches almost nothing today.** Auth's only call to Payment is `GET /payment/licenses/:id/status`, which Payment does not implement. The token is accepted by the guard on five Payment routes, but every object-level rule ties a caller to `payment.producer`, so `auth-service` can create payments *as producer `auth-service`* and can read, cancel or sync only payments it produced itself. It can never start an attempt (payer-only). It cannot reach a payment produced by `billing-service`. The BD-4 study's "full route access" is true only at the guard; the effective exposure is that **any registered caller may create payments**, with no admission check (O-13).
2. **Producer identity cannot be spoofed by the client today.** The producer comes from the authenticated token (`@CallerService()`), not from the body, and unknown body fields are rejected globally. D3 validation items 2 and 4 are already satisfied for Payment's create route.
3. **Billing makes exactly three Payment calls:** create, `GET` and cancel. It makes no attempt or sync call.
4. **Auth's step-up is owner-only.** The step-up machinery takes an `ownerId`, and its allow-list already includes `platform.create`. Operators have no step-up factor; they use a time-boxed working code. D4 requires operator step-up for sensitive operations, so **the mechanism does not exist** (AD-1).
5. **Organization Service has no Auth client and no outbound HTTP by design.** D4 adds its first dependency on Auth.
6. **Hierarchy validation (D2/D3 item 6) cannot be enforced before the cutover.** Until Organization Service holds the data (it is not authoritative and has no production registration), a lookup against it cannot validate anything (AD-5).
7. **The provisioning capability must not be usable before Organization Service is authoritative,** or it would create Companies Auth cannot see. ADR-0040's authoritative marker (a state row) is not built (IC-12).
8. **Auth's bootstrap today inserts the Company itself** (`owner-tools.ts:31`). D1 removes that step after the cutover, so Auth needs another way to learn the Company id (AD-4).
9. **D2 selects Platform scope but names no platforms.** Which platforms each admitted producer may act in is not stated (AD-3), and neither is which operations `auth-service` may use in Payment (AD-2).

**Verdict when first written:** BLOCKED BY additional architecture decisions (section 10). **After the owner's AD-1 to AD-5 answers:** see section 11.6.

---

## 2. What is already fixed (ACCEPTED)

| Ref | Fixed by the accepted record |
|---|---|
| ADR-0042 d1 | service authentication unchanged: opaque token, caller name only |
| ADR-0042 d2, D2 | server-side policy in each target, deny by default; **Platform** is the scope dimension; provisioning is outside it; Platform scope is resolved through the organization-service hierarchy; **no `platformId` on Billing invoices or Payment records**; `platform_currency.platformId` stays currency configuration and a Platform may permit several currencies |
| ADR-0042 d3, D1 | capabilities: reference read, full read, write, provisioning; read and write separate |
| ADR-0042 d4, D3 | per-target explicit admission: `billing-service` and `auth-service` to Payment only; Organization Service and other producers not admitted; seven minimum-validation items; rate limiting is not authorization |
| ADR-0042 d5 | first-assertion lookup, reference capability, bounded, fail closed on creates, memoized only while ids are never reused and anchors never change |
| ADR-0042 d6, D4 | Client, then Auth bearer, then Organization Service; facts from Auth (owner company, active operator assignments, organization-admin memberships), evaluated against Organization Service's anchors; clients supply no facts; a new Auth read endpoint; `/auth/me` not extended |
| ADR-0042 d7, D4 | org admins edit metadata only where the facts grant it; operators need step-up for sensitive operations, not for low-risk metadata unless classified sensitive |
| ADR-0042 d7, D1 | different mechanisms for the first Company and later Companies; a dedicated non-human provisioning identity; credentials not exposed to human clients; no Auth direct-database path after authoritative |
| ADR-0042 d8 | Auth login, refresh, `/auth/me`, registration, join and ordinary authentication-path operations never depend on Organization Service |
| ADR-0042 d9, d10 | audit floor and a durable actor record before production writers; rotation and revocation decided by the owner before production |

---

## 3. Verified current state (EXISTING)

### 3.1 Authentication and configuration in the kit

- `ServiceTokenGuard` (`libs/service-kit/src/service-auth/service-token.guard.ts`) hashes the presented bearer, compares it in constant time against **every** digest with no early exit, sets `req.serviceCaller`, and fails with one generic 401. It carries no scope, claim, audience or expiry.
- `parseServiceTokens` (`service-token.ts`): entries `<caller>:<64 hex>`, at most two per caller (`MAX_TOKENS_PER_CALLER = 2`), duplicate digests refused at startup.
- The kit exports the guard, `CallerService`, `SERVICE_TOKENS`, `HttpAuthClient` (`getIdentity` via `/auth/me`, `hasPlatformAccess` via `/auth/platform-access/:id`, both fail closed with 503), `RateLimitService` (DB-backed `kit_rate_limit`, hashed keys), `DbModule`, migrations and the outbox.
- **Kit boundary rule** (`scripts/lib/checks.mjs`): the kit may not contain product terms or declarations named after financial concepts (`Invoice`, `Payment`, `Ledger`, ...). A generic policy helper is technical infrastructure and is allowed; policy *contents* naming Payment concepts are not.

### 3.2 Every Payment route, its guard and its object-level rule

`ServiceOrUserGuard` (`apps/payment-service/src/auth/service-or-user.guard.ts`) tries service-token digests first; on a match the caller is `{kind:'service', service}` and the bearer is never sent to Auth; otherwise the bearer is asked of Auth live (inactive identity 401, Auth down 503).

| Route | Guard | Object-level rule (`AuthorizationService`) | What Auth's token does today | What Billing's token does |
|---|---|---|---|---|
| `POST /payment/payments` | `ServiceTokenGuard` | none beyond the producer being the caller; per-producer rate limit; the producer of the new record is the authenticated caller | **succeeds: creates a payment whose producer is `auth-service`** | creates (used) |
| `GET /payment/payments/:id` | `ServiceOrUserGuard` | read: producer equals the caller service, or a `user` payer; else collapsed 404 | reads only payments with producer `auth-service`; else 404 | reads its own (used by the reconciler) |
| `POST /payment/payments/:id/cancel` | `ServiceTokenGuard` | cancel: producer only, `Idempotency-Key` required; else 404 | cancels only its own payments | cancels its own (used) |
| `POST /payment/payments/:paymentId/attempts` | `ServiceOrUserGuard` | start attempt: **payer only**; a service is never a payer (403 if it is the producer, else 404) | never succeeds | never succeeds; not called |
| `POST /payment/payments/:paymentId/attempts/:attemptId/sync` | `ServiceOrUserGuard` | sync: producer or payer | syncs only its own payments' attempts | not called |
| `POST /payment/webhooks/:provider` | none (provider signature) | not a service-token route | not applicable | not applicable |
| health, readiness, `/docs` | none / kit | not applicable | not applicable | not applicable |

`ServiceOrUserGuard` routes: exactly three (`GET :id`, attempt start, sync). `ServiceTokenGuard` routes: two (create, cancel). Source: `payments.controller.ts`, `attempts.controller.ts`, `authorization.service.ts`.

**Authentication versus producer authorization, precisely:** the guard authenticates *who is calling*. The only authorization today is the object rule "the caller is the payment's producer (or its payer)". There is **no rule that says which callers may create**. That absence is O-13, and it is what D3 fills.

### 3.3 Other callers and targets

| Caller | Target | Credential and route | EXISTING state |
|---|---|---|---|
| Billing | Payment | `billing-service` token (`docker-compose.yml:134`, registered in Payment at `:164`); create, `GET`, cancel (`payment-client.ts:139,151,159`) | works |
| Auth | Payment | `auth-service` token (registered at `:164`); `GET /payment/licenses/:orgId/status` (`payment-client.ts:22`) | **route does not exist in Payment**; no other Auth call |
| Billing, Payment | Auth | user bearer only, `GET /auth/me` | works; never a service token |
| any | Billing | Billing has 14 service-token or combined-guard routes (invoices, payment requests, catalog); **no inbound caller registered** in compose | no effect today |
| any | Organization Service | 12 service-token routes; `SERVICE_TOKENS` empty in compose; no production configuration in the repository | no caller can reach it |

### 3.4 Organization Service and Auth today

- **Organization Service** wires `HealthModule`, `DbModule`, `ServiceAuthModule`, `IdempotencyModule` and the three domain modules. It deliberately has **no Auth client, no events, no outbound HTTP** (`app.module.ts` comment). Creates require `Idempotency-Key`. Company create is one route behind the class-level `ServiceTokenGuard`; every registered caller has full read/write (RR-1).
- **Auth grant sources already exist** as Auth-owned relationship facts: `owner.companyId`; `platform_assignment(operatorId, platformId, active)`; membership with `isOrganizationAdmin`; `/auth/me` already returns `adminTier` and `memberships[]` (with `isOrganizationAdmin`) but no owner company and no assignments. `PlatformAccessService.organizationAuthority()` already returns `owner | operator | org_admin` from Auth's own tables, which derives from Auth's own tables (after the cutover, from the reference cache that ADR-0040, Proposed, would keep).
- **Step-up:** `STEP_UP_METHODS` is a server-side allow-list of purposes (for example `platform.create`, `platform_assignment.grant`, `organization.admin.grant`); `StepUpService` is keyed by `ownerId` and `sid`, single-use, consumed in Auth's database. Operators have working-code sessions and no step-up. The `x-step-up-token` header name is existing.
- **Bootstrap:** `bootstrap-owner` takes an advisory lock, returns `created:false` if any owner exists, else uses the first Company or **inserts one**, then creates the owner (`owner-tools.ts`).

---

## 4. Target component architecture

### 4.1 Layers (ACCEPTED shape, IC-n for the mechanics)

```text
service caller                                    human caller
     |                                                 |
     v                                                 v
 1 authenticate (who)                            1 authenticate (Auth bearer -> Auth)
   ServiceTokenGuard                               (no service token is ever a user)
   -> serviceCaller                                    |
     |                                                 v
     v                                            2 grant facts (from Auth, server-derived)
 2 admission + capability (may this caller,            |
   in THIS target, do THIS operation)                  v
   deny by default                                 3 evaluate against the target's own anchors
     |                                                 |
     v                                                 v
 3 object-level rule (this record's producer)     4 step-up check if the operation is sensitive
     |                                                 |
     v                                                 v
 4 scope (organization -> platform, allowed set)  5 handler (Idempotency-Key)  -> audit
     |
     v
 5 handler (idempotent) -> audit
```

Rate limiting is **not a layer of authorization**. It stays a separate, per-producer technical control (D3) and is recorded here only to fix its position: after admission, so a producer that is not admitted cannot write limiter rows (IC-9 confirms the order).

### 4.2 The policy component (IC-1, IC-2)

The accepted decision needs "a policy mapping each caller to capabilities and, where relevant, a platform scope, deny by default, in each target". Two ways to build it; neither changes ADR-0042:

| Option | Shape | Consequence |
|---|---|---|
| **P1: generic helper in the kit, contents per service** | the kit gains a small `ServicePolicy` type, a parser and a guard factory that takes capability names as opaque strings; each service supplies its own policy data and capability names | one implementation and one test suite; the kit stays technical (no Payment-named declarations); `check:repo` must be extended to keep policy contents out of the kit |
| **P2: per-service code** | each service implements its own check | no kit change; three near-identical implementations that can drift |

Policy data format and source (IC-2): a validated structure loaded at startup (like `SERVICE_TOKENS`) that fails startup on an unknown caller, an empty admission for a registered caller, or a malformed platform id. Whether it is an environment variable, a mounted file or a committed constant is an implementation choice that also decides *where the documented admission list lives* (the owner's D3 says "documented"). Both options preserve "deny by default": a registered token with **no** policy entry is refused.

### 4.3 Service request flow: Payment create (target)

```text
billing-service                       Payment                                   Organization Service
     | POST /payment/payments           |                                                |
     | Bearer <service token>           |                                                |
     |--------------------------------->|                                                |
     |                                  | 1 ServiceTokenGuard -> "billing-service"       |  EXISTING
     |                                  | 2 policy: (billing-service, payment.create)?   |  NEW
     |                                  |     no -> 403 + audit denial (fail closed)     |
     |                                  | 3 per-producer rate limit                      |  EXISTING
     |                                  | 4 DTO (unknown fields rejected; producer       |  EXISTING
     |                                  |   never from the body)                         |
     |                                  | 5 scope: organizationId ->                     |  NEW (AD-5: activation)
     |                                  |     memo hit? else reference read ------------>| reference capability
     |                                  |     <-- { organizationId, platformId, companyId } (ids only)
     |                                  |     platformId in caller's allowed set? else deny + audit
     |                                  | 6 idempotent create or replay (producer,       |  EXISTING
     |                                  |     paymentRequestId)                          |
     |<---------------------------------| 7 result                                        |
```

Failure behavior: an unseen organization with Organization Service unreachable **fails closed with 503 on create**; a memo hit proceeds; reads and Auth paths are never affected (ADR-0042 d5). Replays are covered in 5.6.

### 4.4 D2: organization to platform resolution (IC-4)

- **Location of the mapping:** Organization Service only. Billing and Payment store no platform id (their invoices and payments carry `organizationId`) and **must not gain one** for this purpose. The resolution helper is a client component in each consumer (`HierarchyReferenceClient`, one port and one HTTP adapter, like `AuthClient`).
- **What the reference read returns:** ids and parents only (organization id, platform id, company id). Today Organization Service has only full-representation routes, so the capability needs either a new restricted route or a capability-based field filter (IC-4).
- **Memo:** ADR-0042 allows memoizing a positive result only while ids are never reused and anchors never change (the id-reuse invariant is still Proposed). Options: process-local memory (no schema; re-asks after restart) or a small table in each consumer (a migration, and effectively a local copy of anchors). A memo proves identity and anchors, **not** active status (BD-5).
- **Platform allowed set:** compared with the resolved platform id; the set's contents are AD-3.
- **Separation from currency:** `platform_currency` is untouched. The resolution helper could in principle serve B-036a later, but this study does not couple them, and a Platform may permit several currencies.
- **Guard against convenience:** propose a DB invariant test (IC-13) asserting that no `platformId` column exists on the Billing invoice tables or the Payment payment tables.

### 4.5 D3: admission matrix (shape only)

The owner admitted two producers to one target. The cells below are the **shape** of the policy; the operation cells are AD-2, not an answer.

| Caller | Target | Admitted (ACCEPTED) | Operations | Platform set |
|---|---|---|---|---|
| `billing-service` | Payment | yes | EXISTING use: create, read, cancel (the three calls it makes today); **AD-2 confirms** | AD-3 |
| `auth-service` | Payment | yes | **AD-2**: not stated by the owner; EXISTING use: none effective | AD-3 |
| Organization Service | any | no (ACCEPTED) | none | none |
| any other producer | any | no (ACCEPTED) | none | none |

The seven minimum-validation items map as follows.

| # | Item | Status | Where |
|---|---|---|---|
| 1 | valid service credential | EXISTING | `ServiceTokenGuard`, `ServiceOrUserGuard` |
| 2 | credential belongs to the registered producer | EXISTING | digest to caller name |
| 3 | admitted for the target and operation | NEW | policy layer (4.2) |
| 4 | producer and request identity not overridable by client input | EXISTING in Payment | producer from `@CallerService()`; unknown fields rejected. To be re-verified per target in tests |
| 5 | resource ownership and producer invariants server-side | EXISTING in Payment | `AuthorizationService`; `organizationId == seller.id` for organization sellers |
| 6 | organization and platform scope server-side where applicable | NEW | 4.3 and 4.4; activation is AD-5 |
| 7 | invalid or unauthorized requests fail closed | partly EXISTING | Auth-down 503 exists; the policy layer must default to deny |

### 4.6 D1: provisioning identity and first Company

**Provisioning identity (later Companies).** Proposed shape (IC-7): a dedicated caller name registered in Organization Service's `SERVICE_TOKENS`, mapped by policy to the **provisioning capability only**, on the Company create route only. It holds no read, write or reference capability; the create response returns the Company, so it needs no read. Its plaintext token is generated with `generateServiceToken()` and held only by the deployment or provisioning process (not in compose files, not in Auth, not in any human client); only the SHA-256 digest is in the service configuration. It is non-human, so it never goes through the user-bearer path.

**Gate (IC-12).** The capability is refused until Organization Service is authoritative (ADR-0040's state row, not built) or the environment is explicitly a fresh one. Without this gate a Company created in Organization Service before the cutover would not exist in Auth.

**Two environment classes.**

```text
Fresh environment (no Auth data)                Existing environment (Auth holds a Company)
--------------------------------                --------------------------------------------
1 migrate Organization Service (explicit)       ADR-0040 sequence (Proposed): import, freeze,
2 authoritative state set (Stage 10.1)            verify, activate with NO caller token,
3 register provisioning digest                    verify, register Auth's read token, switch,
4 first-Company operation -> Company id           then open other callers
5 register Auth's read token                    The imported Company already exists: the
6 Auth owner bootstrap uses the Company id        provisioning identity is registered only
   (no Company insert in Auth)  [AD-4]            AFTER cutover verification, so the
7 provisioning digest kept or removed [owner,     zero-write window is never weakened.
   ADR-0042 d10]
```

> **Superseded for fresh environments (2026-09-20).** The diagram above orders "authoritative state set" before the first-Company operation. [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) Amendment 1 (A1.3) governs: the first Company is created while the state row is `inactive`, and authority is activated once, at step 8. The existing-environment column is unchanged.

**How the bootstrap obtains the resulting Company identity.** The create response carries the Company `id`; the operator-run step reports it. How Auth's owner bootstrap then learns it is **AD-4**: the accepted record says Auth no longer inserts the Company, and ADR-0040's cache accepts rows only through a validated `ensure(id)` fetch.

**Bootstrap mechanism (IC-7).** Options that preserve "explicit, never at service startup": a small command in the Organization Service package that calls its own API with the provisioning credential; or a deployment-pipeline step making the same call. Direct database insertion is not offered because it would bypass the guard, idempotency and audit. Idempotency uses the existing `Idempotency-Key`, so a retried step is safe.

### 4.7 D4: human path and Auth grant facts (IC-5, IC-6)

```text
Client                    Organization Service                          Auth
  | Bearer <user token>          |                                        |
  |----------------------------->| 1 take the bearer (never a service     |
  |                              |   token on this path)                  |
  |                              | 2 ask Auth, bearer forwarded to Auth   |
  |                              |   ONLY ---------------------------------->| AuthGuard: live session, isActive
  |                              |                                        |  derive facts from Auth-owned tables
  |                              |<-- caller's own facts -----------------| (owner company; active assignments;
  |                              |                                        |  org-admin memberships)
  |                              | 3 load target anchors from its own DB  |
  |                              | 4 evaluate rule for the operation      |
  |                              | 5 sensitive? require step-up (AD-1)    |
  |                              | 6 mutate with Idempotency-Key; audit   |
  |<-----------------------------| 7 result                               |
```

- **Candidate fact set (not a schema):** user id and active flag; the owner's company id if an owner; the ids of the platforms with an **active** assignment if an operator; the ids of organizations for which the user holds an active organization-administrator membership. The owner-decision answer also lists the target hierarchy and the operation, which Organization Service holds itself.
- **Rule evaluation is pure and lives in Organization Service:** owner if `ownerCompanyId == platform.companyId`; operator if the platform is in the assigned set; organization administrator if the membership's **organization id** equals the target organization (Organization Service uses its own platform for that organization, not the platform id Auth returns), and only for metadata edits.
- **One call can authenticate and return the facts** (an Auth read endpoint authenticated by the user bearer alone), which avoids a second `/auth/me` round trip (IC-6).
- **No caching of grant facts** (authorization is live, ADR-0027). A revoked assignment or membership must take effect on the next request.
- **Client neutrality (ACCEPTED):** no rule reads a client type, user agent, origin or install identifier; the only inputs are the bearer, the operation, the target, and the optional `x-step-up-token`. A test asserts this (section 7).
- **Auth independence (ACCEPTED):** the new Auth endpoint is a read about the caller; Auth still calls Organization Service only for ADR-0040's administrative first-touch flows, never on login, refresh, `/auth/me`, registration, join or ordinary authentication paths. A static boundary check should fail if a module on those paths imports an Organization Service client.
- **Exact contract:** endpoint name, versioning, pagination of assignments, error semantics (the existing `platform-access` route collapses to 403 or 404; ADR-0042 says these are not carried over automatically), timeout, correlation-id propagation and the retry rule are IC-6 and are not fixed here.

**Step-up (AD-1).** Today step-up is single-use, owner-only, and consumed in Auth. Two separate facts follow:
- *For operators the mechanism does not exist.* D4 requires it for sensitive operations; which factor proves it is AD-1.
- *For owners* the allow-list already contains `platform.create`; ADR-0042 decision 7 adopts the ADR-0022 rules, so owner step-up on the moved operations is presumed to carry over, but the owner should confirm.
- *Evidence path (IC-11):* Organization Service cannot consume Auth's token itself (Auth has no service-token callee side and the token is bound to Auth's database). The likely shape is a user-bearer-authenticated Auth verify-and-consume call made by Organization Service before it mutates. Consume-first is fail-safe (a failed write means the user steps up again); the interaction with `Idempotency-Key` replays must be specified so a replay returns the stored result without a second consume.

---

## 5. Security analysis

| Concern | Design response | Status |
|---|---|---|
| **Fail closed** | policy default is deny; a registered token with no policy entry is refused at startup or per request; unreachable Organization Service fails creates for unseen organizations with 503; unreachable Auth on the human path fails 503; reads and Auth's own paths never depend on Organization Service | design; IC-3 fixes status codes |
| **Confused deputy** | credentials are never mixed: a user bearer goes only to Auth, a service token only to its callee; Billing and Payment call Organization Service with their own service token and the reference capability only; Organization Service never forwards a service token to Auth; a producer's admission is per target, so Auth's Payment admission does not extend to Billing or Organization Service | ACCEPTED shape |
| **Producer spoofing** | producer identity is derived from the credential, never from the body (EXISTING in Payment: DTO has no producer field, unknown fields rejected); `organizationId == seller.id` for organization sellers (EXISTING); tests must repeat this per target | EXISTING plus tests |
| **Cross-platform access** | resolved platform must be in the caller's allowed set; parents are immutable by database trigger, so a memoized organization-to-platform mapping cannot change; an empty or missing set denies | design; set contents AD-3 |
| **Cross-organization access** | object rule (producer owns the record) plus the scope check; an organization the hierarchy does not know is refused on create | EXISTING plus design |
| **Token rotation and revocation** | two digests per caller allow zero-downtime rotation; revocation is removing the digest and restarting (existing); the provisioning digest follows the same rule; the completion proof and incident-time question stay with the owner (ADR-0042 d10) | EXISTING; owner decision deferred |
| **Audit** | for mutations and denials: caller identity, capability, outcome and reason class, correlation id, asserted scope, target id (ADR-0042 d9); Organization Service needs a **durable actor record** (user, session family where available, calling service) before it accepts writers in production; the audit taxonomy and central forwarding are not decided | IC-8 (storage means a later migration) |
| **Replay and idempotency** | Payment create replays on `(producer, paymentRequestId)`; Organization Service creates require `Idempotency-Key`; cancel requires `Idempotency-Key`; step-up tokens are single-use. **Admission is checked before replay lookup** so a producer whose admission was removed cannot replay (IC-10) | IC-10, IC-11 |
| **Enumeration** | Payment already collapses "missing" and "forbidden" to 404; the policy layer must not reintroduce an existence oracle (403 only for the caller's own denied operation) | IC-3 |
| **Timing** | keep the compare-all-digests loop; the policy lookup happens after authentication | EXISTING |
| **Rate limiting** | stays per producer, after admission, and is documented as abuse and blast-radius control, never as authorization | ACCEPTED |
| **RR-1 (any registered token has full Organization Service access)** | removed only when the capability split is implemented; until then it stands | ACCEPTED, unimplemented |

---

## 6. Migration and rollout

### 6.1 Principles

- Policy is **configuration**, so no data migration is needed for the service-token part, and rollback is a configuration revert.
- Every currently registered caller must have an explicit policy entry **before** enforcement, or that caller breaks. A CI check that compares the registered callers in `docker-compose.yml` with the policy entries is proposed (IC-14).
- Nothing new may depend on Organization Service being production-authoritative until it is (AD-5).

### 6.2 Stages

| Stage | Content | Depends on | Rollback |
|---|---|---|---|
| **R0** | approve AD-1 to AD-5 and the IC choices | architecture owner | not applicable |
| **R1** | policy framework (IC-1/2) with unit tests; no service wired | R0 (IC-1, IC-2) | remove the code |
| **R2** | Payment admission policy in **enforce** mode with the exact current operations (Billing: create, read, cancel), so no behavior change for Billing | R1, AD-2, AD-3 | revert the configuration |
| **R3** | Organization Service capability split and the provisioning capability, with the state-row gate; no caller is registered, so nothing changes at runtime | R1, IC-12 | revert; no caller depended on it |
| **R4** | Auth grant endpoint (additive, read-only) | IC-6 | remove the route; nothing calls it |
| **R5** | Organization Service human routes, disabled unless Auth is configured | R3, R4, AD-1 for operator writes | configuration off |
| **R6** | reference read route in Organization Service; `HierarchyReferenceClient` in Billing and Payment behind an activation setting, **off until cutover verification** | R3, AD-5, IC-4 | setting off (see the caveat below) |
| **R7** | first-Company bootstrap tooling and Auth's owner-bootstrap change | AD-4, IC-7, ADR-0040 acceptance | tooling removal |
| **R8** | Auth boundary test and the no-platformId invariant tests | R1 | remove the tests |

### 6.3 Compatibility window

- Between R2 and R6, admission (validation items 1 to 5 and 7) is enforced and scope (item 6) is not yet enforceable. This is the weaker interim state and is permitted only if the owner confirms it (AD-5).
- Identity-only tokens keep working during the window for every caller that has a policy entry; a caller without an entry is refused, which is the intended "registered no longer means trusted".
- An "observe" mode (log-only) is possible but would be a temporary fail-open; it is not proposed unless the owner wants it (IC-9). With only two registered callers in compose, enforce-from-the-start needs no observe phase.

### 6.4 Rollback and the one-way door

Policy, routes and clients are additive and switchable. The exception is the cutover itself, which ADR-0040 (Proposed) treats as a one-way door after the zero-write window; R6 activation is designed to follow, not precede, cutover verification. Whether a documented emergency switch may disable hierarchy validation after cutover (falling back to trusting the admitted producer) is part of AD-5.

### 6.5 Organization Service not yet production-authoritative

Today no environment has an authoritative Organization Service. Therefore: no caller is registered there; the provisioning capability is gated; Billing and Payment must not call it yet; and Auth's grant endpoint and the human routes may exist in code and tests but must be unreachable in any deployed environment until the cutover stage.

---

## 7. Testing strategy

Existing layout: vitest unit specs beside sources, `test/*.e2e-spec.ts` against a scratch Postgres, `db/tests/run.sh` for database invariants, and `scripts/check-repo.test.mjs` for repository boundaries.

| Area | Tests |
|---|---|
| **Unit: policy** | parser rejects a caller with no entry, an unknown capability, a malformed platform id; deny by default; capability and platform-set evaluation; pure human rule evaluation for owner, operator and organization administrator, including every negative (other company, unassigned platform, inactive assignment, membership for a different organization, edit of a field outside metadata) |
| **Integration: Payment admission** | `billing-service` create, read and cancel succeed; `auth-service` denied on each operation not admitted (per AD-2); an unknown registered caller denied; every route above in 3.2 has one admitted and one denied case; a body carrying `producer` is rejected; the producer of a created payment is the credential's caller |
| **Unauthorized-producer** | non-admitted producers denied in Payment, Billing and Organization Service; Organization Service as a caller denied everywhere; admission in one target does not imply another |
| **Cross-platform and cross-organization negatives** | a producer scoped to platform A cannot create for an organization of platform B; an organization the hierarchy does not know is refused; a payment created by producer X is invisible to producer Y (404 collapsed); replay of another producer's `paymentRequestId` conflicts, never leaks |
| **Human authorization** | facts come from Auth only; a client-supplied role, platform, organization, scope, user agent, origin or client type changes nothing; revoked assignment and revoked membership take effect on the next request (no caching); sensitive operation without step-up refused; low-risk metadata edit by an operator allowed only per the classification (AD-1); a service token on a human route and a user bearer on a service route are both refused |
| **Bootstrap** | first-Company operation is idempotent by `Idempotency-Key`; refused before the authoritative state; the provisioning credential cannot call any other route; Auth's owner bootstrap no longer inserts a Company in the authoritative mode; ordering test for both environment classes |
| **Rotation and revocation** | two digests both valid; removing one denies it after restart; a third digest refused at startup; the provisioning digest follows the same rules; a rotated-out token cannot use a retained idempotency key to read a result |
| **Failure and availability** | Organization Service down: creates for unseen organizations 503, memo hits succeed, reads unaffected; Auth down on the human path: 503; timeouts bounded; Auth's login, refresh and `/auth/me` continue with Organization Service down (boundary test); startup refuses a policy that names a caller with no token |
| **Replay and idempotency** | replay after admission removal is denied; step-up token single use; the step-up plus `Idempotency-Key` retry returns the stored result without a second consume |
| **Repository checks** | extend `check:repo`: Auth's authentication-path modules do not import an Organization Service client; policy contents do not enter the kit; no `platformId` column on the Billing invoice or Payment payment tables; registered callers in compose each have a policy entry |
| **Rate limiting** | a test that an over-limit admitted producer gets 429 and that a non-admitted producer gets 403 before any limiter row is written |

---

## 8. Decision register

### 8.1 Architecture decisions needed (AD): options only, no recommendation

> **Status update:** AD-1 to AD-5 have been answered (section 11). The table is kept as the questions were asked.

| ID | Question | Why the accepted record does not answer it | Neutral options | Blocks |
|---|---|---|---|---|
| **AD-1** | **What proves step-up for an operator** performing a sensitive administrative operation, and which operations are sensitive? Also confirm that the existing owner step-up purposes (for example `platform.create`) carry over to the moved operations | D4 requires operator step-up but leaves the classification and the evidence open; operators have no step-up factor today | (a) reuse the operator working-code flow as fresh-proof evidence; (b) give operators a second factor like owners have; (c) other, described by the owner | R5 for operator writes |
| **AD-2** | **Which operations may each admitted producer use in Payment**, in particular `auth-service`? Confirm `billing-service` = create, read, cancel | the owner admitted producers "for the target service and operation" but listed no operations; Auth has no effective use today | (a) `auth-service` admitted with an empty operation list until a use exists; (b) an explicit list of operations; (c) other | R2 |
| **AD-3** | **Which platforms** may each admitted producer act in, and how is the set maintained as platforms are created? | D2 selects Platform scope and names no platforms | (a) enumerated platform ids per producer per target; (b) an explicit "all platforms" value; (c) other | R2, R6 |
| **AD-4** | **The first-Company rule** (what "first" means given multi-company is undecided: refuse if any Company exists, by key, by name) and **how Auth's owner bootstrap learns the Company id** | D1 says the first Company uses a one-time bootstrap and Auth no longer inserts one, and stops there | (a) Auth `ensure(id)` first-touch fetch, which needs Auth's read token registered first; (b) operator supplies id and name and Auth records it without validation; (c) other | R7 |
| **AD-5** | **What happens to hierarchy validation (item 6) before Organization Service is authoritative**, and whether an emergency switch may disable it afterward | validation needs data that does not exist until the cutover | (a) admission-only until cutover, validation activated at cutover verification; (b) validation required before any non-test producer is enabled, which delays production producers until cutover; (c) other | R6, the meaning of "admitted" before cutover |

### 8.2 Implementation choices (IC): proposed, need owner approval

| ID | Choice | Proposed direction | Alternative |
|---|---|---|---|
| IC-1 | where the policy engine lives | generic helper in the kit, contents per service (P1) | per-service code (P2) |
| IC-2 | policy format and where the documented admission list lives | validated startup structure, source chosen with the SDD | environment, file or constant |
| IC-3 | denial status and error codes | 401 unknown credential (existing); 403 for an admitted caller's denied operation; keep 404 collapse for records | 404 for all denials |
| IC-4 | reference read shape and memo | restricted route returning ids and parents; process-local memo | capability field filter; memo table (a migration) |
| IC-5 | human route layout in Organization Service | same paths with a combined guard as in Payment | separate administrative paths |
| IC-6 | Auth grant endpoint contract | one user-bearer call that authenticates and returns the caller's own facts; live, uncached; fail closed | `/auth/me` plus a second call |
| IC-7 | provisioning tool | explicit command or pipeline step calling the API with the credential; never at service startup | none that bypasses the guard |
| IC-8 | durable actor record | a table in Organization Service (a later migration) plus structured logs | logs only, which does not meet ADR-0042 d9 |
| IC-9 | rate-limit order and rollout mode | after admission; enforce from the start | observe mode (temporary fail-open) |
| IC-10 | replay versus admission | admission first | replay first |
| IC-11 | step-up evidence to Organization Service | verify-and-consume call to Auth with the user bearer, consume before write | Auth issues a signed receipt (needs signing, not approved) |
| IC-12 | authoritative gate for provisioning | require the ADR-0040 state row or an explicit fresh-environment flag | none; not acceptable |
| IC-13 | invariant test for no `platformId` on invoices and payments | database catalog test | none |
| IC-14 | CI check that registered callers have policy entries | `check:repo` extension | manual review |

Signed capabilities (Model D) are **not** part of this design and would need separate approval.

---

## 9. Files likely to change in the implementation phase

Not changed now. Listed to scope the later work.

| Area | Files (new or modified) |
|---|---|
| Kit (IC-1) | `libs/service-kit/src/service-auth/` new policy type, parser, guard factory and specs; `libs/service-kit/src/index.ts`; `scripts/lib/checks.mjs` and `scripts/check-repo.test.mjs` |
| Payment | `apps/payment-service/src/auth/service-or-user.guard.ts`; `payments.controller.ts`; `attempts.controller.ts`; `authorization/authorization.service.ts`; `config/` (policy loading); new `hierarchy/` reference client; tests in `test/`; `docker-compose.yml`, `.env.example`, `apps/payment-service/.env.example` |
| Billing | `apps/billing-service/src/payment-integration/payment-client.ts` (no change expected); new `hierarchy/` reference client (only if Billing validates organizations itself); config; tests; its inbound policy remains empty |
| Organization Service | `src/app.module.ts`; the three controllers; new capability policy module; new human-route guard and Auth port; new reference route; provisioning tool; `src/config/organization-config.ts`; a migration for the durable actor record and the authoritative state row (IC-8, IC-12); e2e and db tests; `README.md`; `docker-compose.yml` |
| Auth | new read route and service for the caller's grant facts; `src/cli/owner-tools.ts` and `src/cli/main.ts` (authoritative mode); `src/owner/step-up.service.ts` and operator modules (only if AD-1 adds an operator factor); the boundary test; `apps/auth-service` docs |
| Repository | `docker-compose.yml`, `.env.example`, `.github/workflows/core-ci.yml`, `infra/postgres/init/01-service-databases.sh` if a new database role is needed |
| Documents | payment SDD section 19 (O-13 to O-15) and its gate wording; billing SDD B-029; `core-architecture.md` sections 6, 7, 10, 11; `docs/sdd/organization-service.md`; Auth ADD and SDD; ADR-0040 (open item and cutover sequence); an ADR-0022 amendment note for the bootstrap; a new SDD for the policy component |

---

## 10. Readiness

> **Superseded by section 11.6.** This is the readiness statement as first written, before the owner answered AD-1 to AD-5.

**BLOCKED BY additional architecture decisions.**

The accepted record fixes the architecture, and the source check shows most of it can be built without new policy. It cannot be built completely, because five questions the record does not answer would otherwise be decided by the implementer:

- **AD-1** operator step-up has no mechanism and no classification of sensitive operations;
- **AD-2** which operations `auth-service` may use in Payment (and confirmation of Billing's three);
- **AD-3** which platforms each admitted producer may act in;
- **AD-4** the first-Company rule and how Auth learns the Company id;
- **AD-5** hierarchy validation before Organization Service is authoritative.

Which work each blocks is in section 6.2. Work that needs none of them (the generic policy framework and its tests, and the invariant and boundary tests) is unblocked once the implementation choices IC-1 and IC-2 are approved. Nothing in this study has been implemented, and ADR-0042 is unchanged.


---

## 11. Owner answers to AD-1 to AD-5 (ACCEPTED), and what they leave open

Recorded as given by the architecture owner, dated 2026-09-20, decider "Architecture owner", each marked "Accept". This section records them and reads them against the source. **The residual questions in 11.2 are findings of this study, not decisions.** Nothing here changes ADR-0042; see 11.7.

### 11.1 The answers

**AD-1: operator step-up and sensitive operations.** Extend Auth's existing step-up mechanism to support operator-sensitive administrative operations, using single-use, session-bound proofs with explicit purposes.
- Operators must provide step-up authentication before sensitive Organization Service administrative operations.
- The proof must be single-use; bound to the authenticated User and session; bound to the requested sensitive-operation purpose; time-limited; and invalid after consumption or expiry.
- Organization Service must verify the proof through the Auth authorization contract; the client is never trusted to assert that step-up occurred.
- The existing Auth owner step-up purposes remain valid for owner operations.
- Operator step-up introduces explicit operator-sensitive purposes rather than treating every owner step-up purpose as an operator permission.
- **Sensitive operations:** creating a Platform; changing Platform-level administrative configuration; creating an Organization; changing Organization ownership or hierarchy-sensitive metadata; other operations explicitly classified as sensitive by the Organization Service authorization contract. Ordinary low-risk metadata reads and updates do not require step-up unless explicitly classified as sensitive.

**AD-2: Payment operations per producer.** Explicit operation-level authorization per admitted producer.
- `billing-service` to Payment: create Payment, retrieve Payment, cancel Payment (Billing's existing integration). It is not automatically authorized to start arbitrary Payment attempts outside the Billing payment flow, to operate on another producer's payments, or to perform unrelated Payment administration.
- `auth-service` to Payment: admitted as a producer, with permissions limited to operations explicitly required by Auth's current contract. The intended Auth call is `GET /payment/licenses/:id/status`, which Payment does not implement, so **Auth receives no additional Payment operation solely because it is an admitted producer.** Auth's ability to reach generic Payment routes through the service guard must be restricted to the operations authorized by the final contract.
- Producer admission and operation authorization remain separate controls.

**AD-3: Platform scope for admitted producers.** Producer credentials must be explicitly scoped to one or more Platforms; there is no implicit all-Platform access.
- Platform is the scope selected by D2. An admitted producer does not automatically receive every Platform; each production credential has an explicit Platform scope, and several Platforms only when explicitly assigned.
- Requests involving an Organization must resolve Organization to Platform through the authoritative hierarchy; the request is authorized only if the resolved Platform is inside the producer's assigned scope. Cross-Platform access fails closed.
- Platform scope does not imply one currency per Platform; `platform_currency.platformId` remains Billing currency configuration, unrelated to the scope mechanism.
- Before Organization Service is authoritative, the implementation must use the pre-cutover hierarchy-validation mechanism of AD-5.

**AD-4: first Company bootstrap.** The first Company is created through a one-time controlled provisioning bootstrap; later Company creation uses the dedicated Organization Service provisioning identity.
- *Fresh environment.* A one-time bootstrap controlled by the deployment and provisioning process: (1) authenticates using the dedicated provisioning mechanism; (2) creates the Company in Organization Service; (3) receives the authoritative Company id; (4) persists or records that id in the bootstrap environment; (5) continues owner and bootstrap initialization using it. **Auth must no longer insert the Company directly into its own database.**
- *Later Companies.* Created by the dedicated non-human provisioning identity.
- *Security boundary.* The provisioning credential is never exposed to human clients, is not an organization-admin permission, is not a normal User role; ordinary service credentials cannot invoke Company provisioning unless explicitly authorized for that capability; bootstrap credentials are one-time and environment-controlled.

**AD-5: hierarchy validation before and after cutover.** Explicit phase-dependent authority; never silently fall back to stale or client-supplied hierarchy information.
- *Before cutover:* the current authoritative Auth hierarchy remains the validation authority for existing hierarchy references; service authorization may validate Organization to Platform against it while Auth remains authoritative.
- *During cutover:* service authorization enters a controlled transition state; no operation may silently accept an unvalidated Platform and Organization relationship; the cutover process must establish which authority is active before post-cutover validation is enabled; operations needing authoritative validation may be temporarily unavailable if authority cannot be established safely.
- *After cutover:* Organization Service is the sole authority for Company, Platform, Organization and hierarchy relationships; service authorization resolves Platform scope through it.
- *Emergency:* no arbitrary runtime switch may disable hierarchy validation. An emergency mechanism may change the **active authority during a formally controlled rollback or recovery procedure**, which must be explicitly gated, fail closed if authority cannot be established, be auditable, follow ADR-0040 rollback semantics, and never let client-supplied hierarchy claims substitute for authoritative validation. There is no permanent "disable authorization" mode.

### 11.2 What the answers leave open (findings, not decisions)

These are stated so that the implementer does not decide them. Each is either a question for the owner or a dependency on a Proposed ADR.

| ID | Open point | Evidence |
|---|---|---|
| **RQ-1** | **How an operator obtains the proof.** AD-1 fixes the proof's properties and the verification path, and says the existing mechanism is extended. It does not say what an operator does to earn a proof. Auth's re-verification methods (TOTP, WebAuthn, secret key) belong to owner factors (`owner_auth_factor`); operators have only a time-boxed working code and no factor | `step-up.service.ts` (`StepUpRequest.ownerId`, `STEP_UP_METHODS`); `operator.controller.ts` |
| **RQ-2** | **Classification versus authority.** The sensitive list includes creating a Platform and changing Platform-level configuration, but ADR-0042 decision 7 gives platform create and edit to the **owner**, and organization create and edit to the owner or an assigned operator. This study reads the list as a *sensitivity classification* that applies to whoever is authorized, **not** as widening operator authority; the owner should confirm. Two related gaps: whether **owners** need step-up for the newly classified operations (the existing owner allow-list has `platform.create` and no organization purpose), and which fields count as "ownership or hierarchy-sensitive metadata" (parents are immutable by database trigger and Organization Service has no ownership field) | `STEP_UP_METHODS`; ADR-0042 d7; Organization Service migrations |
| **RQ-3** | **The pre-cutover mechanism.** AD-5 names the authority (Auth's hierarchy) but not how Billing and Payment query it, and AD-3 requires "the explicitly approved mechanism from AD-5". Auth has **no service-token callee side and no service-callable hierarchy route**: `/auth/me` and `platform-access` need a user bearer, and `platformOfOrganization` is internal. A service-callable reference read in Auth would give Auth a callee side, new tokens (Billing and Payment to Auth) and its own capability policy, which ADR-0042 and the BD-4 study had treated as something to avoid for the human path. Also open: whether pre-cutover validation is **mandatory** or only **permitted** (AD-5 says "may"; AD-3 says "must use"), and how consumers learn which authority is active (ADR-0040's state row and configuration switch are Proposed and address Auth's own switch, not Billing's or Payment's) | Auth source: no `ServiceTokenGuard`; `platform-access.service.ts` |
| **RQ-4** | **Auth's Company row.** `owner.companyId` is a foreign key to Auth's own `company` table (`0001_identity_tenancy_platform_assignment.sql`). AD-4 forbids Auth from inserting the Company, and its step 5 continues the owner bootstrap with the authoritative id. The only design that lets Auth hold that row without inserting it is ADR-0040's validated reference cache (`ensure(id)` first-touch fetch), and ADR-0040 is **Proposed**, not accepted. Smaller points: whether "one-time" is enforced by the system or by procedure; where step 4 records the id; whether the bootstrap credential is the same as the standing provisioning credential | `owner-tools.ts`; ADR-0040 decision 1 |

Also noted, not a question: **Auth's license check runs on registration and join, not on login or refresh** (`payment-client.ts`, `auth.service.ts`). It calls a Payment route that does not exist, so a deployed Payment answers 404, which Auth reads as "no license" and refuses registration. This is existing behavior and not caused by this work. AD-2 means the eventual route must be added to Payment's policy for `auth-service` as a named operation; the study expects unmatched routes to stay 404 before any guard (a test should confirm).

### 11.3 Consequences of the answers for the design

| Area | Effect |
|---|---|
| Payment policy (4.5) | `billing-service`: `payment.create`, `payment.read`, `payment.cancel`. The attempt-sync route is not listed for Billing and is denied. `auth-service`: **empty operation list** until a real contract exists, so with enforcement Auth's token is refused on every current Payment route; nothing Auth does today is affected, because its only call targets a route that is not there. The `ServiceOrUserGuard` service branch must check the operation, not only the token |
| Platform scope (4.4) | no wildcard value exists in the policy structure; a credential with no platform set is refused. Scope sits with the caller's policy entry, so both digests of a caller (rotation window) share it (IC-15). The concrete platform ids are deployment data supplied when a production credential is issued |
| Step-up (4.7) | proof properties fixed: single-use, bound to user, session and purpose, time-limited. Organization Service calls Auth to verify and consume it; **consume before write** stays the safe order (IC-11). New operator purposes are named explicitly and do not inherit owner purposes |
| Bootstrap (4.6) | steps 1 to 5 of AD-4 are the flow for a fresh environment; Auth's `bootstrap-owner` loses its Company insert in the authoritative mode |
| Validation (4.3) | three states, not two: **pre-cutover** (validate against Auth's hierarchy), **transition** (fail closed, some operations unavailable), **post-cutover** (validate through Organization Service). The active authority is explicit configuration set by the controlled procedure, never inferred from a request and never disabled |

### 11.4 Updated decision register

| ID | State | Residual |
|---|---|---|
| AD-1 | ANSWERED | RQ-1, RQ-2 |
| AD-2 | ANSWERED | none blocking; the future Auth license route needs its own contract |
| AD-3 | ANSWERED | pre-cutover part depends on RQ-3; IC-15 (per caller versus per digest; rule for non-production credentials) |
| AD-4 | ANSWERED | RQ-4 |
| AD-5 | ANSWERED | RQ-3; an explicit authority indicator is needed by Billing and Payment |
| IC-1 to IC-14 | unchanged, still awaiting approval | IC-15 added |

### 11.5 Stage impact

| Stage | Status after the answers |
|---|---|
| R1 policy framework | no blocking architecture question; needs IC-1, IC-2 |
| R2a Payment admission (operations, deny by default) | no blocking architecture question; needs IC-3, IC-9, IC-10 |
| R2b Payment platform scope | blocked by RQ-3 for the pre-cutover phase; the post-cutover phase follows the cutover |
| R3 Organization Service capability split and provisioning capability | no blocking architecture question; needs IC-12 (and IC-8 before production writers) |
| R4 Auth grant endpoint | no blocking architecture question; needs IC-6 and the verify-and-consume shape of IC-11 |
| R5 human routes | owner and organization-admin paths: no blocking question; **operator sensitive writes blocked by RQ-1 and RQ-2** |
| R6 hierarchy validation client | **blocked by RQ-3** |
| R7 bootstrap tooling and Auth bootstrap change | **blocked by RQ-4** (depends on ADR-0040) |
| R8 boundary and invariant tests | no blocking architecture question |

### 11.6 Readiness after the answers

> **Updated by section 12.** The four questions below (RQ-1 to RQ-4) were studied in section 12, which found DEC-1 to DEC-5.

**Overall: BLOCKED BY additional architecture decisions** (RQ-1 to RQ-4). The blocking points are narrower than before: AD-1 to AD-5 are answered, and what remains is the operator proof method (RQ-1), a one-line confirmation of RQ-2, the pre-cutover mechanism (RQ-3) and ADR-0040's acceptance for Auth's Company row (RQ-4).

**Staged subset READY FOR IMPLEMENTATION:** R1, R2a, R3, R4 and R8 have no blocking architecture question, once the implementation choices named in 11.5 are approved. Implementing them does not remove RR-1 for callers until R3 is deployed, and does not enable hierarchy validation.

### 11.7 Relationship to ADR-0042

ADR-0042 is **unchanged** by this section. It still lists the details answered here under "Not decided", and its decision 5 names only Organization Service as the validation authority, which the AD-5 answer refines for the pre-cutover phase. Until an amendment is made, ADR-0042's text and these accepted answers differ in those places; the answers are the later owner decisions. Whether and how to amend ADR-0042 (and update ADR-0040) is left to the owner.


---

## 12. RQ-1–RQ-4 Architecture Resolution Study

**Purpose.** Section 11 recorded the owner's AD-1 to AD-5 answers and found four questions they leave open. This section studies each against the source and the accepted and Proposed decisions, and says for each whether the existing architecture can resolve it consistently or whether an owner decision is required. It uses the labels of the vocabulary table at the top of this document. **It decides nothing, changes neither ADR-0042 nor ADR-0040, and invents no mechanism.**

### 12.0 Result at a glance

| Question | Can existing accepted or Proposed architecture resolve it? | What is needed |
|---|---|---|
| **RQ-1** operator step-up acquisition | **No.** The repository contains no operator step-up mechanism; ADR-0028 says operators have none | **DEC-1** (owner) |
| **RQ-2** sensitivity versus authority | **Partly.** Authority is settled by ADR-0042 d7 and D4 and is unaffected by AD-1; the classification has small gaps | **DEC-2** (owner clarification) |
| **RQ-3** pre-cutover hierarchy validation | **No mechanism is designed.** Core architecture O9 still lists it as open | **DEC-3** (owner) |
| **RQ-4** Auth `owner.companyId` | **Yes, if ADR-0040 is accepted.** ADR-0040 decisions 1 and 2 already describe it | **DEC-4** (owner: ADR-0040) |
| additional finding | The accepted admission table does not list the callers of Organization Service that ADR-0040 and ADR-0042 assume | **DEC-5** (owner) |

---

### 12.1 RQ-1: operator step-up acquisition

#### Source findings

| Aspect | Owner step-up (EXISTING) | Operator working code (EXISTING) |
|---|---|---|
| Table | `owner_step_up` (`0002_owner_operator_hardening_and_owner_step_up.sql`) | `admin_operator_code` (`0001_identity_tenancy_platform_assignment.sql`) |
| Purpose of the mechanism | re-verification before a sensitive operation, inside a live session | the operator's **login**: operators have no password (`operator.controller.ts`, `operator-code.service.ts`) |
| How the proof is earned | re-verify a factor: TOTP code, WebAuthn assertion (challenge bound to session and purpose), or the secret key (`StepUpService.issue`) | receive a six-digit code out of band (`admin.operator_code_issued` event to the operator's contact) |
| Purposes | server allow-list `STEP_UP_METHODS`, 14 entries, including `platform.create`; acceptable methods per purpose | database enum `operator_code_purpose = ('confirmation','login')` only |
| Bound to user | yes (`ownerId`, foreign key to `owner`) | yes (`userId`, and the HMAC covers operator id, purpose and code) |
| Bound to session | **yes** (`sessionFamilyId`; a step-up from another session is rejected) | **no**: the code is requested and redeemed *before* a session exists, and redeeming it mints a **new** session |
| Bound to purpose | yes (text purpose, checked at consume) | yes (enum value, part of the HMAC) |
| Single use | yes (`consumedAt`, atomic consume in the mutating transaction) | yes (`consumedAt`; issuing supersedes the previous live code) |
| Lifetime | database CHECK: at most 15 minutes; default 300 s (`STEP_UP_TTL_SEC`) | login code: until the end of the operator's shift, or a flat fallback |
| Abuse control | throttles per IP and per owner | 5 attempts per code; throttles per operator, per IP and global |
| Verification path | `StepUpService.consume(q, {ownerId, sid, purpose, token})`, in Auth's own transaction, with the live access token; the id alone is not a bearer credential | `OperatorCodeService.verifyLogin`, a public route |
| Client transport | header `x-step-up-token`; no client identifier | out-of-band delivery; no client identifier |
| Who may use it | **owners only**: `issue` selects `kind='owner'`, and the table's foreign keys point at `owner` and `owner_auth_factor` | operators only, for login and contact confirmation only |
| Route consumers today | owner routes (operator creation, join codes, organization-admin grants) | none for step-up |

Two further facts. **ADR-0028 states it directly:** "Operators and org admins have no step-up mechanism and act on their session alone." **ADR-0027** records that raw one-time operator codes transit the broker (`admin.operator_code_issued`) and the notification path, listed as a residual risk.

#### Existing accepted decisions

AD-1 (the proof is single-use, bound to user, session and purpose, time-limited, and verified through the Auth authorization contract; owner purposes stay valid for owners; operator purposes are explicit) and D4 (operators need step-up for sensitive operations). **Neither says what an operator does to earn the proof.**

#### Answers to the questions asked

1. **How an operator obtains the proof.** Not answered by any accepted decision, and the repository has no such mechanism.
2. **What Auth mechanism verifies it.** For owners, the atomic consume in Auth's transaction. For operators, none exists. AD-1 fixes only that Organization Service verifies **through Auth**, which requires an Auth endpoint authenticated by the user bearer that consumes the proof (see IC-11).
3. **Promote the working code, or replace it.** The working code is a *building block*, not a step-up. Reusable parts: CSPRNG code, HMAC storage, supersede-then-insert, attempt limit, throttles, out-of-band delivery and audit. Missing for AD-1: new purpose values (a database enum and type change, so an Auth migration), **session binding**, a step-up-length lifetime instead of shift end, a request route that requires the operator's *live session* (today the request route is public), separate rate buckets, and a consume path in the mutating transaction. Whether it *should* count as step-up is an owner judgment, because it proves recent control of the operator's contact channel, which is the same channel that delivers the login code; it adds recency, purpose and session binding, and it is **not** an independent second factor.
4. **User, session and purpose binding.** Owner: all three, in one atomic statement. Operator: user and purpose today; **session binding would be new**.
5. **Single-use and expiry.** Owner: `consumedAt` plus a 15-minute database ceiling. Operator: single-use and expiry exist for login codes; the lifetime would have to be shortened for step-up.
6. **Client neutrality.** Both paths carry no client type, origin or device; the only client-shaped element in the whole area is the WebAuthn origin configuration for owner factors. An out-of-band code path is client-neutral.
7. **Which operations require it.** Per AD-1, the sensitive list, subject to RQ-2. Because ADR-0042 d7 gives platform creation and edit to the owner only, **the operator-reachable sensitive operations today reduce to creating an Organization** (see 12.2).

#### Candidate options (no ranking)

| Option | What it would be | Consequences |
|---|---|---|
| **A. Working-code style step-up** | an operator with a live session requests a one-time code for a named sensitive purpose; it is delivered out of band, bound to that session and purpose, short-lived, consumed through Auth | reuses the existing code machinery; needs an Auth migration (enum and session column or a new table) and a session-authenticated request route; **not an independent factor** (same channel as login); depends on the broker and notification path |
| **B. An operator second factor** | give operators TOTP or WebAuthn as owners have | independent factor; needs operator enrollment, recovery and lifecycle that do not exist (this study does not design operator MFA); larger Auth change |
| **C. Re-login as proof** | the operator repeats the login code flow to obtain a fresh session, and that fresh session is the proof | needs no new table; **breaks session binding** (a new session, not the current one) and purpose binding, so it does not meet AD-1 as written |
| **D. Modify AD-1 for operators** | the owner changes AD-1 or D4: for example operators do not perform the sensitive operations, or the classification excludes them | removes the need for an operator mechanism; changes an accepted decision, so it is the owner's alone |

#### Dependencies

RQ-2 (which operations), ADR-0027 (broker transit of codes), the notification path, an Auth migration, IC-11.

#### Decision required: **DEC-1**

*Which acquisition mechanism satisfies AD-1 for operators, or how AD-1 is modified?* Because the accepted architecture contains no valid operator step-up mechanism, this is an owner decision and is not designed here. It blocks only the operator path for creating an Organization; owner paths and organization-admin metadata edits are unaffected.

---

### 12.2 RQ-2: sensitivity versus authority

#### Source findings

Organization Service today (migration `0001`, `0003`, input files, immutability triggers):

| Entity | Fields | Client-writable | Immutable |
|---|---|---|---|
| Company | `name` | `name` (PATCH) | `id`, `createdAt` |
| Platform | `companyId`, `name`, `key` (optional, added in `0003`) | `name` only; `key` is **not** accepted by create or update | `id`, `createdAt`, `companyId` |
| Organization | `platformId`, `name`, `taxCode`, `address`, `phone`, `type` | `name`, `taxCode`, `address`, `phone`, `type` | `id`, `createdAt`, `platformId` |

There is **no ownership field** and no Platform "configuration" field other than `name`. `companyId` and `platformId` are refused by the API ("cannot be changed") and blocked by trigger.

Authority (ADR-0042 d7 and the owner's D4, both accepted):

| Operation | Owner (own company) | Assigned operator | Organization admin | AD-1 classification |
|---|---|---|---|---|
| create Company | no: provisioning identity (D1) | no | no | not a human operation |
| create Platform | yes | **no** | no | sensitive (explicit) |
| edit Platform (`name`) | yes | **no** | no | *unclear*: only "changing Platform-level administrative configuration" could cover it |
| create Organization | yes | yes (on an assigned platform) | no | sensitive (explicit) |
| edit Organization metadata | yes | yes (assigned platform) | yes, own organization, where the server-derived facts grant it | not sensitive unless explicitly classified |
| change a hierarchy link | none | none | none | "hierarchy-sensitive" but no operation exists |

Existing owner step-up (EXISTING): the allow-list and ADR-0025 design `platform.create` for owners with totp, webauthn or secret key, on a route (`POST /auth/admin/platforms`) that **was never built** (F23). No owner purpose exists for creating an Organization, and ADR-0025 lists "normal platform/organization access, reads" as deliberately not step-up.

#### Answers to the questions asked

1. **Does AD-1's sensitive list change authorization? No.** AD-1 says operators must provide step-up before sensitive operations. It grants nothing, and ADR-0042 d7 remains the authority. Consequences of reading it that way: an operator can never create or edit a Platform, whatever its classification, because the authority stage denies it first; and the only sensitive operation an operator can reach today is **creating an Organization**. This is the reading the study uses; DEC-2 asks the owner to confirm it, because the AD-1 list names Platform operations under an "operators must" heading.
2. **Do owners require step-up for sensitive operations?** AD-1 says the existing owner purposes remain valid for owners. Design-only today: `platform.create`. For the other classified operations there is **no owner purpose**, and AD-1 does not say whether an owner performing them needs step-up. Not decided.
3. **Which exact operations and fields are hierarchy-sensitive?** Classified by AD-1 by name: create Platform, create Organization. Ambiguous: rename a Platform (is `name` "administrative configuration"?). Unclassified, and therefore **not sensitive under AD-1's own rule** ("unless explicitly classified"): the Organization fields `name`, `taxCode`, `address`, `phone`, `type`; Company `name`. Which of these, if any, should be classified is not decided.
4. **Does "ownership or hierarchy-sensitive metadata" correspond to a field today? No.** Organization Service has no ownership field, and the two hierarchy links are immutable. The item applies to no current operation; AD-1's last bullet lets the Organization Service authorization contract classify a future field.

#### Candidate options for the open part

| Option | Meaning |
|---|---|
| **A. Explicit list only** | sensitive means exactly create Platform and create Organization, as AD-1 names them; a Platform rename is classified by the owner as either sensitive or not |
| **B. List plus named fields** | A, plus specific Organization or Platform fields the owner names (for example fields that feed fiscal documents), each classified by the owner |
| For owners | either the existing `platform.create` purpose only; or a new owner purpose for each newly classified operation; or no owner step-up for the newly classified operations. Each is a policy choice the owner makes |

#### Dependencies

DEC-1 (only for the operator Organization-create path); the Organization Service authorization contract (IC-5, IC-6); ADR-0042 d7.

#### Decision required: **DEC-2** (a clarification)

(a) Confirm that classification is not authority. (b) State whether a Platform rename is sensitive, and name any further classified fields (none is required by AD-1). (c) State whether owners need step-up for creating an Organization and for a Platform rename, and under which purposes. Until answered, the implementer would otherwise have to decide the owner-side policy; it does not affect the step-up mechanism itself.

---

### 12.3 RQ-3: pre-cutover hierarchy validation

#### Source findings

- **Authority today.** Auth owns Company, Platform and Organization (ADR-0031; the services table of core architecture). Organization Service is implemented and **not authoritative**: no caller token is registered, no production configuration exists, and ADR-0040's state row is not built.
- **Auth's HTTP API** (enumerated from the controllers): every route that touches the hierarchy authenticates a **user bearer** or is public. The only routes that reveal an organization's platform are `GET /auth/admin/organizations/:id` (owner or operator, collapsed 404) and `GET /auth/platform-access/:platformId`. **No route accepts a service token.** Auth has no `ServiceTokenGuard` and no `SERVICE_TOKENS`. Internally, `PlatformAccessService.platformOfOrganization(organizationId)` returns `{platformId, companyId}` from Auth's own tables.
- **Billing and Payment.** Their service-token create routes are called by services and carry no user bearer, so the end-user endpoints above cannot serve them. They already call Auth for user bearers (`GET /auth/me` on user paths, ADR-0040 line 14), never for service-token creates.
- **Open item.** Core architecture O9: "who validates organization → platform → company for non-user requests: decide when organization-service is built." Payment SDD O-15 gates non-trusted production producers on it.
- **Constraints already in the record.** CLAUDE.md: cross-service data goes through the owning service's API or async events; no service queries another's database. ADR-0039 rejected an event-derived permanent replica and the withdrawn tenancy-anchor design. ADR-0040 rejected an Auth **export API for import** ("whole hierarchy, no scope model") in favour of a checksummed file. ADR-0040 decision 3 opens other callers only after cutover.

#### The wording of AD-3 and AD-5

AD-3: "Requests involving an Organization **must** resolve Organization to Platform through the authoritative hierarchy; the request is authorized only if the resolved Platform is in the producer's scope ... Before Organization Service becomes authoritative, the implementation **must use** the explicitly approved pre-cutover mechanism from AD-5." AD-5: service authorization **may** validate against Auth's hierarchy while Auth is authoritative; no operation may silently accept an unvalidated relationship; never fall back to stale or client-supplied information.

| Reading | Meaning | Consistent with |
|---|---|---|
| **1. Mandatory outcome, permitted authority** | resolution is required whenever a platform-scoped credential is used; Auth is the authority that *may* be consulted before cutover; if it cannot be consulted, the request fails closed | AD-3 in full; AD-5's "no silent acceptance"; AD-5's "never fall back" |
| **2. Optional pre-cutover validation** | before cutover a producer may be trusted without resolving | AD-5's "may" read alone; contradicts AD-3's "authorized only if the resolved Platform is in scope" and AD-5's own "no operation may silently accept an unvalidated relationship" |

Only reading 1 satisfies every stated sentence, so this study uses reading 1 (**the outcome is mandatory; the pre-cutover authority is permitted, not optional to check**). It is an interpretation of two accepted answers, so DEC-3 asks the owner to confirm it. **Under reading 1, "mandatory" applies whenever a platform-scoped production credential is in use.** If no such credential exists before the cutover, no pre-cutover mechanism is required (option a of DEC-3).

#### Candidates

| Dimension | **C0**: no cross-service validation before cutover | **C1**: read-only Auth reference endpoint for trusted services | **C2**: shared or exported reference mechanism |
|---|---|---|---|
| What it is | admission and object rules only; the asserted `organizationId` is trusted from an admitted first-party producer (ADR-0042 option B.1) | a new Auth route, service-token authenticated, that returns ids and parents only for an organization | a copy of the hierarchy given to consumers: a shared database, a data-bearing library, or an exported file or configuration map |
| Authority | none consulted | Auth (correct while Auth is authoritative) | none (a copy) |
| Authentication | existing service token | Auth gains a service-token callee side: new digests for `billing-service` and `payment-service` in Auth, at most two per caller | not applicable |
| Authorization | admission only; platform scope **not** enforced | an Auth-side policy: which callers may use the reference read, on which platforms (a new admission list for Auth as a target) | not applicable |
| Failure behavior | no new failure mode | Auth unreachable: creates for an unseen organization fail closed with 503 (ADR-0042 d5); reads unaffected | stale or missing entries; no fail-closed signal |
| Availability | none added | adds Auth to the **create** path of Billing and Payment (they depend on Auth today only on user-bearer paths); shares Auth's process, so a per-caller limit is needed | depends on the export cadence |
| Caching | none | memoization only while ids are never reused and anchors never change (ADR-0042 d5); the id-reuse invariant I1 is still Proposed | the copy *is* a cache |
| Correlation and audit | producer identity only | kit correlation headers; Auth audit events for service callers and denials | none |
| Cutover transition | nothing to switch, but AD-3 is unenforced until cutover | consumers must switch to Organization Service at cutover; Auth's answer after the switch would come from a non-authoritative cache, so the endpoint must stop being an authority at that moment | a copy taken before cutover misses organizations created after it |
| Rollback | not applicable | consumer authority setting reverts only in the zero-write window (ADR-0040 d4) | not applicable |
| New authentication-path dependency? | no | **no** for Auth's own authentication path (Auth calls nobody new); **yes** for consumers' create paths; load on Auth's process is a coupling to control | no |
| Conflict with ADR-0040 | none | none in its decisions; its rejection of an *export API for import* concerned a whole-hierarchy dump, a different purpose; the cutover sequence would need an added consumer-switch step | conflicts with ADR-0039's rejection of a permanent replica and with AD-5's "never stale" |
| Conflict with accepted decisions | leaves AD-3 unenforced pre-cutover (reading 1) | changes the stated current fact "Auth has no service-token callee side" (a fact, not a decision) and core-architecture §10 ("None now") | conflicts with CLAUDE.md (database-per-service) for a shared database; a data-bearing library conflicts with the kit boundary |

Mechanisms considered and excluded by **evidence**, not by preference:

- **Non-authoritative Organization Service copy** (ADR-0039 import phase) as validator before cutover: it would validate against a copy that misses organizations Auth creates after the import, which AD-5 forbids ("never stale"); no caller token is registered until cutover (ADR-0040 d3).
- **Event-derived replica:** rejected by ADR-0039; not chosen by AD-5; this study does not invent it.
- **Signed assertions by the hierarchy authority:** needs signing infrastructure that ADR-0033 deferred and no owner has approved.
- **Forwarding an end-user bearer:** Billing's and Payment's create routes are service-token only, so no user bearer exists there.

#### Cutover timeline (AD-5)

```text
PRE-CUTOVER              TRANSITION                        POST-CUTOVER
Auth authoritative       freeze -> verify -> activate ->   Organization Service sole authority
                         verify -> switch (ADR-0040)
consumer resolves via:   consumer state: TRANSITION        consumer resolves via:
  the mechanism of        - no operation may accept an       Organization Service
  DEC-3 (or, if none,     unvalidated relationship         (reference capability)
  no platform-scoped      - operations needing the
  production credential)    authority may be unavailable
                          - authority established before
                            post-cutover validation opens
active authority = explicit configuration set by the controlled procedure (never inferred from a
request, never disabled); rollback only inside the zero-write window; fail closed if it cannot be established
```

#### Dependencies

ADR-0040 decisions 3 and 4 (Proposed: the state row, the switch by configuration, the zero-write window); AD-3 and AD-5; BD-5's id-reuse invariant for memoization; if C1, an Auth-side admission list and capability policy; BD-7 for where each service runs.

#### Decision required: **DEC-3**

*Before Organization Service is authoritative, how do platform-scoped producer credentials resolve Organization to Platform, and is reading 1 confirmed?* Options for the owner, without ranking:

- **(a)** No platform-scoped **production** credential is enabled before the cutover (test fixtures only); hierarchy validation begins at cutover. No pre-cutover mechanism is needed.
- **(b)** Auth provides a read-only, service-token-authenticated reference endpoint (C1); this needs its own decisions (Auth as a callee, its admission list, the authority indicator).
- **(c)** Another mechanism the owner describes.

C0 alone, with production credentials before cutover, leaves AD-3 unenforced and is not offered as a compliant option under reading 1.

---

### 12.4 RQ-4: Auth `owner.companyId` and the reference row

#### Source findings

Foreign keys into the hierarchy, read from the Auth migrations:

| Referencing table | References | Migration |
|---|---|---|
| `platform` | `company(id)` | `0001` |
| `owner` | `company(id)` (`companyId NOT NULL`) | `0001` |
| `operator` | `company(id)` | `0001` |
| `platform_assignment` | `platform(id, companyId)` (composite, forces the operator's and owner's company to match) | `0001` |
| `organization` | `platform(id)` | `0001` |
| `platform_non_working_day` | `platform(id)` | `0001` |
| `organization_join_code` | `organization(id, platformId)` | `0004` |
| `organization_admin_invitation` | `organization(id, platformId)` | `0005` |
| `organization_membership` | `organization(id)` | `0007` (the old `user.organizationId` was dropped there) |

This is ADR-0040's count of seven Auth-owned dependent tables (membership, join code, invitation, assignment, owner, operator, non-working day) plus the two links inside the hierarchy. Auth's own code reads the hierarchy only from these tables (`platform-access.service.ts`, onboarding, membership, assignment, `owner-tools.ts`); authorization compares **ids** (`o.companyId = p.companyId`), never names.

`bootstrap-owner` (`owner-tools.ts`) takes an advisory lock, returns `created:false` if any owner exists, else uses the first Company or **inserts one**, then creates the owner, whose `companyId` must reference an Auth `company` row.

#### Existing decisions

AD-4: Auth no longer inserts the Company directly; the bootstrap receives the authoritative id and continues owner initialization with it. ADR-0040 (Proposed): **R2c**, a validated non-authoritative reference cache; rows only by `ensure(id)` fetched from Organization Service, parents first, never from a client-supplied id; anchors immutable; a later fetch that disagrees fails closed and alerts; no deletes; the seven foreign keys stay; names and keys are snapshots. Decision 2 already permits **"the bootstrap flow if the company-creation decision below so provides"** as a bounded, fail-closed first-touch flow.

#### Answers to the questions asked

1. **What authoritative source supplies the Auth Company reference row?** Organization Service, by the R2c `ensure(companyId)` fetch. Before cutover it is Auth's own data (unchanged).
2. **How does the first-Company bootstrap obtain the id?** From the create response of the provisioning operation (AD-4 steps 2 to 4). Where the bootstrap environment records it is an implementation detail (IC-7).
3. **How do later Company changes reach Auth?** The only mutable Company field is `name`, and Auth authorizes by id, so a stale name in Auth changes no authorization. ADR-0040 says presentation columns are refreshed "off the request path" but designs no mechanism; nothing in BD-4 needs one, and none is invented here.
4. **Is this the same model as ADR-0040 BD-1?** **Yes.** R2c is the reference model, and decision 2 names the bootstrap flow as a permitted first-touch.
5. **What if the reference is stale or missing?** Missing: `ensure` fetches it; if Organization Service is unavailable, the administrative first-touch flow fails closed (503) and writes nothing, while login, refresh and `/auth/me` are unaffected because they never read it. Stale name: harmless to authorization. Anchor disagreement: fail closed and alert (ADR-0040 d1).
6. **Can owner bootstrap proceed without Auth creating the Company?** **Only if a validated way to place the row in Auth exists.** `owner.companyId` is a foreign key to Auth's `company`, so the row must exist before the owner. R2c supplies that path without Auth *creating* a Company (it inserts a reference row it has just validated). Without R2c the alternatives are excluded by the record: an unvalidated insert by id is an Auth-side insert of the Company, which AD-4 forbids in effect; removing the foreign key is R1, which ADR-0040 rejects for these paths; an event-fed projection is R3, not chosen by ADR-0039.
7. **Must ADR-0040 be amended?** **Yes, before it is accepted** (not before the framework stages). See 12.6.

#### Candidate options

| Option | Source in the record | Consistent with AD-4? | Consequences |
|---|---|---|---|
| **R2c `ensure(id)`** | ADR-0040 d1, d2 (Proposed) | yes | Auth needs a read credential in Organization Service **before** the bootstrap in a fresh environment; Organization Service must be reachable at bootstrap; fails closed and retryable; needs the full-read capability for Auth (DEC-5) |
| Unvalidated insert of a supplied id | not in the record | no in effect: Auth inserts the Company reference unvalidated | contradicts R2c's validation rule and AD-4 |
| Remove the foreign key (R1) | ADR-0040 option A.1 | not applicable | rejected there for `/auth/me` and onboarding; weakens ADR-0024 tenancy integrity |
| Event-fed projection (R3) | ADR-0040 option A.3, ADR-0039 | not applicable | needs reliable events and a consumer; not chosen; not invented here |

#### Dependencies

ADR-0040 acceptance (or an equivalent owner decision); DEC-5 (Auth's read credential in Organization Service); AD-4; the ADR-0040 cutover sequence for the fresh-environment order.

#### Decision required: **DEC-4**

*Is ADR-0040's R2c reference model (its decisions 1 and 2) accepted as the way Auth holds Company, Platform and Organization rows, so that the AD-4 bootstrap can place the Company row through the validated `ensure(id)` path?* If the owner does not accept it, another model is needed before the Auth side of the bootstrap can be designed. ADR-0040 does not need to be accepted **in full** for this; the decision concerns decisions 1 and 2.

---

### 12.5 An additional finding: callers of Organization Service (DEC-5)

> **Narrowed by section 13.** The evidence in section 13 shows that most of what is asked below is already determined by accepted decisions; one narrower question remains.

The accepted admission table (D3) lists producers admitted **to Payment** and says "other producers: any target: not admitted unless explicitly authorized"; admission is per target service. Yet: ADR-0042 d5 has Billing and Payment read Organization Service's reference capability; ADR-0040 d3 registers Auth's token in Organization Service to switch Auth's source and for first-touch fetches; and 12.4 needs Auth's read for the bootstrap. **None of these callers is in the admission table**, so under the accepted per-target rule none is admitted yet. This is a gap, not a contradiction.

**DEC-5.** *Which callers may use which capability in Organization Service?* The record implies `auth-service` for full read (first-touch, ADR-0040), and `billing-service` and `payment-service` for the reference read (ADR-0042 d5); the owner must confirm or change this list, and confirm the dedicated provisioning identity as the only holder of the provisioning capability (D1). It blocks the contents of Organization Service's policy.

---

### 12.6 What amendments the answers will require (not made here)

| Document | Needed if the owner decides as noted |
|---|---|
| **ADR-0040** (Proposed) | remove the open item "who creates a Company after cutover" (decided by D1 and AD-4); update decision 2 (the bootstrap flow now provides for a first-touch); extend decision 3's cutover sequence with the provisioning identity's registration point, the fresh-environment order, Auth's earlier read credential, and the consumers' authority switch (transition state of AD-5); keep its forward-fix-only rollback (AD-5's emergency mechanism must follow it, and does). **Required before ADR-0040 is accepted (DEC-4).** |
| **ADR-0042** (Accepted) | record AD-1 to AD-5 (removing them from "Not decided"); decision 5 gains the phase-dependent authority of AD-5; decision 7 gains the sensitive operations and the operator step-up outcome (DEC-1, DEC-2); Context and Consequences change if DEC-3 chooses Auth as a callee; the follow-up list updates. **Needed before implementation of the affected stages; the framework stages do not need it.** |
| Core architecture | §6 step 2, §10 (Auth "None now"), §11 O9, if DEC-3 or DEC-4 change them |
| Payment SDD, Billing SDD | O-13 to O-15 and B-029 pointers, and the admission list |

### 12.7 Consolidated decisions

| ID | Question | Options (no ranking) | Blocks |
|---|---|---|---|
| **DEC-1** | how an operator earns step-up, or how AD-1 is modified for operators | A working-code style; B operator second factor; C re-login; D modify AD-1 | operator path for creating an Organization |
| **DEC-2** | confirm classification is not authority; Platform rename; owner step-up for Organization create and Platform rename | A explicit list only; B list plus named fields; owner purposes as stated in 12.2 | the human-route step-up rules |
| **DEC-3** | pre-cutover resolution of Organization to Platform, and reading 1 of AD-3 and AD-5 | (a) no platform-scoped production credential before cutover; (b) an Auth reference endpoint; (c) other | platform-scope enforcement before cutover |
| **DEC-4** | accept ADR-0040 decisions 1 and 2 (R2c) for Auth's Company row, or name another model | accept; or another model | Auth bootstrap change |
| **DEC-5** | which callers may use which capability in Organization Service | the record's implied list, or the owner's | Organization Service policy contents; reference client; bootstrap |

> **Update from section 13:** DEC-5 is narrowed to the platform-scope extent of credentials used against Organization Service; the admission matrix itself needs no new decision.

### 12.8 Stage impact

| Stage | After this study |
|---|---|
| R1 policy framework | unchanged: no blocking decision |
| R2a Payment admission | unchanged: no blocking decision |
| R2b Payment platform scope | DEC-3 |
| R3 Organization Service capability split and provisioning | framework unblocked; its admission entries for Auth, Billing and Payment wait on DEC-5; provisioning identity is D1 |
| R4 Auth grant endpoint | unblocked |
| R5 human routes | owner and organization-admin paths unblocked once DEC-2 states the owner-side step-up rules; operator Organization creation waits on DEC-1 |
| R6 hierarchy validation client | DEC-3 and DEC-5 |
| R7 bootstrap tooling and Auth bootstrap change | DEC-4 and DEC-5 |
| R8 boundary and invariant tests | unchanged: no blocking decision |

### Readiness

BLOCKED BY ADDITIONAL ARCHITECTURE DECISIONS

The decisions that genuinely prevent implementation of the affected stages, and nothing else:

- **DEC-1**: the operator step-up acquisition mechanism (the repository has none).
- **DEC-2**: the owner-side step-up rules and the Platform rename classification (a clarification).
- **DEC-3**: the pre-cutover validation mechanism, or the rule that no platform-scoped production credential exists before cutover.
- **DEC-4**: acceptance of ADR-0040 decisions 1 and 2 for Auth's Company reference row.
- **DEC-5**: which callers may use which capability in Organization Service.

The framework, Payment admission, Auth grant endpoint and repository-test stages (R1, R2a, R4, R8) remain free of these decisions.


---

## 13. DEC-5 Evidence: the service-token admission surface

**Purpose.** Section 12.5 raised DEC-5 (which callers may use which capability in Organization Service). This section builds the complete admission matrix from source, to establish whether DEC-5 is (1) already fully determined by D3 and AD-2 and only needs an implementation clarification, or (2) a genuinely new owner decision. **Nothing is inferred from route reachability**: every "permitted" cell below comes from D3, AD-2 or another accepted decision, and every "reachable" cell comes from a guard or repository read in this study. DEC-5 stays separate from DEC-3 (which hierarchy authority applies before cutover).

### 13.1 The layers, kept apart

```text
credential valid?                          EXISTING   ServiceTokenGuard / ServiceOrUserGuard (digest match)
  -> producer identity                     EXISTING   the caller name the digest maps to
  -> producer admitted to THIS target?     NEW        D3: per target service, explicit
  -> producer allowed THIS operation?      NEW        AD-2: per operation, separate control
  -> resource / producer ownership         EXISTING   object rules (relationTo, AuthorizationService)
  -> Platform scope where applicable       NEW        D2 / AD-3: resolved organization -> platform
  -> allow                                 (rate limiting is a separate abuse control and is not a layer of this chain)
```

Registration is credential validity and nothing more. Today the chain stops after "producer identity" and the object rule: **registered means trusted**. D3 and AD-2 add the two missing layers, plus scope.

### 13.2 What is registered in the repository's configuration (EXISTING)

| Target | Registered service-token callers | Source |
|---|---|---|
| Payment | `billing-service`, `auth-service` | `docker-compose.yml:164` |
| Billing | none (no inbound `SERVICE_TOKENS`; the only token Billing holds is its own *outbound* one to Payment, `:134`) | `docker-compose.yml`, `apps/billing-service/.env.example` |
| Organization Service | none (`SERVICE_TOKENS` deliberately empty) | `docker-compose.yml:172-190` |
| Auth | not applicable: Auth has no service-token callee side | no `ServiceTokenGuard` in `apps/auth-service/src` |

Test fixtures register their own callers inside specs; they are not configuration. No production configuration registers any token. So "any other currently registered producer" is **none** in the repository.

### 13.3 Matrix A: Payment as the target

Payment's routes (`payments.controller.ts`, `attempts.controller.ts`, `authorization.service.ts`; the provider webhook route is authenticated by provider signature and is not a service-token route):

| Operation | Route | Guard | Object-level rule (verified) |
|---|---|---|---|
| create | `POST /payment/payments` | `ServiceTokenGuard` | none beyond the caller becoming the record's producer; unknown body fields rejected; per-producer rate limit |
| get | `GET /payment/payments/:id` | `ServiceOrUserGuard` | producer equals the caller service, or a `user` payer; otherwise collapsed 404 |
| cancel | `POST /payment/payments/:id/cancel` | `ServiceTokenGuard` | producer only; `Idempotency-Key` required |
| start attempt | `POST /payment/payments/:paymentId/attempts` | `ServiceOrUserGuard` | **payer only**; a service is never a payer (403 if it is the producer, else 404) |
| sync attempt | `POST /payment/payments/:paymentId/attempts/:attemptId/sync` | `ServiceOrUserGuard` | producer or payer |

Admission and operation matrix. "Guard passes today" means the credential is registered; "object outcome" is what the rule does after the guard. **D3** admits a producer to a target; **AD-2** permits an operation. A blank in the last two columns is a denial (default deny).

| Producer | Target | Operation | Guard passes today | Object outcome today | D3 admits producer | AD-2 permits | Platform scope needed |
|---|---|---|---|---|---|---|---|
| `billing-service` | Payment | create | yes (registered) | creates, producer = `billing-service` | yes | **yes** | yes: resolve organization to platform when the request involves an organization |
| `billing-service` | Payment | get | yes | its own payments only | yes | **yes** | ownership; no resolution on reads (ADR-0042 d5) |
| `billing-service` | Payment | cancel | yes | its own payments only | yes | **yes** | ownership; no resolution on reads |
| `billing-service` | Payment | start attempt | yes | **never succeeds** (payer only) | yes | **no** | not reached |
| `billing-service` | Payment | sync attempt | yes | its own payments' attempts | yes | **no** (not listed) | not reached |
| `auth-service` | Payment | create | yes | creates, producer = `auth-service` | yes | **no** | not reached |
| `auth-service` | Payment | get | yes | its own payments only (none normally exist) | yes | **no** | not reached |
| `auth-service` | Payment | cancel | yes | its own payments only | yes | **no** | not reached |
| `auth-service` | Payment | start attempt | yes | never succeeds | yes | **no** | not reached |
| `auth-service` | Payment | sync attempt | yes | its own payments' attempts | yes | **no** | not reached |
| `auth-service` | Payment | `GET /payment/licenses/:id/status` (intended, Auth's current contract) | not applicable | **route does not exist**: expected 404 from routing (Nest resolves routes before guards; a test should confirm) | yes | **no operation exists to permit** | not applicable |
| Organization Service | Payment | any of the five | **no**: not registered, so 401 | none | **no** (D3) | no | not reached |
| any other producer with a valid credential | Payment | any of the five | yes if it were registered | as `billing-service`, for its own records | **no** (D3: not admitted unless explicitly authorized) | no | not reached |

### 13.4 Matrix B: Billing as the target

D3 and AD-2 admit **no producer to Billing**. Every Billing service-token route is therefore a default denial for every service caller under the accepted decisions, and no registered caller exists today.

| Operation | Route | Guard | Object-level rule (verified in `relations.ts` and the repositories) |
|---|---|---|---|
| create invoice | `POST /billing/invoices` | `ServiceTokenGuard` | none beyond producer = caller; `organizationId` uuid shape and `organizationId == seller.id` for organization sellers; rate limit |
| get invoice | `GET /billing/invoices/:id` | `ServiceOrUserGuard` | producer, or a `user` payer; else collapsed 404 |
| list invoices | `GET /billing/invoices` | `ServiceOrUserGuard` | scoped to the caller's own (producer's created, payer's own) |
| issue invoice | `POST /billing/invoices/:id/issue` | `ServiceTokenGuard` | producer only (`lockForCaller`: a payer "may read and pay, never issue or discard") |
| discard invoice | `POST /billing/invoices/:id/discard` | `ServiceTokenGuard` | producer only |
| create payment request | `POST /billing/invoices/:invoiceId/payment-requests` | `ServiceOrUserGuard` | a relation to the invoice is required (a service can only be the producer) |
| get payment request | `GET /billing/payment-requests/:id` | `ServiceOrUserGuard` | relation to its invoice required |
| cancel payment request | `POST /billing/payment-requests/:id/cancel` | `ServiceTokenGuard` | relation to its invoice required (a service can only be the producer) |
| create / get / archive product | `POST /billing/products`, `GET`, `POST :id/archive` | `ServiceTokenGuard` | create: any registered caller becomes producer; get and archive: producer only (`catalogRelationTo`) |
| create / get / retire price | `POST /billing/prices`, `GET`, `POST :id/retire` | `ServiceTokenGuard` | create: only for a product the caller produced; get and retire: producer only |

Billing has 14 routes: 10 use `ServiceTokenGuard` and 4 use `ServiceOrUserGuard` (which also serves user bearers; the user path is not a producer-admission question). The catalog rules state "which services may act for which sellers is not decided (B-029, B-031)"; this study does not decide it.

### 13.5 Matrix C: Organization Service as the target

All 12 routes (`companies`, `platforms`, `organizations`: create, list, get, patch) sit behind a class-level `ServiceTokenGuard`. There is **no object-level rule**: the caller name only scopes idempotency keys; no record stores a producer. Every registered caller has full read and write (RR-1). None is registered.

Who may use which capability, and what determines it:

| Caller | Capability | Determined by | State |
|---|---|---|---|
| dedicated provisioning identity | provisioning (create Company) only | D1 (accepted) | **determined** |
| `billing-service` and `payment-service` | reference read (ids and parents only) | ADR-0042 d5 and its Consequences (accepted): "Billing and Payment gain a bounded synchronous dependency on organization-service" | **determined** (capability names are not fixed by ADR-0042) |
| `auth-service` | full read (first-touch `ensure`, source switch) | ADR-0040 decisions 1 to 3 (**Proposed**), reached from ADR-0042 d8 | **contingent on DEC-4**: no separate decision |
| Organization Service as a caller | none anywhere | D3 (accepted) | **determined** |
| any other service | none | D3, ADR-0042 d2 (deny by default) | **determined** |
| holder of the service-token write capability (create or update Platform and Organization) | none named | ADR-0042 d3 defines the capability; no decision assigns it; deny by default | **determined** (nobody holds it until a decision assigns it) |
| humans | user bearer, not a service token | D4 | out of scope of this matrix |

### 13.6 Matrix D: Auth as the target

Auth has no service-token routes, so no admission entry exists. Whether Auth ever becomes a callee is DEC-3 option (b), not DEC-5.

### 13.7 The verifications requested

| Check | Result | Source |
|---|---|---|
| `auth-service` has zero permitted Payment operations | **Yes** | AD-2: "Auth receives no additional Payment operation solely because it is an admitted producer" |
| `billing-service` has exactly three | **Yes**: create, get (retrieve), cancel; attempt start and sync are not listed and are denied | AD-2; Billing calls exactly these three (`payment-client.ts:139,151,159`) |
| Organization Service is not admitted to Payment | **Yes** | D3 admission table |
| An unlisted producer is denied even with a valid credential | **Yes under the accepted policy; not yet enforced today**, where any registered caller passes the guard | D3 ("not admitted unless explicitly authorized"); today's guard has no admission layer |
| Admission to one target does not imply another | **Yes** | D3 ("enforced per target service") |
| Admission to Payment does not imply every Payment operation | **Yes**: `auth-service` is admitted and permitted nothing | AD-2 ("producer admission and operation authorization remain separate controls") |

One wording note, not a gap: AD-2 says Billing is "not automatically authorized to start arbitrary Payment attempts outside the Billing payment flow". Billing has no attempt-start call and Payment allows only a payer to start one, so the phrase adds no operation; the permitted set is the three listed.

### 13.8 DEC-5 conclusion

**The admission matrix is an IMPLEMENTATION CLARIFICATION: NO NEW OWNER DECISION.**

- **Payment as target:** D3 and AD-2 determine every cell (13.3). The implementation must encode them and must **not** infer any permission from the fact that a route is reachable today.
- **Billing as target:** D3 admits no producer, so all service callers are denied by default (13.4).
- **Organization Service as target:** provisioning (D1), the Billing and Payment reference read (ADR-0042 d5), Organization Service not admitted (D3) and no holder of the service write capability are all determined; `auth-service`'s full read follows ADR-0040 and therefore **DEC-4**, with no separate decision (13.5).

So DEC-5 **as framed in 12.5** ("which callers may use which capability in Organization Service") does not need a new owner decision.

**One genuine, narrower owner choice remains. It is recorded as DEC-5 (narrowed).**

- **The unresolved choice.** *Does a Platform scope apply to the credentials that services use against Organization Service, and if so, what set?* AD-3 says "each production credential must have an explicit Platform scope; there is no implicit all-Platform access", under a heading about *admitted producers*. It does not say whether the credentials of Billing, Payment and Auth used to call Organization Service (reference read, full read) are covered. ADR-0042 d2 says scope applies "where relevant".
- **Smallest options** (no recommendation):
  - **(i)** The OS-facing credentials carry **no** Platform scope: the reference read returns ids and parents only, and the consumer enforces the caller's Platform scope on the resolved platform.
  - **(ii)** The OS-facing credentials carry an **explicit Platform scope** that Organization Service evaluates after it resolves the organization.
  - **(iii)** Another arrangement the owner states, for example different answers for the reference read and for Auth's full read.
- **What it affects.** AD-3's "no implicit all-Platform access" and ADR-0042 d2 and d3 (capabilities and "where relevant").
- **Why implementation cannot safely choose.** Option (i) gives Billing, Payment and (for full read) Auth a read of ids, parents, names and keys across every Platform, which is arguably the implicit all-Platform access AD-3 forbids. Option (ii) needs per-caller Platform sets at Organization Service; Payment and Billing call it on behalf of several producers, so a set would have to cover the union of their scopes and be kept in step with them, and Auth's first-touch `ensure` and its later cache need the whole company's hierarchy, which a per-Platform set would cut. Each choice changes Organization Service's policy structure and failure semantics, so it is an architecture choice, not an implementation detail.

**Scope on operations over existing records (clarified, not open).** A `get` or `cancel` is authorized by ownership of a record the producer created; ADR-0042 d5 says the organization lookup happens at the first assertion and never on reads. Cross-Platform access to another producer's records is impossible by the object rule. What a later *reduction* of a producer's Platform set does to its own earlier records is not stated anywhere, but it grants no cross-platform access, so this study treats it as an implementation detail to be written into the policy SDD.

### 13.9 What the implementation must encode (no new permission)

| Target | Entry | Source |
|---|---|---|
| Payment | `billing-service`: admitted; operations create, get, cancel; explicit Platform set (deployment data) | D3, AD-2, AD-3 |
| Payment | `auth-service`: admitted; operations: none | D3, AD-2 |
| Payment | every other caller, including Organization Service: not admitted | D3 |
| Billing | no producer admitted | D3 |
| Organization Service | provisioning identity: provisioning only | D1 |
| Organization Service | `billing-service`, `payment-service`: reference read; **scope per DEC-5 (narrowed)** | ADR-0042 d5 |
| Organization Service | `auth-service`: full read; **contingent on DEC-4; scope per DEC-5 (narrowed)** | ADR-0040 (Proposed) |
| Organization Service | everyone else, and the service write capability: none | D3, ADR-0042 d2, d3 |

### 13.10 Readiness impact

DEC-5 no longer blocks the admission matrix or the shape of the Payment, Billing and Organization Service policies. It leaves one narrower question, and it does not change the overall verdict.

BLOCKED BY ADDITIONAL ARCHITECTURE DECISIONS

Remaining decisions that genuinely prevent implementation of the affected stages: **DEC-1**, **DEC-2**, **DEC-3**, **DEC-4** (unchanged), and **DEC-5 (narrowed)**: the extent of Platform scope for credentials used against Organization Service. Stage impact: R2a is unchanged and now has its complete matrix; R3 (capability split and provisioning) proceeds except the scope of the reference-read entries; R6 waits on DEC-3 and DEC-5 (narrowed); R7 waits on DEC-4 and DEC-5 (narrowed).


---

## 14. Final Owner Decision Package — DEC-1 to DEC-5

**Scope.** This section turns sections 12 and 13 into five decisions the owner can answer directly. It is documentation only. It **recommends nothing**, amends no ADR, and changes no accepted decision (D1 to D4, AD-1 to AD-5). It uses the vocabulary at the top of this document. **IC-1 to IC-14 remain implementation choices; none is promoted to an owner decision here.** Each decision below has the same seven parts, so it can be answered without rereading the study.

### 14.0 The concepts the decisions keep apart

| Layer | Question it answers | Owner (EXISTING) | Operator (EXISTING) |
|---|---|---|---|
| **Authentication** | who is this, right now | password and a second factor; a session (`sid`) | working code (no password); a session bounded by the shift ceiling |
| **Step-up proof** | did this authenticated principal just re-prove intent for *this* operation, in *this* session | `owner_step_up`: factor re-verification, bound to owner, session and purpose, single use, at most 15 minutes | **none** (ADR-0028: operators "act on their session alone") |
| **Authorization** | may this principal do this operation on this resource | ADR-0042 d7 and D4, evaluated by Organization Service | the same, for an assigned platform |
| **Operation sensitivity** | does the operation *require* a step-up proof | AD-1's classification | AD-1's classification |

The invariant that runs through DEC-1 and DEC-2: **a sensitive operation is not an authorization to perform it.** Sensitivity only adds a requirement to an operation the principal is already authorized to do.

---

### 14.1 DEC-1: operator step-up

**1. Question.** How does an operator earn the step-up proof that AD-1 requires for sensitive administrative operations, or is AD-1 modified for operators?

**2. Source findings.**
- Owner step-up exists in full (`StepUpService`, `owner_step_up`; 14 purposes; single-use, session-bound, purpose-bound, at most 15 minutes) and is **keyed to owners**: `issue` selects `kind = 'owner'`; the table's foreign keys point at `owner` and `owner_auth_factor`.
- The operator working code (`OperatorCodeService`, `admin_operator_code`) is the operator's **login**: purposes `login` and `confirmation` only; six digits, HMAC-stored, single-use, throttled; delivered out of band through a broker event; redeemed by a public route into a **new** session.
- No operator factor, enrollment or recovery exists. ADR-0028: "Operators and org admins have no step-up mechanism." ADR-0027 records that raw one-time operator codes transit the broker.
- Under ADR-0042 d7, the only sensitive operation an operator can reach today is **creating an Organization** (see DEC-2). Owner paths and organization-admin metadata edits do not depend on this decision.

**3. Existing accepted decisions.** AD-1: the proof is single-use; bound to the user, the session and the purpose; time-limited; verified through Auth; owner purposes stay valid for owners; operator purposes are explicit; a client is never trusted to assert that step-up happened. D4: operators need step-up for sensitive operations. **Neither says what an operator does to earn the proof.**

**4. Options** (the four the study identified; no ranking).

| Property | **A. Working-code style step-up** | **B. Operator second factor** | **C. Re-authentication (re-login)** | **D. Modify AD-1 for operators** |
|---|---|---|---|---|
| What it is | a live-session operator requests a one-time code for a named purpose, delivered out of band, consumed through Auth | operators enroll TOTP or WebAuthn and re-verify it, as owners do | the operator repeats the login code flow and the fresh session is the proof | the owner changes AD-1 and D4 so operators need no step-up (or the owner restricts the operation, which would also change ADR-0042 d7) |
| Security property actually proven | recent control of the operator's contact channel, plus intent for a purpose; **not an independent factor** (the same channel delivers the login code) | possession of an enrolled factor **independent of the contact channel** | recent control of the contact channel; the same property as A, without purpose | nothing beyond the operator's existing session |
| Session binding | achievable, and new: the request requires the live session and the code is bound to its `sid` | achievable (as for owners) | **no**: redeeming mints a new `sid`, so a proof for the *current* session does not exist | none |
| Purpose binding | achievable, and new (new purpose values) | yes (as for owners) | **no**: the code's purpose is `login` | none |
| Single use | yes (existing `consumedAt` pattern) | yes | yes | not applicable |
| Expiry | new short lifetime (login codes today last until shift end) | yes (15-minute database ceiling pattern) | shift-end ceiling of the new session | not applicable |
| Client neutrality | yes: out of band, no client identifier | TOTP yes; WebAuthn carries origin and relying-party configuration (ADR-0041) | yes | yes |
| Auth changes | new purpose values (database enum), a session-binding column or table, a session-authenticated request route, a verify-and-consume endpoint for Organization Service (IC-11), separate throttle buckets, audit events | operator factor storage, enrollment, recovery and removal lifecycle; generalizing the step-up service beyond `ownerId`; **not designed here** | none for the proof | none in Auth; documentation changes |
| Depends on | `OperatorCodeService`, the pepper, throttles, the broker and notification channel (ADR-0027 residual) | the owner factor code as a pattern; new tables | the existing verify route | owner amendment of AD-1 and D4 |
| Meets AD-1 as accepted | yes, once built | yes, once built | **no** (no session or purpose binding); choosing it modifies AD-1 | modifies AD-1 |

**5. Consequences.**
- A adds a second use for the operator's contact channel and a dependency on the notification path for a security proof; it is not a second factor.
- B is the only option that proves an independent factor, and the only one that requires designing operator factor enrollment and recovery; the study has not designed it and will not unless the owner chooses it.
- C leaves the Auth code untouched and drops two of AD-1's properties for operators.
- D leaves operators as ADR-0028 describes them and removes a control the owner accepted in AD-1.
- Whatever is chosen affects **one operation today** (operator creation of an Organization).

**6. Dependencies.** DEC-2 (which operations); IC-11 (verify-and-consume shape); an Auth migration for A or B; ADR-0027 for A; ADR-0028 (its statement about operators changes for A or B).

**7. Exact owner decision required.** *State how an operator satisfies AD-1 for the operator-reachable sensitive operation: option A, B, C, D, or another mechanism you describe. If C is chosen, confirm that AD-1's session and purpose binding are waived for operators. If B is chosen, confirm that designing operator factor enrollment and recovery is authorized.*

---

### 14.2 DEC-2: sensitivity versus authority

**1. Question.** Given that a sensitive operation is not an authorization, what remains to be stated about which operations are sensitive and whether owners need step-up?

**2. Source findings.**
- **Reachable by operators under ADR-0042 d7 and D4:** create Organization (assigned platform) and edit Organization metadata (assigned platform). **Not reachable:** create or edit a Platform, create a Company, change any hierarchy link.
- **Reachable by owners (own company):** create and edit Platforms, create and edit Organizations. Company creation is the provisioning identity's (D1).
- **Organization admins:** edit Organization metadata of their own organizations where the server-derived facts grant it (D4).
- **Organization Service fields today** (migrations, input files, triggers): Company `name`; Platform `name` writable, `key` present but **not writable** through the API, `companyId` immutable; Organization `name`, `taxCode`, `address`, `phone`, `type` writable, `platformId` immutable. There is **no ownership field** and no Platform "configuration" field other than `name`.
- **Existing owner step-up design:** `platform.create` (design-only; the route `POST /auth/admin/platforms` was never built). No owner purpose exists for creating an Organization, and ADR-0025 lists ordinary organization access and reads as deliberately not step-up.

**3. Existing accepted decisions.** ADR-0042 d7 and D4 (authority); AD-1's sensitive list: creating a Platform, changing Platform-level administrative configuration, creating an Organization, changing Organization ownership or hierarchy-sensitive metadata, and others the Organization Service contract classifies; ordinary low-risk metadata needs no step-up "unless explicitly classified as sensitive".

**Verified against the invariant:**

| Operation | Owner may | Operator may | Org admin may | AD-1 status | Does AD-1 widen operator authority? |
|---|---|---|---|---|---|
| create Platform | yes | **no** | no | sensitive (named) | **no**: an operator is denied at the authority stage before step-up matters |
| edit Platform (`name`; no other configuration field exists) | yes | **no** | no | unclear whether `name` is "administrative configuration" | no |
| create Organization | yes | yes | no | sensitive (named) | no: the operator already had this authority |
| edit Organization metadata | yes | yes | yes (own organization) | not sensitive unless explicitly classified | no |
| "ownership or hierarchy-sensitive metadata" | none | none | none | named | **applies to no field or operation today**: hierarchy links are immutable by trigger and refused by the API, and no ownership column exists |

**Answers to the four questions:** (1) operator-reachable: create Organization, edit Organization metadata; (2) **no operation in AD-1 widens operator authority**, provided the list is read as a sensitivity classification; (3) owners: `platform.create` has a design-only purpose, and no owner purpose exists for the other classified operations, which AD-1 does not address; (4) whether a Platform rename is sensitive is unclassified.

**4. Options** (the remaining open items are small and independent).

| Item | Options |
|---|---|
| **2a** Classification is not authority (the reading used above) | confirmed as stated; or the owner states a different reading |
| **2b** Is a Platform rename (`name`) "administrative configuration"? | sensitive; or not sensitive (then it needs no step-up under AD-1's own default) |
| **2c** Do owners need step-up for the classified operations? | separately for: create Platform (existing design-only purpose: carries over, or not), create Organization (a new owner purpose, or none), rename Platform (only if 2b says sensitive) |
| **2d** Fields named "ownership or hierarchy-sensitive" | none exist today; the item stays a rule for future fields under AD-1's last bullet, or the owner names a field |

**5. Consequences.** Until 2c is answered, the human-route contract cannot say whether an owner creating an Organization or renaming a Platform must present a step-up; an implementer would otherwise decide owner-side policy. 2b and 2d change no mechanism.

**6. Dependencies.** DEC-1 (only for the operator path of creating an Organization); the Organization Service authorization contract (IC-5, IC-6); ADR-0042 d7.

**7. Exact owner decision required.** *Answer 2a to 2d: confirm that classification is not authority; state whether a Platform rename is sensitive; state, for each classified operation that an owner performs, whether an owner step-up is required and under which purpose; and confirm that "ownership or hierarchy-sensitive metadata" currently names no field.*

---

### 14.3 DEC-3 and DEC-5 (joint analysis)

DEC-3 and DEC-5 are one problem: **which authority answers, for which caller, under which credential, within which scope, for which hierarchy resource.** They are analysed together, starting from the callers the repository actually has.

#### 14.3.1 The concrete callers

| Caller | Does it need hierarchy data? | What exactly | Platforms it acts for | Producers it acts for | Read or write | Before cutover | After cutover | Source |
|---|---|---|---|---|---|---|---|---|
| **Payment to the hierarchy authority** | **yes**, to enforce a producer's Platform scope on a payment that involves an Organization (`organizationId` set, or an `organization` seller) | organization to platform (the parent chain also returns the company) | **many**: the admitted producer's Platform set; the request's Platform is not in the request | one today (`billing-service`); more only if admitted | **reference read** | only if a Platform-scoped **production** credential exists (DEC-3) | yes | AD-3, ADR-0042 d5 |
| **Billing to the hierarchy authority** | **conditionally**: D3 admits **no** producer to Billing, so there is no producer scope to enforce; a need arises only if producers are admitted to Billing, or if B-036(a) (the Platform of an invoice) is decided | organization to platform | many, if it arises | none today | reference read | same condition | same condition | D3, ADR-0042 Consequences (names Billing), Billing SDD B-036 |
| **Auth to Organization Service** | **yes**, for the administrative first-touch flows (first join code, invitation, assignment, and the bootstrap flow) | the entity by id, parents first, with `name` and `key` snapshots: a **full read** | **all Platforms of the company** it administers, not one | none (it acts for human administrators) | read | **none**: Auth is the authority | yes | ADR-0040 d1, d2 (Proposed) |
| **Provisioning identity to Organization Service** | yes | creates a Company | **none**: a Company has no Platform | not applicable | **write** (provisioning only) | not applicable | fresh environment, and later Companies | D1, D2 |
| Human administrators | not a service credential | user bearer through Auth | per grant facts | not applicable | read and write | not applicable | after cutover | D4 |

Observations that follow from the table:
- **Before cutover the only caller with a possible need is Payment** (and Billing conditionally), and its authority is **Auth**, not Organization Service, which holds no authoritative data and has no registered caller until cutover (ADR-0040 d3).
- The **producer's** Platform scope (billing-service's set) lives in the **consumer's** policy (Payment's), because the Platform is not in the request and differs per producer.
- The credentials that would *consult* the authority are Payment's and Billing's own, Auth's, and the provisioning identity's.
- A payment with no Organization (user-only parties) has nothing to resolve; D3's item 6 already says scope applies "where applicable". A `company` party has no Platform and is reachable only through its producer (Payment SDD; B-026 and O-18 stay open and are not decided here).

```text
authority              caller                  credential                 scope                    resource
(pre) Auth       <-- Payment (Billing?)    <-- its own service token  <-- ?  (DEC-5)          organization -> platform
(post) OrgService <-- Payment (Billing?)   <-- its own service token  <-- ?  (DEC-5)          organization -> platform
(post) OrgService <-- Auth                 <-- its own service token  <-- ?  (DEC-5)          company, platform, organization (full)
(post) OrgService <-- provisioning         <-- dedicated credential   <-- outside scope (D2)  create Company
producer scope (billing-service's Platform set) is evaluated by Payment, after the answer, and is not in question
```

#### 14.3.2 DEC-3: the candidate mechanisms

| Dimension | **A. No pre-cutover cross-service validation** | **B. Read-only Auth hierarchy reference endpoint for trusted services** | **C. Shared, exported or copied reference** |
|---|---|---|---|
| Authority | none consulted; the admitted producer's assertion is trusted (ADR-0042 option B.1 for admitted producers) | Auth, which is correct while Auth is authoritative | none: a copy |
| Authentication | existing service token | Auth gains a service-token callee side: new digests for the calling services in Auth (at most two per caller) | not applicable |
| Credential admission | Payment's existing admission list | a new admission list for **Auth as a target** (D3 says "not admitted unless explicitly authorized") | not applicable |
| Operation authorization | not applicable | one capability, reference read (ids and parents only), by Auth-side policy | not applicable |
| Hierarchy read contract | none | input: an organization id; output: organization id, platform id, company id; unknown id: not found | a file, a map or a table |
| Resource validation | uuid shape and the existing object rules | Auth resolves through its own tables (`platformOfOrganization`, internal today); anchors are immutable by trigger in Auth (`organization.platformId`) | as fresh as the last export |
| Caching | none | memoization only while ids are never reused and anchors never change (ADR-0042 d5); the id-reuse invariant I1 is Proposed | the copy is the cache |
| Failure semantics | no new failure mode; Platform scope **unenforced** for Organization-involving requests | Auth unreachable: creates for an unseen organization fail closed 503 (ADR-0042 d5); reads unaffected | stale or missing entries; nothing signals staleness |
| Availability | none added | adds Auth to the **create** path of Payment (and Billing); Auth already serves their user-bearer paths | depends on the export cadence |
| Correlation and audit | producer identity only | kit correlation headers; Auth audit events for service callers and denials | none |
| Cutover transition | nothing to switch; AD-3 is unenforced until cutover | consumers switch to Organization Service at cutover; Auth's answer afterwards would come from a non-authoritative cache, so the consumer's active-authority setting must be explicit (AD-5) | a copy made before cutover misses organizations created after it |
| Rollback | not applicable | consumer authority setting reverts only inside ADR-0040's zero-write window | not applicable |
| New authentication-path dependency | no | **none for Auth's own authentication path** (Auth calls nobody new); a new dependency on Auth for Payment's and Billing's creates | no |
| Conflict with ADR-0040 | none | none in its decisions; its rejected "Auth export API" was a whole-hierarchy dump for import, a different purpose; the cutover sequence needs an added consumer-switch step | ADR-0039 rejected a permanent replica; ADR-0040 rejects a frozen copy (R4) as Auth's reference model |
| Supported by existing architecture? | yes, for the admitted producers (ADR-0042 option B.1), but it leaves AD-3 unenforced | Auth-as-authority is AD-5's own wording; a **service-callable route does not exist** and is not designed | **no**: a shared database is prohibited (CLAUDE.md, ADR-0032); an exported file used as a validator is a copy that AD-5 forbids ("never stale"); a data-bearing library conflicts with the kit boundary; each would introduce a synchronization and authority mechanism the record does not contain |

**When A is safe.** A is consistent with every accepted decision **only if no Platform-scoped production credential makes an Organization-involving request before the cutover** (test fixtures excepted). If one does, A fails AD-3: the resolution is mandatory (see 14.3.3) and A provides none, so the request would have to fail closed, which makes Organization-involving payments unusable until cutover. Requests with no Organization are unaffected.

**Alternatives excluded by evidence:** a non-authoritative Organization Service copy as validator (it misses organizations Auth creates after the import, and no caller token is registered until cutover, ADR-0040 d3); an event-derived replica (rejected by ADR-0039, not chosen by AD-5, not invented here); signed assertions (needs signing infrastructure deferred by ADR-0033 and unapproved); forwarding an end-user bearer (Payment's and Billing's create routes are service-token only).

#### 14.3.3 The wording tension: AD-3 "must" and AD-5 "may"

The two sentences **can be made consistent**, and only one reading satisfies all of the accepted words.

- AD-3: Organization-involving requests **must** resolve Organization to Platform through the authoritative hierarchy, are authorized only inside the producer's scope, and before cutover "the implementation must use the explicitly approved pre-cutover mechanism from AD-5".
- AD-5: service authorization **may** validate against Auth's hierarchy while Auth is authoritative; no operation may silently accept an unvalidated relationship; never fall back to stale or client-supplied hierarchy information.

Consistent reading: the **outcome** (resolution and scope) is mandatory; Auth is the **permitted authority** before cutover; the **mechanism** is separate. Owner acceptance is needed because this chooses a meaning between two accepted answers. Wording for the owner to accept or replace:

- **W1 (mandatory outcome).** "Whenever a request made with a Platform-scoped production credential involves an Organization, the Organization-to-Platform relationship must be resolved from the active hierarchy authority and must lie within that credential's Platform scope. If it cannot be resolved, the request fails closed."
- **W2 (permitted authority, mechanism separate).** "Before Organization Service is authoritative, the active hierarchy authority is Auth's hierarchy. The mechanism by which a consuming service consults it is decided separately, and this sentence implies none."
- **W3 (not applicable).** "A request that involves no Organization is not subject to Platform-scope resolution ('where applicable', D3 item 6). It remains subject to admission, operation authorization and ownership."

The alternative reading, that pre-cutover validation is optional, contradicts AD-3's "authorized only if the resolved Platform is inside the producer's scope" and AD-5's "no operation may silently accept an unvalidated relationship". If the owner intends it, AD-3 must be modified for the pre-cutover period.

#### 14.3.4 DEC-5: does Platform scope apply to the service credentials that consult the authority?

First, what is **not** in question: the **producer's** scope (for example `billing-service`'s Platform set in Payment's policy) is evaluated by the **consumer** after the authority answers, because the Platform is not in the request and differs per producer. This is the shape AD-3 describes ("authorized only if the resolved Platform is inside the producer's assigned scope"). What is in question is only whether the **credentials used to consult the authority** (Payment's and Billing's, Auth's, and, before cutover, whatever credential consults Auth) **also** carry a Platform scope that the authority evaluates.

| Dimension | **Model A**: the authority verifies the hierarchy and returns the result; the consumer enforces its own Platform scope | **Model B**: the authority verifies the hierarchy **and** the calling credential's Platform scope, then returns the result |
|---|---|---|
| Security boundary | the authority answers any registered, admitted caller; the boundary is the consumer's producer scope | a second boundary at the authority: a credential outside its set gets no answer |
| Implicit all-Platform access | the consulting credential can read ids and parents (and, for Auth, names and keys) of **every** Platform: an implicit all-Platform *read* of reference data, though it grants no producer access | none: the read is bounded by an explicit set |
| Multi-Platform services | no set to maintain | Payment and Billing act for producers with different sets, so the credential's set must cover the **union**, and change whenever a producer's set changes |
| Billing and Payment behavior | resolve, then compare with the producer's set | resolve; a denial can come from either the authority or the consumer, with different error paths |
| Auth reference-cache behavior | Auth's `ensure` reads any entity of its company | Auth needs the **whole company's** hierarchy, including Platforms created later; an explicit Platform set would have to list every Platform and be extended each time one is created, or first-touch for a new Platform is denied |
| Credential management | one capability per caller | a capability and a Platform set per caller, kept in step across services |
| Pre-cutover behavior | not applicable unless DEC-3 (b): then Auth answers any admitted caller | not applicable unless DEC-3 (b): then Auth must hold and evaluate the sets |
| Post-cutover behavior | Organization Service answers any admitted caller | Organization Service evaluates the sets |
| Failure semantics | not found for an unknown id; an out-of-scope Platform is denied by the consumer | a collapsed not-found or forbidden from the authority for an out-of-scope Platform (to avoid an existence oracle) |

Credential by credential:

| Credential | Producer identity | Target and operation | One Platform or many | Platform known from the request | Resolvable from the Organization | Can the authority evaluate scope | Must the consumer enforce |
|---|---|---|---|---|---|---|---|
| Payment to authority | `payment-service` | reference read | many | no | yes | yes, after resolving | **yes**, the producer's scope |
| Billing to authority (conditional) | `billing-service` | reference read | many | no | yes | yes, after resolving | yes, the producer's scope, if any |
| Auth to Organization Service | `auth-service` | full read | **all of the company's** | no | yes | only with a set that lists every Platform and follows new ones | not applicable |
| Provisioning identity | dedicated | create Company | none | not applicable | not applicable | **no**: outside scope by D2 (accepted) | not applicable |

**Is DEC-5 already determined?** No. D2 settles that Platform is the dimension and that provisioning is outside it. AD-3 settles the **producer** scope and that there is "no implicit all-Platform access" for each production credential. AD-5 settles the authority. **None of them says whether the consulting credentials are themselves scoped**, and both models fit the accepted words. Model A satisfies AD-3 for producer credentials; whether it also satisfies AD-3's "each production credential... no implicit all-Platform access" for the consulting credentials depends on whether those credentials are covered, which is the ambiguity. The two models change Organization Service's policy structure and its failure semantics, so an implementer cannot safely choose. **DEC-5 is a genuine owner decision, narrow, and expressed as a clarification of AD-3's extent.**

Wording for the owner to accept or replace:

- **W-A.** "AD-3's Platform scope applies to producer credentials and is evaluated by the target service after the hierarchy authority has resolved the Organization to a Platform. Credentials used to consult the hierarchy authority carry capabilities (reference read, full read) and no Platform scope."
- **W-B.** "AD-3's Platform scope applies to every production credential, including credentials used to consult the hierarchy authority, whose scope the authority evaluates after resolving the Organization. (How this applies to Auth's whole-company full read is stated by the owner.)"
- **W-C.** "As W-A for the reference read, and as stated by the owner for Auth's full read."

#### 14.3.5 How the two decisions couple

| DEC-3 choice | DEC-5 consequence |
|---|---|
| **(a)** no Platform-scoped production credential before cutover | DEC-5 applies only after cutover, against Organization Service |
| **(b)** an Auth reference endpoint | DEC-5 applies twice: to the credential used against Auth before cutover, and to the one used against Organization Service after it |
| **(c)** another mechanism | the owner states how DEC-5 applies |

Order of answering: DEC-3 first (it fixes which authorities exist before cutover), then DEC-5.

#### 14.3.6 DEC-3 decision package

**1. Question.** Before Organization Service is authoritative, how do trusted services resolve Organization to Platform while Auth is the authority, and are W1 to W3 accepted as the meaning of AD-3 and AD-5?

**2. Source findings.** Auth has no service-token routes; Payment is the only caller with a current need; Billing has none while no producer is admitted to it; Organization Service has no authoritative data and no caller before cutover; core architecture O9 lists the question as open; the AD-3 and AD-5 sentences are consistent under W1 and W2.

**3. Existing accepted decisions.** AD-3, AD-5 (authority by phase; no silent fallback; no emergency disable), D2, D3 item 6 ("where applicable"), ADR-0042 d5.

**4. Options.** (a) no Platform-scoped production credential makes an Organization-involving request before cutover; (b) Auth provides a read-only, service-token-authenticated reference endpoint; (c) another mechanism the owner describes. Option C of 14.3.2 (shared or copied reference) is excluded by the evidence given there.

**5. Consequences.** (a): no new mechanism; Organization-involving production payments wait for cutover. (b): a service-callable Auth route, an Auth-side admission list, new credentials, and an authority setting per consumer; it changes the stated fact that Auth has no callee side and core architecture §10 ("None now"). (c): as stated by the owner.

**6. Dependencies.** ADR-0040 d3 and d4 (state row, configuration switch, zero-write window); I1 for memoization; DEC-5 (b only); BD-7.

**7. Exact owner decision required.** *(i) Accept W1, W2 and W3, or state different wording (including, if intended, that pre-cutover validation is optional, which would modify AD-3). (ii) Choose (a), (b) or (c).*

#### 14.3.7 DEC-5 decision package

**1. Question.** Does a Platform scope apply to the service credentials that consult the hierarchy authority, and if so, evaluated by whom?

**2. Source findings.** Payment and Billing act for producers with different Platform sets; Auth needs the whole company's hierarchy; the provisioning identity has no Platform; the producer scope is enforced by the consumer under both models; Model A gives consulting credentials an implicit all-Platform read of reference data; Model B needs per-caller sets.

**3. Existing accepted decisions.** D2 (Platform scope; provisioning outside it), AD-3 (explicit scope per production credential; no implicit all-Platform access), ADR-0042 d2 and d3 ("where relevant").

**4. Options.** Model A (W-A); Model B (W-B); a mixed rule (W-C).

**5. Consequences.** See the Model table in 14.3.4: A adds no sets and leaves an all-Platform read of reference data; B adds a boundary and a set to keep in step across services, and does not fit Auth's whole-company read without a set that follows platform creation.

**6. Dependencies.** DEC-3 (which authorities exist before cutover); Organization Service's policy contents (D3 admission, ADR-0042 d3); AD-3.

**7. Exact owner decision required.** *Accept W-A, W-B or W-C, or state other wording; and, if a Platform scope applies to Auth's full read, state how a set covers Platforms created later.*

---

### 14.4 DEC-4: Auth reference cache and the Company model

**1. Question.** How does Auth hold the Company, Platform and Organization rows that its foreign keys require once it no longer creates them, and does accepting ADR-0040's reference model settle it?

**2. Source findings.** The chain is:

```text
Organization Service: Company (authoritative after cutover; fresh environment from the start)
        |  ensure(companyId): a validated first-touch fetch  (ADR-0040 d1, d2: Proposed; not built)
        v
Auth: company reference row (non-authoritative cache; never deleted; anchors immutable)
        |  foreign key, ON DELETE RESTRICT
        v
owner.companyId  /  operator.companyId  /  platform.companyId
```

- `owner.companyId` is `NOT NULL REFERENCES company(id)`; the same holds for `operator` and `platform`; the seven Auth tables that depend on the hierarchy (ADR-0040's count) match the migrations.
- Auth's bootstrap today **inserts** the Company when none exists. No `ensure` exists in Auth.
- Auth authorizes by **ids** (`o.companyId = p.companyId`), never by names.
- Auth enforces `organization.platformId` immutability by trigger (`0001`) and owner and operator `companyId` (`0002`).
- Company has one mutable field, `name`.

**3. Existing accepted decisions.** AD-4 (Auth no longer inserts the Company; the bootstrap continues owner initialization with the authoritative id), D1, ADR-0042 d8 (Auth's first-touch calls are those of ADR-0040 decision 2). **ADR-0040 is Proposed**, not accepted.

**Does accepting ADR-0040 decisions 1 and 2 suffice?**

| Concern | Resolved by ADR-0040 d1 and d2 as written? |
|---|---|
| Auth Company row and `owner.companyId` foreign-key integrity | **yes**: rows only by validated `ensure`, foreign keys stay, no deletes |
| Stale or missing reference | **yes**: missing row fetched at first touch; Organization Service unreachable fails closed for administrative first-touch flows only; anchor disagreement fails closed and alerts; name snapshots stale harmlessly |
| Post-cutover hierarchy references | **yes** |
| First-Company bootstrap | **partly**: d2 names the bootstrap flow as a permitted first-touch "if the company-creation decision so provides"; D1 and AD-4 now provide it, but ADR-0040 does not say so |
| Bootstrap sequencing (fresh environment) | **no**: ADR-0040 d3 registers Auth's token only late in the cutover sequence; a fresh environment needs Auth's read credential registered **before** the owner bootstrap, after the first Company is created |

**4. Options** (only those the record already contains, from ADR-0040 option A; no event replication, no second tenancy model, no withdrawn anchor mechanism).

| Option | Meaning | Status in the record |
|---|---|---|
| **R2c** | validated non-authoritative reference cache; rows only by `ensure`; foreign keys stay | Proposed in ADR-0040 |
| **R1** | live lookup with no Auth-side rows; foreign keys removed | rejected in ADR-0040 for `/auth/me` and onboarding paths |
| **R3** | event-fed projection | not chosen by ADR-0039; needs reliable events and a consumer |
| **R4** | frozen, never-updated copy | fails: new organizations become unusable |

An unvalidated insert of a supplied id is **not** in the record and is not offered.

**5. Consequences.** With R2c: Auth needs a read credential in Organization Service before the fresh-environment bootstrap; Organization Service must be reachable at bootstrap; the flow fails closed and writes nothing on failure, so it is retryable; Auth keeps name and key snapshots; the Auth code change is an `ensure` function and a bootstrap change. Without R2c, another model from the table must be accepted before the Auth side of the bootstrap can be designed.

**6. Dependencies.** ADR-0040 acceptance and the amendments in 14.5; the Auth read credential and its capability (settled in structure by section 13, scope by DEC-5); AD-4; the cutover sequence.

**7. Exact owner decision required.** *Accept ADR-0040 decisions 1 and 2 (R2c) as the way Auth holds Company, Platform and Organization rows, or name another option from the table; and authorize the ADR-0040 amendment listed in 14.5 (the fresh-environment sequence, the Auth credential's timing, and the bootstrap flow now being provided).* DEC-4 is therefore **a genuine owner decision, and its acceptance still requires an amendment to ADR-0040 for missing detail before implementation.**

---

### 14.5 Cross-ADR conformance

Classification: **contradiction** (two decisions cannot both hold); **missing detail** (a decision is silent where another now speaks); **implementation choice**; **wording issue** (documentation). No row below is a true contradiction.

| Decision | Existing ADR or decision affected | Conflict? | Amendment required? |
|---|---|---|---|
| **DEC-1** | AD-1 and D4 (Option C or D modifies them); ADR-0028's statement that operators have no step-up (changes under A or B); ADR-0025 (owner allow-list is extended, not changed); ADR-0027 (broker transit of codes, under A) | no contradiction with any accepted decision; option C waives AD-1 properties, option D removes AD-1's control: both are owner modifications, not conflicts | **ADR-0042** d7: missing detail (record the outcome). **ADR-0028**: wording issue (its statement about operators). Neither is required to start the framework stages |
| **DEC-2** | ADR-0042 d7 and D4 (authority); AD-1 (classification) | none; the AD-1 list names Platform operations under an "operators must" heading, a **wording issue** that DEC-2a resolves | **ADR-0042** d7: missing detail (the classification and owner step-up rules) |
| **DEC-3** | AD-3 and AD-5 (must and may): a **wording issue**, consistent under W1 to W3; ADR-0042 d5 names only Organization Service as the validator: **missing detail**; ADR-0040 d3 (cutover sequence has no consumer authority switch): **missing detail**; if option (b): ADR-0042 Context ("Auth has no callee side", a stated fact) and core architecture §10 ("None now") change; D3's admission table has no entry for Auth as a target: **missing detail** | none | **ADR-0042** d5 (phase-dependent authority) and, under (b), its Context; **ADR-0040** d3 (transition state, consumer switch); core architecture §6, §10, §11 O9 |
| **DEC-4** | ADR-0040 d1 and d2 (the reference model); ADR-0040 d3 (fresh-environment sequencing and Auth credential timing); ADR-0040's "Not decided" item on Company creation (now decided by D1 and AD-4); ADR-0039 (ADR-0040 already lists its supersession points) | none: AD-4 is consistent with R2c; ADR-0040's forward-fix-only rollback is consistent with AD-5's emergency rule | **ADR-0040**: missing detail (required before its acceptance); the Company-creation open item becomes obsolete |
| **DEC-5** | AD-3 ("each production credential"; "no implicit all-Platform access"); ADR-0042 d2 and d3 ("where relevant"); D2 (provisioning outside scope: consistent under every option) | none; both models fit the accepted words, which is the ambiguity | **ADR-0042** d2 or d3: missing detail; the policy SDD records the chosen model |

Cross-checks against the other decisions: **ADR-0039** (no new synchronous dependency on Auth's authentication path) holds under every option; **ADR-0041** (domain-owned, client-neutral APIs) holds, because no option makes a client type an input; **D1 to D4 and AD-1 to AD-5** are not modified by any option except where DEC-1 options C or D and the alternative reading in 14.3.3 are named as owner modifications.

### 14.6 Classification of the five

| Decision | Kind |
|---|---|
| DEC-1 | genuine owner decision (no operator mechanism exists) |
| DEC-2 | genuine owner decision, the smallest: four items of clarification and classification |
| DEC-3 | genuine owner decision (mechanism) plus acceptance of wording (W1 to W3) |
| DEC-4 | genuine owner decision (accept R2c), and **requires an ADR-0040 amendment** for missing detail |
| DEC-5 | genuine owner decision, narrow, expressed as a clarification of AD-3's extent |

Implementation clarifications already settled by section 13 (the Payment, Billing and Organization Service admission matrix) need no owner decision.

### Readiness

BLOCKED BY ADDITIONAL ARCHITECTURE DECISIONS

**Owner architecture decisions that genuinely prevent implementation** (and nothing else):

| Decision | Blocks |
|---|---|
| DEC-1 | operator path for creating an Organization |
| DEC-2 | owner-side step-up rules in the human-route contract |
| DEC-3 | platform-scope enforcement before cutover; the consumer authority setting |
| DEC-4 | Auth's Company reference row and the bootstrap change (and ADR-0040's acceptance) |
| DEC-5 | the policy structure of Organization Service's reference-read and full-read entries |

**Implementation choices** that remain implementation choices and are **not** owner decisions: IC-1 to IC-14 (section 8.2), including the policy engine location, the policy format, denial codes, the reference-read shape and memo, the human route layout, the grant endpoint contract, the provisioning tool, the durable actor record, the rate-limit order, replay order, the step-up evidence path and the authoritative gate. They need approval before the stage that builds them, as section 8.2 states.

**Not blocked by any of the above:** R1 (policy framework), R2a (Payment admission, with the complete matrix of section 13), R4 (Auth grant endpoint) and R8 (boundary and invariant tests).


---

## 15. Resolution of DEC-1 to DEC-5 (owner direction, 2026-09-20)

**Scope.** This section records how the owner's direction resolves the five decisions of section 14, the contracts Stage 10 must later implement, and the current readiness. It is documentation only. It **supersedes the verdict of sections 12 to 14** for DEC-1 to DEC-5; those sections are kept as the analysis that led here.

### 15.1 Result

| Decision | Resolution | Recorded in |
|---|---|---|
| **DEC-1** operator step-up | Auth's existing step-up is extended for operators: single-use, session-bound, purpose-bound, short-lived, server-validated proof; the operator re-authenticates with the operator credential that exists today; **no second factor**; step-up grants no authority | ADR-0042 Amendment 1 A.1 |
| **DEC-2** sensitivity and authority | authority unchanged; operators gain no Platform authority; sensitive operations (create Platform, create Organization) need step-up from whoever performs them; Organization metadata is ordinary; no "hierarchy-sensitive" category; Platform `name` change and Company `name` change unclassified (OPEN-3 and OPEN-4, defaults apply) | ADR-0042 A.2 |
| **DEC-3** validation mechanism | Organization Service is the sole service-facing validator; no Auth endpoint, no shared or second copy; AD-3 and AD-5 made consistent; derived: no pre-cutover service-facing validation, so Platform-scoped production credentials fail closed for Organization-involving requests until cutover | ADR-0042 A.3 |
| **DEC-4** reference cache and sequencing | ADR-0040 decisions 1 to 4 adopted; Auth is not a second authority; fresh-environment ten-step sequence reconciled with the single activation gate; zero-write window and one-way door kept | ADR-0040 Amendment 1; ADR-0042 A.4 |
| **DEC-5** Platform scope | explicit `allowedPlatforms` on production credentials that access Organization Service, evaluated by Organization Service after resolution; provisioning outside scope; no `platformId` on invoices or payments | ADR-0042 A.5 |

Each of the five earlier blockers is closed. What remains is listed in 15.5.

### 15.2 Contracts Stage 10 must later implement

Nothing below is implemented. These are the contracts the implementing SDDs and stages must satisfy.

**Auth: operator step-up (DEC-1).**
- New operator step-up purposes (names fixed in the contract); existing owner purposes untouched.
- A session binding (the proof is valid only in the requesting `sid`), a short window at most the existing step-up ceiling, single use, purpose binding.
- A request route that requires the operator's **live session** (the working-code request route today is public and issues login codes; it is not reused as is).
- A verify-and-consume endpoint authenticated by the user bearer: it validates and consumes the proof for the session and purpose and returns only success or failure.
- The step-up never widens authorization and never takes a client-supplied assertion.

**Organization Service: human administration (DEC-2, D4).**
- The evaluator is pure: facts from Auth plus its own anchors give allow or deny. Facts: authenticated User, Company ownership, active operator assignments, active organization-administrator memberships, the target hierarchy, the operation. No client field is an input.
- A per-operation "sensitive" flag; sensitive operations require a verified step-up, consumed before the write; a replay of an idempotent request returns the stored result without a second consume.
- Owners: create Platform (existing purpose) and create Organization (new owner purpose). Operators: create Organization (operator-sensitive purpose). Organization administrators: metadata of their own organizations, no step-up.

**Organization Service: service requests (DEC-3, DEC-5).**
- The flow of ADR-0042 A.3: credential, registered producer, admission for target and operation, identity not overridable, Organization-to-Platform resolution, Platform scope, operation authorization, resource invariants; fail closed; denials reveal nothing the caller may not know; rate limiting separate.
- A policy with per-caller capabilities and an explicit `allowedPlatforms` set; **no wildcard**; a credential with no set is refused; provisioning is outside scope; Company reads are not Platform-scoped.
- Entries: provisioning identity (provisioning only); `payment-service` (reference read); `billing-service` (reference read, empty set until a use exists); `auth-service` (full read); everyone else none.
- A documented procedure that extends a set when a Platform is created (Auth's set must list every Platform Auth references); no automatic grant.

**Payment (unchanged by these decisions).** `billing-service`: create, retrieve, cancel; `auth-service`: no operation; every other caller, including Organization Service: not admitted. The producer's own Platform scope is evaluated by Payment after resolution. Reference clients stay disabled until the cutover verification; before it, Platform-scoped production requests involving an Organization fail closed. Test fixtures are excepted. No `platformId` is added to Payment records.

**Billing (unchanged).** No producer is admitted; `platform_currency.platformId` stays currency configuration; no `platformId` on invoices; historical snapshots are untouched.

**Auth: reference cache and bootstrap (DEC-4).** `ensure(id)` for Company, Platform and Organization, parents first, validated, fail closed; the cache-write guard; the direct Company insert removed in the authoritative mode; the owner row references a placed reference row. The fresh-environment sequence is ADR-0040 Amendment 1, A1.3. The authentication paths never call Organization Service.

**Tests to add later.** Step-up: single use, expiry, another session, another purpose, client-claimed step-up, classification never widens authority. Service policy: admitted versus not, per target, per operation; cross-Platform denial (the P1/P2/P7 example); no wildcard; a producer scoped to Platform A cannot act for Platform B. Provisioning: only the provisioning identity creates a Company. Bootstrap: order, fail closed, retry. Repository checks: no `platformId` column on invoices or payments; Auth's authentication modules import no Organization Service client.

### 15.3 Cross-ADR consistency

| Document | Effect | Conflict? |
|---|---|---|
| ADR-0039 | forward note added; status "partly superseded by ADR-0040" for decisions 1 to 4; the rest stands | none |
| ADR-0040 | Amendment 1; decisions 1 to 4 adopted; 5 and 6 Proposed | none; the fresh-environment credential timing is a **missing detail** now recorded; the ten-step wording ("establish" versus "activate") is a **wording issue** reconciled and awaiting confirmation |
| ADR-0041 | one citation corrected; otherwise unchanged; client neutrality preserved | none |
| ADR-0042 | Amendment 1; **still Accepted** | none; AD-5's pre-cutover clause is permitted but not exercised (a wording clarification, not a reversal) |
| ADR-0028, ADR-0025 | forward notes only; owner purposes and membership operations unchanged | none |
| ADR-0033 | authentication unchanged | none |
| D1 to D4 | unchanged; D3 gains Organization Service admission entries without altering the Payment table | none |
| AD-1 to AD-5 | AD-1 made precise; AD-2 unchanged; AD-3 refined; AD-4 realized in the fresh-environment sequence; AD-5 clarified | none |

### 15.4 Final audit

| Area | Verified |
|---|---|
| **Authorization** | Platform is an explicit scope (A.5); a credential cannot claim scope (the set is server-side policy); the client supplies no authorization fact (A.2); producer admission is explicit (D3, A.3); operation authorization stays distinct from admission (A.3, Payment unchanged); rate limiting is stated as not authorization (A.3) |
| **Ownership** | Organization Service owns Company, Platform and Organization after cutover; Auth owns User, credentials, sessions, MFA, recovery and membership; Auth's hierarchy tables are explicitly non-authoritative (ADR-0040 A1.2); no third authority is introduced |
| **Authentication** | login, refresh, `/auth/me`, registration, join and ordinary authentication operations never call Organization Service (ADR-0042 decision 8; ADR-0040 A1.2); the administrative path is Client, Auth bearer, Organization Service authorization |
| **Cutover** | the fresh-environment sequence is explicit and the existing-environment sequence is unchanged; freeze, verify, activate and retire are preserved; the zero-write rollback boundary and the reconciliation rule after the first write are explicit; no automatic ownership rollback is invented |
| **Client neutrality** | no Tauri, browser, desktop or mobile assumption; no client-supplied fact; the step-up header carries no client identity |
| **Financial integrity** | no `platformId` on invoices or payments; Billing's `platform_currency.platformId` remains currency configuration and a Platform may permit several currencies; historical snapshots intact |
| **Offline, device and licensing** | not designed and not decided. The decisions leave ADR-0041 decision 6's guardrails satisfiable: the server stays authoritative, local client state is never authoritative, the local clock is never the sole authority for a lifetime, and offline authorization, if ever allowed, is an explicit, time-bounded, server-issued and server-revocable grant. The owner's note that a device is neither a user nor a session is **not recorded in ADR-0041 or elsewhere in the documents**, and is not decided here |

### 15.5 Open items

> **Update 2026-09-20:** OPEN-1, OPEN-2 and the confirmations below are resolved in section 16 (ADR-0040 Amendment 2). OPEN-3 and OPEN-4 remain, non-blocking.

| ID | Item | Kind |
|---|---|---|
| **OPEN-1** | acceptance of ADR-0040 decisions 5 (import mechanism) and 6 (interim invariants I1 and I2). Stage 10.0 section 16 requires ADR-0040 Accepted, with the interim BD-5 invariants approved, before Stage 10.1 | **OPEN: OWNER DECISION REQUIRED**, independent of DEC-1 to DEC-5 |
| **OPEN-2** | BD-7a to BD-7c: production topology and exposure, gated migrations, least-privilege roles for Organization Service; and BD-7d and BD-7e, or the owner's explicit acceptance of a rehearsal without them (Stage 10.0 section 16, item 3) | **OPEN: OWNER DECISION REQUIRED**, independent (an existing item) |
| **OPEN-3** | whether a Platform `name` change is sensitive (AD-1 names "Platform-level administrative configuration" as sensitive; the default "ordinary unless classified" is an interpretation the owner is asked to confirm) | OPEN: OWNER DECISION REQUIRED, **not blocking** |
| **OPEN-4** | who may change a Company's `name` (`PATCH /organization/companies/:id` exists) and whether it is sensitive; no holder is named, so it is denied by default | OPEN: OWNER DECISION REQUIRED, **not blocking** |
| confirmations | the reconciliation reading of the ten-step sequence; the earlier closing of the one-way door in a fresh environment (ADR-0040 A1.4); the derived consequence, entries and rules marked "derived" in ADR-0042 A.3 and A.5 (including that Billing's Organization-involving requests to Payment fail closed before cutover) | requested, not blocking |
| constraint | BD-8: the `/auth/me` and onboarding contracts stay frozen; nothing here changes them | unchanged |
| deferred | lifecycle (BD-5 semantics), multi-company, B-026, O-18, B-027, O-20, B-028, B-030, B-031, B-036, signed capabilities, offline and device identity, rotation cadence | not decided, not required here |

Implementation choices IC-1 to IC-14 remain implementation choices.

### 15.6 Stage impact

| Stage | After the direction |
|---|---|
| R1 policy framework, R2a Payment admission, R4 Auth grant endpoint, R8 tests | no remaining architecture blocker in DEC-1 to DEC-5 |
| R2b Payment platform scope, R6 reference client | active only after the cutover verification; before it, fail closed; depend on Stage 10.1 (OPEN-1, OPEN-2) |
| R3 Organization Service policy and provisioning | no BD-4 blocker; runs against an inactive Organization Service; the provisioning gate is the state row |
| R5 human routes | no BD-4 blocker for owners, operators and organization administrators |
| R7 bootstrap tooling and Auth's bootstrap change | Stage 10.2; needs ADR-0040 accepted (OPEN-1) |

### Readiness

> **Superseded by section 16.** The verdict below is as it stood before OPEN-1 and OPEN-2 were accepted.

BLOCKED — OWNER DECISION REQUIRED

**DEC-1 to DEC-5 are resolved, and no architecture blocker remains in those five areas.** The verdict is BLOCKED because **two independent owner decisions**, not covered by DEC-1 to DEC-5, are prerequisites of Stage 10 under the repository's own Stage 10.0 rules:

1. **OPEN-1:** ADR-0040 decisions 5 and 6 (the import mechanism and the interim invariants I1 and I2) are still Proposed. The direction adopted decisions 1 to 4 only, and this study does not infer acceptance of the rest.
2. **OPEN-2:** BD-7a to BD-7c (topology and exposure, gated migrations, least-privilege roles) are undecided.

OPEN-3 and OPEN-4 do not block.

**What this verdict does and does not say.** Stage 10.0 section 16 gates **Stage 10.1**, not every Stage 10 activity. Its items 1 and 2 are OPEN-1 and OPEN-2; item 3 (BD-7d and BD-7e, or an accepted rehearsal) is part of OPEN-2. Besides those, entering implementation still needs the approval of the implementation choices IC-1 to IC-14 for the stage concerned and the owner's confirmations listed in 15.5. **Within DEC-1 to DEC-5 no architecture blocker remains.** The BD-4 stages that need no Stage 10.1 prerequisite (the policy framework R1, Payment admission R2a, the Auth grant endpoint R4 and the repository tests R8) have no remaining architecture blocker, subject to those approvals.


---

## 16. OPEN-1 and OPEN-2 resolved; readiness for Stage 10.1 (2026-09-20)

**Scope.** This section records how the owner's acceptance of OPEN-1 and OPEN-2 resolves the last two blocking items, and evaluates readiness to *start* Stage 10.1. It is documentation only and implements nothing.

### 16.1 Result

| Item | Resolution | Recorded in |
|---|---|---|
| **OPEN-1** decision 5 | accepted: the checksummed snapshot export and compare-and-insert import; guarantee: *Organization Service receives exactly the verified hierarchy snapshot intended for cutover*; not replaced by `pg_dump` | ADR-0040 A2.2 |
| **OPEN-1** decision 6 | accepted: I1 (ids never reused) and I2 as **migration invariants, not a lifecycle policy**; I2 recorded in both parts (the owner's "not reparented or mutated" and the original "no physical delete") so no guard is dropped | ADR-0040 A2.3 |
| **OPEN-2** BD-7a to BD-7e | accepted as production-readiness and cutover gates G1 to G7 (ADR-0040 decision 7): explicit topology; deployment is not activation; gated migrations; least privilege before activation (Auth included); monitoring and backup and restore demonstrated in **one successful production-like rehearsal** with recorded evidence; explicit human approval | ADR-0040 A2.4 |
| **Ten-step wording** | one authority switch, **ACTIVATE AUTHORITY**; imported data does not make Organization Service authoritative | ADR-0040 A2.5 |
| **Fresh-environment door** | the same as an existing environment: the first committed hierarchy write after activation; **the earlier closing at the bootstrap is withdrawn** | ADR-0040 A2.6 |
| **ADR-0040** | **Accepted** | ADR-0040 status |

### 16.2 The sequences (ADR-0040 A2.5)

**Existing environment:** E0 expand (inert) deployed; E1 prepare (snapshot, checksummed export, verify, import into the inactive service, verify; repeatable); E2 freeze Auth; E3 final export under the freeze, verify, import, verify against the digest; E4 approval recorded and **ACTIVATE AUTHORITY** with no caller token; E5 post-activation verification; E6 register Auth's credential (ends the zero-write window; the door itself is the first committed write), mirror, retire Auth hierarchy writes; E7 post-cutover verification, then open other callers.

**Fresh environment:** F1 provision (inactive, marker `fresh`); F2 controlled first-Company bootstrap; F3 initial hierarchy is the first Company; F4 bootstrap Auth's reference state; F5 verify; F6 **ACTIVATE AUTHORITY**, mirror; F7 retire, post-activation verification, open other callers. Operations permitted while inactive are the bootstrap and provisioning, Auth's `ensure` for the bootstrap only, and health and readiness.

**The one-way door:** the first committed hierarchy write after activation. Before activation rollback is possible; between activation and the door there is a manual, provable zero-write window; after the door ownership rollback requires reconciliation and no automatic rollback is invented. The verified import is not the door.

### 16.3 Stage 10.0 section 16 prerequisites for starting Stage 10.1

| # | Prerequisite | State |
|---|---|---|
| 1 | ADR-0040 Accepted, with BD-1, BD-2, BD-3, BD-6 and the interim BD-5 invariants approved | **met** |
| 2 | BD-7a, BD-7b and BD-7c decided | **met** as accepted requirements (G1 to G3); the concrete topology stays undecided and is approved at G1 |
| 3 | BD-7d and BD-7e decided, or a rehearsal accepted without them | **met by the second branch** (gates G4 to G6); the restore drilled on the real volume is **not waived** (G5) |
| 4 | BD-8 evidence before any change to `/auth/me` or the resolve contract | **not needed**: Stage 10.1 changes neither; the contracts stay frozen |
| 5 | BD-4 | **resolved** (ADR-0042 and its amendments) |
| 6 | I1 and I2 approved before Auth's cache is trusted | **met** |

### 16.4 Cross-ADR consistency

| Document | State | Conflict? |
|---|---|---|
| ADR-0040 | Accepted; Amendment 2; superseded markers on the Amendment 1 fresh-environment table, note and door bullet | none remaining |
| ADR-0039 | partly superseded by ADR-0040 (Accepted); the import mechanism it left open is decided | none |
| ADR-0042 | Accepted; Amendment 2 (I1 accepted, the memo permitted, references updated) | none; the confirmations marked derived in A.3 and A.5 stay requested and are non-blocking |
| ADR-0041 | client neutrality preserved; two stale statements about ADR-0040 ("Proposed"; the no-cycle guardrail "moot if not accepted") carry update markers, since the reference cache is accepted | none in substance |
| ADR-0028, ADR-0025 | forward notes only | none |
| Stage 10.0 study, first Stage 10 study, core-architecture | update notes and the O9 row | none |

Two points where the direction and the record differed are stated openly in ADR-0040: I2 (the owner's "not reparented or mutated" versus the original "no physical delete": both recorded) and the one-way door (the direction's "write / activation" shorthand versus decision 4's "first committed write after activation": decision 4's precision is kept, and it is **not** moved earlier).

### 16.5 What remains open

- **OPEN-3** (Platform `name`), **OPEN-4** (Company `name`): non-blocking, defaults as recorded.
- **OPEN-5** (initial Platforms or Organizations before activation in a fresh environment): non-blocking for Stage 10.1; until decided the fresh initial hierarchy is the first Company only.
- Not decided and not needed to start: BD-5 lifecycle semantics, multi-company, B-026, O-18, B-036, the concrete topology (a gated Stage 10.1 deliverable), RPO and RTO values and monitoring thresholds (the rehearsal plan).
- The confirmations marked "derived" in ADR-0042 remain requested and do not block Stage 10.1.
- Implementation choices (IC-1 to IC-14) remain implementation choices, approved for the stage that builds them.

### 16.6 What the verdict means

**READY FOR STAGE 10.1 IMPLEMENTATION does not mean production ready.** It does not mean a production cutover is approved, a rehearsal has been completed, a production topology exists or has been deployed, any gate is met, or any authority has been activated. It means the architecture is decided sufficiently to **begin the implementation work that will eventually satisfy the production gates**.

### Readiness

READY FOR STAGE 10.1 IMPLEMENTATION

No genuine Stage 10.1 architecture blocker remains: OPEN-1 and OPEN-2 are explicitly accepted, ADR-0040 is Accepted, the ADRs are consistent, and the two confirmation ambiguities are resolved. The non-blocking open items are listed in 16.5.
