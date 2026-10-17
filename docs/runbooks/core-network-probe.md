# T6 network probe: GitHub Actions → Tailscale → Server 1 (owner-operated)

- **Status:** IMPLEMENTED in the repository (T6.1), **NOT CONFIGURED, NEVER RUN.** No Tailscale credential, policy entry or secret for
  the probe exists. M2 is **NOT CERTIFIED**; G7, F6 and F7 stay **LOCKED**.
- **Authorizes nothing.** Each step in §4 needs its own explicit owner authorization.
- **Workflow:** `.github/workflows/core-network-probe.yml`, enforced by `scripts/lib/checks.mjs` (`probeWorkflowProblems`,
  `probeJobProblems`, and the repository-wide rules on `id-token`, the Tailscale action and `TS_*` secrets).
- **Local proof:** `scripts/deploy-tests/network-probe.test.mjs` runs the workflow's two scripts, exactly as written, against a
  throwaway `sshd` with synthetic keys in an unprivileged network namespace.

## 1. What the probe does, and never does

The probe checks the private route the production SSH workflows will use. It never logs in.

1. **Validation, before anything is contacted.** `TS_PROBE_HOST` must be an IPv4 address inside `100.64.0.0/10` (the tailnet range),
   `DEPLOY_SSH_PORT` a TCP port, and `DEPLOY_SSH_FINGERPRINT` a `SHA256:` fingerprint.
2. **Join the tailnet.** `tailscale/github-action@d1b6cd2…` (v4.2.0) exchanges the job's GitHub OIDC token for an **ephemeral**,
   pre-authorized node tagged `tag:nawara-ci-probe`. The client is pinned: version 1.94.2, with tarball SHA-256 `c6f99a5d…dc32`. The
   cache is off. There is no auth key, OAuth secret, extra argument, exit node, route or Tailscale SSH. The action logs the node out
   after the job.
3. **Probe.**
   - It opens a TCP connection to `TS_PROBE_HOST`:`DEPLOY_SSH_PORT`.
   - `ssh-keyscan -t ecdsa` then reads the host key. This is only the key exchange, with no authentication.
   - The server must offer exactly one `ecdsa-sha2-nistp256` key, and its SHA-256 fingerprint must equal `DEPLOY_SSH_FINGERPRINT`.

The probe prints only `PASS …` or `FAIL …` lines: no address, port, fingerprint or token. GitHub also masks the secret values, as a
second layer. **Do not re-run it with debug logging enabled.**

**It never:**
- logs in, runs a remote command, or checks out repository code;
- runs a script from the repository or a backup;
- reads `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_PASSWORD` or `BACKUP_SSH_*`;
- changes any secret.

`core-backup.yml` and its dispatch command are unchanged.

## 2. Configuration it needs (none exists yet)

**Tailscale admin (owner).**
- **Policy.** Add `tag:nawara-ci-probe` to `tagOwners`, and one grant: source `tag:nawara-ci-probe`, destination
  `tag:nawara-prod-server1`, IP protocol TCP, **the SSH port only**. No other destination or port, no autogroup, no subnet route.
- **Federated identity.** A new credential, separate from the `core-backup.yml` one, which stays untouched:

| Field | Value |
|---|---|
| Issuer | GitHub Actions (`https://token.actions.githubusercontent.com`) |
| Subject | `repo:nawara-solutions@328690360/nawara-core@1369892111:environment:production`, exact, with no `*` |
| Custom claim `workflow_ref` | `nawara-solutions/nawara-core/.github/workflows/core-network-probe.yml@refs/heads/main` |
| Custom claim `job_workflow_ref` | the same value |
| Custom claim `ref` | `refs/heads/main` |
| Custom claim `event_name` | `workflow_dispatch` |
| Custom claim `runner_environment` | `github-hosted` |
| Scope | `auth_keys` (write) only |
| Tags | `tag:nawara-ci-probe` only |

**Why both workflow claims.**
- **`job_workflow_ref`.** GitHub documents it as the ref of the reusable workflow a job runs. For an ordinary job, this repository's
  own Sigstore attestations show it equals the workflow itself: Fulcio's Build Signer URI, mapped from `job_workflow_ref`, equals the
  Build Config URI, mapped from `workflow_ref`. That is observed behaviour, not documented.
- **`workflow_ref`.** It names the top-level workflow.
- **Requiring both** pins the credential to this workflow's own job. A reusable workflow called from it would carry another
  `job_workflow_ref`.

**Check when creating it:**
- that Tailscale combines several custom claims with AND (its documentation implies it but does not state it);
- that no value contains `*`.

**GitHub `production` environment (owner):** three new **environment secrets**, never repository or organization secrets.

| Secret | Value |
|---|---|
| `TS_PROBE_OIDC_CLIENT_ID` | The federated credential's client ID |
| `TS_PROBE_OIDC_AUDIENCE` | The federated credential's audience |
| `TS_PROBE_HOST` | Server 1's tailnet IPv4 address (`100.x.y.z`), read from the Tailscale admin console |

`DEPLOY_SSH_PORT` and `DEPLOY_SSH_FINGERPRINT` are read as they are. `DEPLOY_SSH_HOST` is **not changed**: the other production
workflows share it.

## 3. Running it (only when authorized)

```bash
gh workflow run core-network-probe.yml --ref main
```

- **Approval.** The run waits for the `production` approval. The approval screen must name `core network probe` / `probe`.
- **Queue.** It shares the production queue, so it waits behind any deployment or backup.
- **Expected success.** These lines appear in order:
  - `PASS destination`
  - `PASS port`
  - `PASS fingerprint`
  - the tailnet join
  - `PASS tcp`
  - `PASS host key: matches the pinned DEPLOY_SSH_FINGERPRINT`
  - `PASS T6 network probe`

**On failure, stop.** Report only the `FAIL` line and do not re-run automatically.

| `FAIL` line | Meaning |
|---|---|
| `destination`, `port` or `fingerprint` | A secret is missing or malformed. Nothing was contacted |
| The tailnet join fails | The credential, its claims, the tag or the policy is wrong. Nothing reached Server 1 |
| `tcp` | The grant, the port or Server 1's tailnet state is wrong |
| `host key` | The key is not the pinned one. Treat it as a security finding, not a configuration retry |

## 4. Approval checkpoints (each separate)

1. Merge of the T6.1 pull request.
2. Tailscale policy entry and federated credential (§2), with the claim behaviour checked.
3. The three `production` environment secrets (§2).
4. One dispatch and its approval (§3). No automatic retry.

Later, and outside T6:
- T7 adds the tailnet join to the production SSH workflows;
- T8 moves the scheduled backup's `BACKUP_SSH_*` to the tailnet.

Each is separately reviewed and authorized.
