# Stage 19.4: Security & privacy hardening

- **Status:** PASSED on `feat/security-privacy-hardening` (awaiting review; not committed).
- **Base:** `main` @ `97aac08` (Stages 19.1, 19.2 and 19.3 merged; ADR-0050 Accepted).
- **Scope:** an adversarial review of the Stage 19.2 surface (owner member suspension) and the Stage 19.3 surface (Audit-X), and five
  narrow fixes inside the accepted architecture.
- **Not done:** no new feature, service, database, migration, identity protocol or contract change.

## 1. Threat model reviewed

**19.2 surfaces, member suspension and restoration:**
- **Authentication:** stolen, expired or revoked bearer; disabled owner; tier mismatch; forged kind or actor headers.
- **Step-up:** missing, expired, wrong purpose, another session, replayed, concurrent reuse, malformed, secret-key, no-op
  consumption.
- **Targets:** arbitrary id, owner, operator, self, a member without an active same-Company membership, a member active or pending
  elsewhere, rejected or revoked elsewhere, several same-Company organizations.
- **Races:** suspend vs restore, and membership inserts.
- **Other:** restoration safety, reachability through other routes, mass abuse, error oracles, reason privacy, atomicity, session
  effect across Core.

**19.3 surfaces, Audit-X:**
- **Identity:** the human, the service token, member and operator bearers, revocation.
- **Auth failures:** outage, timeout, malformed answers, the wrong user or organization, unexpected 2xx, redirects, oversized and slow
  answers, reset connections.
- **Scope:** cross-Company access, null-organization evidence, request injection.
- **The bearer:** the `AUTH_SERVICE_URL` / SSRF boundary and bearer forwarding.
- **Queries:** TOCTOU, cursors, the rate limit, self-audit, service-read accountability, result minimization, the filter oracle.
- **Operations:** logs, metrics, configuration, route exposure, caching, CSRF.

## 2. Findings

| # | Finding | Severity | Evidence | Classification | Action |
|---|---|---|---|---|---|
| H1 | Audit-X's Auth client followed **same-origin** redirects with the bearer, and accepted the redirected answer as Auth's answer. Node 24 `fetch` strips `Authorization` on cross-origin redirects (verified empirically) but keeps it on same-origin ones | Low (needs a misbehaving Auth) | `owner-authority.client.ts` (default `redirect: 'follow'`) | **FIXED IN 19.4** | `redirect: 'manual'`, and only a 200 is an answer. A 3xx fails closed (503); nothing follows it |
| H2 | Auth's answer was buffered without a size bound | Low | `res.json()` | **FIXED IN 19.4** | read up to 16 KiB (`MAX_AUTH_RESPONSE_BYTES`) under the request timeout; above that, 503 |
| H3 | `AUTH_SERVICE_URL` accepted embedded credentials, a query or a fragment, which would change what or where the bearer is sent | Low | `reader.url` checks the protocol only | **FIXED IN 19.4** | refused at startup, without echoing the value |
| H4 | Member-security responses carried no `Cache-Control` | Info | Auth sets no cache headers | **FIXED IN 19.4** | `no-store` on both routes |
| H5 | A service platform read narrowed to one organization recorded `target: organization` but not *which* organization | Low (accountability) | `recordPlatformQuery` | **FIXED IN 19.4** | records `changes.organization_id` (the existing optional field; no new action or version) |
| H6 | An empty `AUTH_SERVICE_URL` is treated as unset (the kit reader), so owner access is **disabled**, not refused. The Stage 19.3 record said an empty value would be refused; it is not | Info | the config test pins it | **NO ISSUE** (safe: never half-configured) | documented here; the 19.3 record is kept as history |
| H7 | A 404 on suspending a member the owner can see in their own organizations reveals one bit: that member also has an active or pending membership under *some* other Company (never which) | Info | the inherent consequence of D5 | **ACCEPTED LIMITATION** | a refusal must exist; answering 200 would be false |
| H8 | File access tickets issued before a suspension stay valid until expiry (60–300 s) | Low | ADR-0048 F16; tickets carry no user token | **ACCEPTED LIMITATION** | bounded by the ticket TTL |
| H9 | The kit `HttpAuthClient` (Billing, Payment) and organization-service's grants client also follow same-origin redirects | Low | same default `fetch` | **FUTURE ARCHITECTURE** (outside the Stage 19 surface) | candidate for a kit-wide HTTP hardening |
| H10 | Auth sets no `Cache-Control` on any response, token endpoints included | Low | repository-wide | **PRODUCTION PREREQUISITE** (repository-wide, not Stage 19) | recorded |
| H11 | The owner-read counters classify 401 and 404 as `error`, not `denied` | Info (operations) | `measured()` outcome mapping | **19.5 OPERATIONAL** | recorded |
| H12 | `AUTH_SERVICE_URL` may be `http:` in production: the bearer crosses the internal network in cleartext | Low | same policy as every Core service URL | **PRODUCTION PREREQUISITE** (P-S3) | network policy / TLS |
| H13 | Audit-X TOCTOU: Auth is asked twice, then the read runs | Info | read-only, bounded, self-audited; every page re-verifies live | **NO ISSUE** | none |
| H14 | Mass suspension by a compromised owner | Info | every suspend or restore consumes a fresh factor step-up; a TOTP code is accepted once per 30 s step (`lastUsedCounter`), a passkey needs a gesture; step-up issuance is throttled per owner and IP | **NO ISSUE** | none |
| H15 | Restoration safety: does `isActive = false` have another cause for members? | Info | the only writers are `operator-admin.service.ts` (operators) and `member-security.service.ts`, and nothing else in code, migrations or CLI | **NO ISSUE** today | if a second member-disable cause appears, restoration needs cause tracking |
| H16 | Can a suspended member keep using Core? | Info | every consumer asks Auth live (`/auth/me`, `/auth/grants`); no service verifies JWTs locally | **NO ISSUE** (except H8) | none |

## 3. Service-read accountability (the Stage 19.3 question)

1. **Are organization-scope service reads privileged reads needing a self-audit under ADR-0049?** No. A57 audits only the privileged
   (`read_platform`) scope; `read_organization` is a product reading its own organization's evidence, by design.
2. **Is the missing organization on a narrowed platform read a real gap?** Yes. The record could not answer "who read organization
   X's evidence with the privileged scope".
3. **Architecture impact:** none. The action, the version and the rule "the record stays platform-level" are unchanged; one existing
   optional field is filled in.
4. **Recursion or noise:** none. There is no new action and no new record; the same single record per page.

→ **19.4 FIX** (H5). Organization-scope reads stay unrecorded: **NO ISSUE**.

## 4. What was re-proven (tests)

| Suite | Result |
|---|---|
| Auth `member-security.e2e-spec.ts`: 25 from 19.2 + 7 new | 32 / 32 |
| Auth E2E, all (with a real broker) · Auth unit | 369 / 369 · 119 / 119 |
| Audit `owner-query.e2e-spec.ts` (+ redirect, response-size, stalled-body, reset, 204, `200 {}`, exact-paths, cursor and parameter cases) and `query.e2e-spec.ts` (+ narrowed-read accountability) | 63 / 63 (focused) |
| Audit E2E, all · Audit unit (+ owner-access configuration) | 406 / 406 · 225 / 225 |
| Cross-producer E2E, including the real Audit-X test | 14 / 14 |
| audit-contract unit (not changed) | 1019 / 1019 |
| Build and lint (Auth, Audit), `check:repo` | pass |

**New Auth tests:**
- **Step-up:** an expired proof, another session's proof, and one proof used by two concurrent requests (one 200, one 403).
- **Owner state:** a disabled owner is refused.
- **Atomicity:** if the local security record or the session revocation fails, nothing commits (the member stays active, sessions
  stay live, no evidence is written, the step-up is not burned).
- **Caching:** `no-store`.
- **Reasons:** case, whitespace, NUL, arrays, objects, `null` and booleans are refused.
- **Enumeration:** unknown, cross-Company, shared and pending-only targets are identical in status, body (without the request id) and
  header set.

**New Audit tests:**
- **Redirects:** a same-origin or cross-origin redirect is never followed, and the sink receives nothing.
- **Auth answers:** 204, `200 {}`, oversized with or without `content-length`, a stalled body and a reset connection are each 503,
  with nothing recorded.
- **Exact destination:** exactly two Auth paths, with the caller's own bearer, and a path-shaped id never reaches Auth.
- **Cursors and parameters:** a service cursor on the owner route, an oversized cursor and a repeated parameter are refused.
- **Accountability:** a narrowed service platform read records `organization_id`; unnarrowed and platform-level reads do not.
- **Configuration:**
  - accepted: the URL, a base path, the bounds;
  - disabled: an empty URL;
  - refused: invalid, `ftp:`, `file:`, embedded credentials, a query, a fragment, and out-of-range timeout or rate. None of them
    echoed.

**Mutation check of the fixes.** Removing each fix fails the suite: redirect following, the streaming size cap, the URL rule, the
no-store header, and the narrowed-read `organization_id`. The one survivor, the up-front `content-length` check, is equivalent: the
streaming cap refuses the same bodies. Sources restored and hash-verified.

**Re-proven by the existing 19.2 and 19.3 suites (unchanged):**
- **19.2:** cross-Company, pending cross-Company, same-Company multi-organization, target kinds, the missing, wrong-purpose, foreign
  and reused step-up, concurrent suspend and restore, the concurrent membership insert, idempotency, the session effect, the outbox
  atomicity.
- **19.3:** Company isolation, null-organization isolation, cursor isolation across owners, organizations and routes, the rate limit
  keyed by the verified owner, the self-audit actor and fail-closed path, spoofing, logs.

**Test infrastructure.** The first full run had no broker: the throwaway RabbitMQ container failed at startup reading its Erlang
cookie (`eacces`, a host / Docker quirk). With `-setcookie` passed explicitly it started, and every broker suite passed.

## 5. Privacy review

- **Sensitive logging:** the new paths log no bearer, step-up proof, OTP, passkey material, secret, body, Auth answer, result, email or
  phone. The only lines are fixed codes with `caller=owner` (no id). The kit logger also redacts `Bearer …`.
- **Metrics:** only the closed labels `scope × outcome` (`owner_*`); no owner, organization, user or resource id.
- **Response minimization:** the member-security response is `{id, suspended, changed}`. Audit-X returns the Stage 18 record view
  (no internal id, no raw payload, no IP or user agent, no local Auth evidence).
- **Filter oracle:** every filter is ANDed inside the mandatory organization scope. A filter can narrow, never escape.
- **New PII storage:** none.
  - 19.2 adds bounded local and central rows (ids and a closed code).
  - 19.3 adds bounded self-audit rows (ids and counts).
  - The limiter keys are hashed and purged by the existing janitor; their cardinality is bounded by the number of verified owners,
    because failed authentication is refused before any limiter write.
- **CSRF:** not applicable. Both surfaces are bearer-only; there are no cookies, and CORS is off by default.
- **Operator and member access:** 403 on both surfaces, re-tested.
- **Other routes:** no other route reaches `MemberSecurityService`.
- **Admin service:** none. Audit's client is a narrow verification port.

## 6. Residual risks and prerequisites

**Residual:** H7, H8, H9, H10, H11, H12, the H15 caveat, and the 19.3 limitations (null-organization evidence; the post-cutover lookup
fails closed; Audit-X depends on Auth).

**Production prerequisites, all still open:**
- **P-S1:** operator step-up.
- **P-S2:** service-token rotation.
- **P-S3:** admin network reachability and TLS (H12).
- **P-S4:** privileged-account policy and the forgotten-password gap.
- **P-S5:** monitoring of suspensions and human evidence reads (H11).
- **P-S6:** `JWT_SECRET` rotation.
- **P-A1 to P-A8:** unchanged.

None is closed by assumption.
