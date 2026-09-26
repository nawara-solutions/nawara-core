# Stage 19.3: Audit-X (Company owner reads one organization's evidence)

- **Status:** PASSED on `feat/audit-owner-access` (awaiting review; not committed).
- **Base:** `main` @ `d50746a` (Stages 19.1 and 19.2 merged).
- **Architecture:** [ADR-0050](../../adr/0050-platform-administration-and-verified-human-authority.md) decision 6 (Accepted), which
  amends ADR-0049 A6, A36b and A57 for this one read path.
- **Not done:** no admin service, database, migration, delegated-human token, operator access or null-organization access. No other
  service changed, apart from a backward-compatible parameter added to a cross-service test helper.

## 1. Pre-implementation findings

| Topic | Finding (evidence) |
|---|---|
| Organization read | `GET /audit/organizations/:id/records`: service token + `read_organization`; the path's organization only (never null); window ≤ 92 days; limit 1–100 (default 50); keyset cursor; per-caller 600/min, per (caller, org) 120/min; no self-audit |
| Platform read | `GET /audit/platform/records`: `read_platform`; window ≤ 31 days; 30/min per caller; each page `platform_query.executed` (actor service) in the read's transaction; 503 `accountability_unavailable` if it cannot be recorded |
| Cursor | a fingerprint of (caller, scope incl. organization, filters, window); any mismatch is `invalid_cursor` (`query-params.ts`) |
| Auth owner verification | `GET /auth/grants` returns live `{userId, kind, companyId}`. `GET /auth/admin/organizations/:id` (`platform.controller.ts`): the Auth guard (live `isActive`, active session, tier = kind), organization → platform → company from Auth's tables, owner allowed only if `owner.companyId = platform.companyId` (`platform-access.service.ts`), else a collapsed 404. Both are pinned by Auth's own `platform-authz.e2e-spec.ts` and `grants.e2e-spec.ts` |
| After the ADR-0039 cutover | Auth's hierarchy tables become ADR-0040's reference cache (`ensure` is not built yet; authority is not activated anywhere). Anchors are immutable (migration `0008`), so the lookup stays correct, or fails closed with a 404 for an organization Auth has not yet seen. It never maps an organization to the wrong Company |

No stop condition was met. Human verification needs no delegated identity. Company scope is proven by Auth from persisted state,
never from the request. The organization-scope query is reused unchanged, and ADR-0050 decision 6 is exactly this path.

## 2. Implementation

| Change | File |
|---|---|
| `OwnerAuthority` / `HttpOwnerAuthority`: the only outbound call of audit-service. It forwards the owner's own bearer to `/auth/grants` and `/auth/admin/organizations/:id`, validates every answer strictly, and fails closed (503) on timeout, error, malformed JSON or an answer about another organization | `apps/audit-service/src/owner/owner-authority.client.ts` |
| `GET /audit/owner/organizations/:organizationId/records`: refuses a service token (constant-time digest check, never forwarded), refuses a body, sets `Cache-Control: no-store` | `apps/audit-service/src/owner/owner-query.controller.ts` |
| `AuditQueryService.owner`: verify owner → rate limit per verified owner id → validate the organization and the query → Auth confirms the organization → organization scope, owner policy (all categories and sources, built by the server) → read + `platform_query.executed` in one transaction, or 503 | `apps/audit-service/src/query/query.service.ts` |
| `QueryModule.register`: the owner route and its Auth port exist only when `AUTH_SERVICE_URL` is set | `query.module.ts`, `app.module.ts` |
| Config: `AUTH_SERVICE_URL` (optional), `AUDIT_OWNER_QUERY_RATE_PER_OWNER` (30), `AUTH_TIMEOUT_MS` (3000) | `config/audit-config.ts` |
| Bounds: an owner read uses the platform-scope window (31 days), matching the self-audit's `window_days` of 1–31; counters gain the closed scope label `owner`; limiter bucket `audit_query_owner` (purged by the existing janitor) | `query-model.ts`, `query-params.ts`, `query-counters.ts` |
| Catalog: `platform_query.executed` actors are `service` **or user `owner`**, and it gains an optional `changes.organization_id` (uuid). Additive under A50; contract version 1; the catalog doc is regenerated | `libs/audit-contract/src/catalog.ts` |

**One addition beyond the Stage 19.1 §12 wording.** 19.1 listed the changes of `platform_query.executed` as unchanged. The self-audit
must answer *which* organization an owner read, and the record itself stays platform-level (organization none), so the queried
organization is recorded as the bounded identifier `changes.organization_id`. Nothing else was added. The service reader's record is
unchanged: no `organization_id`, even for a platform read narrowed to one organization. Recording it there too is a 19.4 candidate.

**The owner's exact scope:**
- the records of **one** organization per request. Auth must confirm the organization belongs to the owner's Company;
- records with a null organization are never returned, including `account.disabled` / `account.enabled` (Stage 19.2);
- no wildcard: `organizationId`, `platform`, `companyId` and every unknown parameter are refused (400), and so is a malformed id.

**Error semantics:**

| Situation | Response |
|---|---|
| no, malformed or refused bearer | 401 |
| a service token | 401 (never forwarded to Auth) |
| member or operator | 403 `operation_not_allowed` |
| another Company's organization, or an unknown one | 404, indistinguishable |
| Auth down, slow or unexpected | 503 |
| the read cannot be recorded | 503 `accountability_unavailable` |

## 3. Tests

| Suite | Result |
|---|---|
| `apps/audit-service/test/owner-query.e2e-spec.ts` (new; real PostgreSQL as the runtime role; Auth stubbed on its exact contract, recording what Audit sends) | 18 / 18 |
| `test/e2e-audit-producers/owner-audit-x.e2e-spec.ts` (new; **all real**: built Auth and Audit processes, real RabbitMQ, real PostgreSQL) | 1 / 1 |
| audit-service E2E, all | 394 / 394 |
| cross-producer E2E (`@nawara/e2e-audit-producers`), all | 14 / 14 |
| audit-service unit | 224 / 224 |
| audit-contract unit (+3 pinning the widening) / integration | 1019 / 1019 · 10 / 10 |
| audit-service build, lint (audit-service, contract), `check:repo` | pass |

**What the new tests prove:**
- **Authentication:** missing, malformed or revoked bearer → 401; member and operator → 403; a service token → 401, and Auth
  received nothing.
- **Service readers unchanged:** both service routes still work, and the owner bearer cannot use them.
- **Current authority:** a revoked or blocked session is refused on the next read.
- **Company scope:** A → A1 and A2 each return exactly their own records. A → B1 and B → A1 are 404, identical to an unknown
  organization.
- **No wildcard:** no wildcard or extra-scope parameters.
- **Null organization:** null-organization records, including `account.*`, are never returned.
- **Self-audit:**
  - the actor is the owner, organization none, with `organization_id`, `target`, `window_days`, `result_count`, `page` and
    `filtered`;
  - each read is recorded, and no result content is copied;
  - the record is valid under the contract;
  - revoked `INSERT` → 503, nothing returned, nothing written.
- **Spoofing:** identity headers change neither the actor nor the scope, and are never forwarded to Auth. `actorId` is only a
  filter. A request body is refused.
- **Cursor:** refused across organizations, owners, filters and the service route; malformed or tampered cursors are refused.
- **Bounds:** a window is required; 31 days is accepted and 32 refused; UTC only; no impossible dates; `to` must follow `from`;
  limit 1–100; unknown or repeated parameters refused.
- **Rate limit:** keyed by the verified owner. Headers and organizations do not reset it, and another owner is unaffected.
- **Auth failures:** Auth down, hanging (timeout), malformed, or answering about another organization → 503, and nothing recorded.
- **Configuration:** without `AUTH_SERVICE_URL` the route does not exist.
- **Privacy:** no bearer, owner id or result content in the logs.

**The real cross-process test.** A real owner enrolls TOTP and gets a session. Their membership revocation in A1 and their Stage 19.2
member suspension flow through the outbox and RabbitMQ into `audit_record`. The owner then reads A1:
- the real `membership.revoked` is returned, and `account.disabled` is not;
- the read is recorded with the owner as actor and `organization_id` A1.

The same owner gets 404 on B1. A member gets 403. The suspended member's old token gets 401, because Auth refuses it live. A service
token gets 401.

**Mutation campaign (12 mutants), all killed:**
- service token forwarded to Auth;
- no organization check;
- operator accepted;
- rate limit keyed by organization;
- self-audit actor recorded as the service;
- self-audit failure ignored;
- platform-wide scope;
- cursor not bound to the owner;
- Auth's 404 treated as yes;
- an answer about another organization accepted;
- 92-day window;
- `organization_id` not recorded.

All sources were restored and hash-verified.

**Test infrastructure note.** A first full run failed 10 broker tests. Those tests go through the kit `BrokerProxy`, which connects as
`guest:guest`, and the throwaway broker had other credentials. With the standard `guest` broker, the same tests pass (42 + 6).

## 4. Known limitations and prerequisites

- **Null-organization evidence stays unavailable to owners.** Records with a null organization, among them `account.*`, are never
  shown to Company owners. Company attribution in audit records is a future ADR-0049 question.
- **Post-cutover lookups can deny.** After the ADR-0039 cutover, an organization Auth has not yet cached (`ensure` is not built) is
  denied with a 404 until Auth knows it. The lookup fails closed and never grants the wrong Company.
- **Every read calls Auth twice.** Latency and availability of the owner read depend on Auth, bounded by `AUTH_TIMEOUT_MS`.
- **Owner access is opt-in.** `docker-compose.yml` does not set `AUTH_SERVICE_URL` for audit-service, because an empty value would be
  refused as an invalid URL.
- **Production prerequisites unchanged:** P-S1 to P-S6 and P-A1 to P-A8 remain open. P-S5 (monitoring of human evidence reads) now
  has the `owner_*` query counters to route.
