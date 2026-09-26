# Stage 20.6: Release Management security, privacy and operational hardening

- **Status:** PASSED on `feat/release-security-operational-hardening` (awaiting review; not committed).
- **Base:** `main` @ `8c78f68` (Stage 20.5 merged, PR #135; [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) Accepted, **unchanged**).
- **Scope:** hardening only. The whole surface (CI automation, owner administration, the public compatibility read, and the
  infrastructure under them) was audited read-only first. Only real gaps were fixed; everything else is classified.
- **Not introduced:** no lifecycle state, authority, route, migration, Auth or audit-catalog change. The API contracts are unchanged.
- **Runbooks:** [`docs/runbooks/release-service.md`](../../runbooks/release-service.md).

## 1. Hardening audit: findings

| # | Finding | Classification | Action |
|---|---|---|---|
| F1 | With `TRUST_PROXY=true`, the kit sets Express `trust proxy: true`, whose `req.ip` is the **leftmost** `X-Forwarded-For` entry, written by the client. The public limiter keyed by it, so a client could pick its own bucket. | **FIXED** | `clientAddress()` keys by the peer, or with `TRUST_PROXY` by the **rightmost** hop (appended by our proxy, unforgeable). A longer chain collapses clients into stricter buckets, never looser ones. Tested (spoofed prefixes share one bucket; other clients unaffected), and mutation-proved. |
| F2 | IPv6 clients were bucketed per address: one host rotating the bits inside its /64 multiplied its budget. | **FIXED** | IPv6 counts by /64; an IPv4-mapped IPv6 address counts as the IPv4 address. Tested, and mutation-proved. |
| F3 | The same `req.ip` pattern exists in file-service's ticket limiter, and `TRUST_PROXY` is a kit-wide boolean. | **21.x** (Core-wide) | Not changed outside release-service. It is carried to the Core quality audit and to P-S3 / P-R5 (the real proxy chain decides the hop count). |
| F4 | Automation and owner administration had per-request log lines only: no aggregate signal to alert on. | **FIXED** | `release_automation_snapshot` / `release_admin_snapshot`: fixed grids of operation × outcome (§4). |
| F5 | No release-service signal for the audit backlog. | **FIXED** | `release_outbox_snapshot pending= oldest_pending_s= retrying= max_attempts=`, read from the service's own outbox (the kit `nawara-check-outbox-lag` query). The runbook covers on-demand checks. |
| F6 | Release events audit-service refuses (poison, or an unknown action) land in **audit-service's** DLQ. | **NO ISSUE** for release code; alerting is **21.x** (P-A4) | release-service does not consume and cannot see the broker without a new dependency. The runbook points to audit-service's DLQ tooling (`nawara-check-dlq`, `nawara-dlq replay`). |
| F7 | The 20.5 `If-None-Match` parser ignored lists over 1024 characters while Express's own freshness check still answered 304 for them. The counters could disagree with the response. | **FIXED** | No private cap (Node's 16 KiB header limit bounds it). A genuinely matching list is a true 304; malformed, oversized and foreign tags never are (tested). |
| F8 | Nothing stated at startup which surfaces a replica serves. | **FIXED** | `release_surfaces`: caller count, owner admin enabled or disabled and its Auth budget, compatibility `max-age` and rate, `trust_proxy`, the CORS origin count. Never an address, key or credential. |
| F9 | Automation 401s (the kit token guard) and DTO 400s (the kit pipe) happen before release code, so they are not in the automation counters. | **ACCEPTED LIMITATION** | The counters count requests that were authenticated and reached the operation. 401 volume belongs to ingress and access logs (21.x monitoring). |
| F10 | If the limiter storage fails, the public read must not answer a decision. | **NO ISSUE** (verified) | Bounded 500, `no-store`, counted `failed`, recovers. Tested, and mutation-proved (§5). |
| F11 | Dependency classification (Auth, broker, database). | **NO ISSUE** (verified) | §6. Auth and the broker are not readiness dependencies (tested). |
| F12 | Background timers and loops. | **NO ISSUE** (verified) | The reporters use `unref()`d intervals cleared at shutdown; the ops reporter never overlaps itself; the janitor is a kit `PollLoop` (no overlap, bounded drain) stopped in `beforeApplicationShutdown`; a final snapshot is written. Tested, and mutation-proved. |
| F13 | The kit exception filter logs an unhandled error's message (for a database connection error it may name an internal host). | **21.x** (Core-wide) | Responses stay opaque (tested). release-service's own lines log error **classes** only. Log handling is a Core-wide production item. |
| F14 | When `CORS_ORIGINS` is set, it applies to every route, not only `/compatibility`. | **ACCEPTED LIMITATION** | Exact origins only (the kit refuses wildcards, paths and schemes at boot); `credentials: false`; admin and automation routes still require their bearer or token. An owner web UI may legitimately need it. Default: off (tested: no ACAO for any origin). |
| F15 | Each public request costs one limiter upsert (write amplification under a flood). | **ACCEPTED** + **21.x** | The limiter is abuse control, not a DDoS shield. Volumetric protection is ingress / WAF (P-R5). Rows are purged each window. |
| F16 | Many clients behind one NAT share a bucket. | **ACCEPTED LIMITATION** | The default is 120 per minute per address (configurable); clients fail open on 429 with their last trusted decision. |
| F17 | `RELEASE_RATE_LIMIT_KEY` rotation. | **NO RUNTIME CHANGE**; provisioning **21.x** | Deployment-time replacement is safe: buckets restart empty, which allows at most one extra window per client. A key ring would add nothing to correctness. |
| F18 | Secret and config handling. | **NO ISSUE** (verified) | Production refuses: no broker, no limiter key, a superuser or migrator DB login, a malformed policy, a partial owner-admin configuration, an Auth URL with credentials, query or fragment, a short Swagger password. Digests only, never raw tokens. Nothing is echoed in errors, logs, `/health`, `/ready` or OpenAPI (tests across 20.3–20.6). |
| F19 | Error privacy. | **NO ISSUE** (verified) | No SQL, stack, Auth URL, host, owner, Company or configuration in any response (tests: automation, admin, compatibility, limiter failure, Auth down). |
| F20 | Production image. | **NO ISSUE** (verified) | Non-root (uid 1000), migrations shipped but never run at start, no credentials baked in, production validation at boot (smoke). |
| F21 | During a long broker outage the outbox grows without bound. | **ACCEPTED** + **21.x** | Audit evidence is never deleted to save space. The growth is visible (F5). Capacity planning is P-A6 / P-R7. |
| F22 | The per-request log lines carry the configured caller name, the verified owner's id and a release or component UUID. | **NO ISSUE** | These are logs, not metric labels. They are bounded identifiers needed for incident work. No version, product key, token, proof, address or body (tested). |
| F23 | A mistyped component key leaves a permanent, empty component. | **ACCEPTED LIMITATION** (§3) | Runbook §6. |
| F24–F28 | The rate-limit, reason, TTL and CDN decisions. | See §2, §5 | |

## 2. Security decisions

```text
AUTOMATION RATE LIMIT
Decision: DO NOT IMPLEMENT (application); volumetric control DEFERRED TO INGRESS (21.x, P-R5)
```

- Callers are few, configured service identities with per-product capabilities.
- Every operation is idempotent and bounded (a retry storm writes nothing new and records no evidence; a conflict storm is 409s).
- A compromised credential's blast radius is its own products, and rotation is the control (P-S2 / P-R1).
- A limiter could block a legitimate release pipeline at the worst moment, and would add a database write per call.
- Denials and conflicts are now alertable (`release_automation_snapshot`).

```text
OWNER ADMIN RATE LIMIT
Decision: DO NOT IMPLEMENT
```

- Each operation already requires the live verified owner of one configured Company **and** a fresh, single-use, purpose-bound factor
  step-up, which Auth issues and throttles (`step_up_ip`, `step_up_owner`).
- A per-owner limiter would only ever throttle the one legitimate owner. A per-address limiter would let one client poison another's
  administration (the risk the brief warns against).
- Probing is visible (`*_authority_denied`, `*_step_up_denied`).

```text
ADMIN REASON DECISION
Decision: NO REASON IN CORE V1
ADR impact: none
```

- ADR-0051 and the 20.1 audit design specify none.
- The evidence already names who (the verified owner), what (the release or component, the policy transition and releases), when, and
  correlation.
- A closed set would be a new API and audit-contract field: an amendment, and a decision gate, for no identified consumer. Free text is
  refused by the catalog anyway.
- Incident context belongs in the incident record, linked by the correlation id. It can be added later as an additive catalog change (A50)
  if a consumer appears.

```text
MISTYPED COMPONENT
Security / data-integrity problem: NO   Operational nuisance: YES (a stray empty key)   Runtime change needed: NO
Decision: SAFE ACCEPTED LIMITATION (runbook §6)
```

- Only a caller with `release.register` on that product can create one.
- It has no releases unless CI puts them there, so it is never latest for another component and never a minimum.
- Clients query the real key. Its only effect on the public read is `unknown_release` for that stray key.
- Deletion or archive would be a new lifecycle (a decision gate) and would erase auditability. Not added.

| Decision | Result |
|---|---|
| Automation rate limit | **UNCHANGED** (no application limit); volumetric **DEFERRED TO 21.x** |
| Owner-admin rate limit | **UNCHANGED** (no application limit) |
| Compatibility TTL | **UNCHANGED** (60 s) |
| CDN caching | **DEFERRED TO 21.x**, allowed with conditions (§5) |
| Mistyped component | **ACCEPTED LIMITATION** |
| Administrative reason set | **UNCHANGED** (no reason in Core V1) |
| Auth readiness classification | **UNCHANGED** (not a readiness dependency; owner admin fails closed) |
| Broker readiness classification | **UNCHANGED** (not a readiness dependency; the outbox absorbs outages) |
| Limiter client address | **IMPLEMENTED** (F1, F2) |
| Operational counters and backlog signal | **IMPLEMENTED** (F4, F5, F8) |

## 3. Accepted limitations (Stage 20, carried)

| Limitation | Risk | Why acceptable in Core V1 | Compensating control | Future |
|---|---|---|---|---|
| No release restoration (withdrawn is final) | a mistaken withdrawal needs a fix-forward | withdrawal is a security act, and restoring would reopen a retracted build | lower-then-withdraw runbook; fix-forward publish | future design |
| No `revoked` state for never-published builds | a compromised unpublished build cannot be marked withdrawn | it is never latest or a minimum; the minimum can be raised above it after a fix | runbook §4 | future design (20.4 §1) |
| An empty mistyped component | a stray key | inert (§2) | runbook §6 | — |
| The cache freshness window (`max-age` 60 s) | a new `required` can take up to 60 s to reach a client | bounded; no stale-while-revalidate | clients re-check at start and resume | 21.x tuning with real traffic |
| No per-client compatibility history | no analytics on who runs what | by design (not analytics, no tracking) | the `unknown_release` / outcome counts | — |
| The automation and admin counters exclude 401 / DTO-400 (F9) | unauthenticated noise is not counted here | those happen before release code | ingress / access logs | 21.x monitoring |
| CORS applies service-wide when enabled (F14) | admin routes are reachable from listed origins | exact origins, no credentials, bearer still required | off by default | 21.x ingress |
| Shared NAT buckets (F16) | legitimate 429s | configurable rate; clients fail open | runbook §8 | 21.x tuning |
| The proxy-chain assumption (rightmost hop) | behind a CDN every client shares the edge's bucket (strict) | never loose; real chain unknown | `TRUST_PROXY` off by default | 21.x (P-R5 / P-S3) |
| A spent step-up on post-proof failure (20.4) | the owner steps up again | no distributed transaction between Auth and release-service | runbook §4 | — |

## 4. Observability (bounded by construction)

| Line | Labels (closed sets) | Carries |
|---|---|---|
| `release_automation_snapshot` | `{register,publish}` × `{changed,unchanged,denied,invalid,not_found,conflict,failed}` | counts |
| `release_admin_snapshot` | `{withdraw,policy_change}` × `{changed,unchanged,unauthenticated,authority_denied,step_up_denied,invalid,not_found,conflict,auth_timeout,auth_unavailable,failed}` | counts |
| `release_compatibility_snapshot` (20.5) | `{required_withdrawn,required_below_minimum,available,none,not_modified,invalid_version,invalid_request,unknown_component,unknown_release,rate_limited,failed}` | counts + latency count / avg / max |
| `release_outbox_snapshot` | none | pending, oldest pending seconds, retrying, max attempts |
| `release_surfaces` (startup) | none | surface flags and bounds |

- **Owner-admin distinctions.** `auth_timeout` (slow Auth), `auth_unavailable` (Auth down or misbehaving), `authority_denied` (a
  non-owner) and `step_up_denied` (a missing or bad proof) are separate outcomes. No identity is attached.
- **`unknown_release`.** It is an alertable count only: no version or client is stored (runbook §5).
- **Bounded by construction.** The counters are a **fixed grid**: an unknown operation or outcome is dropped, never added as a label
  (unit-tested with product, version, caller, UUID and address values; mutation-proved). No line carries a product, component, version,
  release id, caller, owner, Company, session, proof, address or correlation id (tested on real traffic). Metric collection and routing is
  21.x (P-R6).

## 5. Compatibility operations

**Cache TTL: KEEP 60 s.**
- There is no repository or operational evidence for another value.
- It bounds how long a `required` stays hidden (withdrawal or emergency minimum) to one minute, with cheap `If-None-Match` revalidation.
- Tuning with real traffic is 21.x.

**Rate limiter.** Per keyed client address (F1, F2), counted before validation, janitor-purged.
- **Failure: fail closed as an API error.** A limiter or database failure is a bounded 500, never a decision. It is fail-closed because the
  decision needs the same database anyway, and a limiter that failed open would give a flood free database reads at the moment the
  database is struggling. Clients then use their last trusted decision.

**ETag.** Unchanged (strong, over release status, policy version and latest). The only change is F7 (`If-None-Match` parsing aligned).

**Cache poisoning.** Checked:
- the response varies only by path and `version`;
- identity, cookie and Origin headers change neither body nor tag (tested);
- the tag is server-computed;
- malformed or oversized validators never force a 304 (tested);
- errors are `no-store`;
- nothing unpublished beyond the caller's own release, and nothing private, is ever included.

**CORS.** Off by default, exact origins only (§1 F14).

**`TRUST_PROXY`.** Rightmost hop (F1). The real chain is **21.x** (P-R5 / P-S3); it is not guessed.

```text
CDN DECISION
Core V1: ALLOWED WITH CONDITIONS (configuration is 21.x, P-R5)
Required production conditions:
- cache key = full path + the `version` query (never strip or normalize the query); no other query parameter forwarded
- honour origin Cache-Control: cache 200/304 for ≤ max-age; never cache no-store errors (400/404/429/5xx)
- no stale-while-revalidate / stale-if-error / serve-stale on origin error (would hide a withdrawal)
- pass ETag / If-None-Match through; do not rewrite ETags
- do not vary on or forward cookies or Authorization; Vary: Origin if CORS is enabled at the origin
- TRUST_PROXY and the limiter hop count configured for the CDN → ingress chain (the edge is then the rightmost hop)
- purge is not required for correctness (max-age bounds staleness)
```

## 6. Dependency classification (verified)

| Dependency | `/health` | `/ready` | Runtime behaviour when it fails |
|---|---|---|---|
| PostgreSQL | independent (200) | **yes** (`database`, `migrations`) | every surface fails: 500s, `*_failed`; nothing half-written; no decision from a failed read |
| Auth | independent | **no** | owner administration fails closed (503 `auth_timeout` / `auth_unavailable`, nothing changed, no proof spent); automation and the public read unaffected (tested) |
| Broker / audit-service | independent | **no** | mutations commit with durable outbox intent; the relay retries; `release_outbox_snapshot` shows the backlog; the public read unaffected (tested) |

A replica is ready when it can serve its data surfaces. One surface's upstream (Auth) does not make the whole replica unready: that would
turn an Auth outage into a release-service outage for CI and every client.

## 7. Outbox and audit

- **Backlog:** pending count and oldest pending age, from `release_outbox_snapshot` every 60 s and on demand
  (`nawara-check-outbox-lag`).
- **Relay failures:** `outbox_publish_failure` (kit), and `retrying` / `max_attempts` in the snapshot.
- **DLQ:** owned by audit-service (`audit-service.audit.dead`): refused release events land there, replayable. Alerting is P-A4. Release
  code has no broker-management dependency.
- **Delivery stays asynchronous.** No synchronous Audit or broker check anywhere, and the broker is not a readiness dependency.
- **Deploy order:** the catalog-aware audit-service first (runbook §9). Otherwise events are dead-lettered as `unknown_action`, and
  recoverable by replay.

## 8. Tests (focused; Full Core Validation NOT RUN)

| Suite | Command | Result |
|---|---|---|
| release-service unit. New: **client address (4)** (rightmost hop, spoofing, IPv6 /64, mapped IPv4) and **counters (3)** (fixed grid, junk labels dropped) | `npm test -w release-service` | 83 / 83 |
| release-service E2E, real PostgreSQL 16, runtime role. New: **hardening (9)**. Every 20.2–20.5 suite re-run unchanged | `npm run test:e2e -w release-service` | 199 / 199 |
| Cross-service release suites (CI → audit-service; the real Auth owner with real step-ups → audit-service) | `test:e2e -w @nawara/e2e-audit-producers -- release*.e2e-spec.ts` | 3 / 3 |
| Typecheck, lint (0 findings), build | | pass |
| Repository checks, and the check script's own tests | `check:repo`, `test:repo` | pass; 17 / 17 |
| Production image with production configuration (boot validation, non-root) | `docker build` + `scripts/smoke-core-image.sh release-service` | SMOKE PASSED |

**New hardening tests (9):**
- counters from real traffic, with closed labels and no identifiers in the lines;
- the startup surface line;
- the outbox backlog under a broker outage (commit, backlog visible, `/ready` 200, drains to 0);
- Auth down (automation and read OK, admin 503, `/ready` 200);
- limiter storage failure (500, never a decision, counted, recovers);
- public-input abuse (oversized keys and version, bracket query, bad percent-encoding, NUL, path traversal);
- `If-None-Match` forcing;
- Origin, cookie and identity header invariance with no CORS;
- `TRUST_PROXY` spoofing and IPv6 rotation;
- shutdown (loops stopped, final snapshots, prompt).

**Automation and owner-admin abuse** stays covered by the 20.3 (68) and 20.4 (47) suites, re-run:
- missing, wrong and human tokens;
- product scope;
- policy mismatch;
- malformed and oversized payloads;
- duplicate, conflicting and publication storms;
- spoofed identity headers;
- member, operator and wrong-Company owners;
- stale bearers;
- missing, wrong-purpose and replayed proofs;
- repeated and concurrent changes.

**Mutation check (14 mutants): all killed.**
- Authority: product authorization removed; owner check removed; step-up refusal ignored; Auth failure fails open.
- Decisions: a withdrawn release answered as supported; the minimum ignored.
- The limiter:
  - a spoofed (leftmost) proxy hop trusted;
  - IPv6 counted per address;
  - the public limit removed;
  - a limiter failure answered as a decision.
- Observability: an unbounded metric label accepted; the automation counters not fed.
- Atomicity and lifecycle: audit intent written after commit; the janitor not stopped at shutdown.

Every source was restored and hash-verified. Not mutated: "the broker made a synchronous dependency". No code path calls the broker or
audit-service during a request (structure; the kit relay is the only publisher), and the broker-outage test fails any such change, since
a mutation would then not commit.

**Not re-run:** Auth, audit-service and audit-contract. None of their code, and no catalog, changed in 20.6.

## 9. Production prerequisites (21.x)

| ID | Status | Why not application code | Required before production | Owner / system |
|---|---|---|---|---|
| P-R1 | OPEN | credential issuance lives in the CI secret store | per-pipeline caller, token and digest, rotation (two slots) | security / CI |
| P-R5 | OPEN | real ingress topology | TLS; `TRUST_PROXY` matching the real chain; `CORS_ORIGINS` or same-origin; WAF / volumetric limits; CDN under §5 conditions | infrastructure |
| P-R6 | OPEN (prepared) | a metrics platform and routing do not exist in Core | collect the snapshot lines; the thresholds of runbook §1; alert routing | operations |
| P-R7 | OPEN | deployment engineering | the §17.2 items; outbox and storage capacity planning (F21); backups of the `release` database | operations |
| P-A1 | OPEN | broker configuration | per-service broker users limited to owned routing keys | security / infrastructure |
| P-A4 | OPEN | alert routing | audit-service DLQ depth for refused release events | operations |
| P-A6 | OPEN | infrastructure | production RabbitMQ | infrastructure |
| P-S2 | OPEN | procedure | service-token rotation | security / operations |
| P-S3 | OPEN | network | Auth reachability and TLS for `AUTH_SERVICE_URL` | infrastructure |
| P-S5 | PARTIALLY PREPARED | collection | now includes the release snapshots | operations |
| (new, 21.x) | OPEN | provisioning | a production `RELEASE_RATE_LIMIT_KEY` (secret store; deploy-time rotation) and a production `RELEASE_OPERATING_COMPANY_ID` | security / operations |
| (Core-wide, 21.x quality audit) | OPEN | cross-service | F3 (proxy-aware keys in file-service's limiter and the kit's `TRUST_PROXY` semantics); F13 (unhandled-error log text) | Core |

## 10. Scope verification

**Not added:**
- no new lifecycle state, restoration or registered-only withdrawal;
- no channels, environments, deployment, artifacts, download URLs or updater;
- no configuration service, feature flags, maintenance mode, notifications or commercial enforcement;
- no analytics or user / device tracking;
- no generic admin service;
- no new authority: CI is still only `release.register` / `release.publish`; the owner is still only `release.withdraw` /
  `compatibility_policy.change`; operators have none.

**Unchanged:** no route, migration, Auth or audit-catalog change; API contracts unchanged.

**Not started:** Stage 20.7 and Stage 21. **Full Core Validation: NOT RUN.**
