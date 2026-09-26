# Stage 20.4: compatibility policy and owner administration

- **Status:** PASSED on `feat/release-compatibility-admin` (awaiting review; not committed).
- **Base:** `main` @ `4bc89c8` (Stage 20.3 merged, PR #133; [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) Accepted, **unchanged**).
- **Scope:** the first human Release Management administration. The verified owner of the configured operating Company withdraws releases
  and changes a client component's minimum supported version:
  - their own bearer is verified live through Auth;
  - each operation needs a mandatory factor step-up;
  - the change and its audit intent are written in one transaction.
- **Not built:** the compatibility read (20.5); hardening and certification (20.6 / 20.7).

```text
owner's own bearer ──▶ OwnerGuard: service token? 401 (never forwarded) · GET /auth/grants (live) · kind = owner AND companyId = the
                        operating Company, else 403 (one answer) · ONE Auth budget starts here
                   ──▶ DTO whitelist (body)
                   ──▶ AdminService: validate (400) · resolve (404) · every knowable precondition (409), BEFORE any step-up is spent
                   ──▶ POST /auth/step-up/verify (same budget): this owner, this session, this purpose, once; consumed in Auth
                   ──▶ one transaction: component advisory lock · the change (the database re-checks every invariant) · audit intent (outbox)
```

## 1. Decision gate: registered-only withdrawal

```text
REGISTERED-ONLY WITHDRAWAL DECISION
Current rule:    registered → published → withdrawn
Question:        should registered → withdrawn be added?
Recommendation:  KEEP CURRENT RULE
Required ADR impact: NONE
```

**Reasoning.**

1. **Withdrawal retracts an offer.** In ADR-0051, `withdrawn` has one precise consequence: every client running that build is `required`
   to update (reason `withdrawn`), and the build leaves "latest". Both matter only for a release that was *offered*, that is, published.
   A registered-only release was never offered: it is never latest, and it can never be designated a minimum (enforced in this stage).
2. **Unpublished mistakes are already inert.** A bad registration that is never published affects no client decision beyond its own
   (hypothetical) holders, and CI simply registers the fixed build as a new version. No recovery path is missing for the normal CI error
   (a wrong or broken build): *don't publish it*.
3. **Allowing it would make `withdrawn` ambiguous.** It would mean either "retracted from clients" or "never meant to exist". The audit
   trail (`release.withdrawn`, a *security* action) would then mix incident response with CI housekeeping, and the 20.2 lifecycle trigger,
   timestamps check (`withdrawnAt` requires `publishedAt`) and 20.3 semantics would all need to change.
4. **The rare real case has a sound path without new semantics.** A registered-only build is compromised *and* already in someone's hands
   (for example a store-review or tester build). The owner raises the minimum above it once a fix is published: every client below the
   minimum, including that build, is then `required` to update. If a cleaner concept is ever needed, it is a *different* one
   (for example `revoked` for never-published builds) and deserves its own ADR amendment. It is recorded as a future design question
   (§11), not added here.

**Final Stage 20.4 rule (unchanged):** `registered → published → withdrawn`. Withdrawing a registered-only release is 409
`invalid_transition`. There is no ADR change.

## 2. Human authority

| Question | Answer |
|---|---|
| Human bearer required | **yes**: the caller's own Auth access token (`Authorization: Bearer`) |
| Live Auth verification | **yes**: `GET /auth/grants` on every request (Auth reloads the user and the session: active, session live, tier = kind); no cache |
| Verified owner required | **yes**: `kind = owner` |
| Configured operating Company enforced | **yes**: `RELEASE_OPERATING_COMPANY_ID` must equal the owner's `companyId` from Auth |
| Factor step-up mandatory | **yes**, per operation (§4) |
| CI can withdraw or change the minimum | **no**: the automation policy has only `release.register` / `release.publish`, and a service token on an owner route is 401 and **never forwarded to Auth** |
| Operator can withdraw or change the minimum | **no**: 403, the same answer as a member or another Company's owner (ADR-0051 decision 8) |
| Service identity can impersonate a human | **no**: the actor is only what Auth verified; no header (`X-User-Id`, `X-Owner`, `X-Role`, `X-Company`, `X-Organization`, `X-User-Kind`, `X-Acting-User` …) or body field is read as identity |

**Configured operating Company.** The deployment sets it (`RELEASE_OPERATING_COMPANY_ID`, together with `AUTH_SERVICE_URL`). Without both,
the owner routes are **not mounted**, which fails closed; a partial configuration refuses to boot.
- Company is not Product, and Product is not Organization.
- The Company is compared, never recorded: audit records carry no Company attribute (ADR-0050).

**Enumeration.** Authority is decided **before** input validation and before any lookup. A member, an operator or another Company's owner
gets the same 403 `operation_not_allowed` for any target, existing or not, well-formed or not. The operating owner has authority over every
product of the deployment, so 404s are no cross-authority leak for them.

## 3. Auth dependency

The same hardened client as audit-service's Audit-X (Stage 19.4 / 19.5):
- `redirect: 'manual'`, so the bearer never leaves the configured Auth;
- answers bounded to 16 KiB and read under the deadline;
- unread bodies released;
- the URL is refused at boot if it carries credentials, a query or a fragment;
- correlation headers only;
- no service credential is ever sent.

**One time budget per request** (`AUTH_TIMEOUT_MS`, default 3000). It starts in the guard, and the owner check **and** the step-up call share
it. A slow owner check leaves only the remainder for the step-up (tested: 500 ms grants, then a hanging step-up, fails at about the budget,
not about twice it).

| Auth condition | Answer |
|---|---|
| Bearer refused (expired, revoked, blocked, inactive) | 401 |
| Not an owner of the operating Company | 403 `operation_not_allowed` |
| Timeout (the shared budget ran out) | 503 `auth_timeout` |
| Down, reset, redirect, 204, empty, unknown kind, oversized, malformed | 503 `auth_unavailable` |
| Step-up call: 401 (the session ended meanwhile) | 401 |
| Step-up call: 403 | 403 `step_up_required` |
| Step-up call: any other status, redirect or failure | 503 |

Everything fails closed: nothing is changed, and no stale authority is used.

## 4. Factor step-up

**Two new purposes in Auth's allow-list, factor only** (TOTP or passkey, never the bare secret key), one per operation:
`release.withdraw` and `compatibility_policy.change`. This follows the least-privilege, factor-only precedent of Stage 19.2's
`account.suspend` / `account.restore`. No existing purpose was broadened.

**Proof.** Auth issues the proof (`POST /auth/admin/step-up`), and release-service verifies **and consumes** it through the existing
`POST /auth/step-up/verify` (ADR-0042 A.1). That call is single-use and bound to:
- the actor (the bearer's owner);
- the session;
- the purpose;
- an expiry.

There is no second MFA system, and no `mfa=true` claim or assurance header is honoured (tested). A malformed proof (not a UUID) is refused
without asking Auth.

**Atomicity, following the established cross-service semantics** (organization-service's `admin/` module, ADR-0050 decision 1: "verifies
and consumes a step-up through Auth"):
- Every precondition that can be known before the change is checked **before** the proof is consumed: authority, input, target,
  lifecycle, minimum ≤ latest, and the expected policy version. **A refusal never spends the proof** (tested: the same proof then succeeds).
- The proof is consumed in **Auth's** database, so it cannot roll back with release-service's transaction. If the mutation then fails, the
  proof is spent and the change is not made; the owner steps up again. This happens only on a database or outbox failure, or on a race the
  database refuses. The same property holds for organization-service. Tested: the outbox refuses, then 500, then nothing changed, the proof
  is spent, and a new proof succeeds once.
- **An idempotent no-op** (already withdrawn; the minimum already in effect) still requires **and spends** a valid proof and writes
  nothing. This is the Stage 19.2 rule for sensitive owner operations, where the no-op path consumes the step-up in its committed
  transaction.

## 5. Withdrawal

**Route:** `POST /release/admin/products/{product}/components/{component}/releases/{version}/withdraw`. It takes `x-step-up-token` and no
body, and returns 200 `{…release, changed}`.

| State | Answer |
|---|---|
| `published` | → `withdrawn`, `withdrawnAt` set; `release.withdrawn` recorded; `changed: true` |
| `withdrawn` | 200 `changed: false`, the same `withdrawnAt`; nothing written |
| `registered` | 409 `invalid_transition` (§1) |
| Unknown component or version | 404 `release_not_found` |
| Malformed key or version | 400 |

**Minimum ≤ latest.** A withdrawal that would leave the current minimum above the new latest is 409 `would_break_minimum`: lower the minimum
first.
- It is checked before the step-up (the same rule as the trigger), and the **database trigger `release_withdrawal_keeps_minimum` remains
  the authority**.
- Withdrawing 3.0.0 with minimum 2.0.0 and latest 3.0.0 is allowed (the new latest 2.0.0 = the minimum). Withdrawing the only release at or
  above the minimum is refused. Both are tested.

**A withdrawn release:**
- stays as history;
- is never latest again;
- is never republished (CI publish is 409);
- keeps its identity unchanged.

There is no restore.

**Concurrency.** Six simultaneous withdrawals of one release produce one transition, one `withdrawnAt` and one record.

## 6. Minimum-version policy

**Route:** `POST /release/admin/products/{product}/components/{component}/compatibility-policy`, body
`{ minimumVersion, expectedPolicyVersion }`, header `x-step-up-token`. Returns 200 `{…policy, changed}`.

**Append-only.** Each change inserts the **next** `policyVersion`; rows are never updated or deleted (the 20.2 triggers and revoked
privileges).

**Optimistic concurrency.** `expectedPolicyVersion` is the version the owner last read (0 when there is none). A stale value is 409
`policy_conflict`: nothing is overwritten and no update is lost. The database's next-version trigger and unique key back it.

**Minimum validation.**
- Canonical SemVer, never normalized; stable only (a pre-release is 400).
- It must designate a **published, not withdrawn release of this component** (409 `invalid_minimum`): an unknown version, a registered-only
  release, a withdrawn one, or another component's.
- A published stable release is always ≤ latest, and the database re-checks minimum ≤ latest under the component lock
  (`minimum_above_latest` if a race slipped between).
- A backend has no policy (409 `policy_not_applicable`).
- An unknown component is 404 `component_not_found`.

**No-op.** The minimum already in effect gives 200 `changed: false`, with no new version and no evidence. This holds even with a stale
expectation, so a retry after a success reaches the goal state instead of a conflict.

**Transaction.** Take the component's advisory lock first; re-read the current policy and the designated release under the lock; append;
write the evidence. A concurrent withdrawal of the designated release, or another change, is therefore seen.

## 7. Concurrency model

Every policy change and withdrawal of a component takes the component's transaction-scoped advisory lock
(`release_lock_component`, Stage 20.2) **first**. The policy and withdrawal triggers take the same lock, so the explicit lock is the
consistent ordering and the triggers are the backstop. The database is the final authority for every invariant.

**Tested over real PostgreSQL, with separate pooled sessions:**
- "minimum = 3.0.0" racing "withdraw 3.0.0" (6 rounds): exactly one ordering commits, the loser gets 409, and the final state always
  satisfies minimum ≤ latest (checked by SQL);
- two changes from the same expectation: one v2, one 409, no duplicate version;
- six concurrent withdrawals: one transition.

The 20.2 two-session write-skew test still passes.

## 8. Audit

| Action | Category | Actor | Organization | Resource | Changes |
|---|---|---|---|---|---|
| `release.withdrawn` | security | `{type: user, id: <owner>, userKind: owner}` | `null` | `release` / its id | `product_id`, `component_id`, `kind` |
| `compatibility_policy.changed` | security | same | `null` | `component` / its id (the policy row has no UUID) | `product_id`, `kind` (client kinds), `policy_version` `{from, to}`, `minimum_release_id`, `previous_minimum_release_id` (when there was one) |

- **Catalog.** Additive (A50; ADR-0051 §9 named both actions). Actors are the **owner only**: no service, no system, no operator.
  Stage 20.1 floated letting a service raise minimums "if the owner allows CI"; that was not decided and is not added. The catalog
  document is regenerated.
- **Deploy order.** As before, audit-service must be deployed with this catalog before release-service emits.
- **Bounded evidence.** The minimum is named by the **release it designates** (a UUID), never by version text (the catalog admits no free
  text). There is no bearer, proof, Auth response, Company, version, body or reason.
- **Truthful.** Evidence is written only when a row changed: a no-op or a retry writes nothing. Deterministic event ids (release + action;
  component + policy version + action) back this up.
- **Atomic.** The evidence is written through the outbox on the mutation's transaction; a forced outbox failure rolls the mutation back
  (tested for both actions).
- **Asynchronous.** A broker or audit-service outage after commit leaves the intent pending in the outbox (the 20.3 relay tests), and the
  real cross-service suite delivers both actions to audit-service with the owner as actor.

**Reason field.** None is added. ADR-0051 and the 20.1 audit design define no reason for withdrawal or minimum changes, whereas Stage 19.2's
closed `reason` was an explicit ADR-0050 decision (D6). A free-text reason would be refused by the catalog anyway. Whether a closed reason
set (for example `security_incident | defect | policy`) is wanted is an owner question for 20.6 / 20.7 (§11); the contract does not expand
here.

## 9. Failure semantics

| Class | Answer | Proof spent | Written |
|---|---|---|---|
| Unauthenticated / service credential / bearer refused | 401 | no | nothing |
| Not the operating Company's owner | 403 `operation_not_allowed` | no | nothing |
| Auth timeout / unavailable | 503 `auth_timeout` / `auth_unavailable` | no (or not confirmed) | nothing |
| Step-up missing, malformed, invalid, expired, wrong purpose, wrong session, replayed | 403 `step_up_required` | — | nothing |
| Invalid input | 400 | no | nothing |
| Unknown resource | 404 `release_not_found` / `component_not_found` | no | nothing |
| Invalid lifecycle / would break the minimum / invalid minimum / stale version / backend | 409 (see codes above) | no | nothing |
| Race refused by the database after the proof | 409 | yes (cross-service) | nothing |
| Database or outbox failure | opaque 500 (`release_admin_failed … error=<class>` logged) | yes (cross-service) | nothing (rolled back) |
| No-op | 200 `changed: false` | yes (Stage 19.2 rule) | nothing |
| Success | 200 `changed: true` | yes | the change + its evidence, atomically |

## 10. Observability (bounded; 20.6 is not started)

| Line | Fields |
|---|---|
| `release_admin_denied` | `operation=withdraw\|policy_change`, `outcome=unauthenticated\|authority_denied\|auth_timeout\|auth_unavailable`, `reason=<closed code>` (the guard) |
| `release_admin` | `operation`, `outcome=changed\|unchanged\|step_up_denied\|invalid\|not_found\|conflict\|unauthenticated\|auth_timeout\|auth_unavailable`, `actor=<owner uuid>`, a release or component UUID and, on success, the policy version |
| `release_admin_failed` | `operation`, `actor`, `error=<class>` |

Never logged: a bearer, a proof, a version, a Company or a request body (tested). No metrics were added.

## 11. Boundaries and deferred work

**Boundaries.**
- No public compatibility read, `update` decision, ETag, cache or public rate limit.
- No web, desktop or mobile updater behaviour; the policy is component-based and technology-neutral.
- No channels, deployment, undeploy, artifacts, CDN, stores or signing.
- No Billing, Subscription, Entitlement or Payment check.
- No generic admin service, delegated token or operator override.
- No Stage 21 work.
- CI authority is unchanged: the automation policy still admits only `release.register` / `release.publish`.

**Deferred.**
- **20.5:**
  - the client decision read (`update` = `required | available | none`, `reason`), which reads these policies and withdrawals;
  - cache / ETag and the public rate limit;
  - web, desktop and mobile guidance.
- **20.6:**
  - counters and snapshot for the admin outcomes;
  - runbooks: the burned-proof retry, `would_break_minimum` (lower the minimum first), operating-Company configuration;
  - outbox lag and DLQ for this producer;
  - the mistyped-component guidance;
  - the automation rate-limit decision;
  - whether owner routes need a rate limit;
  - **a closed `reason` set for withdrawals and minimum changes (owner decision)**;
  - adversarial hardening.
- **20.7:** certify the authority matrix, the step-up semantics, the concurrency claims and the mutation set below.
- **Future design questions (not scheduled):**
  - a `revoked` state for compromised never-published builds (§1);
  - restoring a withdrawn release;
  - whether an owner may delegate minimum raises to CI (20.1 note);
  - an operator step-up and emergency operator withdrawal (ADR-0042 A.1; needs an independent factor).
- **21.C:** none.
- **21.x:**
  - production `RELEASE_OPERATING_COMPANY_ID` / `AUTH_SERVICE_URL` provisioning (TLS to Auth);
  - CI credentials; broker ACLs (P-A1);
  - monitoring;
  - backups;
  - audit-service deployed with the catalog before release-service.

## 12. Tests (focused; Full Core Validation NOT RUN)

| Suite | Command | Result |
|---|---|---|
| release-service unit (configuration incl. owner administration, policy, SemVer, socket bound) | `npm test -w release-service` | 55 / 55 |
| release-service E2E, real PostgreSQL 16, runtime role. Includes **owner administration (47)**: authority, Auth failure modes, the shared budget, step-up, withdrawal, policy, concurrency, atomicity, logs. Also OpenAPI (5) and every 20.2 / 20.3 suite | `npm run test:e2e -w release-service` | 155 / 155 |
| auth-service unit / E2E: the two new purposes, factor-only, purpose-bound, single-use over `/auth/step-up/verify`; everything else unchanged | `npm test` / `npm run test:e2e -w auth-service` | 119 / 119 · 371 / 371 |
| audit-contract unit / integration: catalog, ownership, pinned counts | `npm test` / `npm run test:integration -w @nawara/audit-contract` | 1089 / 1089 · 10 / 10 |
| audit-service unit / E2E (ingestion admits the four release-service actions) | `npm test` / `npm run test:e2e -w audit-service` | 233 / 233 · 423 / 423 |
| Cross-service, all real, every producer. Includes **`release-owner.e2e-spec.ts`**: a real Auth owner with TOTP, real `release.withdraw` / `compatibility_policy.change` proofs consumed through Auth, a live release-service and audit-service over RabbitMQ; another Company's owner, a member and the CI token refused; purpose binding and single use in the real Auth | `npm run test:e2e:audit-producers` | 17 / 17 (9 files) |
| Typecheck, lint (0 findings), build: release-service, auth-service, audit-service, audit-contract; type check of the producer suite | | pass |
| Repository checks, and the check script's own tests | `check:repo`, `test:repo` | pass; 17 / 17 |
| Production images (release-service with owner administration configured; auth-service) | `docker build` + `scripts/smoke-core-image.sh` | SMOKE PASSED (both) |

**Mutation check (15 mutants, on the owner-administration suite).** 14 were killed:
- owner kind check removed;
- operating Company check removed;
- step-up refusal ignored;
- withdrawal bound to the other purpose;
- the withdrawal precheck removed (the database still refuses, but the proof was spent);
- a withdrawn release accepted as a minimum;
- expected version ignored;
- append from the current version, not the expected one;
- withdrawal evidence written after commit;
- the wrong actor id;
- a service token forwarded to Auth;
- redirects followed;
- the step-up given its own fresh budget;
- a no-op writing a new policy version.

1 survived, covered by another layer: the explicit component lock was removed, but both database triggers take the same lock, so
minimum ≤ latest still holds. The explicit lock is kept for the request-level "the designated minimum is still published" rule under
a race.

Every source was restored and hash-verified.

**Not re-run:** the migration and provisioning check. There is no new migration and no role change in 20.4; Stage 20.3's `verify.sh` +
`migrate` result stands.
