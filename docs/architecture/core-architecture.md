# Nawara Core architecture

- **Status:** Proposed. Decisions D1–D4 and E1–E4 were accepted by the project owner on 2026-09-19; the ADRs that record them are
  still *Proposed* until merged. auth-service is described as it is on `main` after the multi-organization change ([ADR-0030](../adr/0030-multi-organization-membership-and-revoked-state.md), merged).
- **Date:** 2026-09-19
- **Financial services:** see [financial-architecture.md](./financial-architecture.md) (billing, payment, accounting; assessment of the old payment design; unresolved decisions).
- **Decisions recorded in:** [ADR-0031](../adr/0031-organization-service-intended-owner-of-the-hierarchy.md),
  [ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md),
  [ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md),
  [ADR-0034](../adr/0034-shared-service-kit-and-api-conventions.md); financial: [ADR-0035](../adr/0035-financial-service-boundaries.md),
  [ADR-0036](../adr/0036-money-parties-and-source-references.md), [ADR-0037](../adr/0037-reliable-events-outbox-inbox.md) (accepts the RabbitMQ choice of [ADR-0018](../adr/0018-rabbitmq-as-async-message-broker.md)),
  [ADR-0038](../adr/0038-entitlement-in-billing-service.md)

Nawara Core is a set of **generic, product-independent** services. Products live outside this repository and consume
Core over the network. Nothing here may contain a concept that belongs to one product's business domain. If a rule
only makes sense for one product, it belongs in that product.

## 1. The model everything shares

**Invariant:** `Company 1 → N Platform`, `Platform 1 → N Organization`. An organization reaches its company only through its platform;
there is no `Company → Organization` link. This is **not** a multi-company SaaS tenancy model and none is introduced.

```
Company
  └── Platform                  a product/app (Core never interprets what a platform is)
        └── Organization        a customer of a platform
              └── Membership ── User      one user, many memberships (Auth owns both)
```

- **Platform already carries "which product"**: Nawara Driver, Nawara School, Nawara Flow (and any future product) are
  each a `Platform` row. Whether a product requires organization context at initial entry, or is platform-wide, is a
  per-product decision — see [ADR-0043](../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md).
- A **User** is one universal identity (Auth). It may belong to many organizations on many platforms.
- Product services keep `userId`, `organizationId` and `platformId` as **opaque references**. They never create a
  second authentication identity. (A product's own domain entity that stores `userId` is correct; a product-specific
  user type inside Auth is not.)
- Generic user kinds stay `member | owner | operator`. They are not product roles.

## 2. Service inventory

| Service | Answers | Owns | Does **not** own | Own database | State today |
|---|---|---|---|---|---|
| **auth-service** | Who is this and how are they authenticated? | user, credentials, sessions, tokens, MFA, recovery, passkeys, **membership and its status/authority**, the Company → Platform → Organization tables **as they are today** ([ADR-0031](../adr/0031-organization-service-intended-owner-of-the-hierarchy.md)), local security audit | long-term: organization/platform/company lifecycle and settings (intended for organization-service); subscriptions; notification delivery | yes | **implemented and deployed** (data model frozen; multi-organization membership per [ADR-0030](../adr/0030-multi-organization-membership-and-revoked-state.md)) |
| **organization-service** | What is this organization and how is it configured? | **intended** owner of Company, Platform and Organization: lifecycle, metadata, settings, policies, and the Company → Platform → Organization relationships | users, credentials, sessions, **membership** | yes | **implemented (Stage 9), NOT authoritative:** service-token API for the three entities exists and is tested; auth-service still owns them and the ownership migration ([ADR-0039](../adr/0039-organization-ownership-and-cross-service-migration-authority.md)) has not occurred. See its [SDD](../sdd/organization-service.md) |
| **notification-service** | How is this delivered? | email/SMS/push/in-app delivery, templates, preferences, attempts, retries, providers | why something was triggered | yes (later) | **implemented and certified (Stage 16, V1: email + SMS)**; not production-enabled (documented external prerequisites) |
| **billing-service** | What is owed, why, how much, when due? | product, price, invoice, invoice line, payment request, credit note, due/overdue, recurring billing (via `price.interval`), **Subscription and its derived Entitlement** (one row per Organization — see [ADR-0044](../adr/0044-subscription-entitlement-final-model.md), not the `organization license`/`user subscription` split this row once named), and (future) invoice presentation: templates, template versions and document metadata ([billing SDD](../sdd/billing-service.md) section 36) | how money moved; the ledger; product concepts | yes | **Stages 1-4 implemented, plus Subscription/Entitlement Stage 12.2-12.7** (foundation, domain schema/invariants, Platform currency foundation, HTTP API, Payment integration: dispatch/cancel/event consumption/reconciliation; Subscription domain, entitlement derivation, Payment→Subscription linking, the effective-access HTTP contract, concurrency hardening, and real-RabbitMQ-broker integration) |
| **payment-service** | How was it paid, by which method, and what is the payment state? | payment, attempt, method, provider transaction, cash workflow, refund, webhooks, idempotency, reconciliation | what is owed; the ledger; entitlements | yes | **implemented through Stage 12.7**: settlement, attempts, the `test` provider, webhooks, resolver/expiry sweeper, transactional outbox, real RabbitMQ publishing (proven end-to-end into billing-service's Subscription, Stage 12.7) |
| **accounting-service** | What accounting effect did this have? | chart of accounts, journal, entries and lines, ledger, fiscal periods, tax, reports | payments and invoices as a source of truth | yes | to build (finance stages) |
| **ai-service** | How do services use AI? | provider abstraction, model config, usage, quotas, cost, safety | product AI workflows | yes (later) | 8-line FastAPI, `/health` only |
| **file-service** | Where is this file and who may read it? | file metadata, ownership, access control, lifecycle, storage port, limits, checksums | business meaning and document relationships (products own them); binaries are never stored in PostgreSQL | yes | designed (Stage 17.1: [ADR-0048](../adr/0048-file-service-architecture.md), [SDD](../sdd/file-service.md)); to build (17.2–17.10) |
| **audit-service** | What happened, who did it, when? | immutable central event history, query, retention | Auth's **local** security audit (stays in Auth) | yes | to build (later, skeleton) |
| **location-service** | Where is this place? | geocoding, reverse geocoding, distance, generic zones, provider port | product routing and assignment | none yet | to build (later, skeleton) |
| **search-service** | How do I find things quickly? | derived index, query, reindex | source of truth (the owner stays authoritative) | none yet (derived) | to build (later, skeleton) |
| **analytics-service** | What is happening across Nawara? | async event ingestion, aggregates, reporting | any synchronous dependency | none yet | to build (later, skeleton) |

**Services deliberately not created:** `user-service`, `role-service`, `permission-service`, `membership-service`, `invoice-service`,
`cash-service`, `tax-service`, `ledger-service`, `wallet-service`, `subscription-service`, `organization-payment-service`, and
any service for a product's own domain entities. User and membership stay in Auth; business roles are a product
concern until there is a concrete cross-product need.

## 3. Ownership map (one owner per entity)

| Entity | Owner | Others hold |
|---|---|---|
| User, credentials, session, refresh token, MFA factor, device | auth | `userId` |
| Membership (user ↔ organization), status, org-admin capability, `audience` label | auth | `membershipId` only if needed; **never a copy of the status** |
| Company, Platform, Organization (hierarchy records) | **auth today** (its tables stay); **organization-service intended**, now built but not authoritative (ADR-0031; migration mechanism ADR-0039, not yet performed) | `companyId`, `platformId`, `organizationId` (opaque) |
| Product, price, invoice, invoice line, credit note, **Subscription (one per Organization) and its derived Entitlement** | billing | `requiresSubscription` may exist as onboarding metadata but is **never** the authority |
| Payment, attempt, cash payment, refund, provider transaction, webhook event | payment | `paymentId` |
| Chart of accounts, journal entry, ledger, tax, fiscal period | accounting | — |
| Notification, template, delivery attempt | notification | — |
| File metadata and access rules | file | `fileId` |
| Central audit event | audit | — |
| Search index | search (derived) | — |
| Analytics event and aggregate | analytics | — |

## 4. Dependencies

```
                       ┌────────── products (outside Core) ──────────┐
                       │ HTTP                                        │ HTTP
                       ▼                                             ▼
   ┌─────────► auth-service ◄──────── organization-service ──────► (events) ──┐
   │  live      ▲   │  ▲   authorize                                            │
   │  checks    │   │  │                                                       ▼
 file-service ──┘   │  └── payment-service (org → platform, membership)   notification-service
                    │                                                     audit-service
                    ▼                                                     search-service
              payment-service                                             analytics-service
```

**Auth calls no financial service.** Registration and join made a synchronous `license status` check against
payment-service until Stage 12.1 (commit `f1901f9`), which removed it outright — the diagram above no longer shows
that edge (it is not repointed to billing-service either; see ADR-0044 and `docs/sdd/billing-service.md` §16.4).

**Synchronous calls (all authenticated, all documented):**

| Caller → callee | Purpose | Failure behaviour |
|---|---|---|
| any service → auth | who is this user, what memberships, what platform access | fail closed (503) |
| payment → auth | organization → platform, and membership check for who may act for an organization (mechanism per ADR-0033; **supersedes ADR-0021's forwarded-JWT choice**) | fail closed |
| ~~auth → payment~~ | **removed, Stage 12.1 (`f1901f9`).** Auth makes no synchronous financial-service call of any kind; the `requiresSubscription` field it stores is a non-authoritative onboarding hint (row below), never read to gate anything. | n/a |
| ~~file → auth~~ | **rejected, Stage 17.1 ([ADR-0048](../adr/0048-file-service-architecture.md) F16).** File Service authorizes service callers (token + policy) and product-issued access tickets only; the product authorizes the user against its own resource before issuing a ticket. File never calls Auth, so Auth availability does not gate file access. | n/a |
| billing, payment → auth | who is the caller, and is their membership active for this organization; seller authority for cash confirmation and invoicing | fail closed |
| platform services → billing | effective-access status (`GET /billing/organizations/:organizationId/entitlement`, implemented Stage 12.5) at the point of use | each consumer documents fail-open or fail-closed |
| billing → payment | create a payment request carrying an **immutable snapshot** (invoice id, amount, currency, payer, seller); payment **never calls billing back** and reports only through events | fail closed for the caller; billing retries |
| product services → billing | "this customer owes X for `sourceType/sourceId`" (service token) | fail closed |

**Events only (never a synchronous dependency):** notification, audit, search, analytics consume events. A producer
never waits for, or fails because of, a consumer.

**Flagged cycle:** `auth ⇄ payment` are two narrow synchronous reads in opposite directions. It is tolerated because
each call is a read with a timeout and a fail-closed default, and ADR-0026 already aims to remove `auth → payment`
at registration. It is recorded as an open risk (O8), not silently accepted as a pattern. **New services must not add
cycles.**

## 5. Data ownership

One **database per service** on a shared PostgreSQL server, one login role per service, no cross-database grants
([ADR-0032](../adr/0032-database-per-service-on-a-shared-server.md)). A service never queries another service's
database and no table is shared or mutated by two services. Cross-service needs go through a service API or an event.
`organizationId`/`userId`/`platformId` in another service's tables are plain identifiers with no foreign key.

## 6. Identity, organization context and authorization

**Identity flow.** The user authenticates only with Auth and receives a short-lived access token. A service that needs to
know who the caller is does **not** verify the token itself (Auth signs with a shared HS256 secret that must not be
distributed). It presents the caller's bearer to Auth and asks (`GET /auth/me`). Auth verifies the signature, the
session and the account **live**, so revocation, blocking and disabled accounts take effect on the next request.

**Organization context flow.** The organization comes from the **resource in the request** (URL or body of a call the
service itself validates), never from a token claim or a client-asserted header. Tokens carry no organization.

**Authorization flow for an organization-scoped request:**
1. The service authenticates the caller (above).
2. It asks Auth what the caller may do *for that organization* : a member's `memberships[]` entry (status must be
   `active`; `isOrganizationAdmin` marks the generic organization-management capability), or, for owner/operator,
   `GET /auth/platform-access/:platformId`.
3. It enforces tenant isolation itself: a resource of another organization/platform/company answers with the same
   **404** as a nonexistent one.
4. **Operation authorization belongs to the service that owns the operation.** Auth supplies identity, active membership, generic
   user kind and security context, and is not the universal business-permission engine: payment-service decides who may perform a
   payment-domain operation, billing-service a billing operation. Business permissions (what an administrator may do *inside a
   product*) are decided by the **product**, not Core. Generic *seller authority* over an organization's own invoices and cash confirmations (organization-management capability, owner, assigned operator) is a **proposed policy** of the financial services, listed as an open decision in [financial-architecture.md](./financial-architecture.md).

Never trusted without server-side verification: `userId`, `organizationId`, `platformId`, `role`, `permissions`.

## 7. Service-to-service authentication

Decision D3 ([ADR-0033](../adr/0033-service-to-service-authentication-and-user-identity.md)):

- One **service token per caller→callee pair** (**new: only the caller side exists today**, see ADR-0033): 32+ random bytes, generated per deployment, never in source control.
  The caller holds the raw token (`<CALLEE>_SERVICE_TOKEN`); the callee stores only its **SHA-256 digest** per caller
  (`SERVICE_TOKENS=<caller>:<digest>[,<caller>:<digest>]`, at most two per caller so a token can be rotated without
  downtime) and compares in constant time. A token is valid for one callee only (audience-bound by construction).
- The token identifies the **calling service**; it never carries a user. On-behalf-of calls forward the user's bearer
  **only to Auth**, never to another service.
- Anything on the internal network is untrusted until it presents a valid token. Every route is deny-by-default:
  either a user guard or a service guard, never neither.
- The **caller side** matches what auth-service already does toward payment (`PAYMENT_SERVICE_TOKEN`, a raw bearer). The
  **callee side** (digest storage, per-caller tokens, constant-time guard) is new and exists nowhere yet.
- Upgrade path (not now): signed short-lived service JWTs with published keys, which needs asymmetric signing in Auth.

## 8. Events

- **Broker:** RabbitMQ, one topic exchange `nawara.events`, routing key = event name, as
  [ADR-0018](../adr/0018-rabbitmq-as-async-message-broker.md) and Auth's publisher already assume (O1: still Proposed).
- **Envelope:** the payload stays the flat, documented shape each service already uses. For **new** publishers, metadata
  (`eventId`, `occurredAt`, `correlationId`, producing service) travels in **message headers**, so payloads stay
  compatible. Since Stage 16.2 Auth publishes the same canonical kit envelope through the kit bus (`eventId`, `occurredAt`,
  `source: auth-service`, `version: 1`, `correlationId`; persistent; confirmed), still fire-and-forget and without an outbox
  ([ADR-0046](../adr/0046-notification-service-architecture.md) D4, [Stage 16.2 record](./stage-16/stage-16-2-auth-event-envelope.md)).
  Before that Auth sent the payload only, and the kit consumer dead-lettered such a message as `malformed_envelope`.
- **Delivery today:** RabbitMQ runs only in the local `docker-compose.yml`, not in production, and events are fire-and-forget, so **no event is reliably delivered yet**.
  A transactional outbox is the recommended fix and is out of scope here (O10).
- **Rules:** a producer never blocks on the broker; a payload never contains a secret or a token; the only exception is
  a one-time code whose delivery *is* the event's purpose (Auth's operator working code and member contact-verification
  code today, an exception Auth's `ports.ts` does not yet reflect); consumers are idempotent by `eventId` where present.

| Producer | Events (existing or planned) | Consumers |
|---|---|---|
| auth | `user.registered`, `membership.requested/approved/rejected/revoked`, `member.contact_verification_requested`, operator/owner alerts | notification (delivery), audit, analytics |
| organization | `organization.created`, `.updated`, `.suspended`, `.activated`, `.deactivated` | audit, search, analytics |
| billing | `invoice.created/due/overdue/paid/voided` (`overdue` is emitted by a billing sweep of `dueAt`) | notification, accounting, audit, analytics |

Subscription does **not** emit its own domain events (corrects this row's original `license.*`/`subscription.*`
entries — ADR-0044): its state changes are internal, applied inside the same transaction as the triggering
`payment.succeeded` consumption. A consumer that needs to know about commercial access reads the effective-access
route (§4's `platform services → billing` row) rather than subscribing to an event.
| payment | `payment.created/succeeded/failed/cancelled/expired`, `cash_payment.submitted/confirmed/rejected`, `refund.requested/succeeded/failed` (the authoritative catalog is in the [payment SDD](../sdd/payment-service.md); it supersedes the earlier `payment.pending`, `payment.refunded`, `refund.created` and `cash_payment.requested`) | billing (invoice paid, entitlement), accounting (journal entry), notification, audit, analytics |
| accounting | `journal_entry.posted` (optional) | audit, analytics |
| file | `file.uploaded`, `file.attached`, `file.deleted`, `file.rejected` (ids only; [file-service SDD](../sdd/file-service.md) §17) | audit, search, analytics |
| every service | security/administrative events worth keeping | audit |

Auth keeps its **own** local security audit and never depends synchronously on audit-service.

## 9. Common foundation (shared conventions)

Delivered by a small `libs/service-kit` ([ADR-0034](../adr/0034-shared-service-kit-and-api-conventions.md)), **implemented as a foundation** (see [service-foundations.md](./service-foundations.md) for what exists and what is deferred, e.g. rate limiting and OpenAPI setup are not in it yet); auth-service is not migrated onto it.

| Area | Convention |
|---|---|
| Config | environment only; validated at startup; missing/weak value stops the process with a clear error that never echoes a secret; `.env.example` per service; production-required values documented |
| Logging | one JSON line per event; request id and correlation id on every line; redaction of anything credential-shaped |
| Ids | `X-Request-Id` (generated if absent) and `X-Correlation-Id` (propagated across services and into event headers) |
| Health | `GET /health` = process alive; `GET /ready` = every dependency check passes, else 503. Root paths, not routed publicly |
| Errors | Nest default `{ statusCode, message, error }` plus `requestId`; validation failures 400; never a stack trace or a database message |
| API | public prefix is the singular domain noun (`/organization`, `/file`, ...), no version segment in v1; additive changes only; a breaking change becomes `/v2/<prefix>`; OpenAPI at `GET /docs` |
| Lists | `?limit=&cursor=` → `{ items, nextCursor }`; allow-listed `sort` and filters |
| Idempotency | `Idempotency-Key` on resource-creating `POST`s |
| Security | `helmet`, request-size limit, baseline rate limit, DTO whitelist with unknown fields rejected, deny-by-default routes |
| Persistence | plain SQL migrations with a `schema_migrations` table (as in Auth), database constraints for invariants |
| Testing | unit, integration against real PostgreSQL, API tests, security tests; concurrency, duplicate requests, idempotency and retries are tested, not assumed |
| Docker | one Dockerfile per service (repository-root context, npm workspaces), non-root, health check; each service runs alone with only its own database |

## 10. Existing services: compatibility (inspect, not rewrite)

| Service | Finding | Concrete change needed |
|---|---|---|
| auth-service | Data model frozen. `GET /auth/platform-access/:platformId` exists today; `GET /auth/me` returns `memberships[]`. It already calls payment with a service token. | **None now.** Auth's hierarchy tables stay unchanged; its client to payment is to be repointed or removed (open decision). |
| notification-service | Notification V1 (Stage 16, certified in 16.10): Auth event intake on `notification.events` and the service-token send API (`Idempotency-Key`, keyed request hash, status, cancel), durable intents and pinned templates, the delivery engine (leases, retries, the ambiguity policy, secret purge), Resend email and Twilio SMS over direct HTTPS, the HMAC destination limiter, key rotation and runbooks. Production enablement waits on documented external / owner prerequisites (provider accounts, Auth E.164). | Consumes Auth events; any Core service may call the send API with a service token and a caller policy. Design: [ADR-0046](../adr/0046-notification-service-architecture.md) (accepted), [ADR-0047](../adr/0047-resend-as-the-email-provider.md), [ADR-0019](../adr/0019-twilio-as-sms-gateway-provider.md) and the [SDD](../sdd/notification-service.md); [Stage 16.10 certification](./stage-16/stage-16-10-focused-certification.md). |
| payment-service | Unmodified starter. Its ADD/SDD assume a single-organization JWT, forwarding the admin JWT (ADR-0021), `Charge` as the transaction and entitlements inside payment; none holds after ADR-0030, ADR-0033, ADR-0035 and ADR-0038. | Rebuilt on [financial-architecture.md](./financial-architecture.md); the old ADD/SDD are marked superseded in their financial parts. No code to migrate. |
| ai-service | 8-line FastAPI app, `/health` only. | Later: `/ready`, request ids, config validation and the service-token guard in Python. Not rewritten now. |

## 11. Decisions and open decisions

| # | Decision | Status |
|---|---|---|
| D1 | organization-service is the **intended** future owner of Company, Platform and Organization; Auth's hierarchy tables stay unchanged; the cross-service mechanism is a **separate decision when organization-service is built** (no anchor, synchronization or adoption flow is designed) | **confirmed as amended 2026-09-19** (ADR-0031) |
| D2 | One database per service on a shared PostgreSQL server | **confirmed** (ADR-0032) |
| D3 | Per-pair service tokens; end users identified by asking Auth live | **confirmed** (ADR-0033) |
| D4 | Phased delivery with a small shared `service-kit` | **confirmed** (ADR-0034) |
| E1 | Entitlement is owned by billing-service | **confirmed and implemented** (ADR-0038's ownership principle; ADR-0044 for the final, built shape — one Subscription per Organization, not a separate organization-license/user-subscription split) |
| E2 | RabbitMQ with a transactional outbox (producers) and inbox (consumers) for the financial services | **confirmed** (ADR-0037) |
| E3 | Order: docs, service-kit, finance foundations, billing, payment, entitlement, accounting; organization-service and the other skeletons later; settlement waits for business/legal input | **confirmed** |
| E4 | One matrix CI workflow (typecheck, lint, tests, Docker build without push) for new services and auth-service; no deploy workflow or server provisioning yet | **confirmed** |

| # | Open decision (nothing pulled in until decided) | Foundation ships |
|---|---|---|
| ~~O1~~ | ~~Accept RabbitMQ~~ **accepted for the financial services with outbox/inbox** (ADR-0037); deployment of RabbitMQ still needs its own approval | event publisher port |
| O2 | Object storage provider for files (S3-compatible service, self-hosted, or a cloud provider) | storage port + filesystem adapter (Stage 17.1: S3-compatible port; a vendor ADR before production enablement, [ADR-0048](../adr/0048-file-service-architecture.md) F6; Stage 17.4: port and adapters built, provider **still open**, compatibility checklist in the [17.4 record](./stage-17/stage-17-4-storage-abstraction.md) §12) |
| O3 | Search engine (PostgreSQL full text, or a dedicated engine) | search port + in-memory adapter |
| O4 | Analytics store | ingestion port only |
| O5 | Geocoding provider | provider port |
| O6 | AI providers | not started |
| O7 | Notification providers | **decided (Stage 16.8):** Twilio for SMS ([ADR-0019](../adr/0019-twilio-as-sms-gateway-provider.md), accepted), Resend for email ([ADR-0047](../adr/0047-resend-as-the-email-provider.md)); architecture [ADR-0046](../adr/0046-notification-service-architecture.md) accepted (Stage 16.9) |
| O8 | Auth ⇄ payment cycle (and its repointing to billing) | documented risk |
| O9 | **Decided, 2026-09-20:** Auth keeps a validated non-authoritative reference cache and organization-service is the validator for service requests ([ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) Amendment 1, [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md) Amendment 1). Original text: How Auth references Company, Platform and Organization once organization-service exists (and who validates organization → platform → company for non-user requests) | **decided** (ADR-0040 Accepted; ADR-0042 Amendment 1); lifecycle semantics (BD-5) remain open |
| O10 | Reliable event delivery (outbox) and asymmetric token signing | out of scope |

## 12. Risks

- **Split hierarchy ownership.** The hierarchy tables live in Auth while organization-service is only the intended owner; the
  reference mechanism is **decided** (O9: a validated non-authoritative reference cache in Auth, [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) Amendment 1; organization-service as the validator of service requests, [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md) Amendment 1); lifecycle semantics stay undecided and must not be improvised, and production readiness is gated by ADR-0040 decision 7.
- **Every service asks Auth live.** Auth becomes a hot dependency for every request; a slow Auth slows everything.
  Mitigation later (caching with a short TTL) needs an explicit revocation decision.
- **No CI runs any suite,** for any service. This is the largest gap before production use.
- **Events are not delivered yet** (no broker, no outbox).
