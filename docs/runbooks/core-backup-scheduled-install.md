# Scheduled backup: E2 installation of the restricted identity (owner-operated)

- **Status:** PREPARED, **NOT EXECUTED.** Nothing in this runbook has been run in production. M2 is **NOT CERTIFIED**; G7, F6 and F7
  stay **LOCKED**.
- **Authorizes nothing.** E2 is a production mutation that needs its own explicit owner authorization, separate from E3 (the secrets), E4
  (`CORE_BACKUP_SCHEDULE`), P2 to P4 (the pre-G7 backup, its verification and the drills) and any restore.
- **Design:** [M2 design](../architecture/stage-21/stage-21-x-m2-pre-g7-backup-design.md) §5, §6, §11, §12 (OD-M2-1, OD-M2-4, OD-M2-12),
  §14, §15. **Runbook:** [backup and restore](core-backup-restore.md) §2, "Scheduled backups".
- **Repository side:** `infra/backup/scheduled-backup.sh` (the forced-command entry, B1, with the E2 root refusal),
  `infra/backup/scheduled-backup.authorized_keys.template` (the one restricted line, B1),
  `infra/backup/verify-scheduled-backup-install.sh` (E2, the read-only verification), `scripts/check-repo.mjs`
  (`checkScheduledBackupEntry`, `checkScheduledBackupVerifier`) and `scripts/deploy-tests/scheduled-backup*.test.mjs`.

## 1. What E2 changes, and nothing else

E2 makes exactly three changes on the production server, all at the owner-operated console (OD-M2-12):

| # | Change | Owner and mode |
|---|---|---|
| 1 | Create `/usr/local/libexec/nawara-core-backup/` (and `/usr/local/libexec/` if it is absent) | `root:root`, `0755` |
| 2 | Install `scheduled-backup.sh` and `backup.sh` from the merged revision R into it | `root:root`, `0555` and `0444` |
| 3 | Append **one** line, the template with the public key, to the runtime user's `~/.ssh/authorized_keys` | the file keeps its owner and mode (`0600`) |

E2 does **not** change `sshd_config` or restart `sshd`, change a group, `sudoers`, a cron table or a systemd unit, touch a container, a
database, `$HOME/nawara-core/backup/` or any G6 evidence, run a backup, or change anything in GitHub.

**Why the installation alone changes no production behaviour.** Nothing on the server starts the entry script: there is no timer and no
cron. The entry runs only when the scheduled key authenticates, and its private half is not in GitHub until E3. The scheduled workflow
is skipped until E4 sets `CORE_BACKUP_SCHEDULE=enabled`. Until then the new line is an unused, restricted key.

## 2. The restricted identity (security model)

- **Identity.** A dedicated ed25519 key, used only for the scheduled backup, in the runtime user's `authorized_keys` (OD-M2-4). It is
  never the deploy password and never a `DEPLOY_SSH_*` credential. Its private half lives only in the `production-backup` environment
  (E3).
- **No shell.** `restrict` turns off port, agent and X11 forwarding, the PTY and `~/.ssh/rc`. `command=` makes `sshd` run only
  `/usr/local/libexec/nawara-core-backup/scheduled-backup.sh`, whatever the client sends.
- **Rejection.** The entry refuses with exit 64, and never runs or prints, any client command (`SSH_ORIGINAL_COMMAND`) or argument. It
  refuses with 65 an unsafe installation (wrong place, inside `$HOME/nawara-core/backup`, a symbolic link, not owned by root, writable by
  group or others) and, since E2, a run as root. It refuses with 66 a `backup.sh` that does not match its pinned SHA-256, with 69 a missing
  tool and with 75 a run while another holds the lock. In each of these cases it does nothing.
- **Scope.** It runs only the installed, hash-pinned `backup.sh`, with `env -i` and only `HOME`, a fixed `PATH` and
  `BACKUP_SERVICES="auth-service organization-service"`. The destination is the existing `destination.env` and recipient certificate
  under `$HOME/nawara-core/backup`, which E2 does not touch.
- **Not isolation by itself (design §14).** The runtime user can run Docker, which is root-equivalent. Root-owned files stop this key
  and the GitHub path from changing what runs. They do not make the runtime user less privileged. The verifier records the user's groups;
  the scheduled identity is **not** called isolated.

## 3. Prerequisites (STOP if any is not met)

1. The E2 pull request is merged. **R** is its merge commit on `main`, with a green `core-ci-passed`.
2. An explicit owner authorization for E2 is recorded. It does not cover E3, E4, P2 to P4 or any restore.
3. E1 is done (`production-backup` exists, `main` only, administrator bypass off, no secrets), and P1 PASSED (2026-10-16, evidence
   SHA-256 `d7db77689a7a9cab4d7bfa7c01e6909c32043249974982991daaf8cd0a1a454e`). P1 is **not** repeated: the verifier of §6 re-reads the
   sshd and ownership facts that E2 depends on, at installation time.
4. `CORE_BACKUP_SCHEDULE` is absent or not `enabled`, and `production-backup` holds no secret.
5. Owner console access to the server, as root, and the runtime user's name as P1 recorded it.
6. A controlled workstation with a checkout of this repository at R. The key is generated there, never on the server.

## 4. Off the server: hashes and key (owner workstation)

```bash
git fetch origin && R=<merge commit of the E2 pull request>
for f in scheduled-backup.sh backup.sh verify-scheduled-backup-install.sh; do git show "$R:infra/backup/$f" | sha256sum; done
git show "$R:infra/backup/scheduled-backup.sh" | grep '^readonly BACKUP_SH_SHA256='   # must equal the backup.sh hash above

ssh-keygen -t ed25519 -a 100 -N '' -C nawara-core-scheduled-backup -f nawara-core-scheduled-backup
ssh-keygen -l -f nawara-core-scheduled-backup.pub   # record the SHA256:... fingerprint
git show "$R:infra/backup/scheduled-backup.authorized_keys.template" | grep -v '^#' \
  | sed "s|REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY|$(cut -d' ' -f2 nawara-core-scheduled-backup.pub)|" > scheduled-backup.line
```

Record the three SHA-256 values (`ENTRY_SHA256`, `BACKUP_SHA256`, `VERIFY_SHA256`) and the fingerprint. The key has no passphrase
because the job uses it unattended with `BatchMode=yes`. Its private half stays on the workstation, in owner custody, until E3 puts it
into `production-backup`. It never goes to the server, a ticket, a chat or the repository. Only `scheduled-backup.line` (public) goes to
the server.

## 5. On the server: the installation (console, as root)

Run the blocks one at a time, at an interactive root shell (no `set -e`, which would close the console on the first failure). Each check
prints `ok:` or `STOP:`; stop at the first `STOP` (§7).

```bash
umask 022
R=<merge commit>; ENTRY_SHA256=<…>; BACKUP_SHA256=<…>; VERIFY_SHA256=<…>; RUNTIME_USER=<runtime user from P1>
DIR=/usr/local/libexec/nawara-core-backup
AK="$(getent passwd "$RUNTIME_USER" | cut -d: -f6)/.ssh/authorized_keys"; echo "authorized_keys: $AK"
STAGE=$(mktemp -d /root/m2-e2.XXXXXX); echo "stage: $STAGE"
```

**5.1 Pre-state (read-only).**

```bash
[ ! -e "$DIR" ] && echo "ok: install directory absent" || echo "STOP: $DIR exists (a reinstallation is a different, reviewed procedure)"
{ [ ! -e "$AK" ] || ! grep -q -e nawara-core-scheduled-backup -e "$DIR" "$AK"; } && echo "ok: no scheduled line" || echo "STOP: a scheduled line already exists"
```

**5.2 The reviewed files**, fetched at R and checked against the hashes computed off the server; then the public line, pasted.

```bash
for f in scheduled-backup.sh backup.sh verify-scheduled-backup-install.sh; do
  curl -fsS --proto '=https' -o "$STAGE/$f" "https://raw.githubusercontent.com/nawara-solutions/nawara-core/$R/infra/backup/$f" || echo "STOP: fetch $f"
done
(cd "$STAGE" && printf '%s  %s\n' "$ENTRY_SHA256" scheduled-backup.sh "$BACKUP_SHA256" backup.sh \
  "$VERIFY_SHA256" verify-scheduled-backup-install.sh | sha256sum -c -) && echo "ok: hashes" || echo "STOP: a hash differs"
cat > "$STAGE/scheduled-backup.line"   # paste the ONE line of scheduled-backup.line, then Ctrl-D
[ "$(grep -c . "$STAGE/scheduled-backup.line")" = 1 ] \
  && grep -qE '^restrict,command="/usr/local/libexec/nawara-core-backup/scheduled-backup\.sh" ssh-ed25519 [A-Za-z0-9+/=]+ nawara-core-scheduled-backup$' "$STAGE/scheduled-backup.line" \
  && echo "ok: one restricted line" || echo "STOP: the staged line is not exactly the restricted template line"
[ ! -e "$AK" ] || { cp -p -- "$AK" "$STAGE/authorized_keys.pre-e2" && echo "ok: rollback copy"; }   # public keys only
```

**5.3 The three changes of §1.**

```bash
install -d -o root -g root -m 0755 "$DIR" \
  && install -o root -g root -m 0555 "$STAGE/scheduled-backup.sh" "$DIR/scheduled-backup.sh" \
  && install -o root -g root -m 0444 "$STAGE/backup.sh" "$DIR/backup.sh" && echo "ok: installed" || echo "STOP: install failed"
runuser -u "$RUNTIME_USER" -- sh -c 'umask 077; mkdir -p "$(dirname "$1")" && touch "$1" &&
  { [ -z "$(tail -c1 "$1")" ] || echo >>"$1"; } && cat >>"$1"' sh "$AK" < "$STAGE/scheduled-backup.line" \
  && echo "ok: line appended" || echo "STOP: append failed"
```

The line is appended as the runtime user (the line is read from the root-only stage through standard input), so the file keeps its
owner and mode; `umask 077` applies only if `.ssh` or the file must be created.

## 6. Verification (console, as root, read-only)

```bash
bash "$STAGE/verify-scheduled-backup-install.sh" "$RUNTIME_USER" "$ENTRY_SHA256" | tee "$STAGE/e2-verify.out"; echo "exit ${PIPESTATUS[0]}"
sha256sum "$STAGE/e2-verify.out"
```

E2 passes only if all of the following hold:

- The output ends with `RESULT: PASS (… checks); nothing was changed` and the exit code is 0.
- `scheduled key fingerprint` equals the fingerprint recorded in §4.

The verifier writes nothing. It checks the install path and its ancestors, the two files, their owner and modes, and the entry and
`backup.sh` hashes. It checks the effective `sshd` settings for the runtime user: `pubkeyauthentication yes`, `forcecommand none`,
`authorizedkeyscommand none`, `permituserenvironment no`, `strictmodes yes`, and OpenSSH 7.2 or later. It checks that exactly one line
in every `AuthorizedKeysFile` names the scheduled backup, that this line is exactly the template's form, and that its key appears on no
other line. Finally, it runs the installed entry as the runtime user with a client command and with an argument, and both must exit 64
without running anything.

**Never "test" the key by logging in with it.** An SSH login with the scheduled key and no command **runs a production backup**: that is
P2, which needs its own authorization. The refusal probe of the verifier runs no backup.

## 7. Stop conditions

Stop and leave everything as it is, then report to the owner, if any of these happens:

- A prerequisite of §3 is missing.
- §5.1 prints `STOP`.
- A hash check fails.
- The staged line is not exactly one restricted line.
- `install` or the append fails.
- The verifier exits non-zero.
- The fingerprint differs.
- The runtime user differs from the one P1 recorded.
- `sshd -T` fails.
- Something would need an `sshd` change or restart, a group, `sudoers` or a container change. Any such change is outside E2.

Never work around a failure by changing modes, editing the installed files, adding `sshd` options or retrying with other values.

## 8. Rollback (only to undo E2's own changes, on the owner's decision)

Remove exactly the scheduled line from `authorized_keys`, as the runtime user:

```bash
runuser -u "$RUNTIME_USER" -- sh -c 'umask 077; { grep -v -F -x -f /dev/stdin "$1" >"$1.new" || [ $? -eq 1 ]; } && mv -- "$1.new" "$1"' \
  sh "$AK" < "$STAGE/scheduled-backup.line"
```

Alternatively, restore `authorized_keys.pre-e2` if nothing else changed since. Then remove `$DIR/scheduled-backup.sh`, `$DIR/backup.sh`
and `$DIR`. Rollback is a production change: perform it only under the E2 authorization or a new one. Removing `$STAGE` and the
workstation copy of the private key are separate, explicitly authorized cleanups. The private key is removed from the workstation after
E3 has stored it.

## 9. Record (for the M2 record, C1)

Record:

- R and the date.
- `ENTRY_SHA256`, `BACKUP_SHA256` and `VERIFY_SHA256`.
- The key fingerprint and the `authorized_keys` line form (`restrict,command="…" ssh-ed25519 <key> nawara-core-scheduled-backup`).
- The SHA-256 of `e2-verify.out`.
- The runtime user's groups, as the verifier printed them, with the statement that the identity is not isolated (design §14).

Never record the key, the private key, the host, the port or an address.

## 10. Open owner decisions (not decided by this runbook)

- **Transfer method.** §5.2 fetches the files from GitHub at R and checks them against hashes computed off the server. The alternative
  is to paste them at the console. Either way, the hash check is mandatory.
- **E2 evidence location.** Where `e2-verify.out` is kept: `$STAGE` under `/root`, or beside the P1 evidence. Also when `$STAGE` is
  removed.
- **Runtime-user privilege (OD-M2-4, design §14).** Docker membership remains root-equivalent. A dedicated system account is OPEN.
- **The runtime user's login shell start-up files** run before the forced command (design §14). Reviewing them is not part of E2.
- **An end-to-end refusal test over SSH** (a login with the key and a command, which must return 64) is not part of E2. Omitting the
  command by mistake would run a backup.
