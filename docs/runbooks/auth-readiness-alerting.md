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
afterwards.

**Credential permissions (metadata only; never print a credential, never `cat` a credential file or echo a URL).** systemd does not
hand the unit the files in `/etc/nawara-auth-readiness-alert/`: on every start it places **copies** in the unit's own credentials
directory (`/run/credentials/auth-readiness-alert.service/`, which exists only while a cycle runs), and the script's per-cycle check
(a regular file owned by its user, mode `0600`/`0400`) sees only those copies. **A passing check on the copies says nothing about the
originals**: a world-readable original would still be copied into a correctly protected copy. Check both, separately:

1. the originals, after installation and after any credential change:
   `find /etc/nawara-auth-readiness-alert -maxdepth 1 -printf '%u:%g %m %y %p\n'` (names and metadata only, hidden files included)
   must show the directory as `root:root 700 d` and each of `pushover.token`, `pushover.user`, `healthchecks.url` and `carrier.env` as
   `root:root 600 f` (or `400`); no symbolic link, no other file, no group or other access. Also confirm that no other
   copy of these values exists on the host (an editor's backup or swap file in that directory, a file in a home directory);
2. the copies supplied to the unit: every cycle's journal line shows that the script accepted them (a refusal names the credential and
   the problem, never its value, and exits 1); to inspect them directly, run `stat -c '%U:%G %a %F %n' /run/credentials/auth-readiness-alert.service/*` as
   root **while a cycle is running** (`systemctl start auth-readiness-alert.service` in another terminal): `root:root`, mode `400` or
   `600` (systemd's choice), regular files, only the three credential names. A cycle usually lasts a few seconds, so the command may
   need repeating; "No such file or directory" only means that no cycle was running;
3. the boundary: only root reads the originals (the unit runs as root; no other user or group is granted access), the copies are
   visible to the unit only for the length of a cycle, and nothing in the unit's `Environment=` holds a value (only the `%d/…` paths).

**Removal** (separately authorized): `systemctl disable --now auth-readiness-alert.timer`, then remove the units, the script, the
configuration directory and `/var/lib/nawara-auth-readiness-alert`. R3 is then no longer met for later Auth deployments.

## 6. Demonstration (required before any production deployment; separately authorized)

**Prerequisites** (nothing here authorizes them; each is part of the demonstration's own authorization):

- a **non-production host isolated from production**: not the production host, no production database, broker, network, credential or
  configuration reachable or copied onto it. Every failure below is injected **only** into the demonstration's own disposable resources;
- a **disposable PostgreSQL** for Auth (created for the demonstration, migrated by the image's own migration runner, destroyed afterwards),
  required: the freeze, the source mismatch and the database stop all act on it;
- **digest-pinned packaged images only**, pulled by digest from GHCR, never rebuilt, never a mutable tag:
  - the **A5.4-A5 image** (with the readiness check): `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:5877c6ad5a4a4ac4b7858efce794abf9ba65c5162dc9fc8f569fdef384ec35ed`
    (`sha-64ad8e3…`, the merge of #291);
  - the **pre-A5 image** (no readiness check; used only for the `DEPLOYMENT` step): `ghcr.io/nawara-solutions/nawara-core-auth-service@sha256:f6e1d165fe1a33f9420f2e4a4626d9a2da482a82c422e879e799a9e19c5d3a54`
    (`sha-fcf5806…`, the merge of #287, the last Auth build before A5.4-A5; no Auth migration differs between the two, so both run
    against the same disposable database);
- **Organization Service optional**: Auth's readiness check never calls it and Auth's start-up does not depend on it, so the
  source-mismatch step needs only `AUTH_HIERARCHY_SOURCE=organization-service` with `ORGANIZATION_SERVICE_URL` pointing nowhere (for
  example `http://127.0.0.1:1`, as the restore drill does) and a throwaway generated `ORGANIZATION_SERVICE_TOKEN` (at least 32
  characters, never a real token). A disposable Organization Service may be added but proves nothing more for R3;
- the **real Pushover and Healthchecks.io credentials**, created and placed by the owner (§5 step 3, §7) for a demonstration-only
  application and check, never printed or shared; `carrier.env` with a demonstration host label and a shortened `REMINDER_SECONDS`.

**Not this demonstration:** the R2 image-capability check (the restore drill's probe, run against the packaged image, that it reports
`capable` or `absent`; [core-backup-restore](core-backup-restore.md) §5 step 7) is a separate verification. Neither one is evidence
for the other.

**Steps** (the design's §10), with the events the carrier actually emits:

1. healthy start on the A5.4-A5 image: `CARRIER_STARTED` on the Pushover client, the Healthchecks.io check up (its identity confirmed as
   in §5 step 5); the credential checks of §5 (originals and copies);
2. `hierarchy-freeze` on the disposable database: `ALERT` (`marker_frozen`); a `REMINDER` after the shortened interval; unfreeze:
   `RECOVERED`;
3. recreate the Auth container **from the same A5.4-A5 image** with the other source (above): `ALERT` (`source_ahead_of_marker`), or
   `CHANGED` to it when a cycle observed the swap (the state was then already failing); recreate
   it again with `local`: `RECOVERED`. **No `DEPLOYMENT`:** the carrier sends `DEPLOYMENT` only when the container's image ID changes,
   never for a new container or a changed setting on the same image. The swap itself may add the messages of §2 (`shutting_down`, then
   `probe_failed:container`, as `ALERT` or `CHANGED` depending on the state before it, followed by `RECOVERED` when it ends ready);
   these are expected;
4. the `DEPLOYMENT` step: recreate the container from the **pre-A5 image** (above), with `local`: `DEPLOYMENT` carrying `previous_image` and
   `previous_revision` (the A5.4-A5 image's ID and its revision `64ad8e3…`; the index digest is a separate field); then back to the
   A5.4-A5 image: `DEPLOYMENT` again. With the marker `local` both answer ready, so apart from the swap's own messages (as in step 3)
   no `ALERT` is expected; the pre-A5 image cannot report
   `hierarchy_authority` at all, so it is never used for steps 2 and 3;
5. stop the disposable database: `ALERT` with `database`, `migrations`, `hierarchy_authority`; restart: `RECOVERED`;
6. break the receiver **by blocking the demonstration host's outbound access to `api.pushover.net`** (a connection failure is retried
   every cycle), **then** inject a failure on the disposable resources (for example `hierarchy-freeze`) so that there is a message to
   deliver: messages queued, the cycle exits 3, no check-in, Healthchecks.io alerts on the silence through its own channel; restore
   access: the queued messages delivered in order, then check-ins resume (unfreeze afterwards: `RECOVERED`). Do **not** use a wrong or
   revoked token: Pushover answers `4xx`, the carrier backs off for an hour (§4), and repeated `4xx` can get the host's IP blocked by
   Pushover;
7. stop the timer: Healthchecks.io alerts after the period and grace; start it again: check-ins resume, without `CARRIER_STARTED` (no
   reboot, the state kept);
8. inspect every delivered message, the journal and the host's process list for secrets; record the credential `stat` output (§5).

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
