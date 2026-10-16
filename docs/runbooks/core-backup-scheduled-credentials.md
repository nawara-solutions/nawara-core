# Scheduled backup: E3 credentials of the restricted identity (owner-operated)

- **Status:** PREPARED, **NOT EXECUTED.** No key exists and no secret is set. M2 is **NOT CERTIFIED**; G7, F6 and F7 stay **LOCKED**.
- **Authorizes nothing.** E3 is a GitHub mutation that needs its own explicit owner authorization, separate from E2 (the console
  installation), E4 (`CORE_BACKUP_SCHEDULE`) and P2 to P4.
- **Design:** [M2 design](../architecture/stage-21/stage-21-x-m2-pre-g7-backup-design.md) §5, §6, §11, §12, §14 to §16.
  **Related runbooks:** [E2 installation](core-backup-scheduled-install.md) and [backup and restore](core-backup-restore.md) §2.
- **Local proof:** `scripts/deploy-tests/scheduled-backup-credentials.test.mjs` runs the real workflow step with synthetic credentials
  against a throwaway loopback `sshd`, whose forced command is the real entry. It covers every "can" and "cannot" in §2.

## 1. The credential set

There is one set: five **environment** secrets of `production-backup`. They are never repository or organization secrets, and never in
the `production` environment. Only `.github/workflows/core-backup-scheduled.yml` reads them (enforced by `scripts/lib/checks.mjs`).

| Secret | Value | Taken from |
|---|---|---|
| `BACKUP_SSH_HOST` | The server name or address the runner connects to. It must be the **same string** as the host in `BACKUP_SSH_KNOWN_HOSTS` | The owner's records (the deploy target) |
| `BACKUP_SSH_PORT` | The SSH port, digits only. The job refuses any other value | `sshd -T` at the console |
| `BACKUP_SSH_USER` | The runtime user recorded by P1, whose `authorized_keys` holds the E2 line. Never root: the entry refuses root (65) | P1 and the E2 verifier output |
| `BACKUP_SSH_KEY` | The **private** half of the dedicated ed25519 key generated in E2 §4, the complete OpenSSH file, without a passphrase | The owner workstation (E2 §4) |
| `BACKUP_SSH_KNOWN_HOSTS` | Exactly one line, `[HOST]:PORT ssh-ed25519 <host key>` (or `HOST ssh-ed25519 <host key>` only when the port is 22) | The server's `/etc/ssh/ssh_host_ed25519_key.pub`, read at the console |

**`BACKUP_SSH_KNOWN_HOSTS` is not the host's `.pub` file.** The `.pub` file has no host name, so the job would fail with "Host key
verification failed". This is also why the key is taken from the console and never fetched with `ssh-keyscan` over the network. The
`[HOST]:PORT` form works on every OpenSSH version. A plain `HOST` line with a non-default port happens to be accepted by recent clients,
but that is version-dependent, so do not rely on it.

## 2. What the credential can and cannot do

Each line below is proved locally by the test.

**Can:** open one SSH session as the runtime user, which runs only
`/usr/local/libexec/nawara-core-backup/scheduled-backup.sh`. That entry runs the pinned `backup.sh` for `auth-service organization-service`.
A login **without a command is a backup run.**

**Cannot:**
- **No command:** any command, a shell, or the sftp subsystem is refused with 64, and its text is never printed.
- **No terminal:** a PTY request is refused by `restrict`.
- **No forwarding:** port forwarding is refused by `restrict`.
- **No fallback login:** a wrong key, or the user `root`, gets no password or keyboard-interactive fallback, because the job uses
  `BatchMode` and allows public keys only.
- **No unverified server:** a wrong or missing known-hosts value fails before anything runs.
- **Nothing left behind:** nothing remains in `RUNNER_TEMP`, and the job prints no key material.

**Who can use it.** Only a job running in `production-backup`. That environment has a `main`-only deployment branch policy, with
administrator bypass off (E1). The job runs only on `schedule` (no dispatch), and only while `CORE_BACKUP_SCHEDULE == 'enabled'`. Until
E4, the job is skipped, a skipped job never receives environment secrets, and **E3 alone opens no connection.** GitHub masks the
values in logs.

## 3. Order and dependencies

```text
E1 (done) ─► P1 (PASSED 2026-10-16) ─► E2 console installation + verifier PASS ─► E3 secrets ─► E4 CORE_BACKUP_SCHEDULE ─► E5 first run
                          └► P2 manual backup (core-backup.yml, `production` approval) ─► P3 verification ─► P4 drills, if decided ──┘
```

- **E2 before E3.** The E3 values come out of the E2 session: the runtime user, the host key, and the key whose fingerprint the verifier
  matched. Secrets set before E2 would hold a key that the server does not accept, and that nothing has yet verified.
- **P2 is independent of E2 and E3.** The first manual pre-G7 backup uses `core-backup.yml`, which ships the repository's `backup.sh`
  under the `production` approval. It does not use the scheduled key or the installed copy. It may run before, between or after E2 and
  E3. GitHub's `production-deploy-core-api` queue serializes it with the scheduled job.
- **The installed `backup.sh` must stay the version P2 ran.** Today both have the SHA-256 `50be3c2b…d193`, which is the entry's pin. If a
  reviewed `backup.sh` change lands before E4, an authorized reinstallation (E2) comes first.
- **E4 needs** E3, P3 and P4 (if decided). **E5** is the first end-to-end use of the credentials in production.

## 4. Prerequisites (STOP if any is not met)

1. E2 is installed in production, and the verifier's `RESULT: PASS` is recorded (E2 runbook §6 and §9).
2. An explicit owner authorization for E3 is recorded. It does not cover E4.
3. `production-backup` exists with the `main` branch policy, administrator bypass off, and **no** secrets.
4. `CORE_BACKUP_SCHEDULE` is absent or not `enabled`.
5. The owner holds the E2 private key on the controlled workstation, plus the fingerprint recorded in E2 §4.
6. `gh` is authenticated as the owner on the workstation.

## 5. Procedure

**5.1 Console (read-only): the host key line.**

```bash
sshd -T | grep -iE '^(port|hostkey) '                 # the port, and that an ed25519 host key is served
cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub     # "ssh-ed25519 AAAA…" (public; the comment is dropped)
ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub    # the host key fingerprint, to compare in 5.2
```

**5.2 Workstation (read-only): build and check the values.** Use files, never shell arguments or history.

```bash
umask 077
printf '[%s]:%s %s\n' '<HOST>' '<PORT>' '<ssh-ed25519 AAAA… from 5.1>' > known_hosts.line   # or "<HOST> …" only if the port is 22
ssh-keygen -l -f known_hosts.line                      # must equal the console fingerprint of 5.1
ssh-keygen -l -f nawara-core-scheduled-backup          # must equal the E2 fingerprint (the key the verifier matched)
ssh-keygen -y -f nawara-core-scheduled-backup >/dev/null && echo "ok: the private key parses and has no passphrase"
[ "$(grep -c . known_hosts.line)" = 1 ] && echo "ok: one known_hosts line"
```

Compare the fingerprints silently on the workstation. Do not paste them into a ticket, chat or PR.

**5.3 GitHub (read-only): the pre-state.**

```bash
R=nawara-solutions/nawara-core
gh api "repos/$R/environments/production-backup" --jq '{policy: .deployment_branch_policy, bypass: .can_admins_bypass, rules: [.protection_rules[].type]}'
gh secret list --env production-backup --repo "$R"     # must be empty
gh secret list --repo "$R" | grep -c BACKUP_SSH_        # must be 0 (no repository-scope copy)
gh secret list --org nawara-solutions | grep -c BACKUP_SSH_   # must be 0 (no organization-scope copy)
gh variable list --repo "$R" | grep CORE_BACKUP_SCHEDULE      # must print nothing, or a value other than "enabled"
```

**5.4 GitHub (MUTATION, the E3 step): set the five secrets.** Every value comes from a file or from the interactive prompt, never from
`--body`:

```bash
gh secret set BACKUP_SSH_KEY         --env production-backup --repo "$R" < nawara-core-scheduled-backup
gh secret set BACKUP_SSH_KNOWN_HOSTS --env production-backup --repo "$R" < known_hosts.line
gh secret set BACKUP_SSH_HOST        --env production-backup --repo "$R"   # paste at the prompt
gh secret set BACKUP_SSH_PORT        --env production-backup --repo "$R"   # paste at the prompt
gh secret set BACKUP_SSH_USER        --env production-backup --repo "$R"   # paste at the prompt
```

**5.5 GitHub (read-only): verification.**

```bash
gh secret list --env production-backup --repo "$R"     # exactly the five names, nothing else
gh secret list --repo "$R" | grep -c BACKUP_SSH_        # still 0
gh variable list --repo "$R" | grep CORE_BACKUP_SCHEDULE   # still not "enabled"
```

GitHub never returns a secret value. The values are proved end to end only by E5, the first scheduled run after E4. Do **not** dispatch
anything, and do not "test" the key by logging in with it: a login without a command runs a production backup (P2's territory).

## 6. Stop conditions

Stop if any of these happens:

- A prerequisite is missing.
- A fingerprint differs.
- The known-hosts value is not exactly one line.
- The environment has another secret, a reviewer, or another branch policy.
- A `BACKUP_SSH_*` secret exists at repository or organization scope.
- `CORE_BACKUP_SCHEDULE` is `enabled`.
- A value would have to appear on a command line, in a ticket or in a log.

If you stop: record what happened, change nothing more, and escalate to the owner.

## 7. Custody, revocation and rotation

- **Custody.** After 5.5 passes, GitHub is the only holder the scheduled path needs. Whether the workstation copy of the private key is
  then deleted (recommended: a lost key is replaced by rotation, not restored), and when, is a separate owner decision (§9).
- **Revocation.** The authoritative kill switch is removing the `authorized_keys` line at the console (E2 runbook §8). Deleting the five
  secrets (`gh secret delete … --env production-backup`) and unsetting `CORE_BACKUP_SCHEDULE` follow.
- **Rotation.** Generate a new key (E2 §4). **Replace** the line in `authorized_keys`, never add a second one: the E2 verifier allows
  exactly one scheduled line. Re-run the E2 verifier, then update `BACKUP_SSH_KEY` (5.4 and 5.5). A host-key change on the server
  breaks the job safely ("Host key verification failed"); update `BACKUP_SSH_KNOWN_HOSTS` from the console.

## 8. Record (for the M2 record, C1)

Record:

- The date and the authorization reference.
- The five secret names and the environment.
- The known-hosts **form** (`[HOST]:PORT ssh-ed25519`), not its value.
- That both fingerprint comparisons matched (the fingerprints themselves stay in the owner's records).
- The 5.3 and 5.5 results.

Never record the key, the host, the port, the user or an address.

## 9. Residual risks and open decisions

- **A holder of the key can start a backup at will.** If GitHub or the environment were compromised, the key could trigger runs; it
  could never run a command. The impact is bounded: `flock` allows one run at a time, and retention keeps the newest 30 backup *days*, so
  extra runs on one day cannot push older days out. Load and storage still grow.
- **No source restriction.** GitHub-hosted runners have no fixed address, so `from=` is not used (design §5).
- **The private key in GitHub has no passphrase.** This is inherent to unattended use. GitHub encrypts it at rest and masks it in logs.
- **The runtime user is root-equivalent through Docker** (design §14). This matters only if the forced command were escaped. The entry's
  checks and `restrict` are the barrier.
- **Workstation key retention and deletion timing:** OPEN (owner decision).
- **An optional attended probe:** OPEN. From the workstation, `ssh … <host> refusal-probe` with the key should return 64. It would prove
  the key, the host pin and the forced command before E5. Omitting the command by mistake would run a production backup, so it is not
  part of E3.
- **GitHub disables schedules** in a public repository after 60 days without activity, and **failure notifications** go to whoever last
  changed the cron line (design §6, §14): TO VERIFY before E4.
