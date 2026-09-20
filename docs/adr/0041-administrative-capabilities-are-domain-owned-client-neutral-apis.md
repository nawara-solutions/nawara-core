# 0041. Administrative capabilities are domain-owned, client-neutral APIs

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (**draft; not approved.** Nothing in this ADR takes effect, and nothing is implemented, until the architecture owner accepts it.)
- **Date:** 2026-09-20
- **Deciders:** Anwar (project owner), approval pending

> Related: [ADR-0040](./0040-organization-ownership-migration-decisions.md) (Proposed when this ADR was written; **Accepted 2026-09-20**; **not amended** by this ADR) and [ADR-0039](./0039-organization-ownership-and-cross-service-migration-authority.md) (**not modified**). The analysis is in the [administrative client model study](../architecture/stage-10/stage-10-administrative-client-model-study.md).

## Context

Nawara may have several administrative clients over time. Tauri is a possible client for organization administration and for operator administration; a browser application is a possible client for either, instead of or as well; other clients are possible. **None of these is decided**, and the choice may differ per role and may change. The consumer product `nawara-drive` already contemplates one admin application delivered both as a browser build and packaged with Tauri, and carries its own Proposed ADR (numbered in that repository) to adopt Tauri for its Admin desktop app; those are consumer-product recommendations, not Core decisions, and they do not constrain Core.

Stage 10 makes the question concrete: after ownership of Company, Platform and Organization moves to organization-service, nothing designs a human-facing way to administer them (finding F23, open decision BD-4). Whatever is designed must not tie the backend to a client technology, and must not create a new owner of business rules just because there are several clients.

The repository already points one way. Core architecture §6 states that "operation authorization belongs to the service that owns the operation" and that Auth "is not the universal business-permission engine"; a list of services is "deliberately not created"; and ADR-0002 chose bearer tokens over plain HTTP/JSON precisely because the clients (a desktop shell, a mobile app, backend services) cannot be assumed to keep a cookie jar. What is missing is the rule stated once, explicitly, for administration.

## Options considered

1. **A central Admin Service that owns administrative business logic.** Rejected: contradicts "operation authorization belongs to the service that owns the operation"; would duplicate or capture authority over Auth, organization, billing and payment data; becomes a god service.
2. **One backend per client type (for example one for Tauri, one for a browser).** Rejected as a default: duplicates business rules, so the same operation could authorize differently per client.
3. **A neutral access or composition layer (gateway, BFF) that only routes, aggregates and adapts.** Acceptable in principle if it holds no business rule, no authority and no state; **creating one is not decided here.**
4. **Domain-owned, client-neutral APIs.** Proposed.
5. **Choose Tauri now, or a browser now.** Rejected: premature, and contrary to the requirement that delivery stays open.
6. **Encode the client type in authorization ("only Tauri may call this").** Rejected: client identity is spoofable and turns a delivery choice into a domain rule. Restricting network reachability is a legitimate deployment control and is a different thing.

## Decision (proposed)

We propose **Option 4**, because it keeps every capability with the service that owns its data, gives all clients one authorization model, and leaves the delivery mechanism replaceable; Options 1, 2 and 6 each move business rules or authority away from the owning service or into the client, and Option 5 forecloses an open choice. Status labels: items 1 and 3 mostly restate existing decisions (noted in each); items 2, 4, 5, 6 and 7 are new proposals.

1. **Domain ownership.** An administrative capability is an API of the domain service that owns the data it changes: identity, membership and operator administration belong to Auth, billing state to billing-service, payment state to payment-service, entitlement decisions to the entitlement capability of billing-service (ADR-0038), and, **from the ownership cutover** (ADR-0031, ADR-0039; until then Auth's tables remain authoritative), Company, Platform and Organization data to organization-service. No service is created whose purpose is to own administrative business logic. This restates core architecture §2 and §6 ("operation authorization belongs to the service that owns the operation"), the "services deliberately not created" list, and ADR-0030, ADR-0031 and ADR-0038. **Which service hosts a human-facing hierarchy administration API, and who may call it, is not decided here (BD-4).**
2. **Client neutrality.** Administrative services expose secure APIs defined by business capabilities and authorization, not by UI technology. An administrative API contains no rule specific to Tauri, to a browser or to any other client, no UI workflow assumption, no local-database authority and no client-controlled authorization.
3. **Server authority.** Authorization is decided by the server from server state, on every request. This restates ADR-0027 (live authorization), ADR-0028 and ADR-0033, and core architecture §6, which already lists `userId`, `organizationId`, `platformId`, `role` and `permissions` as never trusted without server-side verification; ADR-0025 already states that a User-Agent fingerprint is "a weak signal, never an authentication factor" (ADR-0010 gives the rationale, and the same wording is a comment in `apps/auth-service/src/owner/admin-device.service.ts`). *Correction 2026-09-20: this sentence previously attributed the quotation to ADR-0010.* **New here (PROPOSED):** a client type and an install identifier also never gate authorization.
4. **Client-specific concerns stay in the access layer.** They are limited to transport and authenticator binding (a bearer token, an allow-listed origin, an authentication factor, an optional device credential if one is ever adopted) and are expressed generically, not as business rules.
5. **Access or composition layers.** If one is ever created, it holds no business rule, no authority and no state, and decides nothing about who may do what.
6. **What stays open.** Which client (Tauri, browser, both, other) serves organization administration; which serves operator administration; whether any administrative surface is publicly exposed; offline operation; device identity; leases; and administrative UI technology. Any future offline design must satisfy these **guardrails (they are not a lease design)**: the server stays authoritative; local client state is never authoritative; the local clock is never the sole authority for a lifetime; offline authorization, if ever allowed, is an explicit, time-bounded, server-issued and server-revocable grant; clock-rollback detection is a heuristic and not a security boundary; entitlement is not carried in Auth tokens (ADR-0026, ADR-0038).
7. **No synchronous cycle (PROPOSED guardrail; update 2026-09-20: ADR-0040's reference cache is accepted, so the condition below now applies).** A single client request must not cause a synchronous chain that returns to the service it entered through, for example client, organization-service, Auth, organization-service. This matters only if Auth calls organization-service on first touch, which is the reference-cache proposal of ADR-0040 (Proposed); if that is not accepted the guardrail is moot. **The shape of the authorization question between organization-service and Auth is not decided here** (study OD-8).

## Not decided here

- Tauri versus browser versus other, for any role.
- Public exposure of administrative surfaces; reachability policy per role.
- Offline support for organization or operator administration; device identity and its owner (a device credential versus a device seat or license); the lease issuer and clock model; and the departure that offline use would make from ADR-0004's fail-closed license validation.
- Whether a gateway or composition layer is created.
- The human-facing hierarchy administration API itself: actors, credentials, host service, and service-token scopes (O-13, O-14, O-15, F23, BD-4), and the shape of the authorization question between organization-service and Auth (study OD-8).
- The authentication factors supported per client, and the origin configuration (CORS, WebAuthn) a chosen client would need; these must be verified when a client is chosen.
- B-026, O-18, B-036, and lifecycle semantics, unchanged.

## Consequences

- **Easier:** one authorization model and one audit trail regardless of client; a client can be replaced or added without changing service ownership; the human-facing hierarchy API in BD-4 has clear design constraints; no client-specific business rule exists in Auth's administration API today (the client-shaped items, CORS and WebAuthn origin configuration and the alert-only owner fingerprint, are configuration or alerting, not business rules).
- **Harder or given up:** no shortcut of putting client-specific rules in the backend; a client that needs offline behavior must wait for an explicit, owner-approved design that fits the constraints in decision 6.
- **Stage 10:** no change to ADR-0039 or ADR-0040 and no new blocker for Stage 10.1. If ADR-0040's interim rule keeping `/auth/me` and onboarding resolution frozen is accepted, it also covers administrative clients. "Internal only initially" for organization-service (a Stage 10.0 proposal about today's service-token API) must not be read as excluding administrative clients later.
- **Follow-up:** the BD-4 ADR (service-token scopes, hierarchy validation, human-facing hierarchy administration) should be written on top of this rule; later ADRs for public exposure, offline and device identity when a client is chosen.
