# Auth readiness alerting (R3 alert carrier)

The operational alert carrier R3 requires before the first, and every later, production deployment of an Auth image containing the
A5.4-A5 readiness check ([ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4 item 10). Design:
[`core-v2-a5-r3-alert-carrier.md`](../architecture/core-v2-a5-r3-alert-carrier.md). Code: `infra/alerting/`.

> **Status.** Implemented and tested locally only. The owner selected the providers on 2026-10-11: **Pushover** receives the alerts and
> **Healthchecks.io** is the independent heartbeat (§7). **No account or credential exists, no real message or ping has been sent, and the
> carrier is installed nowhere.** R3 is **not** satisfied until: the owner creates the accounts (§7); the demonstration of §6 is run on a
> non-production host and independently reviewed; the owner explicitly certifies the carrier; and a separately authorized installation on
> the production host is done. Every step below that touches a host is a
> **separately authorized production action**; this runbook authorizes none of them.

## 1. What it does

Every 60 s, `auth-readiness-alert.timer` runs one cycle of `auth-readiness-alert.sh`:

1. reads the Auth container's identity (`docker inspect`: container id, running, image ID, revision label; `docker image inspect`: the
   registry index digest) and its `/ready` answer from inside the container (one `docker exec … node -e fetch`), with bounded timeouts;
2. reads Auth's own diagnostic lines since the previous cycle's probe start (every cycle while the container runs; the cursor advances
   only when the read succeeded), accepting only the allow-listed kit records (§3);
3. compares the result with its durable state and queues the messages it implies; delivers the queue, oldest first, to the receiver;
4. checks in with the heartbeat **only** when the queue is empty and the cycle completed.

**Every** `/ready` failure alerts (`hierarchy_authority`, `database`, `migrations`, `shutting_down`, any later check). **Nothing is
suppressed**, during G6/F6 windows included. The carrier is **read-only**: it never restarts, stops or reconfigures Auth, never changes
routing, the marker or any database, and never reads a database. `/auth/health` is not used and is not a substitute for `/ready`.

## 2. Messages

| Kind | Severity | When |
|---|---|---|
| `ALERT` | critical | ready (or unknown) → not ready, or → probe failed |
| `CHANGED` | critical | still failing, but the failing set, the reason or the probe-failure class changed |
| `REMINDER` | critical | the same failure persisted for `REMINDER_SECONDS` (3600) since the last message |
| `RECOVERED` | info | failing → ready (never on a transport failure: an unreachable Auth is a failure, not a recovery) |
| `DEPLOYMENT` | info | the container's image changed (any state); carries the previous image and revision |
| `CARRIER_STARTED` | info | the first cycle after installation, after a reboot (new boot id), or after a missing or invalid state file. A timer stopped and restarted without a reboot is not announced (the heartbeat silence reports the gap) |

A redeploy therefore produces, by design: `ALERT` (`shutting_down`), `CHANGED` (`probe_failed:container` during the swap), then
`DEPLOYMENT` and `RECOVERED`. These are expected and are not suppressed.

**Payload fields** (JSON, nothing else): `kind`, `severity`, `service`, `host`, `container`, `image` (the container's image ID),
`index_digest` (the registry index digest, the identity deploy records use, or `none`), `revision` (`unlabelled` for legacy images),
`state`, `failed`, and when `hierarchy_authority` fails `reason`, `source`, `marker`, `registry_code`; `probe_failure`; `previous`;
`previous_image`, `previous_revision` (DEPLOYMENT); `since`, `duration_s`, `created_at`, `runbook`.

## 3. Reading an alert

| `reason` | Meaning | Operator action |
|---|---|---|
| `marker_frozen` | the authority marker is `frozen` | production is a fresh environment: critical; stop any authority step; investigate |
| `source_ahead_of_marker` | Auth's source is `organization-service`, the marker `local` | expected **only** inside the attended F6 disagreement window; critical at any other time (it is also the signature of a restored pre-F6 database) |
| `marker_ahead_of_source` | the marker is `org_authoritative`, the source `local` | never expected; critical |
| `marker_missing`, `marker_invalid`, `marker_unreadable` | the marker cannot be trusted | critical; never treat as `local` |
| `unknown` | `hierarchy_authority` fails but no reason line has been recognized for this container | read the container's log; the alert stands |

The carrier never decides which case applies. The operator does, with the authority agreement check
([organization-production](organization-production.md) §6.2). Diagnostics are extracted only from top-level kit records
(`{"ts":…,"level":"warn","service":"auth-service","msg":…,"context":…}`) with the expected context, and every value must belong to its
allow-list; anything else is ignored and never echoed. A reason is carried forward per container (Auth logs it only when it changes).

## 4. Delivery, heartbeat and carrier failure

- An undelivered message stays in the queue (`/var/lib/nawara-auth-readiness-alert/queue`) and is retried each cycle, oldest first; the
  cycle exits 3 and **no heartbeat is sent** while anything is queued. Delivery is **at-least-once**: a cycle interrupted after the
  receiver accepted a message can send it again, so a duplicate with the same `created_at` is not a new incident. A receiver that keeps
  refusing one message blocks the queue behind it; the heartbeat silence reports that.
- A heartbeat that cannot be sent makes the cycle exit 4. With Healthchecks.io, an HTTP 200 whose body is not exactly `OK` (`OK (not
  found)`, `OK (rate limited)`) was **not** recorded and counts as a failure.
- Pushover accepts a message only with HTTP 200 and `"status":1`. A `4xx` (bad token or user key: "repeating your same request will not
  work") or a `429` (monthly quota exhausted) makes the carrier back off for one hour, and a `200` without `"status":1` or a redirect for
  15 minutes (`receiver-backoff` in the state directory), instead of repeating the request every minute; a `5xx`, a timeout or a
  connection failure is retried on the next cycle. In every case the messages stay queued and the heartbeat stays silent, so
  Healthchecks.io reports the outage independently. Fixing the credential does not end the back-off early: wait, or (authorized
  operator action) delete `receiver-backoff`.
- A carrier that cannot run at all (credentials refused, state not writable, the script failing) never checks in.
- The external heartbeat service alerts on missed check-ins, through a channel independent of the receiver: this is what reports a
  stopped timer, a down host, a broken carrier or a broken receiver. Its own reliability is a provider requirement (design §8).
- `journalctl -u auth-readiness-alert.service` shows one line per cycle: state, failing checks, reason, queued, delivered, pending and
  heartbeat result. It never shows a payload value beyond those tokens, a URL or a credential.

## 5. Installation (separately authorized; not authorized by this runbook)

Prerequisites: the owner's receiver and heartbeat meet the design's §8 contracts; the demonstration (§6) passed and was reviewed; the
owner certified the carrier; the installation is authorized.

1. Read-only checks on the host: `docker info --format '{{.LoggingDriver}}'` and the daemon's log rotation (the carrier reads
   `docker logs`; the deploy sets no `--log-driver`/`--log-opt`); `systemctl --version`; `curl --version`; whether `docker.socket` is
   enabled (see "Docker maintenance" below).
2. Install the script root-owned, mode `0755`, at `/usr/local/libexec/nawara/auth-readiness-alert.sh`, and the two units in
   `/etc/systemd/system/`.
3. Create `/etc/nawara-auth-readiness-alert/` (root, `0700`) with:
   - `pushover.token` (root, `0600`): the Pushover **application** API token (30 characters `[A-Za-z0-9]`), one line, written by the owner.
   - `pushover.user` (root, `0600`): the owner's Pushover user (or group) key, one line.
   - `healthchecks.url` (root, `0600`): the check's ping URL, one line: `https://hc-ping.com/<uuid>` or
     `https://hc-ping.com/<ping-key>/<slug>`, with no `/start`, `/fail`, `/log` suffix and no `?create=1`. The URL **is** the credential.
   - `carrier.env` (root, `0600`): `ALERT_HOST_LABEL=<a short, non-secret label>`.
   Write each file without echoing its value to a terminal log or the shell history (for example with an editor). systemd passes the three
   credential files to the unit only (`LoadCredential=`); the script refuses a credential file that is not a regular file owned by its
   user with mode `0600`/`0400`, and refuses a value of the wrong shape or a heartbeat URL on any other host, without printing it.
   (The generic `RECEIVER_KIND=generic`/`HEARTBEAT_KIND=generic` curl-config interface is kept for tests and a future provider change only.) Credentials never reach argv, the environment of a child process, the journal
   or a payload; `set -x` must never be added.
4. `systemd-analyze verify /etc/systemd/system/auth-readiness-alert.{service,timer}`; `systemctl daemon-reload`;
   `systemctl enable --now auth-readiness-alert.timer`.
5. Expect `CARRIER_STARTED` at the receiver and check-ins at the heartbeat within two minutes. Confirm the check's identity without
   the URL ever leaving the host: the Healthchecks.io dashboard (or a **read-only** API key, which hides `ping_url`) shows the check's
   `last_ping` and `n_pings` advancing in step with the carrier's `heartbeat=sent` journal lines.

**Trust boundary.** The carrier uses the Docker socket, which is root-equivalent on the host. It runs as root without capabilities,
with a read-only file system except its state directory, and runs only `docker inspect`, `docker image inspect`, `docker logs` and one
`docker exec` reading `/ready`.

**Docker maintenance.** The carrier never starts Docker: its unit is ordered after `docker.service` and does not require it, so a
stopped daemon is reported as `probe_failed:container`. If `docker.socket` is enabled on the host, however, **any** Docker client call
socket-activates the daemon, the carrier's included. Before maintenance that needs Docker to stay stopped, stop the timer first
(`systemctl stop auth-readiness-alert.timer`; the heartbeat provider will report the silence, which is expected) and start it again
afterwards. After installation, also confirm with `stat` that the three files systemd places in the unit's credentials directory are
owned by root with mode `0400` or `0600`; the script refuses anything else on every cycle.

**Removal** (separately authorized): `systemctl disable --now auth-readiness-alert.timer`, then remove the units, the script, the
configuration directory and `/var/lib/nawara-auth-readiness-alert`. R3 is then no longer met for later Auth deployments.

## 6. Demonstration (required before any production deployment; separately authorized)

On a **non-production** host, with a real labelled `main` Auth image containing A5.4-A5, a disposable database, the real receiver and the
real heartbeat (the design's §10):

1. healthy start: `CARRIER_STARTED` on the Pushover client, the Healthchecks.io check up (its identity confirmed as in §5 step 5);
2. `hierarchy-freeze` on the disposable database: `ALERT` (`marker_frozen`); a reminder (shortened interval); unfreeze: `RECOVERED`;
3. redeploy with the other source (needs a reachable Organization Service and a service token): `DEPLOYMENT`, `ALERT`
   (`source_ahead_of_marker`); revert: `DEPLOYMENT`, `RECOVERED`;
4. stop the database: `ALERT` with `database`, `migrations`, `hierarchy_authority`; restart: `RECOVERED`;
5. break the receiver (for example a revoked or wrong token): messages queued, the back-off logged, Healthchecks.io alerts on silence
   through its own channel; restore: queued messages delivered in order;
6. stop the timer: the heartbeat provider alerts on silence;
7. inspect every delivered payload for secrets.

Record the dates, the image digest and payload samples (nothing secret), and have the record independently reviewed. The local tests
(`scripts/deploy-tests/auth-readiness-alert.test.mjs`) prove the carrier's logic only: they do **not** demonstrate delivery to a real
receiver or an independent failure notification.

## 7. Providers (owner-created accounts; none exists yet)

**Pushover** ([API](https://pushover.net/api)). The owner creates an application for this carrier (its token is revocable on its own) and
installs the Pushover client on the devices that must receive alerts. The carrier POSTs to the fixed endpoint
`https://api.pushover.net/1/messages.json` (never configurable): `token`, `user`, `title` (`Nawara Auth readiness: <KIND> (<state>)`),
`message` (the allow-listed `key=value` lines of §2, at most 1000 characters) and `priority`: `1` (high) for ALERT, CHANGED and REMINDER,
`0` for the others. **Emergency priority (`2`) is never used**; it would need its own review. One message per alert; the free monthly
quota (10 000 per application) is far above the carrier's volume, and an exhausted quota (`429`) backs off as in §4.

**Healthchecks.io** ([pinging API](https://healthchecks.io/docs/http_api/)). The owner creates **one** check for this host: period
1 minute; grace **5 minutes** recommended (a redeploy, a slow Docker call or a one-off provider error must not page; three or more missed
cycles do); its notifications go to a channel that does **not** depend on Pushover or on the production host (for example e-mail), so a
broken receiver is still reported. The carrier sends a bare `GET` to the ping URL (no body, no query, no header beyond curl's defaults),
at most once per 60 s cycle (the service rate-limits above 5 pings per minute per check). It never uses `/start`, `/fail`, `/log`,
`?create=1` or the management API. A stopped timer, a down host or a carrier that cannot run sends nothing, and Healthchecks.io alerts after
the period and grace.
