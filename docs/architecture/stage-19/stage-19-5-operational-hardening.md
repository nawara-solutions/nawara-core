# Stage 19.5: Operational hardening

- **Status:** PASSED on `feat/platform-admin-operational-hardening` (awaiting review; not committed).
- **Base:** `main` @ `ed752ab` (Stages 19.1 to 19.4 merged; ADR-0050 Accepted).
- **Scope:** the runtime operation of the two Stage 19 capabilities, owner member suspension (Auth, 19.2) and Audit-X (Audit, 19.3).
  The Stage 19.4 security baseline is unchanged: redirects are never followed, Auth answers are capped at 16 KiB, the
  `AUTH_SERVICE_URL` shape rules hold, member responses are `no-store`, and every fail-closed path still fails closed.
- **Not done:** no new capability, service, database, identity protocol, readiness redefinition, caching of authority, or retry of
  authorization.

## 1. Findings

| # | Finding | Classification | Action |
|---|---|---|---|
| O1 | **H11:** owner-read refusals (401, 404) were counted as `error` | **19.5 FIX** | every refusal of the caller (401, 403, 404) is `denied` |
| O2 | An Auth failure and an unrecorded read were both `unavailable`; a slow Auth was indistinguishable from a broken one | **19.5 FIX** | owner-only outcomes `auth_timeout` and `auth_unavailable`; the 503 body carries the class (`code`), never Auth's address or answer |
| O3 | Each of the two Auth calls had its own timeout, so the worst case was 2 × `AUTH_TIMEOUT_MS`, which can exceed the 5 s HTTP drain | **19.5 FIX** | ONE budget per owner read (`AbortSignal.timeout(AUTH_TIMEOUT_MS)` shared by both calls) |
| O4 | There was no signal of Auth becoming slow | **19.5 FIX** | `owner_auth_count / _avg_ms / _max_ms` per snapshot (time spent on Auth per read, success or failure; no labels) |
| O5 | Unread Auth response bodies (401, 404, 5xx, 3xx) were not released, holding pooled sockets until garbage collection | **19.5 FIX** | `res.body.cancel()` on every answer that is not read |
| O6 | Nothing said whether Audit-X is on | **19.5 FIX** | startup line `audit_owner_access enabled auth_timeout_ms=… rate_per_owner=…` or `… disabled (AUTH_SERVICE_URL not set)`; never the URL |
| O7 | Auth had no operational signal for member suspension | **19.5 FIX** (the application side of P-S5) | `MemberSecurityCounters` and a 60 s `auth_member_security_snapshot` line: {suspend, restore} × {changed, unchanged, step_up_denied, target_refused, failed}. Closed labels; no id, reason or Company; not run by the operator CLI |
| O8 | Readiness: should Audit-X make Audit depend on Auth? | **NO ISSUE** | No Core service puts another service in its readiness (Audit: database, migrations, rabbitmq, audit-ingestion; Auth: database, migrations). Audit stays ready with Auth down, and the owner read fails closed per request. Tested |
| O9 | Liveness | **NO ISSUE** | `/health` is process-only; Stage 19 does not touch it |
| O10 | Client disconnect during an owner read | **ACCEPTED LIMITATION** | Express does not abort the handler. The work finishes, bounded by the Auth budget and the database statement timeout, and the self-audit may record a read whose response was never delivered (over-recording, never under-recording). No socket, client or promise leaks |
| O11 | Shutdown while waiting on Auth | **NO ISSUE** (bounded) | The wait is ≤ `AUTH_TIMEOUT_MS` (default 3000 < the 5000 drain). A request still running when the drain ends is cut: the read is read-only and its transaction rolls back. If `AUTH_TIMEOUT_MS` is set above `HTTP_DRAIN_TIMEOUT_MS`, such reads may be cut at shutdown (documented, safe) |
| O12 | Shutdown during a suspension | **NO ISSUE** | One database transaction: a process killed before COMMIT leaves nothing (state, sessions, local and central evidence all roll back); after COMMIT everything is durable. Reuses the Stage 15 drain and pool-closes-last evidence |
| O13 | Log storm with Auth down | **NO ISSUE** | one bounded `audit_query scope=owner caller=owner outcome=auth_unavailable code=…` warn line per request (no stack). Requests are bounded by the per-owner rate limit (default 30/min) × the number of owners |
| O14 | Limiter state | **NO ISSUE** | keyed by the verified owner, and only after verification; hashed; purged by the existing janitor (`audit_query_owner` is in its bucket list) |
| O15 | Retries | **NO ISSUE** | exactly one attempt per Auth question; a failure is a 503 and the client retries. No authority is cached |
| O16 | Outbox backlog of security evidence | **PRODUCTION PREREQUISITE** (P-A4) | the kit relay logs `outbox_publish_failure … name=audit.account.disabled … ageSeconds=…` once per poll during an outage (bounded); there is no backlog gauge. A Core-wide gauge is kit scope, not Stage 19 |
| O17 | Guard refusals (401, operator or member 403) on member-security routes are not counted | **ACCEPTED LIMITATION** | they are Auth-wide guard outcomes, not this capability's |

## 2. Operational model

**Audit-X outcomes (owner scope).** One counter per request, in `audit_query_snapshot` every 60 s:

| Outcome | Meaning |
|---|---|
| `owner_ok` | the read succeeded |
| `owner_denied` | refused: 401 bad bearer, 403 not an owner, 404 not an organization of the owner's Company |
| `owner_invalid` | bad request (400) |
| `owner_rate_limited` | the per-owner limit was reached (429) |
| `owner_auth_timeout` | Auth did not answer within the budget (503, `code: auth_timeout`) |
| `owner_auth_unavailable` | any other Auth failure: refused or reset connection, DNS, a 5xx or unexpected status, a redirect, a malformed or oversized answer (503, `code: auth_unavailable`) |
| `owner_unavailable` | the Audit database read or the self-audit failed, so nothing is returned (503, `code: accountability_unavailable`) |
| `owner_error` | anything unexpected |

Plus `owner_auth_count / _avg_ms / _max_ms`. The service scopes keep their six outcomes, and the owner-only outcomes never appear
for them.

**Member-security outcomes.** In `auth_member_security_snapshot` every 60 s (and at shutdown):

| Counter | Meaning |
|---|---|
| `suspend_changed`, `restore_changed` | the state changed |
| `suspend_unchanged`, `restore_unchanged` | already in that state; nothing written |
| `*_step_up_denied` | no valid factor step-up |
| `*_target_refused` | the collapsed 404 |
| `*_failed` | the transaction failed and nothing committed: database, outbox, local evidence or session revocation |

The per-operation evidence stays in `auth_audit_event` and the central trail. Metrics duplicate none of it.

**Dependency semantics for Audit-X:**
- one attempt, and one budget for both Auth calls;
- fail closed with a typed 503;
- recovers on the next request once Auth answers, with no restart and no cached authority;
- redirects are never followed and bodies are capped (19.4);
- unread bodies are released.

**The broker and the outbox for member security:** unchanged. The mutation and its outbox intent commit together. With RabbitMQ or
audit-service down, the intent waits and the relay publishes it once when they return. Re-proven by the 19.2 broker-outage test and
the cross-producer suite (14 / 14).

## 3. Alertable conditions (signals exist; thresholds and routing are P-A4 / P-S5)

| # | Condition | Signal | Suggested alert (qualitative) |
|---|---|---|---|
| 1 | Audit-X cannot reach Auth | `owner_auth_unavailable` rising | any sustained non-zero rate while `owner_ok` is 0 |
| 2 | Auth slowing | `owner_auth_avg_ms` / `_max_ms` trending toward `AUTH_TIMEOUT_MS`; `owner_auth_timeout` > 0 | a sustained rise, before timeouts dominate |
| 3 | Owner evidence reads not recorded | `owner_unavailable` > 0 | any occurrence (the accountability path failed) |
| 4 | Unexpected owner-read failures | `owner_error` > 0 | any occurrence |
| 5 | Member-suspension failures | `suspend_failed` / `restore_failed` > 0 | any occurrence |
| 6 | Unusual suspension volume | `suspend_changed` per window | above the deployment's normal baseline (possible compromised owner) |
| 7 | Suspension evidence delayed | `outbox_publish_failure … name=audit.account.disabled … ageSeconds` | age above the deployment's tolerance |
| 8 | Refusal spikes | `owner_denied`, `*_step_up_denied`, `*_target_refused` | a spike means probing or misconfiguration, not an outage |

## 4. Runbooks

**Owner Audit-X returns 503.** Read the response `code` (or the `audit_query … code=` line), then:

| `code` | Meaning and action |
|---|---|
| `auth_timeout` | Auth is slow. Check Auth's latency and `/ready`, and `owner_auth_avg_ms`. Do not raise `AUTH_TIMEOUT_MS` above the HTTP drain without accepting O11 |
| `auth_unavailable` | Auth is unreachable or misbehaving. Check Auth `/health` and `/ready`, the network path to `AUTH_SERVICE_URL`, and any proxy returning 3xx or HTML. Audit's own startup line confirms the capability is enabled |
| `accountability_unavailable` | Audit's database: check Audit `/ready` (database) and the privileges of `audit_app` (INSERT and SELECT on `audit_record`). Nothing was returned, by design |

Never bypass authorization, never read `audit_record` directly on an owner's behalf, and never disable the self-audit.

**Member suspend or restore fails:**
- **403:**
  - the step-up is missing, expired, for another purpose or session, or already used: obtain a fresh factor step-up for
    `account.suspend` / `account.restore`;
  - or the caller is not an owner.
- **404:** the target is intentionally opaque. It is not a member of this Company only: unknown, another Company, shared with another
  Company, or without an active membership here. Auth's local `auth_audit_event` (`denied`, `why`) tells operators which, and it is
  never shown to the caller.
- **5xx:** check `*_failed`, Auth `/ready` (database) and Auth's logs. The transaction rolled back, so retry after recovery.

Never set `isActive` in the database: that bypasses the step-up, the session revocation and the evidence.

**Suspension evidence is delayed.** The suspension is valid and in effect: the state and the session revocation are committed, and
so are the local `auth_audit_event` row and the durable outbox row. With the broker or audit-service down, the relay logs
`outbox_publish_failure … ageSeconds` and retries with backoff until publication (at least once; Audit deduplicates). Restore the
broker or audit-service; do not insert audit records by hand and do not fabricate events.

## 5. Deployment

**Order:**
1. Deploy **audit-service** with the 19.2 to 19.5 catalog: it must accept `account.disabled` with a `reason` and the owner actor of
   `platform_query.executed` before producers emit them (A50: Audit first).
2. Deploy **auth-service** (member security, counters).
3. **Enable Audit-X** by setting `AUTH_SERVICE_URL` on audit-service, then restart it. Check the `audit_owner_access enabled` line.

**Mixed versions (all fail closed):**
- **New Audit with an older Auth:** Audit-X needs only `GET /auth/grants` (Stage 10, ADR-0042) and `GET /auth/admin/organizations/:id`
  (older), so it works. An Auth without them answers 404 or 401, which is refused and never granted.
- **Old Audit with a new Auth:** Audit-X does not exist (the variable is ignored). Suspension evidence with a `reason` sent to a
  pre-19.2 Audit is dead-lettered and replayed after the upgrade (A50); it is never lost.
- **Audit-X enabled before Auth is reachable:** every owner read is `auth_unavailable` (503); the service reads are unaffected.

## 6. Production prerequisites

| # | Status | Reason |
|---|---|---|
| P-S1 operator step-up | **OPEN** | not built, and no operator security power exists |
| P-S2 service-token rotation | **OPEN** | a manual procedure; no rotation mechanism |
| P-S3 admin network reachability, TLS for `AUTH_SERVICE_URL` | **OPEN** | production topology |
| P-S4 privileged-account policy, forgotten-password gap | **OPEN** | policy |
| P-S5 monitoring of suspensions and owner evidence reads | **PARTIALLY PREPARED** | the application signals exist (§2, §3); collection, thresholds and alert routing do not |
| P-S6 `JWT_SECRET` rotation | **OPEN** | a single key, no ring |
| P-A1 to P-A8 | **carried unchanged** | P-A4 (alert routing) now also covers §3 and O16 |

## 7. Tests

| Suite | Result |
|---|---|
| Audit `owner-operational.e2e-spec.ts` (new) | 9 / 9 |
| Auth `member-security.e2e-spec.ts` (+ the counter test) | 33 / 33 |
| Auth E2E · unit | 370 / 370 · 119 / 119 |
| Audit E2E (includes 19.3 / 19.4 Audit-X) · unit | 415 / 415 · 225 / 225 |
| Cross-producer E2E (real Auth, Audit, RabbitMQ; includes the Audit-X and broker-outage paths) | 14 / 14 |
| Build, lint (Auth, Audit), `check:repo` | pass |

**What the new Audit spec proves:**
- **H11 classification:** refusals are `denied`, and a bad request is `invalid`.
- **Auth failures:** `auth_timeout` vs `auth_unavailable` for a hang, a 5xx and a malformed answer, and the 503 body names the class
  only.
- **One budget:** two 250 ms calls under a 400 ms budget time out within about the budget, never 2×.
- **Latency:** the latency aggregate appears.
- **Connection failures:** a refused connection and an unresolvable name (`.invalid`) are `auth_unavailable`, and `/health` stays 200.
- **Recovery:** Auth back means the next read succeeds, with no restart.
- **Audit database:** a failure is `unavailable`, and it recovers.
- **Log lines:** the snapshot and startup lines, with no address.
- **Readiness:** it never names Auth.

**The Auth test** proves each member-security outcome is counted (guard refusals excluded) and that the snapshot line carries no id,
reason or email.

**Mutation check (8 mutants), all killed:**
- H11 reverted;
- per-call timeouts;
- timeout not distinguished;
- Auth failures not their own class;
- no Auth latency;
- no startup line;
- member counters removed;
- step-up denial counted as a failure.

Sources restored and hash-verified.

**Reused evidence:**
- **Stage 15:** shutdown drain and pool ordering.
- **Stage 18:** relay backoff and broker recovery.
- **Stage 19.2 / 19.4:** outbox and database failure atomicity.

**Environment note:** the local RabbitMQ container needs `-setcookie` (the 19.4 host quirk).

## 8. Residual risks

- O10: over-recording on client disconnect.
- O16: no backlog gauge.
- O17: guard refusals are uncounted.
- Thresholds and routing are not defined (P-A4, P-S5).
- The 19.4 residuals (H7 to H12) are unchanged.
