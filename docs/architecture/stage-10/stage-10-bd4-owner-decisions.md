# Stage 10: BD-4 owner decisions required before ADR-0042 can be Accepted

- **Status:** **owner answers recorded.** The architecture owner answered D1 to D4 (answers dated 2026-09-19 as given by the owner) and stated acceptance of [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md), subject to those answers being recorded as the owner's decisions. The evidence, options and consequences below were written before the answers and are kept unchanged as the historical decision request; they selected and recommended nothing. The owner's answers are in each **Owner decision** block, recorded as given. Where a block and an earlier section differ, the block governs.
- **Date:** 2026-09-20
- **Update (2026-09-20):** the architecture owner then gave a direction on the remaining questions DEC-1 to DEC-5 (the operator step-up, sensitivity, the validation mechanism, Auth's reference cache and Platform scope of service credentials). They are recorded in **section 7** below and in [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) Amendment 1 and [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) Amendment 1. Sections 0 to 6 are the earlier D1 to D4 record and are kept unchanged.
- **Companion documents (not modified by this document):** [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) (Accepted), the [BD-4 study](./stage-10-bd4-service-authorization-study.md), [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) (Proposed), [ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Proposed), [ADR-0039](../../adr/0039-organization-ownership-and-cross-service-migration-authority.md).
- **Numbering:** D1 to D4 here are owner-decision numbers. They map to the study's matrix as D1 = study D8 (company creation), D2 = study D3 (scope dimension), D3 = study D6 and ADR-0042 decision 4 (interim gate), D4 = study D7 (human path). The study's own D1 to D13 are unchanged.

## 0. Baseline verified for this document

| Check | Result |
|---|---|
| ADR-0042 header status | at the time of the request: Proposed. **After the owner's answers and acceptance statement: Accepted** (architecture only; nothing implemented) |
| ADR-0042 final conformance review | no blocker; seven wording corrections applied afterwards, all wording only |
| ADR-0039 | unchanged from `HEAD` |
| ADR-0040, ADR-0041 | Proposed, byte-identical to their previous baselines |
| Earlier Stage 10 studies (before BD-4) | unchanged |
| BD-4 study and ADR-0042 | each changed in one sentence during the readiness check (Billing's only `platformId` is the opaque key of its Platform-currency configuration table; no invoice or payment stores one); no decision changed |
| Runtime, database, migration, production configuration | no diff under `apps/`, `libs/`, `infra/`, `docker-compose.yml`, `.env.example`, `.github/`, `scripts/` |

**Acceptance gate (as it stood, and what happened).** ADR-0042 was to remain `Proposed` until D1 to D4 were explicitly resolved and recorded. They are now recorded below and the owner stated acceptance, so ADR-0042 is `Accepted`. Acceptance does not start implementation: no migration, no service-token scope implementation, no change to Organization Service, Auth, Billing, Payment or service-kit is made by this record.

**How to answer (as requested).** Each decision ended with `APPROVE / REJECT / MODIFY`. Because the options are alternatives and not a proposal, `APPROVE` means "I choose the option I name in the record line", `REJECT` means "none of these, and ADR-0042's draft on this point is not accepted", and `MODIFY` means "a changed or different option, described in the record line". The owner answered in descriptive form and did not use the three words; the answers are recorded as given.

---

### D1 — Company provisioning identity

**Question:**
After Organization Service becomes authoritative for Company, Platform and Organization, **what identity is permitted to create a Company?**

**Current evidence:**

- **Today, in Auth.** The `bootstrap-owner` command (`apps/auth-service/src/cli/main.ts`, `owner-tools.ts:31`) takes `BOOTSTRAP_COMPANY_NAME`, `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_OWNER_PASSWORD`, inserts a `company` row into Auth's own database when none exists, then creates the owner. No route creates a Company. ADR-0022 specifies this behavior (it supersedes ADR-0016, which is **not** current authority and created an owner, not a Company). ADR-0040 calls this "today's only provisioning path" and says the choice "must be decided before production cutover completes"; the Stage 10.0 study lists it as BD-4, BLOCKED.
- **In Organization Service today.** `POST /organization/companies` exists behind the service-token guard. In the compose configuration no caller token is registered (`SERVICE_TOKENS` is empty), so no service can call it. The repository contains no other deployment or production configuration for Organization Service (only compose, its README and CI); production topology is BD-7 and undecided. The claim is therefore "no registered caller in any configuration in the repository", not a verified statement about a running production system. Any token that were registered could create Companies, because there are no capabilities (risk RR-1). Organization Service is not authoritative yet.
- **Multi-company.** ADR-0022 records multi-company support as an open question ("never actually exercised"); today exactly one company is assumed.
- **A fresh environment needs a defined identity.** Owners and operators are users of a company, so before the first Company and its owner exist there is no human principal to authorize. After the cutover Auth's hierarchy tables are frozen (ADR-0040 decision 3), and ADR-0040 states that the cutover "would remove today's only provisioning path". Some identity for creating the first Company must therefore be defined; which one is the question.

**What is already decided:**

- Company, Platform and Organization move to organization-service at the cutover (ADR-0031, ADR-0039), and only Organization Service owns them afterwards.
- ADR-0022's bootstrap behavior above is the existing behavior; nothing changes it until a decision does.
- No new user, membership, role, permission or company-administration **service** is created (CLAUDE.md, ADR-0041).

**What remains open:** the identity that may create a Company after cutover; whether any human role may ever create one (tied to the undecided multi-company question); the order between creating the Company and bootstrapping its owner; how ADR-0022's "create a Company if none exists" step is reconciled with Auth's post-cutover freeze (ADR-0040 leaves it open); whether the deployment-time initialization of a fresh environment uses the same identity as later provisioning.

**The five concepts that must not be conflated:**

| Concept | Meaning | Status |
|---|---|---|
| Existing ADR-0022 bootstrap | Auth's CLI inserts the Company and owner in Auth's database | **EXISTING** |
| Future post-cutover authority | the one identity or role permitted to create a Company in Organization Service | **OPEN (this decision)** |
| Human administration | an authenticated owner or operator using an API | **OPEN** for Company; ADR-0020/0022 rules exist for Platform and Organization (Proposed) |
| Service provisioning | a non-human, non-interactive caller holding a provisioning capability | **OPEN** |
| Deployment or bootstrap initialization | creating the very first Company of a fresh environment | **OPEN**; there is no human principal yet |

**Decision options** (none is recommended; ADR-0042's draft corresponds to option A and is cited only as a fact about the draft):

A. **A dedicated provisioning identity in Organization Service**, holding only a provisioning capability, used by an operator-run command; the Company is created first and the owner bootstrap then takes the Company id. (This is what the ADR-0042 draft proposes.)
B. **Auth's bootstrap command keeps creating the Company, by calling Organization Service** with a service token that holds a create capability. Auth would hold a write capability for Companies.
C. **A human role creates Companies through an authenticated API**, for example a platform-level or product-level owner. This needs the multi-company question decided and a role that does not exist today.
D. **Another Core service or a provisioning workflow** creates Companies. Not designed; needs O-13 and O-14 answers of its own.
E. **Different mechanisms for the first Company of a fresh environment and for later Companies**, chosen by the owner (for example an initialization step at deployment, and a separate path afterwards).

**Consequences:**

- A needs one new identity and a provisioning capability; the first Company of a fresh environment and later Companies use the same path only if the owner says so; Auth needs no write access to Organization Service.
- B keeps today's operator experience and makes Auth a caller that holds a Company-create capability in Organization Service; that capability would have to be granted to Auth specifically.
- C is blocked on the multi-company decision and on a human role that would have to be invented.
- D is undesigned; it adds a caller and a workflow and does not remove the need for an identity.
- E needs two identities or paths defined, and the owner must say whether they may differ.
- In every option the cutover sequence of ADR-0040 (which activates Organization Service with **no** caller token registered) must be reconciled with the chosen identity; this is a dependency, not an answer.

**Owner decision:** Dedicated provisioning identity in Organization Service, with a separate bootstrap mechanism for the first Company.

Record (owner's answer, as given):

- **Option:** Different mechanisms for the first Company of a fresh environment and for later Companies.
- **Identity:** A dedicated, non-human provisioning identity controlled by the deployment/provisioning process.
- **Location/mechanism:** Organization Service provisioning boundary; credentials must not be exposed to ordinary human clients.
- **First-Company handling:** A fresh environment may use a one-time bootstrap/provisioning operation to create the first Company. After the Organization Service becomes authoritative, normal Company creation uses the Organization Service provisioning identity rather than Auth's legacy direct database/bootstrap path.
- **Authorization boundary:** Company creation is a provisioning capability, not an ordinary organization-admin capability.
- **Date:** 2026-09-19
- **Decider:** Architecture owner

---

### D2 — Platform scope

**Question:**
**Is Platform the scope dimension for service authorization?** That is, when a target service limits what a producer may do, is the limit expressed as a set of allowed Platforms?

**Current evidence:**

- A service token today identifies only a caller name; there are no scopes, claims, audience or expiry. "Registered" means broad access to every service-token route.
- Billing stores `organizationId` on the invoice (`0003_invoice.sql`) and Payment stores `organizationId` on the payment (`0002_payment.sql`). **Neither the Billing invoice nor the Payment record stores a `platformId`.** The one `platformId` in Billing is the opaque key of its `platform_currency` configuration table (`0009_platform_currency.sql`; no foreign key, no invoice references it, and nothing calls it yet, B-036). The producer asserts the organization id and only its uuid shape is checked.
- In the hierarchy Company → Platform → Organization, the Platform and the Company of an Organization are derived from the parent chain owned by the hierarchy authority; parents are immutable by database trigger in Auth's tables and in Organization Service's own.
- How Billing learns the Platform of an invoice is the separate open item B-036(a).

**What is already decided:** nothing about scope. ADR-0022 and ADR-0024 (both Proposed) treat Platform as the stable tenancy boundary for human authorization; the study's matrix records that as the reason the ADR-0042 draft names Platform, and that draft is Proposed.

**What remains open:** the scope dimension itself; how the organization → platform mapping is obtained (the reference capability is the ADR-0042 draft's mechanism, and it needs the id-reuse invariant of BD-5); how Billing gets an invoice's Platform (B-036a); whether some capabilities (Company provisioning) sit outside any platform scope.

**Precise consequences if Platform is approved as the scope dimension:**

1. Enforcing a platform scope on an organization-based request requires **resolving organization → platform** at validation time. It is an **architectural dependency on the hierarchy authority**, not a stored field.
2. It does **not** require adding `platformId` to Billing invoices or Payment records. Adding one would be a separate decision (B-036a) and is not made here.
3. Hierarchy validation belongs to Organization Service; Billing and Payment ask it and do not evaluate hierarchy relationships themselves.
4. It must **not** make Auth login, refresh, logout, session validation or `/auth/me` depend on Organization Service (ADR-0040 decision 2; ADR-0042 decision 8).
5. A positive lookup proves identity and anchors only; it does not prove that the organization is active (lifecycle, BD-5).
6. Company provisioning is not a platform-scoped act, because a Company has no Platform; D1 decides who does it.

**Decision options:**

A. **Platform is the scope dimension.** A policy lists, per caller and capability, the Platforms it may act in; organization scope is derived from the Platform.
B. **Organization is the scope dimension.** A policy lists individual organizations.
C. **No scope dimension yet: capabilities only.** A caller is limited by what it may do, not by where; scope is deferred until a decision on B-036 and lifecycle.

**Consequences:**

- A needs the organization → platform resolution above, and a small policy per target.
- B needs the policy to change whenever an organization is created, or a wildcard that removes the limit (ADR-0042's draft lists organization-scoped tokens among the alternatives it does not propose; that draft is Proposed, so no rejection is recorded).
- C removes RR-1 only in the read-versus-write sense; it does not bound a producer to a tenant, so O-14's "limits which organizations a producer may bill" stays unanswered.
- Rejecting all three leaves the SDD gate for non-trusted producers in force.

**Owner decision:** Platform is the service-authorization scope dimension.

Record (owner's answer, as given):

- **Option:** Platform.
- **Provisioning sits outside this scope:** Yes.
- **Authorization meaning:** A service credential scoped to a Platform may operate only within that Platform's hierarchy, subject to the specific authorization policy of the target service.
- **Resolution:** Because Billing and Payment primarily carry `organizationId`, Platform scope is resolved through the Organization Service hierarchy rather than adding `platformId` to Billing invoices or Payment records.
- **Currency clarification:** `Billing.platform_currency.platformId` remains a Billing currency-configuration reference. It does not mean that a Platform has only one currency. A Platform may permit multiple currencies, such as EUR and TND.
- **Date:** 2026-09-19
- **Decider:** Architecture owner

---

### D3 — Trusted producer interim gate

**Question:**
**Which first-party producers may create billable obligations before scoped or signed capabilities exist, on what basis, and what minimum validation is required for them?**

**Current evidence:**

```text
Current:   registered token  =  trusted caller
           (no admission list, no scope, no audience, no expiry)

Proposed interim (ADR-0042 decision 4, Proposed):
  registered first-party producer
        -> explicit target-service admission
        -> producer identity
        -> validated resource / scope
```

- Registered callers in the repository's configuration: Payment (compose) registers `billing-service` and `auth-service`; Billing registers no inbound caller and Organization Service registers none. The digests in the root `.env.example` are dev-only pairs. No production configuration in the repository registers any token, so production registrations are not verified. A test caller appears in specs. The payment SDD gates "any producer beyond the test fixture" and "production use by non-trusted producers" on O-13, O-14 and O-15.
- Producer-asserted `organizationId` is checked for uuid shape only (and equality with `seller.id` when the seller is an organization). A record belongs to the producer whose name it stores.
- **Per-producer rate limiting is an abuse control, not authorization**: it bounds volume for any caller that is already accepted and says nothing about what that caller may create or for whom.

**What is already decided:** the payment SDD records a gate, in two wordings: O-13 gates "enabling any producer beyond the test fixture", and O-15 and the SDD's gate summary gate "production use by non-trusted producers"; the billing SDD gates payment requests "outside the test fixture". Whether a trusted first-party producer is inside or outside the gate is part of this decision. The ADR-0042 draft (decision 4) reads the gate as admitting trusted first-party producers only, and that reading is Proposed.

**What remains open:** which first-party producers are admitted; whether admission is specific to each target service or holds across services; the minimum validation that must exist for an admitted producer before stronger capabilities exist; who maintains the admission list and how a change is reviewed. **No allow-list is proposed here; the fill-in below is for the owner.**

**Four different things, kept apart:**

| Concept | What it answers | Today |
|---|---|---|
| Authentication of the token | which service is calling | implemented (`ServiceTokenGuard`: caller name only) |
| Authorization of the caller | what that caller may do, and for whom | not implemented; any registered caller may use any service-token route |
| First-party producer admission | which producers are permitted to create obligations at all | not implemented; documented only as an SDD gate |
| Rate limiting and abuse protection | how much a caller that is already accepted may do | implemented per producer for creates; **it is not authorization** |

**Owner's statements (filled only from the owner's answer):**

| Item | Owner's answer |
|---|---|
| Producers admitted, per target (Billing, Payment, Organization Service) | `billing-service` and `auth-service`, for Payment Service; Organization Service and other producers not admitted |
| Whether admission in one target implies admission in another | "enforced per target service" (owner's wording); the owner did not say more |
| Minimum resource validation for an admitted producer: uuid shape and record ownership only (today); plus the organization exists (reference lookup); plus its platform is in the producer's allowed set (needs D2) | the seven items of the D3 record above; the owner did not state which of the three sheet variants applies beyond "validated server-side where applicable" |
| Who may change the admission list, and the review it needs | "the same architecture-controlled process" (the owner did not name a person or a further review step) |

**Decision options:**

A. **Admission is specific to each target service.** Each target holds its own explicit list; being admitted by Payment does not admit a producer in Billing or Organization Service.
B. **Admission follows token registration, with a documented first-party list.** A registered token continues to mean acceptance, but registration is allowed only for a documented list of first-party producers; where that list is kept is for the owner.
C. **No producer beyond the test fixture is admitted until the reference lookup and platform scope exist.** The interim gate stays closed.

**Consequences:**

- A is the smallest change to the trust model in each target and needs a policy in each; the lists can diverge.
- B keeps today's mechanism and adds a documented gate; a registered token still carries broad access inside a target until a policy exists, so it does not by itself limit what an admitted producer may do.
- C delays every production producer, including the two registrations already in compose, until the mechanism exists.
- In all three, rate limiting stays and must not be described as admission, and rotation and revocation are unbuilt (ADR-0042 decision 10; owner decisions on cadence and secret storage are separate).

**Owner decision:** Explicit first-party producer admission per target service, with a documented admission list and minimum server-side validation.

Record (owner's answer, as given):

- **Option:** Registration plus a documented first-party producer list, enforced per target service.
- **Admitted producers:** `billing-service` → Payment Service; `auth-service` → Payment Service.
- **Other producers:** Not admitted until explicitly added through the same architecture-controlled process.
- **Minimum validation:** (1) Valid service credential. (2) Credential belongs to the registered producer. (3) Producer is explicitly admitted for the target service and operation. (4) Request identity/producer cannot be overridden by client input. (5) Resource ownership/producer invariants are validated server-side. (6) Organization/platform scope is validated server-side where applicable. (7) Invalid or unauthorized producer requests fail closed.
- **Important distinction:** Rate limiting remains abuse/blast-radius protection and is not authorization.
- **Date:** 2026-09-19
- **Decider:** Architecture owner

Admitted-producer table (owner's answer, as given):

| Caller | Target | Admission |
|---|---|---|
| `billing-service` | Payment Service | Admitted |
| `auth-service` | Payment Service | Admitted |
| Organization Service | Any target | Not admitted by this decision |
| Other producers | Any target | Not admitted unless explicitly authorized |

---

### D4 — Human grant-facts shape

**Question:**
**What authorization facts should Organization Service receive or derive from Auth for human administration?** The shape of the facts, and the endpoint that returns them, are undecided; this decision does not choose a schema.

**Current evidence (only what ADR-0042 establishes):**

```text
Client
  -> presents the user's Auth bearer to Organization Service
        -> Organization Service authenticates the user through Auth
        -> Organization Service obtains the caller's own grant facts from Auth
        -> Organization Service evaluates them against the anchors it owns
              (server-side authorization decision)
```

- The client is not the authorization authority. It presents a bearer; it supplies no role, permission, scope, `organizationId`, `platformId`, `userId` or client type as authority.
- The facts the already-designed rules (ADR-0020, ADR-0022, both Proposed) need are the owner's company and an operator's active platform assignments. The ADR-0042 draft, written before the owner's answer, left organization-admin memberships out of the first shape; the owner's D4 answer includes them and governs.
- A new Auth read endpoint about the caller's own grants, authenticated by the user bearer alone, is the ADR-0042 draft's mechanism. `/auth/me` is not extended, and no Auth authentication path calls Organization Service.

**What is already decided:** the flow above is Proposed, not decided. The rule that authorization comes from the server and not from a client is existing architecture (ADR-0027, ADR-0028, ADR-0033, core-architecture §6) and ADR-0041 (Proposed) carries it to administration.

**What remains open:** which facts; whether the endpoint is new or an existing one; how failure is expressed (the existing `platform-access` route's 403 versus 404 semantics are not carried over automatically); whether organization admins may edit organization metadata; whether operators need step-up for hierarchy writes; how this depends on BD-8 (`/auth/me` consumer compatibility) and on ADR-0040's interim freeze.

**Guardrails any answer must satisfy (from ADR-0041 and ADR-0042; both Proposed):** no client-specific authorization; no Tauri-specific rule; no browser-specific rule; no client-specific role; no client-supplied role; no client-supplied scope (organization, platform or any other); the grant facts describe **the authenticated caller only**, so asking with arbitrary ids reveals nothing beyond the caller's own facts.

**Decision options** (about which facts; no schema is proposed):

A. **The owner's company and an operator's active platform assignments only.** Organization Service evaluates the two designed rules against its own anchors.
B. **Option A plus organization-admin memberships**, to allow organization-level administration by organization admins if the owner later permits it.
C. **No grant facts: Organization Service asks Auth a yes-or-no question per operation** (the existing `platform-access` style). The study records that this makes Auth derive the platform's company from its own reference cache, producing a synchronous chain client, Organization Service, Auth, Organization Service (the guardrail in ADR-0041 decision 7).

**Consequences:**

- A needs one new Auth read endpoint and matches the rules as designed; it leaves organization-level edits by organization admins undecided, which stays in the "not decided" list.
- B enlarges the facts and the surface, and decides nothing about whether organization admins may edit; that would still need its own decision.
- C needs no new endpoint. The study records that, with the reference cache of ADR-0040 (Proposed), it produces the synchronous chain that ADR-0041 decision 7 (a Proposed guardrail) describes.
- ADR-0042's draft considered using `/auth/me` alone or extending it and does not propose it: it returns no owner company or assignments and extending it would change a contract that is frozen pending BD-8. That is a Proposed reading, not a rejection; any other shape, including that one, may be chosen through `MODIFY`.

**Owner decision:** Organization Service authorizes human administration using server-derived ownership and assignment facts from Auth; clients never supply authorization facts.

Record (owner's answer, as given):

- **Option:** Owner's company + operator's active platform assignments, plus organization-admin memberships.
- **Authorization facts:** authenticated User identity; the User's Company ownership relationship where applicable; active operator → Platform assignments; active organization-administrator memberships where applicable; target Company/Platform/Organization hierarchy; operation being requested.
- **Client authority:** None. The client may request an operation, but cannot declare its own role, organization, platform, scope, or permissions.
- **Organization admins may edit metadata:** Yes, but only for organizations for which the server-derived authorization facts grant the required administrative capability.
- **Operators require step-up:** Yes for sensitive administrative operations; ordinary low-risk metadata operations do not require step-up unless separately classified as sensitive.
- **Authentication path:** Client → Auth bearer authentication → Organization Service authorization.
- **Auth dependency constraint:** This human administrative dependency does not extend to Auth login, refresh, `/auth/me`, registration, join, or ordinary authentication-path operations.
- **Date:** 2026-09-19
- **Decider:** Architecture owner

---

## 5. Dependencies between the decisions

| Depends on | Why |
|---|---|
| **D3 needs D2** | the interim gate's "validated resource / scope" step is a platform scope only if D2 selects Platform |
| **D3 needs the reference lookup** | admitting any producer beyond the test fixture requires at least an existence check of the asserted organization, which needs the BD-5 id-reuse invariant if results are memoized |
| **D1 interacts with D2** | Company provisioning has no Platform, so it is either outside the scope dimension or handled by its own rule |
| **D1 interacts with ADR-0040** | the cutover activates Organization Service with no caller token; the chosen provisioning identity must be reconciled with that sequence and with ADR-0022's "create a Company if none exists" |
| **D4 needs D1 only for the first environment** | an owner's company id exists only after the Company exists |
| **D4 interacts with BD-8 and ADR-0040** | the `/auth/me` non-extension rule and the first-touch calls are Proposed, and BD-8 is open |
| **D2, D3, D4 all touch RR-1** | until a capability policy exists, any registered token in Organization Service has full read and write |

None of D1 to D4 answers B-026, O-18, B-027, O-20, B-028, B-030, B-031, B-036, BD-5 (lifecycle and id reuse), BD-7 (production topology), BD-8, client technology, offline operation, device authorization, session enumeration, or the audit taxonomy. Those remain open.

## 6. Artifacts to update after the owner decisions (not updated now)

| Artifact | What changes |
|---|---|
| [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) | record each decision, resolve "Not decided" and "Owner input" items, then set the status (Accepted, Rejected or revised Proposed) |
| `docs/adr/README.md` | the ADR-0042 status row |
| [BD-4 study](./stage-10-bd4-service-authorization-study.md) | matrix rows D3, D6, D7, D8; section 18 (dependencies) and the readiness section |
| [Stage 10.0 decisions](./stage-10.0-ownership-migration-decisions.md) | section 7 (BD-4), status from BLOCKED |
| [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) | the open item "who creates a Company after cutover"; cutover sequence if D1 changes it |
| [ADR-0022](../../adr/0022-company-and-platform-entities-with-operator-assignment.md) | an amendment note if the bootstrap "create a Company" step changes (D1) |
| `docs/sdd/payment-service.md` | section 19 open items O-13, O-14, O-15 and the gate wording |
| `docs/sdd/billing-service.md` | B-029 and its gate; B-036(a) only if D2 or D3 affects it |
| `docs/architecture/core-architecture.md` | section 6 step 2 (`platform-access`), section 7, section 11 open items, section 10 Auth "None now" |
| `docs/sdd/organization-service.md` and `apps/organization-service/README.md` | authorization model, RR-1, provisioning path |
| Auth ADD/SDD | the grant endpoint (D4), the bootstrap command (D1) |
| `docs/architecture/README.md` | index rows if new documents are added |

Implementation stages (policy in the kit or per service, the Auth grant endpoint, the reference capability, the durable actor record, the Auth boundary test) are **out of scope of this record**: ADR-0042 is Accepted, and implementation is a separate phase that does not begin merely because it is accepted.

---

## 7. Owner decisions DEC-1 to DEC-5 (recorded 2026-09-20)

Recorded from the architecture owner's written direction. **Nothing is implemented; recording a decision does not start implementation.** Each block has the same fields. "Decision" is normative text; the ADRs named under "Affected ADRs" carry the authoritative wording.

### DEC-1: operator step-up

- **Decision.** Extend Auth's existing step-up architecture for operator-sensitive administrative operations. The proof is single-use, session-bound, purpose-bound, short-lived and server-generated and server-validated; a client can never assert that step-up occurred. Step-up proves recent re-authentication for a purpose and **grants no authority**. Existing owner purposes remain valid; operators get explicit operator-sensitive purposes. The operator working code is not itself the step-up: it is a login and confirmation credential and has no session binding. The operator re-authenticates with the operator authentication credential that exists today (a fresh out-of-band one-time code requested from within the live session); **no second factor is introduced**. Organization Service verifies the proof through Auth (user-bearer authenticated).
- **Rationale.** The existing mechanism already provides every required property for owners. Operators have no factor to re-verify, and the direction forbids an unrelated second authentication architecture unless the existing one demonstrably cannot support the properties. It can, by extension.
- **Consequences.** The proof establishes recent control of the operator's contact channel, which is also the login channel, so it is **not an independent factor**; the notification path becomes part of the proof (ADR-0027's broker-transit residual applies to the new use). Auth gains new purposes, a session binding and a short window in a later stage. Organization administrators still have no step-up and need none, because they perform no sensitive operation.
- **Affected ADRs.** ADR-0042 (Amendment 1, A.1); ADR-0025 (extended, owner purposes unchanged); ADR-0028 (forward note: operators, not org admins); ADR-0027; ADR-0041 (client neutrality preserved).
- **Implementation implications.** Auth: operator step-up purposes, a session-bound store or column, a session-authenticated request route, a verify-and-consume endpoint; Organization Service: forwards the user's bearer, the token and the purpose, consumes before it writes, and on an `Idempotency-Key` replay returns the stored result without a second consume; tests for single use, expiry, another session, another purpose and a client-claimed step-up.
- **Remaining open questions.** None blocking. An independent operator factor is not decided (a later, separate decision if wanted). Purpose names and the exact window inside the existing ceiling are Stage 10 contract details.

### DEC-2: human administrative authority and sensitivity

- **Decision.** Organization Service authorizes human administration from server-derived facts from Auth; the client supplies none. Operators gain no Platform creation or edit authority. Sensitive operations require step-up from **whoever performs them**; ordinary low-risk metadata does not. **Sensitive today:** create Platform (existing owner purpose), create Organization (a new owner purpose and an operator-sensitive purpose). **Ordinary:** Organization metadata changes (`name`, `taxCode`, `address`, `phone`, `type`). **Unclassified:** changing a Platform's `name` (**OPEN-3**; the accepted default, ordinary, applies until classified). No "hierarchy-sensitive metadata" category is created, because no current field would populate it.
- **Rationale.** Sensitive does not mean authorized. The fields Organization Service has today are only the ones listed; hierarchy links are immutable by trigger and refused by the API, and no ownership field exists.
- **Consequences.** Owners creating an Organization present a step-up (a new owner purpose). An operator can reach only Organization create and Organization metadata edit. Future fields are classified through the Organization Service authorization contract.
- **Affected ADRs.** ADR-0042 (Amendment 1, A.2); ADR-0022 and ADR-0020 (rules adopted, unchanged); ADR-0025 (allow-list gains a purpose later).
- **Implementation implications.** The authority evaluator is pure and lives in Organization Service; the step-up requirement is a per-operation flag in its contract; tests assert that classification never widens authority.
- **Remaining open questions.** **OPEN-3** (Platform `name`; AD-1 names "Platform-level administrative configuration" as sensitive, so "ordinary by default" is an interpretation to confirm) and **OPEN-4** (who may change a Company's `name`; no holder is named, so it is denied by default): both OPEN, owner decision required, not blocking.

### DEC-3: Organization Service validation mechanism

- **Decision.** Organization Service is the server-side authority for hierarchy validation of service requests. There is no Auth hierarchy-validation endpoint, no shared hierarchy database, no second authoritative copy, and no client-supplied claim. A service request is checked for credential validity, registered producer, explicit admission for the target and operation, identity not overridable, Organization-to-Platform resolution, Platform scope, operation authorization and resource invariants, and fails closed. Rate limiting is not authorization. **Payment admission is unchanged:** `billing-service` create, retrieve and cancel; `auth-service` no Payment operation merely by admission; Organization Service and other producers not admitted; the route `GET /payment/licenses/:id/status` does not exist and is no permission.
- **Rationale.** One validator, in the service that owns the hierarchy (the owner's direction; ADR-0041, still Proposed, points the same way); no new copy or callee side in Auth; admission and operation authorization stay separate.
- **Consequences.** **Derived (owner confirmation requested):** before Organization Service is authoritative no service-facing validation exists, so Platform-scoped production credentials fail closed for Organization-involving requests until cutover (test fixtures excepted). This sequences production enablement of Organization-involving payments after the cutover. Requests with no Organization are not scope-resolved ("where applicable").
- **Affected ADRs.** ADR-0042 (Amendment 1, A.3; AD-3 and AD-5 wording clarified, not reversed); ADR-0040 (Amendment 1); ADR-0033 (authentication unchanged).
- **Implementation implications.** Organization Service policy (admission entries for `payment-service`, `billing-service`, `auth-service`, the provisioning identity), a reference-read capability, a restricted representation; consumers' reference clients stay off until cutover verification.
- **Remaining open questions.** None in this area. Denial codes and the memo location are implementation choices.

### DEC-4: Auth's reference cache and bootstrap sequencing

- **Decision.** ADR-0040's validated reference cache is adopted. After cutover Organization Service is the sole authority for Company, Platform and Organization; Auth is not a second authority and keeps the three tables only as a non-authoritative validated reference cache (names and keys may be stale). The freeze, verify, activate and retire model, the zero-write window and the one-way door are preserved: **before the first committed Organization Service write rollback can rest on a provable zero-write window; after it, ownership rollback requires reconciliation and is not automatic; no automatic rollback is invented.** The fresh-environment sequence is the owner's ten steps, reconciled with ADR-0040's single activation gate (step 3 reads as "holds the data", step 8 as the activation). *[Superseded 2026-09-20 by ADR-0040 Amendment 2, A2.5 to A2.7: one switch, ACTIVATE AUTHORITY; the fresh sequence is F1 to F7.]*
- **Rationale.** It resolves the foreign keys, stale or missing rows and bootstrap without a second authority, an event feed or a withdrawn anchor design, and keeps the authentication paths independent.
- **Consequences.** Auth loses its direct Company insert; the owner row references a row placed by a validated `ensure(companyId)`; Auth's read credential must exist before the fresh-environment owner bootstrap; ADR-0040 as a whole stays Proposed (decisions 5 and 6). *[Superseded 2026-09-20: ADR-0040 is now Accepted, section 8.]*
- **Affected ADRs.** ADR-0040 (Amendment 1); ADR-0039 (forward note, partly superseded); ADR-0042 (A.4).
- **Implementation implications.** Stage 10.2: `ensure`, the cache-write guard, the bootstrap change; Stage 10.1: state row, verification tooling.
- **Remaining open questions.** ADR-0040 decisions 5 and 6 (**OPEN-1**); BD-7 (**OPEN-2**); the owner's confirmation of the reconciliation reading of the sequence. *[All resolved 2026-09-20: see section 8. The ten-step reading and the door timing are replaced by ADR-0040 Amendment 2, A2.5 to A2.7.]*

### DEC-5: Platform scope for service credentials

- **Decision.** Platform is the service-authorization scope. A production service credential that accesses Organization Service has an **explicit** `allowedPlatforms`; there is no implicit all-Platform access. Organization Service resolves `organizationId` to `platformId` and evaluates the set (for example `[P1, P2]`: O17 resolves to P2, allowed; O99 resolves to P7, denied). The client never supplies scope. **Company provisioning is outside Platform scope** (dedicated non-human provisioning identity, deployment-controlled; a one-time bootstrap for the first Company; later Companies use the same identity). **No `platformId` is added to Billing invoices or Payment records.** Billing's `platform_currency.platformId` stays Platform currency configuration (a Platform may permit several currencies, for example EUR and TND).
- **Rationale.** Platform is the stable tenancy boundary (D2). Two layers give defense in depth: the producer's scope is enforced by its target, and the credential's scope by Organization Service.
- **Consequences.** Payment's set must cover the producers it resolves for; Auth's set must list every Platform Auth references, and a new Platform is not reachable until the set is extended; Company reads are not Platform-scoped ("where applicable"), so they are authorized by admission and the full-read capability.
- **Affected ADRs.** ADR-0042 (Amendment 1, A.5; D2, D3, AD-3 refined); ADR-0040 (Amendment 1, A1.2).
- **Implementation implications.** A policy structure with per-caller Platform sets and no wildcard; a documented procedure for extending a set when a Platform is created; a database catalog test that invoices and payments have no `platformId`.
- **Remaining open questions.** None blocking. Change control for scope sets follows D3's controlled process; production runbook, rotation and revocation timing stay deferred (ADR-0042 decision 10).

### 7.6 Open items after DEC-1 to DEC-5

| ID | Item | Status |
|---|---|---|
| **OPEN-1** | acceptance of ADR-0040 decisions 5 (import mechanism) and 6 (interim invariants I1 and I2) | **RESOLVED 2026-09-20** (accepted, section 8) |
| **OPEN-2** | BD-7a to BD-7e: production topology, gated migrations and activation, least-privilege roles, monitoring, backup and restore, rehearsal | **RESOLVED 2026-09-20** (accepted as production-readiness and cutover gates, section 8) |
| **OPEN-3** | whether a Platform `name` change is sensitive | OPEN: OWNER DECISION REQUIRED, not blocking (default applies) |
| **OPEN-4** | who may change a Company's `name`, and whether it is sensitive | OPEN: OWNER DECISION REQUIRED, not blocking (denied by default) |
| confirmations | the ten-step reading and the fresh-environment door: **resolved** (ADR-0040 Amendment 2, A2.7). The entries and consequence marked derived in ADR-0042 A.3 and A.5: still requested, not blocking | partly resolved |
| constraint | BD-8: `/auth/me` and onboarding resolution stay frozen; these decisions change neither | unchanged |

---

## 8. OPEN-1 and OPEN-2 (recorded 2026-09-20)

Recorded from the architecture owner's written direction. **This records architecture. It implements nothing, no rehearsal has run, and no production gate is met.** The authoritative wording is in [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) Amendment 2.

### 8.1 OPEN-1: ADR-0040 decisions 5 and 6

**Decision 5, accepted: the checksummed snapshot export and import.** Ownership transfer uses one consistent read-only snapshot of Auth's hierarchy, a deterministic checksummed export, verification of the export, a controlled Auth freeze, final verification under the freeze, a compare-and-insert import into Organization Service, verification of the imported data against the export digest, and only then activation. The guarantee is that *Organization Service receives exactly the verified hierarchy snapshot intended for cutover.* It is repeatable before activation. It is **not** replaced by `pg_dump`, which stays the backup tool.

**Decision 6, accepted: I1 and I2 as migration invariants, not a lifecycle policy.**
- **I1:** hierarchy ids are never reused.
- **I2:** existing hierarchy relationships are not reparented or mutated during the migration and ownership transition. **Reconciliation:** ADR-0040's original I2 was "no runtime path physically deletes a Company, Platform or Organization until a lifecycle ADR exists". The owner's wording differs, so **both are recorded** as I2(b) and I2(a) and neither guard is dropped. I2(a) restates immutability the databases already enforce (for `UPDATE`; delete and re-insert is covered only by I1 and I2(b)). I2(b) protects against the loss of `ON DELETE RESTRICT`, and is retained from the original text (if the owner intended I2(a) alone, I2(b) is the only part to withdraw). **They decide no deletion semantics, archival, restoration or future lifecycle.** Their duration (until a lifecycle ADR decides otherwise) is carried from ADR-0040's original wording and is longer than the direction's "during the migration and ownership transition"; the enforcement is Stage 10.1 work.

### 8.2 OPEN-2: production-readiness and cutover gates (BD-7a to BD-7e)

| Item | Accepted as |
|---|---|
| **BD-7a** | an **explicit production topology** is required, documented and approved, before any authority activation; no infrastructure product or provider is named; internal only initially |
| **BD-7b** | **deployment is not activation**; migrations are gated; only inert, expand-only changes ride a normal deploy; the authority switch is a separate, explicit, controlled action |
| **BD-7c** | **least privilege before activation**: neither Auth nor Organization Service may need a PostgreSQL superuser for ordinary runtime operation; roles are scoped per service |
| **BD-7d** | minimum monitoring and alerting **demonstrated in the rehearsal**; thresholds and retention set in the rehearsal plan |
| **BD-7e** | a documented backup procedure is not a verified restore; restore verified in the rehearsal; the owner states the RPO and RTO in the rehearsal plan (the ADR fixes the requirement, not the numbers); the requirement of a restore drilled on the real volume is **not waived**, and the plan states how it is met |
| **Rehearsal** | **one successful production-like rehearsal** of the whole ownership-transition procedure, with recorded evidence; unit tests are not a rehearsal |
| **Approval** | recorded results, all gates passed, then **explicit human approval**, and only then the real production activation; never a side effect of startup, migration, deployment, a health check, a connection or message consumption |

### 8.3 Accepted architecture, future work, and the evidence that exists

| | Content |
|---|---|
| **Accepted architecture** | everything in 8.1 and 8.2; one authority switch named ACTIVATE AUTHORITY; the existing-environment sequence E0 to E7 and the fresh-environment sequence F1 to F7 (ADR-0040 A2.5); the one-way door is the first committed hierarchy write after activation, with a manual zero-write window before it and reconciliation after it, and no automatic rollback (A2.6) |
| **Future implementation work** | Stage 10.1: the production topology design and its approval, the deployment workflow, production roles, the gated-migration mechanism, the export, import and verification tooling with the run table, the enforcement of I1 and I2(b), the state row, the backup job, the monitoring, the rehearsal plan and its execution; Stage 10.2: Auth's `ensure`, the cache-write guard, the bootstrap change; the removal of Auth's superuser posture |
| **Evidence already available** (from the repository's records; not re-verified against production) | a **local** restore drill on a scratch PostgreSQL 16.15 that proves the dump and restore *procedure* inside the server container (a newer host client failed), not production and not application-level; Organization Service's configuration already refuses, in production, a runtime login named `postgres`, `root` or ending `_migrator` (a name check, not a superuser test); local least-privilege roles (a migrator and a runtime role for Auth, Billing, Payment, Accounting and Organization Service, created by `infra/postgres/init/01-service-databases.sh`; `verify.sh` checks all of them except Auth; none for notification or the AI service) exist in `infra/postgres`, local only (production is a separate matter: Auth's production database runs as a superuser); an explicit migration runner exists (`npm run migrate`); health and readiness endpoints exist; Organization Service's tests are part of Core CI (`core-ci.yml`), which is not a rehearsal |
| **Not available** | any Organization Service production deployment or database; any production role for either service (Auth's production database runs as a superuser); a production backup job; a restore drilled on the real volume; documented monitoring; the export, import and verification tooling; a state row; a rehearsal plan or result; an approver. **No gate is met.** |

### 8.4 Confirmations resolved

- **The ten-step wording.** One switch, ACTIVATE AUTHORITY. The earlier ten-step list is replaced (ADR-0040 A2.5). Imported data does not make Organization Service authoritative.
- **The fresh-environment door.** The same as an existing environment: the first committed hierarchy write after activation. The earlier closing at the bootstrap is withdrawn (A2.6).

### 8.5 What remains open

| ID | Item | Status |
|---|---|---|
| **OPEN-3** | whether a Platform `name` change is sensitive | OPEN: OWNER DECISION REQUIRED, **not blocking**; the accepted default (ordinary) applies |
| **OPEN-4** | who may change a Company's `name` | OPEN: OWNER DECISION REQUIRED, **not blocking**; denied by default |
| **OPEN-5** | whether initial Platforms or Organizations must exist before activation in a fresh environment; no accepted decision grants a capability to create them while inactive | OPEN: OWNER DECISION REQUIRED, **not blocking Stage 10.1**; until decided the fresh initial hierarchy is the first Company only |
| deferred | BD-5 lifecycle semantics; BD-8; multi-company; the concrete topology (a gated Stage 10.1 deliverable); RPO and RTO values and monitoring thresholds (the rehearsal plan); B-026, O-18, B-036 | not decided, not needed to start Stage 10.1 |
