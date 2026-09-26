# Stage 21.C.2: Core V1 capability closure — implementation

- **Status:** **PASSED — STAGE 21.C.2 IMPLEMENTATION COMPLETE** (awaiting review; not committed). Stage 21.C is not complete: 21.C.3 remains. On `feat/core-v1-capability-closure`, from `main` @ `0f45a8f` (Stage 21.C.1 merged,
  PR #139).
- **Implements:** [ADR-0052](../../adr/0052-core-v1-capability-closure.md) (Accepted) and [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md)
  Amendment 3, per the [Stage 21.C.1 design record](./stage-21-c-1-capability-closure-design.md), work packages A, D, B, C, E, G and F.
- **Not done here:** the Organization authority cutover (Stage 21.x); any production value; F3, F13, S21-3/4/5/7; migrating the five
  existing caller policies; product-owned Core Audit. **Full Core Validation: NOT RUN.** Stage 21.C.3 (focused certification) remains.

## 0. Result

| WP | Result | Implementation | Focused tests |
|---|---|---|---|
| A caller-policy primitive | PASS | `libs/service-kit/src/service-auth/caller-policy.ts` | `libs/service-kit/test/caller-policy.spec.ts` (29) |
| D Organization reference client | PASS | `libs/service-kit/src/service-auth/organization-reference.ts` | `libs/service-kit/test/organization-reference.spec.ts` (19) |
| B Payment admission | PASS | `apps/payment-service/src/authorization/*`, controllers, `payment.service.ts` | `apps/payment-service/test/caller-admission.e2e-spec.ts` (15), config spec |
| C Billing admission | PASS | `apps/billing-service/src/admission/*`, controllers, repositories | `apps/billing-service/test/caller-admission.e2e-spec.ts` (39), config spec |
| E Auth durable events | PASS | `apps/auth-service/src/events/*`, eight call sites, migration `0011` | `domain-events-outbox.e2e-spec.ts` (11), `events-real-broker.e2e-spec.ts` (7), `test/e2e-real-broker/stage21c2-auth-outbox-durability.e2e-spec.ts` (4) |
| G Auth cutover prerequisites | PASS | `apps/auth-service/src/hierarchy/hierarchy-reference.ts`, three admin flows, bootstrap, config, repository rule | `hierarchy-reference.e2e-spec.ts` (11), `test/e2e-auth-organization/stage21c2-ownership-export-import.e2e-spec.ts` (5) |
| F integration guide | PASS | [core-product-integration-guide.md](../core-product-integration-guide.md) | cross-checked against the routes and OpenAPI |

## 1. WP-A: the caller-policy primitive (kit)

- **API:**
  - `parseCallerPolicy(raw, registered, { variable, keys, entry })` returns a `CallerPolicyMap`;
  - helpers `policyList`, `policyChoice`, `registeredCallers`, `operationsPolicy`, `parseJsonStrict`;
  - `ServiceOperationGuard`, with `@RequireServiceOperation(op)` and `@RefuseServiceCallers()`, driven by a service-provided
    `SERVICE_OPERATION_POLICY`.
- **Deny by default:**
  - no document while tokens are registered, a token caller without an entry, or an entry without a token: refused at startup;
  - malformed JSON, a non-`{"callers":…}` envelope, an unknown or duplicate key at any depth (a duplicate-aware JSON reader), an empty
    operation list, a duplicate value, a value outside the vocabulary: refused;
  - no normalization;
  - at run time: a service caller without the route's operation, or a route with none, gets `403 operation_not_permitted`; a user
    bearer passes to the route's object rules.
- **Secret safety:** errors name the variable, a well-formed caller name, the path and the rule. They never contain a token, a digest,
  a list value, the raw document, the JSON parser's message, or an unknown property's name (a mistyped key can be a pasted secret;
  found by test and fixed).
- **Adoption:** Payment and Billing only. The five existing parsers are unchanged (optional 21.R2).

## 2. WP-D: the Organization reference client (kit)

- **Client** (`HttpOrganizationReferenceClient`): the approved route `GET /organization/reference/organizations/:id`, with the calling
  service's own credential.
  - Hardened: a deadline (default 2 s), `redirect: 'manual'` (a 3xx is refused), a 4 KiB capped body read under the deadline, unread
    bodies released, a strict shape check (three canonical uuids, the requested id echoed).
  - `404` gives `null`. Anything else is `503 hierarchy_unavailable`, with a reason class in the log and never the token, URL or body.
- **Memo** (`MemoizedOrganizationReference`): positive answers only, process-local, bounded LRU (10 000), empty after a restart, no
  expiry. That is ADR-0042 Amendment 2: permitted while I1 holds and anchors never change.
  - It can hold only the authority's own answers, and those exist only once Organization Service is active. So it can never carry a
    pre-cutover or client-supplied hierarchy.
- **Fixture:** `ORGANIZATION_REFERENCE_FIXTURE` is refused when `NODE_ENV=production`, both at configuration and in the constructor.
- **Configuration:** `loadOrganizationReferenceConfig`.
  - Production requires URL and token.
  - The fixture can never be combined with them.
  - Absent outside production, every lookup fails closed.
  - Billing requires the URL and token in production only once a caller is admitted: with no caller, nothing could ever be looked up.

## 3. WP-B: Payment

| Operation (route) | `billing-service` | `auth-service` | other registered service | unknown / malformed token | human bearer |
|---|---|---|---|---|---|
| create `POST /payment/payments` | ALLOW (`payment.create`) + Organization scope | not registered: **401** | **403** `operation_not_permitted` | **401** | **401** |
| read `GET /payment/payments/:id` | ALLOW (`payment.read`) + own payments | 401 | 403 | 401 | payer rule (unchanged) |
| cancel `POST /payment/payments/:id/cancel` | ALLOW (`payment.cancel`) + own producer | 401 | 403 | 401 | 401 |
| start attempt `POST …/attempts` | **403** (no service operation) | 401 | 403 | 401 | payer (unchanged) |
| sync attempt `POST …/attempts/:id/sync` | **403** (AD-2) | 401 | 403 | 401 | payer or producer relation (unchanged) |
| webhooks | not a service route (unchanged) | | | | |

- **Organization scope:** an Organization named on a create (the seller of type `organization`, or `organizationId`) is resolved
  before any transaction and must be in the caller's `allowedPlatforms`.
  - Unknown, or another tenant's Organization: one answer, `403 organization_not_permitted`.
  - The authority unable to answer: `503 hierarchy_unavailable`.
  - Either way nothing is written (no payment, no outbox event, no audit intent: proved by row counts).
  - A replay is answered from the stored payment without a lookup. A request naming no Organization is not resolved (A.3).
- **Credential:** `auth-service`'s development credential is retired from Compose and `.env.example` (Amendment 3); the dev Billing
  pair is unchanged.

## 4. WP-C: Billing

- **Every service surface names its operation** (15 routes):
  - `product.create/read/archive`, `price.create/read/retire`;
  - `invoice.create/read/list/issue/discard`;
  - `payment_request.create/read/cancel`;
  - `entitlement.read`.
  Human routes (the payer's invoices and payment requests) are unchanged.
- **Admitted Core V1 service callers: NONE.** Compose sets `BILLING_SERVICE_POLICY: '{"callers":{}}'` and registers no token. The
  suite proves every one of the 15 routes refuses a service credential, while the payer's route still works.
- **Organization scope:**
  - Product and invoice creates verify an asserted Organization (replays skip it).
  - The entitlement read resolves its path Organization: `403` for another tenant or an unknown one, `503` when the authority cannot
    answer (never "entitled").
  - Reads of a caller's own records never call Organization Service (proved).

## 5. WP-E: Auth durable domain events

- **Events moved:** all twelve names, from eight services. Each is now written in the SAME transaction as its change:

| Event | Transaction | Consumer | Code? |
|---|---|---|---|
| `member.contact_verification_requested` | contact-code issue | Notification | **yes** |
| `admin.operator_code_issued` | login-code issue | Notification | **yes** |
| `admin.operator_confirmation_code_issued` | operator creation (was queued **before** its commit) | Notification | **yes** |
| `admin.owner_recovery_requested` / `_completed` | recovery start / complete | Notification | no |
| `admin.owner_login_from_new_device` | the device upsert (now in a transaction) | Notification | no |
| `membership.approved` / `_rejected` / `_revoked` | the decision | Notification | no |
| `user.registered`, `membership.requested`, `membership.admin_provisioned` | registration / join / invitation accept | none today | no |

  **Not moved:** audit evidence (already on the outbox) and operational logs; no other publishing existed.
- **Legacy publisher:** `EventsPublisherService`, its module, constants, spec and second broker connection are **removed**. There is no
  other path to the broker, so no dual emission.
- **Semantics:** transactionally durable producer intent + at-least-once delivery + consumer de-duplication. The event id is the outbox
  row id (`eventId` = `messageId`).
  - A rolled-back transaction leaves no row (proved, including the confirmation code).
  - A broker outage leaves the row pending and it is delivered later (proved with `failNextPublishes` and with a stalled or severed
    real broker).
  - Crash after commit: the process was SIGKILLed with the broker unreachable, restarted on the same database, and the row reached
    Notification exactly once (live processes).
  - A duplicate publication is absorbed (`notification_duplicate`).
- **`AUTH_EVENTS`:** it decides only whether rows are written. The relay is unconditional, so committed rows are relayed when it is
  off (proved). Startup logs `auth_domain_events enabled=…`. Production stays `off` (21.x).
- **Contract:** same exchange, routing keys, payload fields and headers. **One observable difference:** payloads are stored as `jsonb`,
  so the JSON **key order** of a published payload is PostgreSQL's, not the insertion order. The field sets, names and values are
  identical, and JSON consumers do not depend on key order (Notification validates fields by name).
- **Delivery:** there is up to one relay poll of latency (about 1 s).

### 5.1 The sensitive one-time-code lifecycle

```text
events containing a plaintext one-time code:  member.contact_verification_requested, admin.operator_code_issued,
                                              admin.operator_confirmation_code_issued
storage:              the outbox row only (the code's own table keeps an HMAC), written in the issuing transaction
successful-delivery:  deleted by CodeEventPurge once "publishedAt" is set (next pass, <= 5 s)
expiry cleanup:       an unpublished row is deleted once payload.expiresAt has passed (delivery is no longer useful)
batch bound:          200 rows per statement, at most 10 statements per pass, every 5 s; FOR UPDATE SKIP LOCKED (never waits on the relay)
observability:        auth_code_event_purge deleted=N published=N expired=N (counts only); failures as auth_code_event_purge_failure
logs:                 never (proved by scanning every log line of every suite for the codes)
metrics:              none exist in Core; the counts above only
Audit:                never (proved: audit.* outbox rows and auth_audit_event hold no code)
DLQ diagnostics:      nawara-dlq list prints a secret-named field (code, token, secret, …) as "redacted" even when asked by name (kit change)
migration/index:      0011, one partial index (proved necessary below)
```

**No plaintext code becomes long-term history:** it lives until publication or expiry, whichever is first. The accepted residual (Q3):
a backup or WAL segment taken inside that window.

**Migration `0011` is necessary** (measured before creating it, 200 000 published audit rows plus 20 live code rows):

| Plan | Result |
|---|---|
| without the index | Seq Scan over the whole outbox, 200 020 rows filtered, 19.1 ms, growing without bound (audit rows are never deleted) |
| with the index | Index Scan on `outbox_code_event_purge_idx`, 0.045 ms; the index is 16 kB (only live code rows) |

`outbox_unpublished_idx` cannot serve the purge, because it must also find published rows. The e2e suite asserts the plan uses the
index.

## 6. WP-G: Auth Organization-authority cutover prerequisites

- **Hierarchy source** (`AUTH_HIERARCHY_SOURCE`): `local` (default; today's behaviour, unchanged) or `organization-service` (after the
  21.x switch). This is the ADR-0040 decision 3 switch by configuration.
- **Credential:** `ORGANIZATION_SERVICE_URL` and `ORGANIZATION_SERVICE_TOKEN`, Auth's own full-read credential.
- **Reference cache and `ensure`** (`HierarchyReference`):
  - A cached row answers locally, with no call. Otherwise the entity is fetched, parents first, outside any transaction, and placed in
    one transaction through the `0008` reference-write gate.
  - The Organization's other columns are not copied; names are snapshots (A1.2).
  - Unknown: `false`, so the caller answers its usual `404`.
  - An unavailable authority, a parent it does not show, or a frozen hierarchy gives `503 hierarchy_unavailable`.
  - An anchor that disagrees fails closed and alerts `hierarchy_anchor_mismatch`, and nothing is overwritten.
- **Hardened client** (`OrganizationDirectoryClient`): deadline, no redirect, a 16 KiB cap, body release, shape check, no credential
  in any output. S21-4 for the older clients stays 21.R1/R2.
- **First-touch paths:**
  - The "six administrative paths" are not enumerated in any document. Source shows six Auth insert sites that reference hierarchy
    ids.
  - **Accepted ADR-0040 decision 2 names four first-touch flows**, and those four are implemented:
    1. join-code creation;
    2. admin-invitation creation;
    3. platform-assignment grant;
    4. the owner bootstrap.
  - The other two sites need no call, and decision 2 forbids one:
    - operator creation references the owner's already-cached Company;
    - membership creation through join or consume references the code's or invitation's already-cached Organization, and decision 2
      forbids join and consume from calling Organization Service.
  - The suite proves that register, login, `/auth/me`, refresh and join make **zero** calls, even with Organization Service down.
- **Write guard** (beyond the `0008` database guard):
  - the bootstrap never inserts a Company when the source is Organization Service, even before activation (A1.2);
  - a repository rule (`check:repo`) allows only the reference-cache protocol to open the reference-write gate;
  - a startup line reports source versus marker, with `hierarchy_source_mismatch` when they disagree (never repaired, never fatal).
- **Cross-service export/import certification** (both built CLIs, two databases, one live Organization Service; **nothing activated**):
  - **E1:** Auth export, then Organization Service import; both compute the same content digest; the import is repeatable.
  - A tampered snapshot is refused and changes nothing.
  - **E2/E3:** under Auth's freeze the final export moves Organization Service to FROZEN, and Auth refuses hierarchy writes.
  - Rollback before activation: Organization Service returns to PREPARED and Auth is unfrozen (`local`); no `activate` or `retire`
    event exists.
  - **F1/F2/F4:** the provisioning identity creates the first Company; Auth's bootstrap places it by `ensure` through the real
    `hierarchy.read` route (allowed only in a fresh environment before activation) and creates no Company of its own.
- **What remains for 21.x** (operational only):
  - gates G1 to G7: topology, gated migrations, least privilege (Auth's production runtime is still a superuser), monitoring, restore
    drill, rehearsal, named approval;
  - E0 to E7 (or F1 to F7);
  - setting `AUTH_HIERARCHY_SOURCE=organization-service` with Auth's credential and `allowedPlatforms`;
  - registering the Payment (and, if ever admitted, Billing) reference credentials after E7.

**Organization authority cutover: NOT PERFORMED.**

## 7. WP-F: the integration guide

[core-product-integration-guide.md](../core-product-integration-guide.md) has the 26 required sections and is product-neutral. It:
- treats Web as first-class, and Web, Desktop, iOS, Android and backend automation as independent shapes, with no desktop framework
  assumed;
- states that product-owned Core Audit producers are post-V1, not impossible;
- keeps authentication, authorization, entitlement and payment apart, and never tells a product to chain Auth, Billing and Payment per
  request;
- describes the Organization model as intended, with the cutover as a 21.x step before Stage 22;
- covers BCP 47, IANA time zones, UTC, and stable machine codes;
- covers idempotency per actual route.

## 8. Migrations

| Service | # | Class | Purpose | Rollback / compatibility | Test |
|---|---|---|---|---|---|
| auth-service | `0011_code_event_purge_index` | **expand only** (one partial index; no table, column or data change) | a bounded, index-served code-row purge | `down/0011` drops the index; the purge still works without it (a scan); existing rows unaffected | EXPLAIN assertion in e2e; the full Auth e2e suite migrates through it |

There is no other migration. None in Payment, Billing, the kit, Organization or Notification.

## 9. Configuration

| Variable | Service | Status |
|---|---|---|
| `PAYMENT_SERVICE_POLICY` | Payment | **new**; required when tokens are registered |
| `BILLING_SERVICE_POLICY` | Billing | **new**; V1 value `{"callers":{}}` |
| `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_REFERENCE_TOKEN`, `ORGANIZATION_REFERENCE_TIMEOUT_MS` | Payment (required in production), Billing (in production once a caller is admitted) | **new** |
| `ORGANIZATION_REFERENCE_FIXTURE` | Payment, Billing | **new**, non-production only (refused in production) |
| `AUTH_HIERARCHY_SOURCE`, `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_SERVICE_TOKEN`, `ORGANIZATION_SERVICE_TIMEOUT_MS` | Auth | **new**; default `local` |
| `AUTH_EVENTS` | Auth | **changed meaning**: writes domain-event rows or not |
| Auth's legacy events connection (the `events.rabbitmqUrl` / `confirmTimeoutMs` config) | Auth | **removed**; `RABBITMQ_URL` and `RABBITMQ_CONFIRM_TIMEOUT_MS` now serve the one relay |
| `AUTH_TO_PAYMENT_TOKEN` / `_DIGEST` | root `.env.example`, Compose | **removed** (Amendment 3) |

**No real production value or secret was committed.** Production configuration is 21.x.

## 10. API and contract changes

- **HTTP:**
  - Payment and Billing: new refusals `403 operation_not_permitted` (service callers), `403 organization_not_permitted`, and
    `503 hierarchy_unavailable`, all in OpenAPI.
  - Service callers can no longer start or sync a Payment attempt.
  - Auth: `503 hierarchy_unavailable` on the three first-touch routes when the source is Organization Service (inert under `local`).
- **Broker:** no change to exchange, routing keys, fields or headers; JSON key order may differ (`jsonb`); delivery is at least once
  with the row id as the event id.
- **Audit catalog: NONE.** Denials are logs (`service_operation_denied`, `organization_scope_denied`); no code reaches Audit.
- **Kit (internal):** the DLQ tool redacts secret-named fields.

## 11. Security and failure matrix (tested)

| Case | Result |
|---|---|
| wrong registered service | `403 operation_not_permitted` (Payment, Billing), nothing written |
| unknown or malformed token | `401`, nothing written |
| human bearer on a service-only route / service-or-user route | `401` / the payer's rule, unchanged |
| forged `x-caller`, `x-service`, `x-user-id`, `x-organization-id`, `x-forwarded-*`, correlation ids | ignored; decision unchanged |
| another tenant's Organization / a nonexistent one | `403 organization_not_permitted`, same message, nothing written |
| Organization Service 409 (pre-cutover), 5xx, timeout, redirect, oversized, malformed | `503 hierarchy_unavailable`, nothing written |
| memo hit while the authority is down | proceeds; a new Organization fails closed |
| missing / malformed / duplicate-key / wildcard policy | startup refused, secret-safe |
| broker outage (in-process and real broker, stalled and severed) | the Auth request succeeds; the row is pending, then delivered once |
| process killed after commit | delivered after restart, once |
| duplicate event | absorbed by Notification |
| `AUTH_EVENTS=off` | no domain-event row; committed rows still relayed |
| step-up / correlation confusion | covered by the existing Stage 21 shared-platform suite (unchanged) |

## 12. Test results (local, throwaway PostgreSQL 16 and RabbitMQ 3.13, the CI images)

| Suite | Result |
|---|---|
| service-kit unit | 181 passed |
| service-kit DLQ integration (real broker) | 14 passed, 1 skipped (pre-existing) |
| Payment unit / e2e | 101 / 143 passed |
| Billing unit / e2e | 327 / 302 passed |
| Auth unit / e2e | 108 / 393 passed (full run) |
| Notification unit | 311 passed |
| `test/e2e-auth-organization` | 9 passed |
| `test/e2e-real-broker` (root script, builds first) | 7 files, 17 passed |
| `test/e2e-audit-producers` (root script, builds first; includes the Stage 21 shared-platform suite) | 10 files, 26 passed |
| repository checks / their tests | passed / 18 of 18 |
| clean build (fresh copy, `npm ci` from the lockfile, no prior `dist`) | all 10 workspaces build; typecheck clean; lint: no new findings |
| targeted mutations | 25 run; 24 killed as written; the 25th was equivalent as written (a memoized `null` was never served) and is killed in its behaviour-changing form |

**Known timing sensitivity:** in one full parallel Auth e2e run, the two proxy-based durability cases of `events-real-broker.e2e-spec.ts`
timed out. They passed in the next full run and in two isolated runs, and their windows were widened (assertions unchanged). Recorded
for 21.C.3.

**Cross-process suites adapted (test-only):** the eight suites that spawn Payment or Billing now pass a test-only caller policy and a
stand-in reference read (`test/*/support/admission.ts`), because deny-by-default refuses to start a service whose registered token has no
policy entry. That is the intended behaviour, not a regression.

## 13. Carried items (unchanged)

- **Stage 22 blockers:** F3 and F13; S21-7 (notification fairness flake: it failed again on PR #139's CI).
- **21.R1/R2:**
  - S21-3, S21-4, S21-5;
  - Q-ADR-1 and the ADR-0037 status review;
  - the optional migration of the five caller policies;
  - **new: S21C2-1**, `release-service` `compatibility.e2e-spec.ts` asserts that the stored limiter key does not match `/ffff/`, but the
    key is a random hex digest that can contain `ffff` by chance (it failed on PR #139's CI; roughly 0.1% per run);
  - outbox retention in general.
- **Post-V1:** product-owned Core Audit producers; operator step-up (Stage 10.1 item 2).
