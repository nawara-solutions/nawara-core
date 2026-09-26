# Stage 20.5: client compatibility decision API

- **Status:** PASSED on `feat/release-client-compatibility` (awaiting review; not committed).
- **Base:** `main` @ `b478c9b` (Stage 20.4 merged, PR #134; [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) Accepted, **unchanged**).
- **Scope:** the public, read-only compatibility decision of ADR-0051 decisions 7, 10 and 11, with a bounded cache, a strong ETag, the
  public rate limit, a single-snapshot read, bounded observability and client guidance
  ([client integration guide](../release-compatibility-client-guide.md)).
- **Not built:** 20.6 hardening and 20.7 certification.

## 1. Endpoint

```http
GET /release/products/{product}/components/{component}/compatibility?version=2.5.0
```

- **Why `GET`:** the operation is read-only and idempotent, and HTTP caching (`Cache-Control`, `ETag`, `If-None-Match`, 304) is defined
  for it. The earlier `POST` routes are mutations.
- **Why these paths:** they follow the service's existing `/release/products/{product}/components/{component}/…` layout. The version is a
  query parameter, the only one accepted.
- **Authentication:** none, and no identity input. Clients may be pre-login (ADR-0051 decision 10). A bearer, cookie, user header or
  organization header is ignored and changes nothing (tested).
- **No service call:** it calls no Auth, Billing, Payment, Organization or Audit service. No product request path depends on it.

## 2. Decision algorithm (ADR-0051 decision 7; `src/compatibility/decision.ts`, pure and deterministic)

```text
rate limit (every request, before anything else)            → 429 rate_limited
query: only `version`; canonical SemVer (20.2 rules)          → 400 validation_error / invalid_version
product / component keys well-formed                          → else 404 unknown_component (no query)
ONE statement (one snapshot): component, exact release, current policy, latest
component missing, or kind = backend                          → 404 unknown_component
exact release not registered                                  → 404 unknown_release
release withdrawn                                             → required / withdrawn        (priority)
current policy exists and version < minimum (SemVer)          → required / below_minimum
latest exists and latest > version (SemVer)                   → available
otherwise                                                     → none
```

- **The current policy** is the highest `policyVersion`, never an older one (tested).
- **Latest** is the 20.2 definition, unchanged: the highest *published*, not withdrawn release without a pre-release tag, ordered by
  `(major, minor, patch)`. It uses `release_latest_idx`. Registered-only, withdrawn and pre-release releases are never latest.
- **Comparisons** use the 20.2 `semver` precedence (`compareVersions`), never string order (tested with `1.9.0` / `1.10.0`).
- **Pre-releases.** ADR-0051 defines them fully, so nothing needed broadening:
  - a registered pre-release gets its own decision by SemVer precedence (`2.0.0-rc.1` < `2.0.0`);
  - it is never latest, and never a minimum.
- **Registered-only (unpublished) builds** are known releases, so they get a decision, as ADR-0051 decision 7 makes every shipped build
  registered. The answer exposes nothing unpublished except the caller's own release (decision 10).
- **Backend components** are not clients (ADR-0051: "backends are registered for traceability only"), so they get `unknown_component`.
  This is the closed input-error set: no new code, no new state.
- **AI components:** none exist, and no model, prompt or corpus semantics are added.

## 3. Response contract

```json
{ "update": "required", "reason": "withdrawn", "latestVersion": "3.0.0", "minimumVersion": "2.0.0" }
{ "update": "available", "latestVersion": "3.0.0", "minimumVersion": "2.0.0" }
{ "update": "none", "latestVersion": "3.0.0", "minimumVersion": null }
```

- **`update`** is exactly `required | available | none`.
- **`reason`** (`withdrawn | below_minimum`) is present **only** with `required`.
- **No `supported` field.** ADR-0051 decision 7: "Supported ⟺ update ≠ required. It is derived, never sent as a second field." Omitting
  it makes the impossible pairs the brief lists unrepresentable. The unit property test enumerates 300+ committable states and checks that
  no impossible combination, stray `reason` or `supported` appears.
- **`latestVersion` / `minimumVersion`** are the published facts ADR-0051 names (null when absent). `latestVersion` is **never a
  downgrade target**. A withdrawn build above the latest answers `required` / `withdrawn` with a lower `latestVersion`, and installed
  clients update only upward (tested).
- **No `targetVersion`, URL, notes, store link, environment, organization, entitlement or flag.**

## 4. Errors (never a decision)

| Code | HTTP | When |
|---|---|---|
| `invalid_version` | 400 | missing, repeated, malformed or non-canonical version (a `v` prefix, build metadata, leading zeros, over 128 characters) |
| `validation_error` | 400 | a query parameter other than `version` (for example a user or device id) |
| `unknown_component` | 404 | no such product or component, a malformed key, or a backend |
| `unknown_release` | 404 | a well-formed version that is not a registered release of the component |
| `rate_limited` | 429 | over the per-client budget in the current 60 s window |
| (kit) | 500 | a database failure: opaque, logged by class only |

- **Headers on an error:** `Cache-Control: no-store`, and no `ETag`.
- **Bounded bodies:** no id, SQL, stack, policy history, owner or configuration (tested).
- **`unknown_component` / `unknown_release`** are disclosed deliberately (ADR-0051 decision 7). Clients treat them as "cannot verify this
  build".

## 5. Cache and ETag

**`Cache-Control`.** A decision (200 and 304) carries `public, max-age=60` (`RELEASE_COMPATIBILITY_MAX_AGE_S`, 0–300).
- There is **no `stale-while-revalidate` / `stale-if-error`**: either would let a `none` outlive a withdrawal or a minimum raise beyond the
  bound.
- A new `required` therefore reaches every client, and every shared cache, within `max-age` (ADR-0051 decision 10). This is the freshness
  trade-off: at most 60 s of staleness, in exchange for cheap revalidation.

**`ETag`.** It is strong: `"<27 base64url chars of sha256>"` over exactly the state the answer depends on:
- the component;
- the client's release and its **status**;
- the **current policy version**;
- the **latest release id**.

It is the same on every instance and never depends on identity, time, the request or the process. Express's automatic body ETag is
disabled, so it is the only validator.

**`If-None-Match`.** A list, `*`, or `W/` (weak comparison) answers **304** with the ETag and `Cache-Control`, and no body.

**Tested:**
- same state → same tag, and a 304;
- an irrelevant registration, or withdrawal of an unrelated non-latest release → the tag is unchanged;
- a newer publication (none → available), each minimum change, a raise to `required`, and withdrawal of **only** the client's own
  release → a new tag and a 200, never a stale 304.

## 6. Public rate limit

- **Mechanism:** the kit's shared Postgres fixed-window limiter (`kit_rate_limit`, correct across replicas), bucket
  `release_compatibility`, 60 s window, `RELEASE_COMPATIBILITY_RATE_PER_CLIENT` (default 120).
- **Key:** the client address (`req.ip`; it honours `TRUST_PROXY` only), HMAC-keyed with `RELEASE_RATE_LIMIT_KEY`. The key is base64 of
  at least 32 bytes, required in production, and a random per-process key elsewhere. This follows the File ticket-redemption rule: an
  unkeyed IPv4 digest is reversible.
  - The kit stores only a sha256 of that, so no address is stored.
  - No request header chooses the key. `X-Forwarded-For` is ignored unless the deployment trusts its proxy, so one client cannot move into,
    or poison, another's bucket (tested).
- **Counting:** **every** request counts, including malformed, unknown, conditional and 304 requests, so validation cannot be used to
  bypass the limiter (tested).
- **Refusal:** 429 `rate_limited`, `no-store`, never a decision.
- **Retention:** a janitor purges ended windows every minute (bounded batches, `SKIP LOCKED`; the Audit 18.8 rule). No history of client
  addresses accumulates.
- **No `Retry-After`:** no Core API sends one; the window is at most 60 s.

## 7. Consistency under concurrent administration

**One SQL statement** reads the component, the exact release, the current policy and the latest. In PostgreSQL's READ COMMITTED, one
statement reads one snapshot, so a withdrawal or policy change (each atomic, 20.4) is seen either entirely or not at all. Every committed
state satisfies minimum ≤ latest (enforced by 20.2 / 20.4). So every answer is the decision of *some committed state*, with no heavyweight
lock, no SERIALIZABLE transaction and no administrative lock on the public path.

**Tested with real concurrency:** 60 reads racing 15 policy changes plus two withdrawals (separate pooled sessions). Every answer is
internally consistent: minimum ≤ latest, `reason` matches, `available` ⟺ latest > client, and withdrawn only for releases that were
actually withdrawn.

**Query plan (100 000 releases).** It uses `component_product_key_unique`, `release_component_version_unique` and a bitmap scan on
`release_latest_idx`; execution takes 0.28 ms. The product and policy scans were sequential only because those tables were tiny or empty
(20 and 0 rows). **No new index or migration.**

## 8. Privacy, audit and observability

- **Privacy:**
  - no user, device, installation or organization input is accepted;
  - nothing is persisted except the hashed limiter counter;
  - no per-read audit event (a read is not an administrative mutation), and no Audit call.
- **Headers:** helmet's `nosniff`, JSON content type, no cookies. CORS stays the kit's exact-origin `CORS_ORIGINS` choice, never `*`
  (§9).
- **`release_compatibility_snapshot`** is logged every 60 s and at shutdown. It holds counts over a **closed** outcome set:

  ```text
  required_withdrawn, required_below_minimum, available, none, not_modified, invalid_version, invalid_request,
  unknown_component, unknown_release, rate_limited, failed
  ```

  plus latency count, average and maximum. It never carries a product, component, version, address, id or correlation id (tested).
- **`release_limiter_purged rows=`** records only a count.

## 9. Web, desktop, mobile

The decision is component-based and technology-neutral. See the [client integration guide](../release-compatibility-client-guide.md):

| Client | `required` | `available` | `none` |
|---|---|---|---|
| **Web (first-class)** | Reload the deployed application | Optional refresh | Continue |
| **Desktop** (any technology; Tauri is one option) | Block use and update through the updater | Optional prompt | Continue |
| **iOS / Android** | Block use; the app directs the user to its store | Optional | Continue |

In every case, input errors mean "cannot verify this build", and release-service never reloads, downloads, installs or opens a store.

**Outage.** Clients fail open with the **last trusted decision**. A cached `required` stays binding until a fresh answer lifts it; an
error, 429 or timeout never lifts it.

**CORS.** A browser calling release-service directly needs the web application's exact origins in `CORS_ORIGINS` (the kit's service
setting, off by default). An ingress that serves the web app and the API from one origin needs none. Choosing the origins is deployment
configuration (21.x).

## 10. Tests (focused; Full Core Validation NOT RUN)

| Suite | Command | Result |
|---|---|---|
| release-service unit. Includes **decision (20)**: the matrix, SemVer precedence, pre-releases, no forced update, input errors, and a property check over 300+ committable states. Plus config (incl. key and bounds) | `npm test -w release-service` | 76 / 76 |
| release-service E2E, real PostgreSQL 16, runtime role. Includes **compatibility (34)**: matrix, kinds, withdrawn-above-latest, latest rules, current policy, input errors, backend, public / no identity, no writes, limiter privacy, logs, cache / ETag, rate limit and recovery, janitor, concurrency. Also OpenAPI (6), and every 20.2–20.4 suite unchanged | `npm run test:e2e -w release-service` | 190 / 190 |
| Cross-service release suites (CI → audit, owner → Auth → audit), all real | `test:e2e -w @nawara/e2e-audit-producers -- release*.e2e-spec.ts` | 3 / 3 |
| Query plan on 100 000 releases | EXPLAIN ANALYZE (one-off) | indexes used, 0.28 ms |
| Typecheck, lint (0 findings), build; type check of the producer suite | | pass |
| Repository checks, and the check script's own tests | `check:repo`, `test:repo` | pass; 17 / 17 |
| Production image (with `RELEASE_RATE_LIMIT_KEY`, owner administration configured) | `docker build` + `scripts/smoke-core-image.sh release-service` | SMOKE PASSED |

**Mutation check (15 mutants): all killed.**
- The decision rules:
  - withdrawn ignored;
  - minimum ignored;
  - a newer release forces an update;
  - an unknown release answered as a decision;
  - a backend accepted;
  - string order instead of SemVer.
- Latest and the policy:
  - latest including pre-releases;
  - latest including withdrawn releases;
  - the oldest policy used as current.
- The ETag ignoring the release status, the policy or the latest.
- The rate limit:
  - bypassed;
  - keyed by a caller header;
  - applied only after validation.

The first run found **one real test gap**: withdrawing only the client's own release, with no policy change, left the status mutant
alive. A test was added and the mutant is now killed. Every source was restored and hash-verified.

**Not re-run:** Auth, Audit and audit-contract suites. None of their code, and no catalog, changed in 20.5; nothing new is emitted.

## 11. Scope verification and follow-ups

**Not built:**
- no updater, deployment, artifact distribution or store integration;
- no Tauri-specific domain;
- no user tracking, and no per-read audit;
- no Auth, Billing or Organization dependency;
- no change to CI authority (`release.register` / `release.publish`) or owner authority (`release.withdraw` /
  `compatibility_policy.change`), and no operator authority;
- no new migration;
- no 20.6 / 20.7 / Stage 21 work.

**Full Core Validation: NOT RUN.**

**Follow-ups (not implemented):**
- **20.6:**
  - alerting on the snapshot (for example a spike of `unknown_release` = CI not registering builds; `rate_limited`; `failed`);
  - the operational review of `max-age` against real client volume;
  - whether a CDN may cache the decision, which `public` allows and `max-age` bounds;
  - limiter table growth under attack (the janitor bounds it per window);
  - the rest of the 20.4 / 20.3 follow-ups.
- **20.7:** certify the decision matrix, the cache and ETag invalidation claims, the rate limit, consistency and the mutation set.
- **21.C:** none.
- **21.x:**
  - production `RELEASE_RATE_LIMIT_KEY` provisioning and rotation;
  - `TRUST_PROXY` for the real ingress, so client addresses are the real ones;
  - `CORS_ORIGINS` for web clients (or same-origin ingress);
  - CDN / ingress caching policy;
  - monitoring of the snapshot line.
