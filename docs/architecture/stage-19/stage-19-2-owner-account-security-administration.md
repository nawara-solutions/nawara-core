# Stage 19.2: Owner account security administration

- **Status:** PASSED on `feat/owner-account-security-administration` (awaiting review; not committed).
- **Base:** `main` @ `5bff0da` (Stage 19.1 merged; [ADR-0050](../../adr/0050-platform-administration-and-verified-human-authority.md)
  Accepted).
- **Scope:** ADR-0050 decision 5 (D5 and D6, with D7 respected), in Auth only. It adds no service, database, migration, admin
  framework or Audit-X.

## 1. Pre-implementation findings

| Topic | Finding (evidence) |
|---|---|
| Account state | `"user"."isActive"` is the only account security state. Before this stage its only writer was the operator block (`operator-admin.service.ts`); nothing disables a member |
| Effect of `isActive = false` | refused on the next request by `AuthGuard` (`auth.guard.ts:54-59`), and therefore by `/auth/me` (Billing, Payment) and `/auth/grants` (organization-service). Refresh is refused (`refresh-token.service.ts:95`), and so is login (`auth.service.ts:150`) |
| Owner authority | `@Actors('owner')`: the kind comes from the database and the token tier must equal it. The Company comes from the `owner` row (`UsersService.ownerCompany`); there is one owner per Company |
| Membership authority | Auth's own `organization_membership` (`pending`, `active`, `rejected`, `revoked`; `pending → active \| rejected`, `active → revoked`) → `organization` → `platform."companyId"`. The composite FK `membership_member_fk ("userId","userKind")` allows only members. No other service is needed |
| Step-up | `StepUpService.consume`: an atomic conditional UPDATE in the caller's transaction (owner, session, purpose, unconsumed, ≤ 15 min, allowed method). It rolls back with the operation |
| Audit | `account.disabled` / `account.enabled` exist (owner actor, organization none). `CentralAudit.write` goes to the kit outbox in the caller's transaction |

Existing primitives were sufficient, and nothing contradicted ADR-0050. No stop condition was met.

## 2. Implementation

| Change | File |
|---|---|
| `MemberSecurityService`: one transaction for owner Company → step-up → target lock → eligibility → change → local + central evidence | `apps/auth-service/src/members/member-security.service.ts` |
| `POST /auth/admin/members/:id/suspend {reason}`, `POST /auth/admin/members/:id/restore`: `@Actors('owner')`, `x-step-up-token`, response `{id, suspended, changed}` | `apps/auth-service/src/members/member-security.controller.ts` |
| Step-up purposes `account.suspend`, `account.restore`, factor only | `apps/auth-service/src/owner/step-up.service.ts` |
| Wiring | `apps/auth-service/src/app.module.ts` |
| Catalog: `account.disabled` gains an optional closed `reason`; both purposes widened | `libs/audit-contract/src/catalog.ts` (+ the regenerated `docs/architecture/audit-event-catalog.md`) |

**The implemented D5 rule.** The target must satisfy all three:
- kind `member`;
- at least one **active** membership in an organization whose platform's `companyId` is the owner's;
- **no active or pending** membership in an organization of any other Company.

Rejected and revoked memberships elsewhere do not block, because they grant no current or pending access there. Restoration applies
the same rule. Every failure is a collapsed 404, recorded locally as `denied` with `why` (`not_a_member`, `not_in_company` or
`other_company`). The refusal rolls back, so the step-up is not burned.

**Concurrency.**
- **Target lock:** the target user row is locked `FOR UPDATE`. A concurrent membership INSERT takes `FOR KEY SHARE` on that row (the
  FK), so it either commits first and is seen, or waits for the suspension.
- **Racing requests:** duplicate or racing suspend and restore calls serialize on the same lock. Each real change writes one event;
  a request that finds the account already in its state writes nothing (`changed: false`).

**Evidence.** The local record is `auth_audit_event` `account.disabled` / `account.enabled`, with metadata `{kind: member, reason?}`.
The central record, written in the same transaction, is:
- `actor {type: user, id: owner, userKind: owner}`;
- `organizationId: null`, per the catalog. No organization is fabricated, so these records are outside Audit-X's owner scope, the
  known ADR-0050 limitation;
- `resource {type: user, id}`;
- `changes {reason}` on suspension only.

`reason` is additive under A50: the contract version stays 1, and audit-service deploys first (the Stage 18 rollout rule).

**Unchanged:** the operator block (no step-up, no reason), memberships, Billing, Payment and every other service.

## 3. Tests

| Suite | Result |
|---|---|
| `apps/auth-service/test/member-security.e2e-spec.ts` (new, real PostgreSQL, real routes) | 25 / 25 |
| Auth E2E, all | 355 passed, 7 skipped (the env-gated real-broker file) |
| Auth unit | 119 / 119 |
| audit-contract unit (+5 pinning the `account.disabled` correction) / integration | 1016 / 1016 · 10 / 10 |
| audit-service unit / `contract-persistence` E2E | 224 / 224 · 102 passed (3 broker-gated skipped) |
| Auth build, lint (Auth, contract), `check:repo` | pass |

**The new spec covers:**
- the authorization matrix: owner allowed; operator (assigned) 403; member and organization-admin member 403; unauthenticated 401;
- step-up: missing, malformed, wrong purpose, another owner's, reused and secret-key refusals; a refused target does not burn the
  step-up;
- D5 cross-Company: active or pending elsewhere refused, rejected or revoked elsewhere allowed, several same-Company organizations
  allowed, restore under the same rule, Company B's owner refused, and a concurrent uncommitted INSERT serialized and seen;
- D6: the three codes accepted; `owner_request`, free text, oversized, non-string, missing and extra fields refused;
- spoofing headers and body fields;
- the session effect: `/auth/me`, `/auth/grants`, refresh and login refused; restore does not revive old sessions;
- idempotency, duplicate and racing requests;
- atomicity: an outbox failure rolls everything back; a broker outage leaves the change committed and the evidence published once;
- privacy of the response, local metadata and logs.

**Mutation campaign (10 mutants).** 9 were killed:
- no other-Company check;
- pending not counted;
- no row lock;
- no session revocation;
- no step-up;
- secret key allowed;
- not idempotent;
- not-in-Company allowed;
- reason dropped.

The survivor is equivalent: dropping the `kind = 'member'` check changes nothing, because `membership_member_fk` makes a
non-member's membership impossible. The check stays as defense in depth. All sources were restored and hash-verified.

## 4. Risks and prerequisites

- **Shared identities:** an identity shared by two Companies cannot be suspended by either owner (the D5 consequence).
  Company-specific access disabling is a future concern.
- **Future disable causes:** `isActive` has no cause attribution. If a second member-disable cause is ever added, restoration must
  learn to distinguish it.
- **Audit-X visibility:** owners cannot see `account.*` evidence through Audit-X (organization none). This is the ADR-0050 limitation.
- **Production prerequisites unchanged:** P-S1 to P-S6 and P-A1 to P-A8 remain open.
