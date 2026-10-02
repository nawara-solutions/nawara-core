# Nawara Core roadmap: Core V1 (current), Core V2 (planned), Nawara Admin

- **Status:** Authoritative. This is the one roadmap for Nawara Core: the current Core V1 state and checkpoint, the planned Core V2
  roadmap, the boundary between them, and the relationship with Nawara Admin. Other documents are the authority for their own
  subjects (see [Where the detail lives](#where-the-detail-lives)); when a statement about *status* or *direction* here conflicts with
  an older document, this one wins and the older one is the historical record.
- **Last verified:** 2026-10-02, `main` at `cb37cc0`.
- **Maintenance:** update the [current checkpoint](#current-checkpoint) when a checkpoint closes. Keep this document short: no run
  ids, test counts, branch names or session history. Evidence belongs in the stage records, not here.

## Agent / developer: start here

Before making changes:

1. Read this document.
2. Decide whether the task is **Core V1** (current) or **Core V2** (planned). If it is unclear, ask.
3. Check the [current checkpoint](#current-checkpoint).
4. Distinguish **CURRENT** implementation from **PLANNED** architecture. Planned behaviour is not evidence that it exists.
5. Do not reopen a CLOSED checkpoint without evidence of a regression.
6. Do not implement a Core V2 concept inside Core V1 implicitly.
7. Preserve V1 compatibility (status, `code`, response shape, events) unless the owner explicitly authorizes a change.
8. Treat Nawara Admin mocks as provisional contracts, never as Core contracts.
9. Every production mutation needs its own explicit owner authorization.
10. Final Core Validation is the **last** V1 validation campaign. Do not run it as part of any other task.

```text
NAWARA CORE
│
├── CORE V1   CURRENT / REAL       implemented, partly in production; stabilization and refactor active
│
└── CORE V2   FUTURE / PLANNED     architecture roadmap A0–A19; NOT YET IMPLEMENTED
```

---

## Core V1: current / real

Core V1 is the platform that exists in this repository today. Its services, boundaries and principles are described in
[`CLAUDE.md`](../CLAUDE.md) and [`docs/architecture/core-architecture.md`](architecture/core-architecture.md). Its capability set
was closed by [ADR-0052](adr/0052-core-v1-capability-closure.md).

### Production context

| Item | State |
|---|---|
| In production | auth-service, organization-service (**not authoritative**: Auth still owns the hierarchy), audit-service, RabbitMQ (the Auth → Audit relay) |
| Implemented, not in production | billing-service, payment-service, notification-service, file-service, release-service |
| Starter only | ai-service |
| Ownership cutover | gates G1–G5 and steps F1–F5 executed; **G6 not certified** (see below); G7, F6, F7 blocked behind G6 |
| Evidence record | [`stage-21-x-cutover-record.md`](architecture/stage-21/stage-21-x-cutover-record.md) (production facts, gates, digests) |

Production facts change only through authorized checkpoints; re-verify against the cutover record and the
[runbooks](runbooks/) rather than trusting this summary.

### G6: production-like rehearsal

G6 is **one successful rehearsal of the complete ownership-transition procedure in an isolated, disposable, production-like Ubuntu
environment** ([G6 plan](architecture/stage-21/stage-21-x-g6-rehearsal-plan.md), decision D-1). It is **not certified**: the owner has
intentionally deferred the rest of the rehearsal.

G6 is not tied to any particular hardware. The plan requires an isolated, disposable Ubuntu VM; where it runs is an owner decision,
for example:

- a disposable local Ubuntu VM;
- a temporary isolated Ubuntu cloud server;
- a spare physical Ubuntu machine.

Whatever the host, the plan's isolation rules apply (no production credentials, network path or backup destination; see the plan
§6.1 and the cutover record §6).

**What G6 blocks:** G7, F6, F7, the backup schedule and the pre-G7 backups (cutover record §7), and Final Core Validation.
**What G6 does not block:** Core V1 refactor work, Core V2 planning, and Nawara Admin development.

### Core V1 refactor (localization and stabilization)

The refactor implements [ADR-0054](adr/0054-localized-error-messages-and-stable-error-codes.md): stable machine `code`s, human
messages in English, French and Arabic, with English byte-compatible. It changes no business behaviour. Each service is implemented,
tested, reviewed and merged separately; services are never batched.

```text
CORE V1 REFACTOR

R0  Architecture inventory                 ✅ CLOSED
R1  Localization architecture (ADR-0054)   ✅ CLOSED
R2  Billing safe logging                   ✅ CLOSED
R3  Shared localization foundation         ✅ CLOSED
R4  Validation localization                ✅ CLOSED
R5  Auth localization adoption             ✅ CLOSED
R6  Remaining services                     ✅ CLOSED
    R6.1 Audit                             ✅ CLOSED
    R6.2 Organization                      ✅ CLOSED
    R6.3 Release                           ✅ CLOSED
         └─ Audit timing-test stabilization ✅ CLOSED
    R6.4 File                              ✅ CLOSED
    R6.5 Payment                           ✅ CLOSED
    R6.6 Billing                           ✅ CLOSED
    R6.7 Notification                      ✅ CLOSED
R7  Shared cleanup                         ✅ CLOSED (no material cleanup required)
R8  Legacy/type cleanup                    ✅ CLOSED (Release error helpers narrowed to MessageTexts)
R9  Refactor regression validation         ✅ CLOSED (merged R3–R8 state verified; negative controls detected)
R10 Documentation + error catalog          ✅ CLOSED (guide and per-service catalog index; no runtime change)
R11 Refactor certification                 ✅ CLOSED / CERTIFIED (refactor only; Core V1 not yet complete)

Final Core Validation (Stage 22)           🔒 ABSOLUTE LAST
```

### Current checkpoint

The Core V1 refactor (R0–R11) is closed and certified ([certification record](architecture/core-v1-refactor-certification.md)).
**Core V1 is not complete:** the remaining work is the production ownership cutover (G6, then G7, F6 and F7; see
[Production context](#production-context)), and Final Core Validation stays last.

### Compatibility and safety rules for V1 work

- Existing public contracts are preserved: HTTP status, `code`, response shape, event payloads, success bodies. Existing code-less
  errors stay code-less. Default English stays byte-identical.
- No breaking redesign inside V1. A change that would break a contract stops and goes to the owner.
- No production action (deploy, restart, `.env`, secrets, migrations, container changes) without a separate explicit authorization.
  Merging to `main` can auto-deploy Auth (`auth-service-docker-build.yml`); know a change's workflow impact before it merges.

### Final Core Validation

Final Core Validation (Stage 22) is intentionally the **final** Core V1 validation campaign: the expensive, platform-wide run that
happens once the planned V1 work is complete (the refactor through R11, and the gates that block it). It is **not** re-run after
each service or checkpoint. Each checkpoint gets its own focused validation instead: its tests, negative controls, risk-based
regression and CI.

---

## Core V2: future / planned

> **PLANNED. NOT YET IMPLEMENTED.** Nothing in this section exists in the code unless a V1 section above says so. A Core V2 stage
> starts only when the owner authorizes it. No completion percentages are tracked here.

Core V2 is the next platform architecture. It may redesign contracts deliberately, but only through explicit design documents
(ADR/ADD/SDD/TDD) and a migration plan, never by drift.

| Stage | Scope (planned) |
|---|---|
| **A0 Baseline** | the certified V1 baseline: service versions, API compatibility, deployment topology, infrastructure assumptions |
| **A1 Architecture** | service boundaries; standard bootstrap and service-kit adoption; Auth convergence; common request context; compatibility and migration strategy |
| **A2 Configuration & Secrets** | typed and validated configuration; environment separation; secret lifecycle and rotation; deployment contracts |
| **A3 Messaging** | broker conventions; event envelopes and versioning; retry, DLQ, idempotency; producer and consumer conventions; real-broker certification |
| **A4 Authentication** | sessions, MFA/TOTP, recovery, WebAuthn, cookies, rate limits, service authentication, account lifecycle and security |
| **A5 Organization** | companies and organizations, memberships, ownership, invitations, organization lifecycle, the Auth–Organization interaction |
| **A6 Authorization** | roles, permissions, policy evaluation, caller and service policies, ownership-aware authorization, cross-service enforcement |
| **A7 Audit** | event schema, accountability, producers, retention and querying, correlation, cross-service coverage |
| **A8 Notification** | templates, content localization, channels, delivery lifecycle, retries and fairness, preferences, observability, product contracts |
| **A9 File** | upload and download, authorization, metadata, limits, storage abstraction, failure handling, cleanup and lifecycle, security |
| **A10 Billing** | plans, subscriptions, billing entities, lifecycle and state, invoices and records, reconciliation, product integration |
| **A11 Payment** | provider architecture, webhooks, idempotency, reconciliation, failures, security, the Billing–Payment interaction |
| **A12 Observability** | logs, metrics, tracing, correlation, dashboards, health, alerts, redaction and privacy |
| **A13 Backup / Disaster Recovery** | automation, off-server storage, integrity, retention, restore automation and rehearsal, runbooks, RPO/RTO |
| **A14 Security** | Auth/Authz, service authentication, secrets, rate limits, proxy trust, input handling, F13 (opaque internal errors), dependencies and supply chain, security regression |
| **A15 Developer / Platform Experience** | service templates, shared libraries, local environment, testing and CI conventions, documentation, generators, localization conventions |
| **A16 Product Integration** | for Nawara School, Nawara Drive and future products: API contracts, authentication, authorization, organization/tenant context, files, notifications, billing and payment, audit |
| **A17 Product Readiness** | end-to-end product workflows, failure paths, onboarding, permissions, operations, deployment readiness |
| **A18 Performance** | load testing, bottlenecks, database and broker behaviour, connection pools, caching, scaling, capacity and load balancing |
| **A19 Release Certification** | final V2 certification across architecture, services, security, integration, observability, DR, performance, product readiness, documentation and CI |

---

## The V1 / V2 boundary

| Area | Core V1 | Core V2 |
|---|---|---|
| Status | current, real, partly in production | planned, future |
| Purpose | stabilize, refactor and certify the existing platform | the next platform architecture |
| Compatibility | existing contracts preserved | deliberate migrations may be designed |
| Breaking redesign | avoided; stops and goes to the owner | only through explicit design and a migration plan |
| Localization | the R0–R11 refactor program (ADR-0054) | a native platform convention (A15) |
| Authentication | the existing Auth implementation | planned convergence and evolution (A1, A4) |
| Admin integration | existing APIs where they exist | the primary future target |
| New contracts | only when explicitly required | designed systematically |

**Rules:**

- Do not implement a Core V2 roadmap item while working on Core V1 unless the owner explicitly authorizes it.
- Planned Core V2 behaviour is not evidence that the behaviour already exists in Core V1.
- Accepted ADRs remain binding for V1. A V2 design that departs from one supersedes it with a new ADR; it is never edited away.

---

## Nawara Admin

**Nawara Admin** (`nawara-admin`) is a **separate repository**: an operator frontend that consumes Core APIs. It is not a Core
microservice and holds no Core business rule. It may be developed in parallel with Core.

```text
                 NAWARA PLATFORM

       ┌─────────────────────────────┐
       ▼                             ▼
   nawara-core                  nawara-admin
   backend platform             operator frontend
       │                             │
       └────── API CONTRACTS ────────┘
```

Two accepted decisions already govern it:

- [ADR-0041](adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md): administrative capabilities are APIs of
  the domain service that owns the data, client-neutral, and authorized by the server on every request. Any access or composition
  layer holds no business rule, authority or state.
- [ADR-0050](adr/0050-platform-administration-and-verified-human-authority.md): a privileged human presents their **own** Auth bearer
  to the target service, which verifies them live. Headers, body fields and links are never authority. There is no delegated-human
  token system.

> **Terminology.** "Operator" in this section means a person using Nawara Admin. In Core V1, `operator` is also a specific Auth
> account kind (`owner | operator | member`, [ADR-0012](adr/0012-owner-managed-operator-schedule-and-blocking.md)), and today's
> human platform administration (Release, Audit) is performed by the **owner** of the operating Company. Which Core identities may
> use which Admin capability is an authorization decision for Core (A6), not an Admin assumption.

### Contract states

Every Admin feature declares which state its backend contract is in.

| State | Meaning | Admin may |
|---|---|---|
| 🟢 **EXISTING / CONFIRMED** | the endpoint exists in Core today; its contract is the service's OpenAPI at `GET /docs` | integrate directly (and check whether that service is in production) |
| 🟡 **PLANNED V2 / MOCKED** | the capability is in the accepted V2 direction; no real endpoint yet | build UI, domain models, an API interface, a mock adapter and mock data. **The mock is not the backend contract.** |
| 🔴 **UNDEFINED** | Core has not established the contract | design UX, placeholders and frontend-only view models. **No permanent backend API or schema may be declared;** a Core design decision comes first. |

Existing human-facing administration in Core V1 (🟢; exact routes in each service's `/docs`):

| Service | Human administration that exists | In production |
|---|---|---|
| auth-service | authentication (password, TOTP, WebAuthn, step-up), grants, owner administration of operators and members | yes |
| organization-service | Company/Platform/Organization reads and admin writes (`/organization/admin/…`) | yes, not authoritative |
| audit-service | owner read of one organization's audit records (`/audit/owner/…`) | yes |
| release-service | owner withdrawal and minimum-version administration (`/release/admin/…`) | no |
| billing-service, payment-service | service-token APIs only; **no human administration API** | no |

### Frontend structure (mock versus real)

```text
Angular component
       │
       ▼
Facade / store
       │
       ▼
Domain API interface
       ├──── Mock adapter          (🟡 PLANNED, 🔴 UNDEFINED)
       └──── Core HTTP adapter     (🟢 EXISTING)
```

Components never know whether their data is mocked or real. Moving a feature from mock to real replaces an adapter, not the UI.
This document prescribes the layering, not a state library; that choice belongs to the Admin project.

### Organization context (Admin / V2 product direction, not implemented)

```text
Global context
 ├── Platform overview · Organizations · Users/identity · Licenses
 ├── Billing · Payments · Services · Audit · Platform operations
 │
 ▼ select an organization
Organization context
 └── Overview · Users · Roles/permissions · Licenses · Billing · Payments · Files · Notifications · Audit
```

Selecting an organization is **context selection, not authentication**. The operator stays the same authenticated human; Core
authorizes each request from the operator, the organization and the requested action (ADR-0050). No token claim, header or
endpoint for "switching" exists or is implied.

### Licenses: ownership decided, operator contract undefined

The intended Admin flow is: Licenses → Create → select organization → select product (Nawara School, Nawara Drive, future
products) → plan / entitlements → validity / limits → review → activate.

What exists today:

- **Ownership is decided:** entitlement belongs to **billing-service**
  ([ADR-0038](adr/0038-entitlement-in-billing-service.md), shape in
  [ADR-0044](adr/0044-subscription-entitlement-final-model.md): one organization-scoped Subscription; there is no `License` or
  `UserSubscription` entity). Authentication never depends on entitlement ([ADR-0026](adr/0026-authentication-is-not-entitlement.md)).
- **No operator API exists** to create or change a subscription or entitlement. Billing exposes service-token APIs only.

So the license-management backend contract is **PLANNED / TO BE DEFINED DURING CORE V2** (A10, with A6 for authority). Fields
such as `maxUsers`, `storageQuota`, `features`, `validity`, `plan` or API access are **not** backend fields because a screen
needs them. Whether "license" becomes its own term or stays Billing's Subscription/Entitlement is a V2 design decision against
ADR-0044, not an Admin decision.

### Domain boundaries (not collapsed for the UI)

| Domain | Owns |
|---|---|
| Release | products, components, releases, client compatibility (ADR-0051); never entitlement |
| Billing | what is owed and what is entitled: catalog, prices, invoices, Subscription/Entitlement |
| Payment | how money moved: payments, attempts, provider webhooks, reconciliation |
| Auth / Organization | who the actor is, and which organization and authority they act in |

An Admin screen may combine several of these; the backend contracts stay separate.

### Authorization

Admin should be permission-aware: it may hide or disable actions the operator cannot perform. **Frontend authorization is not
security enforcement.** Core is authoritative, and every privileged operation is enforced server-side by the owning service.

### Localization

Admin is designed for English, French and Arabic, with an RTL-capable layout for Arabic. Frontend localization is the Admin
project's concern. Core's localized `message` is for display only. Application behaviour keys on stable machine values
(`code`, status, enums), **never on parsing a Core human message** (ADR-0054).

---

## Where the detail lives

| Subject | Authority |
|---|---|
| Status and direction (this roadmap), V1/V2 boundary, Admin relationship | this document |
| Decisions | [`docs/adr/`](adr/) |
| Service architecture and boundaries | [`core-architecture.md`](architecture/core-architecture.md), [`financial-architecture.md`](architecture/financial-architecture.md) |
| One service's design | [`docs/sdd/`](sdd/) and the service's README |
| Exact API contract | the service's OpenAPI at `GET /docs` |
| Production facts and gates | [`stage-21-x-cutover-record.md`](architecture/stage-21/stage-21-x-cutover-record.md), [`docs/runbooks/`](runbooks/) |
| Product integration | [`core-product-integration-guide.md`](architecture/core-product-integration-guide.md) |
| Error localization and the per-service error-code index | [`core-error-localization.md`](architecture/core-error-localization.md) |
| Core V1 refactor certification (R11) | [`core-v1-refactor-certification.md`](architecture/core-v1-refactor-certification.md) |
