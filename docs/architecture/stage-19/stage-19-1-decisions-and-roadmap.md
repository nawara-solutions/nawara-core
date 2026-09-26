# Stage 19.1: Security / Platform Administration investigation, decisions and roadmap

- **Status:** **PASSED** (2026-09-26). Every architecture decision is resolved:
  - D1: ADR-0033, ADR-0041, ADR-0025 and ADR-0027 are all Accepted after conformance checks;
  - R1: option (a), the force-reset CLI is not part of Core V1;
  - D2 to D7: approved by the owner.

  [ADR-0050](../../adr/0050-platform-administration-and-verified-human-authority.md) is **Accepted**.
- **Branch:** `feat/security-platform-admin-architecture`; nothing committed.
- **In scope:** what Security / Platform Administration means in Nawara Core; what already exists; what Core V1 needs and where each
  capability belongs; how a privileged human is authenticated and represented; how actions are authorized and audited; and the Stage 19
  plan.
- **Not in scope, and not done:** any runtime, route, schema, consumer or catalog change; any new service; Stage 20+; Final Core
  Validation.
- **Source of truth:** repository evidence. ADR statuses are quoted from the ADR index.

## 1. Baseline

- `main` is at `f3b4bb1`, the Stage 18.10 merge (PR #124); Stage 18 is CLOSED.
- The working tree was clean apart from the untracked `docs/reports/`, which stays untouched.
- The latest ADR was 0049; this stage adds **0050**.

## 2. Terms (from the repository, not invented)

| Term | Meaning in the code | Evidence |
|---|---|---|
| **Company** | top of the hierarchy; exactly one owner, permanently. The data model allows **several Companies** per deployment | ADR-0017, ADR-0022; `company`, `owner`, `owner_single_per_company_v1` |
| **Platform** | a product line of a Company | ADR-0022, `platform."companyId"` |
| **Organization** | a tenant under a Platform | ADR-0020, `organization."platformId"` |
| **owner** | the single human authority of a Company: TOTP / passkey MFA, secret key (step-up, recovery), cool-down recovery | ADR-0025, ADR-0027; `owner/*` |
| **operator** | Company staff (`operator."companyId"`), created and blocked by the owner, scoped by **platform assignments**; out-of-band working code; shift-bounded sessions; **no independent factor** | ADR-0011 to ADR-0015, ADR-0022; `operator/*`, `platform/*` |
| **member** | a **global** identity with 0..N memberships (`pending`, `active`, `rejected` or `revoked`), possibly in organizations of **different Companies** | ADR-0030; migrations `0007`, `0009` |
| **organization administrator** | a membership flag (`isOrganizationAdmin`), not a kind | ADR-0028, ADR-0029 |
| **service** | a caller authenticated by a service token plus a per-target policy; never a user | ADR-0033, ADR-0042 |
| **system process** | a producer's own job | ADR-0049 A9 |

"Platform operator" in the Stage 19 brief maps to the **owner** (Company-wide) and to the **operator** (per assigned Platform).

## 3. Current administration model

```text
Human (owner / operator / member, own Auth bearer)
   │
   ├──► Auth
   │      /auth/admin/*                   owner: operators, assignments, factors, recovery; operator: working-code login
   │      /auth/organizations/:id/*       join codes, memberships, admin invitations
   │      /auth/grants, /auth/step-up/verify   facts and step-up for OTHER services (ADR-0042)
   │
   └──► organization-service /organization/admin/*
          → Auth /auth/grants (+ /auth/step-up/verify)
          authority decided HERE; audit intent in the same transaction

Services (service token + per-target policy): Billing → Payment; Auth → organization-service;
products → Billing / File / Notification / Audit (reads). A service token never carries a user.
```

Every user bearer is verified **live**, so blocking or revocation takes effect on the next request everywhere:
- **Auth:** `apps/auth-service/src/auth/auth.guard.ts:54-59` requires `isActive`, an active session family, and a token tier equal to
  the database kind.
- **Billing and Payment:** Auth `/auth/me`, through the kit `HttpAuthClient`.
- **organization-service:** `/auth/grants`.

## 4. Existing administrative surfaces

| Service | Route(s) | Holder / guard | Central audit | Stage 19 |
|---|---|---|---|---|
| Auth | `POST /auth/admin/operators` | owner, own Company, step-up `operator.create` | `operator.created` | keep |
| Auth | `POST /auth/admin/operators/:id/block` · `/unblock` | owner, own Company, **no step-up** (emergency control, ADR-0025) | `account.disabled` / `.enabled` | keep unchanged; the member path is added beside it (§6) |
| Auth | `POST/DELETE /auth/admin/operators/:id/platform-assignments` | owner, step-up | `platform_assignment.*` | keep |
| Auth | `GET …/platform-assignments`, `GET /auth/admin/organizations/:id`, `GET /auth/platform-access/:id` | owner / operator, live | none | keep. The organization lookup is Audit-X's scope check (§9) |
| Auth | factors, secret key, password, recovery, step-up, owner login, enrollment | owner (own account) | `owner.*` | keep |
| Auth | `/auth/organizations/:id/{join-codes, memberships, admin-invitations}` | owner (step-up) / operator / org admin, by live authority; operators refused on admin invitations | `join_code.*`, `membership.*`, `admin_invitation.*` | keep |
| Auth | `GET /auth/grants`, `POST /auth/step-up/verify` | the caller's own facts only | none | the verified-human mechanism |
| organization-service | `/organization/admin/{platforms, organizations}` | human bearer → Auth grants; step-up for create; operators refused where step-up is required | `platform.*`, `organization.*`, `hierarchy.admin_operation_denied` | keep |
| organization-service | `/organization/{companies, platforms, organizations, reference}` | service token + `SERVICE_POLICY` | domain actions (service) | keep |
| Audit | `GET /audit/organizations/:id/records`, `GET /audit/platform/records` | service token + `AUDIT_SERVICE_POLICY`; **no user path** | `platform_query.executed` (service) | Audit-X adds a human path (§9) |
| Billing, Payment, File, Notification | their APIs | service token (+ Payment payer / Billing user relations) | domain actions | unchanged; no staff authority |

## 5. Findings

| # | Finding | Evidence | Resolution |
|---|---|---|---|
| F1 | ADR-0042's human path is implemented and answers delegated-human identity | `organization-service/src/admin/*`, `auth/grants.service.ts` | foundation (ADR-0050 decision 1) |
| F2 | Only operators can be suspended; a member cannot | `operator-admin.service.ts:46` `setBlocked` | Stage 19.2 |
| F3 | No standalone administrative session revocation | `refresh-token.service.ts` callers | covered: suspension revokes |
| F4 | Operator step-up (ADR-0042 A.1) is not built; operators are refused organization creation | `admin.controller.ts:137`; `STEP_UP_METHODS` holds owner purposes only | D4 deferred; D7 gate |
| F5 | No human can read Audit | `audit-service/src/query/*`; ADR-0049 A36b | Audit-X, Stage 19.3 |
| F6 | No operator capability sets | `grants.service.ts` facts | not needed in Stage 19 |
| F7 | Organization lifecycle is undecided | ADR-0042 decision 3, BD-5 | out of Stage 19 |
| F8 | Staff financial relations are undecided; ADR-0007's admin cash confirmation is not implemented | B-026, O-18 | out of Stage 19 |
| F9 | ADR-0033, ADR-0041, ADR-0025 and ADR-0027 were Proposed although code and accepted ADR-0042 rely on them | ADR index | **all Accepted** (D1 + R1, §14.1) |
| F10 | Service-token rotation and revocation are undecided | ADR-0042 decision 10 | production prerequisite |
| F11 | The ADR-0017 CLI secret-key force-reset **does not exist**, yet ADR-0025, ADR-0027 and the auth security review cite it as an available path | `auth-service/src/cli/main.ts` (commands: `bootstrap-owner`, `reseal-totp-keys`, `check-totp-keys`, `hierarchy-*`) | **R1 resolved**: option (a), ADR-0050 decision 14 (§14.1) |
| F12 | A member can belong to organizations of several Companies, while `isActive` is global | migrations `0007`, `0009` | D5 eligibility rule (§6.2) |
| F13 | Audit records carry no Company or Platform, so `read_platform` spans every Company | `audit_record` columns (migration `0001`); `query.service.ts:77` | Audit-X scope (§9) |
| F14 | `JWT_SECRET` is a single HS256 key with no key ring; rotation invalidates every session | `config/app-config.ts:187` | production prerequisite P-S6 |

## 6. Security administration

### 6.1 Capabilities

| Capability | Exists? | Owner | Stage 19 |
|---|---|---|---|
| Suspend or restore an **operator** | yes (block / unblock) | Auth | unchanged |
| Suspend or restore a **member** (revoking every session) | no | Auth | **19.2** |
| Minimal security-status read of an eligible account (id, kind, active) | no | Auth | **19.2** |
| Revoke sessions without suspending; force credential reset of another user; temporary lock; account deletion | no | Auth | out (suspension covers revocation; deletion waits for P-A3) |

### 6.2 Member suspension rule (D5, approved)

```text
authenticated owner (Auth guard: live, tier = kind)
   ├── current owner authority          owner row → companyId (persisted)
   ├── factor step-up                   purposes account.suspend / account.restore, TOTP or passkey only
   ├── target is a member               "user".kind = 'member'
   └── same Company                     ≥1 ACTIVE membership in an organization of the owner's Company
                                        AND no ACTIVE or PENDING membership in any other Company's organization
                                        (membership → organization → platform → company, read in the mutation's transaction)
          ▼
   isActive := false  +  revoke every session family  +  account.disabled audit intent   (one transaction)
```

- **The rule is the strict reading of "the member belongs to the owner's Company".** Suspension is global, so a member who also
  belongs to another Company is refused; otherwise one owner would act on another Company. Such a member stays reachable through the
  existing organization-scoped membership revocation. **No one can suspend a multi-Company member in V1:** this is recorded as a
  consequence, not solved by a super-admin.
- **Why:** Company-scoped authority must not produce cross-Company denial of access. Company-specific access disabling (disabling a
  member's access to one Company without disabling the global identity) is a **separate future architecture concern**. Stage 19 does not
  redesign membership or add it.
- **Refused:** a member with no active membership in the owner's Company, a member of another Company, the owner themselves, and any
  owner. A body field naming a Company or scope is ignored, never trusted.
- **Idempotent:** suspending a suspended account, or restoring an active one, succeeds and writes nothing (no audit event).
- **Concurrency:** eligibility and the state change are one transaction, with the user row locked. A join approved concurrently in
  another Company is either seen, which refuses the suspension, or ordered after it. Stage 19.2 proves this with a real-PostgreSQL test.
- **Operators:** block / unblock stays exactly as built: owner, own Company, no step-up, sessions revoked.

### 6.3 Reason codes (D6, approved: closed set)

The repository has **no** existing suspension-reason vocabulary: operator block carries none, and refresh-token reasons are
session-mechanics codes. It does have the pattern: `code` fields with closed `values` in the catalog, for example
`hierarchy.admin_operation_denied.reason` and `file.integrity_incident.reason`. Each candidate was checked against a real Stage 19 use:

| Code | Stage 19 use | Kept? |
|---|---|---|
| `compromised_account` | the account itself is suspected or known to be taken over (F2's driver) | **yes** |
| `security_incident` | precautionary containment during an incident, without evidence that this account is compromised | **yes** |
| `policy_violation` | the account holder misuses the platform across the Company's organizations | **yes** |
| `owner_request` | rejected: the actor is always the owner, so it says nothing | no |
| `other` / free text | rejected: an unbounded proxy for notes | no |

The code is **required** on member suspension and **absent** on operator block (an unchanged emergency control) and on restoration.
Support notes never enter central audit; a future case system is a separate concern.

### 6.4 Security is not commercial state

Suspension is Auth security state (`isActive`). Billing, subscription, entitlement or payment state never represents it, and it is
never used for commercial expiry (ADR-0026, ADR-0038). Billing never suspends an identity; Auth never reads entitlement.

## 7. Organization, ownership and membership

- **Existing:**
  - the owner creates and edits Platforms and Organizations, with a step-up for create;
  - operators edit organization metadata on assigned Platforms, manage join codes and approve, reject or revoke memberships there;
  - operators are refused `organization.create` (no step-up exists) and administrator invitations;
  - organization administrators edit metadata and manage their organization's onboarding;
  - the owner grants and revokes organization-admin.
- **`ownership_event` is not "organization ownership":** it is the hierarchy-authority migration ledger (ADR-0039, ADR-0040).
- **D4:** operator organization creation is **deferred**. No required Core workflow needs it, and existing onboarding is unchanged.

## 8. Commercial and payment boundary: closed

Stage 19 introduces **none** of the following:
- manual subscription grants, sponsorship or prepaid redemption;
- entitlement overrides or payment-success overrides;
- pricing administration or seat management;
- manual settlement or staff financial access.

These belong to Commercial V2 or the authoritative commercial services. No Stage 19 component receives another service's database
credentials.

## 9. Audit administration: Audit-X (D3, approved)

Nobody can mutate evidence. The runtime role has INSERT and SELECT only, and retention is a separate owner-policy path.

```text
Company owner ── own bearer ──► audit-service (human read route, Stage 19.3)
                                   ├── Auth /auth/me with the owner's bearer: live, kind = owner
                                   ├── Auth GET /auth/admin/organizations/:id with the owner's bearer
                                   │       200 only if the organization's Platform belongs to the owner's Company; else a collapsed 404
                                   ├── rate limit (per human)
                                   ├── read: records WHERE organizationId = :id   (never the null organization)
                                   └── self-audit, SAME transaction: platform_query.executed { actor: user owner, target: organization }
                                          (cannot be recorded → nothing returned, 503)
```

**Exact scope:**
- **Company → Platform → Organization** is resolved by Auth from persisted state (`organization → platform → company`,
  `platform-access.service.ts:61-63`), with the owner's own bearer. The owner never supplies the Company.
- The owner reads **one organization of their own Company per request**.
- **Not available to owners:**
  - platform-level records (`organizationId` null: `owner.*`, `operator.*`, `account.*`, `company.*`, `platform.*`,
    `platform_assignment.*`, `platform_query.executed`, `hierarchy.*`);
  - unfiltered cross-organization sweeps.

  Audit cannot attribute these to a Company, so owners reading them could expose another Company. They stay `read_platform`
  (service-only). Widening them needs Company attribution in the audit contract: a future ADR-0049 amendment, **not** Stage 19.
- **Bounds (Stage 18, unchanged):**
  - the platform-scope window, at most 31 days per request, which is `platform_query.executed.window_days`;
  - at most 100 records per page (`MAX_LIMIT`), with cursor paging;
  - validated filters;
  - a rate limit, keyed per human on this path.
- **No operator reads**, and no step-up: reads are not step-up operations (ADR-0025). The read is self-audited, and fails closed if the
  self-audit cannot be written.
- **Known limitation (deferred architecture question, not solved by weakening scope):** central records with no organization, including
  the `account.*` evidence of suspensions, cannot be exposed to a Company owner under this organization-scoped model. No Company field is
  added to Audit in Stage 19.
- **Hierarchy authority:**
  - **Before the ADR-0039 cutover,** Auth's organization table is the hierarchy authority.
  - **After it,** Auth's organization lookup must still answer for every organization. Stage 19.3 verifies this against ADR-0040's
    reference model before it relies on the lookup. If the lookup cannot answer, Stage 19.3 stops and reports.
- **Preserved from Stage 18:**
  - organization isolation (a record never leaves its organization's scope);
  - query validation;
  - fail-closed self-audit, in the same transaction as the read;
  - the service-token paths, unchanged;
  - ingestion, which never calls Auth.
- **ADR-0049 amendment:** it is carried by ADR-0050 decision 6 and takes effect on acceptance.
  - **A36b:** Audit calls Auth only, on this path only.
  - **A6:** Stage 19 is a human reader verified by Audit, not an admin backend.
  - **A57:** the self-audit names the verified human.

## 10. Recommended architecture: A (existing services, direct verified-human administration)

```text
Owner / operator / org admin (own Auth bearer; a future admin UI is only a client)
        │
        ▼
Authoritative target service (Auth · organization-service · Audit)
        │  1. authenticate through Auth, live: account active, session active, tier = kind
        │  2. authority facts from Auth or its own state: owner Company · operator assignments · org-admin memberships
        │  3. scope from persisted state; never from a header, body, correlation or causation id
        │  4. decide authority ITSELF for the named operation; no kind allows everything
        │  5. sensitive? verify and consume a step-up through Auth: single-use, bound to session and purpose, ≤ 15 min
        │  6. mutate its own state + durable audit intent (actor = the verified human), SAME TRANSACTION
        ▼
     outbox → relay → RabbitMQ → audit-service → audit_record
```

- **Who authenticates the human:** Auth.
- **Who issues delegated proof:** nobody. The bearer is the proof, and Auth issues and consumes step-ups.
- **Who verifies, and who decides:** the target, every time.
- **Staleness:** none. Every use is re-checked live.
- **Target unavailable:** the request fails and nothing is half-done. Operations are state-idempotent.
- **Asynchronous follow-ups:** they run after commit through the outbox, and never undo the protection.

**New deployable Stage 19 admin service: NO.** With Audit-X there is no proxy, and no Core V1 requirement needs composition. A future
admin UI backend or BFF would be presentation infrastructure only: no authority, no rules, no state. It forwards the human's own
bearer, and it is not created in Stage 19. **No god admin database:** no component writes, or reads, another service's database.

## 11. Threat model

| Threat | Existing defense | Stage 19 action | Deferred control |
|---|---|---|---|
| stolen operator account | code login bound to a verified contact; shift ceiling; owner block | operators get no new security interventions (D7) | operator independent factor (P-S1) |
| stolen owner account | MFA; factor-only step-up for privilege grants; cool-down recovery; new-device alerts | suspension and restoration need a **factor** step-up | recovery surface per ADR-0050 decision 14; forgotten-password gap (P-S4) |
| compromised admin backend / UI | no backend holds authority | none | admin network reachability (P-S3) |
| forged identity (headers, body, `x-user-kind`, correlation) | ignored or refused (ADR-0033; Stage 18 spoof tests) | spoof tests on every new route (19.4) | none |
| replayed or cross-scope proof | no delegation token exists; step-up is single-use and bound to session and purpose | same | signed delegation, if ever |
| suspended user with a live token | live guard, live `/auth/me`, live grants | suspension revokes sessions in the same transaction | none |
| capability escalation (operator → owner) | database kind; tier = kind | explicit holder per operation | operator capability sets |
| cross-Company escalation | Company anchors in the database | D5 exclusive-membership rule; Audit-X per-organization scope | Company attribution in audit |
| service-token misuse | per-target policy; deny by default; `allowedPlatforms` | none | rotation (P-S2); broker identity (P-A1) |
| excessive PII to support | no support role | minimal projections only | none |
| unaudited privileged mutation | same-transaction intent; contract fails closed | every new mutation audited in its transaction | none |
| audit tampering | no route; INSERT / SELECT only; trigger | none | backups (P-A7) |
| direct database intervention | database per service; least privilege | no cross-service credentials | DBA access policy (P-S4) |
| concurrent admin mutations | conditional updates; row locks | locked eligibility + state change (19.2) | none |
| CSRF / browser | bearer tokens, no cookies (ADR-0002) | none | UI decision (ADR-0041 decision 6) |

## 12. Final proposed Stage 19 audit changes (not implemented)

All changes stay additive under contract version 1: A50, the Stage 18 G1 to G5 precedent. None is implemented in 19.1.

**`account.disabled`**
- **Owning service:** Auth.
- **Current semantics:** an owner blocks an operator. Actor `user: owner`; organization none; resource `user`; changes NONE.
- **Proposed semantics:** an owner suspends an **operator or member** account of the owner's Company.
- **Actor:** user `owner`, the Auth-verified database kind.
- **Scope:** organization `none`, since an account is global.
- **Reason / changes:** an optional `reason`, a closed code set (`compromised_account`, `security_incident`, `policy_violation`). It is
  present on member suspension and absent on operator block.
- **Why required:** F2, D5, D6.
- **Substage:** 19.2.

**`account.enabled`**
- **Owning service:** Auth.
- **Current semantics:** an owner unblocks an operator.
- **Proposed semantics:** an owner restores an operator or member account of the owner's Company.
- **Actor:** user `owner`.
- **Scope:** organization `none`.
- **Reason / changes:** none (NONE unchanged).
- **Why required:** D5.
- **Substage:** 19.2.

**`platform_query.executed`**
- **Owning service:** audit-service.
- **Current semantics:** a trusted service read with the platform scope.
- **Proposed semantics:** also a **human owner's** read of one organization of their Company.
- **Actor:** `service` **or user `owner`**. The actor widens; the owner is the Auth-verified human.
- **Scope:** organization `none`, unchanged. The record stays platform-level.
- **Reason / changes:** unchanged (`target` = `organization` for the owner path, `window_days`, `result_count`, `page`, `filtered`).
- **Why required:** D3; A57's "who read".
- **Substage:** 19.3.

No generic `admin.*` action. No new action for suspension: the semantic action exists. Denied suspension attempts are recorded in
Auth's local audit (`auth_audit_event`), as the operator block is today. Central denial evidence is reviewed in 19.4, not assumed.

## 13. Final Stage 19 roadmap (frozen, derived from 19.1 evidence)

> **Progress** (updated as substages close; the roadmap below is unchanged):
>
> | Substage | Status |
> |---|---|
> | 19.1 Architecture & Decisions | ✅ PASSED |
> | 19.2 Owner Account Security Administration | ✅ PASSED, merged: [Stage 19.2 record](./stage-19-2-owner-account-security-administration.md) |
> | 19.3 Audit-X | ✅ PASSED, merged: [Stage 19.3 record](./stage-19-3-audit-x.md) |
> | 19.4 Security & Privacy Hardening | ✅ PASSED, merged: [Stage 19.4 record](./stage-19-4-security-privacy-hardening.md) |
> | 19.5 Operational Hardening | ✅ PASSED on its branch, awaiting review: [Stage 19.5 record](./stage-19-5-operational-hardening.md) |
> | 19.6 Focused Certification & Closure | ⏳ |

The ordering the brief suggested was checked against the evidence and rejected where the evidence contradicts it:
- **Foundation:** the verified-human foundation already exists (Auth's own guard; organization-service's human path).
- **Operator step-up and capabilities:** no Stage 19 substage gives operators new sensitive authority (D4, D7), so they are **not** Stage
  19 substages. They are a gate that must be completed before any future stage grants such authority.
- **Organization / platform administration:** exists (ADR-0042). Lifecycle is deferred.

The roadmap is therefore:

| Stage | Purpose | Services | Runtime changes | Schema changes | Audit changes | Security concerns | Depends on | Exit criteria |
|---|---|---|---|---|---|---|---|---|
| **19.1** | investigation, decisions, ADR-0050 | none | none | none | none | none | none | **met**: all decisions resolved; ADR-0050 Accepted; awaiting review and merge |
| **19.2** | **owner account security administration**: member suspend / restore; operator path unchanged; minimal status read | Auth | owner routes, e.g. `POST /auth/admin/accounts/:id/suspend` · `/restore` and `GET /auth/admin/accounts/:id`; step-up purposes `account.suspend` / `account.restore` (factor only); eligibility per §6.2 | **none**: reuses `isActive` and session revocation | `account.disabled` / `.enabled` catalog correction; `reason` code | cross-Company refusal; body scope ignored; self and owner refused; idempotency; concurrency with joins | 19.1 | real-PostgreSQL E2E for authority, scope, spoofing, idempotency and concurrency; live effect in Auth, Billing, Payment and organization-service on the next request; audit atomicity (a failed intent rolls back); mutations killed |
| **19.3** | **Audit-X**: owner reads one organization's evidence | audit-service (+ Auth, read-only calls) | human read route; Auth verification (a kit-level human-verification client if shared); per-human rate limit | none (rate-limit rows use the existing table) | `platform_query.executed` actor widened; ADR-0049 amendment effective | never another Company; never null-organization records; fails closed without Auth; service paths unchanged | 19.1 (ADR-0050 Accepted); the §9 lookup check | cross-Company refusal proven; the self-audit names the owner; an unrecorded read returns nothing; Auth down → 503; the Stage 18.6 query suites pass unchanged |
| **19.4** | **security and privacy hardening** | Auth, audit-service, organization-service | tests; fixes only if a gap is found | none | review of denial evidence (local vs central), with a stop-and-ask before any new action | spoof suites across every human admin route; minimization of projections; each §11 row proven or explicitly deferred | 19.2, 19.3 | every §11 row has evidence or a named owner; no header identity accepted anywhere |
| **19.5** | **operational hardening** | Auth, audit-service | signals for suspensions and human evidence reads (counters and structured logs, no PII); log budgets | none | none | Auth-dependency behavior; rate-limit exhaustion | 19.4 | failure matrix (Auth down, Audit down, broker down) proven; signals documented for P-A4 / P-S5 |
| **19.6** | **focused certification and closure** | all touched | none | none | none | none | 19.5 | the Stage 18.10 pattern: regression, mutation campaign, closure record |

## 14. Owner decisions

### 14.1 D1: historical ADRs (verified 2026-09-26)

**ADR-0033: Service-to-service authentication, and how services identify the end user**
- **Status before:** Proposed.
- **Runtime relies on it:** YES. **Conforms:** YES.
- **Evidence:**
  - kit `service-token.ts`: `SERVICE_TOKENS=<caller>:<sha256>`, at most two per caller;
  - `service-token.guard.ts`: `timingSafeEqual` over every digest, one generic 401, `serviceCaller` attached;
  - no local JWT verification outside Auth;
  - user bearers are forwarded only to Auth (`auth-client.ts`, `auth-grants-client.ts`).
- **Historical header statements:** "the callee side exists nowhere" and the `PAYMENT_SERVICE_TOKEN` caller (removed in `f1901f9`).
  These are recorded in a dated note, not rewritten.
- **Payment webhooks:** authenticated by provider signature (payment SDD §7), never by reachability.
- **→ Accepted.**

**ADR-0041: Administrative capabilities are domain-owned, client-neutral APIs**
- **Status before:** Proposed.
- **Runtime relies on it:** YES. **Conforms:** YES.
- **Evidence:**
  - administrative capabilities sit in Auth and organization-service;
  - no admin service and no composition layer exist;
  - no client-type or install-id gate (the User-Agent fingerprint is alert-only);
  - guardrail 7 holds: Auth makes no synchronous call to organization-service.
- **"Not decided here" items:** since decided by ADR-0042 (BD-4). Recorded in a dated note.
- **→ Accepted.**

**ADR-0025: Owner login with password + second factor; secret key as step-up and recovery credential**
- **Status before:** Proposed. **Now:** Accepted (2026-09-26, after R1).
- **Runtime relies on it:** YES. **Conforms:** PARTIALLY before R1; YES after the R1 amendment.
- **Conforming:**
  - `/auth/login` returns `mfa_required`, `enrollment_required` or `recovery_required` for owners;
  - TOTP / passkey factors;
  - `owner_step_up`, capped at ≤ 15 min by a CHECK, and single-use;
  - `x-step-up-token`;
  - factor-only purposes refuse the secret key;
  - new-device alerting;
  - block / unblock without step-up.
- **Drift explained by later ADRs:** recovery (ADR-0027); `platform.create` is hosted by organization-service, not Auth (ADR-0042);
  more purposes (ADR-0028, ADR-0029, ADR-0042).
- **Obsolete statement:** "TOTP / WebAuthn validity is service logic not yet implemented".
- **Unimplemented behavior it asserts:** "ADR-0017: unchanged behavior. The reset CLI still overwrites the secret key…", and its
  recovery section names that CLI as the path for "key leaked, factors intact".
- **→ Accepted after R1** (amendment note + acceptance note; no decision changed).

**ADR-0027: Service-layer security model**
- **Status before:** Proposed. **Now:** Accepted (2026-09-26, after R1).
- **Runtime relies on it:** YES. **Conforms:** PARTIALLY before R1; YES after the R1 amendment.
- **Conforming:**
  - cool-down recovery `start` / `complete` / `cancel` (`RECOVERY_COOLDOWN_SEC`, default 24 h);
  - the enrollment rules;
  - the live guard (HS256, issuer and audience pinned, `isActive`, tier = kind, session);
  - migration `0003` state;
  - the secrets loader (`NAME` / `NAME_FILE`, no defaults, the five secrets, the TOTP key ring);
  - step-up token = row id;
  - refresh reuse detection.
- **Obsolete:** §6 "PaymentClient is an injected port" (removed in `f1901f9`); the open question on the registration license check
  (resolved by removal).
- **Unimplemented behavior it asserts:** Costs names "ADR-0017's CLI reset covers the key" as the ops path when the cool-down is
  unacceptable.
- **→ Accepted after R1** (amendment note + acceptance note; no decision changed).

**R1, the discrepancy that held D1 for ADR-0025 and ADR-0027 (now resolved):**

- **ADR:** ADR-0025 (§"What this amends", and its Recovery bullet) and ADR-0027 (Consequences, Costs). Also the auth security review,
  `docs/security/auth-service-security-review.md:75`.
- **Expected:** an ops CLI that force-resets an owner's secret key and revokes sessions (ADR-0017, itself **Proposed**).
- **Actual:** no such command. The Auth CLI has `bootstrap-owner`, `reseal-totp-keys`, `check-totp-keys` and `hierarchy-*`. The
  "key leaked, factors intact" case is covered in-band: `owner.secret_key.rotate` with a TOTP or passkey step-up.
- **Difference:** two ADRs, and a security review, describe an emergency path that does not exist. The "owner lost everything and the
  cool-down is unacceptable" case has no tool; only direct database access remains.
- **Risk:** accepting the ADRs would record a non-existent recovery control as accepted architecture, and production runbooks could
  rely on it.
- **Recommended resolution:** the owner chooses one of three.
  - **(a) Recommended.** Record, in a new ADR or a dated note on ADR-0017, that the force-reset CLI is **not built and not planned for
    Core V1**. The in-band rotation covers a leaked key, and cool-down recovery covers lost factors. Then accept ADR-0025 and ADR-0027
    with pointer notes, and ADR-0050 after them.
  - **(b)** Build the CLI in a later stage, keep ADR-0025 and ADR-0027 Proposed until then, and accept ADR-0050 now with that
    dependency noted.
  - **(c)** Keep all three Proposed.

  ADR-0050 does not depend on the CLI. Its break-glass path is the cool-down recovery, which exists.

**R1 decision (owner, 2026-09-26): option (a).** It is recorded as ADR-0050 decision 14.
- **The CLI:** never implemented; not part of Core V1; not built by Stage 19; no new privileged recovery CLI.
- **Leaked key:** in-band rotation with a TOTP or passkey step-up.
- **Lost factors:** the cool-down recovery, which is the extreme path.
- **Direct database manipulation:** not an approved recovery procedure.

History is preserved. Dated "Amended by ADR-0050" notes were added to:
- **ADR-0017**, whose status stays Proposed and whose index row records the CLI withdrawal;
- **ADR-0025** and **ADR-0027**;
- `docs/sdd/auth-service.md`, the reset-script paragraph;
- `docs/security/auth-service-security-review.md`, the recovery table.

After the amendment, re-evaluation found **no other substantive discrepancy**. What remains are historical statements explained by
later ADRs (ADR-0033, ADR-0042, ADR-0044 / B-035, ADR-0046), and each acceptance note lists them.

**Consequence recorded (P-S4):** an owner who has lost the **password** has no approved recovery in Core V1, because recovery needs
password + key. This follows from the owner's decision; it is not a new capability.

### 14.2 D2 to D7 (approved by the owner, 2026-09-26; recorded in ADR-0050, Accepted)

| # | Decision | Rationale |
|---|---|---|
| D2 | **Verified-human authority accepted.** Own bearer; the target authenticates and authorizes; no header identity; service ≠ human; no delegation token in Core V1 | F1; no key material or replay surface; no proxy that can forge humans |
| D3 | **Audit-X**, owner-only, **one organization of the owner's Company per request** (§9) | the actual human is in the evidence; no trusted proxy; F13 bounds the scope |
| D4 | **Operator organization creation: DEFERRED** | no required Core workflow needs it; existing onboarding unchanged |
| D5 | **Member suspension: owner only + factor step-up + same Company** (exclusive-membership rule, §6.2) | F2; F12 makes "same Company" precise |
| D6 | **Closed reason codes** `compromised_account`, `security_incident`, `policy_violation`; no free text | §6.3 |
| D7 | **Operator security intervention: operator step-up required first**; current onboarding unchanged | no independent factor (F4) |

## 15. Production prerequisites

- **Carried from Stage 18, still open:**
  - P-A1 per-service broker identity;
  - P-A2 retention durations;
  - P-A3 erasure policy;
  - P-A4 alert routing;
  - P-A5 Auth raw-IP retention;
  - P-A6 RabbitMQ in production;
  - P-A7 audit backups;
  - DLQ access control;
  - the retention password and scheduler.
- **P-A8 restated:** real `AUDIT_SERVICE_POLICY` entries for **products**. There is no longer a "Stage 19 admin service" reader, since
  owners read through Audit-X.
- **Added by Stage 19, all open; none is resolved here:**

| # | Prerequisite | Owner |
|---|---|---|
| P-S1 | operator step-up with an independent factor, **before** any operator receives a sensitive capability | security / owner |
| P-S2 | service-token rotation and revocation (ADR-0042 decision 10) | security / operations |
| P-S3 | administrative network reachability (ADR-0041 decision 6) | infrastructure |
| P-S4 | a privileged-account security policy: owner factor hygiene; the cool-down value; the forgotten-password gap (no approved path in V1, since direct database manipulation is not approved); DBA access | owner |
| P-S5 | monitoring and alert routing for suspensions and human evidence reads (joins P-A4) | operations |
| P-S6 | `JWT_SECRET` rotation: a single HS256 key, so rotation ends every session (F14; ADR-0027 open question) | security |

## 16. Not in Stage 19

- organization lifecycle;
- ownership transfer;
- staff financial access and every commercial or settlement mutation (§8);
- Notification / File administration;
- break-glass;
- support cases and notes;
- operator step-up and operator capability sets (a gate, P-S1);
- Company attribution in audit records;
- product administration (Drive, ERP, School, AI);
- release management (Stage 20);
- an admin UI or BFF;
- Final Core Validation.
