# Stage 10: administrative client model study

- **Status:** architecture study. It **proposes**; it decides nothing that an existing ADR has not already decided. Nothing here is implemented, and no client technology is chosen.
- **Date:** 2026-09-20
- **Baseline:** `main` at `6e7ddcc`. The Stage 10 study, the Stage 10.0 decisions and ADR-0040 (Proposed) are preserved unchanged; this study relates to them in section 14.
- **Companion draft:** [ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md), status **Proposed**.
- **Status vocabulary:** `EXISTING` is decided by an ADR or a governing architecture document already in the repository (most ADRs still carry the header status "Proposed" and the project owner treats them as governing; that is not reopened here). `PROPOSED` is a recommendation awaiting the architecture owner. `DEFERRED` stays open on purpose. `BLOCKED` needs input this repository lacks.

## 1. Context

Stage 10 moves ownership of Company, Platform and Organization from Auth to organization-service ([ADR-0039](../../adr/0039-organization-ownership-and-cross-service-migration-authority.md), draft [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md)). The Stage 10.0 decisions left one question that touches people rather than services: **who creates and administers these entities after cutover, and through what** (BD-4, F23). A requirement clarified since then affects how that question, and every other administrative capability, may be answered.

## 2. Newly clarified requirement

Nawara may eventually have several administrative clients. These are **possibilities, not decisions**:

- Tauri is a possible client for organization administration; the client delivery decision remains open.
- A browser application is a possible client for organization administration, instead of or in addition to Tauri; the client delivery decision remains open.
- Tauri is a possible operator administration client; browser and other client models remain open.
- Platform and operator administration may be kept off a publicly exposed browser UI, but this is **not** a permanent architectural decision.

The durable rule this study proposes is about **API and service boundaries**, not today's UI technology:

> Administrative capabilities are exposed through secure backend APIs owned by the domain services. Tauri, browser and future clients are replaceable delivery mechanisms and stay open unless separately decided.

## 3. Current architecture

### 3.1 The repository already separates authority, capability and client

```
   Backend authority            Administrative capability            Administrative client
 (who owns the truth)          (operations over that truth)          (who consumes the API)

 organization-service  ─►  hierarchy administration (undesigned)  ─┐
 auth-service          ─►  identity, membership, operator admin   ─┼─►  Tauri | browser | future
 billing-service       ─►  billing state (service/payer only)     ─┤        (all OPEN)
 payment-service       ─►  payment state (service/payer only)     ─┘
 billing (entitlement) ─►  entitlement decisions (ADR-0038)
```

### 3.2 What exists today, verified

| Capability family | Owner | Where it lives today | Callers it allows |
|---|---|---|---|
| Owner factors (TOTP, WebAuthn), step-up, secret key, password | Auth | `auth/admin/factors*`, `step-up*`, `secret-key/rotate`, `password/change` | owner |
| Operator lifecycle: create, block, unblock | Auth | `POST auth/admin/operators`, `.../:id/block`, `.../unblock` | owner |
| Operator platform assignment: grant, revoke, history | Auth | `auth/admin/operators/:id/platform-assignments` | owner |
| Organization administration of **membership**: join codes, memberships (approve, reject, revoke, org-admin grant), admin invitations | Auth | `auth/organizations/:organizationId/...` | owner, operator, and members with the org-admin capability (live check) |
| Platform/organization lookups for authorization | Auth | `GET auth/platform-access/:platformId`, `GET auth/admin/organizations/:id` | owner, operator |
| **Hierarchy administration** (create, rename Company/Platform/Organization) | organization-service after cutover | **no human-facing API**; organization-service accepts service tokens only; Auth never had routes for it (F23) | none designed |
| Billing and payment state | billing, payment | `ServiceTokenGuard` (12 guard usages) and `ServiceOrUserGuard` (7 guard usages: producer service or the payer user) | services, payer; **no staff, seller or platform-staff relation is designed** (B-026, B-027, B-028) |

Two consequences. First, **administration is already domain-owned**: identity, membership and operator administration are Auth's because User, credentials, sessions and OrganizationMembership are Auth's ([ADR-0031](../../adr/0031-organization-service-intended-owner-of-the-hierarchy.md), [ADR-0030](../../adr/0030-multi-organization-membership-and-revoked-state.md)). Second, the gap is exactly the one Stage 10 exposes: **no human-facing API exists for the hierarchy**.

### 3.3 The authorization pattern already in the repository is client-neutral

[Core architecture §6](../core-architecture.md) (identity, organization context and authorization):

1. The client presents the user's bearer; a service asks Auth `GET /auth/me`, which verifies signature, session and account **live**.
2. The organization comes from the **resource in the request**, never from a token claim or client-asserted header.
3. The service asks Auth what the caller may do for that organization (`memberships[]` with an `active` status and `isOrganizationAdmin`, or, for owner and operator, `GET /auth/platform-access/:platformId`).
4. The service enforces tenant isolation itself (the same `404` for "not yours" and "does not exist").
5. **"Operation authorization belongs to the service that owns the operation."** Auth "is not the universal business-permission engine"; business permissions inside a product belong to the product.

Nothing in this pattern mentions a client type. A Tauri client and a browser client present the same bearer to the same API.

### 3.4 Client-shaped items that already exist (recorded, not judged)

| Item | Where | Client assumption | Consequence |
|---|---|---|---|
| Bearer JWT plus rotating refresh token over plain HTTP/JSON | [ADR-0002](../../adr/0002-jwt-access-token-with-rotating-refresh-token.md) | chosen **because** clients include a desktop shell and a mobile app that cannot be assumed to hold a cookie jar | EXISTING: client-neutral token transport |
| CORS off unless exact `http(s)` origins are allow-listed; `credentials: false` | `apps/auth-service/src/main.ts:17-18`, `config/app-config.ts:203-209` | a browser needs its origin listed; entries that are not `http(s)` origins are refused at startup | whether a given desktop webview origin can be listed is **unverified**; native (non-webview) HTTP calls are not subject to CORS |
| WebAuthn relying party and `https` origins required in production | `config/app-config.ts:179-185` | passkeys bind to an RP id and origin | TOTP is an alternative factor for owners (ADR-0025), so owner login does not depend on the client choice |
| Owner "new device" alert: hash of the normalized User-Agent, a weak alert-only signal (ADR-0025: "a weak signal, never an authentication factor"; the same wording is a code comment) | `owner/admin-device.service.ts`, ADR-0025, ADR-0010 (rationale) | server-observed User-Agent | client-independent alerting only |
| `device` table (`installId`, model, OS, app version) | migration 0001 | mobile-shaped | **no code reads or writes it** |
| Operator login: the operator requests a time-boxed working code (`login/operator/request-code`, unauthenticated) and verifies it (`verify-code`); the session has a hard 8-hour ceiling | ADR-0011, ADR-0013, ADR-0014 | none | client-neutral |
| Consumer product documents describe one admin app delivered as a browser build **and** packaged with Tauri; `nawara-drive` also has its own Proposed ADR (its own numbering, dated 2026-09-14) to adopt Tauri for its Admin desktop app | `nawara-drive/ARCHITECTURE.md`, `nawara-drive/docs/adr/` (recommendations and a Proposed decision in a **consumer** repository, not Core decisions) | n/a | evidence that both delivery forms are already contemplated for one admin surface; it does not constrain Core |

## 4. Organization administration analysis (Case A)

**Question:** what must be true so that organization administration can be delivered by Tauri, a browser, or a future client without changing service ownership?

### 4.1 Decomposition by owner

| Organization-administration concern | Authoritative owner | Existing API | Client-specific part |
|---|---|---|---|
| Who belongs to an organization, join codes, invitations, org-admin capability | Auth (OrganizationMembership) | `auth/organizations/:id/...` | none |
| Organization metadata: name, tax code, address, phone, type; platform/company metadata | organization-service | **none for humans** (BD-4, F23) | none in the domain |
| What an administrator may do to invoices and payments for an organization | billing, payment | none (B-026, B-027, B-028 unresolved) | none |
| What an administrator may do *inside a product* | the product | product's own | product concern (`nawara-drive`'s "Admin" and "School Admin" are **product** roles, mapped by the product, never encoded in Core) |

### 4.2 Authorization

Authorization of an organization administrator is **already client-independent**: an active `OrganizationMembership` with `isOrganizationAdmin`, or an owner of the organization's company, or an operator with an active assignment on its platform, decided from current state on every request (ADR-0027, ADR-0028, `platform-access.service.ts`). Client-supplied `userId`, `organizationId`, `platformId`, `role` and `permissions` are never trusted (core architecture §6). Nothing here needs to differ per client, and **nothing should**.

### 4.3 What a future client must not change

An organization administration client may need bounded offline use, a device identity, or a different authenticator. None of these may become part of the organization's business rules. They belong to the access layer (sections 9 and 10): the domain answers "may this user do X to this organization?", and the answer must not depend on whether the request came from Tauri or a browser.

**Conclusion (PROPOSED):** organization administration needs **no client-specific backend part**. The undesigned piece is the human-facing hierarchy API (section 13), and it must be designed client-neutrally.

## 5. Platform/operator administration analysis (Case A's counterpart, Case B)

The intention that operator administration may stay off a publicly exposed browser UI is recorded as an **open deployment and security choice**, not an architectural rule.

### 5.1 Facts

| Topic | Existing design |
|---|---|
| Operator authentication | owner registers the operator; the operator requests a time-boxed working code; verification returns tokens with a hard 8-hour, schedule-anchored ceiling (ADR-0011, ADR-0013, ADR-0014); the platform calendar no longer gates login (ADR-0023) |
| Operator authorization | live, from the database: an **active** `PlatformAssignment` on the platform; revocation applies on the next request (ADR-0022, ADR-0023, ADR-0024) |
| Owner authentication | password plus second factor (TOTP or WebAuthn), secret key as step-up and recovery credential (ADR-0025) |
| Privileged operations | owner-only operator management and platform assignment; step-up token for sensitive owner actions (`x-step-up-token`) |
| Audit | Auth's local security audit (`auth_audit_event`); server-observed IP and User-Agent |
| Online requirement | every authorization decision is live, so today **every privileged call requires the server** |
| Offline | not designed anywhere |

### 5.2 Separation the study makes explicit

| Category | Statements |
|---|---|
| **Architectural constraints** (follow from existing decisions) | operator authority stays with Auth (User kind `operator`, assignments); hierarchy authority stays with organization-service; authorization is decided by the server from server state; the client is not an authority |
| **Security recommendations** (PROPOSED, not decided) | privileged administration should require an online session by default; a privileged surface should be reachable only where deployment policy allows, controlled by network reachability, not by trusting a client type; admin actions should be auditable with a server-derived actor; stronger factors for the most privileged operations remain available regardless of client |
| **Deferred product and security decisions** | whether operator administration is ever browser-reachable; whether it is ever offline-capable; device binding for operators; the stronger-security profile for operators |

**Reachability is not authorization.** Keeping an API off a public network is a deployment control and is legitimate. Deciding that "only the Tauri client may call this" would encode a client into authorization; it would be trivially spoofable and is rejected in section 6.

## 6. Client-neutral API principle

**Proposed rule (ADR-0041):**

> Administrative services expose secure APIs based on business capabilities and authorization, not on UI technology.

| Must hold | Must not appear in an administrative API |
|---|---|
| operations are named for business capabilities and act on domain resources | Tauri-specific business rules |
| authorization is derived server-side from server state (live) | browser-specific domain rules |
| the same operation behaves identically for every client | UI layout or workflow assumptions baked into the contract |
| client-specific concerns are confined to **transport and authenticator binding** and expressed generically (bearer token, an allow-listed origin, a factor type, an optional device credential) | local-database authority or client-held business state treated as truth |
| errors, pagination and idempotency follow the shared conventions (ADR-0034) | client-controlled authorization (a header, a claim, a body field naming who the caller "is") |

**Neutrality check** (a review question for any administrative endpoint): *could a different client, with a different UI technology, call this unchanged and get the same authorization outcome?* If not, the endpoint carries a client concern that belongs in the access layer.

## 7. Tauri considerations

Generic considerations to verify when a client is chosen; **none is a decision and none is derived from Tauri internals this repository can verify**.

- A desktop shell is a distribution channel for a client; the same web build can run inside it (as `nawara-drive`'s documents already contemplate).
- The client machine and any local storage are outside the trust boundary: a local database, a cached role or a stored flag can never be authoritative.
- Secure token storage and updates are client concerns; the server must not assume them.
- Origin handling: Auth's CORS and WebAuthn configuration are origin-based. Whether a desktop webview presents an origin those checks accept, or performs native HTTP calls that bypass CORS, must be **verified at selection time**.
- Bounded offline operation is a plausible motivation for a desktop client (sections 9 and 10).

## 8. Browser considerations

- A browser needs its exact origin allow-listed (Auth already supports this; wildcards and credentialed CORS are refused). Auth uses bearer tokens with `credentials: false`, so cookie-based CSRF is not part of the model.
- Passkeys bind to the RP id and origin; TOTP is unaffected.
- Public exposure of an administrative surface is a **deployment and security decision** (section 5.2), not implied by choosing a browser client.
- Token storage in a browser is exposed to script injection; that risk belongs to the client design, and the server-side answer is short-lived tokens plus live revocation, which already exist (ADR-0002).
- Bounded offline use is possible in browsers only in limited forms; not assumed.

## 9. Offline and licensing implications

**Not designed here.** This section records the architectural consequences of the possibility that a client, possibly Tauri, may eventually need **bounded** offline operation.

```
 Server authority  ──►  Client authorization / lease  ──►  Client offline capability
 (authoritative)        (signed, bounded, revocable)        (non-authoritative, time-limited)
```

### 9.1 Constraints any future design would have to satisfy (PROPOSED)

| # | Constraint | Basis |
|---|---|---|
| C1 | The **server remains authoritative** for identity, membership, hierarchy, entitlement and revocation | core architecture §6; ADR-0027 |
| C2 | Local client state is **never authoritative** | same |
| C3 | The **local clock must not be the sole authority** for an authorization or license lifetime | a local clock is client-controlled |
| C4 | Bounded offline authorization may be supported only as an **explicit, time-bounded server grant** (a lease) whose worst-case staleness is a documented number | generalizes ADR-0002's "bounded by the access-token TTL rather than instant" |
| C5 | Clock-rollback detection may help but is **not a complete security boundary** | a determined local attacker can defeat it |
| C6 | **Revocation stays server-authoritative**; offline it takes effect no later than the lease end | consequence of C4 |
| C7 | A device identity may eventually be required (section 10) | deferred |
| C8 | Entitlement is **not** folded into Auth tokens | ADR-0026, ADR-0038 |

### 9.2 What existing decisions say

| Decision | Effect on an offline design |
|---|---|
| ADR-0004: registration-time license validation is synchronous and **fails closed** | an offline path departs from it and needs its own decision |
| ADR-0026: authentication is not entitlement; "auth-service never puts entitlement in a token" | a lease is entitlement, so it cannot ride the Auth access token |
| ADR-0038: entitlement lives in billing-service; consumers choose fail-open or fail-closed and document it | the right home for a lease issuer is the entitlement capability, and the consumer's offline behaviour is that consumer's documented choice |
| ADR-0027 and ADR-0022/0023: authorization is live, revocation applies on the next request | offline operation deliberately relaxes "next request" to "next lease renewal"; that trade-off needs the owner's approval |

**Status:** all of section 9 is **DEFERRED**. The constraints C1 to C8 are PROPOSED as guardrails so that a future design cannot contradict the server-authority model.

## 10. Device identity implications

| Question | Finding |
|---|---|
| Is there a device-identity architecture today? | **No.** The only device concepts are an alert-only User-Agent fingerprint (ADR-0025: "a weak signal, never an authentication factor"; ADR-0010 gives the rationale) and an unused `device` table. ADR-0010 also **rejected** device enforcement because it "risks locking out a legitimate" user |
| Would device identity be needed? | only if client authorization (for example a lease) requires proof of possession |
| Who would own it? | two distinct concepts must not be conflated: a **device credential** (proof of possession, credential-like, therefore Auth's domain per ADR-0031) and a **device seat or license** (an entitlement, therefore billing's per ADR-0038) |
| What must not happen | a device identifier becoming a business rule, or a client-supplied device claim being trusted |

**Status: DEFERRED.** Using device identity as an authorization factor would depart from ADR-0010's stance and needs a new decision.

## 11. Security implications

| Consideration | Implication |
|---|---|
| The client is untrusted | every check is repeated server-side; no client-held role, flag or database is authoritative |
| Operator privilege is high | the strongest recommendations apply (online by default, live authorization, auditable), all PROPOSED |
| A single administrative API serves several clients | one authorization model, one audit trail, one rate-limit policy, instead of one per client |
| Client identity must not become authorization | `User-Agent`, `installId`, an app header or a "client type" claim is spoofable; only reachability and authenticated user state may gate |
| Token theft | short-lived tokens, rotating refresh tokens with reuse detection, live revocation (ADR-0002, ADR-0027); already client-neutral |
| Service tokens have no scopes (O-13, O-14) | any future hierarchy-administration path that uses a service token inherits the broad-token risk already recorded as RR-1 |
| Audit | the actor recorded must be server-derived; a client name is at most informational |

## 12. Interaction with Auth

- Auth remains the owner of identity, credentials, sessions, MFA/recovery and membership, and therefore of **identity and membership administration**. Its administrative API is already bearer-based and free of client assumptions (section 3.2).
- Auth answers "who is this, and what is their membership or grant?"; it does **not** become the business-permission engine for other domains (core architecture §6). Hosting hierarchy business rules in Auth would recreate ADR-0020's original placement and contradict ADR-0031.
- Client-shaped Auth configuration (CORS origins, WebAuthn RP and origins) is **deployment configuration**, not domain logic. Choosing a client later means configuring, and possibly verifying, these entries; it must not change Auth's domain rules.
- Login, refresh and `/auth/me` stay client-neutral and stay independent of organization-service (ADR-0026, ADR-0040, principle P-A of the Stage 10.0 decisions).

## 13. Interaction with Organization Service

- Organization-service owns the hierarchy. Its API today is **service-token only**, which is a **Stage 9 interim boundary**, not a decision about who may administer the hierarchy.
- A human-facing hierarchy administration API is **undesigned** (F23, BD-4). Under the proposed rule it belongs to organization-service, is client-neutral, and follows the existing authorization pattern: authenticate the user through Auth, ask Auth what the caller may do, enforce tenant isolation itself (core architecture §6; the Billing and Payment guards already implement this shape).
- **Caution (PROPOSED constraint): no synchronous cycle between Auth and organization-service on a request path.** Under the proposed Stage 10.0 reference cache (R2c), Auth's `platform-access` answer reads Auth's cache, and on a miss Auth fetches from organization-service. If organization-service's future human-facing API asked Auth `platform-access` for a **newly created** platform, the chain would be client → organization-service → Auth → organization-service. It terminates (the inner call is service-token only and calls nothing else) but couples availability and latency. The shape of the authorization question between the two services (for example, organization-service supplying the anchors it already knows and asking Auth only about identity and grants) is a **future decision**, recorded as OD-8.
- "Internal only initially" (BD-7a in the Stage 10.0 decisions) describes today's exposure of a service-token API. It is **not** a decision that administrative clients will never reach organization-service.

## 14. Interaction with Stage 10 and ADR-0040

| Item | Effect | Classification |
|---|---|---|
| ADR-0039 (mechanism, phases) | none | **1. no change** (and it is not modified) |
| BD-1 / R2c reference cache | client type is irrelevant to the cache, first touch and anchors | **1. no change** |
| `/auth/me`, onboarding resolve, membership checks | already client-neutral bearer APIs; the frozen-contract rule now protects **administrative clients** as well as consumer apps | **2. clarification** |
| BD-2, BD-3, BD-5, BD-6 | unaffected by client choice | **1. no change** |
| BD-4 (who creates Company, token scope) | gains a dimension: the human-facing hierarchy API must be client-neutral and domain-owned; still blocked on O-13/O-14 and F23 | **3. deferred decision** (design constraint added by ADR-0041) |
| BD-7a exposure | "internal only initially" must not be read as a permanent exclusion of administrative clients | **2. clarification** |
| BD-8 external `/auth/me` consumers | **new evidence (documents, not code; ADR-0040's rule is itself only proposed):** repository documents name intended consumers: a Tauri desktop app and an Expo mobile app of `nawara-drive` (ADR-0002, `docs/add/auth-service.md`), and `nawara-drive/ARCHITECTURE.md` describes a browser and Tauri-packaged admin app. The earlier finding "no reference in the local checkout" still holds (documents, not code). This **strengthens** the rule to keep the `/auth/me` and resolve shapes frozen | **2. clarification** |
| Service-token authorization (O-13/O-14) | not resolved; an administrative path that used service tokens would inherit RR-1 | **3. deferred decision** |
| Future admin API and the Auth ↔ organization-service call shape | new: OD-8 (no synchronous cycles) | **3. deferred decision** |
| ADR-0040 text | none of its decisions conflict with a client-neutral principle | **4. no amendment needed**; it stays Proposed and unmodified. A one-line cross-reference to ADR-0041 may be added when ADR-0040 is accepted, at the owner's discretion |
| A new ADR | the client-neutral, domain-owned administration principle is a hard-to-reverse boundary that ADR-0040 (a migration decision) is the wrong place for | **5. new ADR: ADR-0041 (Proposed)** |

## 15. What is decided now

| Topic | Decide now? | Status | Evidence and reason |
|---|---|---|---|
| Administrative operations are owned by the domain service that owns the data (for the hierarchy, **from the cutover**; until then Auth's tables remain authoritative); no central administration business service | Yes | **EXISTING** | core architecture §6 ("operation authorization belongs to the service that owns the operation"), "services deliberately not created", ADR-0031 |
| Organization authority (Company, Platform, Organization) | Existing | **EXISTING** | ADR-0031, ADR-0039 |
| Membership, identity and operator authority | Existing | **EXISTING** | ADR-0030, ADR-0031, ADR-0022, ADR-0025 |
| Authorization is server-side, from live server state; client-supplied context is never trusted | Existing | **EXISTING** | ADR-0027, ADR-0028, ADR-0033, core architecture §6 |
| Token transport works for clients without a cookie jar | Existing | **EXISTING** | ADR-0002 |
| **Administrative APIs are client-neutral** (business capability plus authorization, not UI technology) | **Yes** | **PROPOSED** (ADR-0041) | an explicit statement of what ADR-0002 and the pattern in §3.3 already imply |
| A gateway or composition layer may exist only as an access layer with no business rules, authority or state | Yes (as a limit) | **PROPOSED** (ADR-0041) | prevents an accidental new owner; **creating** such a layer is not decided |
| Tauri vs browser vs other for organization administration | No | **DEFERRED** | client delivery choice |
| Tauri vs browser vs other for operator administration | No | **DEFERRED** | client delivery choice |
| Public exposure of administrative surfaces | No | **DEFERRED** | deployment and security decision |
| Organization offline support | No | **DEFERRED** | future product and security decision |
| Operator offline support | No | **DEFERRED** | future security decision; strongest caution applies |
| Device identity | No | **DEFERRED** | only if client authorization requires it; ADR-0010 currently makes fingerprints alert-only |
| License lease and its issuer | No | **DEFERRED** | future entitlement and licensing design (ADR-0038) |
| Admin UI technology | No | **DEFERRED** | presentation choice |
| Human-facing hierarchy administration: who, which credentials, which host | No | **BLOCKED** | O-13, O-14, O-15, F23 (BD-4) |
| Client-specific origin and authenticator support (CORS, WebAuthn origins) | No | **DEFERRED** | verify when a client is chosen |
| Constraints C1 to C8 for any future offline design | Yes (guardrails) | **PROPOSED** | keep a future design inside the server-authority model |

## 16. What remains intentionally deferred

Client technology per role; public exposure; offline for organization and for operator; device identity and its owner; leases and their issuer and clock model; the gateway or composition layer; the authentication factors supported per client; audit requirements for administrative actions; and the human-facing hierarchy API. **None is decided or implied by this study.**

## 17. Alternatives considered

| Alternative | Verdict | Why |
|---|---|---|
| **A central "Admin Service" that owns administrative business logic** | Rejected | contradicts "operation authorization belongs to the service that owns the operation" and the list of services deliberately not created; would duplicate or capture authority over Auth, organization, billing and payment data, and become a god service |
| Per-client backends (one for Tauri, one for browser) | Rejected as a default | duplicates business rules per client; the same operation could diverge in authorization |
| **A neutral API-access or composition layer** (gateway, BFF) that only routes, aggregates and adapts | Acceptable in principle, **not decided** | allowed only if it holds no business rule, no authority and no state; a proxy that decides "who may do what" is a new business owner |
| **Domain-owned, client-neutral APIs** | **Proposed** | preserves ownership, keeps one authorization model, lets the delivery mechanism change |
| Choose Tauri now, or browser now | Rejected | premature; contradicts the requirement that client delivery stays open |
| Encode client type in authorization ("only Tauri may call this") | Rejected | client identity is spoofable and turns a delivery choice into a domain rule; reachability controls are the legitimate tool |
| Offline-first local authority | Rejected | violates server authority (C1, C2) |

## 18. Recommended architectural constraints

| ID | Constraint | Status |
|---|---|---|
| AC-1 | Administrative capabilities live in the domain service that owns the data (the hierarchy's owner is organization-service from cutover, ADR-0031/0039; the host of a human-facing hierarchy API is BD-4) | EXISTING (restated) |
| AC-2 | Administrative APIs are client-neutral (section 6) | PROPOSED |
| AC-3 | No central administration business service; any access layer holds no rules, authority or state | PROPOSED |
| AC-4 | Authorization is server-side from server state; a client is never an authority | EXISTING (restated) |
| AC-5 | Client concerns are confined to transport and authenticator binding, expressed generically | PROPOSED |
| AC-6 | Client identity (client type, `installId`, app header) never gates authorization; a User-Agent is already "a weak signal, never an authentication factor" (ADR-0025; rationale in ADR-0010) | PROPOSED (new, except the User-Agent point) |
| AC-7 | Client technology, public exposure, offline, device identity and leases stay open until separately decided | PROPOSED |
| AC-8 | Any future offline design satisfies C1 to C8 | PROPOSED |
| AC-9 | No synchronous cycle between Auth and organization-service on a request path | PROPOSED |
| AC-10 | Entitlement and leases are not carried in Auth tokens; the entitlement capability issues them | EXISTING (ADR-0026, ADR-0038), restated |

## 19. Impact on Stage 10.1

**No change to the Stage 10.1 prerequisites and no new blocker.** Concretely:

- The migration mechanics, R2c, the cutover sequence and the import are unaffected.
- BD-8 evidence gathering should **include administrative clients** (the Tauri desktop app and any browser build named in the consumer documents); the interim "keep `/auth/me` and resolve frozen" rule already covers them.
- BD-7a's wording gains one clarifying sentence in the accepted ADR; no change to the decision.
- BD-4 remains the place where human-facing hierarchy administration is decided; ADR-0041 constrains its design (client-neutral, domain-owned, no cycles) without deciding its content.

## 20. Open decisions

| ID | Decision | Status | Blocks |
|---|---|---|---|
| OD-1 | Human-facing hierarchy administration: actors, credentials, host service | BLOCKED (BD-4: O-13/O-14/O-15, F23) | opening callers, post-cutover provisioning |
| OD-2 | Client delivery for organization administration (Tauri, browser, both, other) | DEFERRED | nothing in Stage 10 |
| OD-3 | Client delivery for operator administration, and whether it is ever browser-reachable | DEFERRED | nothing in Stage 10 |
| OD-4 | Public exposure of administrative surfaces, per role | DEFERRED | nothing in Stage 10 |
| OD-5 | Offline support for organization administration and for operator administration | DEFERRED | nothing in Stage 10 |
| OD-6 | Device identity: need, and owner (credential in Auth versus seat in billing) | DEFERRED | nothing in Stage 10 |
| OD-7 | Lease design, issuer, clock model, and the departure from ADR-0004's fail-closed model | DEFERRED | nothing in Stage 10 |
| OD-8 | Shape of the authorization question between organization-service and Auth (no synchronous cycles) | DEFERRED | the human-facing hierarchy API |
| OD-9 | Authentication factors supported per client (CORS and WebAuthn origins to be verified) | DEFERRED | client selection |
| OD-10 | Audit requirements for administrative actions | DEFERRED | client selection, operator hardening |
| OD-11 | Whether a gateway or composition layer is created | DEFERRED | nothing in Stage 10 |
| OD-12 | Billing and payment administration by organization and platform staff (B-026, B-027, B-028) | DEFERRED (existing) | not client-related |

**Recommended next architecture step:** the owner reviews ADR-0041 together with ADR-0040; then the BD-4 ADR (producer and administrative service-token scopes, hierarchy validation, human-facing hierarchy administration) is written **on top of** the client-neutral, domain-owned principle rather than before it.
