# Nawara Core: product integration guide

- **Audience:** engineers building a product on Nawara Core (any product; the guide names none).
- **Status:** Core V1, written in Stage 21.C.2 from the implemented contracts ([ADR-0052](../adr/0052-core-v1-capability-closure.md)).
- **Precedence:** every service publishes its exact contract as OpenAPI at `GET /<service>/docs` (for example `/payment/docs`,
  `/billing/docs`; protected by basic auth where the deployment configures a documentation password). This guide explains how the pieces fit and what a
  product may rely on. Where the two differ, the service's OpenAPI document and the cited ADR win; please report the difference.
- **What this guide is not:** an SDK or a client library. Products integrate over HTTP and events only.

## 1. Nawara Core architecture

Nawara Core is a set of independent services that any product reuses as-is:

| Service | Owns | A product uses it for |
|---|---|---|
| auth-service | users, credentials, sessions, MFA, step-up, recovery, memberships | signing people in; who is calling |
| organization-service | Company, Platform, Organization (the hierarchy) | tenancy ids and anchors (§5, §6) |
| billing-service | products, prices, invoices, subscriptions, **entitlement** | "has commercial access been acquired?" (§7 to §9) |
| payment-service | payments, attempts, settlement | nothing directly: Billing collects through it (§10) |
| notification-service | sending e-mail and SMS from platform-owned templates | messages to people (§11, §12) |
| file-service | files, uploads, access tickets | storing and serving files (§13) |
| audit-service | security and business evidence written by Core services | reading approved evidence (§14, §15) |
| release-service | releases and client compatibility | "must this client update?" (§16 to §19) |

**Rules that shape every integration:**
- **Database per service.** No product, and no Core service, reads another service's database.
- **The API is the only contract.** A product calls Core over HTTP exactly as an external client would. It never imports Core code.
- **Side effects travel as events** inside Core (RabbitMQ). Products do not subscribe to Core's internal events in V1.

```text
Human client (Web, Desktop, iOS, Android)        Product backend (and backend automation)
        │  user bearer (auth-service)                     │  service token (per callee)
        ▼                                                  ▼
  auth-service ◄──── product backend ────► Core services (each authorizes its own callers)
```

## 2. Human authentication

- **Flows:** people sign in through auth-service (`POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`).
  Owners have a second factor and a step-up proof for sensitive operations; operators sign in with a one-time code.
- **Result:** a short-lived access token (a bearer) and a refresh token.
- **Rules for every client type:**
  - send the bearer only to Nawara services, over TLS;
  - keep refresh tokens in the platform's secure storage (the browser's HTTP-only storage strategy, the OS keychain, the mobile secure
    enclave), never in logs or URLs;
  - a client never asserts its own role, organization, scope, permission or step-up. Every service derives them from Auth's live answer.
- **Who is a user:** `GET /auth/me` returns the identity and its memberships. Auth answers from live state, so a revoked session or
  membership takes effect on the next request.

## 3. Service authentication

- **Credential:** an opaque service token ([ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md)). The
  caller keeps the raw token; the callee stores only its SHA-256 digest in `SERVICE_TOKENS`.
- **One token per caller–callee pair.** A token authenticates a *service*; it never carries a user.
- **Rotation:** two digests may be active per caller at once, so a token can be rotated without downtime.
- **Never** forward a user's bearer as a service credential, or a service token as a user's. Core refuses both (`401`).
- **Storage:** tokens are secrets. Keep them in the deployment's secret store; never in source control, URLs, logs or client apps. A
  Web, Desktop or mobile client never holds a service token.

## 4. Service caller admission

Authentication says *which* service is calling. Each Core service then decides *what it may do*
([ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md), ADR-0052):

- **Deny by default.** A caller is admitted only by an explicit entry in the target's caller policy (`<SERVICE>_SERVICE_POLICY`), which
  names its operations and, where relevant, its Platforms. A registered token without an entry does not even start the service.
- **Admission is a decision.** A product backend is admitted to a Core service through the ADR-0042 D3 architecture-controlled process
  (a policy entry, a token pair, a row in the admission list). Nothing is admitted implicitly.
- **Core V1 admission state:** Notification, File, Audit (reads) and Release have per-caller policies ready for product callers.
  **Billing admits no service caller in V1**; a product's admission to Billing is a future explicit decision.
- **Answers:**

| Status | Meaning | Retry? |
|---|---|---|
| `401` | the token is unknown, malformed or missing | no; fix the credential |
| `403 operation_not_permitted` | authenticated, but not admitted for this operation | no; request admission |
| `403 organization_not_permitted` | the Organization is unknown or outside the caller's Platforms (one answer, on purpose) | no |
| `503 hierarchy_unavailable` | the Organization could not be verified; nothing was changed | yes, later (§21) |

## 5. Organization and tenant semantics

- **The hierarchy:** a **Company** has **Platforms**; a Platform has **Organizations**. Anchors never change: an Organization never moves
  to another Platform, nor a Platform to another Company. Ids are never reused.
- **Tenant:** most product data is scoped to an Organization. Store the Organization's id as an opaque reference; never as a foreign key
  into Core, never with a copy of its anchors that you then trust.
- **Who owns what:** organization-service owns the hierarchy; auth-service owns users and memberships (who belongs to which
  Organization). A product never decides membership or authority on its own; it asks Auth (`GET /auth/me`).
- **Platform scope:** a product's service credential is scoped to the Platform(s) it serves. Core resolves an Organization's Platform
  itself; a product never supplies it.

## 6. The Organization authority cutover

- **The intended model** (ADR-0039, ADR-0040): organization-service is the single authority for Company, Platform and Organization, and
  hosts their human administration. Auth keeps a validated, non-authoritative reference cache for its own relationships.
- **Today:** the code is in place, but **authority has not been moved**. The cutover is a gated operational step of Stage 21.x (the
  ADR-0040 gates G1 to G7) and completes before Core V1 is declared final.
- **What it means for a product until then:**
  - Core services that must verify an Organization (Payment and Billing creates, Billing's entitlement read) answer `503
    hierarchy_unavailable` in production, by design: there is no bypass.
  - Administration of Platforms and Organizations happens through organization-service's administration API once it is authoritative.
- **Do not** build on Auth's hierarchy tables as if they were the final authority.

## 7. Billing

- Billing owns the commercial catalog (products, prices), invoices and their collection
  ([ADR-0035](../adr/0035-financial-service-boundaries.md)).
- Prices and totals are computed by Billing; a caller never sends an amount, a tax or a total.
- Collection goes through Payment (§10); Billing records the outcome.
- **V1:** no product service is admitted to Billing's service routes (§4). Human payers use their own routes (their invoices, their
  payment requests) with their Auth bearer.

## 8. Subscription

- A paid recurring invoice becomes a **Subscription** in Billing
  ([ADR-0044](../adr/0044-subscription-entitlement-final-model.md)). Its lifecycle (active, grace, expired, terminated) is Billing's.
- A product never stores or computes subscription state of its own; it reads entitlement (§9).

## 9. Entitlement

```text
Authentication = who are you?                    (auth-service)
Authorization  = may you do this?                (the service that owns the operation)
Entitlement    = has commercial access been acquired?   (billing-service)
Payment        = how and whether money was settled       (payment-service)
```

- **Read:** `GET /billing/organizations/{organizationId}/entitlement` answers `{ valid, expiresAt }` (a service route: an admitted
  caller, within its Platforms).
- **`503` means unknown, never "entitled".** Keep your last known answer until `expiresAt` if your product's policy allows it, or
  fail closed; never grant access because Billing could not answer.
- **Do not** call Auth, then Billing, then Payment on every request. Read entitlement where access is granted (a session start, a
  periodic refresh), cache the answer until its `expiresAt`, and re-read on expiry.
- **Payment is not entitlement.** A settled payment does not grant access; Billing's entitlement does.

## 10. Payment boundary

- payment-service settles money ([ADR-0035](../adr/0035-financial-service-boundaries.md)). **In Core V1 its only service caller is
  `billing-service`** (ADR-0042 Amendment 3). A product never creates, reads or cancels a payment with a service token.
- A human payer starts a payment **attempt** on a payment Billing created, with their own bearer; the provider flow and webhooks are
  Payment's.

## 11. Notification

- **Send:** `POST /notification/notifications` (a service route) with a template key, a channel, a recipient and the template's
  variables ([ADR-0046](../adr/0046-notification-service-architecture.md) D15). `Idempotency-Key` is required.
- **Policy:** each caller is admitted for explicit templates and channels (`NOTIFICATION_SERVICE_POLICY`).
- **No raw content:** a caller never sends a subject or a body; the template renders it, in the recipient's locale (§23).
- **Channels:** e-mail and SMS in V1. Delivery is asynchronous; the call records the intent and returns.
- Auth's own messages (codes, security alerts, membership notices) are Core-internal events; a product does not produce or consume them.

## 12. Notification template onboarding

- Templates are **platform-owned and published by migration** in notification-service (ADR-0046 D7). There is no template-upload API.
- **To add one:** request it through the Core change process with:
  - a template key (stable, lowercase, dotted);
  - the channels;
  - the locales and each locale's text;
  - the variable names and their types;
  - which variables are secrets (sealed at rest, never logged).
- Once published, the product's caller policy is extended with the template key.

## 13. File

- **Upload and read:** `POST /file/files` (or an upload ticket, `POST /file/uploads/tickets`), `GET /file/files/{id}`, content at
  `GET /file/files/{id}/content`, attach, delete ([ADR-0048](../adr/0048-file-service-architecture.md)).
- **Access tickets:** a product backend issues a short-lived ticket (`POST /file/files/{id}/tickets`) so a client downloads a file without
  holding a service token (`GET /file/t/{token}`).
- **Policy:** each caller is admitted for operations, media types, a size ceiling and whether it may name Organizations.
- `Idempotency-Key` is required on uploads.

## 14. Audit: read and use boundary

- audit-service keeps security and business evidence produced by **Core services**
  ([ADR-0049](../adr/0049-audit-trail-architecture.md)): append-only, cataloged actions.
- **Products may read** approved evidence through admitted read surfaces: `GET /audit/organizations/{organizationId}/records` and
  `GET /audit/platform/records`, per `AUDIT_SERVICE_POLICY`.
- Owners read their company's evidence through `audit/owner` routes with their own bearer.

## 15. Product-owned Audit: the V1 limitation

- **In Core V1 a product service does not write Core Audit evidence.** The producer list is closed to Core services (ADR-0049;
  ADR-0052 C2).
- **This is not a prohibition on product audit.** A product may, and where its domain requires it should, keep its own domain history
  and evidence in its own storage.
- Generic product producers for Core Audit are a **post-V1** capability. A concrete product requirement triggers that design.

## 16. Release Management

- release-service records a product's releases per component (`backend`, `web`, `desktop`, `mobile_ios`, `mobile_android`) and a
  compatibility policy (the minimum supported version) ([ADR-0051](../adr/0051-release-management-and-client-compatibility.md)).
- **Register and publish** are automation (CI) operations with a service token and a per-product policy. Withdrawing a release and
  changing a minimum version are the owner's, with step-up.
- **Never delivery:** release-service does not build, sign, store, host or deploy anything.

## 17. Web compatibility

- **Web is a first-class client.** A web client asks
  `GET /release/products/{product}/components/web/compatibility?version={its build}` and gets `update: required | available | none`.
- The call is public, rate-limited and cacheable (ETag). Details: the
  [release compatibility client guide](./release-compatibility-client-guide.md).

## 18. Desktop compatibility

- A desktop client asks the same question for the `desktop` component.
- **Desktop is its own shape**, not a variant of Web. **Core assumes no desktop framework.** A particular desktop technology is a
  product's implementation choice; the contract is the same whatever it is.

## 19. iOS and Android compatibility

- Mobile clients ask for `mobile_ios` and `mobile_android` separately: store review and roll-out differ per platform.
- Raise a minimum version only when the new build is actually available in the store for that platform.

## 20. Idempotency

Core retries safely, but only when the caller identifies the operation:

| Aspect | Core convention |
|---|---|
| Header | `Idempotency-Key`, 8 to 128 characters of `A-Z a-z 0-9 . _ : -`, where a route requires it (Notification send, File upload, Payment cancel and attempt start, Organization Service writes). The OpenAPI document of each route says so |
| Natural keys | some creates carry their own key in the body (Billing `invoiceRequestId`, Payment `paymentRequestId`, a product's `(seller, code)`) |
| Replay | the same key with the same request returns the original result, with no second side effect (often `200` with `Idempotent-Replayed: true`) |
| Conflict | the same key with a different request: `422 idempotency_key_reused` (header keys) or `409 …_conflict` (natural keys) |
| Caller duty | one key per logical operation; reuse it on every retry of that operation; never reuse it for a different operation; keep it until a terminal answer |

Domains differ in details (the retention of a key, which fields make a request "the same"). Each service's SDD documents its own.

## 21. Correlation

- Send `x-request-id` (or `x-correlation-id`) with every call: 8 to 128 characters of letters, digits, `.`, `_`, `:`, `-` (anything else
  is replaced by a Core-generated id). Core echoes it,
  logs it, and carries it into the events and audit evidence the request causes.
- **Correlation is never authority.** No request id, correlation id, trace header or forwarded-identity header ever changes who is
  calling, which Organization is concerned, or what is allowed.

## 22. Retries

- **Retry only:** `429`, `503`, and network errors or timeouts.
- **How:** exponential backoff with jitter, a bounded number of attempts, the **same** idempotency key or natural key.
- **Never retry** `400`, `401`, `403`, `404`, `409` or `422`: the answer will not change.
- Honour a `Retry-After` header when a service sends one.

## 23. Dependency failures

| Situation | What Core does | What the product should do |
|---|---|---|
| auth-service down | routes that need a user's live identity answer `503` (fail closed) | show "try again"; never trust a cached identity for authorization |
| organization-service unavailable or not yet authoritative | Organization-verifying operations answer `503 hierarchy_unavailable`; nothing is written | retry later; do not work around it |
| billing-service down | entitlement reads fail | treat as unknown (§9) |
| notification-service down | the intent is not recorded | retry the send with the same `Idempotency-Key` |
| release-service unreachable | a client cannot learn about updates | keep the last `required` answer; do not block users because of this outage (see the release guide) |
| the event broker down | Core producers keep committing; events wait in each producer's outbox and are delivered later, at least once | nothing |

`/health` says a process is alive; `/ready` says it can serve. Route traffic on `/ready`.

## 24. Locale and time

- **Language:** BCP 47 tags (`fr-TN`, `ar`, `en`) where a language is represented.
- **Time zones:** IANA identifiers (`Africa/Tunis`).
- **Instants:** stored and exchanged in UTC (ISO 8601, with `Z`).
- **Localize at presentation:** a client renders localized text and local time; Notification renders its templates per locale.
- **Machine codes are stable and language-neutral:** error codes, reasons and statuses never change with the language. Never parse a
  human `message`.
- Auth keeps no per-user locale in V1; Auth-originated messages use the platform's default locale.

## 25. Security rules

- TLS on every hop; certificates validated.
- Secrets (service tokens, refresh tokens, provider keys) in a secret store; rotated; never in source, URLs, logs, analytics or client
  bundles.
- One service token per caller–callee pair, with the least operations and Platforms it needs.
- Validate every Core answer's shape; treat anything unexpected as a failure, never as success.
- One-time codes and credentials are never logged, stored in plaintext, or copied into analytics.
- Do not follow redirects on service-to-service calls; bound response sizes and timeouts.

## 26. Forbidden integration patterns

A product must never:
1. read or write a Core database, or import Core code;
2. assert its own authority, role, scope, Platform or step-up to Core;
3. treat a correlation, trace or forwarded header as identity;
4. treat a payment as entitlement, or Billing being unavailable as "entitled";
5. call Payment directly, or Billing's service routes, without an explicit admission decision (none exists in V1);
6. write Core Audit evidence (V1), or expect Core to keep its product-domain history;
7. rely on event ordering, or on exactly-once delivery;
8. keep Core ids as foreign keys into Core, or trust a local copy of the hierarchy;
9. assume a desktop or mobile framework in anything shared with Core;
10. hold a service token in a Web, Desktop or mobile client.
