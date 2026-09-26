# Stage 20.7: Release Management focused certification and closure

- **Status: PASSED — STAGE 20 READY TO CLOSE** (on `chore/stage-20-focused-certification`; awaiting review; not committed).
- **Base:** `main` @ `c611b4a` (Stage 20.6 merged, PR #136). [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md)
  Accepted and **unchanged**.
- **Nature:** proof, not construction.
  - **Runtime source changes: NONE.** No change to migrations, Auth, the audit catalog, the API or configuration.
  - **Test-only change:** `apps/release-service/test/certification.e2e-spec.ts` (new).
  - **Documentation:** this record, and the 20.1 progress note.
- The earlier 20.1–20.6 records are not rewritten; §9 clarifies one sentence of the 20.4 record.

## 1. Method

Every claim was checked against the **current code and tests**, not against the stage records:
- the source, schema and migrations;
- the three controllers;
- the one outbound call (the Auth client);
- the audit catalog;
- Auth's step-up allow-list;
- the runbook signal names (every alert signal the runbook names is emitted by the code: 12 of 12);
- audit-service's dead-letter policy (release events are grammar-clean, so a catalog-order mistake is kept **byte for byte** and is
  replayable, as runbook §2 says).

Then:
- the full release-service suites were re-run;
- two cross-surface proofs were added where the per-stage suites did not make them in one place (§3);
- a final mutation campaign ran over the highest-risk invariants (§4).

## 2. Certification matrix

| Area | Result | Evidence |
|---|---|---|
| Architecture | **PASS** | A dedicated service with its own database. Three controllers (automation, owner admin, public read). The one outbound call is Auth, admin-only. No deployment, artifact, updater, store, entitlement, analytics, tracking or configuration concepts in code (source sweep). Kinds `backend, web, desktop, mobile_ios, mobile_android`: web first-class, Tauri nowhere (the generic-term and repository checks pass). |
| Domain | **PASS** | `schema` (20) and `store` (9): unique keys; immutable kind and identity; append-only policy; no delete or truncate, even for the owner; the triggers. |
| Lifecycle | **PASS** | `registered → published → withdrawn` only. Idempotent publish and withdraw. Registered-only withdrawal refused (app and trigger). No restore. Mutants C8 and C9. |
| SemVer and latest | **PASS** | `version` (30) and `decision` (20) unit tests: precedence, pre-releases, build metadata refused, native ids separate. Latest = published, not withdrawn, stable (C14, C15). |
| Automation | **PASS** | `automation` (68) plus the certification authority matrix: register, publish, product scope, idempotency, conflict, concurrency, one audit record. C1, C2, C3. |
| Human admin | **PASS** | `admin` (47) plus the matrix: own bearer; live Auth; owner; the operating Company; service, operator, member and wrong-Company refused; spoofed headers ignored. C4, C5, C5b. |
| Step-up | **PASS** | Two distinct factor-only purposes; single use; session- and purpose-bound (release-service tests plus Auth `step-up-verify` 7/7 in the real Auth). C6, C7. |
| Compatibility | **PASS** | `compatibility` (34) plus `decision` (20): the full matrix; withdrawn priority; no forced update from a newer release; no `supported` field and no `targetVersion`; withdrawn-above-latest `required` with no downgrade. C10–C13. |
| Audit | **PASS** | Four actions with the correct actor, resource, bounded changes and platform scope, validated against the contract (1089/1089). Real delivery into audit-service (producers 3/3, audit ingestion 35/35). No secrets or versions. No duplicate on retry or no-op. |
| Outbox | **PASS** | Atomic with the mutation (forced outbox failures roll back: automation, withdraw, policy). Broker outage leaves the intent durable and drained later (`outbox`, `hardening`, cross-service). C16. |
| Security | **PASS** | The adversarial suites of 20.3–20.6 plus the certification matrix (10 caller types × 5 operations: nothing opens a surface it does not own). |
| Privacy | **PASS** | No identity input on the public read. Only the HMAC-keyed limiter digest is stored, then purged. No per-read audit. Logs and snapshot lines carry no token, proof, version, product or address (tested). |
| Rate limit | **PASS** | Peer or rightmost hop; spoofing refused; IPv6 /64; mapped IPv4; invalid and 304 requests counted; limiter failure is a 500, never a decision; janitor. C17, C18, C19. |
| Cache / ETag | **PASS** | `max-age` 60; errors `no-store`; a deterministic strong ETag; invalidation on publication, minimum and client withdrawal; unchanged for irrelevant state; no false 304 (C20). |
| Concurrency | **PASS** | Concurrent register, publish, withdraw and policy changes; minimum-vs-withdraw races (6 rounds); reads racing administration. Every final state satisfies the invariants (real PostgreSQL, separate sessions). |
| Failure handling | **PASS** | §6: PostgreSQL down (new certification test), Auth timeout and unavailable, broker down, outbox insert failure, limiter failure, shutdown. |
| Observability | **PASS** | Fixed-grid counters (junk labels dropped, unit-tested); `unknown_release` as a count only; the outbox backlog; Auth failure classes distinguishable. |
| Operations / runbooks | **PASS** | Runbook sections match the code (signals, CLIs, DLQ policy, deploy order, rotation, invariants). |
| Production prerequisite tracking | **PASS** | §8: each item is tracked with an ID and owner; none is represented as complete. |

## 3. New certification tests (test-only)

`test/certification.e2e-spec.ts` (11), on real PostgreSQL as the runtime role, with Auth as a contract stub.

**The authority matrix:** 10 caller types × all 5 operations on one application. Each run checks the resulting rows, so what changed
matches exactly what was allowed, and release-service's own service credentials never reach Auth.

| Caller | CI register | CI publish | Owner withdraw | Owner minimum | Public read |
|---|:-:|:-:|:-:|:-:|:-:|
| CI, own product (register + publish) | ✅ | ✅ | 401 | 401 | ✅ |
| CI, register-only | ✅ | 403 | 401 | 401 | ✅ |
| CI, wrong product | 403 | 403 | 401 | 401 | ✅ |
| Another service's credential | 401 | 401 | 401 | 401 | ✅ |
| Owner of the operating Company (+ step-up) | 401 | 401 | ✅ | ✅ | ✅ |
| Owner of another Company | 401 | 401 | 403 | 403 | ✅ |
| Operator | 401 | 401 | 403 | 403 | ✅ |
| Member | 401 | 401 | 403 | 403 | ✅ |
| Anonymous | 401 | 401 | 401 | 401 | ✅ |
| Anonymous with forged identity headers | 401 | 401 | 401 | 401 | ✅ |

**The PostgreSQL-down failure row, per surface.** Register, publish, withdraw and the public read all fail with a bounded 5xx:
- no decision, `no-store`, and no host or credential text;
- `/health` 200 and `/ready` 503;
- after recovery, nothing was half-written, and the read answers again.

## 4. Mutation certification (21 mutants; the full release-service unit and E2E suites per mutant)

**All 21 killed.** Every source was restored and hash-verified.

| # | Mutant | Result (failing tests) |
|---|---|---|
| C1 | Product scope bypassed | killed (8) |
| C2 | Publish authority bypassed (register implies publish) | killed (6) |
| C3 | Human through the CI route (token guard removed) | killed (164) |
| C4 | Service identity through the owner route | killed (11) |
| C5 | Owner verification bypassed (kind) | killed (5) |
| C5b | Operating Company bypassed | killed (2) |
| C6 | Step-up bypassed | killed (3) |
| C7 | Step-up purposes interchanged | killed (11) |
| C8 | Registered-only withdrawal allowed (application layer) | killed (1) |
| C9 | Minimum ≤ latest bypassed on withdrawal, **in the application and the database trigger** | killed (6) |
| C10 | Withdrawal ignored by the decision | killed (9) |
| C11 | Minimum ignored by the decision | killed (7) |
| C12 | A newer release forces an update | killed (16) |
| C13 | Unknown release answered as compatible | killed (3) |
| C14 | Pre-release counted as latest | killed (1) |
| C15 | Withdrawn release counted as latest | killed (1) |
| C16 | Outbox atomicity broken (withdrawal evidence after commit) | killed (1) |
| C17 | Spoofed forwarding header trusted | killed (3) |
| C18 | IPv6 normalization removed | killed (3) |
| C19 | Public rate limit bypassed | killed (2) |
| C20 | False ETag 304 (any `If-None-Match` matches) | killed (4) |

## 5. Compatibility matrix (certified cases)

| Client | Minimum | Latest | State | Answer |
|---|---|---|---|---|
| 3.0.0 | 2.0.0 | 3.0.0 | published | `none` |
| 2.5.0 | 2.0.0 | 3.0.0 | published | `available` |
| 1.5.0 | 2.0.0 | 3.0.0 | published | `required` / `below_minimum` |
| 2.5.0 | 2.0.0 | 3.0.0 | withdrawn | `required` / `withdrawn` |
| 1.0.0 | 2.0.0 | 3.0.0 | withdrawn | `required` / `withdrawn` (withdrawn wins) |
| 4.0.0 | – | 3.0.0 | withdrawn above latest | `required` / `withdrawn`, `latestVersion` 3.0.0 (a fact; no downgrade target) |
| 2.0.0-rc.1 | – | 1.0.0 | published pre-release | `none` (pre-releases are never latest) |
| 2.0.0-rc.1 | 2.0.0 | 3.0.0 | published | `required` / `below_minimum` (SemVer precedence) |
| 3.0.0 | none | 3.0.0 | published | `none` |
| 3.0.0 | – | 1.0.0 | registered-only | `none` (its own decision) |
| `v1.0.0`, `1.0.0+7`, `01.0.0`, … | | | | 400 `invalid_version` |
| unknown product / component / backend | | | | 404 `unknown_component` |
| 1.5.0 (not registered) | | | | 404 `unknown_release` (never guessed) |

## 6. Failure matrix (tested behaviour)

| Failure | Automation | Owner admin | Public compatibility | Audit evidence |
|---|---|---|---|---|
| PostgreSQL down | bounded 5xx, nothing written | bounded 5xx, nothing written, proof unspent | bounded 5xx, `no-store`, never a decision | nothing to write; `/ready` 503 |
| Auth down or slow | unaffected | 503 `auth_unavailable` / `auth_timeout`, fail closed, proof unspent | unaffected | none (nothing changed) |
| Broker down | commits (201/200) | commits | unaffected | durable in the outbox; backlog visible; drains on return |
| Audit rejects an event (e.g. catalog order) | commits | commits | unaffected | dead-lettered by audit-service **with the original body** (grammar-clean) and replayable (audit-service tests; runbook §2) |
| Limiter store fails | n/a | n/a | bounded 500, counted `failed`, never a decision, recovers | n/a |
| Outbox insert fails | 500, rolled back | 500, rolled back (proof spent in Auth; runbook §4) | n/a | none |
| Shutdown | admission stops, bounded drain | same | same | relay drained; loops and timers stopped; pool last |

## 7. Accepted limitations (carried, still valid)

| Limitation | Risk | Compensating control | Future |
|---|---|---|---|
| No restoration of a withdrawn release | a mistaken withdrawal needs a fix-forward | lower-then-withdraw runbook; fix-forward publish | future design |
| No `revoked` state for never-published builds | a compromised unpublished build cannot be withdrawn | it is never latest or a minimum; raise the minimum after a fix | future design |
| Stray mistyped components | a stray key | inert; runbook §6 | — |
| Cache staleness (≤ 60 s) | a `required` reaches clients within a minute | no stale-*; clients re-check at start and resume | 21.x tuning |
| No per-client history | no usage analytics | by design; outcome counts only | — |
| Counters exclude pre-handler 401 / DTO 400 | unauthenticated noise is uncounted here | ingress / access logs | 21.x monitoring |
| CORS is service-wide when enabled | admin reachable from listed origins | exact origins, no credentials, bearer or token still required | 21.x ingress |
| NAT clients share a bucket | legitimate 429s | configurable rate; clients fail open | 21.x tuning |
| The rightmost-hop proxy assumption | behind a CDN every client shares the edge bucket (strict) | never loose; `TRUST_PROXY` off by default | 21.x (P-R5 / P-S3) |
| A spent step-up after a post-Auth failure | the owner steps up again | runbook §4 | — |

## 8. Production prerequisites and Core-wide findings (tracked; none complete; not blocking closure)

**Production prerequisites:**
- **P-R1:** CI credentials.
- **P-R5:** ingress, TLS, `TRUST_PROXY`, CORS origins, WAF and volumetric limits, and the CDN conditions of 20.6 §5.
- **P-R6:** snapshot collection and alert routing.
- **P-R7:** deployment items, outbox capacity and backups.
- **P-A1:** broker ACLs.
- **P-A4:** audit DLQ alerting.
- **P-A6:** production RabbitMQ.
- **P-S2:** token rotation.
- **P-S3:** Auth reachability and TLS.
- **P-S5:** monitoring.
- **Provisioning:** the production `RELEASE_RATE_LIMIT_KEY` and the production `RELEASE_OPERATING_COMPANY_ID`.

**Core-wide findings** (for the Core quality / security work; **not changed here**; each must be resolved **before Stage 22 Final Core
Validation**):
- **F3:** file-service's limiter and the kit's `TRUST_PROXY` have the proxy weakness release-service fixed locally.
- **F13:** the kit error filter may log raw internal error text.
- **CI-1 (new, found here):** `main`'s CI has been red since before Stage 20 (it was already failing on #129 and #130, Stage 19). The four
  failing jobs are all outside Release Management:
  - `audit-service`: the retention and operational suites spawn an unbuilt `dist/cli/retention.js`;
  - `notification-service`: two snapshot-count assertions;
  - "Stage 10.1 Auth/Organization wire contract" and "Real RabbitMQ loops": those jobs compile services without first building
    `@nawara/audit-contract`.

  The `release-service` CI job **and** its image job passed on every Stage 20 merge (#132–#136). This is **not** a Release defect, but it
  must be fixed before Stage 22 Final Core Validation (21.x / Core quality).

## 9. Clarification (documentation only)

The 20.4 record states that a service token on an owner route is "never forwarded to Auth". **Precisely:** release-service's **own**
configured service credentials are recognized and refused (401) without reaching Auth. This is proven in the certification matrix and by
mutant C4. A credential registered only at *another* service is an opaque value, indistinguishable from any unknown bearer. It reaches
Auth, which refuses it (401), exactly like a forged bearer. This is inherent to opaque tokens (ADR-0033), identical to Audit-X, and is
not a defect.

## 10. Test inventory and commands

| Suite | Command | Result |
|---|---|---|
| release-service unit (config 8, caller policy 17, version 30, decision 20, client address 4, counters 3, socket bound 1) | `npm test -w release-service` | 83 / 83 |
| release-service E2E, real PostgreSQL 16, runtime role: schema 20, store 9, health 5, automation 68, admin 47, compatibility 34, outbox 1, OpenAPI 6, hardening 9, **certification 11** | `npm run test:e2e -w release-service` | 210 / 210 |
| Cross-service: release producers (CI → audit-service; real Auth owner with real TOTP step-ups → audit-service) | `test:e2e -w @nawara/e2e-audit-producers -- release*.e2e-spec.ts` | 3 / 3 |
| Cross-service: audit contract (catalog incl. the four actions) | `npm test -w @nawara/audit-contract` | 1089 / 1089 |
| Cross-service: Auth step-up verify (both purposes, factor-only, purpose-bound, single-use) | `npm run test:e2e -w auth-service -- test/step-up-verify.e2e-spec.ts` | 7 / 7 |
| Cross-service: audit-service ingestion (admits the four release actions from `release-service`) | `npm run test:e2e -w audit-service -- test/ingestion-broker.e2e-spec.ts` | 35 / 35 |
| Mutation certification | 21 mutants × (unit + E2E) | 21 / 21 killed |
| Typecheck, lint (0 findings), build | | pass |
| Repository checks, and the check script's own tests | `check:repo`, `test:repo` | pass; 17 / 17 |
| Production image (production configuration, non-root) | `docker build` + `scripts/smoke-core-image.sh release-service` | SMOKE PASSED |

**How the E2E suites cover each area.** The files overlap in purpose, so they are not counted twice. Each E2E file is one of the 210:
- **Concurrency:** automation, admin, compatibility and store.
- **Failure injection:** admin, automation, outbox, hardening and certification.
- **Adversarial:** automation, admin, compatibility, hardening and certification.

**Not re-run, and why:**
- the whole auth-service, audit-service and notification suites, and every other Core service: no code of theirs changed since their last
  green focused runs (20.4 / 20.6), and only the narrow Release-integration files above apply;
- Full Core Validation.

**Full Core Validation: NOT RUN.**

## 11. Closure statement

```text
STAGE 20 — RELEASE MANAGEMENT
STATUS: CERTIFIED / READY TO CLOSE

Release Management Core V1 capability is complete.

Implementation:
20.1–20.6 complete.

Certification:
20.7 passed.

Production infrastructure prerequisites remain tracked for Stage 21.x.

Full Core Validation was NOT RUN.
```

Certified is not deployed. Release Management is **not** production-deployed; §8 lists what production still requires.
