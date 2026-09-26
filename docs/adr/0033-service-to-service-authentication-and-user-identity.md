# 0033. Service-to-service authentication, and how services identify the end user

- **Status:** Accepted (2026-09-26, by the owner, Stage 19.1 decision D1, after the implementation was verified to conform; see the note at the end)
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Supersedes, for Core services, two earlier choices:** (1) [ADR-0021](./0021-payment-service-platform-scoped-authorization.md)
> chose to *forward the admin's already-verified JWT* to auth-service and explicitly rejected a separate
> service-to-service credential; (2) [ADR-0002](./0002-jwt-access-token-with-rotating-refresh-token.md) and
> [ADR-0026](./0026-authentication-is-not-entitlement.md) assume consuming services verify the JWT locally with the
> shared secret and read `organizationId`/`userId` from it. This ADR replaces both for Core services: services do
> **not** verify user tokens locally, and service-to-service calls use their own token. ADR-0021 and the payment
> ADD/SDD need matching amendments (back-pointers added).
> Only the **caller side** exists today: auth-service sends `PAYMENT_SERVICE_TOKEN` as a raw bearer to payment. The
> **callee side** described below (digest storage, per-caller tokens, constant-time guard) exists nowhere yet. It also
> addresses the auth review's finding F12.

## Context

Auth signs user access tokens with a shared HS256 secret. Giving that secret to every service would let any of them
mint tokens and would make one compromised service compromise identity. The internal network must not be trusted.
Auth's authorization is deliberately **live** (reads the database on each request) so revocation is immediate.

## Options considered

1. **Per caller→callee service tokens; users identified by asking Auth live.** Chosen: simplest reliable start.
2. *Signed short-lived service JWTs with published keys, and local verification of user tokens.* Best long-term, but it
   needs asymmetric signing and a key endpoint in Auth, outside the frozen Auth scope.
3. *mTLS between services.* Strong, but needs an internal certificate authority and rotation without a service mesh.

## Decision

**Service authentication.**
- A token per caller→callee pair: 32+ random bytes, unique per deployment, kept in a secret store or `NAME_FILE`,
  never in source control. Presented as `Authorization: Bearer <token>`.
- The callee stores the SHA-256 **digest** per caller (`SERVICE_TOKENS=<caller>:<digest>,...`, at most two per caller
  to allow rotation), hashes the presented token and compares in constant time. A token is valid for exactly one
  callee. The matching caller name is attached to the request for audit. Failures return one generic 401.
- Every route is **deny by default**: it carries a user guard or a service guard. Internal reachability is never
  authentication.
- The token identifies a service, never a user.

**End users.**
- A service does **not** verify user tokens locally. It forwards the caller's bearer **to Auth only** (`GET /auth/me`,
  `GET /auth/platform-access/:platformId`) and Auth answers from live state.
- The user bearer is never forwarded to any other service.
- The organization for a request comes from the resource, not from a token claim (tokens carry none).

## Consequences

- No secret is shared across services; revocation stays immediate.
- Auth is on the request path of every user-facing call: latency and availability of Auth bound every service.
  Response caching is a later, explicit decision because it delays revocation.
- Token distribution and rotation are manual until a secret manager exists.
- The guard is an interface, so moving to signed service JWTs later changes one module per service.

## Note (2026-09-24, Stage 17.2)

A pointer, not a change to this decision: File Service access tickets ([ADR-0048](./0048-file-service-architecture.md) F16) are a
deliberate case where Auth is not on the path of the call that reaches File Service. The end user is authenticated through Auth (and
authorized by the product) **before** the product requests a ticket; the ticket redemption carries no user token, File Service never
verifies one and never calls Auth.

## Note (2026-09-26, Stage 19.1 — acceptance)

Accepted by the owner under Stage 19.1 decision D1, after a conformance check of the running code against every decision above
([Stage 19.1 record](../architecture/stage-19/stage-19-1-decisions-and-roadmap.md) §14.1). No decision changes. Two statements in the
header block are now historical, not current: the **callee side** exists (service-kit `parseServiceTokens` / `ServiceTokenGuard`:
`SERVICE_TOKENS=<caller>:<sha256>`, at most two per caller, constant-time comparison, one generic 401, the caller name attached), and
auth-service no longer calls payment-service with `PAYMENT_SERVICE_TOKEN` (the dead registration license check was removed, `f1901f9`).
User bearers are verified only by Auth (`/auth/me`, `/auth/platform-access/:platformId`, and `/auth/grants` added by ADR-0042); no
service verifies them locally, and none forwards them anywhere except Auth. A pointer like the Stage 17.2 note: payment provider webhooks
are authenticated by the provider's signature (payment SDD §7), never by reachability, so they satisfy "internal reachability is never
authentication" without a user or service guard.
