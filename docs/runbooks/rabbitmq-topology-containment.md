# Notification topology monitor and emergency containment (OD-BRK-2b-1)

> **Status.** Implemented and certified on disposable infrastructure only (OD-BRK-2b-1). **Nothing is installed, enabled or started
> anywhere.** Installing it on the production host, enabling its timers, creating the trigger key, its sudoers rule and any dispatching
> workflow are the separately authorized **OD-BRK-2b-2**. Merging this changes no production system: no workflow references these files
> (`npm run check:repo` refuses one that does).

ADR-0057 §8 "OD-BRK-0" D2 requires the **effective** broker configuration of Notification to be verified, and Notification kept from
consuming when it is unsafe. OD-BRK-2a provides the verifier (`infra/rabbitmq/verify-topology.sh`), the latch contract, and the
first-activation gate in `infra/rabbitmq/provision.sh`. This control keeps verifying after activation and contains on failure.

## 1. What runs, and when

| Unit | Runs | Does |
|---|---|---|
| `nawara-core-topology-monitor.timer` → `.service` | every 5 minutes (server-side; never GitHub Actions) | `verify-and-contain.sh notification-service`: one serialized run |
| `nawara-core-topology-watchdog.timer` → `.service` | every 5 minutes, on its own timer, offset | `topology-watchdog.sh`: checks that the monitor runs (§4) |
| `topology-trigger.sh` (forced command) | on demand, after an authorized topology change | starts the monitor unit once (§3) |

Files (all root-owned, from `infra/rabbitmq/topology-monitor/`):

| Path | Mode | Content |
|---|---|---|
| `/usr/local/libexec/nawara-core-topology/` | 0755 | the six scripts (0555) and the pinned `verify-topology.sh` (0444) |
| `/var/lib/nawara-core-topology-install/` | 0700 | `incoming/`, the signed `installed/` record, `history.jsonl`, an open `transaction/` (OD-BRK-2b-I) |
| `/etc/nawara-core-topology/install-allowed-signers` | 0644 | the Owner's installation key (separate from the recovery key) |
| `/var/lib/nawara-core-topology-monitor/` | 0700 | `installed`, `state` (v2: with the incident), `lock`, `evidence.jsonl`, `alerts.jsonl`, `incidents.jsonl`, `recovery-consumed`, `watchdog`, `watchdog.jsonl`, the `recovery/` inbox (0700) |
| `/var/lib/nawara-core-topology/notification-service.containment` | 0644 (dir 0755) | the OD-BRK-2a latch, read by provisioning |
| `/var/lib/nawara-core-topology/notification-service.incident` | 0644 | the current incident, bound next to the latch (OD-BRK-2b-R) |
| `/etc/nawara-core-topology/recovery-allowed-signers` | 0644 (dir 0755) | the Owner's public key: installed by a separate key-lifecycle operation (§5) |
| `/etc/systemd/system/nawara-core-topology-{monitor,watchdog}.{service,timer}` | 0644 | the units |

The monitor runs as root because it administers the broker through `docker exec … rabbitmqctl` (the same protected broker-local path as
provisioning; Docker access is root-equivalent, and the Erlang cookie never leaves the broker container). Notification has no access to
any of these files. Every script pins its locations, its target and the verifier's SHA-256; `check:repo` keeps the pins equal to the
repository (`checkTopologyMonitor`).

### The state machine

| Verifier result | Action |
|---|---|
| PASS | reset the consecutive UNKNOWN counter; **never** clear the latch |
| FAIL | immediate containment (FAIL always wins over UNKNOWN) |
| UNKNOWN #1 | record, alert (warning) |
| UNKNOWN #2 | record, escalate (critical) |
| UNKNOWN #3 | containment |

The verifier runs pre-grant while Notification holds no grant and post-grant once it does. An invalid, inconsistent or missing verifier
answer, or a broker that cannot be listed, is UNKNOWN, never PASS. The counter is durable and the run serialized (`flock`); state writes
are atomic (temporary file, `sync`, rename). **The state is initialized only by the installer**: after installation, a state that is
missing, corrupt, a symbolic link or weakly permissioned is set aside (`state.rejected`) and Notification is contained. A missing state
directory means "not installed" (exit 78, nothing done).

### Containment

1. Persist the intent: the state (`contained=1`), then the latch `state=contained`, **before** any broker change.
2. Clear Notification's resource and topic permissions in every vhost that lists them.
3. `close_all_user_connections notification-service`: unacknowledged deliveries return to their queues (certified on RabbitMQ 3.13.7).
   Nothing is purged, deleted or re-created.
4. Two read-backs, 5 s apart, must both show no grant, no topic grant, no connection of the service and the latch contained.

Only then is the result **CONTAINED** (exit 20). Otherwise, after at most 3 bounded attempts, **CONTAINMENT_UNCONFIRMED** (exit 21; the
unit fails, a critical alert is queued every run, and the next run retries). A command's exit status is never taken as proof. While
contained, each run re-applies and re-confirms the containment and consults no verification: a PASS restores nothing.

## 2. Installation, upgrade, rollback and repair (OD-BRK-2b-I; executing any of it is OD-BRK-2b-2, not authorized here)

### Trust model

The authority for what may be installed is an **Owner-signed manifest**, never the server's checkout. A hash alone does not prove who
approved anything; the signature does.

- **The manifest** is generated **off the server**, on a trusted machine at the approved commit, from that commit's Git objects:
  `node scripts/topology-monitor-manifest.mjs --commit <40-hex commit> --version <n>`. It lists exactly, in a fixed order:
  - the schema `v1`;
  - `core_commit`;
  - a monotonic package `version`;
  - the `state_schema`, which is the contract version (2: incident-bound state);
  - the SHA-256 of all 11 artifacts.

  It holds no secret.
- **Signing:** the Owner reviews the manifest and signs it off the server:
  `ssh-keygen -Y sign -f <owner key> -n nawara-core-topology-install manifest`.
- **The installation trust anchor:** `/etc/nawara-core-topology/install-allowed-signers` (root 0644, directory 0755), exactly one line,
  `nawara-core-owner namespaces="nawara-core-topology-install" <ssh-ed25519 key>`. The Owner installs it at the console from an
  authenticated channel, and compares its fingerprint off the server. It is separate from the recovery key (§5): a recovery signature
  can never install anything, and an installation signature can never recover.
- **The checkout is only a source of bytes.** Every artifact must equal its signed hash. Each is copied into a private staging area
  first, and nothing is read from the checkout after that.
- **The installer's own integrity:** before running the installer, the Owner checks with system tools that the installer itself is the
  approved one:
  1. `ssh-keygen -Y verify -f /etc/nawara-core-topology/install-allowed-signers -I nawara-core-owner -n nawara-core-topology-install -s manifest.sig < manifest`;
  2. `sha256sum` of `install-topology-monitor.sh` against its `file=` line.

### Commands

As root at the console, with the signed `manifest` and `manifest.sig` placed root-owned (0600) in
`/var/lib/nawara-core-topology-install/incoming/` (0700):

| Command | Does |
|---|---|
| `install-topology-monitor.sh install` | **fresh only**; see below |
| `install-topology-monitor.sh upgrade` | an approved upgrade or rollback; see below |
| `install-topology-monitor.sh repair` | completes an interrupted transaction (below) |
| `install-topology-monitor.sh status` | read-only |

**`install`** refuses when any target, an installation record or a transaction already exists. It never overwrites a state, a latch, an
incident binding or a unit. It installs:
- the 7 files in `/usr/local/libexec/nawara-core-topology` (the six scripts 0555, the pinned OD-BRK-2a verifier 0444);
- the 4 units (0644, **not** enabled, started or reloaded);
- the **initial** state, the inactive latch and an empty incident binding.

**`upgrade`**:
- requires the current installation to verify against its own signed record;
- requires a strictly **higher** version and the same state schema;
- takes the monitor's lock, so no monitor, watchdog or recovery run happens in between;
- replaces **only** the immutable artifacts.

The state, the current incident, the nonce ledger (`recovery-consumed`), the incident history, the evidence, the latch and both trust
keys are never touched. A **rollback** is a newly signed manifest with a higher version that names the older artifacts. There is no
unsigned "go back", and no copy of an older state or nonce ledger is ever restored. A state schema change is never done by an upgrade:
it needs a separate, explicit, versioned migration procedure.

**Every change is one durable transaction** (`/var/lib/nawara-core-topology-install/transaction`). The marker moves through
`staged` → `applying` → `applied` → `verified` → recorded (`installed/manifest`, `installed/manifest.sig`, `history.jsonl`), and
only then is it removed. The locks are always taken in this order: the installation lock, then the monitor's lock.

If an installation step is interrupted at any point:
- the open transaction makes `verify-topology-monitor-install.sh` FAIL (`incomplete_transaction`);
- an ordinary `install` or `upgrade` refuses (exit 70).

`repair` completes the recorded transaction from its staged copies, after re-verifying the recorded manifest's signature. It creates
only what is missing, and never deletes or replaces protected state. Deleting the installation is never a recovery.

### Verification and enablement

`verify-topology-monitor-install.sh` (read-only) authenticates the installed record with the installation key. It checks:
- every artifact (hash, owner, exact mode, one link, no symbolic link, nothing extra) and every ancestor directory;
- the units' hardening, and that no drop-in or same-named unit exists in any systemd unit directory;
- the protected state;
- the recovery key, if present;
- the optional trigger, if configured: its exact sudoers rule, no other rule reaching its user, sshd's effective settings, and the
  restricted forced-command key, which must not be the scheduled-backup key;
- the external alert carrier (§7): its unit's isolation (no capability, the broker's and the Auth carrier's paths inaccessible, no
  environment, exactly its four systemd credentials) and, if configured, its root-only credential files (form checked, never printed),
  two distinct heartbeat checks and its state directory.

Results:

| Exit | Result |
|---|---|
| 0 | PASS |
| 1 | FAIL |
| 3 | UNKNOWN (never PASS) |

**STOP** on anything but PASS.

Enabling the timers is a separately authorized step. The verifier FAILs any enabled timer unless
`/var/lib/nawara-core-topology-install/activation` (root 0600) and its signature authorize it. That file holds
`nawara-core-topology-monitor-activation v1`, `core_commit=`, `version=` (the installed ones) and
`timers=nawara-core-topology-monitor.timer,nawara-core-topology-watchdog.timer` (optionally followed by
`,nawara-core-topology-alert.timer`), signed by the Owner in the installation namespace. Every enabled timer must be in that list.

**Contract v2 (OD-BRK-2b-A).** The manifest header is `nawara-core-topology-monitor-manifest v2`. It lists 14 artifacts: the carrier
`topology-alert-carrier.sh` and its two units are added. The carrier's credentials are never artifacts and the installer never writes
them. The installer refuses to `upgrade` an installation recorded under the OD-BRK-2b-I v1 contract (`installed_contract`). No such
installation exists in production, because OD-BRK-2b-2 has not run. A lab installation is removed and installed fresh. Any later
production upgrade that changes the contract again needs its own Owner-signed manifest and a separately authorized installation.

## 3. The trigger (OD-BRK-2b-2; not authorized here)

An **additional** verification after an authorized change (for example after protected provisioning). The dedicated key's line
(`topology-trigger.authorized_keys.template`) is `restrict,command=` in the runtime user's `authorized_keys`; the entry refuses any
client command or argument (64) and running as root (65), and runs exactly
`sudo -n /usr/bin/systemctl start nawara-core-topology-monitor.service`, allowed by the one sudoers rule of
`topology-trigger.sudoers.template` (`visudo -cf` before installing). The key is never the deploy or scheduled-backup key. A workflow
that dispatches it needs the protected `production` environment and its own authorization.

## 4. The watchdog

A check inside the monitor cannot notice that the monitor stopped. The watchdog, on its own timer, reports `monitor_overdue` (no
completed run for 15 minutes), `monitor_stalled` (a run holding the lock beyond 5 minutes), `monitor_killed` (a run marker with no run
holding the lock), `state_invalid`, `timer_inactive`, `service_failed` and `not_installed`. It records every check, alerts on a change
of status (and hourly while a problem lasts), and writes its own check-in, which the monitor reads in turn (`watchdog_quiet`).

Response policy: evidence and alerts only. It never contains, grants or restarts. **Limits:** it shares the host and systemd with the
monitor, so a dead host or a stopped systemd silences both. Covering that needs an **external heartbeat** (a dead-man's switch, as the
A5-R3 carrier uses for Auth): a pending dependency. Whether a silent monitor should cause autonomous containment is an Owner decision.

## 5. Recovery (Owner-signed, incident-bound, single use; never automatic)

**OD-BRK-2b-R.** Recovery needs **proof** of the Owner's approval, not a reference: an OpenSSH signature (`ssh-keygen -Y sign`) by the
Owner's key over a canonical authorization that names the current incident. The host holds only the public key, so the approval can be
checked independently by anyone with that key. A reference alone (the `reason` field) proves nothing.

### Incidents

A new containment creates an incident id: 128 bits from `/dev/urandom`, never one already recorded in `incidents.jsonl`. It is written
to the state (`incident=`) before anything else, and bound next to the latch
(`/var/lib/nawara-core-topology/notification-service.incident`), then the latch and the broker change follow. Every later run and every
retry keeps the same id. A binding altered by hand is put back from the state (and alerted). Only a signed recovery ends an incident. A
later containment always gets a **new** id, so no authorization ever applies to two incidents. A legacy (v1, OD-BRK-2b-1) contained state
has no incident: the monitor gives it a fresh one and keeps it contained. Nothing earlier is ever taken as approved.

### The authorization

The canonical text, exactly these nine lines in this order, LF line ends and one final LF, at most 1024 bytes:

```
nawara-core-topology-recovery-authorization v1
operation=notification.topology_recovery
service=notification-service
vhost=nawara-core
incident=<the current incident: 32 lowercase hex>
nonce=<32 lowercase hex, fresh for every authorization>
issued_at=<unix seconds>
not_after=<unix seconds, at most 3600 after issued_at>
reason=<an operational reference, [A-Za-z0-9][A-Za-z0-9._-]{0,63}>
```

It is signed **off the host** by the Owner:
`ssh-keygen -Y sign -f <owner key> -n nawara-core-topology-recovery authorization`.

The Owner (or an operator acting on the Owner's signed file) places both files root-owned (0600) in
`/var/lib/nawara-core-topology-monitor/recovery/` (`authorization` and `authorization.sig`). Then they run
`recover-notification-topology.sh`, as root. It takes no argument.

### What the guard verifies (every failure leaves the containment in place; no fallback)

1. Under the monitor's own lock:
   - the installation and the verifier pin are intact;
   - the v2 state says contained, with an incident;
   - the latch is contained, and its incident binding equals the state's;
   - the containment holds: two read-backs show no grant, no topic grant and no connection.
2. The trusted key is exactly one line, `nawara-core-owner namespaces="nawara-core-topology-recovery" <ssh-ed25519 key>`, root-owned, not
   writable by group or others, and no symbolic link. A wildcard or another principal, another namespace, an option or a second key is
   refused. `ssh-keygen -Y verify` itself accepts a wildcard principal, so the guard checks the file's structure first.
3. Private, root-owned copies of both files are checked, so there is no substitution after the check:
   - the text is exactly canonical: a duplicate, unknown, reordered or re-encoded field, CRLF, a trailing space, a NUL byte, or a missing
     final newline is refused;
   - an unsupported version is refused;
   - the signature is one armored OpenSSH signature;
   - `ssh-keygen -Y verify -f <trusted key> -I nawara-core-owner -n nawara-core-topology-recovery` answers `Good`.
4. Its binding:
   - this operation, service and vhost;
   - the **current** incident;
   - `issued_at` no later than 120 s from now, not expired, and a validity window of at most 3600 s;
   - a nonce never consumed.
5. A fresh verification (the OD-BRK-2a verifier, pre-grant) whose only non-passing check is L1 `latch_contained`.

### Single use and crash safety

The nonce is appended to `recovery-consumed` and flushed **before** anything changes. A consumed nonce is refused for ever.

The guard then:
1. records the decision;
2. clears the state, then the latch, then the binding;
3. verifies again;
4. on any doubt, contains the **same** incident again. The authorization stays consumed: a new one is needed.

What a crash leaves:

| Crash point | What it leaves |
|---|---|
| Before the consumption | Nothing changed. The same authorization can be used. |
| After the consumption | Still contained. The authorization can never be reused, so a new one is needed. |
| Between clearing the state and the latch | A contained latch. The next monitor run contains again as a **new** incident. |

Two simultaneous recoveries are serialized by the lock: exactly one succeeds.

The guard **never grants**. Notification is granted again only by protected provisioning, whose pre-grant and post-grant gates run
again. No replay, no queue deletion and no data change happen. Restarting a container, a PASS or an ordinary provisioning run never
recovers: provisioning refuses while the latch is contained.

### Signing-key lifecycle (each step a separately authorized operation; none is performed by this repository)

- **The private key** stays with the Owner, off the host: on a hardware token (`sk-ssh-ed25519@openssh.com`, preferred) or an encrypted
  key on an Owner device. It is **never** placed in Git, CI, an image, the production host or any configuration. The test keys of the
  certification are disposable and exist only in a test run's own directory.
- **Installing the public key:** `/etc/nawara-core-topology/recovery-allowed-signers` (root:root 0644, directory 0755), exactly one line
  as above. It is installed at the console. Its SHA-256 fingerprint (printed by `verify-topology-monitor-install.sh`) is compared off
  the host with the Owner's key.
- **Rotation:** sign nothing with the old key; replace the one line under a separate authorization, then verify the new fingerprint.
  Authorizations by the old key stop verifying at once.
- **Revocation or compromise:** remove the line (recovery is then impossible) or replace it with a new key. A compromised key also needs
  the incident review, because every authorization it signed is bound to one incident, expires within an hour, and is single use.
- **Lost key:** recovery is impossible until a new public key is installed by a separately authorized key-lifecycle operation. There is
  no fallback.
- **Expired authorizations** are refused. Sign a new one with a fresh nonce.
- **Pinning and substitution:** the guard's paths, principal and namespace are pinned, and checked by `check:repo`. The trusted key, the
  inbox and its files must be regular, root-owned, not group- or other-writable, and no symbolic links.

## 6. Evidence and alerts

`evidence.jsonl` (one line per run), `alerts.jsonl` and `watchdog.jsonl`, each bounded to 2000 lines, and a summary line in the journal.
Fields: version, timestamps, mode, phase, result, reason code, verifier check ids, UNKNOWN counter, containment outcome, attempts and the
watchdog's status. Never a message, a code, a credential, an HMAC key, the Erlang cookie, a policy definition or a broker address.

`alerts.jsonl` is a local spool. The external carrier (§7) reads it on its own timer. Containment never depends on an alert being
written or delivered.

## 7. External alerts and independent heartbeats (OD-BRK-2b-A; installing or enabling any of it is OD-BRK-2b-2, not authorized here)

### Architecture

`topology-alert-carrier.sh` runs one cycle every 60 s, from `nawara-core-topology-alert.service` and its own timer. It is a separate
instance of the A5-R3 carrier pattern (`infra/alerting/auth-readiness-alert.sh`). It uses the same providers: Pushover for alerts and
Healthchecks.io for heartbeats. It shares A5-R3's handling of credentials (protected files, passed to curl only through `--config -`),
its fixed HTTPS endpoints with certificate verification and no redirects, and its acceptance rules. It has its own unit, state
directory (`/var/lib/nawara-core-topology-alert`), queue, cursor, ledger and credentials. It never reads or writes the Auth carrier's
state, and both of that carrier's directories are inaccessible to its unit.

The producers write only local lines and never wait for the carrier:
- the monitor (`containment_started` is written before the broker changes, then `verification_fail`, `contained`, and so on);
- the watchdog;
- the signed recovery (`recovery_authorized`, `recovery_refused`, `recovery_reverted`, `recovered`).

None of them calls the network or the carrier (`npm run check:repo` enforces this).

The carrier only reads `alerts.jsonl`, `evidence.jsonl` and `watchdog`. It takes no producer lock, writes nothing outside its own
directory, holds no broker credential and never runs docker, rabbitmqctl or systemctl. Its unit makes the Docker and containerd sockets,
the Docker data, `/opt/nawara-core` and the recovery inbox inaccessible.

### Event contract

Each event is one canonical record. Every field is a closed code, a number or an id:
- `v`, `id` (32 hex: the SHA-256 of the source line, or deterministic for the carrier's own events);
- `code`, `severity`, `component` (`monitor | watchdog | recovery | carrier`);
- `at`, `at_epoch`, `incident` (`none` or 32 hex), `reason`, `problems`;
- `count`, `last_epoch`, `queued_epoch`.

The carrier's table sets the severity, never the line. Producer kinds keep their names and map to codes:

| Code | From | Severity |
|---|---|---|
| `topology_verification_fail` | monitor `verification_fail` | critical |
| `topology_verification_unknown` / `topology_unknown_escalated` / `topology_unknown_cleared` | monitor `unknown_first` / `unknown_escalated` / `unknown_cleared` | warning / critical / info |
| `containment_started` / `containment_confirmed` / `containment_unconfirmed` | monitor `containment_started` / `contained` / `containment_unconfirmed` | critical |
| `containment_latch_restored` / `containment_incident_rebound` | monitor | critical |
| `watchdog_quiet` | monitor | warning |
| `monitor_overdue` / `monitor_stalled` / `monitor_killed` / `monitor_timer_inactive` / `monitor_service_failed` / `watchdog_state_invalid` / `watchdog_not_installed` | watchdog | critical |
| `watchdog_ok` / `watchdog_contained` | watchdog | info |
| `recovery_authorized` / `recovery_refused` / `recovery_reverted` | recovery | critical |
| `recovery_completed` | recovery `recovered` | warning |
| `installation_integrity_failed` / `installation_integrity_restored` | carrier: the installed artifacts checked against the signed installed manifest (alerting only) | critical / info |
| `heartbeat_delivery_failed` | carrier | warning |
| `spool_event_rejected` (`malformed`, `oversized`, `unrecognized`), `spool_gap`, `spool_unreadable`, `spool_cursor_invalid` | carrier | critical |
| `carrier_started` | carrier | info |

A line that is longer than 1024 bytes, does not match the producers' exact schema, carries any extra field, or names an unknown kind
never reaches a provider. It becomes a fixed `spool_event_rejected` alert. The following never reach the queue, the journal or a
provider:
- message bodies, authentication or recovery codes, nonces, signers, signed payloads, keys, the Erlang cookie, broker addresses or
  credentials;
- exception text or free-form metadata.

### Delivery

- **Order and priority.** Critical events go first. A message carries up to 8 events and a cycle sends up to 3 messages. Pushover
  priority is 1 when any event is critical; emergency priority (2) is never used.
- **Acceptance.** An event counts as delivered only on HTTP 200 with `"status":1`. `deliveries.jsonl` records `submitted` before each
  request and `accepted` (with Pushover's receipt id) after.
- **Retries.**
  - A timeout, a connection failure or a 5xx backs off 60, 120, 240, 480, then at most 900 s.
  - A 4xx or 429 is recorded as `rejected` and backs off 3600 s.
  - A 200 without `"status":1`, or a redirect, backs off 900 s.
  - Nothing is dropped while undelivered.
- **Deduplication and coalescing.**
  - A bounded ledger of 4000 ids keeps a replayed or rewritten spool line from being delivered twice.
  - A pending event with the same code, incident, reason and problems absorbs repeats as a count (for example `x50`).
  - The carrier's lasting conditions are reported at most once an hour.
- **At-least-once.** A cycle killed after the provider accepted a message, but before its queue files were removed, sends it again.
  Exactly-once is not claimed.
- **Crash safety.** The queue, the ledger, the cursor and the state are written atomically and flushed before anything is sent. A
  partial spool line waits for the next cycle.
- **Cursor and state.**
  - A missing, corrupt or symbolically linked cursor or state is set aside and raises a critical `spool_cursor_invalid` alert. The
    carrier then replays the last 24 h through the ledger.
  - A cursor line that the producer's 2000-line bound has dropped raises `spool_gap`, meaning possible loss.
- **Saturation.** The queue holds at most 256 files. Beyond that, events are counted by severity and the next message carries an
  `OVERFLOW` line. The spool on the host keeps the lines. A critical event that waits more than 600 s, or any critical overflow, also
  escalates through the other provider (next section). This is fail-visible and never loops back into the broken carrier.

### Heartbeats (two independent checks)

The carrier pings Healthchecks.io's `/<exit-status>` endpoint. Status 0 is a success; any other status is a failure that Healthchecks.io
alerts on. Each check is pinged only for a **new completed run** of its own component, read from:
- the monitor's last `evidence.jsonl` line, written at the very end of a run;
- the watchdog's `watchdog` check-in.

A run is pinged only if it completed within 360 s (`HB_FRESH`), and only once. The carrier never invents a run that did not happen.
After an outage, the latest run is pinged only if it is still fresh; older runs are not pinged, because that would hide the gap.

| Component | Exit status pinged |
|---|---|
| monitor | 0 PASS · 10 UNKNOWN · 20 contained · 21 containment unconfirmed · 1 anything else · 75 PASS while critical alerts cannot reach the Owner |
| watchdog | 0 its run found no problem (or only containment) · 1 it found a problem |

What each situation looks like from outside:
- **A local UNKNOWN:** a failure ping (10), plus a Pushover alert.
- **A missed monitor run:** no ping. The monitor check goes down after its grace period. The watchdog reports `monitor_overdue`, and
  `heartbeats.jsonl` records `missed` locally after 900 s.
- **A dead watchdog timer:** the watchdog check goes down on its own; the monitor's check is unaffected.
- **A network outage:** a failed ping is recorded locally (`failed`, with the HTTP status) and retried while the run is fresh.
  `heartbeat_delivery_failed` goes out through Pushover at most once an hour.
- **A carrier failure:** both checks go down at once, and the unit fails locally.

Neither check can stand in for the other, and the carrier refuses to send any heartbeat when both URLs are the same.

**Required check settings (Owner, in Healthchecks.io):** two checks, each with a period of 5 minutes and a grace of 10 minutes. A
missing run then alerts after about 15 minutes; the last real run was pinged within 60 s of completing.

### Credentials (placed by the Owner at the console; never in Git, a manifest, an image, the environment or a command line)

`/etc/nawara-core-topology-alert/` is root 0700. Each file is root-owned, mode 0400 or 0600, one link, and not a symbolic link:

| File | Value |
|---|---|
| `pushover.token` | the Pushover application token (30 × `[A-Za-z0-9]`) |
| `pushover.user` | the Pushover user or group key (30 × `[A-Za-z0-9]`) |
| `healthchecks-monitor.url` | the monitor check's ping URL (`https://hc-ping.com/<uuid>` or `/<ping-key>/<slug>`, no suffix) |
| `healthchecks-watchdog.url` | the watchdog check's ping URL (a different check) |

systemd passes them through `LoadCredential=`. They are not shared with the Auth carrier's files; the Owner decides whether the same
Pushover application or user is reused. Each credential is validated and never printed. A missing or invalid one disables only what it
serves (exit 78). The intake and the local evidence still run. Certification uses only disposable values and a local HTTPS receiver.

### Prerequisites before any production use (OD-BRK-2b-2, separately authorized)

1. The Owner creates the two Healthchecks.io checks and a Pushover application, and places the four credential files.
2. A newly signed v2 manifest is installed.
3. `verify-topology-monitor-install.sh` returns PASS.
4. A signed activation lists the carrier's timer.
5. A real end-to-end delivery is demonstrated, as A5-R3 required for its carrier.

Nothing in this repository installs, enables or starts the carrier.

## 8. Exit codes

| Code | Monitor | Watchdog | Trigger | Recovery |
|---|---|---|---|---|
| 0 | PASS | ok (or contained) | started | latch cleared |
| 1 | | a problem | | refused after checks |
| 2 | | | | invalid invocation |
| 10 | UNKNOWN recorded | | | |
| 20 | CONTAINED | | | |
| 21 | CONTAINMENT_UNCONFIRMED | | | |
| 64 | client command / argument | client command / argument | client command / argument | |
| 65 | unsafe installation, not root | unsafe installation, not root | unsafe installation, root | unsafe installation |
| 66 | verifier pin mismatch | | | verifier pin mismatch |
| 69 | tool missing | tool missing | tool missing | |
| 75 | lock busy (60 s) | lock busy | | lock busy |
| 78 | not installed | | | |

Carrier: 0 everything delivered and every due heartbeat sent; 3 events stay queued; 4 a heartbeat could not be sent; 64 an argument or
a client command; 65 an unsafe installation or state, or not root; 69 a tool missing; 78 a credential missing or invalid (the intake
still ran).

## 9. Remaining production gates

OD-BRK-2b-2 (installation, enablement, the trigger key and its sudoers rule, the provisioning and activation of the OD-BRK-2b-A alert
carrier and its two heartbeats, with its own
Owner-approved decision on these host-level privileged choices, and pointers in ADR-0053 and `core-rabbitmq-production.md`); NP-K; S1-R;
the applicable A12 / A5-R3 alert readiness; OD-BRK-3 to OD-BRK-5; the S1e-5 recertification; explicit Owner authorization for
Notification's production activation.
