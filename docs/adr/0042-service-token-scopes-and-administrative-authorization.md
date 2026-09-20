# 0042. Service-token scopes, hierarchy validation and administrative authorization

- **Status:** Accepted <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (accepted by the architecture owner. The acceptance statement was given together with the owner's answers to D1 to D4, recorded verbatim in the [owner-decision sheet](../architecture/stage-10/stage-10-bd4-owner-decisions.md), and is subject to those four answers being recorded as the architecture-owner decisions, which they are. **Acceptance is a decision about architecture only: nothing is implemented, and implementation is a separate phase that does not begin merely because this ADR is accepted.**)
- **Date:** 2026-09-20 (drafted). The owner's D1 to D4 answers carry the date 2026-09-19 as given by the owner; the acceptance statement itself is undated in the record.
- **Deciders:** Anwar (project owner); decisions D1 to D4 were made by the architecture owner.
- **Amended:** **Amendment 1 (2026-09-20)** at the end of this ADR records the architecture owner's DEC-1 to DEC-5 direction; **Amendment 2** records the consequences of ADR-0040 being Accepted. The ADR **stays Accepted**. The original text below is kept for the historical record; where the amendment differs, the amendment governs.

> Related, none modified: [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (header status Proposed; its token mechanism is implemented in service-kit), [ADR-0039](./0039-organization-ownership-and-cross-service-migration-authority.md), [ADR-0040](./0040-organization-ownership-migration-decisions.md) (Proposed), [ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Proposed). The analysis, evidence and decision matrix are in the [BD-4 study](../architecture/stage-10/stage-10-bd4-service-authorization-study.md); the owner's answers are in the [owner-decision sheet](../architecture/stage-10/stage-10-bd4-owner-decisions.md). This ADR does **not amend** ADR-0033: it keeps its authentication and adds the authorization layer that ADR-0033 does not define. ADR-0040, ADR-0041, ADR-0020, ADR-0022 and ADR-0024 keep their own header status; this ADR adopts, for hierarchy administration, the rules it names from them and does not change those ADRs.

## Context

Once organization-service owns Company, Platform and Organization, two questions have no designed answer (BD-4): which services may do what for which organizations, and how a human administrator is authorized to change the hierarchy.

What exists, read from source: a service token is 32 random bytes stored only as a SHA-256 digest (at most two per caller), and the guard yields **only a caller name**. There are no claims, expiry, audience or scopes. Authorization is "any registered caller may use any service-token route", plus an object-level rule that a record belongs to the producer whose name it stores. Producer-asserted `organizationId` is checked for uuid shape only, in both Billing and Payment; both rate-limit creates per producer, which is a technical abuse limit and not authorization. In the compose configuration Auth's token is registered in Payment, where it is accepted on the create and cancel routes, on `GET /payments/:id` and on the attempt start and sync routes (which also accept a user bearer through the combined guard; object-level rules for those routes were not verified), although Auth only needs a read route that Payment does not implement (production registration not verified). Any token registered in organization-service can read and write the whole hierarchy (risk RR-1). Auth has no service-token callee side and authenticates only users.

The human authorization **rules** for platforms and organizations were designed in ADR-0020 and ADR-0022 (both Proposed) for Auth-hosted routes that were never built (finding F23); the host service for a human-facing API was left undecided by ADR-0041. The payment SDD gates any producer beyond a test fixture on O-13 (service-token issuance and authorization), O-14 (a `ServiceTokenGuard` scope model) and O-15 (validation with no user context); the billing SDD's B-029 repeats that gate for products, prices and invoices, and B-031 (catalog governance) and B-030 (price authority) stay separate.

## Options considered

**A. Service authorization model**
1. *Identity-only tokens, each target decides ad hoc (today).* Rejected for production: "registered" means broad access.
2. *Scoped tokens (claims carry capabilities and scope).* Rejected for now: the opaque-digest token cannot carry claims, it needs signing infrastructure that ADR-0033 deferred, and it revokes only by expiry.
3. *Identity token plus server-side policy in each target.* **Adopted** (decision 2).
4. *Hybrid: stable identity plus signed capabilities (signed service JWTs).* The documented evolution: ADR-0033 anticipates it ("changes one module per service") but also states it needs asymmetric signing and a key endpoint in Auth, which is not built and is outside Auth's frozen scope. Not adopted now; not decided here.

**B. Validating a producer-asserted organization**
1. *Trust the producer (today).* Rejected except for the admitted first-party producers of decision 4.
2. *Reference lookup against organization-service at the first assertion, memoized.* **Adopted** (decision 5).
3. *Signed assertion by the hierarchy authority.* Long-term option; needs signing infrastructure.
4. *A locally cached copy of the anchors.* Rejected: duplicates hierarchy data that memoization makes unnecessary.
5. *Asynchronous verification after creation.* Rejected for financial creates, because invoices and payments are immutable records.

**C. How organization-service learns what a user may do**
1. *Call Auth's existing `platform-access`.* Works, but Auth derives platform to company from its reference cache, which produces the chain client, organization-service, Auth, organization-service (the guardrail in ADR-0041).
2. *Auth publishes the caller's own grant facts; organization-service evaluates them against its own anchors.* **Adopted** (decision 6, with the facts of owner decision D4).
3. *Use `/auth/me` alone.* Not adopted: it returns no owner company and no assignments, and extending it changes a contract that is frozen pending BD-8.

**D. Other:** a central Admin Service or a business-owning gateway (rejected, ADR-0041); organization-scoped tokens (not adopted: the owner chose Platform as the scope dimension, D2).

## Decision

The architecture owner decided the following, because each keeps authorization in the service that owns the operation, needs no token redesign, and leaves Auth's login, refresh and `/auth/me` untouched. Decisions marked **D1** to **D4** are the owner's answers recorded in the owner-decision sheet; the other points are the drafted decisions, accepted together with this ADR.

1. **Authentication is unchanged.** Service tokens identify a service only (ADR-0033). A user bearer is never a service credential and a service token never carries a user.
2. **Service authorization is server-side policy in each target (Model C, option A.3), deny by default, with Platform as the scope dimension (D2).** A policy maps each caller to **capabilities** and, where relevant, a **platform scope**. A service credential scoped to a Platform may operate only within that Platform's hierarchy, subject to the specific authorization policy of the target service. Organization scope is derived from the Platform. **Company provisioning sits outside this scope** (a Company has no Platform).
   - **Resolution.** Billing and Payment carry `organizationId` (Billing on the invoice, Payment on the payment) and record no `platformId` on invoices or payments. Platform scope is therefore resolved through the organization-service hierarchy (organization to platform, decision 5). **This is an architectural dependency on organization-service. It does not add `platformId` to Billing invoices or Payment records**, and nothing in this ADR requires it.
   - **Currency clarification.** `platform_currency.platformId` in Billing is a currency-configuration reference and remains that. It does not mean that a Platform has only one currency: a Platform may permit several (for example EUR and TND). This ADR does not modify Billing's currency model, and how Billing learns the Platform of an invoice remains open (B-036a).
   - Model D (option A.4) is a possible evolution once signed tokens exist; it needs issuer and key publication that do not exist today, and audience is enforced only by construction (a token is registered only in its callee) until then. Whether policy semantics carry over is not verified.
3. **Capabilities (conceptual; names are not fixed here):** a reference read (ids and parents only), a full read, a write (create or update Platform and Organization) and a **provisioning capability (create Company)**. Read and write are separate, which would remove RR-1 once implemented. The provisioning capability is not an ordinary organization-admin capability (D1). No delete or archive capability exists until lifecycle is decided.
4. **Producer admission (D3): explicit first-party producer admission per target service, with a documented admission list and minimum server-side validation.** Admission is registration plus a documented first-party producer list, enforced per target service. It is not implied across targets.

   | Caller | Target | Admission |
   |---|---|---|
   | `billing-service` | Payment Service | Admitted |
   | `auth-service` | Payment Service | Admitted |
   | Organization Service | any target | Not admitted by this decision |
   | Other producers | any target | Not admitted unless explicitly authorized |

   Other producers are not admitted until added through the same architecture-controlled process. **Minimum validation:** (1) a valid service credential; (2) the credential belongs to the registered producer; (3) the producer is explicitly admitted for the target service and operation; (4) the request identity and producer cannot be overridden by client input; (5) resource ownership and producer invariants are validated server-side; (6) organization and platform scope are validated server-side where applicable; (7) an invalid or unauthorized producer request fails closed.
   - **Four concepts, kept apart:** service authentication (which service is calling), service authorization (what it may do and for whom), producer admission (whether it may create obligations at all), and rate limiting. **Rate limiting is abuse and blast-radius protection, not authorization.** Per-producer rate limits stay and are not admission.
   - **Relation to the SDD gates.** The two admissions above are the non-test producers this decision admits. The payment SDD gates O-13 ("beyond the test fixture") and O-15 ("non-trusted producers") and the billing SDD gate stay in force until the policy is implemented and those SDD items are updated.
   - Admission is "for the target service and operation" (validation item 3). **The operations for which each admitted producer is admitted are part of the documented admission list and are not enumerated by the owner decision or by this ADR**; in particular the operations admitted for `auth-service` in Payment are not stated. Until they are listed, no operation is treated as decided for either producer.
   - Enforcing a platform scope on an admitted producer uses the organization-to-platform resolution of decision 2.
5. **Hierarchy validation:** a producer-asserted organization is validated against organization-service **at the first assertion to a target**, using the reference capability only, bounded and **fail closed on creates**, never on reads and never on any Auth path. A positive result may be memoized **only while ids are never reused and anchors never change** (ADR-0024; the id-reuse invariant is still Proposed in the Stage 10.0 decisions). A memo is effectively a small local copy of anchors, so its location and contents (organization id, platform id, company id; no names, no status) must be fixed in the implementing SDD; it proves identity and anchors only, **not** that the organization is active, which is the lifecycle question (BD-5). No cross-service foreign key and no full local copy of the hierarchy are introduced.
6. **Human path to organization-service (D4):** organization-service hosts the human-facing hierarchy API after the cutover, because it owns the data; it is **internal only initially**, and whether any administrative surface is publicly reachable stays open (ADR-0041). The flow is:

   ```text
   Client -> Auth bearer authentication -> Organization Service authorization
   ```

   The client presents the user's bearer; organization-service authenticates the user through Auth and obtains server-derived facts about the caller from Auth. **Clients never supply authorization facts:** a client may request an operation but cannot declare its own role, organization, platform, scope or permissions. The authorization facts are:
   - the authenticated User identity;
   - the User's Company ownership relationship, where applicable;
   - active operator-to-Platform assignments;
   - active organization-administrator memberships, where applicable;
   - the target Company, Platform and Organization hierarchy, which organization-service owns;
   - the operation being requested.

   Organization-service **evaluates them against the anchors it owns** (owner: the owner's company equals the platform's company; operator: the platform is among the assigned platforms; organization administrator: the membership is for the organization concerned). This requires a new Auth read endpoint about the caller's own grants, authenticated by the user bearer alone, so Auth needs no service-token callee side. The exact schema of the facts and the endpoint contract are **not decided here**. `/auth/me` is not extended (which also depends on BD-8 and on ADR-0040's interim freeze). This departs from core-architecture §6 step 2, which names `platform-access` for this question, and it does not carry over that route's 403-versus-404 semantics; those are to be specified with the endpoint. No Tauri-specific, browser-specific or otherwise client-specific role, permission or rule exists (ADR-0041).
7. **Human authorization rules and Company creation.**
   - **Rules adopted from ADR-0020, ADR-0022 and ADR-0024 (whose headers remain Proposed):** the owner, scoped to a company, creates and edits platforms and assigns operators; the owner, or an operator with an active assignment on the platform, creates and edits organizations.
   - **Organization administrators may edit organization metadata (D4),** only for organizations for which the server-derived facts grant the required administrative capability. They do not create organizations under this decision.
   - **Operator step-up (D4):** operators require step-up for sensitive administrative operations; ordinary low-risk metadata operations do not require it unless separately classified as sensitive. Which operations are sensitive is not enumerated by the decision and is left to the implementing design, as is how step-up evidence reaches organization-service.
   - **Company creation (D1): different mechanisms for the first Company of a fresh environment and for later Companies.** *Later Companies*, once organization-service is authoritative, are created by a **dedicated, non-human provisioning identity in organization-service**, controlled by the deployment and provisioning process; its credentials are not exposed to ordinary human clients, and Company creation is a provisioning capability, not an ordinary organization-admin capability. *The first Company of a fresh environment* may be created by a **one-time bootstrap or provisioning operation**. After organization-service is authoritative, normal Company creation uses the organization-service provisioning identity and **not** Auth's legacy direct database or bootstrap path (ADR-0022's bootstrap Company insert, whose predecessor ADR-0016 is Superseded). Until the cutover Auth's tables remain authoritative and the existing bootstrap behavior is unchanged (ADR-0039, ADR-0040). This decision grants no human role Company creation; whether any human role may ever create one is tied to the multi-company question, which is not decided. No role is invented.
   - **What D1 leaves open:** the credential form of the provisioning identity and where it is stored; the mechanics and control of the one-time bootstrap operation; how Auth's owner bootstrap obtains the id of a Company that organization-service created (an owner belongs to a Company, so the Company exists first); and how this fits ADR-0040's Proposed cutover sequence, which activates organization-service with **no caller token registered**. Those are for the implementing design and ADR-0040.
8. **Auth independence:** login, refresh, logout, session validation, `/auth/me`, the member access check, registration, join, invitation consume and onboarding resolution never call organization-service. In the owner's D4 answer the human administrative dependency of decision 6 does not extend to login, refresh, `/auth/me`, registration, join or ordinary authentication-path operations; logout, session validation, the member access check, invitation consume and onboarding resolution are added from ADR-0040 decision 2 (Proposed). Auth's administrative first-touch calls are those of ADR-0040 decision 2. A static boundary test should enforce this for Auth.
9. **Audit minimum** (a floor, not the audit taxonomy, which is not decided; see BD-7 for where audit data is kept): for mutations and denials, record the caller identity, the capability, the outcome and reason class, the correlation id, the asserted scope and the target id; organization-service needs a **durable actor record** (user, session family where available, calling service) before it accepts writers in production. Policy version, token fingerprint and central forwarding are future; client type and device are not required.
10. **Rotation and revocation:** nothing is built. Before production the owner decides rotation cadence, the runbook and its completion proof, whether restart-based revocation meets the incident-response time, secret storage, and the rule of one token per caller-callee pair.

## Not decided here (as at acceptance; Amendment 1 resolves the items it names)

- Client technology, offline operation, device authorization, session enumeration and the audit taxonomy (unchanged from ADR-0041).
- Lifecycle semantics and ID reuse (BD-5), production topology (BD-7), `/auth/me` consumer compatibility (BD-8).
- Multi-company support; producer scope for sellers that are not organizations (Billing's seller type is not limited to organizations).
- **B-026, O-18, B-027, O-20, B-028** (staff and user-bearer relations to financial data, and who acts for a company seller), **B-030** (price authority), **B-031** (catalog governance, which also gates catalog writes) and **B-036** (including how Billing learns an invoice's platform and how platform currencies are administered).
- Whether a gateway or composition layer is created; whether signed capabilities (Model D) are adopted.
- **Details the owner answers did not enumerate** (left to the implementing designs, not decided here): the operations each admitted producer may use, in particular for `auth-service` in Payment; where and how the admission list is kept; the credential form and storage of the provisioning identity and the mechanics of the first-Company bootstrap; how Auth's owner bootstrap obtains the Company id; which administrative operations are "sensitive" for operator step-up and how step-up evidence reaches organization-service; which organization fields count as "metadata"; the schema of the grant facts and the Auth endpoint contract, including its failure semantics.

## Consequences

- **This records the decision mechanism** for O-13 (target-side policy and the admission list decide which services may create obligations), O-14 (the scope model: target-side policy with platform scope, answering the SDD's guard-scope wording) and O-15 (first-assertion validation), and for the producer-scope part of B-029; it gives F23 an authorization model by adopting the rules of ADR-0020 and ADR-0022. **Nothing is implemented, and the SDD items close only when their implementation gates are met and the SDDs are updated.** O-15 also depends on O-5, O-6 and O-18 for staff and company access. Nothing in the "Not decided" list is closed.
- **Easier (once implemented):** least privilege per caller with no token change; each admitted producer limited to the operations on its admission list; scope changes never reissue tokens; the hierarchy authority stays the only evaluator of hierarchy relationships; no synchronous cycle between Auth and organization-service; no client-specific authorization.
- **Harder or given up:** organization-service gains a dependency on Auth for human requests (Auth's frozen scope, "None now" in core-architecture §10, is relaxed by the one new read endpoint and by ADR-0040's first-touch calls); each target carries a policy, an admission list and a capability check; Billing and Payment gain a bounded synchronous dependency on organization-service **for creating obligations for a newly asserted organization** (not for reads or authentication); Auth gains one read endpoint; memoization is correct only if ids are never reused; Company creation needs a provisioning identity and a first-Company bootstrap that do not exist yet; step-up evidence must reach organization-service for sensitive operator operations.
- **Residual risk:** until the policy is implemented, RR-1 and the Auth-token-on-Payment finding (Auth's token accepted at the guard on create, cancel, `GET /payments/:id` and the attempt start and sync routes although Auth is admitted for a list of operations that is not yet written) stand.
- **Follow-up (none started):**
  - update the documents that state the old questions: payment SDD §19 O-13 to O-15 and its gate wording, billing SDD B-029, core-architecture §6 step 2, §7, §10 and §11, the organization-service SDD and README, the Auth ADD and SDD, ADR-0040's open item on who creates a Company and its cutover sequence (**done in ADR-0040 Amendment 1**), and an amendment note on ADR-0022's bootstrap;
  - implementation stages, each a separate task: the capability and admission policy (in the kit or per service), the Auth grant endpoint, the organization-service reference capability and provisioning identity, the first-Company bootstrap, the durable actor record, the Auth boundary test;
  - a lifecycle ADR; a production topology and gating ADR.

## Amendment 1 (2026-09-20): operator step-up, sensitivity, hierarchy validation, Platform scope of service credentials

- **Status:** Accepted, recorded from the architecture owner's written direction of 2026-09-20 on DEC-1 to DEC-5. It refines this ADR; **it does not downgrade it and reverses none of D1 to D4 or AD-1 to AD-5**.
- **What it clarifies or supersedes.** Each row names the original text and the effect.

| Original text | Effect of Amendment 1 |
|---|---|
| Decision 5, AD-3 and AD-5: validation "against organization-service"; AD-3's "must use the explicitly approved pre-cutover mechanism from AD-5"; AD-5's "before cutover the current authoritative Auth hierarchy ... may validate" | **Clarified, and superseded in effect for one clause.** Organization Service is the sole service-facing hierarchy validator. Auth remains the authority for its own data before cutover but **exposes no service-facing validation endpoint**. AD-5's clause is therefore *permitted but not exercised*, and AD-3's "must use the pre-cutover mechanism" is **superseded in effect**, because no such mechanism exists (A.3). The production sequencing constraint this creates is derived, and the owner is asked to confirm it (A.3) |
| Decision 2, D2 and AD-3: Platform scope "where relevant", "each production credential" | **Clarified.** Platform scope applies to production service credentials that access Organization Service, evaluated by Organization Service (A.5) |
| Decision 7, D4 and AD-1: operators need step-up for sensitive operations | **Made precise.** The step-up contract, the sensitive operations and the treatment of owners are stated (A.1, A.2) |
| "Not decided here": details the owner answers did not enumerate (the operator step-up evidence path, the sensitive classification, the platform lists per producer, the first-Company rule and Auth's Company row) | **Resolved as stated below**, except the one item marked OPEN |

### A.1 Operator step-up (DEC-1)

**Decision.** The existing Auth step-up architecture is the foundation and is **extended** for operator-sensitive administrative operations. No unrelated second authentication architecture is created. The step-up proof is:

- **single-use**: consumed once, atomically, and invalid afterwards;
- **session-bound**: valid only in the session (`sid`) in which it was obtained;
- **purpose-bound**: valid only for the named sensitive-operation purpose;
- **short-lived**: valid for a short window, at most the existing step-up ceiling (Auth's `STEP_UP_TTL_SEC`, with its 15-minute database ceiling);
- **server-generated and server-validated**: the client can never assert that a step-up occurred.

**What step-up is.** A proof of **recent re-authentication for a specified purpose**. **Step-up does not grant authority**: it only adds a requirement to an operation the principal is already authorized to perform (A.2).

**Existing owner purposes remain valid** and unchanged (for example `platform.create`). Operators receive **explicit operator-sensitive purposes**; no owner purpose is treated as an operator permission.

**The operator working code is not itself the step-up.** It is a login and confirmation credential: its purposes are `login` and `confirmation` only, and it is redeemed into a **new** session, so it has no session binding. The step-up extension therefore adds, in Auth (later work): new purpose values, a session binding, the short window, and an authenticated request path; the operator **re-authenticates with the operator authentication credential that exists today** (a fresh one-time code delivered out of band, requested from within the live session). This decision introduces no second factor for operators. Because that credential is delivered on the same channel as the login code, the proof establishes recent control of that channel and is **not an independent factor**; the owner direction accepts extending the existing mechanism on that basis. An independent operator factor would be a separate, later decision and is not decided here.

**Verification path (contract for Stage 10).** Organization Service verifies the proof **through Auth**: an Auth endpoint authenticated by the user's bearer that validates and consumes the proof for the session and purpose. Organization Service acts only after Auth confirms. The consume happens before the write, so a failed write requires a new step-up. Auth has no service-token callee side and needs none for this. The step-up transport is a header (`x-step-up-token`, the existing name); no client type, origin or device is read.

### A.2 Sensitivity and authority (DEC-2)

**Authority is unchanged.** Organization Service authorizes human administration from **server-derived facts obtained from Auth**: the authenticated User, the User's Company ownership where applicable, active operator-to-Platform assignments, active organization-administrator memberships where applicable, the target Company, Platform and Organization hierarchy (which Organization Service owns) and the requested operation. **The client supplies none of these**: not a role, organization, platform, company, permission, scope, ownership, operator assignment or an authorization result.

**Invariant.** *Sensitive does not mean authorized.* Classification only requires step-up; it never grants an operation. **Operators do not gain Platform creation or edit authority**; Platform administration stays with the owner. Organization administration rests on the server-derived assignment and membership facts. Where a sensitive operation is performed, **whoever performs it** presents a step-up: owners with their existing mechanism, operators with the extension of A.1.

| Operation (current Organization Service surface) | Authority | Sensitive? | Step-up |
|---|---|---|---|
| create Platform | owner, own company | **sensitive** (named by AD-1) | owner: existing purpose `platform.create` (designed; its route is not built) |
| change Platform metadata (`name`; `key` is not writable through the API; `companyId` immutable) | owner | **OPEN-3: not classified.** AD-1 lists "Platform-level administrative configuration" as sensitive, and whether `name` is that is the open question (the code is itself ambiguous: a comment says a Platform is "named at creation and never changed afterwards", while the update input accepts `name`). Until the owner classifies it, the accepted default (ordinary unless explicitly classified) applies; that is an interpretation the owner is asked to confirm | none until classified |
| create Organization | owner; operator on an assigned platform | **sensitive** (named by AD-1) | owner: a **new owner purpose**; operator: a new **operator-sensitive purpose** (names fixed in the Stage 10 contract) |
| change Organization metadata (`name`, `taxCode`, `address`, `phone`, `type`; `platformId` immutable) | owner; assigned operator; organization administrator of that organization (where the facts grant it) | **not sensitive**: ordinary low-risk metadata, none separately classified | none |
| create Company | the dedicated provisioning identity, and the one-time bootstrap for the first Company (D1). **No human role is granted it by this decision**; whether any human role may ever create one is tied to multi-company support, which is undecided | not applicable to the provisioning identity | not applicable |
| change Company metadata (`name`; `PATCH /organization/companies/:id` exists today) | **no holder is named.** The provisioning capability creates only, and the service write capability covers Platform and Organization. Denied by default until an owner decision names one | **OPEN-4: not classified** | not applicable until a holder exists |
| change a hierarchy link (Platform's company, Organization's platform) | none: immutable by trigger and refused by the API | no category is created | not applicable |
| reads | per the facts | not sensitive (ADR-0025) | none |

Organization administrators perform no sensitive operation, so they need no step-up. **No "hierarchy-sensitive metadata" category is created**: no current field would populate it, and AD-1's "ownership or hierarchy-sensitive metadata" and "Platform-level administrative configuration" apply to any future field only if the Organization Service authorization contract classifies it.

### A.3 Hierarchy validation (DEC-3)

**Decision.** **Organization Service is the server-side authority for hierarchy validation.** There is **no** Auth hierarchy-validation endpoint, **no** shared hierarchy database, **no** second authoritative copy, and **no** client-supplied hierarchy claim. For a service request to Organization Service:

```text
service caller
   -> Organization Service
        authenticate the credential                        (a caller name only, ADR-0033)
        the credential belongs to a registered producer
        the producer is explicitly admitted for this target and operation
        the request cannot override the credential's identity
        resolve Organization -> Platform                   (Organization Service's own hierarchy)
        verify the Platform is inside the credential's allowed Platform scope   (A.5)
        authorize the requested operation                  (capability)
        resource ownership and producer invariants hold
        fail closed at every step
```

The credential is never the only decision. The order of evaluation is an implementation detail provided every check must pass and a denial reveals nothing the caller may not know. **Rate limiting remains abuse and blast-radius protection and is not authorization.**

**Admission at Organization Service** (in addition to D3, which admits `billing-service` and `auth-service` to Payment only):

| Caller | Capability | Basis |
|---|---|---|
| dedicated provisioning identity | provisioning (create Company) only | D1 |
| `payment-service` | reference read (ids and parents only) | Decision 5 and Consequences |
| `billing-service` | reference read; used only if a use arises (no producer is admitted to Billing today), so its Platform set is empty until then | Consequences (names Billing) |
| `auth-service` | full read (first-touch `ensure`) | ADR-0040 decisions 1 and 2 (adopted, ADR-0040 Amendment 1) |
| Organization Service as a caller; any other service | none | D3 |

**Derived entries (owner confirmation requested).** The entries for `payment-service` and `billing-service` derive from decision 5 and its Consequences, which name Billing and Payment as callers of the reference read; D3 says other producers are "not admitted unless explicitly authorized", so these entries, including the empty Platform set for `billing-service`, are stated for the owner to confirm. The same applies to the rule that Company reads are authorized by admission and the full-read capability (A.5).

The Payment decisions are unchanged: **`billing-service` to Payment may create, retrieve and cancel; `auth-service` to Payment has no approved operation merely because it is admitted.** The route `GET /payment/licenses/:id/status`, which Auth calls for its registration and join license check, **does not exist** in Payment; it must not be read as permission, and no generic Payment capability is created for it.

**Consequence for the wording of AD-3 and AD-5.** The two are consistent as follows. *The outcome is mandatory:* whenever a request made with a Platform-scoped production credential involves an Organization, the Organization-to-Platform relationship must be resolved from the active hierarchy authority and lie inside the credential's scope, or the request fails closed. *Auth is the pre-cutover authority for its own data but offers no service-facing mechanism.* Therefore **before Organization Service is authoritative, a Platform-scoped production credential cannot have an Organization-involving request validated; such a request fails closed**, and such credentials are not enabled for those requests in production until cutover (test fixtures excepted). This is derived from the owner direction and the two answers, and is stated so that production enablement of Organization-involving payments is sequenced after the cutover. **The constraint applies even though D3 admits `billing-service` to Payment:** Billing's requests to Payment that involve an Organization fail closed before cutover. **The owner is asked to confirm this derived consequence.** A request that involves **no Organization** is not subject to Platform-scope resolution (D3 item 6, "where applicable") and remains subject to admission, operation authorization and ownership. (This concerns Platform-scope resolution only; it decides nothing about producer scope for sellers that are not organizations, which stays open, A.6.)

**The decision 5 memo is not a second copy.** It is a bounded, non-authoritative optimization, permitted only while ids are never reused, which depends on I1 (ADR-0040 decision 6). *Update: I1 is accepted (ADR-0040 Amendment 2), so the memo is permitted on those conditions; see Amendment 2 below.*

### A.4 Cutover and Auth's reference cache (DEC-4)

The validated non-authoritative reference cache of ADR-0040 decisions 1 and 2 is **adopted**, with the fresh-environment sequence and the one-way-door rule recorded in **ADR-0040 Amendment 1**. Auth is not a second authority. After cutover Organization Service owns Company, Platform and Organization. Auth owns User, credentials, sessions, MFA, recovery and membership, and keeps the hierarchy tables only as a reference cache for its own relationships. The authentication path (login, refresh, `/auth/me`, registration, join, ordinary authentication operations) **never** calls Organization Service (decision 8, unchanged).

### A.5 Platform scope of service credentials (DEC-5)

**Decision.** **Platform is the service-authorization scope.** A production service credential that accesses Organization Service carries an **explicit** `allowedPlatforms` set. There is no implicit all-Platform access and no wildcard.

```text
credential allowedPlatforms = [P1, P2]
request organization O17;  Organization Service resolves O17 -> P2;  P2 allowed  -> authorized
request organization O99;  Organization Service resolves O99 -> P7;  P7 not allowed -> denied
```

- **Organization Service resolves** `organizationId -> platformId` and evaluates the credential's set. **The client never supplies the authoritative Platform scope.**
- **Two layers, both kept** (the covering-set rule is derived; owner confirmation requested). A producer's own Platform scope in a target (for example `billing-service` in Payment, AD-3) is evaluated by that target after resolution. The set on a service credential used against Organization Service is evaluated by Organization Service. A credential used on behalf of several producers (Payment) needs a set that covers the sets of those producers; changing one changes the other through the same architecture-controlled process as admission (D3).
- **Auth's credential** carries an explicit set that lists every Platform Auth must reference. **A new Platform does not become reachable by Auth until its set is extended**; there is no automatic grant. The procedure that extends it belongs to the implementing SDD and runbook (production change control is deferred by decision 10). Under the current revocation model a set change is a configuration change applied by restart, which decision 10 leaves for the owner to assess before production.
- **Company provisioning is outside Platform scope** (D2). The dedicated non-human provisioning identity is controlled by the deployment and provisioning process, is never exposed to human clients, and is not an organization-admin permission or a User role. The first Company may be created through a one-time controlled bootstrap; later Companies use the same provisioning identity. Provisioning is not forced into the Platform-scoped credential model.
- **Company-level reads** (derived from D3 item 6; owner confirmation requested). A read of a Company has no Platform, so Platform-scope resolution is "not applicable" (D3 item 6); it is authorized by admission and the full-read capability. Whether a credential is further restricted to particular Companies is tied to multi-company support, which stays undecided.
- **Financial integrity.** **No `platformId` is added to Billing invoices or Payment records** for this decision. Billing's `platform_currency.platformId` remains **Platform currency configuration**: it is not transaction ownership, it does not mean a Platform has one currency (a Platform may permit several, for example EUR and TND), and it is not read as part of scope. Historical financial snapshots are untouched.

### A.6 Not decided after Amendment 1

- **OPEN-3 (OPEN: OWNER DECISION REQUIRED, not blocking):** whether changing a Platform's `name` is sensitive. The accepted default (ordinary unless classified) applies until the owner decides; that default is an interpretation, because AD-1 names "Platform-level administrative configuration" as sensitive.
- **OPEN-4 (OPEN: OWNER DECISION REQUIRED, not blocking):** who may change a Company's `name`, and whether it is sensitive. No holder is named, so it is denied by default until decided.
- Unchanged and independent of DEC-1 to DEC-5: client technology, offline operation, device authorization, session enumeration and the audit taxonomy (ADR-0041); lifecycle and id reuse (BD-5), production topology (BD-7), `/auth/me` consumer compatibility (BD-8); multi-company support; producer scope for sellers that are not organizations; B-026, O-18, B-027, O-20, B-028, B-030, B-031, B-036 (including how Billing learns an invoice's platform); a gateway or composition layer; signed capabilities; rotation cadence, revocation time, secret storage and change control (decision 10).
- **Implementation details left to the Stage 10 contracts and SDDs**, not architecture questions: the names of the new step-up purposes, the Auth verify-and-consume and grant endpoints, denial status codes, the durable actor record, the policy format and the memo location.

### A.7 Implementation boundary

Nothing is implemented by this amendment or by the acceptance of this ADR. Implementation is a separate phase, and it does not begin merely because these decisions are recorded.

## Amendment 2 (2026-09-20): consequences of ADR-0040 being Accepted

- **Status:** ADR-0042 **stays Accepted**. This amendment changes no decision; it updates statements that depended on ADR-0040 being Proposed.
- **What is updated.**
  - **The memo (decision 5, A.3).** I1 (a hierarchy id is never reused) is accepted as a migration invariant (ADR-0040 decision 6, Amendment 2, A2.3). A memo of a positive lookup is therefore permitted, while I1 holds, anchors never change and the memo is non-authoritative. It proves identity and anchors only, never that an organization is active. The invariant is interim and lasts until a lifecycle ADR decides otherwise; if it ever ends, memoization ends with it.
  - **References to ADR-0040 as Proposed** (the Related note, decision 8's reference to its decision 2, A.3's admission basis for `auth-service`, A.4) now read **Accepted**. The full-read admission of `auth-service` no longer waits on an unaccepted ADR.
  - **"Not decided after Amendment 1" (A.6).** Production topology and gating (BD-7) is now decided **as gates** (ADR-0040 decision 7); lifecycle semantics and id reuse beyond I1 stay undecided (BD-5); `/auth/me` compatibility stays frozen (BD-8).
  - **The production sequencing constraint (A.3).** Platform-scoped production credentials fail closed for Organization-involving requests until cutover. The cutover is itself gated by ADR-0040 decision 7, so their production enablement follows the gates G1 to G7 and the approved authority activation.
  - **Follow-up.** ADR-0040's open item and cutover sequence are done (Amendments 1 and 2).
- **Unchanged.** The confirmations marked "derived" in A.3 and A.5, OPEN-3 and OPEN-4 (non-blocking, defaults as recorded in A.2 and A.6), and everything Amendment 1 leaves undecided.
- **Implementation boundary.** Nothing is implemented.
