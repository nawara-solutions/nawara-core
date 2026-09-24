# Stage 16.10 — Notification V1 focused certification and closure

- **Status:** PASSED on `test/notification-focused-certification` (awaiting review).
- **Scope:** Notification only. This is the Notification-specific focused certification of Stage 16; it is **not** the final Core
  production validation (Stage 22), which stays reserved until the remaining shared services, Shared Services Integration, the Core
  Quality / API audit (21.R1) and the controlled refactor (21.R2) are done. No Stage 15.9 campaign was rerun.
- **Method:** reuse the evidence of Stages 16.2–16.9 where a suite already proves an invariant in the final code; add integrated proof
  only where components had not been exercised together; rerun everything once in the final integrated state.
- **Outcome:** Notification V1 implementation and focused Core certification complete. Production enablement remains subject to the
  documented external / owner prerequisites (§7).

## 1. Baseline

`main` at `f49bf0f` (Stage 16.9 merged). Before this stage: unit 311, Notification E2E 292, real-broker package 13. Documents read:
the SDD, ADR-0046 / 0047 / 0019, the Stage 16.1–16.9 records, production readiness and the runbooks.

## 2. New integrated evidence

`test/certification.e2e-spec.ts` (11 tests) runs **one application wired exactly as production**: the real kit RabbitMQ consumer on
`notification.events`, the service-token send API with two callers and their policies, the delivery engine with the **real Resend and
Twilio adapters selected by configuration** (talking to a local stand-in of both APIs), the destination limiter, on a real PostgreSQL:

| Flow | Proven |
|---|---|
| API → EMAIL | token, policy, `Idempotency-Key` replay = same intent (one delivery), changed body = 422; code sealed (not in `data`, not in the ciphertext bytes); Resend request with the configured sender and `Idempotency-Key: nawara-notification/<id>/0`; `SENT`, attempt `ACCEPTED`, secret purged; the status view holds no destination, code, provider id, key metadata or hash |
| API → SMS | E.164 accepted and sent through Twilio (`To`, `MessagingServiceSid`, body with the code); `98765440`, `21698765440`, `0021698765440`, `+216 98 765 440` refused `422 invalid_destination`; no `+216` ever added |
| Rabbit → EMAIL | Auth-shaped envelope → intent → Resend → `SENT`; the queue drains (acknowledged after commit); the same envelope again → no new intent, no second send, nothing dead-lettered |
| Rabbit → SMS | canonical E.164 → Twilio → `SENT`; a non-canonical Auth phone → `FAILED invalid_destination`, attempts 0, never sent (D20) |
| Locale EN / FR / AR | `fr-TN` → `fr` (French accents byte-exact at Resend), `ar` → `ar` (Arabic byte-exact at Twilio), `de` → `en` (default) |
| Arabic SMS too long | `FAILED content_too_long`, attempts 0, never truncated, never sent |
| Destination limiter | one channel-specific bucket across callers and templates (4 hits: 3 `SENT`, 1 `rate_limited`); SMS has its own bucket; stored keys are neither a plain SHA-256 of the destination nor of any obvious form |
| Lease fencing across instances | a stale claim recovered and **re-claimed by another instance** (`SENDING` again): the stale worker can neither start an attempt nor call the provider (`lease_lost`); the owner sends once |
| Restart with mixed work | pending sent by the new instance; scheduled not before its time; retrying not before its backoff; each then `SENT`; intent count unchanged; no duplicate attempt |
| Authority and isolation | `from`, `sender`, `provider`, `messagingServiceSid`, `body`, `bodyText`, `subject`, `templateVersion`, `version`, `ownerScope` → 400; a template, channel or organization outside the caller policy → 403; another caller's GET / cancel → 404 (also with a spoofed `x-caller` header) |
| Final leak scan | codes, destinations, provider error bodies with personal data, Resend key, Twilio key SID and secret, both service tokens, the secret, request-hash and limiter keys, rendered FR / AR text: 0 in all logs; in the database only where frozen (destinations in `notification_delivery.destination`, template text in `notification_template_version`) |

## 3. Certification matrix

| Requirement | Owner stage | Evidence | Result |
|---|---|---|---|
| Event intake (envelope, map, dedupe, ack after commit) | 16.2 / 16.5 | `event-intake-broker` (9), `intake` (10), real-broker Auth → Notification (4); certification Rabbit flows | PASS — new integrated evidence |
| API intake (auth, policy, validation, bounds) | 16.6 | `send-api` (32), `foundation` (18); certification API flows | PASS — new integrated evidence |
| API idempotency (replay, changed body 422, concurrency, restart) | 16.6 | `send-api`; certification API → EMAIL | PASS — new integrated evidence |
| Event idempotency (duplicates, 12 concurrent, crash window, restart replay) | 16.5 | `intake`, `event-intake-broker`; certification Rabbit → EMAIL | PASS — new integrated evidence |
| Templates, pinning | 16.4 / 16.5 / 16.7 | `persistence`, `migrations`, `intake`, `send-api`, `delivery-engine` (v1 / v2) | PASS — existing evidence reused |
| Locale (exact → base → default), EN / FR / AR through adapters | 16.5 / 16.8 | `intake`; `provider-adapters` (Arabic); certification locale | PASS — new integrated evidence |
| EMAIL (Resend) | 16.8 | `providers.spec` (adapter contract), `provider-adapters`; certification | PASS — new integrated evidence |
| SMS (Twilio), strict E.164, no country guessed | 16.5 / 16.6 / 16.8 | `send-api`, `providers.spec`, real-broker D20; certification | PASS — new integrated evidence |
| Scheduling | 16.6 / 16.7 | `send-api`, `delivery-engine`; certification restart | PASS |
| Cancellation (PENDING; claimed → 409 → pre-send → `CANCELLED`, 0 calls) | 16.6 / 16.7 | `send-api`, `delivery-engine` C2 | PASS — existing evidence reused |
| Expiry (before claim; between claim and send; during retry) | 16.7 | `delivery-engine` | PASS — existing evidence reused |
| Retry, Retry-After, exhaustion | 16.7 / 16.8 | `delivery-engine`, `provider-adapters` (429 + `Retry-After`) | PASS — existing evidence reused |
| Permanent failures (invalid destination, unsubscribed, too long, rejected) | 16.8 | `providers.spec` (21211 / 21610 / 21612 / 21614 / 21617, 4xx), `provider-adapters`; certification Arabic | PASS |
| Provider auth / config fault (alerted, bounded) | 16.8 / 16.9 | `provider-adapters`, `security-operations` (backoff bound) | PASS — existing evidence reused |
| Ambiguity (timeout, reset, 502 / 504, invalid 2xx) → `UNCONFIRMED` | 16.7 / 16.8 | `delivery-engine`, `providers.spec`, `provider-adapters` | PASS — existing evidence reused |
| OTP ambiguity: one resend, same code; Resend key stable; Twilio has no key | 16.7 / 16.8 | `delivery-engine`, `provider-adapters` | PASS — existing evidence reused |
| Crash windows A–F, result-loss window, stale recovery | 16.7 | `delivery-engine` | PASS — existing evidence reused |
| Lease fencing | 16.7 | `delivery-engine`; **certification (re-claimed by another instance)** | PASS — new integrated evidence (see §6 C6) |
| Worker concurrency, SKIP LOCKED, bounded concurrency, no open transaction during a call | 16.7 | `delivery-engine` | PASS — existing evidence reused |
| Secret encryption and purge (every terminal state, concurrent-finish race, purge loop) | 16.5 / 16.7 | `intake`, `send-api`, `delivery-engine`; certification API → EMAIL | PASS |
| Encryption-key lifecycle and retirement tool | 16.9 | `security-operations`; production image (CLI as runtime role) | PASS — existing evidence reused |
| Destination limiter (D21): shared bucket, channel split, concurrency, privacy, rotation, fail closed | 16.9 | `security-operations`; certification | PASS — new integrated evidence |
| Request-hash rotation (previous key, removal → 422, never a second intent) | 16.9 | `security-operations` | PASS — existing evidence reused |
| Provider credentials (startup validation, never echoed, `*_FILE`) | 16.8 / 16.9 | `notification-config.spec`, production image | PASS |
| Readiness (DB, migrations, RabbitMQ; provider outage not readiness) | 16.3–16.5 / 16.9 | `foundation`, `health`, `event-intake-broker`, `security-operations`, image | PASS — existing evidence reused |
| Database outage (API, Rabbit intake, worker, retention) | 16.5–16.9 | `send-api`, `event-intake-broker`, `delivery-engine`, `security-operations` | PASS — existing evidence reused |
| RabbitMQ outage (not ready; API still durable; reconnect) | 16.5 / 16.6 | `event-intake-broker`, `send-api` | PASS — existing evidence reused |
| Restart | 16.5–16.7 | `event-intake-broker`, `send-api`, `delivery-engine`; certification mixed restart | PASS — new integrated evidence |
| Shutdown (HTTP drain, intake drain, bounded provider call, DB last, exit 0) | 16.3–16.8 | `foundation`, `event-intake-broker`, `send-api`, `delivery-engine`, `provider-adapters`, `process`; production image | PASS — existing evidence reused |
| Operational signals, snapshot, alert rules, runbooks | 16.9 | `security-operations`; production image; [runbooks](../../runbooks/notification-service.md) | PASS |
| Retention (limiter state; the materialized-CTE batch fix) | 16.9 | `security-operations` (bounded batch regression) ; image (1 200 rows as runtime role) | PASS — existing evidence reused |
| PII / log safety | 16.3–16.9 | every suite's leak scan; certification final scan; image logs and `pg_dump` | PASS — new integrated evidence |
| DB privileges (runtime DML only, no DDL, migrator-only migrations) | 16.4 | `runtime-role`; image (migrate as runtime → exit 1, DDL → permission denied) | PASS |
| Migrations (fresh, re-run no-op, no pending) | 16.4 | `migrations`; image (5 applied, then 0 applied / 5 already) | PASS |
| Production configuration refusals | 16.8 / 16.9 | `notification-config.spec` (71), image | PASS |
| Real-provider sandbox smoke | 16.8 | — | PENDING EXTERNAL — credentials not supplied |
| Live provider latency | 16.8 | — | PENDING EXTERNAL — credentials not supplied |
| History retention (D10) | 16.9 | — | PENDING OWNER |
| Push, preferences, attachments, IN_APP delivery | — | — | DEFERRED — accepted scope |

## 4. Production image

Built from the repository Dockerfile and run with throwaway PostgreSQL (the init roles) and RabbitMQ:
- migrations: 5 applied as the migrator; a re-run applies 0 (5 already); as the runtime role the migrator exits 1; runtime DDL →
  `permission denied for schema public`;
- image: `USER node`, environment only `PATH`, `NODE_VERSION`, `YARN_VERSION`, `NODE_ENV=production`; no secret in the layer history;
  no provider SDK or development package (`twilio`, `resend`, `@sendgrid`, `nodemailer`, `vitest`, `typescript`, `@nestjs/cli`,
  `supertest`, `ts-node`) in the runtime `node_modules`; 228 MB;
- refused in production (never echoing a value): the test provider, Resend without a key, a malformed Twilio SID, a plain-http provider
  URL, a provider without the limiter key, the published development request-hash key, a patterned limiter key, the limiter key equal
  to the request-hash key;
- a valid production configuration: uid 1000, Node as PID 1, `/ready` 200, retention of 1 200 expired limiter rows and the operator
  CLI as the runtime role (`retire-check` of the active key exits 3), stop 60 ms, exit 0;
- development against the stand-in: a code sent by Resend, SMS provider unreachable → `PENDING provider_unreachable` with `/ready`
  200, stop during a hung call 1.5 s, exit 0, `UNCONFIRMED provider_timeout`; 0 leaks in logs and `pg_dump`.

**Dependency audit:** runtime dependencies are `@nawara/service-kit`, `@nestjs/{common,core,platform-express,swagger}`, `amqplib`,
and the NestJS peer set (`class-transformer`, `class-validator`, `reflect-metadata`, `rxjs`, used through Nest and the kit, as in every
Core service). No provider SDK (16.8 decision), no duplicate or unexpected package.

## 5. Test results (final integrated state)

Unit 311 (7 files) · Notification E2E 303 (13 files, including `certification` 11) · real-broker package 13 / 13 · `check:repo` ·
`test:repo` 16 · typecheck · lint (3 pre-existing warnings) · build · `git diff --check`: all green.

The first real-broker run was interrupted when the local development PostgreSQL container was removed from outside the session
(Docker events: `kill` / `destroy`, its data volume intact); nothing in the repository or this stage removes it. The package was rerun
unchanged against a throwaway PostgreSQL (removed afterwards, with its volume): 6 files, 13 / 13 passed. The local development stack was
left as found.

## 6. Final cross-boundary mutations

Each applied, the affected suites run, then restored; `sha256sum -c` confirmed all five files byte-identical (including the rebuilt kit
`dist` for C1).

| Mutation | Result |
|---|---|
| C1 the kit consumer acknowledges before the handler commits | 7 broker tests fail (crash window, database lost, poison, restart replay, shutdown, reconnect) |
| C2 an engine timeout classified retryable | 4 fail (engine and real-adapter timeout, shutdown during a hang) |
| C3 the destination limiter bypassed | 6 fail (certification limiter, 16.9 limiter suite) |
| C4 key reuse across purposes allowed | the purpose-separation configuration test fails |
| C5 a provider check added to readiness | the provider-outage readiness test fails |
| C6 lease fencing removed | **initially survived**: the existing tests were also protected by the status and attempt guards. The certification added the one case only the lease token protects (a stale worker vs a claim re-claimed by another instance); rerun, C6 is killed |
| C7 secret purge disabled | 12+ fail (certification API → EMAIL, every purge assertion) |

## 7. External and owner prerequisites (not certified here; production enablement)

| Item | Owner | Classification |
|---|---|---|
| Auth stores canonical E.164 (new contacts; inventory and deliberate migration of existing ones; never `+216` by default) | Auth | PRODUCTION PREREQUISITE (SMS for Auth users) |
| D19 Auth outbox (an event lost between Auth's commit and the broker confirm) | Auth | ACCEPTED RESIDUAL RISK (ADR-0046 §17) |
| D10 notification-history retention durations | owner / legal | PENDING OWNER |
| Resend cost at volume, data-processing agreement, sending region | owner / legal | PENDING OWNER |
| Tunisia / MENA deliverability pilot (AR, FR, EN) | owner | PENDING OWNER |
| Resend domain verification, SPF, DKIM, DMARC decision | operations | PENDING EXTERNAL |
| Twilio account, Messaging Service, sender registration where required, geo permissions | operations | PENDING EXTERNAL |
| Provider sandbox / live smoke and live latency (the 10 s timeout / 60 s lease re-check) | operations | PENDING EXTERNAL — credentials not supplied |
| Log-based alert routing (runbooks §1) | platform | PENDING EXTERNAL |
| Production secrets generated and stored; producer policies and tokens | operations | PENDING EXTERNAL |

External provider sandbox smoke: **PENDING — credentials not supplied.** Live provider latency: **PENDING — credentials not supplied.**
These do not invalidate the Notification V1 focused certification.

## 8. Accepted residual risks

- **External delivery is at-least-once with best-effort deduplication, never exactly once.** A lost answer for a one-time code can send
  it twice (once more at most; Resend deduplicates within 24 h with an identical payload); for anything else it ends `UNCONFIRMED`.
- **D19:** Auth events are not transactional (ADR-0046 §17).
- **Codes on the broker / DLQ** until consumed or replayed; an expired replay is never sent (SDD §13.1).
- **Configuration faults** (bad credentials) exhaust the attempt budget of the deliveries due meanwhile (about 7.5 min at the defaults);
  alerted as errors.
- **A provider accepting and later failing delivery** is invisible (no delivery-status webhooks in V1).

## 9. Defects found

- **None in production code.** One **test gap** was found by mutation C6 and closed with a regression (lease fencing across instances).
  Stage 16.9's batch-bound defect (the materialized-CTE fix) stays covered by its regression.
- **Documentation:** the Core architecture overview and the root README still described Notification as a starter / "no worker, no
  provider"; corrected to the implemented state (documentation-only, no behaviour change).

## 10. Carryovers

- **Later Core stages:** the whole-Core API / quality observations belong to 21.R1 / 21.R2 (for example the `/notification/notifications`
  route prefix and Core-wide error / DTO conventions); unchanged here by design.
- **Kept visible:** Auth E.164, D19, D10, Resend cost / DPA / MENA pilot, provider sandbox and live latency, alert routing, and
  **File Service attachments (Stage 17)**. None is resolved by closing Stage 16.
- **Stage 22** remains the single final Core production validation; Stage 16.10 does not replace it.

## 11. Decision

**STAGE 16.10 PASSED — NOTIFICATION V1 FOCUSED CERTIFICATION PASSED — STAGE 16 (NOTIFICATION SERVICE) CLOSED.**
Notification V1 implementation and focused Core certification are complete. Production enablement remains subject to the documented
external / owner prerequisites (§7), which do not invalidate this certification.
