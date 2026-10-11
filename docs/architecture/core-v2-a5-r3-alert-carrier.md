# Core V2 A5.4-A5 R3: the operational alert carrier (design record)

- **Status:** design record, written 2026-10-10 as **documentation only** under the owner's documentation authorization for R3. **The
  record itself selects no provider, creates no account, installs nothing and authorizes no deployment.** §9 lists the owner decisions
  as they stood when the design was written (all OPEN, the defaults being recommendations, **not approvals**); the owner's later
  approvals **for provider-neutral code only** are recorded in §9's update note and in §15.
- **Implementation status (2026-10-11):** implemented locally on `feature/core-v2-a5-r3-readiness-alert` under the owner's
  development authorization (§15): `infra/alerting/` (script, service and timer units), its tests and the runbook
  [`auth-readiness-alerting.md`](../runbooks/auth-readiness-alerting.md). **No provider is selected, nothing is installed, no
  demonstration has run, and R3 is not satisfied.**
- **Provider integration (2026-10-11, §16):** the owner selected **Pushover** (receiver) and **Healthchecks.io** (heartbeat); both are
  integrated and tested locally against fake endpoints only. **No account or credential exists, no real message or ping was sent,
  nothing is installed, no demonstration has run, the carrier is not certified, and R3 is not satisfied.**
- **Governs:** [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4, clarification item 10 (R3), and the
  [F6 readiness decision record](core-v2-a5-4-f6-transitional-readiness.md) ("Later rulings", R3). Where this record and either differs,
  they govern. Related: the [A5.4-A5 design](core-v2-a5-4-a5-readiness-design.md) (§7, §10 item 10, §11 OPEN-3), the
  [A12 record](core-v2-a12-observability.md), the [A5 record](core-v2-a5-organization.md) §9.1.
- **Labels used below:** **CONFIRMED** (read in the repository or on GitHub on 2026-10-10, `main` at `5edaf34`), **PROPOSED** (this
  design), **BLOCKED** (waits on an owner decision, a provider or another gate).

## 1. The requirement (R3, CONFIRMED)

ADR-0063 §4 item 10: "Before the **first** production deployment of any Auth image containing the A5.4-A5 readiness check, an explicitly
reviewed operational alert mechanism is implemented and demonstrated; the requirement also applies to later Auth deployments, including
F6-related redeployments. A separately certified equivalent mechanism may satisfy it without completing the whole A12.10 stage. The alert
implementation, delivery channel, polling strategy and demonstration environment are the subject of a separate reviewed design. Logs and
an attended operator give diagnostic visibility for local testing; they do not by themselves satisfy the production alert requirement."

This record is that separate design. It is not the review or the demonstration R3 requires; both come later (§8, §10).

## 2. Production alerting today: none (CONFIRMED)

| Fact | Evidence |
|---|---|
| No production observability stack: A12.10 has not started; the stack's production placement is undecided | [A12 record](core-v2-a12-observability.md) status and decision D2 |
| Service metrics are off unless a deployment enables them; the Auth deploy does not | A12 status (`METRICS_ENABLED=false` by default); `apps/auth-service/deploy/provision-and-deploy.sh` |
| No Alertmanager and no receiver anywhere | A12 refinement D6a: Alertmanager "DEFERRED until a concrete receiver exists"; no receiver, webhook or pager is configured in the repository |
| Locally, readiness has no alert rule | `infra/observability/prometheus/rules/nawara-core.rules.yml`: "Readiness has no alert: its gauges change only when /ready is called" |
| Nothing probes Auth's `/ready` in production | the container healthcheck and the deploy wait use `/auth/health` (`provision-and-deploy.sh`); the A12 record: Auth's readiness gauges are "stale in production unless something probes Auth's `/ready`"; the runbook's §6.1 probe is attended |
| No scheduled automation | no GitHub workflow has a `schedule:`; every production SSH workflow is dispatch-only and waits for the `production` environment approval (V2-A.3), so a scheduled workflow cannot be an always-on prober without a governance change |
| notification-service is not in production | `CLAUDE.md`; it cannot carry alerts |

**What is observable** (CONFIRMED, A5.4-A5): `/ready` answers 503 with the names of failing checks; Auth's JSON log carries
`hierarchy_authority_not_ready reason=<code> source=<local|organization-service> marker=<token>` when the reason changes, and the
registry's `readiness_check_failed check=<name> error=<Class>[ code=<code>][ kind=<kind>] — /ready answers 503 until it recovers` when a
check flips (`code` and `kind` are optional: a timeout reads `error=ReadinessCheckTimeout` with no code;
`libs/service-kit/src/health/readiness.registry.ts`, `logging/failure.ts`). The container's image and (for images built since V2-A.2)
its `org.opencontainers.image.revision` label are readable with `docker inspect`. The last **documented** production Auth image
(`97f78cb`, 2026-10-02) is a legacy image without a revision label; the **live** image is **NOT VERIFIED**.

**Conclusion:** no existing component can carry R3. Something must probe `/ready` and deliver alerts. **No new service, endpoint or
metric is needed**; one operational component (a prober) and two external accounts (a receiver, a heartbeat) are.

## 3. Options and recommendation

| | A. Reuse A12 (A12.10) | B. Lightweight host-local carrier |
|---|---|---|
| Components | production Prometheus, a blackbox prober (Prometheus cannot probe `/ready` itself), Alertmanager, a receiver; metrics enabled in Auth | one bash prober run by a systemd timer on the production host; one receiver; one external heartbeat |
| Sees the reason code | not without log shipping (out of A12's decided scope, D7: no Loki) | yes, from the container's own JSON log lines (§5) |
| Depends on | A12.10 start, D2 (placement), D6a (receiver), retention and network decisions | the receiver and heartbeat decisions only |
| New production surface | several services and ports | one script and one timer; no port, no metric, no image change |
| Status | **BLOCKED** (A12.10 not started) | **PROPOSED** (recommended) |

**Recommendation (PROPOSED, O-R3-1):** **B**, as the "separately certified equivalent" R3 allows. It is retired or wrapped when A12.10
delivers a certified path (§12).

## 4. Carrier behavior (PROPOSED)

**Probe (every cycle; default interval 60 s, O-R3-5).** On the host:
1. `docker inspect` of the Auth container (`nawara-core-auth-service`, the deploy script's `APP`): its container id, running state, its
   **image ID** (`.Image`, the local configuration digest) and the revision label if present (else `unlabelled`); then
   `docker image inspect` of that image for its **registry index digest** (`RepoDigests`, the identity deploy records use; `none` if
   absent). The image ID and the index digest are distinct fields and are never confused (L-1). A missing or stopped container is the
   state `probe_failed:container`.
2. `/ready` read **inside the container** with a body-reading probe (`node -e fetch(…)`, as the R2 restore drill does; BusyBox `wget`
   does not return a 503 body), bounded by a timeout (proposed 10 s). No answer is `probe_failed:unreachable`.
3. On a not-ready answer, the Auth diagnostic lines since the **start of the previous cycle's probe** (persisted, so a line written by
   the carrier's own probe or by an operator's `/ready` call is never missed; `docker logs --since`), from which only the enumerated
   tokens of §5 are extracted.

**Carry-forward of diagnostics.** Auth writes its reason line only when the reason changes, and the registry its line only when a check
flips, so a persisting failure produces no new line. The last recognized reason and registry code are therefore kept in the durable state,
**keyed to the container id**, and replaced only by a newer recognized line from the same container. `reason=unknown` is used only when
none was recognized for this container, and moving to `unknown` is never a CHANGED. A lost line (log rotation inside a window) is covered
by the carry-forward and never hides the failure itself, which the `/ready` body drives.

**Execution boundary.** Every Docker call has its own timeout (a `timeout`-killed `docker exec` may leave the `node` probe running in the
container; the probe itself is bounded). Cycles are serialized by a lock. Access to the Docker socket is root-equivalent on the host: the
unit runs as root but hardened (`NoNewPrivileges`, `ProtectSystem`, no added capabilities), and `set -x` is forbidden. The host's Docker
log driver and rotation are checked read-only before installation (the deploy script sets no `--log-driver` or `--log-opt`).

**States:** `ready`; `not_ready` with its failing set and, when `hierarchy_authority` is in it, its reason; `probe_failed` with its
class (`container`, `unreachable`, `timeout`, `unparseable`). **Any** `/ready` failure counts, not only `hierarchy_authority`
(owner instruction; `database`, `migrations`, `shutting_down` and any later check alert too). A deployment therefore raises critical
alerts by design (`shutting_down` while draining, then `probe_failed:container` or `unreachable` during the swap, then RECOVERED); this is
expected and **not suppressed**.

**Lifecycle:**

| Event | When | Message |
|---|---|---|
| ALERT | `ready` → `not_ready` or `probe_failed` | the full payload (§6) |
| CHANGED | the failing set, the reason, or the probe-failure class changes while not ready | the full payload, with the previous state |
| REMINDER | the same failure persists for one reminder interval (proposed hourly, O-R3-5) since the last message | the full payload and the duration |
| RECOVERED | not ready / probe failed → `ready` | the payload with the duration of the incident |
| DEPLOYMENT | the container's image changes (any state) | the old and new image identity and revision; also shows the carrier saw the redeploy |

**Durable state.** One state file (root-owned, `0600`, written atomically by rename) holding everything the next cycle needs (L-2): the
last state, its failing checks and probe-failure class; the carried-forward reason, source, marker and registry code, with the container id
they belong to; the reason last reported (so a later `unknown` is never a change); the container id, image ID, index digest and revision;
the failure's first-seen time and the last message time; the log cursor (the previous cycle's probe start, for `--since`); the boot id;
and the queue sequence. The undelivered messages are separate files in a queue directory, never in the state file. A restart re-reads it, so a restart never re-sends an ALERT for
an unchanged failure and never loses a RECOVERED. A missing or unreadable state file is treated as "unknown": the next observation is
sent as ALERT or as an initial `ready` notice (never silently assumed ready).

**Delivery and its failures.** One receiver (O-R3-2). A delivery that fails or times out stays queued and is retried each cycle; queued
messages are sent oldest first. While anything is queued, the carrier **does not check in** with the heartbeat, so a broken receiver is
reported from outside the host (§7).

**Heartbeat (dead-man's switch).** After each cycle whose messages were all delivered, the carrier checks in with an external heartbeat
service (O-R3-3). Missed check-ins (the host down, the timer stopped, the script failing, the receiver failing) raise an alert from the
heartbeat service itself, through a channel independent of the carrier.

**G6/F6 windows (O-R3-4).** **No suppression.** The accepted semantics make every disagreement not ready, inside the attended F6 window
too (ADR-0063 §4 ruling 1), and an alert is sent. A future, owner-approved annotation could label `source_ahead_of_marker` as "expected
inside an authorized F6 disagreement window", set by the attended operator and self-expiring; it would change the wording only, never
delivery, timing or severity. Until ruled, no annotation exists.

**Fail-closed rules.** Anything the carrier cannot classify is reported, never dropped: an unparseable `/ready` answer is
`probe_failed:unparseable`; a not-ready answer for which no reason has been recognized for this container (after the carry-forward) is sent with
`reason=unknown`; a carrier error after
probing withholds the heartbeat. The carrier never retries Auth, never restarts it, never changes routing, configuration, the marker or
any database, and never reads a database.

## 5. Safe diagnostic extraction (PROPOSED)

- **Only top-level kit log records** are considered, anchored at the start of the line on the kit's fixed envelope order
  (`ts, level, service, msg, context, …`, `libs/service-kit/src/logging/json-logger.ts`):
  `^\{"ts":"…","level":"warn","service":"auth-service","msg":"…"`, so a nested `msg` key or a value cannot match (`JSON.stringify`
  escapes every `"` inside a value). The reason line must also carry `"context":"HierarchyAuthorityReadiness"` and the registry line the
  registry's own context (`"Readiness"`).
- A reason is accepted only while `/ready` lists `hierarchy_authority`, and, when a registry line for that check is also recognized, only
  if its `code` equals the reason.
- **Only these messages** are recognized, each with a strict regular expression; their captured fields must belong to fixed enumerations:

| Message | Fields kept | Allowed values |
|---|---|---|
| `hierarchy_authority_not_ready reason=… source=… marker=…` | reason, source, marker | reason: `source_ahead_of_marker`, `marker_ahead_of_source`, `marker_frozen`, `marker_missing`, `marker_invalid`, `marker_unreadable`; source: `local`, `organization-service`; marker: `local`, `frozen`, `org_authoritative`, `missing`, `invalid`, `unreadable` |
| `readiness_check_failed check=… error=…[ code=…][ kind=…] — /ready answers 503 until it recovers` | check, error class, optional code, optional kind | check: `[a-z][a-z0-9_-]{0,40}` (the kit's check-name rule); error class: `[A-Za-z][A-Za-z0-9_]{0,63}`; code: `[A-Za-z0-9_.-]{1,64}` (the kit's token rule); kind: one of the kit's `FailureKind` values (`logging/failure.ts`) |

The implementation recognizes the registry line of the `hierarchy_authority` check only (its `code` is what `registry_code` reports); the
failing set of every other check comes from the `/ready` body, which needs no log line.

- A value outside its enumeration or pattern becomes `unrecognized`, never echoed. Nothing else from the log (message text, stack,
  request ids, fields) is read into the payload.
- The `/ready` body is parsed as JSON and accepted only in the kit's two shapes (`{"status":"ready"}`, `{"status":"unavailable","failed":[names]}`
  with every name matching the check-name rule); anything else is `probe_failed:unparseable`.

## 6. Alert payload contract (PROPOSED)

Plain key/value text (or JSON for a webhook receiver), **only** these fields:

| Field | Content |
|---|---|
| `kind` | `ALERT`, `CHANGED`, `REMINDER`, `RECOVERED`, `DEPLOYMENT`, `CARRIER_STARTED` |
| `severity` | `critical` for every not-ready or probe-failed state (fresh path; no downgrade), `info` for RECOVERED, DEPLOYMENT, CARRIER_STARTED |
| `service` | `auth-service` |
| `host` | an operator-configured, non-secret host label |
| `container` | `nawara-core-auth-service` |
| `image`, `index_digest`, `revision` | `image`: the container's image ID (`docker inspect` `.Image`); `index_digest`: the registry index digest from `docker image inspect` `RepoDigests` when present (the identity deploy records use), else `none`; `revision`: the `org.opencontainers.image.revision` label, or `unlabelled` for legacy images |
| `state` | `ready`, `not_ready`, `probe_failed` |
| `failed` | the failing check names |
| `reason`, `source`, `marker` | the §5 tokens when `hierarchy_authority` fails; else absent |
| `registry_code` | the §5 code of the latest registry line for a failing check |
| `probe_failure` | `container`, `unreachable`, `timeout`, `unparseable` |
| `since`, `duration_s`, `created_at` | UTC times (`created_at`: when the message was queued; a delayed delivery keeps it) |
| `previous` | the previous state (ALERT, CHANGED, RECOVERED) |
| `previous_image`, `previous_revision` | DEPLOYMENT only: the image ID and revision seen before |
| `runbook` | a fixed pointer to the runbook section |

**Never** in the payload, the carrier's own logs or its argv: the receiver or heartbeat credentials, any environment value, database
URL, token, user, hierarchy content, log text beyond the §5 tokens. The credentials (including a heartbeat's secret check-in URL, which
is itself a credential) are read from root-only `0600` files and handed to curl as `--config <that file>` (the implementation's form; the
file's path is not a secret, its content is never read by the carrier itself): neither a header value nor a secret URL ever appears in
argv, in the environment of child processes, or in the journal. The heartbeat check-in
carries **no payload**.

**Reason guidance (static text in the runbook, keyed by the payload):** `marker_frozen` is critical on the fresh path (production);
`source_ahead_of_marker` is expected only inside the attended F6 disagreement window and critical otherwise; `marker_ahead_of_source`
is never expected; `marker_missing`, `marker_invalid`, `marker_unreadable` mean the marker cannot be trusted. The carrier never decides
which case applies: the operator does, with the authority agreement check (organization-production runbook §6.2).

## 7. Detecting carrier failure (PROPOSED)

| Failure | Detected by |
|---|---|
| receiver down or refusing | the heartbeat is withheld while messages are queued → the heartbeat service alerts |
| carrier script failing or crashing | no check-in → the heartbeat service alerts; systemd records the failed unit |
| timer stopped, host down or rebooted without the timer | no check-in → the heartbeat service alerts |
| heartbeat service down | **not** detectable by the carrier itself: the heartbeat provider's own reliability is a provider requirement (§9, O-R3-3) |
| carrier (re)installed, its state lost, or the host rebooted | `CARRIER_STARTED` (info) on the first cycle afterwards. A timer stopped and started again **without** a reboot is not announced by the carrier: the heartbeat silence reports the gap |

## 8. Provider contracts (BLOCKED: no provider is selected)

**Receiver (O-R3-2)** must: deliver to the owner privately (not a public channel); accept an authenticated HTTPS request (or an
authenticated mail submission) with a credential usable from a root-only file; return a success status the carrier can check; accept a
small text payload; and keep its credential revocable. It must not require the credential in a URL that could be logged.

**Heartbeat (O-R3-3)** must: be **independent of the production host and of the receiver**; accept a check-in by an authenticated or
unguessable HTTPS endpoint; alert the owner on its own after a configurable silence (proposed: three missed cycles); alert through a
channel that still works if the receiver is down; and be **reliable enough to be the backstop** (L-3, §7): its availability, its own
alert delivery and its silence detection are the provider's documented service, reviewed by the owner when the provider is selected,
because the carrier cannot detect the heartbeat service's own failure.

No account is created and no credential exists. Choosing them is the owner's (§9). *Update 2026-10-11: chosen; see §16 for how each
selected provider meets these contracts.*

## 9. Owner decisions (all OPEN unless marked)

| # | Decision | Proposed default (recommendation, **not approved**) | Status |
|---|---|---|---|
| O-R3-1 | the carrier | B, the lightweight host-local carrier (§3); A12.10 later | OPEN |
| O-R3-2 | the receiver | one owner-selected private receiver meeting §8 | OPEN; **BLOCKED** on provider selection |
| O-R3-3 | the heartbeat; the demonstration environment | one independent external heartbeat meeting §8; demonstration on a non-production host with real Auth packaging (§10) | OPEN; **BLOCKED** on provider selection |
| O-R3-4 | G6/F6 windows | no suppression; no annotation until separately ruled | OPEN |
| O-R3-5 | intervals; scope of failures; code location | 60 s probe, hourly reminder, every `/ready` failure (the latter is an owner instruction, recorded as such), code under `infra/alerting/` | OPEN (except "every failure") |
| O-R3-6 | the record type | this short design record, subject to architectural governance review; an ADR only if the review asks for one | OPEN |

**Update (2026-10-11, owner development authorization; provider-neutral code only).** Approved for the implementation of §15:
O-R3-1 (the host-local carrier); provider-neutral receiver and heartbeat **interfaces** under O-R3-2 and O-R3-3; O-R3-4 (no suppression
and no authorized-window bypass); O-R3-5 (60 s probes, 60 min reminders, every `/ready` failure, code under `infra/alerting/`); O-R3-6
(this record as the implementation reference, no additional ADR). **Still OPEN and BLOCKED:** the receiver provider, the heartbeat
provider, their accounts and credentials, and the demonstration environment. The table above is kept as written.

**Update (2026-10-11, owner development authorization "Integrate Pushover + Healthchecks.io with R3").** O-R3-2: **Pushover**; O-R3-3:
**Healthchecks.io** (§16). **Still OPEN:** the accounts and credentials (owner-created), the demonstration environment, the
certification and the installation. Pushover emergency priority is not authorized.

## 10. Tests and demonstration (as written 2026-10-10: PROPOSED; the tests are since implemented, §15; the demonstration has not run)

**Focused tests** (local, with the existing fake-Docker deploy-test harness and a fake receiver and heartbeat; `npm run test:deploy`):

| # | Case |
|---|---|
| C1 | each of the six `hierarchy_authority` reasons: ALERT with the exact tokens; the reason **carried forward** into a REMINDER and across a restart (no `unknown`, no false CHANGED) |
| C2 | other `/ready` failures (`database`, `migrations`, `shutting_down`, several at once): ALERT with the failing set, no reason; registry lines with no `code`, with `kind`, and the timeout line (`error=ReadinessCheckTimeout`) are recognized |
| C3 | probe failures: container missing or stopped; `/ready` unreachable; timeout; unparseable body |
| C4 | transitions: ALERT once; CHANGED on a new reason or failing set; nothing on an unchanged probe |
| C5 | bounded reminders: exactly one per interval while the failure persists |
| C6 | recovery: one RECOVERED with the duration; none if never failed |
| C7 | restart: state re-read; no duplicate ALERT; RECOVERED after a restart still sent; CARRIER_STARTED sent; a corrupt state file fails safe (§4) |
| C8 | receiver failure: message queued, retried, delivered in order; heartbeat withheld while queued |
| C9 | heartbeat: checked in only after full delivery; withheld on any carrier error |
| C10 | deployment: image change → DEPLOYMENT; unlabelled legacy image → `revision=unlabelled`; a deploy's `shutting_down` → swap → RECOVERED sequence is alerted, not suppressed |
| C11 | secret redaction: no credential, environment value, URL or log text in payload, carrier output or argv |
| C12 | spoofed or malformed logs: diagnostics inside another field or a nested `msg`, a wrong `context`, a reason that disagrees with the registry `code`, plain text, out-of-enumeration values, oversized lines → `unrecognized` or ignored, never echoed |
| C13 | no suppression: `source_ahead_of_marker` alerts whatever the time or any file present |
| C14 | read-only: the carrier never runs a mutating Docker command (`rm`, `restart`, `stop`, `exec` other than the probe) |
| M | mutation checks: alert on every probe; no RECOVERED; payload leak; ready treated as failure; heartbeat while queued |

**Demonstration before any production deployment (required by R3; BLOCKED on O-R3-2 and O-R3-3):** on a **non-production** host, with
a real Auth image containing A5.4-A5 (a labelled, attested `main` image), a disposable database, the real receiver and the real heartbeat:
1. healthy start: CARRIER_STARTED; heartbeat check-ins;
2. induce `marker_frozen` (the Auth CLI `hierarchy-freeze` on the disposable database): ALERT; reminder after the (shortened) interval;
   unfreeze: RECOVERED;
3. induce `source_ahead_of_marker` (redeploy with the other source; this needs a reachable Organization Service and a service token
   for Auth in the demonstration environment): DEPLOYMENT, ALERT; revert: DEPLOYMENT, RECOVERED;
4. stop the database: ALERT with `database`, `migrations`, `hierarchy_authority`; restart: RECOVERED;
5. break the receiver: messages queued, heartbeat silence alert from the provider; restore: queued messages delivered in order;
6. stop the timer: heartbeat silence alert;
7. inspect every delivered payload against §6 for secrets.
The demonstration is recorded (dates, the image ID and index digest, payload samples with nothing secret) and independently reviewed. The G6 rehearsal VM is
a candidate host if it exists in time; the first Auth digest deployment may precede G6, and R3 must be met before it.

## 11. Implementation scope (as written 2026-10-10: PROPOSED; implemented locally since, §15)

- `infra/alerting/auth-readiness-alert.sh` (bash, no new dependency), `infra/alerting/auth-readiness-alert.service` and `.timer`.
- `scripts/deploy-tests/auth-readiness-alert.test.mjs` with the existing harness; a fake receiver and heartbeat (in the test or a small
  helper; `scripts/deploy-tests/lib/fake-docker-cli.mjs` may need `docker logs --since` and `inspect` formats).
- A new runbook `docs/runbooks/auth-readiness-alerting.md`: installation, credentials, acknowledgement, the reason guidance of §6, the
  F6 window, and carrier failure.
- Status updates: this record, the A5 design, the A5 record, the roadmap.
- Not changed: Auth code, libraries, images, existing workflows, the restore drill, the G6 plan. **Installing the carrier on the
  production host is a production mutation with its own authorization.**

## 12. Relationship to A12.10 (PROPOSED)

The carrier is a narrow, certified equivalent, not a monitoring platform. When A12.10 delivers a production stack with a certified
`/ready` probe, reason visibility and a receiver, the owner decides whether to retire the carrier or keep it as an independent backstop.
The payload tokens of §6 match the A12 metric and log vocabulary (`check`, the kit's reason codes), so alerts read the same in both.
Nothing here pre-empts A12.10's decisions D2 or D6a.

## 13. Production prerequisites (BLOCKED until each is done)

1. The owner rulings still open (§9's update note): the receiver and heartbeat providers, their accounts, created by the owner, and the
   demonstration environment.
2. The implementation (§11) under its own authorization, with the tests of §10 passing and an independent review.
3. The demonstration (§10) on a non-production host, recorded and independently reviewed, followed by an explicit **certification** of
   the carrier as R3's "separately certified equivalent": an owner or architecture-governance act, distinct from the independent review.
4. A separately authorized installation on the production host, with the credentials placed root-only by the owner.
5. Then, for the Auth deployment itself, the existing gates: the G6 plan and runbook refresh, the certified digest set and G6, live-state
   verification, and the deployment authorization (A5.4-A5 design §10).

## 14. What this record does not do

*As written 2026-10-10 (superseded for the local implementation by §15).* It implements, installs and configures nothing; it selects no provider and holds no credential; it changes no ADR, runbook, workflow,
image or alert rule; it authorizes no demonstration, installation, deployment or activation. The A3 findings (PR #287 item 5 NOT VERIFIED;
O1 timing unmet) and the R2 evidence limitations (the capability probe not yet validated inside a real image) are unchanged.

## 15. Implementation (2026-10-11): local, provider-neutral, not installed

*Recorded with the implementation; the sections above are the design it implements. The owner's development authorization (2026-10-11)
approved, for provider-neutral code only: O-R3-1 the host-local carrier; O-R3-2 and O-R3-3 provider-neutral receiver and heartbeat
interfaces (the providers, accounts, credentials and the demonstration environment stay OPEN); O-R3-4 no suppression and no
authorized-window bypass; O-R3-5 60 s probes, 60 min reminders, every `/ready` failure, code under `infra/alerting/`; O-R3-6 this record as
the implementation reference (no additional ADR).*

- **Code:** `infra/alerting/auth-readiness-alert.sh` (bash; `docker`, `curl`, `flock`, `timeout`, coreutils; no new dependency),
  `auth-readiness-alert.service` (oneshot, root without capabilities, read-only file system except `StateDirectory=`, credentials by
  `LoadCredential=`, `TimeoutStartSec=55`, hardened) and `auth-readiness-alert.timer` (every 60 s, `OnBootSec=60`).
- **Provider-neutral interfaces:** each of the receiver and the heartbeat is one curl config file (URL and credential) owned by the owner;
  the receiver gets the §6 JSON by `POST` (`--data-binary` from the queued file), the heartbeat a bare check-in with no payload; both
  HTTPS only (`--proto =https`, no redirects), `-q` (no `~/.curlrc`), bounded time. Credential files must be regular, owned by the
  carrier's user, mode `0600`/`0400`; their paths are un-exported, so no child process inherits them.
- **Resolved design findings:** L-1 (image ID versus index digest, §4 step 1, §6), L-2 (the complete durable state, the persisted log
  cursor, §4), L-3 (the heartbeat's reliability in its contract, §8).
- **Tests:** `scripts/deploy-tests/auth-readiness-alert.test.mjs` with the test-only stand-ins `scripts/deploy-tests/lib/fake-alert-tools.mjs`
  (`docker`, `curl`, `date`), part of `npm run test:deploy`; they prove the carrier's logic only, not a delivery to a real provider.
- **Guarantees and limits of the implementation:** the carrier never starts Docker (the unit orders itself after `docker.service` without
  requiring it, so a deliberately stopped daemon stays stopped and is reported `probe_failed:container`); delivery is **at-least-once**
  (a cycle killed after the receiver accepted a message but before its file is removed sends it again); a cycle is bounded by its own
  budgets (Docker calls at most 30 s in total, no new delivery after 35 s, 10 s per delivery, 7 s for the check-in) under the unit's 55 s
  limit; the log cursor advances only when the logs were read; nothing is carried forward once Auth is ready again; a reason is compared
  only with a registry line that follows it. `CARRIER_STARTED` announces an installation, a lost state or a reboot, not a timer restarted
  without a reboot.
- **Mutation checks (local):** alert on every probe; missing recovery; dropped pending delivery; a secret in the journal; a secret in the
  payload; the heartbeat not withheld; ready treated as a failure; carried diagnostics dropped, or kept across containers; the cursor not
  persisted; a reason accepted against a later registry line. Also: the carried reason kept after a ready result; the cursor advanced over an unread
  log window; stray queue files parsed; the unit requiring Docker; the config paths exported. Each of these is killed by a named test and
  restored byte-identically. **Not covered by a test or a mutant, correct by inspection only:** the ordering "state persisted before
  delivery" (a kill in the middle of a delivery is not simulated) and the delivery deadline and time budgets (never reached with the
  test stand-ins).
- **Not done (each separately authorized):** the provider selection and accounts; the demonstration of §10 on a non-production host; the
  owner's certification; the production installation. Until then R3 is **not** satisfied and the first and later Auth deployments
  containing the A5.4-A5 check stay gated.

## 16. Provider integration (2026-10-11): Pushover and Healthchecks.io, local only

*Recorded with the integration under the owner's development authorization of 2026-10-11. No account, credential, real message or real
ping was created or sent; nothing is installed. Contracts read on 2026-10-11 from the providers' official documentation:
<https://pushover.net/api> and <https://healthchecks.io/docs/http_api/> (also its rate-limit and management-API pages).*

- **Selection:** `RECEIVER_KIND=pushover`, `HEARTBEAT_KIND=healthchecks` in the unit. The provider-neutral curl-config interfaces of §15
  stay as `generic` (the script's default, used by the existing tests).
- **Credentials:** three root-only files passed by `LoadCredential=` (`pushover.token`, `pushover.user`, `healthchecks.url`), checked like
  §15's (regular, owned by the carrier's user, `0600`/`0400`) and by shape: the Pushover token and user key are 30 characters
  `[A-Za-z0-9]`; the ping URL must be `https://hc-ping.com/<uuid>` or `https://hc-ping.com/<22-character ping key>/<slug>`, with no
  suffix (`/start`, `/fail`, `/log`), query, user-info or other host (slugs: `a-z`, `0-9`, `-`, `_`). A refused value is never printed. The values are read with bash
  builtins and handed to curl on **stdin** (`--config -`), so they never appear in argv, any process environment, the journal, a payload
  or the state directory.
- **Pushover receiver (§8):** the endpoint `https://api.pushover.net/1/messages.json` is a constant. Each queued §6 message becomes an
  allow-listed `title` and `key=value` `message` (within the 250 and 1024 character limits), `priority` 1 for critical kinds and 0 for
  info; emergency priority (2) is never sent. **HTTP success is not acceptance:** a message is delivered only on HTTP 200 **and**
  `"status":1`. Pushover documents that a `4xx` will not succeed if repeated unchanged (and that repeated 4xx can block the client's IP),
  so `4xx` and `429` (quota) back off one hour; a 200 without `"status":1` or a redirect backs off 15 minutes; `5xx`, timeouts and
  connection failures retry next cycle (60 s, above Pushover's 5 s minimum). One request at a time (Pushover allows two concurrent).
  Every undelivered message stays queued in order, the cycle exits 3 and no heartbeat is sent (§4 and §15 unchanged: at-least-once).
  The provider's answer is written to a state-directory file, inspected, removed, and never logged; only the HTTP code reaches the journal.
- **Healthchecks.io heartbeat (§8):** a bare `GET` of the ping URL with no body, query or diagnostic content, only after a completed cycle
  with an empty queue, at most once per cycle (the service rate-limits above 5 pings per minute per check). **HTTP 200 is not proof:**
  the service answers 200 `OK (not found)` and 200 `OK (rate limited)` without recording the ping, so a check-in counts only on 200 with
  the body exactly `OK`; anything else exits 4. A stopped timer, a down host or a broken carrier sends nothing and the check's own
  period and grace raise the alert, through a Healthchecks.io channel independent of Pushover (runbook §7).
- **Transport (both):** HTTPS only (`--proto =https`), certificate verification on, no redirect followed (`--max-redirs 0`,
  `--proto-redir =https`), `-q` (no `~/.curlrc`), `--max-time` plus an outer `timeout -k`, within §15's budgets.
- **Proving the check's identity without exposing the URL:** the owner compares the Healthchecks.io dashboard, or a **read-only** API key
  (which hides `ping_url`), for `last_ping`/`n_pings`/`status`, with the carrier's `heartbeat=sent` journal lines. The read-only
  `unique_key` is not used: its derivation is not documented.
- **Tests (fake endpoints only, `scripts/deploy-tests/auth-readiness-alert.test.mjs`, "providers:"):** acceptance through the official
  endpoint with the secrets on stdin; all six kinds formatted within the limits and priorities; HTTP 200 with `"status":0`; 4xx; 429; a
  302; network failure, timeout and 5xx retried next cycle; the uncertain acknowledgement re-sent identically; a restart with pending
  alerts; Healthchecks.io `OK`, `OK (not found)`, `OK (rate limited)`, HTTP 500, 404 and timeout; the check-in withheld while Pushover fails
  and resumed after delivery; no check-in from a lock-skipped cycle; spoofed, plain-HTTP, `/fail`, `?create=1` and user-info URLs and
  malformed credentials refused unprinted; slug URLs (with `-` and `_`) accepted; an over-long stored back-off ignored; no secret in output, argv, environment, state, queue or a kept response.
- **Limits:** no real provider was contacted, so the providers' live behavior (TLS, answers, delivery to a device, Healthchecks.io's own
  notifications) is **not demonstrated**; that is the §10 demonstration. The back-off does not end early when a credential is fixed, and a stored back-off longer than one hour is ignored. A 4xx caused by one
  message's content (not the credentials) would hold that message, and every later one, at the head of the queue indefinitely; the
  content is allow-listed so this is not expected, and the silent heartbeat reports it.
  Healthchecks.io self-hosted instances are out of scope (only `hc-ping.com`).
- **Not done (each separately authorized):** the owner's accounts and credentials; the demonstration; the certification; the production
  installation. R3 remains **not** satisfied.
