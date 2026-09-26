# 0050. Platform administration and verified human authority

- **Status:** Accepted <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (2026-09-26, by the owner, after the Stage 19.1 review:
  D2 to D7 approved, D1 verified, R1 resolved, see the [Stage 19.1 record](../architecture/stage-19/stage-19-1-decisions-and-roadmap.md) §14.
  **Acceptance is a decision about architecture only:** nothing is implemented until the Stage 19.2+ implementation stages are authorized.)
- **Date:** 2026-09-26
- **Deciders:** Anwar (project owner). D2 to D7 were decided by the architecture owner on 2026-09-26.
- **Amends:**
  - [ADR-0049](./0049-audit-trail-architecture.md) decisions A6, A36b and A57, for the one read path of decision 6; ADR-0049 is otherwise
    unchanged.
  - [ADR-0017](./0017-single-owner-with-secret-key-force-reset.md), [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md)
    and [ADR-0027](./0027-service-layer-security-model.md), on the force-reset CLI only (decision 14).

  Each amended ADR carries a dated back-pointer.

> Related: [ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Accepted 2026-09-26: domain-owned,
> client-neutral administration), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) (Accepted: its human path is
> the pattern generalized here), [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (Accepted 2026-09-26: "a service
> token never carries a user"), [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) and
> [ADR-0027](./0027-service-layer-security-model.md) (both Accepted 2026-09-26: owner MFA, step-up, live authorization),
> [ADR-0030](./0030-multi-organization-membership-and-revoked-state.md) (a member may belong to many organizations),
> [ADR-0026](./0026-authentication-is-not-entitlement.md) / [ADR-0038](./0038-entitlement-in-billing-service.md) (entitlement is not
> identity). Evidence: the Stage 19.1 record.

## Context

Stage 19 asks who may administer Nawara Core, how that human is represented across service boundaries, and how privileged actions are
authorized and audited. The Stage 19.1 investigation found that most of the answer already exists and is implemented:

- **Humans.** Auth has three kinds of user:
  - `owner`: one per Company, with MFA, factor-only step-up and cool-down recovery.
  - `operator`: created and blocked by the owner, and scoped by platform assignments. An operator logs in with an out-of-band working
    code, has shift-bounded sessions, and has **no independent second factor**.
  - `member`: a global identity with 0..N organization memberships, possibly in organizations of **different Companies** (ADR-0030).
    Organization-admin authority is a membership flag, not a kind.
- **Live authorization.** Auth's guard reloads the user and the session on every request (`isActive`, session family, and the token's
  tier must equal the database kind). The other services verify user bearers live through Auth, so blocking or revoking takes effect on
  the next request, not at token expiry.
- **The human administrative path.** ADR-0042 decision 6 defines it, and organization-service's `admin/` module implements it:
  - the human's own Auth bearer reaches the service that owns the data;
  - that service obtains server-derived grant facts from Auth, evaluates them against the anchors it owns, and verifies and consumes a
    step-up through Auth for sensitive operations;
  - it then mutates its own state and writes central audit evidence, with the verified human as the actor, in the same transaction.
- **Audit scope.** Audit records carry an optional `organizationId` and **no Company or Platform attribute**. Records with a null
  organization ("platform-level", for example `owner.*`, `operator.*`, `account.*`, `company.*`, `platform.*`) belong to no organization.
  Audit's `read_platform` scope therefore spans **every Company** of a deployment. The data model allows several Companies (ADR-0022).
- **Gaps:**
  - a member account cannot be suspended at the platform level; only operators can be blocked;
  - no human path to Audit exists, and ADR-0049 A36b forbids Audit calling Auth;
  - operator step-up (ADR-0042 A.1) is accepted but not built;
  - there are no fine-grained operator capabilities;
  - organization lifecycle is undecided (BD-5).

## Options considered

**How a privileged human action reaches the owning service**

1. **Human bearer direct to the owning service, verified through Auth (the ADR-0042 pattern).** The target verifies the human live,
   evaluates authority against its own state, and records the verified human. No intermediary can forge a human. **Chosen.**
2. **Service-asserted human.** An admin backend authenticates as a service and names the human in a header or body field.
   **Rejected:** any compromise or bug in that backend forges any human. It contradicts ADR-0033 and ADR-0042 decision 1.
3. **Signed delegation assertion**, naming the human, the audience and the capabilities. It needs issuer keys, publication, rotation,
   audience and replay handling, and adds nothing while humans can reach the owning service themselves. **Deferred** until a flow exists
   in which a human cannot present their own bearer.

**Where platform administration lives**

- **A: existing authoritative services, with direct verified-human administration.** **Chosen.**
- **B: A plus a thin composition layer.** Not needed: no Core V1 requirement demands one. A future admin UI may add presentation
  infrastructure under the constraints of decision 13.
- **Rejected:** a new Platform Administration service owning administrative logic (ADR-0041 option 1). The same goes for any
  component with write access to other services' databases.

**How a human reads Audit evidence**

- **Audit-X: Audit verifies the human itself through Auth and records the actual human in its self-audit.** **Chosen.**
- **Audit-Y: a new admin backend calls Audit with its service token.** **Rejected:** it creates a trusted proxy whose only job is to be
  trusted, and Audit's own evidence would name the proxy, not the human.

## Decision

1. **The verified human model: the human's own bearer, the target decides (Core V1).** A privileged human presents their **own**
   authenticated Auth bearer to the **authoritative target service**. The target:
   - authenticates the human through Auth (live);
   - verifies the current account state (active, session active, tier = kind);
   - verifies scope against state it owns or obtains from Auth;
   - verifies authority for the specific operation;
   - requires a step-up where the operation demands one.

   Only then does it authorize, mutate its own state and write its durable audit intent. **No general signed delegated-human token
   system is introduced;** option 3 remains a future possibility, gated on a demonstrated need.
2. **Identity is never asserted by a header or by linkage.** Service identity is not a human actor: a service token names a service,
   never a user. `correlationId` and `causationId` are linkage, never identity. Headers such as `x-operator-id`, `x-admin-user-id`,
   `x-user-kind` or `x-acting-user`, and any body field naming an actor, kind, Company or scope, are **never** authority.
3. **Authority = verified identity + relationship facts + scope. The operator is not a super-admin.** The accepted relationships stay the
   authority model:
   - the owner of the Company;
   - an operator with an active assignment on the Platform;
   - an organization administrator of the Organization.

   No kind means "allow everything":
   - the owner's authority is bounded by its own Company, its Platforms and their Organizations;
   - an operator's authority is bounded by its assignments and by the operations explicitly granted to operators.

   New privileged operations name their holder explicitly.
4. **Operators: current onboarding authority unchanged; no new sensitive security intervention until an operator step-up exists (D7).**
   Operators keep exactly what they have today:
   - organization metadata edits on assigned Platforms;
   - join codes, and membership approval, rejection and revocation, in organizations of assigned Platforms.

   They receive **no** new sensitive security intervention until an operator step-up with an independent factor exists (ADR-0042 A.1). It
   is scheduled before any stage that grants such authority. **Operator organization creation stays deferred** (D4): operators remain
   refused where `organization.create` requires a step-up.
5. **Account suspension (D5) and its reason (D6).** Implemented in Auth (Stage 19.2). The rule:
   - **Who:** the Company owner only, with a **factor** step-up (TOTP or passkey; never the bare secret key), for both suspend and restore.
   - **Target, derived from persisted state only:**
     - a member is eligible only if they have at least one active membership in an organization of the owner's Company **and no active
       or pending membership in an organization of any other Company**. Suspension is global (`isActive`), so suspending a member who also belongs to
       another Company would act on that Company;
     - an operator is eligible if `operator.companyId` is the owner's Company;
     - the request body never supplies the Company or the scope.
   - **Refused:**
     - a member with an active or pending membership in another Company, or with no active membership in the owner's Company;
     - the owner themselves, and any other owner.
   - **Effect:**
     - it reuses `"user"."isActive"`, so every existing live check enforces it immediately;
     - all of the account's sessions are revoked in the **same transaction**;
     - it is state-idempotent: suspending a suspended account succeeds and writes nothing.
   - **Why:** Company-scoped authority must not produce cross-Company denial of access. Company-specific access disabling (as opposed to
     disabling the global identity) is a separate, future architecture concern; Stage 19 neither redesigns membership nor adds it.
   - **Operators:** the existing owner block/unblock of operators is unchanged. It stays a no-step-up emergency control (ADR-0025).
   - **Reason:** a closed reason code, recorded in the audit event. **Free text never enters central audit.** The Core V1 set is
     `compromised_account`, `security_incident` and `policy_violation` (rationale: Stage 19.1 record §6.3). The code is required for
     member suspension; operator block carries none (it is an emergency control), and restoration carries none.
6. **Audit evidence read by the owner (Audit-X, D3), with its exact scope.** Implemented in audit-service (Stage 19.3). The owner's own
   bearer reaches Audit, and Audit:
   - verifies the owner through Auth (live);
   - verifies that **the requested organization** belongs to the owner's Company through Auth's live organization lookup, called with
     the owner's own bearer (a collapsed 404 otherwise);
   - executes the read;
   - records `platform_query.executed` with the **actual owner** as actor, in the same transaction as the read. If that record cannot be
     written, nothing is returned (fail closed).

   **Scope:**
   - exactly one organization of the owner's Company per request;
   - platform-level records (null organization) and unfiltered cross-organization sweeps are **not** available to owners, because Audit
     cannot attribute them to a Company. They stay service-only (`read_platform`). Widening them needs Company attribution in the audit
     contract: a separate, future ADR-0049 amendment;
   - the Stage 18 query bounds apply unchanged: at most 31 days per request, at most 100 records per page, cursor paging, validated
     filters and a rate limit (per human on this path);
   - no operator reads;
   - no step-up: reads are not step-up operations (ADR-0025), and a read is self-audited and rate-limited instead.

   Auth being unavailable fails the human read closed (503). The amendment to ADR-0049 is narrow:
   - **A36b:** Audit calls **Auth only**, and only on this human read path. Ingestion and service-token reads stay Auth-free.
   - **A6:** Stage 19 is an admitted **human** reader through Audit's own verification, not an admin backend.
   - **A57:** the self-audit names the verified human.
7. **Domain ownership stays with the authoritative services (ADR-0041).**

   | Service | Owns |
   |---|---|
   | Auth | user and security state (accounts, sessions, credentials, operators, assignments, memberships) |
   | organization-service | Company / Platform / Organization state (behind the ADR-0039 authority gate) |
   | Billing | commercial state |
   | Payment | settlement |
   | File | files |
   | Notification | delivery |
   | Audit | immutable evidence; nobody mutates it |

   Platform administration is a set of capabilities of these services, not a second owner.
8. **No god admin database.** No Stage 19 component has write access, or any access, to another service's database. Every administrative
   operation goes through the authoritative service's API.
9. **Same-transaction audit.** Every audit-worthy administrative mutation writes its durable audit intent **in the same transaction** as
   the mutation, in the authoritative service (the Stage 18 outbox). The model "admin layer mutates, then makes a best-effort audit
   call" is rejected. Actions are semantic and domain-owned; no generic `admin.action` exists.
10. **Security suspension is not commercial state.** Suspension is Auth security state. Billing, subscription, entitlement or payment
    state never represents or implies it, and suspension is never used as a substitute for commercial expiry (ADR-0026, ADR-0038).
11. **Minimization.** Administrative reads are purpose-specific projections (identifiers, state, timestamps), never "everything about a
    user". Scope is explicit in the route; there is never an `organizationId = *`.
12. **Out of Stage 19:**
    - organization lifecycle (suspend or archive; BD-5);
    - ownership transfer or emergency owner replacement beyond Auth's recovery;
    - platform-wide membership intervention beyond the owner's organization-scoped powers;
    - any commercial or settlement mutation by staff: manual subscription grants, sponsorship, prepaid redemption, entitlement or
      payment-success overrides, pricing, seats. These belong to Commercial V2 or the commercial services;
    - Notification and File administration;
    - break-glass, which is the single owner with cool-down recovery;
    - support cases and notes;
    - operator capability sets;
    - product administration (Drive, ERP, School, AI);
    - release management (Stage 20, which may reuse this model).
13. **A future admin UI.** If one needs a backend or BFF, that is presentation and composition infrastructure. It holds no authority, no
    business rule and no state. It forwards the human's own bearer, and is never the authority for Auth security, Organization,
    Billing, Payment or Audit (ADR-0041 decision 5). None is created in Stage 19.
14. **The Core V1 owner recovery surface (R1).** The ADR-0017 CLI secret-key force-reset, referenced by ADR-0025 and ADR-0027, **was
    never implemented, is not part of Core V1 and is not built by Stage 19**; Stage 19 introduces no privileged recovery CLI.
    - A leaked secret key is rotated in-band: `owner.secret_key.rotate`, with a TOTP or passkey step-up.
    - Lost factors go through the existing cool-down recovery (ADR-0027), which is the extreme recovery path.
    - **Direct database manipulation is not an approved operational recovery procedure.**

    ADR-0017, ADR-0025 and ADR-0027 keep their text as history, with dated amendment notes.

## Consequences

- **Easier:**
  - no new trust anchor, no key management and no delegation replay surface;
  - suspension and revocation take effect on the next request everywhere;
  - every administrative mutation lands in the audit trail with the human who did it;
  - no new deployable service;
  - Stage 20 can reuse the model.
- **Harder or given up:**
  - a member who belongs to several Companies cannot be suspended by any owner in V1;
  - owners cannot read platform-level evidence (including `account.*` records) until Company attribution exists;
  - operators stay without security interventions until an operator factor exists;
  - Audit gains a bounded Auth dependency on one read path, failing closed;
  - a future UI calls several services with the human's bearer.
  - an owner who has lost the password has no approved recovery in Core V1 (recovery needs password + key, and no out-of-band
    reset or ops path is approved). This is recorded as a limitation under the privileged-account policy prerequisite.
- **Production prerequisites and follow-up:** see the Stage 19.1 record, §15 and §13.
