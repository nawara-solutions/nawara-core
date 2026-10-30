# Real-broker certification on demand (GitHub Actions)

- **Status:** Core V2 Phase 3 (post-S6 stabilization). On demand only: not part of `core-ci-passed`, never on a pull request, a push or a
  schedule. A recurring run, or making it required, is a separate Owner decision.
- **Workflow:** [`.github/workflows/real-broker-certification.yml`](../../.github/workflows/real-broker-certification.yml), guarded by
  `npm run check:repo` (`checkOnDemandWorkflow`: `workflow_dispatch` only, `contents: read` only, no environment, no secret, no SSH).
- **Suites:** `npm run test:deploy:real-broker`, the same five files that run locally:

| File | Certifies |
|---|---|
| `scripts/deploy-tests/real-broker.mjs` | the authentic `provision.sh` on a disposable broker: identities, permissions, Notification's topology gate |
| `scripts/deploy-tests/real-broker-topic-grants.mjs` | every identity's effective topic grants equal the S1d-1 generator's output |
| `scripts/deploy-tests/real-broker-notification-topology.mjs` | Notification's isolated dead-lettering (OD-BRK-1/2a) |
| `scripts/deploy-tests/real-broker-topology-containment.mjs` | the OD-BRK-2b containment installer, as root of an unprivileged user namespace (the real-broker half of OD-BRK-2b-L, not its real-systemd half) |
| `scripts/deploy-tests/real-broker-consumers.mjs` | S1e-5 integrated consumer provenance on the real built processes ([report](../architecture/core-v2-s1e5-integrated-certification.md)) |

## 1. Run it

```sh
gh workflow run real-broker-certification.yml --ref main       # or --ref <branch> to certify a branch
gh run list --workflow real-broker-certification.yml --limit 1  # its run id
gh run watch <run-id> --exit-status
```

Or: Actions → "real-broker certification (on demand)" → Run workflow → pick the branch.

A second dispatch on the same ref waits for the first (it never cancels a run mid-cleanup). Different refs run in parallel on separate
runners; each suite names its resources after its own process id, so nothing is shared.

## 2. What it does

1. Checks out the ref and installs dependencies (`npm ci --ignore-scripts`), as Core CI does.
2. Verifies the npm script still runs exactly the five suites.
3. Prepares the disposable runner: Docker present; unprivileged user namespaces allowed (Ubuntu 24.04 restricts them through AppArmor;
   the containment suite needs `unshare -r`). This changes only the runner VM, which is discarded after the job.
4. Runs the suites (builds the kit, the audit contract and the four services first). Each suite provisions its own disposable
   RabbitMQ and PostgreSQL containers with generated credentials and removes them by recorded id.
5. Writes the `ℹ tests / pass / fail` summary to the run page.
6. On failure or cancellation: uploads `real-broker-diagnostics-<run>-<attempt>` (the full output, the container and network inventory,
   the last 500 log lines of each left-over suite container), kept 7 days. These hold only disposable test data.
7. Always: removes any left-over container, network or volume with a suite prefix (`rbreal-`, `rbtopic-`, `rbnotif-`, `rbcontain-`,
   `rbcons-`) and fails if one remains.

Bounds: the job 120 minutes, the suites step 100 minutes, each suite 30 minutes (`node --test --test-timeout`). Locally the five take about
25 minutes.

Nothing reaches production: no secret, no SSH, no environment, no deployed broker, no Nawara Lab host.

## 3. First verification after merge

GitHub offers `workflow_dispatch` only for a workflow that exists on the default branch, so the first real run happens after the merge:

1. `gh workflow run real-broker-certification.yml --ref main`
2. `gh run watch <run-id> --exit-status`: expect success.
3. The run summary shows `ℹ fail 0`, and the suites step log shows all five files.
4. The cleanup step reports `no disposable container remains`.
5. On failure: download the diagnostics artifact (`gh run download <run-id>`), then report it; do not weaken an assertion to pass.

## 4. Open observations (recorded, not fixed by Phase 3)

- **Auth "sequential replays" 401.** During Phase 2 (#407), one full run of `authorization-receipt-routes.e2e-spec.ts` failed once
  in "sequential replays" with `401` where `200` was expected, before any fault-injection code ran. It did not recur in 47 later full
  runs; its log was not kept; the guard, session, step-up and TOTP paths all use the suite's fake clock and no timing path to it was
  found. Open.
- **Notification's one-shot fault injection.** `apps/notification-service/test/send-api.e2e-spec.ts` (two `vi.spyOn(dbs, 'tx')
  .mockImplementationOnce`) and `delivery-engine.e2e-spec.ts` (`query` once) use the pattern #407 removed from Auth: a fault armed
  for the next call on a `DbService` that background workers may share. Not yet assessed; a separate decision.
- **OD-BRK-2b-L, real-systemd half:** BLOCKED — HARDWARE MAINTENANCE (Nawara Lab 01). This workflow covers only the real-broker half.
