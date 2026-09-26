# Stage 21: Shared Services Integration

- **Status:** PASSED — STAGE 21 READY TO CLOSE (on `feat/shared-services-integration`; awaiting review; not committed).
- **Base:** `main` @ `0ae4223` (Stage 20.7 merged, PR #137; Stage 20 closed).
- **Question answered:** does Nawara Core work as **one coherent platform** when a workflow crosses service boundaries? The individual
  certifications are not repeated.
- **Changes:**
  - **Runtime: NONE.**
  - **Test:** one new real-process platform suite (`test/e2e-audit-producers/shared-platform.e2e-spec.ts`).
  - **CI:** the CI-1 orchestration repair, plus a new CI job for the cross-service suites.
  - **Scripts:** build order in three root `test:e2e:*` scripts.
  - **Docs:** this record; Stage 20 marked closed.

## 1. Method

The integration audit was read-only and read from **code**, not documentation:
- every outbound HTTP client;
- every broker producer, consumer and binding;
- every database URL and role;
- every readiness check and service-token callee;
- the policies, error filters and correlation propagation.

Then:
- a new real-process suite ran every shared capability together on one broker;
- the CI-1 root causes were reproduced and fixed **from a clean copy** (no `dist`, no `node_modules`, fresh `npm ci`);
- every cross-service suite ran as the new CI job runs it.

## 2. Actual dependency graph (from the code)

```text
                               SYNCHRONOUS (HTTP)                                   ASYNCHRONOUS (outbox → RabbitMQ)
Product / client ──► Auth (own)                                          Auth ─┬─ audit.* (outbox, durable) ────────┐
Product API ──svc token──► Organization, Billing, Payment,                     └─ membership/contact/recovery events  │
                            Notification, File, Audit (reads), Release             (fire-and-forget, AUTH_EVENTS; F14) ─► Notification (intake)
Billing ──svc token──► Payment                                          Organization ── audit.* ─────────────────────┤
Billing, Payment ──user bearer──► Auth (/auth/me: human callers)        Billing ── audit.* + invoice.created ──────────┤
Organization admin ──human bearer──► Auth (grants, step-up verify)      Payment ── audit.* + payment.* ──► Billing (consumer)
Audit-X owner read ──human bearer──► Auth (grants, org check)           File ── audit.* ─────────────────────────────┤
Release owner admin ──human bearer──► Auth (grants, step-up verify)     Release ── audit.* ─────────────────────────►  Audit (consumer, audit.#)
Notification ──► email/SMS providers (external)                          Notification: produces nothing (owns no action)
```

| Service | Auth | Organization | Billing | Payment | Audit | Broker | Other |
|---|---|---|---|---|---|---|---|
| **Auth** | — | NONE | NONE | NONE | ASYNC (outbox) | ASYNC (outbox relay; legacy events fire-and-forget) | — |
| **Organization** | SYNC (human admin only) | — | NONE | NONE | ASYNC | ASYNC | — |
| **Billing** | SYNC (human callers only) | NONE | — | SYNC (svc token) + ASYNC consumer | ASYNC | ASYNC; readiness | — |
| **Payment** | SYNC (human callers only) | NONE | NONE | — | ASYNC | ASYNC; readiness | gateways (external) |
| **Notification** | NONE | NONE | NONE | NONE | NONE | ASYNC consumer; readiness | providers (external) |
| **File** | NONE | NONE | NONE | NONE | ASYNC | ASYNC | object store (config) |
| **Audit** | SYNC (Audit-X owner read only) | NONE | NONE | NONE | — | ASYNC consumer; readiness | — |
| **Platform admin** (the human routes in Auth, Organization, Audit-X, Release) | SYNC (live verification + step-up) | — | NONE | NONE | ASYNC | ASYNC | — |
| **Release** | SYNC (owner admin only) | NONE | NONE | NONE | ASYNC | ASYNC | — |

Every Auth dependency above is **runtime and per request**, and only on **human** paths. No service calls Auth at startup. No shared
service calls Billing, Payment, Organization or Audit synchronously.

**Forbidden coupling: none found.**
- No circular calls.
- Auth depends on no downstream service.
- Audit calls no producer.
- No Notification ↔ Release, Release ↔ Billing or File ↔ Notification coupling.
- No commercial check in any shared service.
- No cross-service import (`check:repo` architecture boundaries).

## 3. Integration certification matrix

| Area | Result | Evidence |
|---|---|---|
| Service boundaries | **PASS** | §2. `check:repo` boundaries. Only approved synchronous calls exist. |
| Database ownership | **PASS** | Each service reads only its own `DATABASE_URL`. The extra URLs (migrator, retention, ownership) are roles on the **same** database. `infra/postgres/verify.sh` proves no role can connect to another service's database. No foreign table access in code. |
| Human identity | **PASS** | Human bearers are verified live by Auth on every human path (Organization admin, Audit-X, Release admin, and Billing / Payment human callers). They are refused on every service-token route (platform suite). |
| Service identity | **PASS** (with the tracked open item S21-1) | Opaque tokens stored as digests; policies are deny-by-default in Organization, Notification, File, Audit and Release. **Payment / Billing: no per-caller admission yet** (S21-1, an accepted residual risk in ADR-0042). Every service token is refused on every foreign service and on every human route (platform suite). |
| Tenant isolation | **PASS** | Human paths derive the tenant from Auth. Service paths accept an asserted `organizationId` only from policy-admitted callers (File / Notification `organizations: request`), which is ADR-0048 / 0046 design. Audit and Audit-X allow one organization per request. Cross-Company is refused (Stage 19.3 / 20.4 real tests, re-run). Payment O-15 (producer-asserted organization) is tracked under S21-1. |
| Audit producers | **PASS** | §5. One evidence stream from six producers (platform suite and every producer suite, clean build). Actor, organization and privacy verified. |
| Outbox | **PASS** | Every audit producer writes its intent in the mutation's transaction through the kit outbox. The broker and audit-service outages were tested across processes: mutations commit and evidence arrives once. Auth's legacy domain events are a documented exception (F14, §7). |
| Failure isolation | **PASS** | §4, tested with real processes. |
| Retry / idempotency | **PASS** | §6. |
| Privacy | **PASS** | §8. The platform suite scans all evidence for tokens, bearers and emails. |
| Correlation | **PASS** | Every outbound client propagates `x-correlation-id`. Owner correlation ids reach the audit record through Auth and through Release→Auth. A correlation or request id equal to a user id grants nothing (platform suite). |
| Readiness | **PASS** | §4 table. Producers are ready without the broker; consumers report it. Payment is the one divergence (S21-5). |
| Shutdown | **PASS** | The kit drain order (admission → HTTP drain → workers and relay → bus → pool) is used by every kit service. Restarts of every service inside the platform suite were clean. The per-service shutdown suites were re-run through their CI suites. |
| Client neutrality | **PASS** | No browser-, desktop-, Tauri- or mobile-specific assumption in any shared service (code sweep). Web is first-class (Release guide). |

## 4. Failure isolation (tested: `shared-platform.e2e-spec.ts`, all real processes)

| Failure | Auth | Notification | File | Audit | Admin (owner routes) | Release |
|---|---|---|---|---|---|---|
| **Auth down** | — | API works, ready | works, ready | service reads work, ready; **Audit-X owner read 503** (fail closed) | **Release owner admin 503** (fail closed); Auth's own admin is down | CI and the public read work, ready |
| **Broker down** | mutations commit (audit waits in the outbox), ready | API works; **`/ready` 503** (its intake consumer needs the broker) | mutations commit, ready | **`/ready` 503** (a consumer) | mutations commit | mutations commit, ready; public read works |
| **audit-service down** | ready | ready | ready | — | commits | commits; evidence delivered **once** on return |
| **Notification down** | unaffected | — | works | works | unaffected | works |
| **File down** | unaffected | works | — | works | unaffected | works |
| **Release down** | unaffected | works | works | works | unaffected | — |
| **A service's database down** | that service only (per-service suites: `/ready` 503, bounded 5xx) | | | | | |

**Readiness semantics:**

| Service | Database required | Auth required | Broker required | Other |
|---|:-:|:-:|:-:|---|
| Auth | ✅ | — | ❌ | — |
| Organization | ✅ | ❌ | ❌ | — |
| Billing | ✅ | ❌ | ✅ (consumer of payment events) | — |
| Payment | ✅ | ❌ | ✅ **(a producer; diverges: S21-5)** | — |
| Notification | ✅ | ❌ | ✅ (intake consumer) | — |
| File | ✅ | ❌ | ❌ | the object store is not a readiness dependency |
| Audit | ✅ | ❌ | ✅ (ingestion consumer) | — |
| Release | ✅ | ❌ | ❌ | — |

**Shared failure domains.** One PostgreSQL server, with a separate database and roles per service and separate pools. One broker, with a
shared `guest` identity locally (production per-service users: P-A1). Separate ports. No shared filesystem, temp directory, cache,
coordinator or singleton. These are intentional shared infrastructure, not shared failure state.

## 5. Audit producer integration

| Producer | Actions | Outbox | Actor | Organization semantics | Result |
|---|---|---|---|---|---|
| auth-service | 24 (membership, admin, owner security, `account.*`) | kit outbox (18.7.5) | user (owner, member, operator) / system | required / none per catalog | **PASS** |
| organization-service | 7 | kit outbox | user / service | self / none / resource | **PASS** |
| billing-service | 11 | kit outbox | user / service / system | optional / required | **PASS** |
| payment-service | 5 | kit outbox | user / service / system | optional | **PASS** |
| file-service | 2 | kit outbox | service / system | optional | **PASS** |
| release-service | 4 | kit outbox | service (CI) / user owner | none | **PASS** |
| audit-service | 1 (its own reads) | written directly, in the read's transaction | service / user owner | none | **PASS** |
| notification-service | none (by catalog design: no privileged capability) | — | — | — | **PASS** (none required) |

- **One contract version (1).** One catalog in `@nawara/audit-contract`, used by the producer helper and by the consumer (1089 / 1089
  contract tests; audit-service ingestion admits all 53 bus actions).
- **Delivery.** Every producer's real process delivered to one live audit-service over real RabbitMQ from a clean build: the 10 suites of
  the new CI job, 26 / 26.
- **Deploy order.** audit-service with the catalog first. A wrong order dead-letters with the original body kept, and is replayable
  (Stage 20.7 §1).

## 6. Retry and idempotency

| Operation | Protection | Retry class |
|---|---|---|
| Release register / publish | natural key (component, version); state-idempotent | safe to retry |
| Release withdraw / policy change; Auth suspend / restore; Organization create | state-idempotent / `Idempotency-Key`; a **new step-up per attempt** | retry with a new proof |
| File upload / Notification send / Payment create / Billing payment request | `Idempotency-Key` (request hash) | idempotent with key |
| File delete | state-idempotent (202 again) | safe to retry |
| Outbox relay → broker | at least once; deterministic event ids where needed | safe (receivers deduplicate) |
| Audit ingestion | unique `(source, eventId)`; the same id with different evidence is refused | safe |
| Notification intake / Billing payment-event consumer | kit inbox | safe |
| Auth legacy domain events (F14) | fire-and-forget; not retried | a loss is possible (documented) |

**Step-up proofs are bound per purpose across services.** A `release.withdraw` proof cannot restore an Auth account, and is not spent by
trying (platform suite).

## 7. CI-1

```text
CI-1 STATUS: FIXED IN STAGE 21 (CI orchestration only; no runtime change)

ROOT CAUSES (reproduced from a clean copy: no dist, fresh npm ci):
  (a) Core CI matrix job ran "integration tests" BEFORE "build". The audit-service suites spawn dist/cli/retention.js and the
      notification-service suite spawns dist/cli/secret-keys.js → "Cannot find module" (audit: 2 tests; notification: the CLI test,
      whose aborted run left a live secret that then broke the "operational snapshot" count → the "two snapshot-count failures" were
      one root cause + one cascade, NOT expectation drift). Deterministic.
  (b) "Stage 10.1 wire contract" and "Real RabbitMQ loops" jobs built services without @nawara/audit-contract (imported by every
      producer since Stage 18.7) → TS2307. Deterministic.

FIXED IN STAGE 21 (.github/workflows/core-ci.yml, package.json):
  - matrix job: build the workspace before its integration suites;
  - both e2e jobs: build @nawara/audit-contract right after the kit;
  - root scripts test:e2e:real-broker / test:e2e:auth-organization: the same contract-first order; test:e2e:audit-producers also
    builds notification-service;
  - NEW job "Core shared platform integration": the cross-service suites (never in CI before) from a clean npm ci, contract first.

VERIFIED FROM CLEAN STATE:
  old order → exactly CI's failures (TS2307; the 2 notification tests; the 2 audit retention tests);
  fixed order → Stage 10.1 4/4, notification 303 (302 + 1 load flake, §9 S21-7; 58/58 ×3 in isolation), audit-service 423/423,
  shared-platform job 26/26.

RUNTIME IMPACT: none. No test expectation was changed. No build output committed.
FINAL CI STATUS: unknown until the PR runs (the fixes are only validated locally from a clean copy).
```

## 8. Privacy (cross-service data)

| From | To | Data | Why | Persisted | Result |
|---|---|---|---|---|---|
| Organization, Audit-X, Release (human routes) | Auth | the human's own bearer; a step-up proof (Organization, Release) | live verification; single-use proof | no | PASS |
| Billing, Payment (human callers) | Auth | the human's own bearer | `/auth/me` | no | PASS |
| Billing | Payment | a service token; the payment request (amount, currency, organization, references) | settlement | Payment | PASS |
| Payment | Billing (events) | payment ids, state, amounts | the invoice lifecycle | Billing | PASS |
| Auth | Notification (events) | recipient destination and template data (membership, contact code, owner recovery) | delivery | encrypted, with retention | PASS |
| Every producer | Audit | ids, closed codes, integers (contract screen); correlation | evidence | Audit | PASS (tokens, bearers, emails scanned: none) |
| Product | File | file bytes, name, organization | storage | File | PASS (no names or URLs in audit) |
| Product | Notification | destination, template data | delivery | encrypted | PASS |
| Public client | Release | product, component, version | the decision | the limiter digest only | PASS |

No service forwards a bearer or proof anywhere but Auth. Service credentials are never forwarded (release-service's own are refused
before Auth; §9 S21-4 covers the older clients). No raw IP is forwarded.

## 9. Findings

| ID | Finding | Classification |
|---|---|---|
| **CI-1** | CI build-order defects (§7) | **FIX IN STAGE 21** (done) |
| **S21-1** | Payment and Billing have **no per-caller admission** (ADR-0042 decision 3 decided Billing and Auth for Payment; not implemented; RR-1 / "Auth-token-on-Payment" is an accepted residual risk; Payment SDD O-13 / O-15 open). Compose registers an `auth-service` credential at Payment that Auth never uses. | **STAGE 22 BLOCKER**, a security boundary that must be resolved before Stage 22. **Carried into 21.C first**: decide whether Core V1 standardizes caller policy (the shared library / standard candidate below), then implement the ADR-0042 Payment / Billing admission list on that basis and remove unused credentials. Not implemented in Stage 21. |
| **S21-2** | Auth's domain events (the Notification intake) are fire-and-forget without an outbox (F14); `AUTH_EVENTS=off` in the production deploy | **ACCEPTED LIMITATION** (documented F14) + **21.x** (enabling it in production); the outbox is a **21.C / 21.R1 candidate** |
| **S21-3** | Auth keeps its own error envelope (it predates the kit filter) | **21.R1 QUALITY FINDING** |
| **S21-4** | The older outbound clients (the kit `HttpAuthClient` used by Billing / Payment, Organization's Auth-grants client, Billing's Payment client) have bounded timeouts but **follow redirects** and have **no response cap / body release** (the Stage 19.4 hardening is only in the Audit / Release / Notification clients). `fetch` strips `Authorization` on cross-origin redirects; the targets are configured internal services. | **21.R1 QUALITY FINDING** (security hardening consistency; → 21.R2) |
| **S21-5** | Payment (a producer) makes the broker a readiness dependency, unlike every other producer | **21.R1 QUALITY FINDING** |
| **S21-6** | The cross-service producer suite was never in CI | **FIX IN STAGE 21** (new CI job) |
| **S21-7** | The notification "fairness" test flaked once under full-suite load (3 / 3 green in isolation; never in CI history) | **21.R1 QUALITY FINDING** / pre-Stage-22 stabilization (test robustness; the test must be made robust, **never disabled or hidden** to make CI green) |
| **S21-8** | The new platform suite flaked once (1 of 6 runs): a restarted consumer was checked before `/ready` | **FIX IN STAGE 21** (the harness waits for `/ready` after restarts; re-verified, §10) |
| **F3** | The proxy / client-address trust weakness in file-service's limiter and the kit's `TRUST_PROXY` (still present: `req.ip` in `redemption-limiter.ts`) | **21.R1 / R2 security**; **STAGE 22 BLOCKER** |
| **F13** | The kit error filter logs the raw internal error message (still present: `exception.filter.ts`) | **21.R1 / R2 security**; **STAGE 22 BLOCKER** |

**21.C candidates** (undecided; investigate only; not built; 21.C evaluates each against the Core V1 completeness test):
- **A durable domain-event outbox for Auth.**
  - **Evidence:** S21-2. Every product that relies on Auth-driven notifications is exposed to loss today.
  - **Form:** library / standard (the kit outbox already exists).
- **A per-service caller-policy primitive in the kit.**
  - **Evidence:** five services hand-roll the same `*_SERVICE_POLICY` parser, and Payment / Billing have none (S21-1).
  - **Form:** library.
- **A generic product consumption guide.**
  - **Evidence:** a future product integrates Auth, Organization, Billing, Notification, File, Audit and Release through seven
    configuration surfaces and seven service tokens, with no single guide.
  - **Form:** standard / documentation.

**21.x prerequisites (carried; new evidence noted):**
- `AUTH_EVENTS=on` with production RabbitMQ (P-A6);
- per-service broker users (P-A1);
- production service-token issuance per caller (P-S2 / P-R1), and removing unused credentials (S21-1);
- TLS between services (P-S3);
- snapshot collection and alerting (P-R6 / P-A4 / P-S5);
- the Stage 20 list (20.7 §8).

## 10. Tests

| Suite | Where | Result |
|---|---|---|
| **Stage 21 platform suite** (`shared-platform.e2e-spec.ts`, 9): the three shapes, credential confusion (13 cross-service cases), cross-service step-up purpose binding, failure isolation (Auth, broker, audit-service, Notification, File, Release) | clean copy, real processes, real RabbitMQ | 9 / 9 on 3 consecutive runs after the S21-8 harness fix (before it: 5 of 6 runs green, 1 restart-timing flake) |
| **New CI job equivalent** (`npm run test:e2e:audit-producers`: contract-first build of every service, then the 10 cross-service suites) | clean copy | 26 / 26 (10 files) |
| Stage 10.1 Auth / Organization wire contract (fixed build order) | clean copy | 4 / 4 |
| notification-service integration (build first) | clean copy | 302 / 303 (S21-7 flake; the delivery-engine file 58 / 58 × 3) |
| audit-service integration (build first) | clean copy | 423 / 423 |
| CI-1 reproduction with the old order | clean copy | TS2307; notification 2 failed; audit retention 2 failed (as in CI) |
| Repository checks, and the check script's own tests | repo | pass; 17 / 17 |
| Suite type check | repo | pass |

**Not re-run:** the per-service unit and E2E suites of Auth, Organization, Billing, Payment, File and Release, and the real-broker
Billing / Payment loops (no runtime change; CI runs them). Full Core Validation is also not run.

**Mutation / negative validation (targeted, cross-service only):**
- the "contract build dependency removed" negative was reproduced (the old order fails exactly as CI did);
- credential confusion, identity from correlation, forged identity headers and step-up replay across services are exercised as negative
  cases in the platform suite;
- the per-service identity, outbox and tenant mutants of Stages 19 and 20 are not repeated.

## 11. Scope verification

**Not added:**
- no new Core service or generic capability;
- no authorization, commercial or API redesign;
- no 21.C, 21.x, 21.R1 or 21.R2 work;
- no Stage 22 work;
- no Nawara Drive work.

**Not changed:**
- no runtime code;
- no test expectation;
- no committed build output.

**Full Core Validation: NOT RUN.**
