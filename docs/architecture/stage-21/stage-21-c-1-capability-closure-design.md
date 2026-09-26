# Stage 21.C.1: Core V1 capability closure — architecture and decisions

- **Status:** **PASSED — STAGE 21.C.1 ARCHITECTURE READY TO CLOSE.** The architecture owner approved the design and resolved Q1 to Q6
  on 2026-09-26 (§3). On `docs/core-v1-capability-closure-design`; awaiting review; not committed.
- **Base:** `main` @ `a9cc00b` (Stage 21 merged, PR #138). The Stage 21.C investigation made no file change.
- **Changes:**
  - **Runtime: NONE.** No source, migration, configuration, credential or CI change.
  - **Docs:** this record; [ADR-0052](../../adr/0052-core-v1-capability-closure.md) (**Accepted**);
    [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) **Amendment 3** (Q1); the ADR index rows for
    0042 and 0052.
- **Full Core Validation: NOT RUN.**

## 0. Progress

| Stage | State |
|---|---|
| 21 Shared Services Integration | ✅ **CLOSED**, merged (PR #138): [Stage 21 record](./stage-21-shared-services-integration.md) |
| 21.C Capability completeness investigation | ✅ report delivered (read-only; no files); owner decisions C1 to C3 taken |
| **21.C.1 Architecture** | ✅ **ready to close** (this record; Q1 to Q6 resolved) |
| 21.C.2 Implementation | ⏳ |
| 21.C.3 Focused certification | ⏳ |
| 21.x Production prerequisites (including the Organization cutover) | ⏳ |
| 21.R1 Quality / API audit, then 21.R2 Controlled refactor | ⏳ |
| Focused regression / security | ⏳ |
| 22 Final Core Validation | ⏳ |

**Why Stage 21 is recorded as closed here.** The Stage 21 record's status line still reads "ready to close (awaiting review)". That line
is historical: every stage record is written before review and is not rewritten afterwards. Stage 20.7 still reads the same way, and
Stage 21 recorded Stage 20's closure in Stage 20's **progress table** (in `stage-20-1-decisions-and-roadmap.md`). Stage 21 has no separate
roadmap document, so its closure is recorded in this progress table instead, following that precedent. The Stage 21 record itself is not
edited.

## 1. Approved inputs

| Decision | Value |
|---|---|
| New Core V1 microservice | **NO** |
| Caller-policy primitive | **YES**, as an existing service-kit utility |
| Payment and Billing admission | **YES**, in 21.C.2 |
| Organization authority cutover | **YES**, required for Core V1; operational cutover in 21.x; must complete before Stage 22 |
| Durable Auth domain-event outbox | **YES**, in 21.C.2 |
| Product-integration guide | **YES**, in 21.C.2 |
| Product-owned Core Audit evidence | **NO for V1**; post-V1 |

## 2. Evidence base (read from source at `a9cc00b`)

| Topic | Evidence |
|---|---|
| Caller policies | `apps/organization-service/src/authorization/service-policy.ts` (`SERVICE_POLICY`), `apps/notification-service/src/api/caller-policy.ts`, `apps/file-service/src/policy/caller-policy.ts`, `apps/audit-service/src/policy/caller-policy.ts`, `apps/release-service/src/policy/caller-policy.ts`; kit `service-auth/service-token.ts` and `service-token.guard.ts` |
| Payment routes | `payments.controller.ts` (create: `ServiceTokenGuard`; get: `ServiceOrUserGuard`; cancel: `ServiceTokenGuard`), `attempts.controller.ts` (start and sync: `ServiceOrUserGuard`), `authorization.service.ts` (object rules), `webhooks.controller.ts` (provider-authenticated) |
| Billing routes | `products.controller.ts`, `prices.controller.ts`, `invoices.controller.ts`, `payment-requests.controller.ts`, `subscriptions/entitlement.controller.ts` |
| Actual callers | Billing's `payment-client.ts` calls Payment's create, get and cancel only. No Core service calls Billing. Auth has made no Payment call since `f1901f9`. Compose registers `billing-service` **and `auth-service`** at Payment (`docker-compose.yml:179`) and **no caller** at Billing |
| ADR-0042 | D3 (admission), decision 5 (validation), Amendment 1 A.3 (no Auth validation endpoint; fails closed before the cutover), A.5 (Platform scope), Amendment 2 (memo permitted under I1); the BD-4 implementation study §4.5 and §11 (AD-2: Billing may create, read and cancel; Auth has an **empty** operation list; attempt sync is **denied** for Billing) |
| Organization reference read | `apps/organization-service/src/reference/reference.controller.ts`: `GET /organization/reference/organizations/:id` returns `{organizationId, platformId, companyId}`. A caller outside its Platform scope, or an unknown organization, gets a collapsed `404`; before `ACTIVE` it returns `409 not_authoritative`. It needs `hierarchy.reference.read` |
| Cutover state | `docs/architecture/stage-10/stage-10-1-implementation.md` §4: items 2 (operator step-up), 3 (Auth reference cache `ensure`), 6 (cross-service export/import test) and 7 (Billing and Payment reference clients) are **NOT IMPLEMENTED**; item 5 (G1 to G7) is operational. Confirmed in source: Auth has no outbound client to Organization Service and no `ensure` |
| Auth events | `apps/auth-service/src/events/events-publisher.service.ts`, `events.module.ts`; ten call sites (§8.1); `app-config.ts` (`AUTH_EVENTS`, on unless `off`); `deploy/provision-and-deploy.sh:149` sets `AUTH_EVENTS off` in production |
| Auth outbox | migration `0010_audit_outbox.sql`, identical to the kit table: row immutable except its bookkeeping, `DELETE` not blocked; `audit/central-audit.ts` (`AuditRelayModule`, one kit relay, exchange `nawara.events`, independent of `AUTH_EVENTS`); the runtime role has `DELETE` (`provision-and-deploy.sh:108`) |
| Consumer dedupe | Notification intake: `(sourceService, sourceEventId)` is unique, so a duplicate is acknowledged and nothing is written (`intake.service.ts`) |

## 3. Decisions (Q1 to Q6): RESOLVED 2026-09-26

**Owner resolutions:**
- **Q1:** REMOVE VIA ADR AMENDMENT (ADR-0042 Amendment 3; the development credential is retired in 21.C.2).
- **Q2:** YES, WP-G is added to 21.C.2; the cutover is not performed there.
- **Q3:** YES, through the durable outbox, as sensitive short-lived data (§8.5).
- **Q4:** KEEP, as the event-write gate (§8.8).
- **Q5:** CONFIRMED, no service caller is admitted to Billing in V1.
- **Q6:** CONFIRMED, creates fail closed in production before the cutover, with no bypass.

The recommendations as originally put:

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **Q1** | Should `auth-service`'s admission to Payment be removed (ADR-0042 D3)? | **REMOVE VIA ADR AMENDMENT** (§6) | WP-B's configuration only (the runtime outcome is "deny" either way) |
| **Q2** | Cutover code gaps: add **WP-G** (Auth reference cache + cross-service export/import test) to 21.C.2? | **YES**: the cutover cannot run without it (§5.2) | 21.x cutover; Stage 22 |
| **Q3** | Code-bearing Auth events through the outbox, with the purge rule and one expand-only index? | **YES** (§8.5) | WP-E |
| **Q4** | `AUTH_EVENTS`: keep it as the event-write gate, or retire it? | **KEEP** as the write gate (§8.8) | WP-E |
| **Q5** | Billing admits no caller in V1; the entitlement read resolves Platform scope (a read that fails closed) | **CONFIRM** (§4.3, §7.4) | WP-C |
| **Q6** | Confirm ADR-0042 A.3's derived consequence: Organization-involving creates fail closed in production until the cutover | **CONFIRM** (§7.6) | WP-D |

Operator step-up (Stage 10.1 item 2) is **not** a cutover prerequisite. No current Auth route lets an operator create or change an
Organization, so there is no regression; after the cutover, owners can administer and operators fail closed. It stays post-V1 unless the
owner wants operator hierarchy administration at launch.

## 4. The shared caller-policy primitive (WP-A)

### 4.1 Inventory: the actual common denominator

| Property | Organization | Notification | File | Audit | Release | Payment | Billing |
|---|---|---|---|---|---|---|---|
| Variable | `SERVICE_POLICY` | `NOTIFICATION_SERVICE_POLICY` | `FILE_SERVICE_POLICY` | `AUDIT_SERVICE_POLICY` | `RELEASE_SERVICE_POLICY` | none | none |
| `{"callers":{…}}` envelope | yes | yes (exactly one key) | yes | yes | yes | — | — |
| Required when tokens exist; empty is allowed with no tokens | yes | yes | yes | yes | yes | — | — |
| Policy caller must be registered; registered caller must have an entry | yes | yes | yes | yes | yes | — | — |
| Unknown entry properties rejected | **no** | yes | yes | yes | yes | — | — |
| Duplicate list values rejected | **no** | **no** | yes | yes | yes | — | — |
| Duplicate JSON keys detected | **no** | **no** | **no** | **no** | **no** | — | — |
| Configuration values echoed in errors | **yes** (`JSON.stringify`) | no | no | no | no | — | — |
| Enforcement | guard + `@RequireCapability` | inline | inline | inline | guard | — | — |
| Domain dimensions | capabilities, `allowedPlatforms` | templates, channels, organizations | operations, organizations, mediaTypes, maxBytes | operations, categories, sourceServices | products → capabilities | — | — |

**Common denominator:** the envelope, the two-way registration cross-check, deny by default, and entry and list validation. Everything in
the last row is domain-specific and stays in each service.

### 4.2 Location and surface

- **Location:** `libs/service-kit/src/service-auth/caller-policy.ts`, next to `ServiceTokenGuard`. It is technical infrastructure, so it
  fits the kit rule. **No** service, database, network call or central store.
- **Surface** (names are indicative; fixed in 21.C.2):

```ts
// Generic parsing: the service passes its variable name and an entry parser for ITS dimensions.
parseCallerPolicy<E>(raw: string | undefined, registered: readonly string[], spec: {
  variable: string;                       // e.g. 'PAYMENT_SERVICE_POLICY' (used in error text)
  keys: readonly string[];                // the entry's allowed property names; anything else is refused
  entry(at: PolicyPath, e: Record<string, unknown>): E;  // the service's own dimension checks
}): CallerPolicyMap<E>                    // .of(caller): E | undefined   .callers(): string[]

// Helpers for the entry parser (no vocabulary of their own).
policyList(at, value, { allowed?: readonly string[]; pattern?: RegExp; allowEmpty?: boolean }): ReadonlySet<string>
policyChoice(at, value, choices: readonly string[]): string
registeredCallers(entries: ServiceTokenEntry[]): string[]

// Optional enforcement for "one named operation per route".
@RequireServiceOperation('payment.create')        // route metadata
ServiceOperationGuard                             // after ServiceTokenGuard / ServiceOrUserGuard
SERVICE_OPERATION_POLICY: { allows(caller: string, operation: string): boolean }  // provided by the service
```

- **`ServiceOperationGuard`:**
  - It acts only when the request authenticated **as a service**, via the `serviceCaller` of `ServiceTokenGuard` or the service branch
    of `ServiceOrUserGuard`.
  - A user bearer passes through unchanged to the route's existing object-level rules. This closes the gap noted in BD-4 §11.3: "the
    `ServiceOrUserGuard` service branch must check the operation".
  - A route whose metadata names no operation is refused for service callers (fail closed). A route that must never admit a service
    names a sentinel that no policy can hold.

### 4.3 Configuration schema (Payment and Billing)

```json
{ "callers": { "billing-service": { "operations": ["payment.create", "payment.read", "payment.cancel"],
                                     "allowedPlatforms": ["<platform uuid>"] } } }
```

| Service | Variable | Operation vocabulary (closed, service-owned) | Other dimensions |
|---|---|---|---|
| Payment | `PAYMENT_SERVICE_POLICY` | `payment.create`, `payment.read`, `payment.cancel` | `allowedPlatforms` (required; explicit uuid list, may be empty; no wildcard; AD-3) |
| Billing | `BILLING_SERVICE_POLICY` | `product.create`, `product.read`, `product.archive`, `price.create`, `price.read`, `price.retire`, `invoice.create`, `invoice.read`, `invoice.list`, `invoice.issue`, `invoice.discard`, `payment_request.create`, `payment_request.read`, `payment_request.cancel`, `entitlement.read` | `allowedPlatforms` (as for Payment) |

- **Payment has no attempt operation.** Starting an attempt is payer-only (a user), and AD-2 denies Billing the sync route. The service
  branch of both attempt routes is therefore always refused.
- **Billing catalog operations** (`product.*` and `price.*` writes) are expressible, but granting them to any caller also needs the still
  open B-031 (catalog governance) and B-030 (price authority). The mechanism does not decide those.

### 4.4 Deny by default: exact behaviour (startup unless stated)

| Situation | Result |
|---|---|
| No policy variable, no registered tokens | starts; every service-token route is refused (`401` for lack of a token) |
| No policy variable, registered tokens | **refuses to start**; names the callers missing an entry |
| A registered token caller absent from the policy | **refuses to start** |
| A policy caller with no registered token | **refuses to start** |
| Empty `operations` list | **refused**: a caller with nothing to do must not hold a credential |
| Empty domain list (for example `allowedPlatforms: []`) | allowed only where the service's spec says `allowEmpty` (the Organization precedent); it then means "no Platform" |
| Duplicate caller key, or any duplicate JSON key | **refused**: plain `JSON.parse` keeps the last key silently, so the kit reads the document with a duplicate-key check |
| Duplicate list value | **refused** |
| Unknown top-level key, or unknown entry property | **refused** |
| Wildcards (`*`, `all`, `null` meaning everything) | none exist; a value outside the vocabulary is refused |
| Normalization | **none**. Values match exactly and case-sensitively; uuids must be lowercase and canonical. A non-canonical value is refused, never rewritten |
| At runtime: caller authenticated, no entry | cannot happen (refused at startup); defensively `403` |
| At runtime: operation not held | `403 operation_not_permitted` |

### 4.5 Secret-safe diagnostics

- **An error names only:**
  - the variable;
  - the caller name (a registry identifier, never a secret), and only when it matches the caller-name pattern;
  - the property path;
  - the rule broken.
- **An error never contains:** a token, a digest, an `Authorization` header, a list value, the raw JSON, or the JSON parser's own
  message (which can quote input).
- Denials at request time are logged with the caller, operation, outcome, reason class, correlation id, asserted organization id and
  target id. That is the ADR-0042 decision 9 floor, in logs, following the Organization Service precedent for service-token denials.
- A denial is never an Audit catalog action (§11).

### 4.6 Adoption

- 21.C.2 builds the kit utility, and Payment and Billing adopt it.
- The five existing parsers stay as they are. Migrating them is optional 21.R2 work with no behaviour change, apart from the stricter
  duplicate-key and unknown-property checks, which would be called out.

## 5. Organization authority cutover

### 5.1 Decision C1: required for Core V1

**CORE V1 REQUIRED — YES.**
- The mechanism already exists and is reused unchanged: ADR-0039, ADR-0040 decisions 1 to 7 with Amendments 1 and 2, and the Stage 10.1
  ownership CLI (`declare-class`, `import`, `freeze`, `verify`, `approve`, `activate`, `retire`).
- **No second cutover architecture is designed.**

### 5.2 What remains: code versus operations

| Item (Stage 10.1 §4) | Kind | Needed for the cutover? | Where |
|---|---|---|---|
| 3. Auth reference cache: `ensure(id)`, Auth's outbound client to Organization Service, first-touch calls in the six administrative paths, the cache-write guard beyond the existing database guard | **CODE** (a Class C change to Auth) | **YES**. Without it, a fresh environment cannot finish its Auth bootstrap (F4). After activation, Auth cannot reference a Platform or Organization that is created in Organization Service | **WP-G (Q2)** |
| 6. Cross-service export/import integration test | **CODE** (test) | **YES**, as rehearsal evidence (G6) | **WP-G (Q2)** |
| 7. Billing and Payment reference clients | **CODE** | YES (the callers of the reference read) | **WP-D** |
| 2. Operator step-up | CODE | **NO** (§3) | post-V1 unless decided |
| 5. G1 topology, G2 gated migrations, G3 least privilege (Auth's production runtime is still a superuser), G4 monitoring, G5 backup and restore drill, G6 rehearsal, G7 named approval | **OPERATIONAL** | YES | **21.x** |

### 5.3 Sequence

```text
21.C.1  architecture and contracts final (this record)
   │
21.C.2  code: WP-D (reference clients, fail closed) · WP-G (Auth ensure + export/import test)
21.C.3  certification (includes the cutover code paths in a rehearsal-like test run)
   │
21.x    operational cutover (ADR-0040, unchanged)
   ├── prerequisites  G1 topology · G2 gated migrations · G3 least-privilege roles · G4 monitoring
   ├── reconciliation E1 prepare (snapshot, checksummed export, import, verify), repeatable
   │                  (existing environment) or F1–F5 (fresh environment); the class is chosen at G1
   ├── gates          G5 restore drill · G6 production-like rehearsal · G7 named human approval
   ├── cutover        E2 freeze → E3 final export/import/verify → E4 ACTIVATE AUTHORITY (no caller token)
   │                  → E5 verify → E6 Auth credential, mirror, retire
   ├── rollback       possible only before activation, or in the zero-write window (ADR-0040 A2.6);
   │                  never automatic; after the door, reconciliation only
   └── verification   E7 post-cutover checks; THEN register the Payment and Billing reference credentials
                      and their allowedPlatforms at Organization Service ("then open other callers")
   │
Organization Service authoritative ──▶ Organization-involving Payment/Billing creates succeed ──▶ Stage 22 eligible
```

## 6. ADR-0042 and `auth-service` at Payment (§10 of the brief)

- **Why it was admitted:**
  - When BD-4 was answered (2026-09-19/20), Auth called `GET /payment/licenses/:id/status` on registration and join.
  - ADR-0042's own context says Auth "only needs a read route that Payment does not implement". AD-2 records that call as "the intended
    Auth call", and gives Auth **no** Payment operation because the route did not exist.
- **What changed afterwards:**
  - Commit `f1901f9` removed the license check and Auth's `PaymentClient`.
  - Its reasons: the route never existed (M-05), and Stage 11 decided that Auth owns identity and membership only, never commercial
    entitlement (B-035). Entitlement belongs to Billing (ADR-0038, ADR-0044).
  - No Auth → Payment flow is planned anywhere in the ADRs, SDDs or roadmaps.
- **Classification: C (obsolete).** There is no intended Core V1 operation (so not A), and no known upcoming flow (so not B).
- **Recommendation: REMOVE VIA ADR AMENDMENT.** **Approved (Q1) and applied as ADR-0042 Amendment 3** (the D3 row is withdrawn; the
  historical text is kept). The originally proposed text:
  - Proposed text, to be added to ADR-0042 only after approval as "Amendment 3": *"D3's admission of `auth-service` to Payment Service is
    withdrawn. Its sole purpose, the license-status read of AD-2, was removed by Stage 11 (B-035): Auth owns no commercial entitlement.
    `auth-service` holds no Payment operation and no Payment credential. Any future Auth → Payment need is a new admission under D3."*
  - **Until approved,** WP-B still denies `auth-service` every Payment route, which is exactly AD-2's empty operation list. The
    mechanism has no "admitted with nothing" state (§4.4), so the dev `AUTH_TO_PAYMENT_*` credential leaves Payment's `SERVICE_TOKENS`
    either way.
  - **If the owner prefers KEEP,** the only change is that the kit must allow an empty operation list for that one caller. That is not
    recommended: it is a credential that authorizes nothing.

## 7. Payment and Billing admission, and Organization scope

### 7.1 Payment matrix

| Payment operation (route) | `billing-service` | `auth-service` | other registered service | unknown token | human bearer |
|---|---|---|---|---|---|
| create `POST /payment/payments` | **ALLOW** (`payment.create`); Organization scope checked (§7.3) | **DENY 403** | **DENY 403** | 401 | 401 (service-only route) |
| read `GET /payment/payments/:id` | **ALLOW** (`payment.read`) + existing object rule (its own payments; otherwise collapsed 404) | DENY 403 | DENY 403 | 401 | existing: payer relation, otherwise 404 |
| cancel `POST /payment/payments/:id/cancel` | **ALLOW** (`payment.cancel`) + existing rule (own producer only) | DENY 403 | DENY 403 | 401 | 401 |
| start attempt `POST …/attempts` | **DENY 403** (payer-only; no service operation exists) | DENY 403 | DENY 403 | 401 | existing: payer only |
| sync attempt `POST …/attempts/:id/sync` | **DENY 403** (AD-2 / BD-4 §11.3) | DENY 403 | DENY 403 | 401 | existing: payer or producer relation |
| webhooks `POST /payment/webhooks/:provider` | not a service-token route (provider signature); unchanged | — | — | — | — |

- **Evidence:**
  - AD-2 names create, retrieve and cancel for Billing, and nothing for Auth.
  - Billing's `payment-client.ts` makes exactly those three calls.
  - **Behaviour narrowed:** today a producer service can sync; after WP-B it cannot. No caller uses it (verified), and AD-2 denies it.

### 7.2 Billing matrix (V1 admission: **none**)

| Billing operation (route) | Allowed caller(s) in V1 | Organization source | Entitlement implication |
|---|---|---|---|
| `POST /billing/products` | none | seller (`organization` type: seller id) | none (catalog); B-031 also gates it |
| `GET /billing/products/:id` | none | the stored product | none |
| `POST /billing/products/:id/archive` | none | the stored product | none; B-031 |
| `POST /billing/prices` | none | via its product | none; B-030 and B-031 |
| `GET /billing/prices/:id` | none | via its product | none |
| `POST /billing/prices/:id/retire` | none | via its product | none; B-031 |
| `POST /billing/invoices` | none | body `organizationId` / seller: **asserted, so verified (§7.3)** | leads to a subscription only once paid |
| `GET /billing/invoices/:id`, `GET /billing/invoices` | none (service branch); **user payer unchanged** | the stored invoice | none |
| `POST /billing/invoices/:id/issue`, `/discard` | none | the stored invoice | issuing makes it collectable |
| `POST /billing/invoices/:id/payment-requests` | none (service branch); **user payer unchanged** | from the invoice (not re-asserted) | starts collection (Billing → Payment) |
| `GET /billing/payment-requests/:id` | none (service branch); user payer unchanged | the stored request | none |
| `POST /billing/payment-requests/:id/cancel` | none | the stored request | none |
| `GET /billing/organizations/:organizationId/entitlement` | none | **path parameter: asserted, so Platform scope is resolved (§7.4)** | **the entitlement answer itself**: a cross-tenant read discloses commercial state |

- **Admitting a product later** is a D3 architecture-controlled change. The change is:
  - one policy entry (operations and `allowedPlatforms`);
  - a token pair;
  - one row in ADR-0042's admission list.
  It needs no code.
- **Payment and Billing lists differ on purpose:** Billing's only Core caller would be a product. Payment's only caller is Billing.

### 7.3 Organization scope on creates (ADR-0042 decision 5, A.3, A.5)

- **Who asserts:** a service caller, in the body of a create:
  - Payment: `organizationId`, or `seller` of type `organization`;
  - Billing: invoice `organizationId` or seller, and product seller.
  A user never asserts an Organization on these routes.
- **"First assertion":** the first time a given `organizationId` reaches a given target **process** without a memo entry. The memo is
  process-local (positive results only; bounded LRU; cleared on restart; no migration). After a restart the target asks again, which is
  stricter than "first ever". Replays (the same `paymentRequestId` or `invoiceRequestId`) are resolved **before** verification, so
  returning an existing record never needs Organization Service.
- **Verifier:** Organization Service's reference read, and nothing else. It is synchronous and bounded: the hardened HTTP-client
  conventions apply (timeout, no redirects, capped response body; S21-4).
- **Check, at the target:** the resolved `platformId` must be in the caller's own `allowedPlatforms`. This is the second of A.5's two
  layers; the first is the target credential's scope, evaluated by Organization Service.
  - **Cross-Company:** a Platform belongs to exactly one Company, so Platform scope is strictly finer than Company scope. No separate
    Company check is needed.
- **No Organization in the request** (a seller that is not an organization): Platform resolution does not apply (A.3, D3 item 6);
  admission and operation checks still apply. Producer scope for non-organization sellers stays open (A.6).
- **Memo validity:** I1 (ids are never reused) holds. The memo proves identity and anchors, **not** that the Organization is active
  (BD-5).
- **Where it runs:** the network call is made **outside** any database transaction.

### 7.4 Organization scope on reads

- **Reads of a target's own records** (Payment get and cancel lookups; Billing product, price, invoice and request reads) keep their
  existing object rules and **never call Organization Service** (decision 5: "never on reads"). The record's Organization was verified
  when it was created.
- **The entitlement read is different:** the Organization is a caller-supplied path value, not a record the caller owns. The only
  protection against a cross-tenant read is Platform-scope resolution (AD-3: "requests involving an Organization must resolve …
  cross-Platform access fails closed"). It therefore uses the memo, or the reference read, and **fails closed** (`503`) when neither can
  answer. A caller must treat `503` as "unknown", never as "entitled". This reading is Q5.

### 7.5 Failure behaviour

| Situation | Create | Own-record read | Entitlement read |
|---|---|---|---|
| Memo hit | proceeds (no call) | — | proceeds |
| Resolved; Platform in scope | proceeds | — | proceeds |
| Organization unknown, **or** outside the target credential's scope at Organization Service (collapsed `404`), **or** resolved to a Platform outside the caller's scope | **`403 organization_not_permitted`** (one answer for every case: no existence oracle) | — | same |
| Organization Service `409 not_authoritative` / `5xx` / timeout / unreachable / refused redirect / oversize body | **`503 hierarchy_unavailable`** with `Retry-After`; nothing written | unaffected | `503` |
| Reference credential refused (`401`/`403`) by Organization Service | `503` (a configuration fault; logged `hierarchy_reference_denied`) | unaffected | `503` |

- Billing's collection flow already treats Payment's `503` as retryable (`payment_unavailable`), and its reconciler keeps the request
  pending.

### 7.6 Before and after the cutover (one contract)

| Phase | Production | Non-production |
|---|---|---|
| Before activation | the reference read answers `409` → creates for an Organization **fail closed**; own-record reads work | a **fixture resolver** (static id → platform/company map), **refused when `NODE_ENV=production`** (the Organization `testFixture` precedent), or a real Organization Service activated through the fresh sequence |
| During the transition (freeze → activation) | fail closed (AD-5 "transition": temporarily unavailable) | same |
| After E7 | Payment and Billing reference credentials registered at Organization Service; creates resolve normally | same |

- **No switch disables validation** (AD-5), and no temporary "trust the producer" mode exists.
- The same client, memo and error mapping run before and after. Only Organization Service's own state changes.
- Consequence (Q6): until the 21.x cutover, **production collection for Organization sellers is unavailable**. ADR-0042 A.3 states this
  and asked the owner to confirm it. Decision C1 (cutover before Stage 22) makes it consistent with the roadmap.

### 7.7 Commercial boundary (unchanged)

- Organization Service answers identity and anchors only. It never answers whether a customer may buy, owes or is entitled.
- Payment settles; it never becomes entitlement authority.
- Billing owns subscription and entitlement.
- No `platformId` is added to invoices or payments (ADR-0042 decision 2); the memo is process memory, not a column.

### 7.8 Correlation is never authority

`x-request-id`, `x-correlation-id`, trace headers, `x-forwarded-*` and any identity-looking header are ignored for authorization:
- the caller comes only from the service token;
- the Organization's Platform comes only from Organization Service;
- the policy comes only from startup configuration.

A test sends forged caller, organization and forwarded-identity headers and expects no change in the decision (§13).

## 8. Durable Auth domain events (WP-E)

### 8.1 Inventory (every legacy publish)

| Event | Producer transaction | Consumer(s) | Class and purpose | Consequence of loss |
|---|---|---|---|---|
| `member.contact_verification_requested` | `ContactVerificationService.request`: code insert (tx); publish after commit | Notification (`identity.contact_verification_code`) | notification trigger; **carries a code** | the user re-requests (throttled); an annoyance |
| `admin.operator_code_issued` | `OperatorCodeService` login code (tx); after commit | Notification (`identity.operator_login_code`) | notification trigger; **carries a code** | the operator re-requests |
| `admin.operator_confirmation_code_issued` | `issueConfirmation(q, …)` **inside** the operator-creation transaction, published **before commit** | Notification (`identity.operator_confirmation_code`) | notification trigger; **carries a code** (TTL up to 7 days) | **loss**: the operator cannot confirm without an owner re-issue; **phantom**: a rollback can still send a dead code |
| `admin.owner_recovery_requested` | `RecoveryService.start` (tx); after commit | Notification (`identity.owner_recovery_requested`) | **security alert** | **cannot be reconstructed**: the owner may never learn a recovery has started, which defeats the ADR-0025 cool-down |
| `admin.owner_recovery_completed` | `RecoveryService.complete` (tx); after commit | Notification | **security alert** | the owner is not told the credentials were replaced |
| `admin.owner_login_from_new_device` | `AdminDeviceService.checkAndRecord`: a single upsert, **no transaction**; after it | Notification | **security alert** | a new-device login goes unnoticed |
| `membership.approved` / `membership.rejected` | `MembershipService.decide` (tx); after commit | Notification | notification trigger (member notice) | the member is not told; no state is lost |
| `membership.revoked` | `MembershipService.revoke` (tx); after commit | Notification | notification trigger | the same |
| `user.registered` | `AuthService.register` and `InvitationService.accept` (tx); after commit | **none** | domain event | none today |
| `membership.requested` | register (if pending) and join (tx); after commit | **none** | domain event | none today (no admin notice exists) |
| `membership.admin_provisioned` | `InvitationService.accept` (tx); after commit | **none** | domain event | none today |

- **Separate paths, not in scope:**
  - Audit evidence already goes through the outbox (`audit.*`, Stage 18.7.6).
  - Operational telemetry is logs only (`event_publish_failure` and the like).
  - Nothing in this list is Audit evidence.
- **All twelve names move to the outbox.** The three with no consumer cost nothing extra, and keeping them on a second path is exactly
  the dual-publisher state that must not exist.

### 8.2 The current loss window (proved from source)

```text
db.tx(... mutation ...) COMMIT ──▶ bus.publish(): returns at once, enqueued in process memory (max 1000)
                                        │
             ┌──────────────────────────┼─────────────────────────────┬──────────────────────────────┐
             ▼                          ▼                             ▼                              ▼
     process crash/kill        broker down / confirm timeout    backlog ≥ 1000               SIGTERM + 5 s drain
     → event gone              → logged, NOT retried            → dropped (logged)           → rest dropped (logged)
```

- Plus the **phantom** case above (a publish inside an uncommitted transaction).
- Plus production today: `AUTH_EVENTS=off`, so **nothing** is delivered at all.

### 8.3 Target

```text
Auth transaction ── domain mutation ── (audit intent, existing) ── outbox row for the domain event ── COMMIT
                                                    │
                            existing kit OutboxRelay (one per instance; FOR UPDATE SKIP LOCKED; publisher confirms;
                            backoff ≤ 15 s; unlimited retry; drained at shutdown)
                                                    │
                                     nawara.events (same exchange, same routing key)
                                                    │
                          Notification intake queue ── dedupe on (sourceService, sourceEventId) ── handler
```

- **Relay:** the domain events use the **same** `outbox` table (migration `0010`, already the kit table), the same `OutboxService`, and
  the same relay and bus that carry Auth's audit evidence today.
- **Naming:** `AuditRelayModule` becomes Auth's single outbox relay module. That is a rename; the mechanism does not change.
- **One connection:** the legacy `EventsPublisherService`, its second broker connection and its `events.rabbitmqUrl` configuration are
  **removed**.
- **Transaction boundaries:** every call site enqueues through the transaction's client `q`:
  - `AdminDeviceService` gains a transaction around its upsert and the enqueue;
  - `issueConfirmation` already receives `q`;
  - every other site moves its publish inside the existing `db.tx`.
- **No central outbox, and no new relay type.**

### 8.4 Event identity and delivery semantics

- **Id:** a generated uuid per event row (`OutboxService.enqueue`), used as the envelope id, the `eventId` header and the AMQP
  `messageId`.
  - It is **not deterministic**. Each business transaction runs once.
  - A retried HTTP request is a new transaction with a new code, so it is correctly a new event.
- **Semantics:** transactionally durable producer intent + at-least-once delivery + consumer deduplication.
  - A crash between publish and the "published" stamp re-publishes the same id.
  - Notification acknowledges the duplicate and writes nothing.
  - **Not** exactly-once, and not promised.
- **Ordering:** no global order. One relay publishes roughly in `occurredAt` order; several instances interleave. No current consumer
  relies on order (each event is an independent notice).

### 8.5 Code-bearing payloads (Q3)

- **Today's position:** Auth stores codes only as an HMAC. The code exists in plaintext only in memory, on the broker, and in
  Notification's ciphertext. An outbox row would put it **in plaintext in Auth's database**. The kit's envelope doc says payloads carry
  "never secrets"; these three events are an existing, documented exception (Notification SDD §13, "code-bearing DLQ messages").
- **Recommended rule:** Auth deletes the outbox rows of the **three code-bearing names only** once they are published, **or** once their
  `payload.expiresAt` has passed, whichever comes first.
  - An expired code is worthless, and Notification never sends an expired code.
  - Only these names are touched; `audit.*` and every other row are never deleted.
- **Mechanics:**
  - a kit `PollLoop` worker, with bounded batches and counts-only logs;
  - `DELETE` is permitted by the immutability trigger (it guards `UPDATE` only) and by the runtime role's grants.
- **One expand-only migration (`0011`):** a partial index on `outbox (name, "publishedAt")` for the three names. It stays tiny because
  its rows are deleted, and it keeps the purge off a scan of the whole, ever-growing outbox.
- **Residual risk (accepted in the recommendation):** a backup or a WAL segment taken inside the window can hold a live code until the
  code's TTL.
- **Owner requirements (Q3, approved):**
  - the row is written atomically with the Auth transaction, and nothing reaches the broker before the commit;
  - the existing relay publishes it, and Notification deduplicates on the established event identity;
  - the row is deleted after successful publication, and unpublished rows are deleted once their code has expired;
  - no plaintext code is kept as event history;
  - codes never reach logs, metrics, errors, DLQ diagnostics or tooling output (the relay's `lastError` and `nawara-check-outbox-lag` carry
    ids, names and redacted error classes only; certification scans them);
  - codes are never copied into Audit;
  - the purge is bounded, observable (counts only) and covered by focused tests;
  - no secrets store and no new service;
  - the `0011` index only if implementation proves it is the minimal migration needed.
- **Alternatives:**
  - keep codes fire-and-forget (two publishers, and the loss and phantom cases stay for codes);
  - encrypt the code for Notification (a new cryptographic contract).
  Both are rejected.

### 8.6 Compatibility (target: zero external contract change)

| Aspect | Before | After | Change? |
|---|---|---|---|
| Exchange / routing key | `nawara.events` / the event name | same | no |
| Payload | the documented shapes | byte-for-byte the same objects | no |
| Headers | `eventId`, `occurredAt`, `source: auth-service`, `version: 1`, `correlationId` | same (the relay stamps `source`; the version defaults to 1) | no |
| `messageId` = `eventId` | yes | yes (the row id) | no |
| `occurredAt` | publish time | row time (the transaction's `now()`); earlier by at most the transaction's duration | semantics refined, not changed |
| Payload `timestamp` / `expiresAt` | computed in code | unchanged | no |
| Retry | none | until published (backoff ≤ 15 s) | improvement |
| Latency | immediate | up to one relay poll (1 s default) | small; noted |
| Duplicates | none (and losses) | possible after a crash; absorbed by dedupe | consumers already built for it |

### 8.7 Migrations and persistence

- Table: **none new** (`0010` is reused).
- Index: `0011` only if Q3 is accepted (§8.5).
- No change to the kit's schema.

### 8.8 `AUTH_EVENTS` (Q4)

- **Recommended: keep the variable; change what it gates.**
  - **Before:** it started the legacy publisher and its broker connection.
  - **After:** it decides whether domain-event rows are **written** in the transaction. The relay is unconditional; it already runs for
    audit, and production requires `RABBITMQ_URL`.
- **This guarantees:**
  - **No invisible backlog.** With `off`, no row is written, so nothing waits unrelayed. Any written row is relayed, and a stuck backlog
    shows in the existing outbox-lag check (`nawara-check-outbox-lag`) and in `outbox_publish_failure` logs.
  - **No duplication on a switch.** Identity is the row, created once. Switching `off → on` affects only later transactions.
  - **`on → off`:** rows already committed are still relayed; committed intent is honoured.
  - **No dual emission.** The legacy publisher no longer exists.
- **Startup:** one line, `auth_domain_events enabled=true|false`.
- **Production:** production keeps `off` until 21.x sets `on`, together with Notification's production readiness.
- **Alternative: retire the variable** (always write the rows). It is simpler, but it removes 21.x's control of when production starts
  sending codes and alerts. Not recommended.

## 9. Product-integration guide (WP-F)

One generic, product-neutral document: `docs/architecture/core-product-integration-guide.md`, next to the Release client guide, which it
links rather than repeats.

**Rules for the guide:**
- Every statement cites the owning ADR or SDD, or the service's `GET /docs`.
- No product domain (driving, daycare and the like).
- Client-neutral: Web, Desktop, iOS, Android and backend automation are equal. **Web ≠ Desktop, and Desktop ≠ Tauri**; no framework is
  assumed.

**Proposed outline:**

1. **Architecture overview:** what Core is and is not; database per service; API only; the services, and who owns what.
2. **Human authentication:** Auth login, refresh and step-up; the member, owner and operator kinds; bearer handling on every client type;
   what a client never supplies (role, scope, organization authority).
3. **Service authentication:** opaque service tokens (ADR-0033); one token per caller–callee pair; two-token rotation; storage rules;
   never forward a user bearer as a service credential.
4. **Caller admission:** the per-target caller policy (ADR-0042, ADR-0052); the admission request process (D3); operations; Platform
   scope; the `401`, `403` and `503` meanings.
5. **Organization and tenant semantics:** Company, Platform and Organization; how a product obtains ids; the reference read is for Core
   services; creation is human administration in Organization Service after the cutover; membership stays in Auth.
6. **Billing, subscription and entitlement:** Billing is the only entitlement authority; how to read entitlement (`503` means unknown,
   never entitled); invoices; catalog governance status (B-030, B-031).
7. **Payment boundary:** products never call Payment directly for collection; Billing does; payer attempts; settlement is not entitlement.
8. **Notification:** the generic send API (ADR-0046 D15), channels and caller policy; event intake is Core-internal.
9. **Notification template onboarding:** templates are platform-owned and published by migration (D7); how a product requests a template
   (key, channels, locales, variables); no raw content through the API.
10. **File:** upload, tickets, media types and size policy; organization scoping; attach and delete.
11. **Audit:** products **read** approved surfaces (A39); products do **not** produce Core Audit evidence in V1 (§10); keeping product
    domain history is the product's own job.
12. **Release management:** products, components, releases, compatibility policy (ADR-0051); never delivery.
13. **Web compatibility:** checking whether a web client is still supported; the `required`, `recommended` and `none` answers.
14. **Desktop compatibility:** the same contract for `desktop`; no framework assumption.
15. **iOS and Android compatibility:** `mobile_ios` and `mobile_android`; store-release lag.
16. **Idempotency:** §12.
17. **Correlation ids:** send `x-request-id` / `x-correlation-id`; they are echoed and logged; **they never carry authority**.
18. **Failure handling:** the meaning of `401`, `403`, `404` (collapsed), `409`, `422`, `429` and `503`; fail-closed behaviour per
    service; health versus readiness.
19. **Retry guidance:** retry only `429`, `503` and network errors, with backoff and jitter, and with the **same** idempotency key or
    natural key; never retry `4xx` validation errors.
20. **Locale and time:** §11.
21. **Security rules:** secret storage, token rotation, no tokens in URLs or logs, TLS, least privilege per caller.
22. **What products must NOT do:** query Core databases; import Core code; assert authority or scope; treat correlation as identity; call
    Payment for entitlement; write Core Audit evidence; rely on event ordering; persist Core ids as foreign keys across services.

## 10. Product Audit boundary (C2)

**POST-V1.**

```text
Core services ──▶ may produce approved Core Audit actions (CORE_PRODUCERS, ADR-0049)
Products      ──▶ may consume approved Audit read surfaces (caller policy, A39)
              ──▶ do NOT gain generic Core Audit producer admission in V1
```

- Products **may and should** keep their own domain history and audit trails where their domain requires it.
- A concrete product requirement triggers a dedicated design later.
- No catalog, producer-list or consumer change is made.

## 11. Locale and time standard (guide material; no service)

- Represent language with **BCP 47** tags (`fr-TN`, `ar`).
- Represent time zones with **IANA** identifiers (`Africa/Tunis`).
- Persist and exchange instants in **UTC** (ISO 8601 with `Z`).
- Localize **only** at the presentation or template boundary (Notification renders by locale).
- Machine codes (errors, reasons, statuses) are stable and language-neutral (A54).
- **No per-user locale in Auth in V1.** Auth-originated notices use `NOTIFICATION_DEFAULT_LOCALE`.

## 12. Idempotency standard (guide material)

| Aspect | Core convention (as implemented) |
|---|---|
| Header | `Idempotency-Key`, `[A-Za-z0-9._:-]{8,128}`, where a route requires it: Payment cancel and attempt start; Notification send; File upload; Organization Service writes |
| Natural keys | some creates carry their own key in the body: Payment `paymentRequestId`, Billing `invoiceRequestId`, product `(seller, code)` |
| Replay | the same key with the same request returns the original result (status and body), with no second side effect |
| Conflict | the same key with a different request: `422 idempotency_key_reused` (header routes) or `409 …_conflict` (natural keys) |
| Client duty | generate one key per logical operation; reuse it on every retry of that operation; never reuse it for a different one; keep it until a terminal answer |
| Scope | keys are scoped to the authenticated caller; the retention horizon is per service (documented in each SDD) |

Domain semantics are **not** forced to be identical. The guide states the common contract and links each service's specifics.

## 13. Security matrix (Payment and Billing after WP-A to WP-D)

| Case | Result | Reasoning |
|---|---|---|
| Expected service caller, operation held, Organization in scope | **ALLOW** | every ADR-0042 D3 check passes |
| Unexpected registered service (for example `notification-service` at Payment) | **403** `operation_not_permitted` | registered is not admitted (deny by default) |
| Unknown or invalid token | **401** (generic) | `ServiceTokenGuard` |
| Human bearer on a service-only route | **401** | a user bearer is never a service credential (ADR-0042 decision 1) |
| Human bearer on a `ServiceOrUser` route | existing object rule (payer), unchanged | the operation guard acts on service callers only |
| Forged identity headers (`x-caller`, `x-organization-id`, `x-forwarded-*`) | ignored; decision unchanged | identity comes only from the token (§7.8) |
| Caller asserts another tenant's Organization | **403** `organization_not_permitted` | Platform resolved server-side and outside scope |
| Caller asserts a nonexistent Organization | **403** `organization_not_permitted` (the same answer) | no existence oracle |
| Organization Service unavailable or not authoritative | **503** `hierarchy_unavailable` on creates and the entitlement read; own-record reads unaffected | fail closed (decision 5, AD-5) |
| Reused token (a rotated-out digest still configured) | accepted as that caller, **with that caller's policy only** | two digests per caller share one policy entry (IC-15); revocation is removing the digest (decision 10) |
| Policy missing while tokens are registered | **startup failure** | deny by default |
| Malformed policy (JSON, unknown key, duplicate key, wildcard, empty operations) | **startup failure**, secret-safe message | §4.4, §4.5 |
| `auth-service` token at Payment | **403** on every route (and not registered once Q1 is applied) | AD-2 |

## 14. Failure semantics (summary)

| Failure | Behaviour |
|---|---|
| Caller-policy misconfiguration | the service does not start (it never runs permissively) |
| Organization Service unavailable | creates and the entitlement read `503`; nothing is written; memo hits proceed |
| Broker unavailable | Auth mutations commit with their outbox rows; the relay retries; backlog visible via lag checks and logs |
| Relay failure | rows stay unpublished; retried with backoff; `outbox_publish_failure` is logged with id, attempt and age |
| Consumer (Notification) unavailable | messages wait in its durable queue; Auth is unaffected (producer isolation, Stage 21 proof) |

## 15. Stage 21.C.2 work packages

| WP | Content | Depends on | Migration |
|---|---|---|---|
| **A** | kit caller-policy utility + `ServiceOperationGuard` + tests | — | none |
| **D** | organization reference client + memo + fixture resolver (refused in production) | — | none |
| **B** | Payment: `PAYMENT_SERVICE_POLICY`, the operation guard on every service-token route, Organization scope on create; compose/`.env.example` (drop `auth-service` per Q1; add policy, reference credential, fixture) | A, D | none |
| **C** | Billing: `BILLING_SERVICE_POLICY` (no callers in V1), the operation guard, scope on invoice and product create, and on the entitlement read | A, D | none |
| **E** | Auth: domain events through the outbox; legacy publisher removed; `AUTH_EVENTS` as the write gate; transactions at every site; code-row purge worker | — (independent) | `0011` partial index (if Q3) |
| **G** | *(approved, Q2)* Auth cutover prerequisites: reference cache and `ensure` (Company, Platform, Organization; parents first; validated; fail closed); a hardened client to Organization Service (timeout, no redirects, capped body); the first-touch calls in the six administrative paths; the Auth write guard (beyond the existing `0008` database guard); the cross-service export/import certification test; only the minimal supporting code ADR-0039/0040 prove necessary. **No cutover is performed** | — | none expected. It reuses `0008` and the existing hierarchy tables. Any migration must be proven necessary and expand-only (ADR-0040 G2) |
| **F** | product-integration guide | A to E (G if built), so it documents real behaviour | none |

**Order:**

```text
A ─┐
D ─┼─▶ B ─▶ C
E  (parallel)
G  (parallel; Auth)
            └──▶ F ──▶ 21.C.3
```

- **Placement of the reference client (WP-D):** it goes in the kit, next to the existing `AuthClient` precedent. It is transport,
  memo and error mapping only; the scope decision stays in each service.
- **If placing it in the kit is refused,** each of the two services keeps its own copy (about 80 lines each).

## 16. Migrations and contract changes

| Kind | 21.C.2 |
|---|---|
| Database migrations | Payment none · Billing none · kit none · Organization none · Auth `0011` (expand-only partial index; **only if proven minimal**, Q3) · WP-G: none expected (any migration must be proven necessary and expand-only) |
| API changes | Payment, Billing: new refusals `403 operation_not_permitted`, `403 organization_not_permitted`, `503 hierarchy_unavailable` (OpenAPI updated). No route added or removed. Service callers lose Payment attempt sync |
| Audit catalog | **none**. Denials are operational logs (the ADR-0042 decision 9 floor); successful mutations keep their existing evidence |
| Broker contract | **none** (§8.6) |
| Configuration | new `PAYMENT_SERVICE_POLICY`, `BILLING_SERVICE_POLICY`; per service, an Organization Service URL and reference token, plus a non-production fixture variable; Auth loses the legacy events connection settings (`RABBITMQ_URL` stays), and `AUTH_EVENTS` changes meaning (Q4); dev `AUTH_TO_PAYMENT_*` retired (Q1) |

## 17. Implemented in 21.C.2 versus enabled in 21.x

| 21.C.2 (code) | 21.x (production enablement and configuration) |
|---|---|
| the kit policy mechanism; Payment and Billing enforcement; the reference client and memo; Auth outbox events and purge; WP-G (Auth cutover prerequisites, no cutover); the guide | production credentials, and removing unused ones (`AUTH_TO_PAYMENT`); per-service broker users; `AUTH_EVENTS=on`; the **Organization cutover** (G1 to G7, E0 to E7 or F1 to F7); Payment and Billing reference credentials and `allowedPlatforms` at Organization Service after E7; TLS; ingress, `TRUST_PROXY`, CORS; `RELEASE_RATE_LIMIT_KEY`; monitoring and alerts; backups and capacity |

## 18. Stage 21.C.3 focused certification plan

**Caller-policy primitive:**
- malformed JSON;
- a non-object envelope;
- an extra top-level key;
- a duplicate caller key and a duplicate nested key;
- an unknown property;
- empty operations;
- a duplicate value;
- a wildcard attempt;
- uppercase or non-canonical uuids;
- a policy caller without a token;
- a token caller without a policy;
- no policy with tokens registered;
- no policy with no tokens;
- a runtime denial for an operation not held;
- a user bearer passing through;
- a route without metadata denied for services;
- **every error message scanned** for digest, token and value leakage.

**Payment and Billing:**
- the allowed caller per operation;
- a wrong registered service;
- the `auth-service` token;
- an unknown token;
- a human bearer on service-only routes and on `ServiceOrUser` routes;
- another tenant's Organization, and a nonexistent one (identical answers);
- Organization Service at `409`, `5xx`, timeout, redirect and oversize (a `503`, nothing written);
- a memo hit while Organization Service is down;
- a replay while Organization Service is down (the existing record is returned);
- a cross-Platform entitlement read;
- forged identity headers;
- the fixture resolver refused in production;
- Billing's collection flow with the policy on (`apps/billing-service/test/payment-integration.e2e-spec.ts` and
  `payment-subscription-integration.e2e-spec.ts`);
- a check that no `platformId` column exists (IC-13).

**Auth outbox:**
- normal delivery to a real broker with an unchanged envelope;
- broker down during the mutation (commit succeeds, the row is pending, delivered after recovery);
- a crash after commit and before relay (a killed process, the row relayed by the next instance);
- relay retry and backoff;
- a duplicate re-publish absorbed by Notification's dedupe;
- shutdown drain and restart;
- atomicity: a rolled-back transaction leaves no row, including `issueConfirmation`;
- no dual emission (the legacy module is absent; a static check);
- `AUTH_EVENTS` `off` (no row), `on`, and `on → off` (committed rows still relayed);
- the purge: published and expired code rows deleted, `audit.*` untouched, counts-only logs.

**Integration guide:**
- every route, status, header and variable cross-checked against the OpenAPI documents and the ADRs;
- a repository check for product-domain terms;
- no Tauri or framework assumption;
- no statement giving Payment or Organization commercial authority;
- no product Audit-producer promise.

**Targeted mutations** (each must fail at least one test):
1. policy parse defaults to allow when an entry is missing;
2. the operation check is skipped for `ServiceOrUser` service callers;
3. the wrong caller is accepted (comparison by prefix);
4. Organization verification is bypassed on create;
5. Organization outage fails open (treated as a memo hit);
6. the memo stores negative results;
7. Platform scope check removed at the target;
8. the outbox enqueue is moved outside the transaction;
9. the legacy direct publish is kept alongside the outbox;
10. Notification dedupe is removed;
11. the purge deletes `audit.*` rows;
12. a configuration error echoes a value or digest.

No earlier mutation campaign is repeated.

## 19. Preserved blockers and quality items (not touched)

| Item | Status |
|---|---|
| **F3** (proxy and client-address standard) | Stage 22 blocker → 21.R1/21.R2 |
| **F13** (safe error and logging) | Stage 22 blocker → 21.R1/21.R2 |
| **S21-7** (notification fairness test flake) | stabilize before Stage 22; never disable |
| **S21-1** | designed here; closed by 21.C.2 + 21.C.3 |
| S21-3, S21-4, S21-5 | quality → 21.R1/21.R2 (S21-4's HTTP-client rules are applied by WP-D for its own client) |
| Optional migration of the five existing caller policies to the kit | 21.R2 |
| Outbox retention of published rows in general (no service purges today) | noted; post-V1 / 21.R2, **not** decided here |
| ADR-0037 (outbox and inbox) still **Proposed** | low-severity dependency note; **not blocking** (the mechanism is implemented, certified and built on by Accepted ADR-0046 and ADR-0049; ADR-0052 depends on no unresolved ADR-0037 decision); carried to the 21.R1 architecture review; **not** accepted here |
| **Q-ADR-1**: `docs/adr/README.md` says an ADR becomes Accepted on merge, while repository practice (ADR-0040, 0041, 0050, 0051, 0052) records Accepted at the architecture owner's approval | clarify and document which is the formal Proposed → Accepted transition point; **21.R1**; no ADR process or status change here |

## 20. Roadmap

```text
21.C   Investigation                   ✅
21.C.1 Architecture                    ✅ ready to close (Q1–Q6 resolved)
21.C.2 Implementation                  ⏳ WP A, D → B → C; E; G; F
21.C.3 Certification                   ⏳ §18
21.x   Production prerequisites        ⏳ cutover (G1–G7) · AUTH_EVENTS=on · credentials · infra
21.R1  Quality/API audit               ⏳
21.R2  Controlled refactor             ⏳ F3 · F13 · S21-3/4/5/7 · optional policy migration
       Focused regression/security     ⏳
22     Final Core Validation           ⏳ (only after the cutover is complete and verified)
```
