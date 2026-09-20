# Stage 10: client-neutral cross-service audit

- **Status:** read-only architecture audit. It changes nothing, decides nothing, and implements nothing. No client technology is chosen.
- **Date:** 2026-09-20
- **Baseline:** `main` at `6e7ddcc`.
- **Classification vocabulary** (used in the matrices): `SAFE` no action needed; `CLARIFY` wording or documentation should be made precise; `DEFER` a decision that stays open on purpose; `BLOCKER` prevents the client-neutral principle from holding; `CHANGE REQUIRED` a code or design change is needed now. **No item in this audit is a BLOCKER or CHANGE REQUIRED for client neutrality.**

## 1. Baseline

Phase 0 verification of the prior Stage 10 work (all verified from the files, not from the previous reports):

| Check | Result |
|---|---|
| ADR-0041 status | **Proposed**, "draft; not approved" |
| ADR-0040 status | **Proposed** |
| ADR-0039 | no diff against `HEAD` |
| Any Stage 10 ADR set to Accepted | none |
| Runtime, migrations, infra, CI, compose | fingerprint identical to the previous task's baseline |
| Pre-existing uncommitted work and both stashes | present and untouched |
| ADR-0041 conformance review | reviewed once: no blockers, four SHOULD FIX items; I applied them afterwards, and **those edits were not re-reviewed** |
| Tauri made the final client? | no; the only pattern matches are the rejected alternative "only Tauri may call this" |
| Browser administration made mandatory? | no |
| Operator administration locked to Tauri? | no |
| Offline licensing or device authorization made an implemented requirement? | no; they appear only as open, deferred or guardrails |

## 2. Relationship to ADR-0041

[ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Proposed) states the principle. This audit **tests it against the repository**: does anything already built or designed contradict it, or hide a client assumption? The answer is in section 20. The audit proposes no new ADR: nothing it found requires a decision that ADR-0040, ADR-0041 or the already-identified BD-4 ADR does not cover.

## 3. Client-neutral principle

> Core business capabilities must be client-neutral. Administrative clients are replaceable delivery mechanisms, not business authorities.

Test applied to every service: **could a different client, with a different UI technology, call the same API unchanged and get the same authorization outcome?** Evidence was searched for four failure modes: (a) client type used in authorization or trust; (b) a client or device concept quietly standing in for a user or session; (c) authorization taken from client-supplied `role`, `permissions`, `organizationId`, `platformId`, `userId`; (d) licensing, device or offline responsibilities landing in a service that should not own them.

**Cross-cutting evidence (all services):**

- The complete set of request headers read anywhere in service or kit source is: `authorization`, `idempotency-key`, `x-step-up-token`, `x-forwarded-for` (only behind an explicit trust-proxy flag), `user-agent` (server-observed, alert-only), the request and correlation ids, and a provider signature header. **There is no client-type, app, install or device header anywhere.**
- No service reads `role`, `permissions`, `adminTier` or a client type from a request body for authorization.
- Bearer tokens over plain HTTP/JSON (ADR-0002); CORS is off unless exact origins are allow-listed and is a shared kit setting, not domain logic.

## 4. Auth findings

**Verdict: client-neutral. SAFE, with two CLARIFY items and one DEFER.**

| Question | Evidence | Result |
|---|---|---|
| Is `User = Device`? | `refresh_token` has `userId`, `tokenHash`, `familyId`, expiry and ceiling only; no device or client column | no |
| Is `Session = Device`? | a session is a refresh-token **family** (`sid`); each login creates a new family and **no login flow revokes the others** (verified across `auth.service.ts`, `owner-auth.service.ts`, `operator-code.service.ts`); sessions end only by logout, refresh-reuse detection, owner password change (other sessions), owner recovery, or operator block | no; a user can hold several concurrent sessions |
| Is `Browser = User`, `Tauri = Operator`, `Client type = authorization or trust`? | the guard takes `kind`, `role` and `isActive` from the **database**, requires the token's `adminTier` claim to agree, and requires the session family to be live (`auth.guard.ts`); `@Actors('owner'\|'operator'\|'member')` keys off user kind; the User-Agent is used only to hash a weak "new device" alert and is "a weak signal, never an authentication factor" (ADR-0025) | no |
| Operator authorization | live, from an active `PlatformAssignment`; block and unblock (owner-only) take effect on the next request | client-independent |
| Service tokens | per caller-callee pair, identify a service, never a user | unaffected by client choice |
| `/auth/me`, onboarding, join codes, invitations, membership checks | bearer or code based, resource-derived scope, live checks | client-independent |

**Can `User → {Browser session, Tauri session, future session}` exist without changing identity ownership?** **Yes, today.** Identity stays in `user`; each client login is a separate session family; authorization depends on the user, never on which family. Nothing to change.

**How device authorization could exist in addition to, not instead of, user identity** (not designed, not decided): the principal remains the authenticated user. A device would be an *additional*, optional, server-evaluated condition attached to a session or to a credential the user registers (a device credential is credential-like and therefore Auth's domain, ADR-0031; a device seat or license is an entitlement, billing's, ADR-0038). The authorization question stays "may this user act on this resource", with "from a registered device" as an optional extra term. The user is never replaced.

| # | Finding | Class |
|---|---|---|
| A-1 | The `device` table (`installId`, model, OS, app version, locale, `userId`) is mobile-shaped and **no code reads or writes it**. It is a latent, unused device model; nothing should build on it implicitly | **CLARIFY** (document as unused before any device work) |
| A-2 | The owner "new device" alert hashes the normalized User-Agent. An owner who uses a browser and a desktop shell will see alerts for each; it is alert-only, so this is noise, not an authorization effect | **CLARIFY** |
| A-3 | **No session management API**: only `logout` (the current session). A user cannot list sessions or revoke one client's session; account-level revocation exists (block, password change, recovery). Future "device revocation" or per-client revocation would need session enumeration | **DEFER** (architecture should support it later; not required now) |
| A-4 | Registration by join code asks Payment `GET /payment/licenses/:organizationId/status` (ADR-0004, kept by ADR-0026). Payment implements **no such route** (0 matches in source; the compose file says so), so registration by join code fails closed (`404` becomes a refusal, an unreachable Payment a `503`). This is **not client-related** (every client hits it identically) but it is an entitlement-boundary gap that ADR-0038 already calls "a separate, additive Auth change and an open decision". Its current production effect was **not verified** here | **DEFER** (entitlement boundary) |

## 5. Organization findings

**Verdict: client-neutral. SAFE.**

- Organization-service exposes only service-token APIs (Stage 9); a caller is a **service**, so no client can exist at its boundary today. Parents are validated by foreign keys; a request cannot supply ownership context; unknown fields are refused. Nothing in its source mentions licensing, entitlement, lease, device or client type (0 matches).
- It contains **no UI-specific logic**: capability names are `companies`, `platforms`, `organizations` with create, read, list, update.
- The human-facing hierarchy administration API does not exist (F23, BD-4). Under ADR-0041 it would be client-neutral and organization-owned, using the existing pattern (authenticate through Auth, ask Auth about the caller, enforce isolation itself).

| # | Finding | Class |
|---|---|---|
| O-1 | Mutations are attributed to the calling **service** in log lines only; there is no durable actor record. A future human-facing API will need actor, session and service recorded durably | **DEFER** (with the human-facing API) |
| O-2 | "Internal only initially" (Stage 10.0, BD-7a) describes today's service-token exposure and must not be read as excluding administrative clients later | **CLARIFY** (already clarified in the client-model study) |
| O-3 | Stage 10 ownership migration (ADR-0039, ADR-0040) is independent of client type | **SAFE** |
| O-4 | Organization ownership does **not** imply licensing ownership: no entitlement, device or lease code exists there | **SAFE** (keep it that way; section 13) |

## 6. Billing findings

**Verdict: client-neutral. SAFE.**

- Authorization is `relationTo(invoice, caller)`: `producer` when the caller is the creating service (token), `payer` when the payer is a user and equals the Auth-verified user id; anything else is a collapsed 404. **Organization membership, seller staff and platform staff have no relation** (B-026, B-027, B-028), "and neither does an Auth administrator: Auth answers who someone is, never what they may do here".
- `organizationId` on an invoice is **asserted by an authorized producer service**, not by a client; whether it is valid is O-15 ("nothing verifies it"), an existing, client-unrelated open decision.
- No header or body field carries a role, permission or client type. History is durable: `billing_transition` records `actorType` (`user`, `service`, `system`), `actorId`, cause and `correlationId`.
- `entitlementKind` (`none`, `organization_license`, `user_subscription`) exists on products; the entitlement API is designed but **not built** (billing's own health test asserts entitlement routes do not exist yet).

| # | Finding | Class |
|---|---|---|
| B-1 | The billing SDD (R-11) says `/auth/me` "returns only the organization `id`"; the code returns names and platform data too. Stale statement, no impact on Billing | **CLARIFY** (documentation) |
| B-2 | No human staff or administrator relation to invoices exists, so there is no human administrative API for Billing to be client-neutral about | **DEFER** (B-026 to B-028) |

## 7. Payment findings

**Verdict: client-neutral. SAFE.**

- Five tables (`currency`, `idempotency_key`, `payment`, `payment_attempt`, `webhook_event`); routes are webhooks, create (service token), read (service or user), cancel (service token), start and sync an attempt (service or user). **No refund or cash route exists yet**, although one comment mentions refunds.
- `AuthorizationService` is "the ONLY place that establishes a caller's relation to a payment": producer by token, payer by verified user id. Webhooks are authenticated **only by the provider signature**, "never a service token or user bearer", over the exact raw bytes.
- Idempotency is header-based and scoped by caller. Attribution (actor, cause, correlation) is carried on **emitted events**; Payment has no durable history table equivalent to Billing's.
- No licensing, entitlement, lease or device code (0 matches). Payment authority is server-side.

| # | Finding | Class |
|---|---|---|
| P-1 | Attribution is on events only, not in a durable table; not a client concern | **CLARIFY** (audit representation, section 9) |
| P-2 | Human privileged operations (cash confirmation, refund step-up) are undesigned | **DEFER** (O-4, O-5, O-18, O-20) |

## 8. Accounting findings

**Verdict: not built; the design is client-neutral by construction. SAFE.**

Accounting is design only (`financial-architecture.md`, ADR-0035): chart of accounts, journal, ledger, fiscal periods, tax, reports; "posting into a closed period is rejected" is a server rule. The design contains **no human access model and no client assumption**. The only privileged-operation notes are "who may submit cash" and "refund step-up", listed under undecided policies. Nothing depends on a UI.

| # | Finding | Class |
|---|---|---|
| AC-1 | Privileged financial operations (period close, manual entries, refunds) will need server-derived actor, step-up evidence and audit; not designed yet | **DEFER** |

## 9. Audit findings

Audit-service is design only ("immutable central event history"; "every service: security and administrative events worth keeping → audit"; Auth keeps its **own** local audit and never depends synchronously on audit-service). What exists is local:

| Capability | Auth (`auth_audit_event`) | Billing (`billing_transition`) | Payment | Kit |
|---|---|---|---|---|
| actor / user | `actorId`, `targetId` | `actorType` + `actorId` | on events | n/a |
| session | `sessionFamilyId` | no | no | no |
| IP | `ip` | no | no | n/a |
| request or correlation id | in `metadata` only | `correlationId` | `correlationId` on events | `requestId`, `correlationId` |
| organization / platform | in `metadata` only | `organizationId` on the invoice; platform not recorded (only `platform_currency` configuration holds a platform id) | `organizationId` on the payment; platform not recorded | n/a |
| device / client type | no | no | no | no |

**Classification of the requested fields (not all must be implemented):**

| Field | Class | Reason |
|---|---|---|
| actor / user | **already supported** | Auth, Billing, Payment events |
| request / correlation id | **already supported** (kit, Billing, Payment); Auth records it only in free-form metadata | small additive gap, not required now |
| session | **architecture should support later** | Auth records it; other services cannot because `/auth/me` returns no session id; an additive field would suffice |
| organization, platform | **architecture should support later** | first-class fields in a central audit, derived from the resource server-side |
| device | **defer** | no device concept authorizes anything today; if ever recorded it is server-observed and informational, never client-asserted |
| client type | **defer, informational at most** | must never gate authorization; not required by any existing decision |
| IP | already supported (Auth) | server-observed |

**Privileged operator and owner actions are already audited in Auth** with actor, target, session family and IP: `operator.create`, `account.disabled` and `account.enabled` (operator block and unblock), `platform_assignment.grant` and `revoke`, `operator.login`, `operator.code.issued`, `owner.step_up`, `owner.login`, factor changes, recovery steps, and membership decisions. Client type and device identity are **not** required by any existing decision and are not mandated here.

## 10. File findings

File-service is design only ("file metadata, ownership, access control, lifecycle, storage port, limits, checksums"; "who may read it"). There is **no signed-URL or download-mechanism design** in any document. Access control belongs to the owning service by design, so nothing is client-shaped. **SAFE (nothing to audit yet).** Guardrail for when it is designed: any signed access mechanism must be independent of UI technology (a URL or token a server issues after a server-side authorization), so Tauri and a browser are just consumers. **DEFER.**

## 11. Notification findings

Notification-service is a **60-line starter** (a hello-world controller). Its design (delivery, templates, preferences, attempts, "why something was triggered" is *not* its concern) is event-driven: notification-triggering operations are authorized by the services that emit the events, asynchronously. No admin action lives here, and there is no UI leakage. **SAFE.**

## 12. Service-kit findings

**SAFE: technical infrastructure only.** Searches for client-, UI-, licensing- and device-shaped logic in the kit found nothing (two textual matches for "lease" are `release`). Its client-related settings are generic and technical: exact-origin CORS (off by default), request and correlation ids, bounded bodies, the service-token guard, and the `AuthClient` port. `check:repo` already forbids product terms and financial-domain declarations in the kit. One observation: the kit's `AuthIdentity` carries `id`, `adminTier`, `isActive`, `memberships` and **no session id**; this matters only if a later audit design wants sessions outside Auth (section 9). **Do not add abstractions for future clients.**

## 13. Entitlement and licensing findings

Not built. Where the concepts would live, from existing decisions:

```
 billing-service (ADR-0038: entitlement lives here; the entitlement API is designed, not built)
        │
        ▼  entitlement decision  { valid, expiresAt }
 Client/device authorization     ← ownership UNDECIDED (see below)
        │
        ▼
 Optional bounded offline lease  ← not designed; must satisfy the ADR-0041 guardrails
```

**Does any service accidentally own licensing, device registration, device authorization, leases, clock-rollback detection or client licensing?** No.

| Service | Licensing, entitlement, lease, device code |
|---|---|
| Organization | **none** |
| Payment | **none** (and it lacks the route Auth asks for) |
| Notification, kit | none |
| Auth | only the **registration-time organization-license check** (a consumer of an entitlement answer, deliberately kept by ADR-0026 item 4) and `requiresSubscription` on join codes; tokens carry **no entitlement claim** (`token.service.ts` says so) |
| Billing | the designed home: `entitlementKind` on products; the API is unbuilt |

**Organization ownership must not become licensing ownership merely because Tauri may be a client.** That holds today. The risk is future drift: a device *credential* is credential-like (pulls toward Auth); a device *seat* is an entitlement (Billing); a tenant-like framing pulls toward organization-service. **Unresolved question (DEFER):** which service owns "client/device authorization" between entitlement (Billing) and credential (Auth). Nothing existing decides it, and this audit does not.

## 14. Tauri implications

Analyzed for `Tauri → Core API`. **Tauri is a possible client; nothing here makes it mandatory.**

| Concern | Class | Note |
|---|---|---|
| Server authority | **existing architecture** | core architecture §6, ADR-0027 |
| Device identity | **future decision** | only if client authorization needs proof of possession; ADR-0010 currently makes fingerprints alert-only |
| Secure local storage | **implementation concern** | client design; the server assumes nothing |
| Local cache | **implementation concern**, constrained by "local state is never authoritative" | ADR-0041 guardrails |
| Bounded offline operation | **future decision** | departs from ADR-0004's fail-closed model and from live revocation |
| Offline lease | **future decision** | issuer and clock model undecided; cannot ride Auth tokens (ADR-0026, ADR-0038) |
| Clock-rollback detection | **implementation concern**, not a security boundary | guardrail C5 |
| Device revocation | **future decision** | today only account-level revocation exists (A-3) |
| Client update | **implementation concern** | not a Core concern |
| Tauri as the mandatory client | **not required** | |

## 15. Browser implications

For `Browser → Core API`, verified that a browser could be added later **without changing ownership, duplicating business logic, changing domain authorization, or creating browser-specific rules**: every service authorizes from the authenticated principal and server-side state, and tokens are bearer-based with `credentials: false`, so no cookie or CSRF model is needed. The only per-client work is **configuration**: exact CORS origins per service and, for passkeys, the WebAuthn relying party and https origins (TOTP is unaffected). Public exposure of any administrative surface stays a deployment decision (DEFER). Browser administration is not required.

## 16. Operator implications

Analyzed separately from organization administration. All four future states are compatible: `Operator API → Tauri`, `→ Browser`, `→ Tauri + Browser`, `→ Future client`. None is selected.

- **Server-side authorization:** live, from the database, on every request (active assignment, active account, live session, session ceiling of 8 hours). Independent of UI technology.
- **Privileged operations** (create, block, unblock, assign) are owner-only and audited with actor, target, session and IP (section 9).
- **Gap already noted:** no per-session enumeration or revocation (A-3), relevant only if per-client revocation is ever wanted. Operator-level revocation (block) exists and takes effect on the next request.
- Whether operator administration is browser-reachable or offline-capable stays deferred; the strongest security caution applies to operators.

## 17. Organization-admin implications

Likewise compatible with `Organization Admin API → Tauri | Browser | both | future`. Organization administration decomposes by owner: **membership administration is Auth's** (join codes, memberships, admin invitations, org-admin capability; live check); **hierarchy administration will be organization-service's**, but has no human-facing API yet (BD-4); **billing and payment administration by staff** is undesigned (B-026 to B-028). Product roles such as a consumer app's "Admin" or "School Admin" are the product's to map onto Core's owner, operator and org-admin capabilities and are never encoded in Core.

## 18. Security findings

For every sensitive operation the authorization basis is a **server-side context** (authenticated principal, membership or role from the database, scope derived from the resource, resource relation), never a client-supplied claim:

| Operation | Authorization basis | Client-supplied value trusted? |
|---|---|---|
| Owner factors, step-up, password, secret key | owner user from DB, live session, step-up token | no |
| Create, block, unblock operator | owner from DB; company from the owner's own row | no (company is not accepted from the body) |
| Grant, revoke platform assignment | owner from DB; platform-in-company checked in code | no |
| Join codes, memberships, admin invitations | authority derived from the resource: owner of the organization's company, active assignment on its platform, or active org-admin membership | no (organization is the resource; platform and company are derived) |
| Register, join, invitation consume | the code or invitation resolved server-side | no |
| Billing: create invoice, payment request | producer service token | `organizationId` is **asserted by the producer service**, unverified (O-15) |
| Billing, Payment: read | payer equals the Auth-verified user id, or the producing service | no |
| Payment: create, cancel | producer token | producer-asserted values, as above |
| Payment: start attempt, sync | verified payer, or producer for sync | no |
| Payment webhooks | provider signature over raw bytes | no |
| Organization-service: all | service token; parents by FK; idempotency scoped by caller | no |

**No violation of the "no client-supplied authorization" rule was found.** The one place a caller-asserted scope value is accepted is the **service-to-service** producer assertion of `organizationId`, an existing, documented, client-independent open decision (O-13, O-14, O-15). This audit does not resolve it.

## 19. Stage 10 implications

| Item | Result | Note |
|---|---|---|
| ADR-0039 | **SAFE** | unchanged; mechanism independent of client type |
| ADR-0040 (Proposed) | **SAFE** | no decision depends on a client; remains Proposed |
| ADR-0041 (Proposed) | **SAFE** | audit supports the principle; its no-cycle guardrail depends on ADR-0040's reference cache, as already stated |
| BD-1 and R2c reference cache | **SAFE** | verified: nothing on the `/auth/me`, onboarding or membership paths depends on client type |
| `/auth/me` | **SAFE** | returns identity plus memberships; client-neutral; frozen-contract rule stands |
| Onboarding, join codes, invitations | **SAFE** | code-based, resource-derived |
| Membership checks | **SAFE** | membership rows only |
| Operator authorization | **SAFE** | live DB, independent of client |
| BD-2, BD-3, BD-5, BD-6 | **SAFE** | unaffected |
| BD-4 and service-token authorization | **DEFER** | O-13, O-14, O-15, F23 stay open; not resolved here |
| BD-7 | **CLARIFY** | "internal only initially" is today's exposure, not a permanent exclusion |
| BD-8 | **CLARIFY** | administrative clients are intended consumers named in repository documents; still unverified in code |
| Organization Service ownership | **SAFE** | owns the hierarchy from cutover; owns no licensing or client concerns |
| Registration license check (A-4) | **DEFER** | entitlement-boundary gap, independent of Stage 10 |

**Domain ownership remains correct** (ADR-0041 decision 1): Organization Service for hierarchy administration (from cutover), Auth for identity and membership administration, Billing for billing administration and entitlement, Payment for payment administration, Accounting for accounting administration (design), Audit for audit (design). **No generic Admin Service is warranted.** An API gateway or BFF, if ever created, is an access and composition layer only: it may route, aggregate and adapt, and must hold no business rule, authority or state, because a component that decides "who may do what" is a new business owner. None exists today (the Auth ADD notes there is no gateway in front of Auth).

## 20. Findings matrix

| Service | Client-neutral? | Hidden client assumption | Security concern | Change required | Classification |
|---|---|---|---|---|---|
| Auth | Yes | unused mobile-shaped `device` table (A-1); UA-hash alert differs per client (A-2) | none in authorization; no session management API (A-3); registration license route missing (A-4, not client-related) | none now | **SAFE** (2 CLARIFY, 2 DEFER) |
| Organization | Yes | none | service-token API only; no durable actor record (O-1) | none now | **SAFE** (1 CLARIFY, 1 DEFER) |
| Billing | Yes | none | producer-asserted `organizationId` (O-15, existing) | none | **SAFE** (1 CLARIFY, 1 DEFER) |
| Payment | Yes | none | none client-related; attribution on events only | none | **SAFE** (1 CLARIFY, 1 DEFER) |
| Accounting | Yes (design only) | none | privileged-operation model undesigned | none | **SAFE** (DEFER) |
| Audit | Yes (design only) | none | session, organization, device fields not yet modeled | none | **SAFE** (DEFER, field taxonomy in section 9) |
| File | Yes (design only) | none | signed-access mechanism undesigned | none | **SAFE** (DEFER) |
| Notification | Yes (starter) | none | none | none | **SAFE** |
| Service-kit | Yes | none | none | none; do not add future-client abstractions | **SAFE** |
| Entitlement | n/a (not built) | none | ownership of client and device authorization undecided | none | **DEFER** |

## 21. Deferred decisions

Client technology per role; public exposure; offline for organization and operator; device identity and its owner (Auth credential versus Billing seat); the lease issuer and clock model; session enumeration and per-client revocation (A-3); the central-audit field taxonomy (section 9); the human-facing hierarchy API and its actor record (O-1, BD-4); the authorization question shape between organization-service and Auth (OD-8); service-token scopes (O-13, O-14, O-15); staff relations to billing and payment (B-026 to B-028, O-18, O-20); the registration license route (A-4); a gateway or composition layer. **None is decided or implied by this audit.**

## 22. Blockers

**None for client neutrality.** No BLOCKER and no CHANGE REQUIRED finding. The existing Stage 10.0 blockers (BD-4, BD-5 semantics, BD-7d, BD-7e, BD-8) are unchanged and unrelated to client type.

## 23. Recommended next step

1. The owner reviews **ADR-0040 and ADR-0041** together; both remain Proposed.
2. Write the **BD-4 ADR** (service-token scopes, hierarchy validation, human-facing hierarchy administration) on top of the client-neutral rule, including a durable actor record for hierarchy changes (O-1).
3. Two small documentation corrections when convenient: the stale `/auth/me` statement in the billing SDD (B-1), and a note that the Auth `device` table is unused (A-1).
4. **Before any Tauri, offline or device work**, decide session enumeration and revocation (A-3), the audit field taxonomy, and the ownership of client and device authorization; none is needed for Stage 10.
