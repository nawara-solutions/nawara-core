# Stage 21.C.3: Core V1 capability closure — focused certification

- **Status:** **PASSED — STAGE 21.C.3 FOCUSED CERTIFICATION COMPLETE** (on `feat/core-v1-capability-closure`, uncommitted, together with
  the Stage 21.C.2 implementation; awaiting review).
- **Certifies:** the exact Stage 21.C.2 implementation ([record](./stage-21-c-2-capability-closure-implementation.md)) against
  [ADR-0052](../../adr/0052-core-v1-capability-closure.md), [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md)
  (including Amendment 3), ADR-0039, ADR-0040, ADR-0046 and ADR-0049.
- **Infrastructure:** throwaway PostgreSQL 16 and RabbitMQ 3.13 (the CI images), removed afterwards.
- **Organization authority cutover: NOT PERFORMED. Full Core Validation: NOT RUN.**

## 1. Corrections made during certification

Only two, both directly necessary and neither a behaviour change.

| # | Severity | Evidence | Correction |
|---|---|---|---|
| C1 | low (contract documentation) | The generated OpenAPI documents omitted the new `403 operation_not_permitted` on 14 of the 20 service-token routes; the Billing issue and discard `403`s described another reason only | `@ApiResponse` decorators only. Afterwards Payment 5/5 and Billing 15/15 service routes declare it |
| C2 | low (documentation) | The integration guide said OpenAPI is at `GET /docs` (the services mount `GET /<service>/docs`), and gave the correlation-id format imprecisely | two sentences in the guide |

## 2. Architecture conformance

| Invariant | Evidence | Result |
|---|---|---|
| no new Core microservice | `apps/` unchanged; new code is inside the kit and existing services | ✅ |
| no central authorization service, no shared policy database | the policy is parsed from each service's own configuration | ✅ |
| no cross-service database access | the new modules hold no connection string; Organization is reached over HTTP only | ✅ |
| Auth → Payment authority: none | no Payment code or configuration in Auth's source; the credential is absent from Compose and `.env.example`; Payment's policy cannot express an admitted caller with no operation | ✅ |
| Billing V1 service callers: none | Compose `{"callers":{}}`, no token; all 15 routes refuse a service credential | ✅ |
| no Organization production bypass | the fixture is refused at configuration and construction (live-process test); no switch disables verification | ✅ |
| no product-owned Core Audit producer | `libs/audit-contract` unchanged | ✅ |
| Organization cutover | not performed (§12) | ✅ |

**Observation (low, 21.x):** Auth's production deploy script still writes an unused `PAYMENT_SERVICE_URL` and a freshly random
`PAYMENT_SERVICE_TOKEN` into Auth's environment. Auth reads neither, and the random token is registered nowhere, so it carries no
authority. This is the already-tracked O7 stale-variable item; it is not changed here.

## 3. Caller policy (kit)

- **Startup refusal:** 34 rejected configurations were started as the BUILT Payment and Billing processes (17 each). All 34 refused to
  start, each for the right rule (the captured `ConfigError` names it). The classes:
  - no policy while a token exists; a token without an entry; an entry without a token;
  - an unknown key (with a canary name, and with a token-shaped name);
  - a duplicate JSON key; a duplicate operation; an empty operation list;
  - wildcard operation and platform;
  - malformed JSON carrying the raw token; a non-canonical caller name; malformed `SERVICE_TOKENS` carrying the raw token;
  - production + fixture (with and without a real reference); a short reference token.
- **No leakage:** the stdout and stderr of all 34 contained no canary token, digest, canary value, canary property name,
  `Authorization` value or raw policy JSON. The unknown-property-name case fixed in 21.C.2 is regression-tested with a token-shaped key.
- **Valid empty policy:** Billing's `{"callers":{}}` with no token starts. A valid configured caller holds exactly its operations.

## 4. Payment

- **Independent route inventory:** 6 routes, 5 reachable with a service token, all guarded, none missing:
  - create (`payment.create`), get (`payment.read`), cancel (`payment.cancel`);
  - attempt start and sync (services refused);
  - the webhook route is provider-authenticated.
- **The matrix is proved on real PostgreSQL:**
  - billing-service is allowed its three operations;
  - auth-service gets 401 everywhere (not registered);
  - another registered service gets 403; an unknown or malformed token gets 401;
  - human bearer: 401 on service-only routes, and the payer rule is unchanged.
- **Organization:** in-scope creates succeed. Every failure writes **no payment row and no outbox row**, proved by row counts:
  - an out-of-scope or nonexistent Organization: `403`, one message;
  - `409`, 5xx, timeout, redirect, malformed or oversized answers: `503`;
  - forged caller or Organization headers: ignored.
- **Memo (new certification spec):** an Organization memoized for a P1 caller is refused to a P2 caller, answered from the memo with no
  new lookup; nothing is written; a nonexistent Organization never becomes a memo entry.

## 5. Billing

- **Independent inventory:** 15 service-token routes, each naming an explicit operation.
- **Admitted Core V1 service callers: NONE.** All 15 refuse a service credential, and the payer's route still works.
- **Organization:** with a test-only policy, product and invoice creates and the entitlement read fail closed (`403` / `503`), with
  **no mutation** (product, price, invoice and outbox counts). Reads of the caller's own records make no call.

## 6. Organization reference client

- **Hardening:** deadline 2 s by default (bounded 100 to 10 000); redirects refused; body capped at 4 KiB, under the deadline; unread
  bodies released; strict shape; every non-answer is `503` with a reason class; no credential, URL or dependency body in any output.
- **Adoption:** Payment and Billing both use the same kit client through their `CallerAdmissionModule`.
- **Memo:** positive answers only, process-local, bounded (least recently used evicted), empty after a restart. Not an authority: the
  scope check runs on every request.
- **Production fixture:** startup refused for both services (live processes), and refused by the constructor (unit).

## 7. Auth outbox

- **Independent inventory:** the twelve event names come from eleven `emit` sites in eight services. Nothing uses a legacy publisher:
  a source and configuration search for the old classes, symbols, exchange constant, failure log or library returns **nothing**. The
  audit outbox path remains.
- **Atomicity:**
  - commit: the contact-code, confirmation-code, operator-code and registration events are proved in their real transactions;
  - rollback: a refused operator creation leaves no event and no user; a thrown transaction after `issueConfirmation` leaves no row and
    nothing on the bus.
- **Broker outage (real broker, live processes):** the request takes 40–48 ms; the row stays pending; after recovery Notification
  records it once, 853–1 073 ms later (3 runs).
- **Crash after commit** (SIGKILL, restart on the same database): delivered once in 1.65–1.69 s (3 runs). A re-publication of the same
  event id is absorbed (`notification_duplicate`).
- **`AUTH_EVENTS`** (live processes):
  - a row committed while on is relayed after the switch to off;
  - while off, no domain-event row is written (the change and its audit evidence still happen);
  - on again replays nothing, and new rows appear normally;
  - no logical duplicate (no `sourceEventId` counted twice).

## 8. Sensitive codes

- **Event names verified in source:** `member.contact_verification_requested`, `admin.operator_code_issued`,
  `admin.operator_confirmation_code_issued`.
- **Canary scan (full capture of both live processes, not a tail):** three canary codes plus the real codes generated in the run. None
  appears in:
  - Auth's or Notification's logs, or error output;
  - the DLQ tool's output, or the outbox-lag tool's output;
  - Auth's audit outbox rows or `auth_audit_event`;
  - Notification's plain columns (the code is sealed).
  Core has no metrics platform; the purge reports counts only.
- **DLQ tool:** `nawara-dlq list` prints `code=redacted` while `channel=fax` and `userId=…` stay readable. Otherwise its behaviour is
  unchanged: the integration test's ordinary field and a non-secret-named field are still shown.
- **Purge:**
  - published rows are deleted, and expired unpublished rows are deleted;
  - unexpired pending rows, other events and audit rows are kept;
  - at most 200 rows per statement and at most 10 statements per pass;
  - it skips a row held by another transaction;
  - run concurrently with the relay over 300 unexpired code rows, every row was published exactly once before being purged.

## 9. Migration 0011

Measured at **1 000 085 rows** (1 000 000 audit rows):

| Case | Plan | Time |
|---|---|---|
| without 0011 | Seq Scan, 1 000 035 rows filtered | 111 ms per pass, growing with the audit history |
| with 0011 | Index Scan on `outbox_code_event_purge_idx` | 0.091 ms |
| outage backlog, +100 000 pending code rows | Index Scan (bounded by the backlog) | 72 ms |

- **Change:** partial index only, expand-only, no data statement.
- **Safe with existing rows:** applying it over 1 000 085 existing rows, and its down migration, leave the table content digest
  unchanged.
- **Correct without the index:** the purge deletes the same rows with or without it.
- **Down migration:** removes only that index.

## 10. JSONB key order

- **Unchanged:** routing key, event type, field names, values, headers and the message-id semantics (asserted on a real broker).
- **Consumer:** the kit consumer `JSON.parse`s the body, and Notification validates by field name (`field in payload`); nothing
  compares serialized strings.
- **Documents:** no document guarantees property order.

**Classification: NON-BREAKING REPRESENTATION DIFFERENCE.**

## 11. WP-G and ADR-0040

- **Decision 2's text names the first-touch flows:** the first join code or invitation for an organization, the first assignment on a
  platform, and the bootstrap flow. **Architectural first-touch flows = 4**, and the implementation has exactly those.
  - Operator creation references an already-cached Company.
  - Join and consume are forbidden to call Organization Service.
- **Zero-call paths (new certification):** in authoritative mode with Organization Service answering 503, these all succeed with
  their existing results and make **zero** calls:
  - resolve, register, login, `/auth/me`, the member access check;
  - join, refresh, invitation resolve, invitation consume, logout.
- **`ensure`:**
  - parents first; repeated calls are safe;
  - an anchor mismatch fails closed, alerts, and overwrites nothing;
  - an outage or a missing parent invents no hierarchy;
  - a frozen hierarchy refuses the reference write.
- **Write guard:**
  - the local default keeps today's behaviour (the full Auth e2e suite);
  - the Organization source blocks the bootstrap's Company insert;
  - only the protocol may open the gate (the repository rule, proved by a mutant);
  - a source/marker disagreement is logged (`hierarchy_source_mismatch`).
- **Export/import:**
  - digest equality;
  - a tampered snapshot refused;
  - the freeze and final import;
  - rollback before activation;
  - the fresh bootstrap through the real read route.
  Nothing is activated.

## 12. Cutover invariant

- Auth's hierarchy source defaults to `local`; no Compose, deploy or CI file sets it or an Auth Organization credential.
- organization-service is unchanged.
- Nothing outside tests invokes `activate`, `retire` or `hierarchy-retire`; the tests only activate throwaway databases.
- No production credential, role or configuration was touched.

**Organization authority cutover: NOT PERFORMED.**

## 13. Integration guide

- **Checked against the source:** every route it names exists as written.
- **No false claims:** no Tauri claim; Desktop is not Web; product Audit writes are not in V1 (post-V1, not impossible); Payment is not
  entitlement; Organization has no commercial authority; Auth does not call Payment; the cutover is not complete.
- **Corrected:** C2.
- **Links:** all 66 relative links in the changed documents resolve.

## 14. Cross-service test adaptations

The eight adapted suites use a TEST-ONLY policy and a stand-in for the reference read, through the real HTTP client (not the fixture),
with `NODE_ENV=test`.
- The helpers live in private test workspaces that no production code imports and no Dockerfile copies.
- The production rule (a policy is required, no fixture) is untouched.

## 15. Flakes

| Item | Evidence | Classification |
|---|---|---|
| **S21-7** Notification fairness | failed on PR #139's CI; reproduced locally in 1 of 5 runs; Notification is unchanged by 21.C.2 | **pre-existing, PRE-STAGE-22 BLOCKER** (not disabled) |
| **S21C2-1** Release limiter-key test | `apps/release-service/test/compatibility.e2e-spec.ts` scans stored rows, which include a random 64-character hex key, for `/ffff/` (meant for `::ffff:` addresses); about 0.09% per row; release-service unchanged | **unrelated; 21.R1/R2 stabilization**. Fix: match `::ffff:` or exclude the key |
| **S21C3-1** File S3 client-abort timing (found in PR #140's CI) | `apps/file-service/test/download-s3.e2e-spec.ts:134` expects under 50% of the 8 MiB object read after a client abort; CI read about 51.6% (4 332 616 bytes) on a slower shared runner, while 313 other tests passed; locally 8 of 8 pass on CI's S3 gateway (`versitygw v1.8.0`); no Stage 21.C change to file-service. The PostgreSQL permission-denied lines in that job are the intended least-privilege tests (they passed) | **unrelated; 21.R1/R2 stabilization** (not changed in PR #140) |
| Auth outbox durability timing | isolated 5×, suite group 2×, full parallel Auth e2e 2×, 9/9 green. Stall test 1.52–1.62 s and connection-lost test 3.00–3.08 s, against windows of 90 s (formerly 15 s and 40 s). The single 21.C.2 failure hit the old windows exactly and never recurred | **B/C: environment and test synchronization, not an implementation race** (§15.1) |

### 15.1 Why the old windows could be exceeded

A frozen (silent) broker during connection or channel setup is detected only by the AMQP heartbeat: about 3 × 10 s by default (kit
Stage 15.3). Add the relay's 15 s backoff ceiling, and delivery after recovery can legitimately take about 45 s. That is more than the
old 15 s window and less than the current 90 s. No loss or duplicate was ever observed: the only symptom was delay, and the Auth request
was never affected.

## 16. Mutations

- **Campaign:** 31 targeted mutants; **30 killed**.
- **The survivor is equivalent, not a gap:** D6 as first written (a memoized `null` is never served). Its behaviour-changing form, D6b,
  is killed. Every mutated file was restored byte-identically (checksums verified).

| Area | Mutants (all killed) |
|---|---|
| caller policy | default allow for a missing caller or a route without an operation; unregistered caller accepted; registered caller without an entry ignored; wrong operation accepted; a value echoed; an unknown property name echoed; duplicate JSON key accepted |
| Organization | verification bypassed; outage fails open; nonexistent accepted; Billing platform scope skipped; memoized Organization skips the scope check; fixture enabled in production; negative answer memoized and served; entitlement read without resolution |
| Auth hierarchy | bootstrap creates a Company; first touch skipped; anchor mismatch accepted; reference-write gate opened outside the protocol (repository rule) |
| Auth outbox | outbox write removed; event outside the transaction; relay stopped by `AUTH_EVENTS=off`; a new event id minted by the relay; a second emission path; expired rows never cleaned; the purge deleting unrelated rows; the purge deleting nothing; the DLQ tool printing a secret field; Notification de-duplication bypassed (cross-process) |

## 17. Build and checks

Final counts are in the Stage 21.C.3 report. In short:
- the clean build succeeds from a fresh copy;
- typecheck is clean; lint has no new findings;
- repository checks pass;
- OpenAPI declares the new responses;
- all links resolve.
