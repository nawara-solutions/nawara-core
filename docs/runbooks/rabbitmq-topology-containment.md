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
| `/usr/local/libexec/nawara-core-topology/` | 0755 | the four scripts (0555) and the pinned `verify-topology.sh` (0444) |
| `/var/lib/nawara-core-topology-monitor/` | 0700 | `installed`, `state`, `lock`, `evidence.jsonl`, `alerts.jsonl`, `watchdog`, `watchdog.jsonl` |
| `/var/lib/nawara-core-topology/notification-service.containment` | 0644 (dir 0755) | the OD-BRK-2a latch, read by provisioning |
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

## 2. Installation (OD-BRK-2b-2; not authorized here)

As root at the console, from a checkout of the reviewed revision:

1. `infra/rabbitmq/topology-monitor/install-topology-monitor.sh`: fresh only (it refuses if any target exists, so it never overwrites a
   state or a latch); it installs the files above, the initial state and the latch `state=inactive`, and copies the units **without**
   enabling or starting them.
2. `infra/rabbitmq/topology-monitor/verify-topology-monitor-install.sh`: read-only; every hash against its pin, owners, modes, the
   state and the latch. **STOP** on any FAIL.
3. The separately authorized enablement: `systemctl daemon-reload`, then the two timers.

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

## 5. Recovery (the contract; Owner-authorized, never automatic)

`recover-notification-topology.sh <authorization-reference>`, as root at an interactive terminal, under the monitor's lock. It clears
the latch, and only the latch, when: the installation and the verifier pin are intact; the state says contained and the latch is
contained; two read-backs show no grant and no connection; a fresh verification finds exactly one non-passing check (L1
`latch_contained`); and the operator types `RECOVER notification-service <reference>`. It then verifies again with the latch cleared
(or puts it back), resets the state and records the reference. **It never grants**: Notification is granted again only by protected
provisioning, whose pre-grant and post-grant gates run again. No replay, no queue deletion, no data change.

Restarting a container, a PASS or an ordinary provisioning run never recovers (provisioning refuses while the latch is contained).
**Open decision:** how the Owner's recovery authorization is issued and verified (the reference is recorded, not cryptographically
checked).

## 6. Evidence and alerts

`evidence.jsonl` (one line per run), `alerts.jsonl` and `watchdog.jsonl`, each bounded to 2000 lines, and a summary line in the journal.
Fields: version, timestamps, mode, phase, result, reason code, verifier check ids, UNKNOWN counter, containment outcome, attempts and the
watchdog's status. Never a message, a code, a credential, an HMAC key, the Erlang cookie, a policy definition or a broker address.

`alerts.jsonl` is a spool: **delivery is a pending dependency** (no production carrier exists for this control; the A5-R3 carrier is
Auth's and is not installed). Containment never depends on an alert being written or delivered.

## 7. Exit codes

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

## 8. Remaining production gates

OD-BRK-2b-2 (installation, enablement, the trigger key and its sudoers rule, an alert carrier and an external heartbeat, with its own
Owner-approved decision on these host-level privileged choices, and pointers in ADR-0053 and `core-rabbitmq-production.md`); NP-K; S1-R;
the applicable A12 / A5-R3 alert readiness; OD-BRK-3 to OD-BRK-5; the S1e-5 recertification; explicit Owner authorization for
Notification's production activation.
