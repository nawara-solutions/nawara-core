# Stage 10: BD-4 service-token scopes, hierarchy validation and human-facing administration

- **Status:** architecture and authorization study. It **proposes**; it decides nothing that an existing ADR has not already decided. Nothing here is implemented. The companion ADR is [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md), status **Proposed when this study was written; now Accepted** by the architecture owner (see the note below).
- **Date:** 2026-09-20
- **Baseline:** `main` at `6e7ddcc`.
- **Update after the owner's answers (2026-09-19 as given by the owner):** the analysis below is left as written and is not rewritten. The owner answered D1 to D4 and accepted ADR-0042; the answers are in the [owner-decision sheet](./stage-10-bd4-owner-decisions.md) and the decisions in ADR-0042. Where this study differs, **ADR-0042 and the sheet govern**: the study's "proposed" wording is now the owner's decision for Platform scope (D3 here), producer admission (an explicit list of two admissions, not a general trusted-producer gate), and the human path (H2 with organization-admin memberships added to the grant facts, and operator step-up for sensitive operations); Company creation (D8 here) is decided as different mechanisms for the first Company and later Companies. Nothing is implemented.
- **Status vocabulary:** `EXISTING` is decided by an ADR or governing architecture document already in the repository (most ADRs still carry the header status "Proposed" and the project owner treats them as governing). `PROPOSED` is a recommendation awaiting the architecture owner. `DEFERRED` stays open on purpose. `BLOCKED` needs input this repository lacks.
- **Rule for this document:** authorization the code does not actually enforce is never inferred. Every "current" statement below was read from source.

## 1. Baseline and Phase 0 result

| Check | Result |
|---|---|
| ADR-0041 post-review state | **Re-reviewed after the four SHOULD FIX edits: no conformance blocker.** All four fixes present and correct. One new SHOULD FIX (see the pending correction below); not a blocker |
| ADR-0041, ADR-0040 status | both **Proposed**; no Stage 10 ADR is Accepted |
| ADR-0039 | no diff against `HEAD` |
| Client-neutral audit and earlier Stage 10 studies | present and **unchanged by this task** |
| Runtime, migrations, infra, CI, compose | fingerprint identical to the previous task |
| Pre-existing uncommitted work and both stashes | untouched |

**Documentation correction (was pending when written; applied 2026-09-20 in ADR-0041, the client-model study and the audit).** The re-review found that the quotation "NEVER an authentication factor" is attributed to ADR-0010 in ADR-0041 (decision 3) and in the client-model study (three places). The exact wording is a **code comment** (`apps/auth-service/src/owner/admin-device.service.ts`); ADR-0025 says "never an authentication factor" in lower case; ADR-0010 supports the substance (the fingerprint is an alerting signal, not enforcement) without containing the phrase. The client-neutral audit repeats the quotation without an ADR citation. The fix is to cite ADR-0025 (and ADR-0010 for the rationale) and drop the quotation marks. **New documents in this task attribute it correctly and avoid the quotation.**

## 2. The problem

After organization-service becomes authoritative for Company, Platform and Organization, two questions have no designed answer:

1. **Service path.** Which services may do what to which organizations, and who validates that an asserted `organizationId` or `platformId` is real and belongs to the claimed hierarchy? (O-13, O-14, O-15, B-029.)
2. **Human path.** How is a human administrator authorized to create or change hierarchy entities, independently of the client used? (F23.)

## 3. What is implemented today

### 3.1 The service-token mechanism (`libs/service-kit`)

| Property | Fact |
|---|---|
| Token | 32 random bytes, base64url (`generateServiceToken`) |
| Callee storage | only the SHA-256 digest, in `SERVICE_TOKENS=<caller>:<digest>[,…]` read at process start |
| Per-caller limit | at most **2** tokens (for rotation); a **duplicate digest within one callee is refused** |
| Comparison | constant time against **every** entry (no early exit) |
| What the guard produces | `req.serviceCaller`: the **caller name string**, nothing else |
| Claims, expiry, not-before, audience, scopes | **none exist**. Audience is "by construction": a callee accepts only the digests it lists; nothing prevents the same digest being listed in two callees |
| Empty `SERVICE_TOKENS` | every call refused (fail closed) |
| A user bearer as a service credential | never accepted |
| Revocation | remove the digest and restart the instance |

### 3.2 Caller and target inventory (only what the code enforces)

| Caller | Target | Authentication | Current authorization | Asserted scope | Risk or gap |
|---|---|---|---|---|---|
| Billing | Payment (payment requests, cancel, reads) | `BILLING_TO_PAYMENT` token, registered in Payment | route allowed to **any registered caller**; object level: a payment is reachable only by the `producer` whose name equals the row's producer, or by its payer | `organizationId`, `seller`, `payer` in the body | asserted scope is **shape-checked only** (uuid, equal to `seller.id`); no existence, platform or company validation |
| **Auth** | Payment | `AUTH_TO_PAYMENT` token, **registered in Payment's `SERVICE_TOKENS` in the compose configuration** (production configuration not verified) | the same route allowance as Billing: create and cancel are guarded only by "registered caller" | as above | Auth needs one read (`/payment/licenses/:id/status`, which **does not exist**), yet its token is accepted on **create and cancel** and, through `ServiceOrUserGuard`, on `GET /payments/:id` (create is rate-limited per caller): full route access with no capability limit |
| Any registered producer | Billing (products, prices, invoices, payment requests) | service token (none registered in compose) | route allowed to any registered caller; reads and archive limited to the caller's own `producer`; **no producer admission or allow-list logic exists** (verified by search; the similar-sounding source comment concerns the invoice locale default, not admission); creates are **rate-limited per producer** (invoice and payment-request create), a technical abuse limit, not authorization | `seller`, `organizationId`, party snapshots | any registered caller may assert any seller or organization; natural key is `(seller, code)`, so one producer can occupy another's key |
| Any registered service | Organization Service (12 routes) | service token (none registered by default) | any registered caller has **full read and write** on Company, Platform, Organization | parent ids validated by foreign key | the broad-token risk **RR-1**; no read/write split |
| Billing, Payment (and the kit) | Auth `GET /auth/me` | the **user's** bearer, no service identity | Auth authenticates the user live | none | Auth cannot tell which service is asking; Auth has **no service-token callee side** (0 references) |
| Payment provider | Payment webhooks | provider signature over the raw bytes | signature only | provider event | not a service token |
| Organization Service | anyone | none outbound | n/a | n/a | no outbound calls |

Only two outbound service-token clients exist in the whole repository: Auth to Payment and Billing to Payment.

## 4. Authentication, authorization, scope and validation: are they separated?

```
Authentication  ─ who is calling?                     kit ServiceTokenGuard  ─►  a caller name
Authorization   ─ what may that caller do?            NOT modeled at capability level
Scope           ─ for which platform/organization?    NOT enforced; asserted in the request body
Validation      ─ does it exist, and belong to the    shape only (uuid); nothing checks existence
                  claimed hierarchy?                  or the organization-to-platform-to-company chain
```

**Assessment.** Authentication is cleanly separated and technical (the kit). The other three are **collapsed into one rule: "registered means trusted, and the caller's name is the tenancy of its records."** Concretely, the guard's output (a name) is used directly as the authorization principal (`relationTo(row, caller)` compares `caller.service === row.producer`). There is no capability layer, no scope, and no validation of asserted ids. That is acceptable for a test fixture and is exactly what the payment SDD gates: "enabling any producer beyond the test fixture" is blocked by O-13/O-14, and O-15 gates "production use by non-trusted producers".

## 5. Service-token scope models

| Criterion | **A** identity-only token, target decides ad hoc (today) | **B** scoped token (claims carry capabilities and scope) | **C** identity token plus **server-side policy** in the target | **D** hybrid: stable identity plus explicit signed capabilities |
|---|---|---|---|---|
| Security | weakest: registered means broad | strong per token | strong: deny by default, least privilege per caller | strongest |
| Revocation | remove digest, restart | only by expiry or a deny list | edit policy in the target; token unchanged | short expiry plus policy |
| Rotation | two digests per caller | reissue on every scope change | independent of scope: scope changes never reissue tokens | keys plus expiry |
| Blast radius | any registered caller reaches every route | bounded by the token | bounded by policy | bounded |
| Fits today's mechanism | yes | **no**: an opaque random token digest cannot carry claims; needs signing | **yes**: no token change | needs signed tokens |
| Operational complexity | lowest | high (issuer, keys, expiry) | low to medium (a policy per target) | highest |
| Multi-organization | asserted, unchecked | per-token org list grows | platform-scoped policy plus validation | capability per platform |
| Platform scope | none | in the token | in the policy | in the token |
| Hierarchy validation | none | none by itself | policy needs a validation source (section 7) | assertion can be signed by the authority |
| Future organization-service, Auth, Billing, Payment, Entitlement | each invents its own | one issuer for all | each target owns its own policy | one issuer for all |
| Auditability | caller name only | caller and claims | caller, capability, policy decision | caller, claims, key id |

**Verdict (PROPOSED): Model C now, Model D as the documented evolution, Model B rejected for now.**

- **Model A** is what exists and is insufficient for production (section 3.2).
- **Model B** does not fit the kit's opaque-token design and would need signing infrastructure that ADR-0033 explicitly deferred ("signed short-lived service JWTs with published keys… needs asymmetric signing"), with revocation only by expiry.
- **Model C** needs no token change, keeps scope changes independent of token rotation, keeps authorization in the service that owns the operation (core architecture §6), and is deny by default.
- **Model D** is a possible next step that ADR-0033 anticipates: "the guard is an interface, so moving to signed service JWTs later changes one module per service". ADR-0033 also states it needs asymmetric signing and a key endpoint in Auth, which do not exist and lie outside Auth's frozen scope, so issuer and key publication would be new work. Whether the policy semantics defined under C carry over is not verified.

**Scope dimension (PROPOSED): platform.** Platform is the existing tenancy and product boundary (ADR-0022), is stable (an organization's platform never changes, ADR-0024), and keeps a policy short. Per-organization scope would be unbounded and dynamic. Organization scope is then *derived*: an organization is in scope iff its platform is.

## 6. O-13, O-14, O-15 and producer assertions

| # | Question | Answer from the repository |
|---|---|---|
| 1 | What is a "producer"? | a **service** holding a valid token that creates obligations (products, prices, invoices, payments); its identity is the token's caller name, stored as `producer` on rows and used as the isolation column (payment SDD, billing SDD). It is not a user and not a role |
| 2 | Which service is authoritative for the asserted organization? | organization-service **from the cutover**; before it, Auth's tables, but Auth exposes no service API for it (only `GET auth/admin/organizations/:id` for owner and operator users) |
| 3 | Can a buggy or malicious producer assert another organization's id? | **Yes.** Any uuid passes; the only guard is that other producers cannot read that producer's rows. An invoice can therefore name a seller organization the producer has no relationship to, and the issuer snapshot comes from the producer's own request |
| 4 | What validates the relationship? | **nothing** beyond uuid shape and `organizationId == seller.id` |
| 5 | Should the target trust the caller? | for a **trusted first-party producer under an explicit policy**, provisionally yes; for a non-trusted producer, no (this is the SDD's own gate) |
| 6 | Should the target call organization-service? | see section 7: the recommended mechanism is a bounded, capability-limited, memoized reference lookup **at the first assertion**, never on reads and never on the authentication path |
| 7 | Should the caller obtain a signed or scoped capability? | a valid future option (Model D); requires signing infrastructure; not proposed now |
| 8 | Asynchronous validation? | **rejected for creates**: an invoice or payment is an immutable financial record, so bad data must not enter before validation. Acceptable only as a background reconciliation check |
| 9 | Organization scope in the token? | **rejected**: opaque tokens cannot carry it, and per-organization tokens do not scale |
| 10 | Does this violate Auth's login and refresh independence? | **No.** The lookup is made by Billing and Payment on obligation creation, not by Auth, and never on login, refresh or `/auth/me` |

## 7. Hierarchy validation: where the invariant is checked

The invariant `Organization → Platform → Company` is **owned by organization-service** (foreign keys, immutability triggers). Consumers hold only opaque ids (ADR-0032, ADR-0036).

| Option | Description | Assessment |
|---|---|---|
| V1 | trust the producer's assertion (today) | closes nothing; allowed only for trusted first-party producers |
| **V2** | **first-assertion reference lookup** against organization-service (a capability limited to ids and parents), bounded and fail closed on creates, with the positive result memoized because anchors are immutable | **recommended**; no copy of the hierarchy, no new table required, purpose-limited |
| V3 | signed assertion (authority signs organization, platform, company, expiry) verified locally | best long-term; needs signing infrastructure (Model D) |
| V4 | cached anchors kept in a local table | duplicates hierarchy data; unnecessary given V2's memoization |
| V5 | asynchronous verification after creation | rejected for financial creates (section 6, question 8) |

**Placement per id:**

| Id | Validated where | By what |
|---|---|---|
| `companyId` | organization-service | primary key and parent foreign key |
| `platformId` | organization-service; consumers check membership in the caller's allowed platform set (policy) | foreign key; policy |
| `organizationId` | organization-service (existence and parent); consumers check its platform against the caller's policy | V2 |

**V2 is not an "arbitrary synchronous call":** one capability (`reference.read`: ids and parents only, no names, tax codes or addresses), one moment (a producer first asserts an organization to a target), fail closed for creates, never for reads, never on any Auth path, and memoization of positive results is safe **only if ids are never reused and anchors never change** (ADR-0024 for anchors; the BD-5 interim invariant I1 for ids, still Proposed). No cross-service foreign key and no withdrawn tenancy-anchor design is reintroduced: consumers store only the opaque id they already store. No Billing invoice and no Payment record stores a platform id today (Billing's only `platformId` is the opaque key of its Platform-currency configuration table, which no invoice references); platform scope therefore needs organization → platform to be resolved from organization-service at validation time (an architectural dependency, not a new stored field), and how Billing learns an invoice's platform stays open (B-036a). A positive result proves identity and anchors only, **not** that the organization is active: active or inactive status is the lifecycle question (BD-5).

**Interim gate (PROPOSED):** until V2 or V3 exists, the only permitted producers are trusted first-party services under an explicit policy. This is the payment SDD's existing gate, restated.

## 8. Organization Service authorization: two paths, never conflated

### 8.1 The two paths

```
Human:     client ─► (user bearer) ─► organization-service ─► Auth: who is this, and what grants does this user hold?
                                          └► organization-service evaluates the grants against ITS OWN hierarchy anchors
Service:   service ─► (service token) ─► organization-service ─► its policy: may this caller do this capability?
```

**Rules:** a user bearer is never a service credential and a service token never carries a user (ADR-0033). A service acting **on behalf of** a user forwards the user's bearer **only to Auth**, never to another service. A capability granted to a service is not a way around a user's authorization: services validating references hold only `reference.read`.

### 8.2 Existing human authorization design (reused, not reinvented)

ADR-0020 and ADR-0022 already designed the human rules, for Auth-hosted routes that were never built. They are the existing architecture:

| Operation | Designed human authorization | Source |
|---|---|---|
| Create Company | **no human route**; the bootstrap command creates the company with its owner | ADR-0022 bootstrap (ADR-0016 is Superseded; it creates an owner, not a Company) |
| Create, list, read, rename Platform | **owner** only, company-wide (one company today) | ADR-0022 |
| Assign or revoke an operator on a platform | **owner** only | ADR-0022 |
| Create, list, read, update Organization | **owner** (any platform in the company) **or operator** with an active assignment on the platform; a `403` for a supplied but inaccessible `platformId` on create, a collapsed `404` on `:id` | ADR-0020 |
| Update organization metadata by a member with the organization-admin capability | **not decided** (ADR-0028 gives that capability membership administration, not metadata edits) | ADR-0020, ADR-0028 |
| Delete or archive any hierarchy entity | **no decision** (BD-5) | ADR-0020, ADR-0039 |

### 8.3 How organization-service learns what a user may do (the OD-8 question)

Existing `GET /auth/platform-access/:platformId` makes **Auth derive** platform → company from its own tables, so under the proposed reference cache (R2c) a newly created platform would trigger an Auth-to-organization-service fetch inside a call organization-service made to Auth: a synchronous cycle.

| Option | Shape | Assessment |
|---|---|---|
| H1 | organization-service calls existing `platform-access` | works, but creates the chain client, organization-service, Auth, organization-service (ADR-0041's guardrail) |
| **H2** | Auth publishes the **principal's own grant facts** to the caller holding the user bearer: the owner's company id (if an owner), and the platforms with an **active assignment** (if an operator); organization-admin memberships are not part of the first shape. The shape is **illustrative and needs the owner's decision (D7)**: it is what the designed rules need, not a contract. **Organization-service evaluates them against the anchors it owns** (owner: `ownerCompanyId == platform.companyId`; operator: `platformId ∈ assignedPlatformIds`) | **recommended**: Auth reads no hierarchy, so **no cycle and no dependence on the reference cache**; needs a new Auth **read endpoint about the caller's own grants**, authenticated by the user bearer only, so Auth needs **no service-token callee side**; asking with arbitrary ids reveals nothing beyond the caller's own facts |
| H3 | use `/auth/me` alone | insufficient: `/auth/me` returns no owner company and no assignments; extending it would change a frozen contract (BD-8) |

H2 matches core architecture §6: Auth supplies identity, membership, user kind and security context; **the service that owns the operation decides**. It is client-neutral, since a Tauri client, a browser and any other client present the same bearer.

### 8.4 Service path: capability vocabulary (conceptual, names are not fixed)

| Capability | Meaning | Intended holders |
|---|---|---|
| `hierarchy.reference.read` | ids and parents only | Billing, Payment (validation); nothing else |
| `hierarchy.read` | full read including names and metadata | Auth (first-touch fetches, R2c) |
| `hierarchy.write` | create or update Platform and Organization | none by default; a service holds it only if a decision assigns it |
| `hierarchy.provision` | create Company | one **provisioning identity** used by an operator-run command |

Splitting read from write **would resolve RR-1 once implemented**: an Auth token holding only `hierarchy.read` could no longer mutate the hierarchy. No delete or archive capability is defined (BD-5).

## 9. Human-facing administration: primitives independent of the client

What the **API level** must provide, for any client:

1. Authenticate the user through Auth (live identity, live session).
2. Obtain the caller's own grant facts from Auth (H2).
3. Evaluate the grant against the hierarchy anchors the service owns.
4. Enforce tenant isolation in the service (the same `404` for "not yours" and "does not exist").
5. Derive scope from the **resource**, never from a request field; refuse unknown fields.
6. Record a durable actor (user id, session family where available, calling service if any) and the outcome.
7. Accept no client-supplied role, permission, scope, `organizationId`, `platformId`, `userId` or client type as authority.

None of this names a client. **Tauri versus browser stays open.**

## 10. Platform and operator administration

Using existing terminology (owner, operator with an active `PlatformAssignment`, member with the organization-admin capability):

| Question | Answer under existing decisions |
|---|---|
| Who may create platforms? | the **owner** (ADR-0022) |
| Who may modify platforms? | the owner |
| Who may create organizations? | the owner, or an operator with an active assignment on the target platform (ADR-0020) |
| Who may perform cross-organization operations? | the owner (company-wide); an operator only within assigned platforms |
| Who may create a company? | **provisioning only** (no owner or operator API); multi-company is an open question (ADR-0022) |
| Human authorization needed | live grant facts (H2) evaluated by organization-service |
| Service authorization needed | policy capability (section 8.4); operators are humans, not services |
| What must be audited | actor, session, operation, target ids, outcome, correlation id, for every hierarchy mutation and every denial |

Operators act without step-up today for membership operations (ADR-0028, ADR-0030 record this as a residual risk). Whether hierarchy writes by operators need a stronger control is **DEFERRED**. No role is invented.

## 11. Auth independence

**Preserved.** Under this proposal:

| Path | Calls organization-service? |
|---|---|
| login, refresh, logout, session validation, `GET /auth/me`, member access check | **never** |
| register, join, invitation consume, onboarding resolve | **never** (ids and snapshots already local) |
| Auth administrative first-touch (first join code or invitation for an organization, first assignment on a platform, bootstrap) | **may**, bounded and fail closed (ADR-0040 decision 2, Proposed) |
| organization-service human API | calls **Auth** (user bearer) for identity and grants; Auth does **not** call back |
| Billing, Payment obligation creation | call organization-service (`reference.read`), first assertion only; **not an Auth path** |

`/auth/me` is **not** extended (no owner company, no assignments): that would both change a frozen contract and turn it into hierarchy state. A static boundary test (as organization-service already has) should assert that no authentication-path code references the organization-service client.

## 12. Audit implications

Service-token authorization events, by need:

| Field | Class | Note |
|---|---|---|
| caller service identity | **required now** | already recorded (Billing `actorType`/`actorId`, organization-service logs) |
| operation (capability) | **required now** for mutations and denials | |
| outcome and reason class (allowed, denied by policy, denied by validation) | **required now** | today a denial is a generic `401` with no record |
| correlation or request id | **required now** | the kit already provides it |
| scope asserted (`organizationId`, `platformId`) and target resource id | **required now** for mutations | |
| durable actor for hierarchy changes (user, session, service) | **required before organization-service accepts writers in production** | today only log lines (finding O-1 of the audit) |
| policy version and token fingerprint (which of two tokens) | future enhancement | useful for rotation forensics |
| forwarding to a central audit | future (audit-service is design only) | |
| client type, device | **unnecessary** | never authorization inputs (ADR-0041 direction) |

## 13. Revocation and rotation

| Topic | Current | Sufficient for pre-production? | Decide before production |
|---|---|---|---|
| Lifetime | none: valid until removed | yes | rotation cadence |
| Rotation | two digests per caller, manual runbook (add, deploy callee, switch caller, remove) | yes | who runs it, how often, proof of completion |
| Revocation | remove digest **and restart** every instance | acceptable pre-production | whether restart-based revocation meets the incident response time (BD-7) |
| Compromised token | valid from anywhere with network reach until removed; blast radius is every route today, tempered only by the per-producer create rate limits in Billing and Payment | no | policy (Model C) limits blast radius; reachability controls |
| Scope change | none exists | n/a | policy reload semantics (restart or live reload) |
| Multi-instance | identical environment per instance; drift possible | yes | startup validation and a drift check |
| Cross-callee reuse | not prevented by code (only within one callee) | yes | rule: one token per caller-callee pair, enforced by process or CI |
| Secret storage | server-side env files (mode 600); no secret manager (ADR-0033) | yes | BD-7 |

No token-management platform is proposed.

## 14. Security scenarios

| # | Threat | Current protection | Gap | Required decision |
|---|---|---|---|---|
| 1 | Billing's token creates payments for another organization | producer isolation on reads; shape checks | organization not validated; no scope | V2 plus platform policy |
| 2 | A producer token creates a payment for an organization it has no relationship to (Payment holds no outbound token itself) | same | same | same |
| 3 | **Auth's token performs a service-only operation** | Auth's token is registered in Payment and accepted on **create, cancel and `GET /payments/:id`** | no capability limit | Model C: Auth holds only what it needs |
| 4 | Organization-service receives a forged `organizationId` | ids are resource ids; a wrong parent is a foreign-key failure; unknown fields refused | any registered caller can act on any organization | capability plus platform scope |
| 5 | A human organization admin attempts another organization's operation | Auth-hosted operations derive authority from the resource and answer `404` | no human API on organization-service yet | H2 evaluated by organization-service |
| 6 | An operator acts outside an assigned platform | live `PlatformAssignment` check (Auth) | not yet on organization-service | H2 |
| 7 | A compromised token is replayed | secret entropy, constant-time compare, digest-only storage | valid until removed; no expiry | rotation decisions (section 13) |
| 8 | An old token still works after rotation | two-digest window | the old digest stays until someone removes it | runbook and completion proof |
| 9 | An organization id is real but belongs to another platform | Auth: composite FK; organization-service: foreign key | Billing and Payment: not checked | V2 |
| 10 | A platform id is real but belongs to another company | Auth and organization-service: foreign keys | Billing (`platform_currency`): not checked | V2 where a platform id is asserted |
| 11 | A client sends a forged role, permission or scope | unknown fields refused; authority from the database (verified across services) | none found | none |
| 12 | The authentication path accidentally calls organization-service | no such code exists | no automated boundary for Auth | a static boundary test for Auth, mirroring organization-service's |

## 15. Decision matrix

| ID | Decision | Current state | Options | Security impact | Operational impact | Dependencies | Recommendation |
|---|---|---|---|---|---|---|---|
| D1 | Service authentication | opaque token, digest, per pair | keep; signed JWTs; mTLS | unchanged | none | ADR-0033 | **keep**; signed tokens later (Model D) |
| D2 | Authorization model | registered means trusted | A, B, C, D | C would close the gap once implemented | one policy per target | none | **Model C now, D later** |
| D3 | Scope dimension | none | organization, platform | platform is stable and short | small policy | ADR-0022, ADR-0024 | **platform** |
| D4 | Capability granularity | route allowance | route, read/write, per operation | read/write split resolves RR-1 | few capabilities | none | **reference.read, read, write, provision** |
| D5 | Producer admission | any registered caller | allow-list per platform | bounds blast radius | a policy entry per producer | D2, D3 | **explicit policy; deny by default** |
| D6 | Hierarchy validation | shape only | V1 to V5 | V2 would close O-15 if adopted | one bounded lookup at first assertion | BD-5 invariant I1, organization-service reference capability | **V2 now, V3 later; trusted-producer gate until then** |
| D7 | Human path to organization-service | not built | H1, H2, H3 | H2 avoids cycles and contract changes | one new Auth read endpoint | ADR-0040 (for H1 only), ADR-0041 | **H2** |
| D8 | Company creation | bootstrap CLI in Auth | provisioning identity; owner API; another service | narrowest is provisioning only | one operator-run command | multi-company decision (ADR-0022) | **provisioning only**, no human role |
| D9 | Human hierarchy writes | designed in ADR-0020/0022, unbuilt | reuse; redesign | reuse keeps decided rules | none | BD-5 for delete | **reuse ADR-0020/0022** (owner: platforms; owner or assigned operator: organizations) |
| D10 | Auth independence | holds today | boundary test | enforces the rule | one test | ADR-0040 | **adopt the boundary test** |
| D11 | Audit minimum | actor in Billing, logs in organization-service | section 12 | denials become visible | small | none | **section 12 "required now"** |
| D12 | Rotation and revocation | manual, restart-based | runbook; secret manager; expiry | reduces compromise window | process | BD-7 | **decide before production; nothing built now** |
| D13 | Gateway or admin service | none | Admin Service; gateway; none | a new owner would be a risk | avoided | ADR-0041 | **none; domain-owned APIs only** |

## 16. Proposed BD-4 decision

**PROPOSED (ADR-0042):** keep service authentication as is; add **server-side, deny-by-default authorization policy in each target** (Model C) with **capabilities** and **platform scope**; validate producer-asserted organizations against **organization-service at first assertion** (V2) and admit only trusted first-party producers until that exists; give the **human path** to organization-service an **Auth-published grant facts** shape evaluated by organization-service (H2), reusing the human authorization already designed in ADR-0020 and ADR-0022; treat **company creation as provisioning**, not a human role; preserve Auth's login, refresh and `/auth/me` independence; record the audit minimum in section 12.

**If accepted, this would record the decision mechanism for:** O-13 (target-side policy decides which services may create obligations), O-14 (the scope model: Model C, platform scope), O-15 (hierarchy validation without user context: V2; also tied to O-5, O-6 and O-18 for staff and company access), the producer-scope part of B-029 (products, prices and invoices), F23's authorization model (the rules of ADR-0020/0022 relocated), and BD-4. The SDD items close only when their implementation gates are met. **It would not resolve:** B-026, O-18, B-027, O-20, B-028 (staff and user-bearer relations to financial data), B-030 (price authority), B-031 (catalog governance, which also gates catalog writes), B-036 (including how Billing learns an invoice's platform), lifecycle semantics or ID reuse, offline or device authorization, client technology, `/auth/me` consumer compatibility, or production topology.

## 17. Deferred and unrelated decisions (status unchanged)

Tauri versus browser; offline licensing; device authorization; session enumeration; the audit taxonomy; entitlement ownership; organization deletion and archival (BD-5); ID reuse (BD-5 invariant I1 remains Proposed); production topology (BD-7); `/auth/me` consumer compatibility (BD-8); whether an organization admin may edit organization metadata; whether operators need step-up for hierarchy writes; multi-company support; a gateway or composition layer.

## 18. Blockers and dependencies

**No blocker to approving the architecture.** Dependencies of *implementation*: ADR-0042 accepted; BD-5 invariant I1 accepted before V2 memoization is relied on; ADR-0040 accepted for Auth's first-touch flows; BD-7 for secret distribution and revocation timing; a durable actor record in organization-service; a new Auth read endpoint for H2; an organization-service reference capability.

## 19. Readiness

**READY FOR ARCHITECTURE-OWNER APPROVAL** as a **Proposed** architecture. Owner input is needed on: the provisioning identity for company creation (D8), platform as the scope dimension (D3), the trusted-producer interim gate (D6), and H2 as the human-path shape (D7). Implementation stays blocked on the dependencies in section 18.
