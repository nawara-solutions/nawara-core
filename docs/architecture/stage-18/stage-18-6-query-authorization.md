# Stage 18.6 — Query and authorization

- **Status:** implemented and validated on `feat/audit-query-authorization` (awaiting review; not committed).
- **Scope:** the two audit reads for trusted internal services (organization scope, platform scope), their authorization (service token +
  `AUDIT_SERVICE_POLICY`), strict query parsing, keyset pagination with a bound cursor, rate limits, the self-audit of platform reads
  (`platform_query.executed`, fail closed), one index (`0002`), OpenAPI, tests on real PostgreSQL 16 (and the real broker for the
  ingestion regression), plans at 500 000 rows, a hardened-image probe.
- **Not in scope (and not present):** real producer integration and the Auth outbox (18.7), retention and DLQ privacy (18.8), the
  operational campaign (18.9), certification (18.10), Stage 19 administration, any end-user authentication or call to another service.
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) A35–A40, A55–A57, A66, [SDD §6–§7](../../sdd/audit-service.md),
  [Stage 18.1 §13](./stage-18-1-decisions-and-roadmap.md). Two documented refinements: the platform route's path (§2) and the
  self-audit action's name (§8). No decision reopened; no ambiguity found (§4).

## 1. Baseline

`main` at `9166dd9ff25e6432275e3a11882a2052dd585a94` = the Stage 18.5 merge (PR #119, `01911cc`); working tree clean except the
untracked `docs/reports/`. Reused: the kit service-token guard, the 18.2 caller policy, the kit Postgres rate limiter (File's per-caller /
per-organization pattern), Billing's cursor convention (`{ items, nextCursor }`, limit 1–100 refused not clamped, strict opaque cursor),
File's OpenAPI mounting behind basic auth, the 18.3 repository and indexes, the 18.4 validator and mapper.

## 2. Flow and routes

```text
GET /audit/organizations/{organizationId}/records     read_organization
GET /audit/platform/records                           read_platform

kit ServiceTokenGuard (401) → caller policy: the operation (403 operation_not_allowed; deny by default)
  → rate limit (429 rate_limited; before any audit_record access)
  → strict parse: path scope, from/to, limit, cursor, filters (400 invalid_query | invalid_scope | window_too_large | invalid_cursor)
  → filters vs the caller policy (403 category_not_allowed | source_not_allowed)
  → AuthorizedAuditQuery (scope + policy from the server; request values only narrow)
  → ONE parameterized SELECT … ORDER BY "occurredAt" DESC, id DESC LIMIT n + 1
     platform: the SELECT and the platform_query.executed INSERT in ONE transaction; COMMIT; then the response (503 if not recorded)
```

The SDD sketched the platform read as `GET /audit/records`; it is `GET /audit/platform/records` so the privileged scope is explicit in the
path (a reader cannot mistake it for a scoped route) and sits beside the organization route under the service's `/audit` prefix. No
Core-wide route convention is changed (21.R1/R2). No POST search, no HTTP ingestion, write or delete route exists (tested: 404).

## 3. Authentication and authorization

- **Authentication:** the kit guard only (SHA-256 digests, constant-time); the caller is the token's service, never a request value. No
  user JWT, session, membership lookup or call to Auth / Organization (A36b).
- **Capabilities are explicit, never hierarchical:** `read_organization` does not grant the platform route; `read_platform` does not grant
  the organization route (a platform caller narrows the platform route with `organizationId` instead). Tested both ways.
- **Before data:** a denied, unauthenticated, invalid or policy-violating request never reaches `findPage` (tested with a spy); a
  rate-limited one neither (tested). The limiter itself writes only `kit_rate_limit`.

## 4. Scopes

- **Organization (A38):** `WHERE "organizationId" = $n::uuid` from the PATH (the only scope source: an `organizationId` or `platform`
  query parameter on this route is a 400; a cursor cannot carry a scope). Platform-level (null) records never appear. An organization
  Audit has no records for is an empty page (Audit does not know which organizations exist; no 404 oracle).
- **Platform (A38: "may query null-organization and any organization"; SDD §6: "optional organizationId or platform=true"):** no
  organization predicate by default (every organization + platform-level); `organizationId=<uuid>` narrows to one organization;
  `platform=true` narrows to `organizationId IS NULL`; both together, a list, `*` or anything else is a 400. The two sources agree; the
  interpretation is theirs, not chosen here.

## 5. Caller policy

`AUDIT_SERVICE_POLICY` categories (required) and optional source services are injected into the SQL on every request
(`category = ANY($)`, `"sourceService" = ANY($)`), independently of the request. A request that names a category, an action of a
category, or a source outside its policy is **refused** (`403 category_not_allowed` / `source_not_allowed`: it only reveals the caller's
own policy); a resource / subject / actor filter cannot pull records past the policy (tested: empty page).

## 6. Filters, time, page size

| Parameter | Rule |
|---|---|
| `from`, `to` | **required**; UTC with `Z`, at most milliseconds, a real instant; half-open **`[from, to)` on `occurredAt`** (the business timeline; `recordedAt` is not a V1 filter: it is Audit's storage clock and serves retention); organization window ≤ **92 days**, platform ≤ **31 days** (exactly at the limit passes, +1 ms is `window_too_large`) |
| `limit` | 1–100, default 50; anything else 400 (never clamped) |
| `action` | a cataloged action, exact |
| `category` | security / business / commercial / administrative |
| `actorType` + `actorId` | together; user → UUID, service → service name, system → process code |
| `resourceType` + `resourceId`, `subjectType` + `subjectId` | together; type code + UUID |
| `sourceService` | a catalog producer |
| `outcome` | succeeded / denied |
| `correlationId` | the kit grammar (navigation only) |
| `organizationId`, `platform` | platform route only (§4) |

Every filter is AND-ed; there is no OR, wildcard, regex, LIKE, sort choice, column choice or free text. An unknown, repeated (array),
empty or over-long parameter is a 400; nothing is coerced, trimmed or ignored.

## 7. Pagination and cursor

- Order `"occurredAt" DESC, id DESC` (A36; `id` is the internal tie-breaker only, never exposed). Keyset: `("occurredAt", id) < (pos)`
  at **microsecond** precision (the column's), `LIMIT n + 1`.
- Cursor: base64url of `{ v: 1, t: <occurredAt µs>, i: <id>, q: <fingerprint> }`, strictly decoded (exact keys, types, version, sizes).
  `q` = SHA-256 (first 96 bits) of the canonical `{ caller, scope (+ organization), every filter, from, to }` (not `limit`, which may
  change between pages): a cursor used with another caller, organization, scope, filter or window is **refused** (`invalid_cursor`),
  deterministically. It is not signed and carries no authority (the scope and policy are re-applied from the request's own
  authorization), so a forged position only moves inside the caller's own authorized result (tested).
- Under concurrent inserts (no snapshot is promised): a record newer than the position never appears in the remaining pages; an older one
  inserted beyond the position does; no duplicate, no skip among pre-existing records, never another scope (tested).

## 8. `platform_query.executed` (A57's `audit.platform_query`)

| | |
|---|---|
| Action | `platform_query.executed` (event type `audit.platform_query.executed`): A13's `<resource>.<verb>`; an action never sits in the `audit.` namespace its event type adds (18.4 rule), so 18.1's working name is kept as the resource |
| Producer (`sourceService`) | `audit-service` (added to `CORE_PRODUCERS`; it owns only this action) |
| Actor | `service` = the authenticated caller (a delegated human cannot be verified from a service token; none is invented) |
| Category / organization / resource / subject / outcome | security / none (platform-level) / `platform_query` = the event's own id / none / succeeded |
| Changes (bounded facts, all required) | `target` all \| organization \| platform; `window_days` 1–31; `result_count` 0–100; `page` first \| next; `filtered` boolean — never a filter value, an organization id or a returned record |
| Written | directly, in the read's transaction: `SELECT page` → `validateAuditEvent` (the shared validator) → `toNewAuditRecord` → `insertOnce` → COMMIT → respond. Not over the bus (no recursion, no broker dependency); the runtime role's INSERT suffices (no new privilege) |
| Fail closed | if it cannot be recorded, the transaction rolls back and the response is `503 accountability_unavailable` with no evidence (tested by revoking INSERT) |
| Only successful pages | a denied, invalid or rate-limited platform request records nothing (it returned nothing); organization reads are not recorded (A57) |
| No recursion | one record per successful page, never more (tested); recording is an INSERT, not a query, and is not counted as one |
| Spoofing | ingestion refuses any bus message claiming `audit-service` as source (`producer_not_admitted`): the action can only be written by the service itself |

Catalog: **50 actions** (49 + 1); the generated catalog document is regenerated.

## 9. Rate limits

Per 60 s window (kit Postgres limiter, keys hashed): organization reads per caller (`AUDIT_QUERY_RATE_PER_CALLER`, default 600) AND per
(caller, organization) (`AUDIT_QUERY_RATE_PER_ORGANIZATION`, default 120, ≤ per caller); platform reads per caller
(`AUDIT_PLATFORM_QUERY_RATE_PER_CALLER`, default 30). Checked after authorization (an unauthorized request spends nothing) and before any
record access; every attempt of an authorized caller counts (no free probing, the kit rule). One caller never spends another's budget.
Tested: thresholds, the refused request runs no query, per-organization isolation, recovery when the window ends.

## 10. Response

`{ items: [...], nextCursor }`, each item: `eventId`, `occurredAt`, `recordedAt`, `action`, `category`, `sourceService`, `actor`
`{ type, id, userKind? }`, `organizationId`, `resource`, `subject` | null, `outcome`, `changes` | null, `correlationId`, `causationId`.
Never the internal `id`, the keyset position, `schemaVersion`, SQL / constraint / queue / DLQ / token information. No display names, no
enrichment, no localized text. `Cache-Control: no-store`; JSON; a GET with a body is 400 `unexpected_body`; CORS stays off.

## 11. Indexes and plans

Measured with `EXPLAIN (ANALYZE, BUFFERS)` on the EXACT `findPage` statements, as the runtime role, 500 000 records (~1 year, 1 000
organizations, 5 % platform-level; `npm run test:ops`), PostgreSQL 16.15:

| Query | Before `0002` | After `0002` |
|---|---|---|
| organization, newest page | org_time index, 0.31 ms | 0.43 ms |
| organization + action / security-only policy | bitmap on org_time, 0.53 / 0.79 ms | 0.60 / 0.26 ms |
| organization + actor / resource / subject / correlation | their indexes, 0.08–0.15 ms | 0.05–0.10 ms |
| organization, page after a cursor | org_time index, 0.37 ms | 0.09 ms |
| **platform, every organization, newest page (31 days)** | **parallel seq scan + sort, 41.7 ms** | **time index, 0.19 ms** |
| **platform, every organization + action / + security policy / deep page** | **parallel seq scan, 33.4 / 37.6 / 32.5 ms** | **0.12 / 0.08 / 0.08 ms** |
| platform, platform-level only | bitmap on org_time, 10.5 ms | time index, 0.45 ms |
| platform, one organization | org_time, 0.12 ms | 0.20 ms |

**Decision (the one 18.3 deferred):** add `audit_record_time_idx ("occurredAt" DESC, id DESC)` (migration `0002`). Without it every
all-organizations platform page scans the whole table, linearly in its size (≈ 7 M rows a year at the A67 1 000-organization horizon);
with it a page reads about `limit` entries. Cost: one more index write per insert. No other index was needed.

## 12. Evidence (counts)

| Suite | Result |
|---|---|
| audit-service unit (incl. parser / cursor 60, parameterization 3, ingestion guard) | **224 / 224** (was 158) |
| audit-service E2E, real PostgreSQL 16.15 + real RabbitMQ 3.13.7 (10 files) | **345 / 345** (was 307): query + authorization + cross-tenant + cursor + time + platform + self-audit + response + logs **33**, rate limits **1**, OpenAPI **2**, persistence **+1** (all-organizations plan), ingestion regression **35** (incl. audit-service source refused) + pipeline **3** |
| plans (`test:ops`, 500 000 rows) | 2 / 2 (no sequential scan anywhere; < 1 ms) |
| `@nawara/audit-contract` unit / integration (50 actions) | **873 / 873** (was 858); 10 / 10 |
| service-kit unit (unchanged) | 132 / 132 |
| hardened production image, real PostgreSQL + RabbitMQ + real tokens / policy | ingestion, organization read (no-store), platform read + 1 self-audit row, cross-capability 403, missing / forged token 401, SIGTERM exit 0 in 68 ms, no token / password / organization id / URL in logs; CI smoke passed |
| `check:repo` + tests; lint; typecheck; builds | pass, 17 / 17; 0; 0; clean |

**Cross-tenant:** A, B, C and platform-level records seeded with every dimension; organization A read under every filter aimed at B /
the platform (resource, actor, subject, correlation, action, category + source, the organization resource, all at once, a scope
override, a platform flag, a repeated filter trying an OR) → only A's records, or a 400. **Cursor:** A → B, platform → organization,
organization → platform, action X → Y, action → none, another window, another caller, another platform narrowing → `invalid_cursor`;
13 malformed cursor shapes → `invalid_cursor`, never a 500. **Time:** exact boundaries, 92 d / 31 d ± 1 ms, inverted, empty, offsets,
DST, date-only, `infinity` / `now` / `epoch`, microseconds, far past, future. **Adversarial:** SQL-looking, `%`, `_`, regex, control and
bidi characters, huge values, arrays, prototype keys, unknown enums → 400 with a value-free message; SQL never echoed.

**Mutations (19; each applied once, run against unit and / or real-PostgreSQL e2e, restored, SHA-256 verified; all killed):**

| # | Mutation | Result |
|---|---|---|
| Q1 | organization predicate removed | killed (13) |
| Q2 | organization predicate widened with `OR IS NULL` | killed (5) |
| Q3 | platform permission accepts `read_organization` | killed (2) |
| Q4 | category policy removed from the SQL | killed (2) |
| Q5 | source-service policy removed from the SQL | killed (1) |
| Q6 | 92-day organization window removed | killed (unit 1, e2e 1) |
| Q7 | platform window = 92 days | killed (unit 1, e2e 1) |
| Q8 | page-size maximum removed | killed (unit 1, e2e 1) |
| Q9 | cursor scope binding removed | killed (unit 1, e2e 1) |
| Q10 | cursor filter binding removed | killed (unit 1, e2e 1) |
| Q11 | cursor tie-breaker removed | killed (1: the tied records are skipped) |
| Q12 | a records query before authorization | killed (1) |
| Q13 | rate limiter bypassed | killed (1) |
| Q14 | platform evidence returned although the self-audit failed | killed (1) |
| Q15 | platform self-audit removed | killed (3) |
| Q16 | action filter interpolated into the SQL | killed by the parameterization invariant (unit 1); the e2e suites pass under it — **defended** by the catalog grammar (the value cannot contain a quote), recorded rather than counted as an e2e kill |
| Q17 | internal id exposed | killed (1) |
| Q18 | the self-audit records itself again (recursion) | killed (1) |
| Q19 | ingestion admits `audit-service` as a bus source | killed (1) |

## 13. Security, privacy, observability

- **Threat model additions:** T8 (cross-organization query) → SQL-enforced path scope, AND-only predicates, cursor binding; T9
  (unauthorized platform query) → explicit capability + self-audit + fail closed + a tighter rate limit; T19 (scraping) → window, page
  and per-caller / per-organization limits; T22 (SQL / filter injection) → parameterized SQL (a unit invariant), closed grammars; a new
  one, **self-audit spoofing** → ingestion refuses `audit-service` as a bus source. Residual: a stolen `read_platform` token reads within
  its policy and limits, each page recorded (T9, Stage 19 hardening); per-service broker identity is still P-A1.
- **Logs:** `audit_query scope=… caller=… outcome=… items=… more=… ms=…` (or `code=…`): no organization id, filter value or record
  (tested). **Snapshot:** `audit_query_snapshot` every 60 s and at shutdown: `<scope>_<outcome>` counts, rows, latency; closed labels.

## 14. Scope proof

No file of auth, organization, billing, payment, file or notification changed (no producer integration, no Auth outbox); no retention,
maintenance role or DLQ change; `libs/service-kit` unchanged; the append-only guarantees and privileges unchanged (18.3 suite green);
no Stage 18.9 campaign (the 500 000-row plans are the brief's §84 measurement, not capacity work).

## 15. Findings and deferred items

| # | Item | For |
|---|---|---|
| F1 | Stage 19 needs delegated-human context for platform reads (who, behind the service); a separate trusted delegation contract. | Stage 19 |
| F2 | Real producers emit through `AuditEventWriter`. | 18.7 |
| F3 | DLQ copies of refused messages (18.5 F3); `kit_rate_limit` rows keyed by (caller, organization) have no purge yet (File purges its own). | 18.8 |
| F4 | A platform all-organizations query with a very rare filter walks the time index across its 31-day window (bounded by the window, ≈ 600 k entries a month at the A67 horizon); watch its latency under volume; audit query percentiles and alerts. | 18.9 |
| F5 | `platform_query.executed` shares `audit_record`'s retention class `security` (P-A2). | 18.8 / owner |
| F6 | Per-service broker identity (P-A1); the self-audit spoof guard depends on the `source` header until then. | production prerequisite |
| F7 | Global API conventions (`/api/v1`, route naming) untouched. | Stage 21 |
