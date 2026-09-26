# Stage 19.6: Focused certification and closure (Security / Platform Administration)

- **Status:** **PASSED. Stage 19 is CLOSED** (on `chore/stage-19-focused-certification`, awaiting review; not committed).
- **Base:** `main` @ `c910906` (Stages 19.1 to 19.5 merged; ADR-0049 and ADR-0050 Accepted).
- **Runtime changes:** **none**. This stage re-read the merged code, re-ran the focused suites and a bounded regression from merged
  `main`, ran a representative mutation check, and reconciled the limitations and prerequisites.
- **Not run:** Full Core Validation; Stage 18.10-style certification.

## 1. Architecture certification

| Guarantee | Architecture | Merged implementation (re-read) | Result |
|---|---|---|---|
| Verified human authority: own bearer, the target service decides | ADR-0050 decisions 1 and 2 | Auth: `@Actors('owner')` (live: `isActive`, session, tier = database kind), `member-security.service.ts`. Audit: `owner-query.controller.ts` → `HttpOwnerAuthority` (`/auth/grants` + `/auth/admin/organizations/:id` with the caller's own bearer) | PASS |
| Service identity ≠ human actor | ADR-0033, ADR-0050 decision 2 | the owner route refuses any configured service-token digest (constant time) before calling Auth; `@Actors` refuses service tokens (not JWTs) | PASS |
| Correlation id ≠ identity | ADR-0049 A33, ADR-0050 decision 2 | only forwarded as a header (`correlationHeaders()`) and recorded as navigation; never read for a decision | PASS |
| No identity headers | ADR-0050 decision 2 | no `x-owner-*`, `x-admin-*`, `x-user-*`, `x-acting-*` or `x-company-*` read anywhere in the Stage 19 code | PASS |
| No central admin service | ADR-0050 decisions 7, 8 and 13 | none. audit-service's only outbound call is the narrow Auth verification client; no Stage 19 component holds another service's database credentials | PASS (none found) |
| Domain ownership | ADR-0050 decision 7 | Auth owns account and session state; Audit owns evidence; the hierarchy stays Auth's (organization-service authority is not activated) | PASS |

## 2. Certification matrix

| Requirement | Architecture | Implementation | Test evidence (re-run on merged `main`) | Result |
|---|---|---|---|---|
| Owner-only suspend / restore | ADR-0050 decision 5 | `member-security.controller.ts` `@Actors('owner')` | member-security: operator (assigned), member, org admin → 403; unauthenticated → 401 | PASS |
| Factor step-up, single-use, bound to session, purpose and time, consumed in the transaction | decision 5; ADR-0025 | `StepUpService.consume` in the transaction; purposes `account.suspend` / `account.restore`, factor only | missing, malformed, wrong purpose, another owner's, another session, expired (16 min), reused, concurrent double-use (one 200, one 403), secret key → 400 | PASS |
| Same-Company rule (D5) | decision 5 | `eligibleMember`: `FOR UPDATE` on the user; `bool_or` over membership → organization → platform → company | active or pending elsewhere → 404; rejected or revoked elsewhere allowed; same-Company multi-organization allowed; Company B's owner refused; restore under the same rule; a concurrent uncommitted INSERT is serialized and seen | PASS |
| Target must be a member | decision 5 | `kind === 'member'` (and `membership_member_fk`) | owner, operator, zero-membership, pending-only → 404 | PASS |
| Transaction atomicity | decision 9 | one `db.tx`: step-up, state, sessions, local record, outbox | failures of the outbox, the local record and the session revocation → 500 and nothing committed; step-up not burned | PASS |
| Session effect | decision 5 | `setActive` + `revokeAllForUser`; the guard is live | `/auth/me`, `/auth/grants`, refresh and login refused; restore does not revive old sessions | PASS |
| Bounded reason | D6 | `@IsIn(SUSPENSION_REASONS)`; catalog `reason` code | the 3 codes accepted; `owner_request`, free text, case, whitespace, NUL, array, object, `null`, boolean, extra fields → 400 | PASS |
| Audit-X: own bearer, live verification | decision 6 | `AuditQueryService.owner` → `verifyOwner` (kind owner, companyId) | no, malformed or revoked bearer → 401; member, operator → 403; service token → 401 and never forwarded; a blocked session → 401 on the next read | PASS |
| Organization → Platform → Company | decision 6 | Auth `/auth/admin/organizations/:id` (`owner.companyId = platform.companyId`); the answer's id must equal the request's | A→A1 and A2 allowed; A→B1, B→A1 and unknown → identical 404; wrong-organization answer → 503 | PASS |
| One organization per request | decision 6 | path id only; `parseQuery(…, 'owner')` rejects `organizationId`, `platform`, `companyId` and unknown parameters | wildcards, lists, uppercase and extra-scope parameters → 400 | PASS |
| No null-organization records | decision 6 | scope `{kind: 'organization'}` (never null) | every item's organization = the path's; `action=account.disabled` → empty | PASS |
| Bounds | A66 + 19.3 | `MAX_WINDOW_MS.owner` 31 days; `MAX_LIMIT` 100; default 50 | 31 days accepted, 32 refused; UTC only; impossible dates; reversed window; limits 0, 101 and repeated → 400 | PASS |
| Scoped cursor | A36 + 19.3 | fingerprint(`owner:<id>`, scope incl. organization, filters, window) | across owners, organizations, filters and routes (both directions); tampered, malformed, oversized → refused | PASS |
| Owner-keyed rate limit | 19.3 | `audit_query_owner`, keyed by the verified id, after verification | spoofed headers and alternating organizations do not reset it; another owner is unaffected | PASS |
| Self-audit, real actor, organization, fail closed | decision 6; A57 | read + `platform_query.executed` {user owner, `organization_id`} in one transaction | recorded per read; no result content; revoked INSERT → 503 and nothing returned or written; real cross-process test | PASS |
| Redirects never followed; body ≤ 16 KiB; answers validated; URL rules | 19.4 | `redirect: 'manual'`; streaming cap; strict shape checks; `authServiceUrl()` | same-origin and cross-origin redirects, 204, `200 {}`, oversized, stalled, reset → 503; the URL refused with credentials, query or fragment | PASS |
| `no-store` | 19.4 | Audit-X controller; `@Header` on member routes | asserted on both | PASS |
| Sensitive logging absent | 19.4 | fixed-code log lines; `caller=owner` without id | log assertions (no bearer, owner id, result, email) | PASS |
| Bounded metrics | 19.5 | `QueryCounters` (scope × outcome, owner-only outcomes); `MemberSecurityCounters` (operation × outcome) | snapshot lines asserted; no ids | PASS |
| H11 and dependency classes | 19.5 | `measured()` mapping; `AuthDependencyError` | `denied` for 401/403/404; `auth_timeout` vs `auth_unavailable`; `unavailable` | PASS |
| One Auth budget per read | 19.5 | a shared `AbortSignal.timeout(AUTH_TIMEOUT_MS)` | two 250 ms calls under a 400 ms budget → `auth_timeout` within about the budget | PASS |
| Recovery, readiness, liveness | 19.5 | no authority cache; readiness has no Auth check | Auth down → 503, back → 200 with no restart; `/ready` never names Auth; `/health` 200 | PASS |
| Resource cleanup | 19.5 | bodies cancelled; limiter janitor; counters are fixed-key maps | inspection plus the refused and reset tests | PASS |
| Member-security and owner-query signals | 19.5 | the two snapshot lines | counter tests | PASS |
| Deployment order documented | 19.5 | Stage 19.5 record §5 | mixed versions reasoned from the merged routes (§6) | PASS |

## 3. Tests re-run from merged `main` (`c910906`)

| Suite | Result |
|---|---|
| Stage 19.2 focused `member-security.e2e-spec.ts` | 33 / 33 |
| Stage 19.3 / 19.4 Audit-X `owner-query` + `query` | 63 / 63 |
| Stage 19.5 operational `owner-operational` | 9 / 9 |
| Auth E2E · unit | 370 / 370 · 119 / 119 |
| Audit E2E · unit | 415 / 415 · 225 / 225 |
| audit-contract unit · integration | 1019 / 1019 · 10 / 10 |
| Cross-producer E2E (real Auth, Audit, Billing, Payment, organization-service and File processes; real RabbitMQ; includes the real Audit-X test and the broker-outage recovery) | 14 / 14 |
| Build; lint (Auth, Audit, contract: 0 warnings); `check:repo` | pass |

**Mutation check (13 critical controls, all killed; sources restored and hash-verified):**
- the cross-Company guard removed;
- the step-up check removed;
- operator allowed on suspend;
- the row lock removed;
- the session revocation removed;
- the owner kind weakened;
- the null-organization boundary removed (platform-wide scope);
- the cursor's owner binding removed;
- Auth redirects followed;
- a self-audit failure ignored;
- H11 misclassified;
- the shared Auth budget removed;
- the organization ownership check removed.

## 4. Final truths (where earlier reports are superseded)

- **The Stage 19.3 record** said an empty `AUTH_SERVICE_URL` "would be refused". An empty value is **unset**, so owner access is
  disabled (Stage 19.4 H6). It is never half-configured.
- **Only two code paths disable an account** (`setActive`): operator block (operators only) and member suspension. Restore is
  therefore safe with the current `isActive` model (re-verified).

## 5. Accepted limitations (each re-verified on merged `main`)

| ID | Limitation | Still applicable | Impact | Why Stage 19 closes with it | Destination |
|---|---|---|---|---|---|
| H7 | A 404 on a visible member reveals one bit: that member also has a pending or active membership under some other Company (never which) | yes | Low | inherent to D5; a refusal must exist | accepted limitation |
| H8 | File download tickets issued before a suspension stay valid until they expire (default 120 s, range 60–300 s, reusable) | yes (`upload-config.ts`) | Low | bounded, and tickets carry no user token (ADR-0048 F16) | accepted limitation |
| H9 | The kit `HttpAuthClient` and organization-service's grants client follow same-origin redirects | yes (no `redirect` option) | Low (needs a misbehaving Auth) | outside the Stage 19 surface | future kit HTTP hardening |
| H10 | Auth sets no `Cache-Control` except on the member-security routes | yes | Low | repository-wide, not a Stage 19 path | production prerequisite / future |
| H12 | `AUTH_SERVICE_URL` may be `http:` | yes | Low (internal network) | production topology | P-S3 |
| O10 | A client disconnect may leave a self-audit record for an undelivered response | yes | None for security (over-records) | conservative direction | accepted limitation |
| O16 | No outbox backlog gauge (the relay failure log carries `ageSeconds`) | yes | Low (visibility) | a kit-wide gauge is not Stage 19 | P-A4 |
| O17 | Guard refusals on member-security routes are not counted | yes | None | they are Auth-wide guard outcomes | accepted limitation |
| O18 (new, informational) | Owner-route requests with no bearer, or a service token, are refused (401) before the owner-read counters | yes | None | same nature as O17 | accepted limitation |
| 19.3 | Owners cannot read null-organization evidence (incl. `account.*`); after the ADR-0039 cutover, uncached organizations are denied (404); Audit-X depends on Auth availability | yes | None for security (all fail closed) | accepted by ADR-0050 | future Company attribution (ADR-0049 amendment) |

## 6. Production prerequisites (nothing closed by tests)

| # | Status | What exists in code | What remains | Owner |
|---|---|---|---|---|
| P-S1 operator step-up | **OPEN** | operators have no security power (tested) | an operator independent factor before any such power | security / owner |
| P-S2 service-token rotation | **OPEN** | two digests per caller allow overlap | rotation procedure / mechanism | security / operations |
| P-S3 admin reachability, TLS | **OPEN** | URL shape rules; no redirects | network policy, TLS termination | infrastructure |
| P-S4 privileged-account policy | **OPEN** | cool-down recovery; the CLI withdrawn (ADR-0050 decision 14) | the policy; the forgotten-password gap | owner |
| P-S5 monitoring | **PARTIALLY PREPARED** | `auth_member_security_snapshot`, `audit_query_snapshot` owner outcomes and latency; alertable conditions (19.5 §3) | collection, thresholds, routing | operations |
| P-S6 `JWT_SECRET` rotation | **OPEN** | a single HS256 key | a key ring / rotation | security |
| P-A1 per-service broker identity | **OPEN** | `sourceService` catalog-checked | broker users, permissions, `user-id` | security / infrastructure |
| P-A2 retention durations | **OPEN** | the policy table ships empty (never purge) | durations | legal / owner |
| P-A3 erasure policy | **OPEN** | none | policy | legal / privacy |
| P-A4 alert routing | **OPEN** | snapshot signals (now incl. Stage 19) | routing, thresholds | operations |
| P-A5 Auth raw-IP retention | **OPEN** | local audit only | decision | privacy / owner |
| P-A6 RabbitMQ in production | **OPEN** | the kit bus, relay and DLQ | production broker | infrastructure |
| P-A7 audit backup / restore | **OPEN** | append-only design | a tested procedure | operations |
| P-A8 real reader policies | **OPEN** (restated: products; Audit-X needs none) | `AUDIT_SERVICE_POLICY` | entries for real product readers | products |
| Also carried | DLQ access control; the retention password and scheduler; production RabbitMQ validation | — | — | as in Stage 18.10 |

Owners of closure: the production-readiness track (Stage 22) and the owner or infrastructure decisions above. None belongs to
Stage 20.

## 7. Closure decision

**No runtime defect was found, no blocker remains, and every remaining item is an accepted limitation, a production prerequisite or
future work.**

| Substage | Status |
|---|---|
| 19.1 Architecture & Decisions | ✅ closed |
| 19.2 Owner Account Security Administration | ✅ closed |
| 19.3 Audit-X | ✅ closed |
| 19.4 Security & Privacy Hardening | ✅ closed |
| 19.5 Operational Hardening | ✅ closed |
| 19.6 Focused Certification & Closure | ✅ passed |
| **Stage 19** | **🏁 CLOSED** |

Next: **Stage 20, Release Management**, not started.
