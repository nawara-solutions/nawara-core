# release-service runbooks

Operational procedures for Release Management (ADR-0051; Stages 20.2–20.6).
- **Signals.** They are structured JSON log lines (`msg` field). Core has no metrics platform, so alert rules are log-based (§1). Routing
  alerts to people is a production prerequisite (P-R6 / P-A4 / P-S5), not chosen here.
- **Secrets.** Never paste a token, digest, step-up proof, bearer, `RELEASE_RATE_LIMIT_KEY`, credential or client address into a ticket,
  chat or command history. Every `<…>` is yours to fill in.

Related:
- [service README](../../apps/release-service/README.md);
- [client integration guide](../architecture/release-compatibility-client-guide.md);
- stage records [20.3](../architecture/stage-20/stage-20-3-registration-and-lifecycle.md),
  [20.4](../architecture/stage-20/stage-20-4-compatibility-and-owner-administration.md),
  [20.5](../architecture/stage-20/stage-20-5-client-compatibility-api.md) and
  [20.6](../architecture/stage-20/stage-20-6-security-operational-hardening.md).

**Never, as a recovery step:**
- edit or delete `product` / `component` / `release` / `compatibility_policy` rows by hand (the schema refuses most edits: triggers and
  revoked privileges);
- delete or "republish" `outbox` rows;
- raise a service's authority to work around a refusal.

The supported paths are the APIs below.

## 1. Signals and alert rules

Each replica writes a snapshot every 60 s and at shutdown. It holds counts over **closed** labels only: never a product, component,
version, release, caller, owner, Company, address or correlation id. The thresholds are starting points; tune them with real traffic.

| Signal (`msg` starts with) | Alert when | Runbook |
|---|---|---|
| `release_outbox_snapshot … oldest_pending_s=N` | N > 300 (audit evidence delayed more than 5 min) | §2 |
| `release_outbox_snapshot … retrying=N max_attempts=M` | N > 0 for 3 snapshots, or M ≥ 8 | §2 |
| `outbox_publish_failure` (kit relay) | sustained over 5 min | §2 |
| `release_outbox_snapshot_failed` | 3 in 5 min (the database is unreachable from this replica) | §7 |
| `release_admin_snapshot … withdraw_auth_timeout / _auth_unavailable / policy_change_auth_*` | any, sustained | §3 |
| `release_admin_snapshot … *_step_up_denied` | a burst without a known owner session (probing with stolen bearers) | §4 |
| `release_admin_snapshot … *_authority_denied` | any (a non-owner tried the owner routes) | §4 |
| `release_admin_snapshot … *_failed` / `release_admin_failed` | any | §4, §7 |
| `release_automation_snapshot … *_denied` | any (a CI credential used outside its product or capability) | §6 |
| `release_automation_snapshot … register_conflict` | a burst (CI re-registering a version with another build id) | §6 |
| `release_automation_snapshot … *_failed` / `release_automation_failed` | any | §7 |
| `release_compatibility_snapshot … unknown_release=N` | N rising well above the baseline (clients run builds CI never registered) | §5 |
| `release_compatibility_snapshot … rate_limited=N` | sustained, or a jump without a known product event | §8 |
| `release_compatibility_snapshot … failed=N` | any, sustained | §7 |
| `release_compatibility_snapshot … latency_max_ms=N` | N > 1000 for 3 snapshots | §7 |
| `release_limiter_purge_failure` | 3 in 5 min | §8 |

The startup line `release_surfaces …` states which surfaces this replica serves:
- the number of automation callers;
- owner administration enabled or disabled;
- the compatibility `max-age` and rate;
- `trust_proxy`;
- the number of CORS origins.

Compare it across replicas after a deploy.

## 2. Audit backlog (broker or audit-service down)

**What it means.** Every registration, publication, withdrawal and minimum change commits **with** its audit intent in the outbox, and the
kit relay delivers it asynchronously. A broker or audit-service outage **never** fails or undoes a mutation. Evidence waits.
1. Confirm it with the snapshot (`pending`, `oldest_pending_s`, `retrying`), or on demand:

   ```bash
   nawara-check-outbox-lag --database-url <release runtime URL> --max-age-seconds 300
   ```

   (the kit CLI; it reads only; exit 1 = over the threshold). It is also in the image at
   `node /app/libs/service-kit/dist/cli/check-outbox-lag.js`.
2. Check the broker (P-A6) and audit-service ingestion (its own runbook: DLQ depth `nawara-check-dlq`, queue
   `audit-service.audit.dead`). **Release events that audit-service refuses land in audit-service's DLQ, not here.** DLQ monitoring
   belongs to audit-service (P-A4).
3. When the broker returns, the backlog drains by itself: retries are unlimited with a backoff capped by the kit. Do nothing to the rows.
4. **Wrong deploy order** (§9): release-service emitted `release.*` / `compatibility_policy.changed` before audit-service knew the catalog.
   Those events are refused as `unknown_action` and dead-lettered by audit-service. Deploy the catalog-aware audit-service, then
   **replay** them from its DLQ (`nawara-dlq replay`, audit-service runbook). Nothing is lost.

## 3. Auth outage (owner administration only)

`auth_timeout` (Auth slow: the shared `AUTH_TIMEOUT_MS` budget ran out) or `auth_unavailable` (refused, reset, redirected, malformed,
oversized) means owner withdrawals and minimum changes fail closed with **503** and change nothing. Classification by surface:

| Surface | During an Auth outage |
|---|---|
| CI automation (service tokens) | unaffected |
| Public compatibility read | unaffected |
| Owner administration | fails closed (503), nothing changed, no step-up spent |
| `/ready` | stays 200 (Auth is not a readiness dependency: a replica is not "down" because one surface depends on another service) |

Actions:
1. Check Auth's health and runbooks, then the network path. `AUTH_SERVICE_URL` must be a plain origin (validated at boot); redirects are
   never followed.
2. If an emergency withdrawal is needed during the outage, there is no bypass by design: no operator or CI withdrawal. Restore Auth.

## 4. Owner administration refusals

**A spent step-up.** The owner's proof is consumed **in Auth** (`POST /auth/step-up/verify`) just before the change. If release-service
then fails (a 500, or a 409 from a race the database refused), the proof is spent and **the change was not made**.
- Do **not** retry with the same proof: it answers `403 step_up_required`.
- Do this instead:
  1. obtain a **new** step-up for the same purpose (`release.withdraw` or `compatibility_policy.change`; TOTP or passkey);
  2. retry the same request. A retry that turns out to be a no-op answers 200 `changed:false` (and still spends the new proof).

Every refusal that is known before the change (400, 404, 409 preconditions, 403 authority) never spends the proof.

**`409 would_break_minimum` (a withdrawal blocked by the minimum).** Withdrawing that release would leave the current minimum above the new
latest. This is the invariant, not a bug; there is no force option. Do this:
1. Read the current policy version (the last `policyVersion` you set, or the 409 `policy_conflict` answer).
2. Lower the minimum to a published, not withdrawn, stable release that stays **at or below the latest after** the withdrawal:
   `POST …/compatibility-policy {minimumVersion, expectedPolicyVersion}` with a `compatibility_policy.change` step-up.
3. Withdraw: `POST …/releases/{version}/withdraw` with a `release.withdraw` step-up.

Both steps are audited. Raise the minimum again after a fix-forward release is published.

**Other refusals.**
- `authority_denied`: the caller is not the owner of `RELEASE_OPERATING_COMPANY_ID`. Check the configured Company, not the person.
- `step_up_denied` bursts: consider a stolen bearer; revoke the owner's sessions in Auth.

## 5. `unknown_release` spike

Clients report versions that were never registered. The usual cause is a pipeline that built, deployed or distributed without calling
`register` (or registered under another component key, §6).
1. It is a count only; no version is stored or logged (by design). Ask the product teams which build is new.
2. Check the pipeline's register step and its credential (`release_automation_snapshot … register_denied`).
3. Register the build (CI, idempotent). Clients then get a decision within one `max-age`.

Clients treat `unknown_release` as "cannot verify this build" (the client guide), so a missed registration blocks installed clients. Fix
the pipeline, not the decision.

## 6. CI automation problems

- **`*_denied`:** the credential holds no such capability, or not for this product (`RELEASE_SERVICE_POLICY`). Correct the policy or the
  pipeline's product key. Never widen a caller to "all products": there is no wildcard.
- **`register_conflict`:** the same version was registered with a different `buildId` / `sourceRevision` / `notesRef`. A release is
  immutable; bump the version.
- **A mistyped component key.** A first registration under a wrong key (for example `web-ap`) creates that component, permanently. It is
  **inert**:
  - it has only the releases CI put there;
  - it is never latest for the real component;
  - clients query the real key.

  Register the build again under the correct key. Leave the stray component: rows are never deleted, it is not a security problem, and a
  repeated typo only ever lands in the same stray key. Do not "reuse" it.
- **Credential rotation (P-S2 / P-R1).** Each caller has two digest slots. Add the new digest next to the old one, deploy, switch CI to
  the new token, remove the old digest, deploy.

## 7. Database problems

`/ready` answers 503 (`database` / `migrations`), and every persistence-dependent surface fails (500s, `*_failed` counters). `/health`
stays 200 (liveness). The compatibility read then answers a bounded 500 (never a decision). Clients fail open with their last trusted
decision, and a cached `required` stays binding. Restore the database; nothing needs replaying (a mutation either committed with its
audit intent or not at all).

## 8. Public rate limit incidents

- **Mechanism.** The kit Postgres limiter, bucket `release_compatibility`, 60 s window, `RELEASE_COMPATIBILITY_RATE_PER_CLIENT` per
  client address (default 120).
- **Key.** An HMAC with `RELEASE_RATE_LIMIT_KEY`:
  - with `TRUST_PROXY` off, the TCP peer;
  - with it on, the **rightmost** `X-Forwarded-For` hop;
  - IPv6 counts by /64.
- **Legitimate 429s.** Many clients behind one NAT or proxy share a bucket. Raise the rate (config), or confirm `TRUST_PROXY` and the
  ingress: behind a CDN, the rightmost hop is the CDN edge, so clients share buckets (strict, never loose) until the ingress chain is
  settled (21.x).
- **An abusive client.** Its requests are refused without reaching the decision query. Add an ingress or WAF rule for volumetric abuse;
  the application limiter is not a DDoS shield (every request still costs one upsert).
- **Rotating `RELEASE_RATE_LIMIT_KEY`.** Replace it at deploy time. Buckets restart empty; at most one extra window's allowance per
  client.
- **Limiter storage failing** (`failed=` rising, 500s). The read fails closed as an API error, never as a decision; see §7.

## 9. Deployment order

1. **Database.** Provision the `release` database and roles (`infra/postgres/init`), then apply migrations as the migrator:
   `npm run migrate -w release-service` with `MIGRATION_DATABASE_URL` (never at startup, never with runtime credentials).
2. **audit-service with the catalog that knows `release.registered`, `release.published`, `release.withdrawn` and
   `compatibility_policy.changed`, deployed first.** Otherwise the events are dead-lettered as unknown (recoverable by replay, §2).
3. **Broker** reachable (`RABBITMQ_URL`, required in production), with a per-service identity once P-A1 lands.
4. **Auth** with the `release.withdraw` / `compatibility_policy.change` step-up purposes (auth-service ≥ Stage 20.4), before
   `AUTH_SERVICE_URL` + `RELEASE_OPERATING_COMPANY_ID` enable owner administration.
5. **release-service** with production configuration. The boot refuses a missing `RABBITMQ_URL`, a missing `RELEASE_RATE_LIMIT_KEY`, a
   superuser or migrator `DATABASE_URL`, a malformed policy, a partial owner-admin configuration, or an unsafe `AUTH_SERVICE_URL`.
6. **CI credentials and policy** (P-R1): per pipeline, one caller, only its products and only the capabilities it needs.
7. **Public ingress** for `…/compatibility` (P-R5):
   - TLS;
   - `TRUST_PROXY` set to match the real chain;
   - `CORS_ORIGINS` listing the web app origins (or same-origin ingress);
   - an optional CDN under the conditions of the 20.6 record §5.
