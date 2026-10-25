import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { AUTH_NEVER_CALL, AUTH_ORGANIZATION_CLIENT, AUTH_ORGANIZATION_OPERATIONS, checkAuthOrganizationBoundary } from './lib/checks.mjs';
import { REPAIR_AUDIT_ACTIONS, REPAIR_AUDIT_PRODUCER, REPAIR_AUDIT_SCAN, REPAIR_AUDIT_TESTS, checkRepairAuditProducerScope, repairAuditScanned } from './lib/checks.mjs';
import { ALERT_CATALOG, BROKER_ALARMS, CI_AGGREGATE, CORE_JOBS, GRAFANA_DASHBOARDS, PROMETHEUS_SELF_METRICS, PRODUCTION_GROUP, checkAlertRules, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkActionPins, checkDigestDeploy, checkHierarchyFixtures, checkImageBuild, checkImagePins, checkLocalGrafana, checkLocalObservability, checkTypedConfirmation, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety, SBOM_GENERATOR, checkMetricsClientImport, metricsClientReferences, CALLER_POLICY_MODULES, checkCallerPolicyInventory, checkCallerPolicyModule, staticModuleSpecifiers, workspaceAppPackages, DEVELOPMENT_SECRET_CATALOG, DOCKER_CONTEXT_EXCLUDED, ENV_PATHS_IGNORED, PROCESS_ENV_BOUNDARY, checkDevelopmentSecretCatalog, checkDockerContext, checkEnvIgnorePolicy, checkEnvTemplates, checkReadmeEnvironmentCoverage, checkTrackedEnvFiles, developmentSecretCatalog, dockerIgnoreExcludes, envAssignments, gitIgnoreProbe, gitTrackedFiles, isEnvTemplate, isServiceConfigSource, sourceFacts, ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS, checkEnvReaderClis, checkNodeToolchain, nodeMajor, checkCiWorkspaceCoverage, GENERICITY_HISTORICAL_LINES, checkEventContracts, usesEventTraffic, EVENT_CONTRACT_EXEMPT, checkOutboxRetentionEligibility, outboxIdSources, OUTBOX_RETENTION_APPROVED_SERVICES } from './lib/checks.mjs';
import ts from 'typescript';
import { BACKUP_ENVIRONMENT, SCHEDULED_BACKUP_CRON, SCHEDULED_BACKUP_GUARD, SCHEDULED_BACKUP_SECRETS, checkScheduledBackupEntry, checkScheduledBackupVerifier } from './lib/checks.mjs';
import { BACKUP_DESTINATION_ENV, BACKUP_JOB, BACKUP_JOB_SECRETS, BACKUP_PACKAGE_RUN, BACKUP_PERMISSIONS, BACKUP_REMOTE_SCRIPT, BACKUP_SSH_ACTION, BACKUP_SSH_WITH, BACKUP_TAG, BACKUP_TAILSCALE_WITH, BACKUP_WORKFLOW, SSH_ACTION_INPUTS, checkDroneSshFiles } from './lib/checks.mjs';
import { PROBE_ENV, PROBE_GUARD, PROBE_JOB, PROBE_SECRETS, PROBE_TAG, PROBE_TAILSCALE_WITH, PROBE_WORKFLOW, TAILSCALE_ACTION, TAILSCALE_ACTION_RELEASE, TAILSCALE_CLIENT_SHA256, TAILSCALE_CLIENT_VERSION } from './lib/checks.mjs';

// V2-A.3 A3.6: the host-key guard step, exactly as every real production SSH job carries it.
const HOST_KEY_GUARD_STEP = `      - name: Require the pinned production host key
        env:
          DEPLOY_SSH_FINGERPRINT: \${{ secrets.DEPLOY_SSH_FINGERPRINT }}
        run: |
          [[ $DEPLOY_SSH_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] \\
            || { echo "::error::DEPLOY_SSH_FINGERPRINT is missing or is not a SHA256 host-key fingerprint; nothing was sent to the server"; exit 1; }
`;
const deploy = ({ script = 'set -euo pipefail\ndocker pull "$IMAGE"', concurrency = `concurrency:\n      group: ${PRODUCTION_GROUP}\n      cancel-in-progress: false`, guard = "if: github.ref == 'refs/heads/main'", push = 'workflow_dispatch:', environment = 'environment: production' } = {}) => `
name: d
on:
  ${push}
jobs:
  deploy:
    ${guard}
    ${environment}
    ${concurrency}
    runs-on: ubuntu-latest
    steps:
${HOST_KEY_GUARD_STEP}      - uses: appleboy/ssh-action@v1
        with:
          fingerprint: \${{ secrets.DEPLOY_SSH_FINGERPRINT }}
          script: |
${script.split('\n').map((l) => '            ' + l).join('\n')}
`;

test('a correct production deployment passes', () => {
  assert.deepEqual(checkWorkflowSafety('d.yml', deploy()), []);
});

test('the remote script must start with set -euo pipefail', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ script: 'docker pull "$IMAGE"' })).join(), /must start with "set -euo pipefail"/);
  assert.match(checkWorkflowSafety('d.yml', deploy({ script: 'set -e\ndocker pull x' })).join(), /must start with "set -euo pipefail"/);
});

test('the ignored script_stop input is refused (it gives no protection)', () => {
  const wf = deploy().replace('          script: |', '          script_stop: true\n          script: |');
  assert.match(checkWorkflowSafety('d.yml', wf).join(), /script_stop.*not an input/);
});

test('a deployment without a concurrency group is refused', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ concurrency: '' })).join(), /no concurrency group/);
});

test('cancelling a running production deployment is refused', () => {
  const cancel = `concurrency:\n      group: ${PRODUCTION_GROUP}\n      cancel-in-progress: true`;
  assert.match(checkWorkflowSafety('d.yml', deploy({ concurrency: cancel })).join(), /cancel-in-progress must be explicitly false/);
  const implicit = `concurrency:\n      group: ${PRODUCTION_GROUP}`;
  assert.match(checkWorkflowSafety('d.yml', deploy({ concurrency: implicit })).join(), /cancel-in-progress must be explicitly false/);
});

test('every deployment path must share the one production group', () => {
  const other = 'concurrency:\n      group: something-else\n      cancel-in-progress: false';
  assert.match(checkWorkflowSafety('d.yml', deploy({ concurrency: other })).join(), /concurrency group must be/);
});

test('a stale trigger on a branch other than main is refused', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ push: 'push:\n    branches: [feat/old-branch]' })).join(), /must not trigger on branches other than main/);
});

test('a deployment not restricted to main is refused', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ guard: '' })).join(), /restricted to refs\/heads\/main/);
});

test('a secret interpolated into the remote script is refused', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ script: 'set -euo pipefail\necho ${{ secrets.TOKEN }}' })).join(), /secret is interpolated/);
});

test('publishing the :production image must share the deployment queue', () => {
  const wf = `
name: b
on:
  push:
    branches: [main]
jobs:
  build:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: docker/build-push-action@v7
        with:
          push: true
          tags: |
            ghcr.io/x/y:production
`;
  assert.match(checkWorkflowSafety('b.yml', wf).join(), /publishes the :production image/);
});

// ---------------------------------------------------------------------------------------------------- V2-A.2: build ≠ deploy
const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const BUILD = workflow('auth-service-docker-build.yml');
const DEPLOY = workflow('auth-service-deploy.yml');
// V2 A14: the provenance signer of each deployment (as scripts/check-repo.mjs derives it from IMAGE_BUILDS).
const SIGNER = { 'nawara-core-auth-service': 'auth-service-docker-build.yml', 'nawara-core-organization-service': 'organization-service-image.yml', 'nawara-core-audit-service': 'audit-service-image.yml' };
const checkDigestDeployFor = (f, t, r) => checkDigestDeploy(f, t, r, { signerWorkflow: SIGNER[r] });
const AUTH = 'nawara-core-auth-service';
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `fixture drift: "${from}" not found`);
  return text.replace(from, to);
};

test('A: an SSH deployment on push (or any automatic event) is refused; a scheduled one too (A3.5: it would wait for approval)', () => {
  for (const event of ['push:\n    branches: [main]', 'pull_request:\n    branches: [main]', 'workflow_run:\n    workflows: [x]']) {
    assert.match(checkWorkflowSafety('d.yml', deploy({ push: event })).join(), /must only run on workflow_dispatch or schedule, never automatically/);
  }
  assert.match(checkWorkflowSafety('d.yml', deploy({ push: 'schedule:\n    - cron: "0 2 * * *"' })).join(), /must be in a workflow_dispatch-only workflow/);
});

test('A: the real Auth image workflow builds only; re-adding an automatic deploy job is refused', () => {
  assert.deepEqual(checkWorkflowSafety('auth-service-docker-build.yml', BUILD), []);
  const deployJob = `
  deploy-production:
    needs: build-image
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    concurrency:
      group: ${PRODUCTION_GROUP}
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          script: |
            set -euo pipefail
            docker pull "$IMAGE"
`;
  assert.match(checkWorkflowSafety('b.yml', BUILD + deployJob).join(), /never automatically \(found: push\)/); // V2 A14: the Auth image workflow is push-only
});

test('B/C: a push-triggered workflow may not publish or move :production or :latest', () => {
  for (const tag of ['production', 'latest']) {
    const tagged = swap(BUILD, 'tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}', `tags: |\n            \${{ env.IMAGE_NAME }}:sha-\${{ github.sha }}\n            \${{ env.IMAGE_NAME }}:${tag}`);
    assert.match(checkWorkflowSafety('b.yml', tagged).join(), /must not publish or move :production or :latest/);
    const retag = swap(BUILD, '          set -euo pipefail\n          [[ "$DIGEST"', `          set -euo pipefail\n          docker buildx imagetools create -t "$IMAGE_NAME:${tag}" "$IMAGE_NAME@$DIGEST"\n          [[ "$DIGEST"`);
    assert.match(checkWorkflowSafety('b.yml', retag).join(), /must not publish or move :production or :latest/);
  }
});

test('H: a workflow input interpolated into a shell script is refused (any workflow)', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ script: 'set -euo pipefail\ndocker pull "x@${{ inputs.digest }}"' })).join(), /input is interpolated into a shell script/);
  const run = swap(DEPLOY, '[[ "$DIGEST" =~', '[[ "${{ inputs.digest }}" =~');
  assert.match(checkWorkflowSafety('d.yml', run).join(), /input is interpolated into a shell script/);
});

test('the real digest deployment passes every rule', () => {
  assert.deepEqual(checkWorkflowSafety('auth-service-deploy.yml', DEPLOY), []);
  assert.deepEqual(checkDigestDeployFor('auth-service-deploy.yml', DEPLOY, AUTH), []);
});

test('D: a digest deployment that builds (rebuilding main) is refused', () => {
  const buildStep = `      - uses: docker/build-push-action@v7
        with:
          push: true
          tags: \${{ env.IMAGE_NAME }}:sha-\${{ github.sha }}
      - uses: appleboy/ssh-action@v1`;
  assert.match(checkDigestDeployFor('d.yml', swap(DEPLOY, '      - uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5', buildStep), AUTH).join(), /must never build an image/);
  for (const cmd of ['docker build -t x .', 'docker buildx build --push .']) {
    const bad = swap(DEPLOY, '          docker buildx imagetools inspect "$REF" >/dev/null', `          ${cmd}\n          docker buildx imagetools inspect "$REF" >/dev/null`);
    assert.match(checkDigestDeployFor('d.yml', bad, AUTH).join(), /must never build an image/);
  }
});

test('E: removing or loosening the digest validation, or moving it after the registry login, is refused', () => {
  const VALIDATE = `      - name: validate the digest
        env:
          DIGEST: \${{ inputs.digest }}
        run: |
          set -euo pipefail
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "refused: the digest must be sha256:<64 lowercase hex>" >&2; exit 1; }
`;
  // verify's validation (the first occurrence) loosened, then deploy's re-validation loosened
  const loose = swap(DEPLOY, '^sha256:[0-9a-f]{64}$ ]] || { echo "refused: the digest must', '^sha256:.+$ ]] || { echo "refused: the digest must');
  assert.match(checkDigestDeployFor('d.yml', loose, AUTH).join(), /job "verify": the digest must be validated against/);
  const looseDeploy = DEPLOY.slice(0, DEPLOY.lastIndexOf(VALIDATE)) + VALIDATE.replace('{64}', '+') + DEPLOY.slice(DEPLOY.lastIndexOf(VALIDATE) + VALIDATE.length);
  assert.match(checkDigestDeployFor('d.yml', looseDeploy, AUTH).join(), /job "deploy": the digest must be re-validated/);
  // verify's validation moved after the registry login
  const late = swap(swap(DEPLOY, VALIDATE, ''), '      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n', `      - uses: docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0\n${VALIDATE}`);
  assert.match(checkDigestDeployFor('d.yml', late, AUTH).join(), /job "verify": the digest must be validated .* before any registry step/);
});

// ---------------------------------------------------------------- V2-A.3 (A3.5): production SSH only inside a protected environment
test('A3.5: every job using production SSH or DEPLOY_SSH_* must declare an approved literal environment', () => {
  assert.match(checkWorkflowSafety('d.yml', deploy({ environment: '' })).join(), /must declare a protected environment \(production\)/);
  assert.match(checkWorkflowSafety('d.yml', deploy({ environment: 'environment: staging' })).join(), /"staging" is not an approved production environment/);
  assert.match(checkWorkflowSafety('d.yml', deploy({ environment: "environment: ${{ inputs.target }}" })).join(), /must be a literal name, never an expression/);
  assert.match(checkWorkflowSafety('d.yml', deploy({ environment: 'environment: production-backup' })).join(), /not an approved production environment/);
  assert.deepEqual(checkWorkflowSafety('d.yml', deploy({ environment: 'environment:\n      name: production' })), []);
  for (const use of ['${{ secrets.DEPLOY_SSH_HOST }}', "${{ secrets['DEPLOY_SSH_USER'] }}", '${{ secrets["DEPLOY_SSH_PORT"] }}', '${{ toJSON(secrets) }}']) {
    const consumer = `
name: c
on:
  workflow_dispatch:
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$H"
        env:
          H: ${use}
`;
    assert.match(checkWorkflowSafety('c.yml', consumer).join(), /must declare a protected environment/, use);
  }
});

test('A3.5: a production-environment job only behind an explicit dispatch (never push, pull_request or a schedule)', () => {
  for (const event of ['schedule:\n    - cron: "17 2 * * *"', 'push:\n    branches: [main]']) {
    const both = deploy({ push: `workflow_dispatch:\n  ${event}` });
    assert.match(checkWorkflowSafety('d.yml', both).join(), /must be in a workflow_dispatch-only workflow/, event);
  }
});

const PRODUCTION_WORKFLOWS = ['auth-service-deploy.yml', 'organization-service-deploy.yml', 'audit-service-deploy.yml', 'core-rabbitmq-provision.yml', 'auth-db-credential-rotate.yml', 'core-backup.yml'];

test('A3.5: the six real production workflows are gated by the production environment, dispatch-only', () => {
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    assert.deepEqual(checkWorkflowSafety(name, text), [], name);
    const doc = parse(text);
    assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch'], name);
    const sshJobs = Object.entries(doc.jobs).filter(([, j]) => (j.steps ?? []).some((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action')));
    assert.equal(sshJobs.length, 1, name);
    assert.equal(sshJobs[0][1].environment, 'production', name);
  }
});

test('A3.5: removing the environment from any real production workflow is refused', () => {
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    const without = text.replace(/\n {4}environment: production\n/, '\n');
    assert.notEqual(without, text, name);
    assert.match(checkWorkflowSafety(name, without).join(), /must declare a protected environment/, name);
  }
});

// ---------------------------------------------------------------- V2-A.3 A3.6: the production host key is pinned
const FINGERPRINT_INPUT = '          fingerprint: ${{ secrets.DEPLOY_SSH_FINGERPRINT }}\n';
const GUARD_BLOCK = /      - name: Require the pinned production host key\n(?:.*\n){5}/;

test('A3.6: every real production SSH step pins the host key behind the guard', () => {
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    const doc = parse(text);
    const [, job] = Object.entries(doc.jobs).find(([, j]) => (j.steps ?? []).some((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action')));
    const sshAt = job.steps.findIndex((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));
    assert.equal(job.steps[sshAt].with.fingerprint, '${{ secrets.DEPLOY_SSH_FINGERPRINT }}', name);
    // The guard sits right before the SSH step; in core-backup.yml (Core V2 M2 T7) the destination check and the tailnet join follow it.
    const guardAt = sshAt - (name === 'core-backup.yml' ? 3 : 1);
    assert.equal(job.steps[guardAt].name, 'Require the pinned production host key', name);
    assert.equal(job.steps[guardAt].env.DEPLOY_SSH_FINGERPRINT, '${{ secrets.DEPLOY_SSH_FINGERPRINT }}', name);
    assert.match(text, GUARD_BLOCK, name);
  }
});

test('A3.6: a missing, literal or substituted fingerprint is refused in every real production workflow', () => {
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    assert.match(checkWorkflowSafety(name, swap(text, FINGERPRINT_INPUT, '')).join(), /must pin the production host key/, name);
    for (const value of [`SHA256:${'A'.repeat(43)}`, '${{ secrets.DEPLOY_SSH_HOST_KEY }}', '${{ vars.DEPLOY_SSH_FINGERPRINT }}', "${{ secrets.DEPLOY_SSH_FINGERPRINT || '' }}", "''"]) {
      const changed = swap(text, FINGERPRINT_INPUT, `          fingerprint: ${value}\n`);
      assert.match(checkWorkflowSafety(name, changed).join(), /fingerprint must be exactly \$\{\{ secrets\.DEPLOY_SSH_FINGERPRINT \}\}/, `${name}: ${value}`);
    }
  }
});

test('A3.6: removing the guard from any real production workflow is refused', () => {
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    const without = text.replace(GUARD_BLOCK, '');
    assert.notEqual(without, text, name);
    assert.match(checkWorkflowSafety(name, without).join(), /must be preceded by the host-key guard step/, name);
  }
});

test('A3.6: a guard after the SSH step, without failure, skippable or reading another value is refused', () => {
  const after = deploy().replace(HOST_KEY_GUARD_STEP, '') + HOST_KEY_GUARD_STEP;
  assert.match(checkWorkflowSafety('d.yml', after).join(), /must be preceded by the host-key guard step/);
  const weakened = [
    HOST_KEY_GUARD_STEP.replace('exit 1; }', 'exit 0; }'),
    HOST_KEY_GUARD_STEP.replace(' exit 1; }', ' }'),
    HOST_KEY_GUARD_STEP.replace('{43}', '+'),
    HOST_KEY_GUARD_STEP.replace('^SHA256:', '^'),
    HOST_KEY_GUARD_STEP.replace('        env:\n', '        if: false\n        env:\n'),
    HOST_KEY_GUARD_STEP.replace('        env:\n', '        continue-on-error: true\n        env:\n'),
    HOST_KEY_GUARD_STEP.replace('        env:\n', '        shell: sh\n        env:\n'),
    HOST_KEY_GUARD_STEP.replace('${{ secrets.DEPLOY_SSH_FINGERPRINT }}', '${{ vars.DEPLOY_SSH_FINGERPRINT }}'),
    HOST_KEY_GUARD_STEP.replace('${{ secrets.DEPLOY_SSH_FINGERPRINT }}', `SHA256:${'A'.repeat(43)}`),
  ];
  for (const guard of weakened) {
    assert.notEqual(guard, HOST_KEY_GUARD_STEP);
    assert.match(checkWorkflowSafety('d.yml', deploy().replace(HOST_KEY_GUARD_STEP, guard)).join(), /must be preceded by the host-key guard step/, guard);
  }
});

test('A3.6: a fingerprint variable in any env, or a proxy, is refused', () => {
  const workflowEnv = deploy().replace('\njobs:\n', '\nenv:\n  PLUGIN_FINGERPRINT: x\njobs:\n');
  assert.match(checkWorkflowSafety('d.yml', workflowEnv).join(), /no fingerprint variable may be set at workflow level \(found: PLUGIN_FINGERPRINT\)/);
  const jobEnv = deploy().replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    env:\n      SSH_FINGERPRINT: x\n');
  assert.match(checkWorkflowSafety('d.yml', jobEnv).join(), /no fingerprint variable may be set at job level \(found: SSH_FINGERPRINT\)/);
  const stepEnv = deploy().replace('      - uses: appleboy/ssh-action@v1\n', '      - uses: appleboy/ssh-action@v1\n        env:\n          INPUT_FINGERPRINT: x\n');
  assert.match(checkWorkflowSafety('d.yml', stepEnv).join(), /no fingerprint variable may be set at step 2 level \(found: INPUT_FINGERPRINT\)/);
  for (const input of ['proxy_fingerprint: x', 'proxy_host: x']) {
    const proxied = deploy().replace(FINGERPRINT_INPUT, `${FINGERPRINT_INPUT}          ${input}\n`);
    assert.match(checkWorkflowSafety('d.yml', proxied).join(), /must not use a proxy/, input);
  }
});

test('A3.6: the fingerprint secret stays out of the Auth verify job (no production credential before the approval)', () => {
  const leaked = swap(DEPLOY, '          DIGEST: ${{ inputs.digest }}\n', '          DIGEST: ${{ inputs.digest }}\n          FP: ${{ secrets.DEPLOY_SSH_FINGERPRINT }}\n');
  assert.match(checkDigestDeployFor('d.yml', leaked, AUTH).join(), /job "verify": must not use production SSH or the DEPLOY_SSH_\* credentials/);
});

test('A3.5: core-backup is manual only (B1): re-adding its schedule is refused', () => {
  const BACKUP = workflow('core-backup.yml');
  const scheduled = swap(BACKUP, '        default: auth-service\n', "        default: auth-service\n  schedule:\n    - cron: '17 2 * * *'\n");
  assert.match(checkWorkflowSafety('core-backup.yml', scheduled).join(), /must be in a workflow_dispatch-only workflow/);
});

test('A3.5: typed confirmations of the real production operations are kept', () => {
  const ROTATE = workflow('auth-db-credential-rotate.yml');
  assert.deepEqual(checkTypedConfirmation('auth-db-credential-rotate.yml', ROTATE, 'rotate auth_app'), []);
  assert.deepEqual(checkTypedConfirmation('auth-service-deploy.yml', DEPLOY, 'deploy auth-service'), []);
  const dropped = swap(ROTATE, " && inputs.confirm == 'rotate auth_app'", '');
  assert.match(checkTypedConfirmation('r.yml', dropped, 'rotate auth_app').join(), /job "rotate": must require the typed confirmation/);
  const changed = swap(ROTATE, "inputs.confirm == 'rotate auth_app'", "inputs.confirm == 'yes'");
  assert.match(checkTypedConfirmation('r.yml', changed, 'rotate auth_app').join(), /must require the typed confirmation/);
  const optional = swap(ROTATE, '        required: true\n', '        required: false\n');
  assert.match(checkTypedConfirmation('r.yml', optional, 'rotate auth_app').join(), /"confirm" input must exist and be required/);
});

test('A3.5: the Auth verify/deploy split is enforced', () => {
  assert.deepEqual(checkDigestDeployFor('auth-service-deploy.yml', DEPLOY, AUTH), []);
  const noEnv = swap(DEPLOY, '    environment: production\n', '');
  assert.match(checkDigestDeployFor('d.yml', noEnv, AUTH).join(), /must be bound to the "production" environment/);
  const onVerify = swap(swap(DEPLOY, '    environment: production\n', ''), '  verify:\n    if:', '  verify:\n    environment: production\n    if:');
  const msgs = checkDigestDeployFor('d.yml', onVerify, AUTH).join();
  assert.match(msgs, /job "verify": must not declare an environment/);
  assert.match(msgs, /job "deploy": must be bound to the "production" environment/);
  assert.match(checkDigestDeployFor('d.yml', swap(DEPLOY, '    needs: verify\n', ''), AUTH).join(), /must need the "verify" job/);
  const verifyGone = DEPLOY.replace(/\n {2}verify:\n[\s\S]*?\n {2}deploy:\n/, '\n  deploy:\n');
  assert.match(checkDigestDeployFor('d.yml', verifyGone, AUTH).join(), /the "verify" job is missing/);
  const sshOnVerify = swap(DEPLOY, '      - id: artifact\n', '      - run: echo "$H"\n        env:\n          H: ${{ secrets.DEPLOY_SSH_HOST }}\n      - id: artifact\n');
  assert.match(checkDigestDeployFor('d.yml', sshOnVerify, AUTH).join(), /job "verify": must not use production SSH or the DEPLOY_SSH_\* credentials/);
  const renamed = swap(swap(DEPLOY, '\n  deploy:\n    needs: verify\n', '\n  ship:\n    needs: verify\n'), 'jobs:\n', 'jobs:\n');
  assert.match(checkDigestDeployFor('d.yml', renamed, AUTH).join(), /the SSH job must be "deploy"/);
  const noConfirmVerify = DEPLOY.replace("  verify:\n    if: github.ref == 'refs/heads/main' && inputs.confirm == 'deploy auth-service'\n", "  verify:\n    if: github.ref == 'refs/heads/main'\n");
  assert.match(checkDigestDeployFor('d.yml', noConfirmVerify, AUTH).join(), /job "verify": must require the typed confirmation/);
});

test('F: deploying anything but exactly IMAGE_NAME@digest is refused', () => {
  for (const image of ['${{ env.IMAGE_NAME }}:production', '${{ env.IMAGE_NAME }}:sha-${{ github.sha }}', 'ghcr.io/other/repo@${{ inputs.digest }}', '${{ steps.verify.outputs.ref }}']) {
    const bad = swap(DEPLOY, 'IMAGE: ${{ env.IMAGE_NAME }}@${{ inputs.digest }}', `IMAGE: ${image}`);
    assert.match(checkDigestDeployFor('d.yml', bad, AUTH).join(), /must deploy exactly/);
  }
  const foreign = swap(DEPLOY, 'IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/nawara-core-auth-service', 'IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/nawara-core-organization-service');
  assert.match(checkDigestDeployFor('d.yml', foreign, AUTH).join(), /IMAGE_NAME must be fixed to the nawara-core-auth-service repository/);
});

test('F: dropping the artifact verification (existence, revision label, ancestry) is refused', () => {
  const noAncestry = swap(DEPLOY, '          git merge-base --is-ancestor "$rev" HEAD || { echo "refused: revision $rev is not an ancestor of main" >&2; exit 1; }\n', '');
  assert.match(checkDigestDeployFor('d.yml', noAncestry, AUTH).join(), /revision label checked as an ancestor of main/);
});

test('G: the digest deployment keeps the production queue, never cancels, main only, typed confirmation, read-only packages', () => {
  const noQueue = swap(DEPLOY, `    concurrency:
      group: production-deploy-core-api
      cancel-in-progress: false
`, '');
  assert.match(checkWorkflowSafety('d.yml', noQueue).join(), /has no concurrency group/);
  assert.match(checkWorkflowSafety('d.yml', swap(DEPLOY, '      cancel-in-progress: false\n', '      cancel-in-progress: true\n')).join(), /cancel-in-progress must be explicitly false/);
  const noConfirm = swap(DEPLOY, " && inputs.confirm == 'deploy auth-service'", '');
  assert.match(checkDigestDeployFor('d.yml', noConfirm, AUTH).join(), /typed confirmation/);
  assert.match(checkDigestDeployFor('d.yml', swap(DEPLOY, '      packages: read', '      packages: write'), AUTH).join(), /packages/);
  assert.match(checkDigestDeployFor('d.yml', swap(DEPLOY, '  workflow_dispatch:\n', '  push:\n    branches: [main]\n  workflow_dispatch:\n'), AUTH).join(), /workflow_dispatch only/);
  const optional = swap(DEPLOY, 'sha256:<64 hex>, from a build-image run summary)"\n        required: true', 'sha256:<64 hex>, from a build-image run summary)"\n        required: false');
  assert.match(checkDigestDeployFor('d.yml', optional, AUTH).join(), /"digest" input must exist and be required/);
});

test('I: the digest deployment keeps set -euo pipefail and no secret in the remote script', () => {
  assert.match(checkWorkflowSafety('d.yml', swap(DEPLOY, '            set -euo pipefail\n            trap', '            trap')).join(), /must start with "set -euo pipefail"/);
  assert.match(checkWorkflowSafety('d.yml', swap(DEPLOY, 'docker login ghcr.io -u "$GITHUB_ACTOR"', 'docker login ghcr.io -u ${{ secrets.DEPLOY_SSH_USER }}')).join(), /secret is interpolated/);
});

// ------------------------------------------------------------------------------ V2-A.3 (A3.2): the stable aggregate check
const CORE_CI = workflow('core-ci.yml');
const NEEDS_LINE = '    needs: [repo-checks, node, images, infra, e2e-real-broker, e2e-auth-organization, e2e-shared-platform]\n';

test('core-ci-passed: the real Core CI workflow has the aggregate, needing every other job', () => {
  assert.deepEqual(checkCiAggregate('core-ci.yml', CORE_CI), []);
  const jobs = parse(CORE_CI).jobs;
  assert.deepEqual([...jobs[CI_AGGREGATE].needs].sort(), Object.keys(jobs).filter((id) => id !== CI_AGGREGATE).sort());
  assert.equal(jobs[CI_AGGREGATE].name, 'core-ci-passed');
});

test('core-ci-passed: removing the aggregate, renaming it or making it a matrix is refused', () => {
  const without = CORE_CI.slice(0, CORE_CI.indexOf('  core-ci-passed:\n'));
  assert.match(checkCiAggregate('core-ci.yml', without).join(), /aggregate job "core-ci-passed" is missing/);
  assert.match(checkCiAggregate('core-ci.yml', swap(CORE_CI, '    name: core-ci-passed\n', '    name: all green\n')).join(), /name must be exactly "core-ci-passed"/);
  const matrix = swap(CORE_CI, '    name: core-ci-passed\n', '    name: core-ci-passed\n    strategy:\n      matrix:\n        n: [1, 2]\n');
  assert.match(checkCiAggregate('core-ci.yml', matrix).join(), /must not be a matrix/);
});

test('core-ci-passed: dropping any needed job, or adding a job it does not need, is refused', () => {
  for (const id of ['repo-checks', 'node', 'images', 'infra', 'e2e-real-broker', 'e2e-auth-organization', 'e2e-shared-platform']) {
    const dropped = swap(CORE_CI, NEEDS_LINE, NEEDS_LINE.replace(new RegExp(`${id}(, )?`), '').replace(', ]', ']'));
    assert.match(checkCiAggregate('core-ci.yml', dropped).join(), new RegExp(`missing: ${id}`), id);
  }
  const added = swap(CORE_CI, '  core-ci-passed:\n', '  new-suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n\n  core-ci-passed:\n');
  assert.match(checkCiAggregate('core-ci.yml', added).join(), /missing: new-suite/);
});

test('core-ci-passed: it must always run (a skipped required check counts as passed)', () => {
  assert.match(checkCiAggregate('core-ci.yml', swap(CORE_CI, '    if: always()\n', '')).join(), /must have "if: always\(\)"/);
  for (const weaker of ['success()', '!cancelled()', "always() && github.event_name == 'push'"]) {
    assert.match(checkCiAggregate('core-ci.yml', swap(CORE_CI, '    if: always()\n', `    if: ${weaker}\n`)).join(), /must have "if: always\(\)"/, weaker);
  }
  assert.deepEqual(checkCiAggregate('core-ci.yml', swap(CORE_CI, '    if: always()\n', '    if: ${{ always() }}\n')), []);
});

test('core-ci-passed: weakening the verdict is refused', () => {
  const RULE = `all(.[]; .result == "success")`;
  for (const weaker of ['any(.[]; .result == "success")', 'all(.[]; .result != "failure")', 'all(.[]; .result == "success" or .result == "skipped")']) {
    assert.match(checkCiAggregate('core-ci.yml', swap(CORE_CI, RULE, weaker)).join(), /exactly one step must decide/, weaker);
  }
  const swallowed = swap(CORE_CI, `|| { echo "core-ci-passed: at least one Core CI job did not succeed" >&2; exit 1; }`, '|| true');
  assert.match(checkCiAggregate('core-ci.yml', swallowed).join(), /swallows its failure/);
  const soft = swap(CORE_CI, '      - name: every Core CI job succeeded\n', '      - name: every Core CI job succeeded\n        continue-on-error: true\n');
  assert.match(checkCiAggregate('core-ci.yml', soft).join(), /must not be conditional or continue on error/);
  const softJob = swap(CORE_CI, '  infra:\n', '  infra:\n    continue-on-error: true\n');
  assert.match(checkCiAggregate('core-ci.yml', softJob).join(), /job "infra": must not set continue-on-error/);
  const otherSource = swap(CORE_CI, 'NEEDS: ${{ toJSON(needs) }}', 'NEEDS: ${{ toJSON(needs.node) }}');
  assert.match(checkCiAggregate('core-ci.yml', otherSource).join(), /exactly one step must decide/);
});

test('core-ci-passed: Core CI must report on every pull request to main (no path filter)', () => {
  for (const filter of ["    paths:\n      - 'apps/**'\n", "    paths-ignore:\n      - 'docs/**'\n"]) {
    const filtered = swap(CORE_CI, '  pull_request:\n    branches: [main]\n', `  pull_request:\n    branches: [main]\n${filter}`);
    assert.match(checkCiAggregate('core-ci.yml', filtered).join(), /must have no paths(-ignore)? filter/);
  }
  assert.match(checkCiAggregate('core-ci.yml', swap(CORE_CI, '  pull_request:\n    branches: [main]\n', '')).join(), /must run on pull_request/);
});

test('core-ci-passed: the REAL deciding step passes only when every needed job succeeded', () => {
  const step = parse(CORE_CI).jobs[CI_AGGREGATE].steps.find((s) => s.name === 'every Core CI job succeeded');
  const ids = parse(CORE_CI).jobs[CI_AGGREGATE].needs;
  const decide = (results) => spawnSync('bash', ['-c', step.run], { env: { PATH: process.env.PATH, NEEDS: JSON.stringify(results) }, encoding: 'utf8' });
  const all = (result, over = {}) => Object.fromEntries(ids.map((id) => [id, { result: over[id] ?? result, outputs: {} }]));
  const green = decide(all('success'));
  assert.equal(green.status, 0, green.stderr);
  for (const id of ids) assert.match(green.stdout, new RegExp(`^${id}: success$`, 'm'));
  for (const bad of ['failure', 'cancelled', 'skipped']) {
    for (const id of ids) assert.notEqual(decide(all('success', { [id]: bad })).status, 0, `${id}=${bad} was accepted`);
  }
  assert.notEqual(decide({}).status, 0, 'an empty needs context was accepted');
  assert.notEqual(spawnSync('bash', ['-c', step.run], { env: { PATH: process.env.PATH, NEEDS: 'not json' }, encoding: 'utf8' }).status, 0);
});

// --------------------------------------------------------------------------------- V2 A0: immutable builds, digest deployments
const IMAGE_BUILD_FILES = {
  'auth-service-docker-build.yml': { repository: 'nawara-core-auth-service', app: 'auth-service' },
  'organization-service-image.yml': { repository: 'nawara-core-organization-service', app: 'organization-service' },
  'audit-service-image.yml': { repository: 'nawara-core-audit-service', app: 'audit-service' },
};
const DEPLOY_FILES = {
  'auth-service-deploy.yml': ['nawara-core-auth-service', 'deploy auth-service'],
  'organization-service-deploy.yml': ['nawara-core-organization-service', 'deploy organization-service'],
  'audit-service-deploy.yml': ['nawara-core-audit-service', 'deploy audit-service'],
};
const ORG_IMAGE = workflow('organization-service-image.yml');
const ORG_IMAGE_CFG = IMAGE_BUILD_FILES['organization-service-image.yml'];

test('A0/A14: the three real image builds satisfy the immutable-build contract (push-only; provenance, SBOM, attestation)', () => {
  for (const [name, cfg] of Object.entries(IMAGE_BUILD_FILES)) {
    assert.deepEqual(checkImageBuild(name, workflow(name), cfg), [], name);
    assert.deepEqual(checkWorkflowSafety(name, workflow(name)), [], name);
  }
});

test('A0: every image input is a trigger path, including libs/audit-contract, .dockerignore and the workflow itself', () => {
  for (const [name, cfg] of Object.entries(IMAGE_BUILD_FILES)) {
    for (const input of ["      - 'libs/audit-contract/**'\n", "      - '.dockerignore'\n", `      - '.github/workflows/${name}'\n`, `      - 'apps/${cfg.app}/**'\n`]) {
      const text = workflow(name);
      const idx = text.indexOf(input, text.indexOf('  push:'));
      assert.ok(idx > 0, `${name}: ${input.trim()} not in push paths`);
      const without = text.slice(0, idx) + text.slice(idx + input.length);
      assert.match(checkImageBuild(name, without, cfg).join(), /push paths must include every image input/, `${name} ${input.trim()}`);
    }
  }
});

test('A0: the image build publishes only the immutable sha tag, with both labels and a validated digest', () => {
  const C = ORG_IMAGE_CFG;
  for (const tag of ['latest', 'production', 'main']) {
    const bad = swap(ORG_IMAGE, 'tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}', `tags: \${{ env.IMAGE_NAME }}:${tag}`);
    assert.match(checkImageBuild('o.yml', bad, C).join(), /the only tag must be/, tag);
  }
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '            org.opencontainers.image.revision=${{ github.sha }}\n', ''), C).join(), /revision=\$\{\{ github\.sha \}\} is required/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, 'org.opencontainers.image.revision=${{ github.sha }}', 'org.opencontainers.image.revision=main'), C).join(), /revision=\$\{\{ github\.sha \}\} is required/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '            org.opencontainers.image.source=', '            org.example.source='), C).join(), /image\.source is required/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '      - id: build\n', '      - id: image\n'), C).join(), /must have id: build/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]', '[[ -n "$DIGEST" ]]'), C).join(), /must be captured and validated/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '/nawara-core-organization-service\n', '/nawara-core-auth-service\n'), C).join(), /IMAGE_NAME must be/);
});

test('A0: an image build never deploys (no environment, credentials, SSH or production queue) and runs only on push to main', () => {
  const C = ORG_IMAGE_CFG;
  const withEnv = swap(ORG_IMAGE, '  build-image:\n', '  build-image:\n    environment: production\n');
  assert.match(checkImageBuild('o.yml', withEnv, C).join(), /must not declare an environment/);
  const creds = swap(ORG_IMAGE, '          TAG: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}\n', '          TAG: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}\n          H: ${{ secrets.DEPLOY_SSH_HOST }}\n');
  assert.match(checkImageBuild('o.yml', creds, C).join(), /must not use production SSH or the DEPLOY_SSH_\* credentials/);
  const ssh = ORG_IMAGE + "      - uses: appleboy/ssh-action@v1\n        with:\n          script: |\n            set -euo pipefail\n            true\n";
  assert.match(checkImageBuild('o.yml', ssh, C).join(), /must not use production SSH/);
  const queued = swap(ORG_IMAGE, '  build-image:\n', `  build-image:\n    concurrency:\n      group: ${PRODUCTION_GROUP}\n      cancel-in-progress: false\n`);
  assert.match(checkImageBuild('o.yml', queued, C).join(), /must not join the production queue/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, '    branches: [main]\n', '    branches: [main, develop]\n'), C).join(), /push to main only/);
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, 'on:\n  push:\n', 'on:\n  workflow_dispatch:\n  push:\n'), C).join(), /never on workflow_dispatch/);
});

test('A14 (D3): the Auth image workflow never publishes from a pull request: a PR trigger or a second (develop) job is refused', () => {
  const AUTH_BUILD = workflow('auth-service-docker-build.yml');
  const C = IMAGE_BUILD_FILES['auth-service-docker-build.yml'];
  assert.doesNotMatch(AUTH_BUILD, /pull_request|build-develop|:develop/, 'no PR publication path remains');
  const prTrigger = swap(AUTH_BUILD, 'on:\n  push:\n', "on:\n  pull_request:\n    branches: [main]\n  push:\n");
  assert.match(checkImageBuild('a.yml', prTrigger, C).join(), /never on pull_request/);
  const developJob = swap(AUTH_BUILD, 'jobs:\n', `jobs:\n  build-develop:\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: write\n    steps:\n      - uses: docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0\n        with:\n          push: true\n          tags: \${{ env.IMAGE_NAME }}:develop\n`);
  const msgs = checkImageBuild('a.yml', developJob, C).join();
  assert.match(msgs, /exactly one job, build-image/);
});

test('A0: Organization and Audit deploy exactly a verified digest (same contract as Auth)', () => {
  for (const [name, [repository, phrase]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name);
    assert.deepEqual(checkDigestDeployFor(name, text, repository), [], name);
    assert.deepEqual(checkTypedConfirmation(name, text, phrase), [], name);
    assert.deepEqual(checkWorkflowSafety(name, text), [], name);
  }
  const ORG = workflow('organization-service-deploy.yml');
  const rebuild = swap(ORG, '      - uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5', '      - uses: docker/build-push-action@v7\n        with:\n          push: true\n          tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}\n      - uses: appleboy/ssh-action@v1');
  assert.match(checkDigestDeployFor('o.yml', rebuild, 'nawara-core-organization-service').join(), /must never build an image/);
  assert.match(checkDigestDeployFor('o.yml', ORG, 'nawara-core-audit-service').join(), /IMAGE_NAME must be fixed to the nawara-core-audit-service repository/);
  // verify's confirmation is enforced by the digest-deploy contract; deploy's (the production job) by the typed-confirmation contract
  const noConfirmVerify = swap(ORG, " && inputs.confirm == 'deploy organization-service'", '');
  assert.match(checkDigestDeployFor('o.yml', noConfirmVerify, 'nawara-core-organization-service').join(), /job "verify": must require the typed confirmation/);
  const deployIf = "  deploy:\n    needs: verify\n    if: github.ref == 'refs/heads/main' && inputs.confirm == 'deploy organization-service'\n";
  const noConfirmDeploy = swap(ORG, deployIf, "  deploy:\n    needs: verify\n    if: github.ref == 'refs/heads/main'\n");
  assert.match(checkTypedConfirmation('o.yml', noConfirmDeploy, 'deploy organization-service').join(), /job "deploy": must require the typed confirmation/);
  assert.match(checkTypedConfirmation('o.yml', ORG, 'deploy audit-service').join(), /must require the typed confirmation \(inputs\.confirm == 'deploy audit-service'\)/);
});

test('A0.3 (D9): every digest deployment refuses a revision that is not a literal commit SHA before the ancestry check', () => {
  const LABEL_CHECK = '          [[ "$rev" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: no org.opencontainers.image.revision label (not a build-image artifact)" >&2; exit 1; }\n';
  for (const [name, [repository]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name);
    assert.deepEqual(checkDigestDeployFor(name, text, repository), [], name);
    // D9: the label is still extracted (the label name stays in the step) and the ancestry check stays, but the format check is gone
    const removed = swap(text, LABEL_CHECK, '');
    assert.ok(removed.includes('org.opencontainers.image.revision') && removed.includes('merge-base --is-ancestor'), name);
    assert.match(checkDigestDeployFor(name, removed, repository).join(), /must be refused unless it matches \^\[0-9a-f\]\{40\}\$/, `${name}: D9`);
    // weakened variants: a looser pattern, no refusal, or the check placed after the ancestry check
    for (const weaker of [
      LABEL_CHECK.replace('{40}', '+'),
      LABEL_CHECK.replace(' >&2; exit 1; }', ' >&2; }'),
    ]) {
      assert.match(checkDigestDeployFor(name, swap(text, LABEL_CHECK, weaker), repository).join(), /must be refused unless it matches/, `${name}: weaker`);
    }
    const ANC = '          git merge-base --is-ancestor "$rev" HEAD || { echo "refused: revision $rev is not an ancestor of main" >&2; exit 1; }\n';
    const after = swap(swap(text, LABEL_CHECK, ''), ANC, ANC + LABEL_CHECK);
    assert.match(checkDigestDeployFor(name, after, repository).join(), /before the ancestry check/, `${name}: order`);
  }
});

test('CI coverage: every claimed check must be an actual step', () => {
  const full = `
name: ci
permissions:
  contents: read
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint -w x
      - run: npm run typecheck -w x
      - run: npm test -w x
      - run: npm run build -w x
      - run: npm run check:repo
`;
  assert.deepEqual(checkCiCoverage('core-ci.yml', full), []);
  assert.match(checkCiCoverage('core-ci.yml', full.replace('      - run: npm run typecheck -w x\n', '')).join(), /no step runs typecheck/);
  assert.match(checkCiCoverage('core-ci.yml', full.replace('permissions:\n  contents: read\n', '')).join(), /permissions/);
});

test('V2 A12.2: only the kit metrics module may import the metrics client library', () => {
  const home = 'libs/service-kit/src/metrics/prom.ts';
  for (const spec of ["export { Counter } from 'prom-client';", "import client from 'prom-client';", "import { Registry } from '@prometheus-io/client';"]) {
    assert.deepEqual(checkMetricsClientImport(home, spec), [], spec);
    assert.deepEqual(checkSource('libs/service-kit/src/metrics/metrics.ts', spec), [], spec);
  }
  const refused = [
    "import { Counter } from 'prom-client';",
    "import client from \"prom-client\";",
    "import 'prom-client';",
    "const c = await import('prom-client');",
    "const c = require('prom-client');",
    "import { Histogram } from 'prom-client/lib/histogram';",
    "import { Registry } from '@prometheus-io/client';",
    "export { Gauge } from 'prom-client';",
  ];
  for (const where of ['libs/service-kit/src/bootstrap.ts', 'libs/service-kit/src/health/x.ts', 'libs/service-kit/test/x.spec.ts', 'apps/auth-service/src/main.ts', 'apps/billing-service/test/x.e2e-spec.ts', 'libs/audit-contract/src/x.ts']) {
    for (const spec of refused) {
      assert.match(checkMetricsClientImport(where, spec).join(), /imports the metrics client library/, `${where}: ${spec}`);
      assert.match(checkSource(where, spec).join(), /imports the metrics client library/, `${where}: ${spec}`);
    }
  }
  // not an import: a comment, a string, a lookalike package
  for (const text of ["// import { Counter } from 'prom-client';", "/* require('prom-client') */", "const s = 'prom-client is replaced';", "import x from 'prom-client-extra';", "import x from 'my-prom-client';"]) {
    assert.deepEqual(checkMetricsClientImport('apps/auth-service/src/main.ts', text), [], text);
  }
});

test('V2 A12.2a: the metrics-client guard is syntax-aware (security review H-1)', () => {
  const where = 'apps/billing-service/src/x.ts';
  const refused = {
    'default': "import x from 'prom-client';",
    'named': "import { Counter } from 'prom-client';",
    'namespace': "import * as x from 'prom-client';",
    'side effect': "import 'prom-client';",
    'type only': "import type { Registry } from 'prom-client';",
    'export star': "export * from 'prom-client';",
    'export named': "export { Counter } from 'prom-client';",
    'require': "const p = require('prom-client');",
    'require template, spaced': 'const p = require (`prom-client`);',
    'module.require': "const p = module.require('prom-client');",
    'dynamic import': "const p = await import('prom-client');",
    'dynamic import template, spaced': 'const p = await import (`prom-client`);',
    'dynamic import template': 'const p = await import(`prom-client`);',
    'require template': 'const p = require(`prom-client`);',
    'subpath': "import h from 'prom-client/lib/histogram.js';",
    'successor': "import { Registry } from '@prometheus-io/client';",
    'successor subpath': "const r = require('@prometheus-io/client/lib/registry');",
    'createRequire, direct': "import { createRequire } from 'node:module';\nconst p = createRequire(import.meta.url)('prom-client');",
    'createRequire, through a variable': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nconst p = r(`prom-client`);",
    'require.resolve': "const where = require.resolve('prom-client');",
    'import x = require()': "import p = require('prom-client');",
    'import type node': "type R = import('prom-client').Registry;",
    'escaped specifier': "const p = require('prom\\u002dclient');",
    'multiline': "import {\n  Counter,\n  Gauge,\n}\nfrom\n  'prom-client';",
    'comments around': "/* metrics */ import { Counter } from /* x */ 'prom-client'; // y",
    '"//" inside a string before it': "const s = \"a//b\"; import { Counter } from 'prom-client';",
    "'//' and `//` inside strings": "const a = 'x//y', b = `u//v`; const p = require('prom-client');",
    'glob-like strings around it': "const a = 'apps/*/src';\nimport { Counter } from 'prom-client';\nconst b = 'lib/**/x';",
    'comment-like template around it': "const a = `/*`;\nconst p = await import('prom-client');\nconst b = `*/`;",
  };
  for (const [label, text] of Object.entries(refused)) {
    for (const file of [where, 'libs/service-kit/test/x.spec.ts', 'scripts/x.mjs'.replace('scripts/', 'libs/service-kit/src/'), 'apps/auth-service/src/main.js']) {
      assert.match(checkMetricsClientImport(file, text).join(), /imports the metrics client library/, `${label} in ${file}`);
    }
    assert.match(checkSource(where, text).join(), /imports the metrics client library/, label);
  }
  const allowed = {
    'line comment': "// import { Counter } from 'prom-client';",
    'block comment': "/* const p = require('prom-client'); */",
    'JSDoc mention': "/** Uses prom-client through the kit only. */\nexport const x = 1;",
    'plain string': "const s = 'prom-client';",
    'string in an ordinary call': "console.log('prom-client is replaced by @prometheus-io/client');",
    'template string': 'const s = `prom-client`;',
    'lookalikes': "import x from 'prom-client-extra'; import y from 'my-prom-client'; const z = require('@prometheus-io/clientele');",
    'unrelated createRequire use': "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nconst pg = r('pg');",
  };
  for (const [label, text] of Object.entries(allowed)) assert.deepEqual(checkMetricsClientImport(where, text), [], label);
  assert.deepEqual(checkMetricsClientImport('libs/service-kit/src/metrics/prom.ts', refused.named), []);
  assert.deepEqual(checkMetricsClientImport('apps/billing-service/db/migrations/0001_x.sql', "-- from 'prom-client'"), []);
  assert.deepEqual(metricsClientReferences(where, refused['createRequire, through a variable']), ['prom-client']);
  // Documented owner-review boundary (not statically decidable): a fully computed specifier.
  assert.deepEqual(checkMetricsClientImport(where, "const n = 'prom-' + 'client'; await import(n);"), []);
});

/**
 * V2 A12.2a / A4.4 (security review P4): the HTTP pipeline installs, in this order and adjacent, shutdown admission, the request context,
 * the metrics foundation and helmet. Since A4.4 the order lives in the kit's `configureApp` (every service), Auth's `main.ts` calls only
 * `configureAuthApp`, and `configureAuthApp` calls only `configureApp` (then the docs). Each check reads the named function's own
 * statements (TypeScript AST), never text elsewhere in the file. Returns the violations (empty when P4 holds).
 */
function p4Problems({ main, authApp, kit }) {
  const statementsOf = (text, name) => {
    const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fn = sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === name);
    return fn?.body ? fn.body.statements.filter(ts.isExpressionStatement).map((st) => st.expression.getText(sf).replace(/\s+/g, ' ')) : undefined;
  };
  const problems = [];
  const boot = statementsOf(main, 'bootstrap');
  if (!boot) problems.push('main.ts: bootstrap() not found');
  else {
    const configured = boot.indexOf('configureAuthApp(app, cfg, logger)');
    const listening = boot.findIndex((c) => c.startsWith('await app.listen('));
    if (configured < 0) problems.push('main.ts: bootstrap() does not call configureAuthApp(app, cfg, logger)');
    else if (listening >= 0 && listening < configured) problems.push('main.ts: bootstrap() listens before configureAuthApp');
    for (const c of boot) if (/^(app\.use\(|app\.useGlobal|app\.enableCors\(|installMetrics\(|configureApp\()/.test(c)) problems.push(`main.ts: bootstrap() wires the pipeline itself: ${c}`);
  }
  const auth = statementsOf(authApp, 'configureAuthApp');
  const expected = 'configureApp(app, authBaseConfig(cfg), logger, { exceptionFilter: new AuthExceptionFilter(logger), corsBeforeBodyParser: true, urlencodedBodies: true })';
  if (!auth) problems.push('configure-auth-app.ts: configureAuthApp() not found');
  else if (JSON.stringify(auth) !== JSON.stringify([expected, 'mountDocs(app, cfg)'])) {
    problems.push(`configure-auth-app.ts: configureAuthApp() must be exactly the kit's configureApp with Auth's options, then mountDocs: ${auth.join(' | ')}`);
  }
  const kitCalls = statementsOf(kit, 'configureApp');
  if (!kitCalls) problems.push('bootstrap.ts: configureApp() not found');
  else {
    const at = (prefix) => kitCalls.findIndex((c) => c.startsWith(prefix));
    const [shutdown, ctx, metrics, helmet] = [at('app.use(shutdownAdmission('), at('app.use(requestContextMiddleware)'), at('installMetrics(app, config, logger)'), at('app.use(helmet())')];
    if (shutdown < 0 || ctx !== shutdown + 1 || metrics !== ctx + 1 || helmet !== metrics + 1) {
      problems.push(`bootstrap.ts: configureApp() must run shutdown admission, request context, metrics, helmet in this order and adjacent: ${kitCalls.join(' | ')}`);
    }
    if (shutdown >= 0 && kitCalls.slice(0, shutdown).some((c) => c.startsWith('app.use('))) problems.push('bootstrap.ts: configureApp() installs middleware before shutdown admission');
  }
  return problems;
}

test('V2 A12.2a / A4.4: P4, the order shutdown admission, request context, metrics, helmet, holds for Auth through the kit (security review P4)', () => {
  const real = {
    main: readFileSync(new URL('../apps/auth-service/src/main.ts', import.meta.url), 'utf8'),
    authApp: readFileSync(new URL('../apps/auth-service/src/http/configure-auth-app.ts', import.meta.url), 'utf8'),
    kit: readFileSync(new URL('../libs/service-kit/src/bootstrap.ts', import.meta.url), 'utf8'),
  };
  assert.deepEqual(p4Problems(real), []);
  const swap = (text, a, b) => {
    const [ia, ib] = [text.indexOf(a), text.indexOf(b)];
    assert.ok(ia >= 0 && ib > ia, `fixture lines exist in order: ${a} / ${b}`);
    return text.slice(0, ia) + b + text.slice(ia + a.length, ib) + a + text.slice(ib + b.length);
  };
  const SHUTDOWN = 'app.use(shutdownAdmission(app.get(ShutdownState)));';
  const CTX = 'app.use(requestContextMiddleware);';
  const METRICS = 'installMetrics(app, config, logger);';
  const HELMET = 'app.use(helmet());';
  const broken = {
    'request context after metrics': { ...real, kit: swap(real.kit, CTX, METRICS) },
    'metrics before shutdown admission': { ...real, kit: swap(real.kit, SHUTDOWN, METRICS) },
    'helmet before metrics': { ...real, kit: swap(real.kit, METRICS, HELMET) },
    'another middleware before shutdown admission': { ...real, kit: real.kit.replace(SHUTDOWN, `app.use(cors());\n  ${SHUTDOWN}`) },
    'Auth bypasses configureAuthApp': { ...real, main: real.main.replace('configureAuthApp(app, cfg, logger);', 'configureApp(app, authBaseConfig(cfg), logger);') },
    'Auth wires a middleware itself': { ...real, main: real.main.replace('configureAuthApp(app, cfg, logger);', 'configureAuthApp(app, cfg, logger);\n  app.use(helmet());') },
    'Auth listens before configuring': { ...real, main: swap(real.main, 'configureAuthApp(app, cfg, logger);', 'await app.listen(cfg.port);') },
    'configureAuthApp bypasses configureApp': { ...real, authApp: real.authApp.replace(/configureApp\(app, authBaseConfig\(cfg\), logger, \{[^}]*\}\);/, 'app.use(helmet());') },
    'configureAuthApp drops an Auth option': { ...real, authApp: real.authApp.replace('corsBeforeBodyParser: true, ', '') },
    'configureAuthApp wires a middleware before configureApp': { ...real, authApp: real.authApp.replace('  configureApp(app, authBaseConfig', '  app.use(requestContextMiddleware);\n  configureApp(app, authBaseConfig') },
  };
  for (const [label, files] of Object.entries(broken)) {
    assert.notDeepEqual(JSON.stringify(files), JSON.stringify(real), `${label}: the fixture differs from the real files`);
    assert.ok(p4Problems(files).length > 0, `${label}: P4 must be reported`);
  }
});

test('architecture: product terms, financial declarations and cross-service imports are refused', () => {
  assert.deepEqual(checkSource('libs/service-kit/src/db/db.service.ts', 'export class DbService {}'), []);
  assert.match(checkSource('libs/service-kit/src/x.ts', '// a student pays').join(), /product-specific term/);
  // Stage 17.5: no invisible bidirectional control characters anywhere in source (escapes are fine).
  assert.match(checkSource('apps/file-service/src/x.ts', 'const s = "admin\u202E";').join(), /bidirectional control character/);
  assert.deepEqual(checkSource('apps/file-service/src/x.ts', 'const s = /[\\u202a-\\u202e]/;'), []);
  // Stage 17.3: a Core service's schema is checked like its source.
  assert.match(checkSource('apps/file-service/db/migrations/0002_x.sql', 'CREATE TABLE student_documents (id uuid);').join(), /product-specific term/);
  assert.match(checkSource('apps/file-service/db/migrations/0002_x.sql', 'ALTER TABLE file ADD COLUMN "instructorId" uuid;').join(), /product-specific term/);
  assert.deepEqual(checkSource('apps/file-service/db/migrations/0001_file_schema.sql', 'CREATE TABLE file (id uuid PRIMARY KEY);'), []);
  for (const shape of ['const driverPhoto = 1;', 'interface X { lessons: string[] }', 'type ClassroomId = string;', 'const vehicle_plate = 1;']) {
    assert.match(checkSource('apps/file-service/src/x.ts', shape).join(), /product-specific term/, shape);
  }
  assert.match(checkSource('libs/service-kit/src/x.ts', 'export interface Invoice { id: string }').join(), /financial-domain concept/);
  assert.deepEqual(checkSource('libs/service-kit/src/service-auth/auth-client.ts', 'export interface AuthMembership { organization: {id: string} }'), []);
  assert.match(checkSource('apps/payment-service/src/a.ts', "import { X } from '../../billing-service/src/x.js';").join(), /another service's source/);
  assert.match(checkSource('apps/payment-service/src/a.ts', "import { X } from '../../../apps/billing-service/src/x.js';").join(), /another service's source/);
  assert.deepEqual(checkSource('apps/payment-service/src/a.ts', "import { X } from './x.js'; import { Y } from '@nawara/service-kit';"), []);
});

test('architecture: organization-service is held to the same generic-Core and no-cross-service-import rules', () => {
  assert.match(checkSource('apps/organization-service/src/a.ts', '// a student joins').join(), /product-specific term/);
  assert.match(checkSource('apps/organization-service/src/a.ts', "import { X } from '../../auth-service/src/x.js';").join(), /another service's source/);
  assert.match(checkSource('apps/organization-service/src/a.ts', "import { X } from '../../../apps/billing-service/src/x.js';").join(), /another service's source/);
  assert.deepEqual(checkSource('apps/organization-service/src/a.ts', "import { X } from './x.js'; import { Y } from '@nawara/service-kit';"), []);
});

test('architecture: the audit contract dependency direction (Stage 18.4)', () => {
  const imp = (spec) => `import { X } from '${spec}';`;
  assert.match(checkSource('libs/service-kit/src/events/x.ts', imp('@nawara/audit-contract')).join(), /must not depend on the audit contract/);
  assert.match(checkSource('libs/audit-contract/src/catalog.ts', imp('@nawara/service-kit')).join(), /no runtime dependency/);
  assert.match(checkSource('libs/audit-contract/src/catalog.ts', imp('node:crypto')).join(), /no runtime dependency/);
  assert.deepEqual(checkSource('libs/audit-contract/src/validate.ts', imp('./catalog.js')), []);
  assert.deepEqual(checkSource('libs/audit-contract/test/outbox.int-spec.ts', imp('@nawara/service-kit')), []);
  assert.match(checkSource('apps/billing-service/src/x.ts', imp('@nawara/audit-contract/consumer')).join(), /only audit-service may use the audit consumer API/);
  assert.deepEqual(checkSource('apps/audit-service/src/persistence/m.ts', imp('@nawara/audit-contract/consumer')), []);
  assert.deepEqual(checkSource('apps/billing-service/src/x.ts', imp('@nawara/audit-contract')), []);
  assert.match(checkSource('apps/file-service/src/x.ts', imp('@nawara/audit-contract/testing')).join(), /test tooling/);
  assert.deepEqual(checkSource('apps/audit-service/test/a.e2e-spec.ts', imp('@nawara/audit-contract/testing')), []);
  assert.deepEqual(checkSource('apps/audit-service/src/persistence/m.spec.ts', imp('@nawara/audit-contract/testing')), []);
  assert.match(checkSource('libs/audit-contract/src/catalog.ts', "'lesson.booked': {}").join(), /product-specific term/);
  assert.match(checkSource('apps/payment-service/src/a.ts', imp('../../../apps/audit-service/src/persistence/audit-record.mapper.js')).join(), /another service's source/);
});

test('the hierarchy snapshot fixtures must exist and be byte-identical in auth-service and organization-service', () => {
  assert.deepEqual(checkHierarchyFixtures('{"a":1}\n', '{"a":1}\n'), []);
  assert.equal(checkHierarchyFixtures('{"a":1}\n', '{"a":2}\n').length, 1);
  assert.equal(checkHierarchyFixtures(undefined, '{"a":1}\n').length, 1);
  assert.equal(checkHierarchyFixtures('x', undefined).length, 1);
});

test('a financial record migration must not carry a platformId, while Billing platform currency configuration may', () => {
  assert.deepEqual(checkNoPlatformIdOnFinancialRecords('apps/billing-service/db/migrations/0003_invoice.sql', 'CREATE TABLE invoice ("organizationId" uuid);'), []);
  assert.equal(checkNoPlatformIdOnFinancialRecords('apps/billing-service/db/migrations/0003_invoice.sql', 'ALTER TABLE invoice ADD COLUMN "platformId" text;').length, 1);
  assert.equal(checkNoPlatformIdOnFinancialRecords('apps/payment-service/db/migrations/0002_payment.sql', 'CREATE TABLE payment (platform_id uuid);').length, 1);
  assert.deepEqual(checkNoPlatformIdOnFinancialRecords('apps/payment-service/db/migrations/0002_payment.sql', '-- no platformId here\nCREATE TABLE payment (id uuid);'), []);
  assert.deepEqual(checkNoPlatformIdOnFinancialRecords('apps/billing-service/db/migrations/0009_platform_currency.sql', 'CREATE TABLE platform_currency ("platformId" text);'), []);
});

test('auth-service business errors must go through errors.ts and carry a stable code (Stage 13.2)', () => {
  assert.deepEqual(checkAuthErrorCoverage('apps/auth-service/src/auth/auth.guard.ts', "import { unauthenticated } from '../errors.js';\nthrow unauthenticated();"), []);
  assert.match(
    checkAuthErrorCoverage('apps/auth-service/src/auth/auth.guard.ts', "throw new ForbiddenException('nope');").join(),
    /raw Nest HTTP exception class/,
  );
  assert.match(
    checkAuthErrorCoverage('apps/auth-service/src/auth/auth.service.ts', "throw new HttpException({ message: 'no code here' }, 401);").join(),
    /no "code" field/,
  );
  assert.deepEqual(
    checkAuthErrorCoverage('apps/auth-service/src/auth/auth.service.ts', "throw new HttpException({ reason: 'x', message: 'ok', code: 'session_ceiling_reached' }, 401);"),
    [],
  );
  // errors.ts itself defines authError() in terms of a raw HttpException: exempt, it is the one legitimate call site.
  assert.deepEqual(checkAuthErrorCoverage('apps/auth-service/src/errors.ts', "export function authError(status, code, message) { return new HttpException({ message, code }, status); }"), []);
  // health.controller.ts's readiness probe is infra, not a business error: allowlisted by file.
  assert.deepEqual(checkAuthErrorCoverage('apps/auth-service/src/health/health.controller.ts', "throw new ServiceUnavailableException({ status: 'unavailable' });"), []);
  // out of scope for this check entirely
  assert.deepEqual(checkAuthErrorCoverage('apps/payment-service/src/x.ts', "throw new ForbiddenException('nope');"), []);
});

test('Stage 21.C.2: only the reference-cache protocol may open Auth\'s hierarchy reference-write gate', () => {
  const opens = "import { withReferenceWrite } from '../hierarchy/hierarchy-authority.js';\nawait withReferenceWrite(q);";
  assert.deepEqual(checkSource('apps/auth-service/src/hierarchy/hierarchy-reference.ts', opens), []);
  assert.equal(checkSource('apps/auth-service/src/onboarding/onboarding.service.ts', opens).length, 1);
  assert.equal(checkSource('apps/auth-service/src/cli/owner-tools.ts', "await q.query(`SELECT set_config('nawara.reference_write', 'on', true)`);").length, 1);
});


// ================================================================================ V2 A14: supply chain and provenance
const ALL_WORKFLOWS = ['audit-service-deploy.yml', 'audit-service-image.yml', 'auth-db-credential-rotate.yml', 'auth-service-deploy.yml', 'auth-service-docker-build.yml', 'core-backup-scheduled.yml',
  'core-backup.yml', 'core-ci.yml', 'core-rabbitmq-provision.yml', 'organization-service-deploy.yml', 'organization-service-image.yml'];
const CHECKOUT_PIN = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';

test('A14 (D2): every external action in every workflow is pinned to a full SHA with its exact release comment', () => {
  for (const name of ALL_WORKFLOWS) assert.deepEqual(checkActionPins(name, workflow(name)), [], name);
  const local = "jobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: ./.github/actions/local\n";
  assert.deepEqual(checkActionPins('l.yml', local), [], 'a local ./ action is allowed');
});

test('A14 (D2): a major tag, version tag, branch, short SHA or missing version comment is refused', () => {
  const CI = workflow('core-ci.yml');
  for (const [label, to, re] of [
    ['major tag', 'actions/checkout@v7', /must be pinned to a full 40-hex commit SHA/],
    ['version tag', 'actions/checkout@v7.0.1', /must be pinned to a full 40-hex commit SHA/],
    ['branch', 'actions/checkout@main', /must be pinned to a full 40-hex commit SHA/],
    ['short SHA', 'actions/checkout@3d3c42e # v7.0.1', /must be pinned to a full 40-hex commit SHA/],
    ['no version comment', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', /must carry its exact release as a comment/],
    ['a vague comment', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7', /must carry its exact release as a comment/],
  ]) {
    const i = CI.indexOf(CHECKOUT_PIN);
    const bad = CI.slice(0, i) + to + CI.slice(i + CHECKOUT_PIN.length);
    assert.match(checkActionPins('core-ci.yml', bad).join(), re, label);
  }
});

const NODE_PIN = 'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';
const PG_PIN = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const DOCKERFILES = Object.fromEntries(['audit', 'auth', 'billing', 'file', 'notification', 'organization', 'payment', 'release']
  .map((s) => [`apps/${s}-service/Dockerfile`, readFileSync(new URL(`../apps/${s}-service/Dockerfile`, import.meta.url), 'utf8')]));
const DEPLOY_SCRIPTS = Object.fromEntries(['auth', 'organization', 'audit']
  .map((s) => [`apps/${s}-service/deploy/provision-and-deploy.sh`, readFileSync(new URL(`../apps/${s}-service/deploy/provision-and-deploy.sh`, import.meta.url), 'utf8')]));
const withFile = (set, path, fn) => ({ ...set, [path]: fn(set[path]) });

test('A14: the eight application Dockerfiles use the same pinned Node base; the three production PostgreSQL images are pinned and equal', () => {
  assert.deepEqual(checkImagePins(DOCKERFILES, DEPLOY_SCRIPTS), []);
  for (const text of Object.values(DOCKERFILES)) for (const l of text.split('\n').filter((x) => x.startsWith('FROM '))) assert.ok(l.includes(NODE_PIN), l);
  for (const text of Object.values(DEPLOY_SCRIPTS)) assert.match(text, new RegExp(`^DB_IMAGE=${PG_PIN.replace(/[.]/g, '\\.')}$`, 'm'));
});

test('A14: a floating or inconsistent Node base, or a floating or inconsistent production PostgreSQL image, is refused', () => {
  const F = 'apps/auth-service/Dockerfile'; const D = 'apps/audit-service/deploy/provision-and-deploy.sh';
  assert.match(checkImagePins(withFile(DOCKERFILES, F, (t) => t.replace(NODE_PIN, 'node:22-alpine')), DEPLOY_SCRIPTS).join(), /must be pinned as <image>:<tag>@sha256/);
  assert.match(checkImagePins(withFile(DOCKERFILES, F, (t) => t.replace(NODE_PIN, `node:22-alpine@sha256:${'1'.repeat(64)}`)), DEPLOY_SCRIPTS).join(), /must all use the same pinned base image/);
  assert.match(checkImagePins(withFile(DOCKERFILES, F, (t) => t.replaceAll(NODE_PIN, `node:24-alpine@sha256:${'1'.repeat(64)}`)), DEPLOY_SCRIPTS).join(), /same pinned base image|pinned node:22-alpine/);
  assert.match(checkImagePins(DOCKERFILES, withFile(DEPLOY_SCRIPTS, D, (t) => t.replace(PG_PIN, 'postgres:16-alpine'))).join(), /must be a pinned postgres/);
  assert.match(checkImagePins(DOCKERFILES, withFile(DEPLOY_SCRIPTS, D, (t) => t.replace(PG_PIN, `postgres:16-alpine@sha256:${'2'.repeat(64)}`))).join(), /must all use the same pinned PostgreSQL image/);
  assert.match(checkImagePins(DOCKERFILES, withFile(DEPLOY_SCRIPTS, D, (t) => t.replace(/^DB_IMAGE=.*$/m, ''))).join(), /no DB_IMAGE/);
});

const SBOM_LINE = '          attests: type=sbom,generator=docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9\n';
test('A14: each image build has provenance mode=max, a pinned SBOM generator and a GitHub attestation of the exact index digest', () => {
  for (const [name, cfg] of Object.entries(IMAGE_BUILD_FILES)) {
    const text = workflow(name);
    assert.deepEqual(checkImageBuild(name, text, cfg), [], name);
    for (const [label, from, to, re] of [
      ['SBOM removed', SBOM_LINE, '', /attests: type=sbom/],
      ['SBOM generator unpinned', SBOM_LINE, '          attests: type=sbom,generator=docker/buildkit-syft-scanner:stable-1\n', /attests: type=sbom/],
      ['plain sbom', SBOM_LINE, '          sbom: true\n', /attests: type=sbom/],
      ['provenance removed', '          provenance: mode=max\n', '', /provenance: mode=max/],
      ['provenance weakened', '          provenance: mode=max\n', '          provenance: mode=min\n', /provenance: mode=max/],
      ['attestation removed', '        uses: actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a # v3.0.0\n', '        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2\n', /attest-build-provenance step must attest/],
      ['subject name with a tag', '          subject-name: ${{ env.IMAGE_NAME }}\n', '          subject-name: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}\n', /subject-name must be exactly/],
      ['subject digest changed', '          subject-digest: ${{ steps.build.outputs.digest }}\n', '          subject-digest: ${{ inputs.digest }}\n', /subject-digest must be exactly/],
      ['not pushed to the registry', '          push-to-registry: true\n', '          push-to-registry: false\n', /pushed to the registry/],
      ['id-token removed', '      id-token: write\n', '', /needs id-token: write and attestations: write/],
      ['attestations removed', '      attestations: write\n', '', /needs id-token: write and attestations: write/],
    ]) assert.match(checkImageBuild(name, swap(text, from, to), cfg).join(), re, `${name}: ${label}`);
  }
  const atTop = swap(ORG_IMAGE, 'env:\n', 'permissions:\n  id-token: write\nenv:\n');
  assert.match(checkImageBuild('organization-service-image.yml', atTop, ORG_IMAGE_CFG).join(), /id-token: write must be granted to build-image only/);
});

test('A14: the deploy verifier requires the exact attestation identity; removing or loosening any part is refused', () => {
  for (const [name, [repository]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name); const wf = SIGNER[repository];
    assert.deepEqual(checkDigestDeployFor(name, text, repository), [], name);
    const cases = [
      ['verify removed', /          verified=\$\(gh attestation verify[\s\S]*?exit 1; \}\n/, '', /gh attestation verify|bind --source-digest/],
      ['wrong repository', '--repo nawara-solutions/nawara-core \\', '--repo nawara-solutions/other \\', /--repo nawara-solutions\/nawara-core/],
      ['wrong signer workflow', `--signer-workflow nawara-solutions/nawara-core/.github/workflows/${wf} \\`, '--signer-workflow nawara-solutions/nawara-core/.github/workflows/core-ci.yml \\', /--signer-workflow/],
      ['wrong source ref', '--source-ref refs/heads/main --source-digest', '--source-ref refs/heads/develop --source-digest', /--source-ref refs\/heads\/main/],
      ['source digest missing', ' --source-digest "$rev" \\', ' \\', /bind --source-digest/],
      ['source digest another variable', '--source-digest "$rev"', '--source-digest "$other"', /bind --source-digest/],
      ['wrong predicate', '--predicate-type https://slsa.dev/provenance/v1 --deny', '--predicate-type https://spdx.dev/Document --deny', /--predicate-type https:\/\/slsa\.dev\/provenance\/v1/],
      ['self-hosted allowed', ' --deny-self-hosted-runners', '', /--deny-self-hosted-runners/],
      ['not the exact digest', 'gh attestation verify "oci://$REF"', 'gh attestation verify "oci://$IMAGE_NAME:latest"', /the exact digest/],
      ['caller bundle', '--format json) \\', '--format json --bundle "$BUNDLE") \\', /caller-supplied bundle/],
      ['failure ignored', /\|\| \{ echo "refused: no trusted build provenance[^\n]*\n/, '|| true\n', /a failed gh attestation verify must refuse/],
      ['jq re-check removed', /          # Defence in depth[\s\S]*?does not describe \$REF as required" >&2; exit 1; \}\n/, '', /re-checked with jq -e/],
      ['jq failure ignored', /\|\| \{ echo "refused: the verified provenance[^\n]*\n/, '|| true\n', /a failed jq re-check must refuse/],
      ['jq signer loosened', '$c.buildSignerURI == $signer and ', '', /check the signer/],
      ['jq subject unchecked', ' and ([.verificationResult.statement.subject[]?.digest.sha256] | index($d) != null)', '', /signed subject digest/],
      ['attestations: read removed', '      attestations: read\n', '', /needs attestations: read/],
      ['GH_TOKEN removed', '          GH_TOKEN: ${{ github.token }}\n', '', /GH_TOKEN must be/],
    ];
    for (const [label, from, to, re] of cases) {
      const bad = from instanceof RegExp ? text.replace(from, to) : swap(text, from, to);
      assert.notEqual(bad, text, `${name}: ${label} (fixture)`);
      assert.match(checkDigestDeployFor(name, bad, repository).join(), re, `${name}: ${label}`);
    }
    const anc = text.match(/          git merge-base --is-ancestor[^\n]*\n/)[0];
    const moved = swap(text, anc, '').replace('          verified=$(gh attestation verify', `${anc}          verified=$(gh attestation verify`);
    assert.match(checkDigestDeployFor(name, moved, repository).join(), /after the literal-SHA check and before the ancestry check/, `${name}: verify after ancestry`);
    const signs = swap(text, '      attestations: read\n', '      attestations: write\n      id-token: write\n');
    assert.match(checkDigestDeployFor(name, signs, repository).join(), /a deployment never signs/, `${name}: signing permissions`);
  }
});

// ================================================================================ V2 A14.2a: strict-cutover bypasses (C1), SBOM generator (C2)
const GH_LINE = '          verified=$(gh attestation verify';
const before = (text, lines) => swap(text, GH_LINE, `${lines}\n${GH_LINE}`);
const CANON = /must equal the canonical verify job/;

test('A14.2a C1: the approved verifier of each service is accepted (C1-T7)', () => {
  for (const [name, [repository]] of Object.entries(DEPLOY_FILES)) assert.deepEqual(checkDigestDeployFor(name, workflow(name), repository), [], name);
});

test('A14.2a C1: no early success, allow-list, bypass variable or alternative path before the trust checks (C1-T1..T6 and beyond)', () => {
  for (const [name, [repository]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name);
    const cases = [
      // C1-T1..T6 (the A14.3 V27/V28 shapes and their generalizations)
      ['C1-T1 legacy digest allow-list', before(text, '          if [ "${REF##*@}" = "sha256:436b0797f62054399895066d4c13f3e39447a69c6e3636d4a54b9fdcaf4e54c0" ]; then\n            echo "revision=$rev" >>"$GITHUB_OUTPUT"\n            exit 0\n          fi'), CANON],
      ['C1-T2 bypass variable', before(text, '          if [ "${SKIP_PROVENANCE:-}" = "1" ]; then\n            echo "revision=$rev" >>"$GITHUB_OUTPUT"\n            exit 0\n          fi'), CANON],
      ['C1-T2 bypass variable (another name)', before(text, '          [ -z "${ALLOW_UNATTESTED:-}" ] || exit 0'), CANON],
      ['C1-T3 unconditional exit 0', before(text, '          exit 0'), CANON],
      ['C1-T3 bare exit', before(text, '          exit'), CANON],
      ['C1-T4 return from a function', before(text, '          check() { return 0; }\n          check && { echo "revision=$rev" >>"$GITHUB_OUTPUT"; }'), CANON],
      ['C1-T5 early GITHUB_OUTPUT write', before(text, '          echo "revision=$rev" >>"$GITHUB_OUTPUT"'), CANON],
      ['C1-T6 exec', before(text, '          exec true'), CANON],
      // the same invariant, shapes no string blacklist would catch (all missed before A14.2a)
      ['gh shadowed by a function', before(text, '          gh() { echo "[]"; }'), CANON],
      ['jq shadowed by a function', before(text, '          jq() { return 0; }'), CANON],
      ['PATH changed before gh', before(text, '          PATH="$RUNNER_TEMP/bin:$PATH"'), CANON],
      ['the gh call made conditional', swap(text, GH_LINE, '          [ -n "${X:-}" ] && verified=$(gh attestation verify'), CANON],
      ['set +e', before(text, '          set +e'), CANON],
      ['the artifact step skipped (if)', swap(text, '      - id: artifact\n', "      - id: artifact\n        if: inputs.digest != 'sha256:x'\n"), CANON],
      ['the artifact step allowed to fail', swap(text, '      - id: artifact\n', '      - id: artifact\n        continue-on-error: true\n'), CANON],
      ['the artifact step shell replaced', swap(text, '      - id: artifact\n', '      - id: artifact\n        shell: bash --noprofile --norc {0} || true\n'), CANON],
      ['the verify job allowed to fail', swap(text, '    outputs:\n      revision:', '    continue-on-error: true\n    outputs:\n      revision:'), CANON],
      ['BASH_ENV injected by an earlier step', swap(text, 'exit 1; }\n      - uses: docker/setup-buildx', 'exit 1; }\n          echo "BASH_ENV=/tmp/x" >>"$GITHUB_ENV"\n      - uses: docker/setup-buildx'), CANON],
      ['an extra step in verify', swap(text, '      - id: artifact\n', '      - run: echo "revision=0000000000000000000000000000000000000000" >>"$GITHUB_OUTPUT"\n      - id: artifact\n'), CANON],
      ['the job output taken from another step', swap(text, 'revision: ${{ steps.artifact.outputs.revision }}', 'revision: ${{ inputs.digest }}'), CANON],
      ['deploy runs whatever verify did (always())', swap(text, '    needs: verify\n    if: ', '    needs: verify\n    if: always() && '), /its condition must be exactly/],
      ['deploy runs unless cancelled', swap(text, '    needs: verify\n    if: ', '    needs: verify\n    if: ${{ !cancelled() }} && '), /its condition must be exactly/],
      ['workflow-level default shell', swap(text, '\nenv:\n', '\ndefaults:\n  run:\n    shell: bash {0}\nenv:\n'), /must not set workflow-level defaults/],
      ['workflow-level BASH_ENV', swap(text, '\nenv:\n', '\nenv:\n  BASH_ENV: /tmp/x\n'), /workflow-level env must be exactly IMAGE_NAME/],
      // preserved A14 detectors (A14.3 V2, V3b, V17 and identity changes) still fire, now alongside the canonical check
      ['|| true after gh', text.replace(/\|\| \{ echo "refused: no trusted build provenance[^\n]*/, '|| true'), /a failed gh attestation verify must refuse/],
      ['real suppression inside the substitution (V3b)', swap(text, ' --format json) \\', ' --format json; true) \\'), CANON],
      ['|| true after jq', text.replace(/\|\| \{ echo "refused: the verified provenance[^\n]*/, '|| true'), /a failed jq re-check must refuse/],
      ['identity changed', swap(text, '--source-ref refs/heads/main --source-digest', '--source-ref refs/heads/develop --source-digest'), /--source-ref refs\/heads\/main/],
      ['identity check removed', swap(text, ' and $c.sourceRepositoryDigest == $rev', ''), /the source commit/],
    ];
    for (const [label, bad, re] of cases) {
      assert.notEqual(bad, text, `${name}: ${label} (fixture)`);
      const problems = checkDigestDeployFor(name, bad, repository).join('\n');
      assert.match(problems, re, `${name}: ${label}`);
    }
    // A reviewed Dependabot SHA bump of an action in verify stays acceptable to the canonical check (checkActionPins still requires a full SHA).
    const bumped = swap(text, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', `actions/checkout@${'a'.repeat(40)} # v7.0.2`);
    assert.doesNotMatch(checkDigestDeployFor(name, bumped, repository).join(), CANON, `${name}: action SHA bump`);
    assert.match(checkDigestDeployFor(name, swap(text, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@v7'), repository).join(), CANON, `${name}: unpinned action in verify`);
  }
});

test('A14.2a C1: the verifier of one service cannot be swapped in for another (the canonical job binds service and signer)', () => {
  const auth = workflow('auth-service-deploy.yml');
  const orgVerify = workflow('organization-service-deploy.yml').match(/\n  verify:\n[\s\S]*?\n  deploy:\n/)[0];
  const mixed = auth.replace(/\n  verify:\n[\s\S]*?\n  deploy:\n/, orgVerify);
  assert.notEqual(mixed, auth);
  assert.match(checkDigestDeployFor('auth-service-deploy.yml', mixed, 'nawara-core-auth-service').join(), CANON);
});

const GENERATOR = 'docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9';
test('A14.2a C2: the SBOM generator is the exact frozen identity in Auth, Organization and Audit (C2-T1, C2-T7)', () => {
  assert.equal(SBOM_GENERATOR, GENERATOR);
  for (const [name, cfg] of Object.entries(IMAGE_BUILD_FILES)) {
    assert.ok(workflow(name).includes(`attests: type=sbom,generator=${GENERATOR}\n`), name);
    assert.deepEqual(checkImageBuild(name, workflow(name), cfg), [], name);
  }
});

test('A14.2a C2: another digest, another generator, a floating or missing generator, or one diverging service is refused (C2-T2..T6)', () => {
  const SBOM = /must set exactly attests: type=sbom,generator=docker\/buildkit-syft-scanner:1\.12\.0@sha256:ae4f3b55/;
  for (const [name, cfg] of Object.entries(IMAGE_BUILD_FILES)) {
    const text = workflow(name);
    for (const [label, to] of [
      ['C2-T2 same generator and version, another valid-looking digest', `docker/buildkit-syft-scanner:1.12.0@sha256:${'5'.repeat(64)}`],
      ['C2-T2 one hex digit changed', GENERATOR.slice(0, -1) + (GENERATOR.endsWith('9') ? '8' : '9')],
      ['C2-T3 another generator, pinned', `docker/buildkit-syft-scanner-fork:1.12.0@sha256:${'6'.repeat(64)}`],
      ['C2-T3 another registry, same digest', `ghcr.io/attacker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9`],
      ['another version, same digest', `docker/buildkit-syft-scanner:1.13.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9`],
      ['C2-T4 floating tag', 'docker/buildkit-syft-scanner:stable-1'],
      ['C2-T4 digest without the tag', 'docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9'],
    ]) assert.match(checkImageBuild(name, swap(text, GENERATOR, to), cfg).join(), SBOM, `${name}: ${label}`);
    assert.match(checkImageBuild(name, swap(text, `attests: type=sbom,generator=${GENERATOR}`, 'attests: type=sbom'), cfg).join(), SBOM, `${name}: C2-T5 generator omitted`);
    assert.match(checkImageBuild(name, swap(text, `          attests: type=sbom,generator=${GENERATOR}\n`, ''), cfg).join(), SBOM, `${name}: C2-T5 SBOM omitted`);
  }
  // C2-T6: only one service diverges; the other two stay accepted, the diverging one is refused.
  const results = Object.entries(IMAGE_BUILD_FILES).map(([name, cfg]) => checkImageBuild(name, name === 'organization-service-image.yml'
    ? swap(workflow(name), GENERATOR, `docker/buildkit-syft-scanner:1.12.0@sha256:${'7'.repeat(64)}`) : workflow(name), cfg));
  assert.deepEqual(results.map((p) => p.length > 0), Object.keys(IMAGE_BUILD_FILES).map((n) => n === 'organization-service-image.yml'));
});

// ---- V2 A12.5.1: local observability overlay ----------------------------------------------------------------------------------
{
  const BASE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const OVERLAY = readFileSync(new URL('../docker-compose.observability.yml', import.meta.url), 'utf8');
  const PROM = readFileSync(new URL('../infra/observability/prometheus/prometheus.yml', import.meta.url), 'utf8');
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);

  test('A12.5.1: the repository overlay, base file and scrape configuration pass', () => {
    assert.deepEqual(checkLocalObservability(BASE, OVERLAY, PROM), []);
  });
  test('A12.5.1: metrics enabled in the base file (map or list form) are refused: normal development stays off', () => {
    fails(checkLocalObservability(BASE.replace('      NODE_ENV: development\n', "      NODE_ENV: development\n      METRICS_ENABLED: 'true'\n"), OVERLAY, PROM), /docker-compose\.yml: .* sets METRICS_ENABLED/);
    fails(checkLocalObservability('services:\n  x:\n    environment:\n      - METRICS_ENABLED=true\n', OVERLAY, PROM), /x sets METRICS_ENABLED/);
  });
  test('A12.5.1: a published metrics listener is refused, in either file and either form', () => {
    fails(checkLocalObservability(BASE, OVERLAY.replace("    environment: *core-metrics\n  billing-service:", "    environment: *core-metrics\n    ports: ['127.0.0.1:9464:9464']\n  billing-service:"), PROM), /auth-service publishes the metrics listener/);
    fails(checkLocalObservability('services:\n  y:\n    ports:\n      - target: 9464\n        published: 19464\n', OVERLAY, PROM), /docker-compose\.yml: y publishes the metrics listener/);
  });
  test('A12.5.1: an unpinned image or a non-loopback port in the overlay is refused', () => {
    fails(checkLocalObservability(BASE, OVERLAY.replace(/prom\/prometheus:v[^\n]+/, 'prom/prometheus:latest'), PROM), /prometheus image prom\/prometheus:latest must be pinned/);
    fails(checkLocalObservability(BASE, OVERLAY.replace("'127.0.0.1:9090:9090'", "'9090:9090'"), PROM), /prometheus must publish ports on 127\.0\.0\.1 only/);
    fails(checkLocalObservability(BASE, OVERLAY.replace("'127.0.0.1:9090:9090'", "'0.0.0.0:9090:9090'"), PROM), /127\.0\.0\.1 only/);
  });
  test('A12.5.1: admin, lifecycle and remote-write-receiver flags, the Docker socket and privileged mode are refused', () => {
    for (const flag of ['--web.enable-admin-api', '--web.enable-lifecycle', '--web.enable-remote-write-receiver']) {
      fails(checkLocalObservability(BASE, OVERLAY.replace('      - --storage.tsdb.path=/prometheus\n', `      - --storage.tsdb.path=/prometheus\n      - ${flag}\n`), PROM), new RegExp(`must not run with ${flag}`));
    }
    fails(checkLocalObservability(BASE, OVERLAY.replace('      - nawara_prometheus_data:/prometheus\n', '      - nawara_prometheus_data:/prometheus\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n'), PROM), /must not mount the Docker socket/);
    fails(checkLocalObservability(BASE, OVERLAY.replace('    read_only: true\n', '    read_only: true\n    privileged: true\n'), PROM), /must not be privileged/);
  });
  test('A12.5.1: a credential or remote write in the scrape configuration is refused, and so is an empty or missing one', () => {
    fails(checkLocalObservability(BASE, OVERLAY, PROM.replace("  - job_name: auth-service\n", "  - job_name: auth-service\n    basic_auth: { username: u, password: p }\n")), /basic_auth is not allowed/);
    fails(checkLocalObservability(BASE, OVERLAY, PROM.replace("  - job_name: auth-service\n", "  - job_name: auth-service\n    authorization: { credentials: x }\n")), /authorization is not allowed/);
    fails(checkLocalObservability(BASE, OVERLAY, `${PROM}\nremote_write:\n  - url: http://example.invalid/write\n`), /remote_write is not allowed/);
    fails(checkLocalObservability(BASE, OVERLAY, 'global: {}\n'), /no scrape_configs/);
    fails(checkLocalObservability(BASE, OVERLAY.replace(/\n  prometheus:[\s\S]*?\nvolumes:/, '\nvolumes:'), PROM), /no prometheus service/);
  });
}

// ---- V2 A12.5.2: RabbitMQ native broker metrics ---------------------------------------------------------------------------------
{
  const BASE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const OVERLAY = readFileSync(new URL('../docker-compose.observability.yml', import.meta.url), 'utf8');
  const PROM = readFileSync(new URL('../infra/observability/prometheus/prometheus.yml', import.meta.url), 'utf8');
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);

  test('A12.5.2: publishing the RabbitMQ Prometheus endpoint (15692) is refused, in either file and either form', () => {
    fails(checkLocalObservability(BASE.replace("      - '127.0.0.1:15672:15672'\n", "      - '127.0.0.1:15672:15672'\n      - '127.0.0.1:15692:15692'\n"), OVERLAY, PROM), /docker-compose\.yml: rabbitmq publishes the metrics listener \(15692\)/);
    fails(checkLocalObservability(BASE, `${OVERLAY}\n`.replace('\nvolumes:\n', "\n  rabbitmq:\n    ports:\n      - target: 15692\n        published: 25692\n\nvolumes:\n"), PROM), /docker-compose\.observability\.yml: rabbitmq publishes the metrics listener \(15692\)/);
  });
  test('A12.5.2: the scrape configuration must keep every Core job and the rabbitmq job', () => {
    fails(checkLocalObservability(BASE, OVERLAY, PROM.replace(/\n  - job_name: rabbitmq\n[\s\S]*$/, '\n')), /no scrape job rabbitmq/);
    fails(checkLocalObservability(BASE, OVERLAY, PROM.replace("  - job_name: audit-service\n    static_configs:\n      - targets: ['audit-service:9464']\n", '')), /no scrape job audit-service/);
  });
}

// ---- V2 A12.5.3: PostgreSQL exporter --------------------------------------------------------------------------------------------
{
  const BASE = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const OVERLAY = readFileSync(new URL('../docker-compose.observability.yml', import.meta.url), 'utf8');
  const PROM = readFileSync(new URL('../infra/observability/prometheus/prometheus.yml', import.meta.url), 'utf8');
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  const PASS_LINE = '      DATA_SOURCE_PASS: ${MONITORING_PASSWORD:?copy .env.example to .env}\n';

  test('A12.5.3: publishing postgres-exporter (9187) is refused', () => {
    fails(checkLocalObservability(BASE, OVERLAY.replace('      - --no-collector.statio_user_indexes\n', "      - --no-collector.statio_user_indexes\n    ports: ['127.0.0.1:9187:9187']\n"), PROM), /postgres-exporter publishes the metrics listener \(9187\)/);
  });
  test('A12.5.3: the exporter must use the monitoring role with an interpolated password, never a URL credential', () => {
    fails(checkLocalObservability(BASE, OVERLAY.replace('DATA_SOURCE_USER: observability_monitor', 'DATA_SOURCE_USER: postgres'), PROM), /must connect as observability_monitor/);
    fails(checkLocalObservability(BASE, OVERLAY.replace('DATA_SOURCE_USER: observability_monitor', 'DATA_SOURCE_USER: auth_migrator'), PROM), /must connect as observability_monitor/);
    fails(checkLocalObservability(BASE, OVERLAY.replace(PASS_LINE, '      DATA_SOURCE_PASS: written-out-password\n'), PROM), /DATA_SOURCE_PASS must be interpolated/);
    fails(checkLocalObservability(BASE, OVERLAY.replace('DATA_SOURCE_URI: postgres:5432/postgres?sslmode=disable', 'DATA_SOURCE_URI: observability_monitor:pw@postgres:5432/postgres'), PROM), /must not embed credentials/);
    fails(checkLocalObservability(BASE, OVERLAY.replace(PASS_LINE, `${PASS_LINE}      DATA_SOURCE_NAME: postgresql://u:p@postgres:5432/postgres\n`), PROM), /must not use DATA_SOURCE_NAME/);
    fails(checkLocalObservability(BASE, OVERLAY.replace(/\n  postgres-exporter:[\s\S]*?\nvolumes:/, '\nvolumes:'), PROM), /no postgres-exporter service/);
  });
  test('A12.5.3: only the overlay may create the monitoring role; the postgres job is required', () => {
    fails(checkLocalObservability(BASE.replace('      POSTGRES_USER: postgres\n', '      POSTGRES_USER: postgres\n      MONITORING_PASSWORD: ${MONITORING_PASSWORD:-}\n'), OVERLAY, PROM), /postgres must not receive MONITORING_PASSWORD/);
    fails(checkLocalObservability(BASE, OVERLAY, PROM.replace(/\n  - job_name: postgres\n[\s\S]*$/, '\n')), /no scrape job postgres/);
  });
}

// ---- V2 A12.6.1: local Grafana --------------------------------------------------------------------------------------------------
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const OVERLAY = read('docker-compose.observability.yml');
  const DS = read('infra/observability/grafana/provisioning/datasources/prometheus.yml');
  const PV = read('infra/observability/grafana/provisioning/dashboards/nawara-core.yml');
  const OVERVIEW_PATH = 'infra/observability/grafana/dashboards/nawara-core/core-overview.json';
  const OVERVIEW = read(OVERVIEW_PATH);
  const ENV = read('.env.example');
  const DASH_DIR = 'infra/observability/grafana/dashboards/nawara-core';
  const DASH = Object.fromEntries(['core-overview', 'core-service', 'core-messaging', 'core-postgresql'].map((n) => [`${DASH_DIR}/${n}.json`, read(`${DASH_DIR}/${n}.json`)]));
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  const check = ({ overlay = OVERLAY, ds = DS, pv = PV, dash = DASH, env = ENV } = {}) => checkLocalGrafana(overlay, ds, pv, dash, env);
  const grafanaEnv = (from, to) => OVERLAY.replace(from, to);
  const withExpr = (expr) => {
    const d = JSON.parse(OVERVIEW);
    d.panels.find((p) => p.targets).targets[0].expr = expr;
    return { ...DASH, [OVERVIEW_PATH]: JSON.stringify(d) };
  };

  test('A12.6.1: the repository Grafana service, provisioning, dashboards and placeholder pass', () => {
    assert.deepEqual(check(), []);
  });
  test('A12.6.1: an unpinned or non-OSS image, a non-loopback or extra port is refused', () => {
    fails(check({ overlay: OVERLAY.replace(/grafana\/grafana:13[^\n]+/, 'grafana/grafana:latest') }), /grafana must run grafana\/grafana:<tag>@sha256/);
    fails(check({ overlay: OVERLAY.replace(/grafana\/grafana:13/, 'grafana/grafana-enterprise:13') }), /grafana must run grafana\/grafana:<tag>@sha256/);
    fails(check({ overlay: OVERLAY.replace("'127.0.0.1:3100:3000'", "'3100:3000'") }), /must publish exactly 127\.0\.0\.1:3100:3000/);
    fails(check({ overlay: OVERLAY.replace("'127.0.0.1:3100:3000'", "'0.0.0.0:3100:3000'") }), /must publish exactly 127\.0\.0\.1:3100:3000/);
    fails(check({ overlay: OVERLAY.replace("      - '127.0.0.1:3100:3000'\n", "      - '127.0.0.1:3100:3000'\n      - '127.0.0.1:3101:3001'\n") }), /must publish exactly/);
  });
  test('A12.6.1: a writable root, kept capabilities, a user override, a state volume or a writable mount is refused', () => {
    const g = OVERLAY.slice(OVERLAY.indexOf('\n  grafana:'));
    const swap = (from, to) => OVERLAY.replace(g, g.replace(from, to));
    fails(check({ overlay: swap('    read_only: true\n', '    read_only: false\n') }), /grafana must be read_only/);
    fails(check({ overlay: swap('    cap_drop: [ALL]\n', '') }), /must drop all capabilities/);
    fails(check({ overlay: swap("    security_opt: ['no-new-privileges:true']\n", '') }), /must set no-new-privileges/);
    fails(check({ overlay: swap('    read_only: true\n', '    read_only: true\n    user: root\n') }), /non-root user/);
    fails(check({ overlay: swap('    read_only: true\n', '    read_only: true\n    privileged: true\n') }), /must not be privileged/);
    fails(check({ overlay: swap('dashboards:/etc/grafana/dashboards:ro\n', 'dashboards:/etc/grafana/dashboards:ro\n      - grafana_data:/var/lib/grafana\n') }), /must be a repository bind mount/);
    fails(check({ overlay: swap('dashboards:/etc/grafana/dashboards:ro\n', 'dashboards:/etc/grafana/dashboards\n') }), /must be read-only/);
    fails(check({ overlay: swap('dashboards:/etc/grafana/dashboards:ro\n', 'dashboards:/etc/grafana/dashboards:ro\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n') }), /docker\.sock/);
    fails(check({ overlay: swap('      - /var/lib/grafana:uid=472,gid=0,mode=0770\n', '') }), /must keep \/var\/lib\/grafana in tmpfs/);
  });
  test('A12.6.1: anonymous access, sign-up, a written-out admin password or an admin/admin placeholder is refused', () => {
    fails(check({ overlay: grafanaEnv("GF_AUTH_ANONYMOUS_ENABLED: 'false'", "GF_AUTH_ANONYMOUS_ENABLED: 'true'") }), /must set GF_AUTH_ANONYMOUS_ENABLED=false/);
    fails(check({ overlay: grafanaEnv("      GF_AUTH_ANONYMOUS_ENABLED: 'false'\n", '') }), /must set GF_AUTH_ANONYMOUS_ENABLED=false/);
    fails(check({ overlay: grafanaEnv("GF_USERS_ALLOW_SIGN_UP: 'false'", "GF_USERS_ALLOW_SIGN_UP: 'true'") }), /GF_USERS_ALLOW_SIGN_UP=false/);
    fails(check({ overlay: grafanaEnv(/GF_SECURITY_ADMIN_PASSWORD: [^\n]+/, 'GF_SECURITY_ADMIN_PASSWORD: admin') }), /GF_SECURITY_ADMIN_PASSWORD must be interpolated/);
    fails(check({ overlay: grafanaEnv(/      GF_SECURITY_ADMIN_PASSWORD: [^\n]+\n/, '') }), /GF_SECURITY_ADMIN_PASSWORD must be interpolated/);
    fails(check({ env: ENV.replace(/^GRAFANA_ADMIN_PASSWORD=.*$/m, 'GRAFANA_ADMIN_PASSWORD=admin') }), /must be a non-empty placeholder other than admin/);
    fails(check({ env: ENV.replace(/^GRAFANA_ADMIN_PASSWORD=.*\n/m, '') }), /no GRAFANA_ADMIN_PASSWORD placeholder/);
  });
  test('A12.6.1: any call home or plugin installation is refused', () => {
    for (const [k, on] of [['GF_ANALYTICS_REPORTING_ENABLED', 'true'], ['GF_ANALYTICS_CHECK_FOR_UPDATES', 'true'], ['GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES', 'true'],
      ['GF_ANALYTICS_FEEDBACK_LINKS_ENABLED', 'true'], ['GF_NEWS_NEWS_FEED_ENABLED', 'true'], ['GF_SECURITY_DISABLE_GRAVATAR', 'false'],
      ['GF_PLUGINS_PREINSTALL_DISABLED', 'false'], ['GF_PLUGINS_PREINSTALL_AUTO_UPDATE', 'true'], ['GF_PLUGINS_PLUGIN_ADMIN_ENABLED', 'true']]) {
      fails(check({ overlay: grafanaEnv(new RegExp(`${k}: '[a-z]+'`), `${k}: '${on}'`) }), new RegExp(`must set ${k}=`));
    }
    for (const k of ['GF_INSTALL_PLUGINS', 'GF_PLUGINS_PREINSTALL', 'GF_PLUGINS_PREINSTALL_SYNC']) {
      fails(check({ overlay: grafanaEnv("      GF_LOG_MODE: console\n", `      GF_LOG_MODE: console\n      ${k}: grafana-clock-panel\n`) }), new RegExp(`must not set ${k}$`));
    }
    fails(check({ overlay: grafanaEnv("      GF_LOG_MODE: console\n", '      GF_LOG_MODE: console\n      GF_DATABASE_TYPE: postgres\n') }), /must not set GF_DATABASE_TYPE/);
  });
  test('A12.6.1: exactly one credential-free Prometheus datasource, by uid', () => {
    fails(check({ ds: DS.replace('uid: nawara-prometheus', 'uid: other') }), /uid nawara-prometheus/);
    fails(check({ ds: DS.replace('url: http://prometheus:9090', 'url: http://127.0.0.1:9090') }), /url http:\/\/prometheus:9090/);
    fails(check({ ds: DS.replace('access: proxy', 'access: direct') }), /access proxy/);
    fails(check({ ds: DS.replace('    editable: false\n', '    editable: false\n    basicAuth: true\n') }), /basicAuth is not allowed/);
    fails(check({ ds: DS.replace('    editable: false\n', '    editable: false\n    secureJsonData: { password: x }\n') }), /secureJsonData is not allowed/);
    fails(check({ ds: `${DS}  - name: Postgres\n    uid: pg\n    type: postgres\n    url: postgres:5432\n    access: proxy\n` }), /exactly one datasource is allowed \(found 2\)/);
    fails(check({ pv: PV.replace('allowUiUpdates: false', 'allowUiUpdates: true') }), /allowUiUpdates false/);
    fails(check({ pv: PV.replace('folder: Nawara Core', 'folder: General') }), /folder "Nawara Core"/);
  });
  test('A12.6.1: dashboards are deterministic, use the datasource uid and job, and never fabricate zeroes', () => {
    const d = JSON.parse(OVERVIEW);
    assert.equal(d.uid, 'nawara-core-overview');
    assert.equal(d.title, 'Core · Overview');
    fails(check({ dash: { [OVERVIEW_PATH]: JSON.stringify({ ...d, id: 7 }) } }), /top-level "id" is not allowed/);
    fails(check({ dash: { [OVERVIEW_PATH]: JSON.stringify({ ...d, version: 3 }) } }), /top-level "version" is not allowed/);
    fails(check({ dash: { [OVERVIEW_PATH]: JSON.stringify({ ...d, __inputs: [] }) } }), /top-level "__inputs" is not allowed/);
    fails(check({ dash: { [OVERVIEW_PATH]: OVERVIEW.replace('"uid": "nawara-prometheus"', '"uid": "abc123"') } }), /must be \{"type":"prometheus","uid":"nawara-prometheus"\}/);
    fails(check({ dash: { [OVERVIEW_PATH]: JSON.stringify({ ...d, panels: [{ ...d.panels[1], datasource: 1 }] }) } }), /datasource must be/);
    fails(check({ dash: withExpr('sum(up) or vector(0)') }), /or vector/);
    fails(check({ dash: withExpr('sum by (service) (rate(nawara_http_server_requests_total[5m]))') }), /selects on "service"; use "job"/);
    fails(check({ dash: withExpr('up{service="auth-service"}') }), /selects on "service"/);
    assert.deepEqual(check({ dash: withExpr('nawara_service_info{service="auth-service"}') }), []);
    fails(check({ dash: withExpr('nawara_readiness_ready{job="auth-service"}') }), /reads readiness without/);
    fails(check({ dash: withExpr('time() - nawara_readiness_last_run_timestamp_seconds') }), /reads readiness without/);
    assert.deepEqual(check({ dash: withExpr('time() - (nawara_readiness_last_run_timestamp_seconds{job="a"} > 0)') }), []);
    fails(check({ dash: { [OVERVIEW_PATH]: '{' } }), /not valid JSON/);
    fails(check({ dash: { [OVERVIEW_PATH]: OVERVIEW, 'x/copy.json': OVERVIEW } }), /uid nawara-core-overview is also used/);
    fails(check({ dash: {} }), /uid nawara-core-overview\) is missing/);
  });
  test('A12.6.1: the overview has the required panels, selected by job, over every Core job', () => {
    const d = JSON.parse(OVERVIEW);
    const exprs = d.panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));
    for (const needle of ['up{job=~"', 'up{job="rabbitmq"}', 'up{job="postgres"}', 'scrape_duration_seconds', 'scrape_samples_scraped', 'nawara_readiness_ready',
      'nawara_readiness_last_run_timestamp_seconds', 'nawara_http_server_requests_total', 'status_class="5xx"', 'nawara_db_pool_waiting_clients',
      'nawara_db_pool_max_connections', 'nawara_event_consumer_up', 'nawara_outbox_oldest_pending_age_seconds', 'nawara_outbox_pending_events',
      'nawara_outbox_retrying_events', 'rabbitmq_queue_messages_ready', 'pg_up', 'pg_settings_max_connections']) {
      assert.ok(exprs.some((e) => e.includes(needle)), `no panel query uses ${needle}`);
    }
    const core = /job=~"([^"]+)"/.exec(exprs.find((e) => e.startsWith('up{job=~')))[1].split('|');
    assert.deepEqual(core.sort(), ['audit-service', 'auth-service', 'billing-service', 'file-service', 'notification-service', 'organization-service', 'payment-service', 'release-service']);
    const ids = d.panels.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
}

// ---- V2 A12.6.2: operational dashboards ---------------------------------------------------------------------------------------------
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const OVERLAY = read('docker-compose.observability.yml');
  const DS = read('infra/observability/grafana/provisioning/datasources/prometheus.yml');
  const PV = read('infra/observability/grafana/provisioning/dashboards/nawara-core.yml');
  const ENV = read('.env.example');
  const DIR = 'infra/observability/grafana/dashboards/nawara-core';
  const FILES = { overview: `${DIR}/core-overview.json`, service: `${DIR}/core-service.json`, messaging: `${DIR}/core-messaging.json`, postgresql: `${DIR}/core-postgresql.json` };
  const DASH = Object.fromEntries(Object.values(FILES).map((f) => [f, read(f)]));
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  const check = (dash = DASH) => checkLocalGrafana(OVERLAY, DS, PV, dash, ENV);
  // A copy of the dashboards with one of them changed by `edit` (which mutates a parsed copy).
  const mutate = (key, edit) => {
    const d = JSON.parse(DASH[FILES[key]]);
    edit(d);
    return { ...DASH, [FILES[key]]: JSON.stringify(d) };
  };
  const exprs = (key) => JSON.parse(DASH[FILES[key]]).panels.flatMap((p) => (p.targets ?? []).map((t) => t.expr));
  const panel = (d, title) => d.panels.find((p) => p.title === title);
  const setExpr = (key, title, expr) => mutate(key, (d) => { panel(d, title).targets[0].expr = expr; });

  test('A12.6.2: the four provisioned dashboards pass, with fixed uids and titles', () => {
    assert.deepEqual(check(), []);
    const found = Object.fromEntries(Object.values(DASH).map((t) => JSON.parse(t)).map((d) => [d.uid, d.title]));
    assert.deepEqual(found, GRAFANA_DASHBOARDS);
    for (const [key, uid] of [['service', 'nawara-core-service'], ['messaging', 'nawara-core-messaging'], ['postgresql', 'nawara-core-postgresql']]) {
      const rest = { ...DASH };
      delete rest[FILES[key]];
      fails(check(rest), new RegExp(`uid ${uid}\\) is missing`));
    }
    fails(check(mutate('service', (d) => { d.title = 'Service'; })), /title must be "Core · Service"/);
    fails(check(mutate('messaging', (d) => { d.uid = 'nawara-core-overview'; })), /uid nawara-core-overview is also used/);
  });
  test('A12.6.2: dashboards stay deterministic, local and credential-free', () => {
    fails(check(mutate('service', (d) => { d.version = 2; })), /top-level "version" is not allowed/);
    fails(check(mutate('messaging', (d) => { d.gnetId = 10991; })), /gnetId is not allowed/);
    fails(check(mutate('postgresql', (d) => { d.links = [{ title: 'docs', url: 'https://grafana.com' }]; })), /links must be empty/);
    fails(check(mutate('postgresql', (d) => { d.panels.at(-1).options.content += '\nsee https://example.com'; })), /must not contain a URL/);
    fails(check(mutate('service', (d) => { d.panels[1].datasource = { type: 'postgres', uid: 'pg' }; })), /must be \{"type":"prometheus","uid":"nawara-prometheus"\}/);
    fails(check(mutate('postgresql', (d) => { d.panels[1].targets[0].rawSql = 'SELECT 1'; })), /rawSql is not allowed/);
    fails(check(mutate('service', (d) => { d.panels[1].options.password = 'x'; })), /password is not allowed/);
    fails(check(mutate('service', (d) => { d.panels[1].type = 'grafana-clock-panel'; })), /no plugin panel/);
    fails(check(mutate('service', (d) => { d.panels[2].id = d.panels[1].id; })), /reuses a panel id/);
    fails(check(mutate('service', (d) => { d.editable = true; })), /editable must be false/);
  });
  test('A12.6.2: each operational dashboard has one bounded, single-valued variable', () => {
    const v = (key) => JSON.parse(DASH[FILES[key]]).templating.list;
    assert.deepEqual(v('service').map((x) => [x.name, x.definition]), [['job', `label_values(nawara_service_info{job=~"${CORE_JOBS.join('|')}"}, job)`]]);
    assert.match(v('messaging')[0].definition, /^label_values\(nawara_event_consumer_up\{job=~"[^"]+"\}, queue\)$/);
    assert.match(v('postgresql')[0].definition, /^label_values\(pg_database_size_bytes\{job="postgres",datname=~"[a-z|]+"\}, datname\)$/);
    const setVar = (key, change) => mutate(key, (d) => { Object.assign(d.templating.list[0], change); });
    fails(check(setVar('service', { multi: true })), /must be single-valued/);
    fails(check(setVar('messaging', { includeAll: true, allValue: '.*' })), /must be single-valued/);
    fails(check(setVar('postgresql', { type: 'textbox' })), /must be a query variable/);
    fails(check(setVar('service', { regex: '/.*/' })), /must not post-filter/);
    const def = (key, definition) => setVar(key, { definition, query: definition });
    fails(check(def('service', 'label_values(up, job)')), /must be label_values\(<metric>\{<bounded selector>\}/);
    fails(check(def('service', 'label_values(up{job=~".+"}, job)')), /must read the label "job" from nawara_service_info/);
    fails(check(def('service', 'label_values(nawara_service_info{job=~".+"}, job)')), /must be a literal alternation/);
    fails(check(def('service', 'label_values(nawara_service_info{job=~"auth-service|rabbitmq"}, job)')), /bounded to the eight Core jobs/);
    fails(check(def('messaging', 'label_values(nawara_event_consumer_up, queue)')), /must be label_values/);
    fails(check(def('postgresql', 'label_values(pg_database_size_bytes{job="postgres",datname=~"auth|template1"}, datname)')), /without template databases/);
    fails(check(def('postgresql', 'label_values(pg_database_size_bytes{job="postgres"}, datname)')), /bounded to an explicit list of databases/);
    fails(check(setVar('service', { definition: 'label_values(nawara_service_info{job=~"x"}, job)' })), /the same in "query" and "definition"/);
    fails(check(mutate('overview', (d) => { d.templating.list = [JSON.parse(DASH[FILES.service]).templating.list[0]]; })), /must define no variable/);
    fails(check(mutate('messaging', (d) => { d.templating.list[0].name = 'q'; })), /must define exactly the variable "queue"/);
  });
  test('A12.6.2: panels use the variable as an exact match only, and the Service dashboard filters every series by job', () => {
    assert.ok(exprs('service').every((e) => e.includes('job="$job"')));
    assert.ok(exprs('messaging').some((e) => e.includes('queue="$queue"')));
    assert.ok(exprs('postgresql').some((e) => e.includes('datname="$datname"')));
    fails(check(setExpr('service', 'Target up', 'up{job=~"$job"}')), /other than as the exact match job="\$job"/);
    fails(check(setExpr('service', 'Target up', 'up{job=~"${job}.*"}')), /other than as the exact match/);
    fails(check(setExpr('service', 'Target up', 'up{job="auth-service"}')), /up must select job="\$job"/);
    fails(check(setExpr('service', 'Uptime', 'time() - process_start_time_seconds')), /process_start_time_seconds must select job="\$job"/);
    fails(check(setExpr('service', 'Target up', 'up{job="$job",instance="$instance"}')), /unknown variable \$instance/);
    fails(check(setExpr('messaging', 'Consumed by outcome', 'sum by (outcome) (rate(nawara_events_consumed_total{queue=~"$queue"}[5m]))')), /other than as the exact match queue="\$queue"/);
    fails(check(setExpr('messaging', 'Consumed by outcome', 'sum by (outcome) (rate(nawara_events_consumed_total{queue="$queue"}[5m]))')), /must be bounded to the Core jobs/);
    fails(check(setExpr('postgresql', 'Size', 'pg_database_size_bytes{job="postgres",datname=~"$datname"}')), /exact match datname="\$datname"/);
    fails(check(mutate('postgresql', (d) => { for (const p of d.panels) for (const t of p.targets ?? []) t.expr = t.expr.split('datname="$datname"').join('datname="auth"'); })), /never filter by datname="\$datname"/);
    fails(check(setExpr('service', 'Target up', 'up{job="$job"} or vector(0)')), /or vector/);
  });
  test('A12.6.2: readiness and outbox are read only once they ran; no-data states are never fabricated', () => {
    const ready = exprs('service').filter((e) => e.includes('nawara_readiness_'));
    assert.ok(ready.length >= 3 && ready.every((e) => /nawara_readiness_last_run_timestamp_seconds\{job="\$job"\} > 0/.test(e)));
    fails(check(setExpr('service', 'Readiness — last result', 'nawara_readiness_ready{job="$job"}')), /reads readiness without/);
    const outbox = exprs('service').filter((e) => /nawara_outbox_(pending|retrying|oldest)/.test(e));
    assert.ok(outbox.length === 3 && outbox.every((e) => e.includes('nawara_outbox_stats_timestamp_seconds{job="$job"} > 0')));
    for (const e of [...exprs('service'), ...exprs('messaging'), ...exprs('postgresql')]) assert.doesNotMatch(e, /or\s+vector\s*\(/);
  });
  test('A12.6.2 owner correction: no dashboard shows outbox gauges before the stats were read', () => {
    const gauges = (key) => exprs(key).filter((e) => /nawara_outbox_(pending_events|retrying_events|oldest_pending_age_seconds)/.test(e));
    assert.equal(gauges('overview').length, 3);
    assert.equal(gauges('service').length, 3);
    const strip = (e) => e.replace(/ and on \(job, instance\) \(nawara_outbox_stats_timestamp_seconds\{[^}]*\} > 0\)/, '');
    for (const [key, title] of [['overview', 'Outbox — oldest pending age'], ['overview', 'Outbox — pending and retrying'], ['service', 'Oldest pending age'], ['service', 'Outbox pending and retrying']]) {
      const original = JSON.parse(DASH[FILES[key]]);
      const at = panel(original, title).targets.length - 1;
      fails(check(mutate(key, (d) => { const t = panel(d, title).targets[at]; t.expr = strip(t.expr); })), /reads outbox gauges without "and on \(job, instance\) \(nawara_outbox_stats_timestamp_seconds > 0\)"/);
    }
    // Not a substitute: a filter that does not require a successful read, or that drops the instance match.
    const swap = (from, to) => mutate('overview', (d) => { const t = panel(d, 'Outbox — oldest pending age').targets[0]; t.expr = t.expr.replace(from, to); });
    fails(check(swap('> 0)', '>= 0)')), /reads outbox gauges without/);
    fails(check(swap('on (job, instance)', 'on (job)')), /reads outbox gauges without/);
    fails(check(swap(/ and on .*$/, ' or vector(0)')), /or vector/);
  });
  test('A12.6.2: broker metrics stay aggregate, and broker dead-lettering is never shown as parked messages', () => {
    const m = exprs('messaging');
    assert.ok(m.some((e) => e.includes('nawara_events_consumed_total') && e.includes('dead_lettered_permanent')), 'the application dead-letter outcome is shown');
    assert.ok(m.some((e) => e.includes('rabbitmq_global_messages_dead_lettered_expired_total')), 'broker dead-letter mechanics are shown');
    fails(check(mutate('messaging', (d) => { panel(d, 'Broker dead-letter mechanics (not parked messages)').title = 'DLQ messages'; })), /title must say "mechanics" and never "DLQ"/);
    fails(check(mutate('messaging', (d) => { panel(d, 'Aggregate broker backlog (all queues, incl. retry and dead-letter)').title = 'Backlog'; })), /must say "aggregate"/);
    fails(check(setExpr('messaging', 'Broker target up', 'sum by (queue) (rabbitmq_queue_messages_ready{job="rabbitmq"})')), /groups broker metrics by a per-object label/);
    fails(check(setExpr('messaging', 'Broker target up', 'rabbitmq_queue_messages{job="rabbitmq",queue="billing.payment-events.dead"}')), /per-object label "queue"/);
    fails(check(setExpr('messaging', 'Broker target up', 'rabbitmq_detailed_queue_messages{job="rabbitmq"}')), /detailed endpoint is not scraped/);
    fails(check(setExpr('messaging', 'Broker target up', 'rabbitmq_connections')), /must select job="rabbitmq"/);
    fails(check(mutate('messaging', (d) => { panel(d, 'Consumers attached').targets.push({ ...panel(d, 'Consumers attached').targets[0], refId: 'B', expr: 'sum(rabbitmq_consumers{job="rabbitmq"})' }); })), /mixes broker/);
  });
  test('A12.6.2: PostgreSQL panels use only the collected server and per-database statistics', () => {
    for (const e of ['pg_stat_statements_calls_total{job="postgres"}', 'pg_stat_user_tables_seq_scan{job="postgres"}', 'pg_statio_user_indexes_idx_blks_hit_total{job="postgres"}',
      'rate(pg_stat_database_blk_read_time{job="postgres",datname="$datname"}[5m])', 'sum by (query) (pg_stat_activity_count{job="postgres"})']) {
      fails(check(setExpr('postgresql', 'Size', e)), /not collected/);
    }
    fails(check(setExpr('postgresql', 'Size', 'pg_database_size_bytes{datname="$datname"}')), /must select job="postgres"/);
    const p = exprs('postgresql');
    for (const needle of ['pg_up', 'pg_stat_database_numbackends', 'pg_settings_max_connections', 'pg_stat_activity_count', 'pg_stat_database_xact_commit', 'pg_stat_database_xact_rollback',
      'pg_locks_count', 'pg_stat_database_deadlocks', 'pg_database_size_bytes', 'pg_stat_database_tup_inserted', 'pg_stat_database_blks_hit', 'pg_stat_database_blks_read']) {
      assert.ok(p.some((e) => e.includes(needle)), `no PostgreSQL panel uses ${needle}`);
    }
  });
}

// ---- V2 A12.6.3: alerting foundation (rules, self-scrape) ----------------------------------------------------------------------------
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const BASE = read('docker-compose.yml');
  const OVERLAY = read('docker-compose.observability.yml');
  const PROM = read('infra/observability/prometheus/prometheus.yml');
  const RULES = read('infra/observability/prometheus/rules/nawara-core.rules.yml');
  const TESTS = read('infra/observability/prometheus/tests/nawara-core.rules.test.yml');
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  const check = ({ overlay = OVERLAY, prom = PROM, rules = RULES, tests = TESTS } = {}) => checkLocalObservability(BASE, overlay, prom, rules, tests);
  const KEEP = PROMETHEUS_SELF_METRICS.join('|');
  // The rule file with one alert's field changed (`edit` gets the parsed rule).
  const editRule = (alert, edit) => {
    const doc = parse(RULES);
    edit(doc.groups.flatMap((g) => g.rules).find((r) => r.alert === alert), doc);
    return JSON.stringify(doc);
  };

  test('A12.6.3: the repository rules, tests, self-scrape and mounts pass', () => {
    assert.deepEqual(check(), []);
    // A12.6.3.2 completed the catalog: the six A12.6.3.1 alerts plus ten.
    const byGroup = Object.fromEntries(parse(RULES).groups.map((g) => [g.name, g.rules.map((r) => r.alert)]));
    assert.deepEqual(byGroup, ALERT_CATALOG);
    for (const a of ['CoreServiceDown', 'PostgreSQLDown', 'PostgresExporterDown', 'PrometheusConfigReloadFailed', 'PrometheusRuleFailures', 'RabbitMQDown']) assert.ok(Object.values(byGroup).flat().includes(a));
    const core = /job=~"([^"]+)"/.exec(parse(RULES).groups.flatMap((g) => g.rules).find((r) => r.alert === 'CoreServiceDown').expr)[1].split('|');
    assert.deepEqual(core.sort(), [...CORE_JOBS].sort());
  });
  test('A12.6.3: no Alertmanager, and rule_files is exactly the rules directory glob', () => {
    fails(check({ prom: `${PROM}\nalerting:\n  alertmanagers:\n    - static_configs:\n        - targets: ['alertmanager:9093']\n` }), /no alerting block or Alertmanager/);
    fails(check({ prom: PROM.replace('  - /etc/prometheus/rules/*.rules.yml\n', '  - /etc/prometheus/rules/*.yml\n') }), /rule_files must be exactly/);
    fails(check({ prom: PROM.replace('  - /etc/prometheus/rules/*.rules.yml\n', '  - /etc/prometheus/rules/*.rules.yml\n  - /etc/prometheus/tests/*.yml\n') }), /rule_files must be exactly/);
  });
  test('A12.6.3: exactly one self-scrape job, on its own port, keeping exactly the approved families', () => {
    fails(check({ prom: PROM.replace(/\n  # V2 A12\.6\.3: Prometheus itself[\s\S]*$/, '\n') }), /exactly one self-scrape job "prometheus" is required \(found 0\)/);
    fails(check({ prom: PROM.replace(`regex: '${KEEP}'`, `regex: '${KEEP}|go_goroutines'`) }), /must keep exactly/);
    fails(check({ prom: PROM.replace(`regex: '${KEEP}'`, "regex: '.+'") }), /must keep exactly/);
    fails(check({ prom: PROM.replace(`regex: '${KEEP}'`, `regex: '${KEEP.replace('|prometheus_tsdb_head_series', '')}'`) }), /must keep exactly/);
    fails(check({ prom: PROM.replace('        action: keep\n', '        action: drop\n') }), /must keep exactly/);
    fails(check({ prom: PROM.replace("      - targets: ['localhost:9090']\n", "      - targets: ['prometheus.example.org:9090']\n") }), /must scrape exactly localhost:9090/);
    fails(check({ prom: PROM.replace("  - job_name: prometheus\n", "  - job_name: prometheus\n    scheme: https\n") }), /must not set scheme/);
    fails(check({ prom: `${PROM}  - job_name: prometheus-all\n    static_configs:\n      - targets: ['localhost:9090']\n` }), /job prometheus-all scrapes Prometheus/);
  });
  test('A12.6.3: the rules are mounted read-only and the tests never', () => {
    const mount = '      - ./infra/observability/prometheus/rules:/etc/prometheus/rules:ro\n';
    fails(check({ overlay: OVERLAY.replace(mount, '') }), /must mount the rules exactly once, read-only/);
    fails(check({ overlay: OVERLAY.replace(mount, mount.replace(':ro\n', '\n')) }), /must be read-only|must mount the rules exactly once/);
    fails(check({ overlay: OVERLAY.replace(mount, `${mount}      - ./infra/observability/prometheus/tests:/etc/prometheus/tests:ro\n`) }), /must not mount the rule tests/);
  });
  test('A12.6.3: rule labels, severities and annotations stay bounded and static', () => {
    fails(check({ rules: editRule('CoreServiceDown', (r) => { r.labels.severity = 'page'; }) }), /labels must be exactly severity: critical \| warning/);
    fails(check({ rules: editRule('CoreServiceDown', (r) => { r.labels.team = 'core'; }) }), /labels must be exactly severity/);
    fails(check({ rules: editRule('RabbitMQDown', (r) => { r.annotations.runbook_url = 'https://wiki.example.org'; }) }), /annotation runbook_url is not allowed|must not contain a URL/);
    fails(check({ rules: editRule('RabbitMQDown', (r) => { r.annotations.description += ' See https://example.org'; }) }), /must not contain a URL/);
    fails(check({ rules: editRule('CoreServiceDown', (r) => { r.annotations.summary = 'down on {{ $labels.route }}'; }) }), /may use only \$value and \$labels/);
    fails(check({ rules: editRule('CoreServiceDown', (r, doc) => { doc.groups[0].rules.push({ record: 'job:up:sum', expr: 'sum(up)' }); }) }), /alert rules only/);
    fails(check({ rules: editRule('CoreServiceDown', (r, doc) => { doc.groups[0].interval = '1m'; }) }), /must not set interval/);
  });
  test('A12.6.3: expressions are bounded, never fabricate zeroes, and never alert on readiness', () => {
    const expr = (alert, e) => check({ rules: editRule(alert, (r) => { r.expr = e; }) });
    fails(expr('CoreServiceDown', 'up == 0'), /up must select the Core jobs/);
    fails(expr('CoreServiceDown', 'up{job=~".+-service"} == 0'), /up must select the Core jobs/);
    fails(expr('CoreServiceDown', 'up{job=~"auth-service|billing-service"} == 0'), /up must select the Core jobs/);
    fails(expr('CoreServiceDown', `nawara_readiness_ready{job=~"${CORE_JOBS.join('|')}"} == 0`), /readiness is dashboard only/);
    fails(expr('PostgreSQLDown', '(pg_up{job="postgres"} or vector(0)) == 0'), /or vector/);
    fails(expr('PostgreSQLDown', 'pg_up == 0'), /pg_up must select job="postgres"/);
    fails(expr('RabbitMQDown', 'rabbitmq_detailed_queue_messages{job="rabbitmq"} > 0'), /detailed broker metrics/);
    fails(expr('PrometheusRuleFailures', 'increase(prometheus_rule_evaluation_failures_total[10m]) > 0'), /must select job="prometheus"/);
    fails(expr('CoreServiceDown', `sum by (job, route) (rate(nawara_http_server_requests_total{job=~"${CORE_JOBS.join('|')}",status_class="5xx"}[5m])) > 0`), /groups or matches on "route"|matches on "status_class"/);
    fails(expr('CoreServiceDown', `label_replace(up{job=~"${CORE_JOBS.join('|')}"}, "x", "$1", "job", "(.*)") == 0`), /must not create labels/);
    fails(expr('CoreServiceDown', `nawara_outbox_pending_events{job=~"${CORE_JOBS.join('|')}"} > 100`), /reads outbox gauges without/);
  });
  test('A12.6.3: every alert has a firing and a quiet promtool test, and the tests load exactly the rule file', () => {
    const tests = parse(TESTS);
    const strip = (alert, keepFiring) => JSON.stringify({ ...tests, tests: tests.tests.map((g) => ({ ...g, alert_rule_test: g.alert_rule_test.filter((a) => a.alertname !== alert || (keepFiring ? a.exp_alerts.length : !a.exp_alerts.length)) })) });
    fails(check({ tests: strip('PostgresExporterDown', false) }), /no test where PostgresExporterDown fires/);
    fails(check({ tests: strip('PrometheusConfigReloadFailed', true) }), /no test where PrometheusConfigReloadFailed does not fire/);
    fails(check({ tests: TESTS.replace('  - ../rules/nawara-core.rules.yml\n', '  - ../rules/other.yml\n') }), /rule_files must be exactly/);
    fails(check({ tests: TESTS.replace('alertname: RabbitMQDown\n', 'alertname: RabbitMqDown\n') }), /tests the unknown alert RabbitMqDown/);
    fails(check({ rules: '' }), /no rule group/);
    assert.deepEqual(checkAlertRules(RULES, TESTS), []);
  });
}

// ---- V2 A12.6.3.2: the remaining alert catalog ---------------------------------------------------------------------------------------
{
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const RULES = read('infra/observability/prometheus/rules/nawara-core.rules.yml');
  const TESTS = read('infra/observability/prometheus/tests/nawara-core.rules.test.yml');
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected a problem matching ${pattern}, got ${JSON.stringify(problems)}`);
  const rule = (doc, alert) => doc.groups.flatMap((g) => g.rules).find((r) => r.alert === alert);
  const withRule = (alert, edit) => { const doc = parse(RULES); edit(rule(doc, alert), doc); return checkAlertRules(JSON.stringify(doc), TESTS); };
  const withExpr = (alert, f) => withRule(alert, (r) => { r.expr = f(r.expr); });
  const C = CORE_JOBS.join('|');

  test('A12.6.3.2: exactly the approved catalog; deferred and rejected alerts stay out', () => {
    assert.equal(Object.values(ALERT_CATALOG).flat().length, 17);
    assert.deepEqual(checkAlertRules(RULES, TESTS), []);
    fails(withRule('PgLockWaits', (r, doc) => { doc.groups[2].rules = doc.groups[2].rules.filter((x) => x.alert !== 'PgLockWaits'); }), /alert PgLockWaits is missing from group infrastructure/);
    for (const name of ['SettleFailures', 'CoreServiceNotReady', 'PrometheusSelfScrapeDown', 'DlqDepthHigh', 'BrokerBacklogHigh', 'PgLongTransaction']) {
      fails(withRule('CoreServiceDown', (r, doc) => { doc.groups[0].rules.push({ ...r, alert: name }); }), new RegExp(`${name} is deferred or rejected`));
    }
    fails(withRule('CoreServiceDown', (r, doc) => { doc.groups[0].rules.push({ ...r, alert: 'SomethingElse' }); }), /SomethingElse is not in the approved alert catalog/);
    fails(withRule('CoreServiceDown', (r, doc) => { doc.groups.push({ name: 'extra', rules: [] }); }), /the groups must be exactly/);
  });
  test('A12.6.3.2: labels stay bounded; selection-only labels never widen', () => {
    fails(withExpr('ConsumerDetached', () => `sum by (job, queue, outcome) (nawara_events_consumed_total{job=~"${C}"}) > 0`), /groups or matches on "outcome"/);
    fails(withExpr('MessagesDeadLettered', (e) => e.replaceAll('dead_lettered_malformed|', 'processed|')), /matches on "outcome=~/);
    fails(withExpr('DeadLetterCopyFailing', (e) => e.replace('outcome="dead_letter_deferred"', 'outcome="processed"')), /matches on "outcome="/);
    fails(withExpr('DeadLetterCopyFailing', (e) => e.replace('outcome="dead_letter_deferred"', 'outcome=~"dead_letter_deferred|processed"')), /matches on "outcome=~/);
    fails(withExpr('DbPoolWaiting', () => `nawara_db_pool_waiting_clients{job=~"${C}",route="/x"} > 0`), /matches on "route="/);
    fails(withExpr('HttpServerErrorRatio', (e) => e.replace('status_class!="aborted"', 'status_class!="4xx"')), /matches on "status_class!=/);
    fails(withExpr('PgLockWaits', (e) => e.replace('wait_event_type="Lock"', 'wait_event_type=~".+"')), /matches on "wait_event_type=~/);
    fails(withExpr('PgDeadlocks', (e) => e.replace('sum by (job, instance, datname)', 'sum by (job, instance, datname, usename)')), /groups or matches on "usename"/);
    fails(withRule('ConsumerDetached', (r) => { r.annotations.description = 'payload {{ $labels.outcome }}'; }), /may use only \$value and \$labels/);
  });
  test('A12.6.3.2: the outbox rules keep the A12.6.2 initialisation filter; no fabricated zero', () => {
    fails(withExpr('OutboxBacklogAging', (e) => e.replace(/ and on \(job, instance\) \(nawara_outbox_stats_timestamp_seconds\{[^}]*\} > 0\)/, '')), /reads outbox gauges without/);
    fails(withExpr('OutboxBacklogAging', (e) => e.replace('> 0)', '>= 0)')), /reads outbox gauges without/);
    fails(withExpr('OutboxStatsStale', (e) => `${e} or vector(0)`), /or vector/);
    fails(withExpr('ConsumerDetached', () => 'nawara_event_consumer_up == 0'), /must be bounded to the Core jobs/);
  });
  test('A12.6.3.2: HttpServerErrorRatio keeps both the ratio and the absolute 5xx floor', () => {
    fails(withExpr('HttpServerErrorRatio', (e) => e.replace(/\n\s*and on \(job\)\n[^\n]*>= 3/, '')), /needs both an error ratio threshold and an absolute 5xx floor/);
    fails(withExpr('HttpServerErrorRatio', (e) => e.replace(') > 0.05', ')')), /needs both an error ratio threshold/);
  });
  test('A12.6.3.2: BrokerResourceAlarm is the one reviewed label_replace, over the three aggregate alarms only', () => {
    assert.deepEqual(BROKER_ALARMS, ['memory_used_watermark', 'free_disk_space_watermark', 'file_descriptor_limit']);
    fails(withExpr('BrokerResourceAlarm', (e) => e.replace('(memory_used_watermark|free_disk_space_watermark|file_descriptor_limit)', '(.+)')), /BrokerResourceAlarm: must be exactly label_replace/);
    fails(withExpr('BrokerResourceAlarm', (e) => e.replace('|file_descriptor_limit', '|file_descriptor_limit|other')), /must be exactly label_replace/);
    fails(withExpr('BrokerResourceAlarm', (e) => e.replace(',job="rabbitmq"', '')), /must be exactly label_replace/);
    fails(withExpr('BrokerResourceAlarm', () => 'max by (job, instance, queue) (rabbitmq_queue_messages{job="rabbitmq"}) > 0'), /must be exactly label_replace/);
    fails(withExpr('CoreServiceDown', (e) => `label_replace(${e}, "alarm", "x", "", "")`), /must not create labels/);
    fails(withExpr('RabbitMQDown', () => '{__name__=~"rabbitmq_.+",job="rabbitmq"} == 0'), /bare \{…\} selector/);
  });
  test('A12.6.3.2: PostgreSQL rules stay scoped to postgres, count waiting sessions, and use only collected data', () => {
    fails(withExpr('PgLockWaits', () => 'sum by (job, instance, datname) (pg_locks_count{job="postgres",datname!~"template0|template1"}) >= 1'), /must count sessions waiting on a lock/);
    fails(withExpr('PgConnectionPressure', (e) => e.replaceAll('{job="postgres"}', '')), /must select job="postgres"/);
    fails(withExpr('PgDeadlocks', () => 'sum by (job, instance, datname) (increase(pg_stat_statements_calls_total{job="postgres"}[10m])) > 0'), /not collected/);
    fails(withExpr('PgDeadlocks', () => 'sum by (job, instance, datname) (rate(pg_stat_database_blk_read_time{job="postgres"}[10m])) > 0'), /not collected/);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A1.4: architecture guards (ADR-0056; A1.3 caller-policy convergence; OD-A1-4a = Option 1).

const repoFile = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const KIT_IMPORT = "import { ConfigError, parseCallerPolicy } from '@nawara/service-kit';\n";
const classPolicy = (variable = 'RELEASE_SERVICE_POLICY') => `${KIT_IMPORT}
export class ReleaseCallerPolicy {
  private constructor(private readonly callers: ReadonlyMap<string, unknown>) {}
  static parse(raw: string | undefined, registered: readonly string[]): ReleaseCallerPolicy {
    const map = parseCallerPolicy<unknown>(raw, registered, { variable: '${variable}', keys: ['products'], entry: (at, e) => e });
    return new ReleaseCallerPolicy(new Map(map.callers().map((c) => [c, map.of(c)!])));
  }
}
`;
const REL = 'apps/release-service/src/policy/caller-policy.ts';

test('V2 A1.4: the caller-policy inventory is exactly the seven A1.3 consumers plus Auth (S2-Auth.2), each bound to its variable', () => {
  assert.deepEqual(CALLER_POLICY_MODULES, {
    'apps/billing-service/src/admission/caller-admission.policy.ts': 'BILLING_SERVICE_POLICY',
    'apps/payment-service/src/authorization/caller-admission.policy.ts': 'PAYMENT_SERVICE_POLICY',
    'apps/organization-service/src/authorization/service-policy.ts': 'SERVICE_POLICY',
    'apps/notification-service/src/api/caller-policy.ts': 'NOTIFICATION_SERVICE_POLICY',
    'apps/file-service/src/policy/caller-policy.ts': 'FILE_SERVICE_POLICY',
    'apps/audit-service/src/policy/caller-policy.ts': 'AUDIT_SERVICE_POLICY',
    'apps/release-service/src/policy/caller-policy.ts': 'RELEASE_SERVICE_POLICY',
    'apps/auth-service/src/receipts/service-policy.ts': 'AUTH_SERVICE_POLICY',
  });
  // The real modules pass: every one delegates its document to the kit parser.
  assert.deepEqual(checkCallerPolicyInventory(Object.fromEntries(Object.keys(CALLER_POLICY_MODULES).map((rel) => [rel, repoFile(rel)]))), []);
});

test('V2 A1.4: a governed caller-policy module delegates to parseCallerPolicy and never parses the document itself', () => {
  const ok = (text, rel = REL, variable = 'RELEASE_SERVICE_POLICY') => assert.deepEqual(checkCallerPolicyModule(rel, text, variable), [], text);
  const refused = (text, message, variable = 'RELEASE_SERVICE_POLICY') => assert.match(checkCallerPolicyModule(REL, text, variable).join('\n'), message, text);

  // PASS: a wrapper class; Billing / Payment's function style; comments and strings that merely mention a parser.
  ok(classPolicy());
  ok("import { parseCallerPolicy, policyList, type CallerPolicyMap } from '@nawara/service-kit';\nexport function parseBillingServicePolicy(raw: string | undefined, registered: readonly string[]): CallerPolicyMap<unknown> {\n  return parseCallerPolicy(raw, registered, { variable: 'BILLING_SERVICE_POLICY', keys: ['operations'], entry: (at, e) => e });\n}\n",
    'apps/billing-service/src/admission/caller-admission.policy.ts', 'BILLING_SERVICE_POLICY');
  ok(`${classPolicy()}// Before A1.3 this module called JSON.parse(raw) itself.\n/* parseJsonStrict(raw) is the kit's job */\n`);
  ok(`${classPolicy()}export const NOTE = 'JSON.parse is never called here';\nexport const T = \`JSON['parse'](x)\`;\n`);

  // FAIL: the shared parser replaced by a local one.
  const local = "import { ConfigError } from '@nawara/service-kit';\nexport function parse(raw: string) { const doc = JSON.parse(raw); return doc; }\n";
  refused(local, /must import parseCallerPolicy/);
  refused(local, /never calls parseCallerPolicy/);
  refused(local, /calls JSON\.parse; a governed caller-policy module must not parse the policy document itself/);
  // FAIL: imported but not called (parsing done locally instead).
  refused(classPolicy().replace(/parseCallerPolicy<unknown>\(raw, registered, (\{[^}]*\})\)/, 'JSON.parse(raw)'), /never calls parseCallerPolicy[\s\S]*calls JSON\.parse/);
  refused(`${KIT_IMPORT}export const x = 1;\n`, /never calls parseCallerPolicy/);
  // FAIL: a valid shared-parser call plus a local parser beside it, in either spelling or through the kit's strict reader.
  refused(`${classPolicy()}export const shadow = (raw: string) => JSON.parse(raw);\n`, /calls JSON\.parse/);
  refused(`${classPolicy()}export const shadow = (raw: string) => JSON['parse'](raw);\n`, /calls JSON\.parse/);
  refused(`${classPolicy()}export const shadow = (raw: string) => (JSON).parse(raw);\n`, /calls JSON\.parse/);
  refused(classPolicy().replace('parseCallerPolicy }', 'parseCallerPolicy, parseJsonStrict }') + 'export const shadow = (raw: string) => parseJsonStrict(raw, \'X\');\n', /calls parseJsonStrict/);
  // FAIL: no import at all (a local look-alike), an alias, a type-only import, a namespace import.
  refused(classPolicy().replace(KIT_IMPORT, 'function parseCallerPolicy<E>(...a: unknown[]): any { return a; }\n'), /must import parseCallerPolicy from @nawara\/service-kit/);
  refused(classPolicy().replace('parseCallerPolicy }', 'parseCallerPolicy as p }').replace('parseCallerPolicy<unknown>(', 'p<unknown>('), /imports parseCallerPolicy under an alias/);
  refused(classPolicy().replace(KIT_IMPORT, "import type { parseCallerPolicy } from '@nawara/service-kit';\n"), /must import parseCallerPolicy/);
  refused(classPolicy().replace(KIT_IMPORT, "import * as kit from '@nawara/service-kit';\n").replace('parseCallerPolicy<unknown>(', 'kit.parseCallerPolicy<unknown>('), /must import parseCallerPolicy[\s\S]*never calls parseCallerPolicy/);
  // FAIL: the call is not bound to the inventoried variable (a renamed, missing or computed variable).
  refused(classPolicy('RELEASE_POLICY'), /no parseCallerPolicy call is bound to RELEASE_SERVICE_POLICY/);
  refused(classPolicy().replace("variable: 'RELEASE_SERVICE_POLICY', ", ''), /no parseCallerPolicy call is bound to RELEASE_SERVICE_POLICY/);
  refused(classPolicy().replace("variable: 'RELEASE_SERVICE_POLICY'", 'variable: NAME'), /no parseCallerPolicy call is bound to RELEASE_SERVICE_POLICY/);
});

test('V2 A1.4: a missing governed caller-policy module is reported', () => {
  const files = Object.fromEntries(Object.keys(CALLER_POLICY_MODULES).map((rel) => [rel, repoFile(rel)]));
  files['apps/file-service/src/policy/caller-policy.ts'] = undefined;
  assert.deepEqual(checkCallerPolicyInventory(files), [
    'apps/file-service/src/policy/caller-policy.ts (the governed caller-policy module for FILE_SERVICE_POLICY) is missing; update CALLER_POLICY_MODULES if it moved',
  ]);
});

test('V2 A1.4: a caller-policy consumer outside the inventory fails (completeness); unrelated JSON parsing stays allowed', () => {
  const ungoverned = (text, rel = 'apps/booking-service/src/policy.ts') => assert.match(checkSource(rel, text).join(), /has no governed caller-policy module; add it to CALLER_POLICY_MODULES/, text);
  ungoverned("import { parseCallerPolicy } from '@nawara/service-kit';\nexport const p = (raw: string) => parseCallerPolicy(raw, [], { variable: 'BOOKING_SERVICE_POLICY', keys: [], entry: (a, e) => e });\n");
  ungoverned("import { parseCallerPolicy as p } from '@nawara/service-kit';\n");
  ungoverned("import * as kit from '@nawara/service-kit';\nkit.parseCallerPolicy(raw, [], spec);\n");
  ungoverned("export const raw = reader.get('BOOKING_SERVICE_POLICY');\n", 'apps/booking-service/src/config/booking-config.ts');
  ungoverned("export const raw = reader.required('SERVICE_POLICY');\n", 'apps/booking-service/src/config/booking-config.ts');
  ungoverned('export const raw = process.env.BOOKING_SERVICE_POLICY;\n', 'apps/booking-service/src/main.ts');
  ungoverned("export const raw = process.env['BOOKING_SERVICE_POLICY'];\n", 'apps/booking-service/src/main.ts');
  // A Core service that is not governed gains a policy read: refused too. (Auth was the example until S2-Auth.2 governed it.)
  ungoverned("export const raw = reader.get('SEARCH_SERVICE_POLICY');\n", 'apps/search-service/src/config/search-config.ts');

  const allowed = {
    'apps/billing-service/src/config/billing-config.ts': "const p = parseBillingServicePolicy(reader.get('BILLING_SERVICE_POLICY'), registeredCallers(t));", // governed
    'apps/organization-service/src/config/organization-config.ts': "servicePolicyRaw: reader.get('SERVICE_POLICY'),", // governed
    'apps/auth-service/src/config/app-config.ts': "const p = parseAuthServicePolicy(reader.get('AUTH_SERVICE_POLICY'), registeredCallers(t));", // governed (S2-Auth.2)
    'apps/booking-service/src/x.ts': "// parseCallerPolicy is the kit's; reader.get('BOOKING_SERVICE_POLICY') comes later\nconst s = 'BOOKING_SERVICE_POLICY';",
    'apps/booking-service/src/tokens.ts': "export const SERVICE_POLICY = Symbol('SERVICE_POLICY'); const t = reader.get('SERVICE_TOKENS');",
    'apps/booking-service/test/p.e2e-spec.ts': "import { parseCallerPolicy } from '@nawara/service-kit';", // tests are not consumers
    'apps/booking-service/src/p.spec.ts': "const raw = process.env.BOOKING_SERVICE_POLICY;",
    'apps/billing-service/src/common/pagination.ts': 'export const decode = (c: string) => JSON.parse(Buffer.from(c, "base64url").toString());',
    'apps/booking-service/src/cursor.ts': 'export const decode = (c: string) => JSON.parse(c);',
    'libs/service-kit/src/events/x.ts': 'export const body = (b: Buffer) => JSON.parse(b.toString());',
    'libs/service-kit/src/service-auth/caller-policy.ts': "export function parseCallerPolicy() {} const v = reader.get('SERVICE_POLICY');", // the kit is the parser's home
  };
  for (const [rel, text] of Object.entries(allowed)) assert.deepEqual(checkSource(rel, text), [], rel);
});

test('V2 A1.4: the shared static-specifier collector sees every module-loading form, and only real ones', () => {
  assert.deepEqual(staticModuleSpecifiers('apps/x-service/src/a.ts', [
    "import a from 'm1';", "import type { B } from 'm2';", "export * from 'm3';", "import 'm4';", "const c = await import('m5');",
    "const d = require('m6');", "import e = require('m7');", "type F = import('m8').F;",
    "// import g from 'not1';", "const s = 'not2'; const t = `from 'not3'`;",
  ].join('\n')), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']);
});

test('V2 A1.4 (OD-A1-4a): app → app and library → application imports are refused in every module-loading form', () => {
  const manifests = Object.fromEntries(['audit-service', 'auth-service', 'billing-service', 'file-service', 'notification-service', 'organization-service', 'payment-service', 'release-service']
    .map((dir) => [dir, repoFile(`apps/${dir}/package.json`)]));
  const appPackages = workspaceAppPackages(manifests);
  assert.equal(appPackages.size, 8);
  assert.equal(appPackages.get('billing-service'), 'billing-service'); // read from the manifest, never derived from a naming scheme
  assert.equal(workspaceAppPackages({ 'x-service': '{"name":"@acme/x"}' }).get('@acme/x'), 'x-service');

  const forms = (target) => ({
    'static import': `import { X } from '${target}';`,
    'type-only import': `import type { X } from '${target}';`,
    're-export': `export * from '${target}';`,
    'side-effect import': `import '${target}';`,
    'dynamic import': `const m = await import('${target}');`,
    'require': `const m = require('${target}');`,
  });
  const appToApp = {
    'apps/payment-service/src/a.ts': ['../../billing-service/src/x.js', '../../../apps/billing-service/src/x.js', 'billing-service', 'billing-service/dist/x.js'],
    'apps/payment-service/test/a.e2e-spec.ts': ['../../billing-service/src/x.js', 'billing-service/dist/x.js'],
  };
  for (const [rel, targets] of Object.entries(appToApp)) {
    for (const target of targets) {
      for (const [label, text] of Object.entries(forms(target))) {
        assert.match(checkSource(rel, text, { appPackages }).join(), /imports another service's source/, `${rel}: ${label} of ${target}`);
      }
    }
  }
  const libToApp = {
    'libs/service-kit/src/x.ts': ['../../../apps/auth-service/src/x.js', 'auth-service', 'organization-service/dist/x.js'],
    'libs/audit-contract/src/x.ts': ['../../../apps/audit-service/src/x.js'],
  };
  for (const [rel, targets] of Object.entries(libToApp)) {
    for (const target of targets) {
      for (const [label, text] of Object.entries(forms(target))) {
        assert.match(checkSource(rel, text, { appPackages }).join(), /a shared library imports application source/, `${rel}: ${label} of ${target}`);
      }
    }
  }
  // PASS controls: the service's own files and package, external and node modules, the shared libraries; mentions are not imports.
  const allowed = {
    'apps/payment-service/src/a.ts': "import { X } from './x.js'; import y from '../common/y.js'; import { Pool } from 'pg'; import { Z } from '@nawara/service-kit'; import { W } from '@nawara/audit-contract'; import { createHash } from 'node:crypto'; const own = await import('payment-service/dist/x.js');",
    'apps/billing-service/src/b.ts': "// moved from '../../payment-service/src/x.js'\nconst note = \"see require('payment-service')\"; const t = `import('auth-service')`;",
    'libs/service-kit/src/y.ts': "import { Pool } from 'pg'; import { x } from './x.js'; const m = await import('node:fs');",
    'apps/payment-service/src/c.ts': "import { x } from 'billing-service-sdk'; import y from '@billing-service/x';", // look-alike packages are not workspace apps
  };
  for (const [rel, text] of Object.entries(allowed)) assert.deepEqual(checkSource(rel, text, { appPackages }), [], rel);
});

test('V2 A1.4: the runner wires both guards (the workspace packages reach checkSource; the inventory is checked)', () => {
  const sf = ts.createSourceFile('check-repo.mjs', repoFile('scripts/check-repo.mjs'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const named = (name) => calls.filter((c) => c.expression.text === name);
  assert.ok(named('checkSource').some((c) => c.arguments[2] && ts.isObjectLiteralExpression(c.arguments[2])
    && c.arguments[2].properties.some((p) => p.name?.text === 'appPackages')), 'checkSource(rel, text, { appPackages })');
  assert.equal(named('workspaceAppPackages').length, 1, 'the packages are read from the application manifests');
  assert.equal(named('checkCallerPolicyInventory').length, 1, 'the caller-policy inventory is checked');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A2.5: configuration and secret hygiene guards. Fixture secrets are generated per run: no published value is repeated here.
// ---------------------------------------------------------------------------------------------------------------------------------

/** A temporary Git directory holding one `.gitignore`: the ignore guard is tested on Git's own evaluation, as the runner uses it. */
function withGitDirectory(gitignore, run) {
  const dir = mkdtempSync(join(tmpdir(), 'nawara-ignore-'));
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0, 'git init');
    writeFileSync(join(dir, '.gitignore'), gitignore);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const GITIGNORE = 'node_modules/\n.env\n.env.*\n!.env.example\n';

test('V2 A2.5: the environment ignore policy is checked on behaviour (Git evaluates the rules)', () => {
  withGitDirectory(GITIGNORE, (dir) => assert.deepEqual(checkEnvIgnorePolicy(gitIgnoreProbe(dir)), []));
  // Another spelling with the same behaviour passes: the guard does not match text.
  withGitDirectory('**/.env\n**/.env.*\n!**/.env.example\n', (dir) => assert.deepEqual(checkEnvIgnorePolicy(gitIgnoreProbe(dir)), []));
  withGitDirectory('node_modules/\n.env\n!.env.example\n', (dir) => {
    const problems = checkEnvIgnorePolicy(gitIgnoreProbe(dir));
    assert.deepEqual(problems.map((p) => /ignores (\S+):/.exec(p)[1]), ['.env.local', '.env.production', 'apps/auth-service/.env.local']);
    assert.match(problems[0], /^\.gitignore no longer ignores \.env\.local: a real environment file could be committed/);
  });
  withGitDirectory('node_modules/\n.env\n.env.*\n', (dir) => {
    assert.deepEqual(checkEnvIgnorePolicy(gitIgnoreProbe(dir)), [
      '.gitignore ignores .env.example: the committed development templates must stay trackable (expected rule: !.env.example)',
      '.gitignore ignores apps/auth-service/.env.example: the committed development templates must stay trackable (expected rule: !.env.example)',
    ]);
  });
  withGitDirectory('node_modules/\n', (dir) => assert.equal(checkEnvIgnorePolicy(gitIgnoreProbe(dir)).length, ENV_PATHS_IGNORED.length));
  // Git could not answer (not a repository): reported, never read as "not ignored" or as a pass.
  const outside = mkdtempSync(join(tmpdir(), 'nawara-nogit-'));
  try {
    const probe = gitIgnoreProbe(outside);
    if (probe('.env') === undefined) assert.match(checkEnvIgnorePolicy(probe).join('\n'), /Git could not evaluate the ignore rules for \.env /);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.match(checkEnvIgnorePolicy(() => undefined)[0], /Git could not evaluate the ignore rules/);
});

test('V2 A2.5: no tracked environment file except the .env.example templates (the index, not the disk)', () => {
  assert.deepEqual(checkTrackedEnvFiles(['.env.example', 'apps/auth-service/.env.example', 'apps/x-service/src/env.ts', 'docs/environment.md', 'apps/x-service/src/config/env-reader.ts', 'scripts/dotenv.mjs']), []);
  for (const path of ['.env', 'apps/x-service/.env', 'apps/x-service/.env.local', '.env.production', 'prod.env', 'deploy/secrets.env', 'apps/x-service/.env.example.bak.env']) {
    assert.deepEqual(checkTrackedEnvFiles(['.env.example', path]), [`${path} is tracked: only .env.example templates may be committed (remove it from the index; a real environment file never enters the repository)`], path);
  }
  assert.match(checkTrackedEnvFiles(undefined)[0], /Git could not list the tracked files/);
  assert.equal(isEnvTemplate('apps/x-service/.env.example'), true);
  assert.equal(isEnvTemplate('apps/x-service/.env.example.bak'), false);
  // The runner's source is the index: an ignored file on disk is not listed, a tracked one is.
  withGitDirectory(GITIGNORE, (dir) => {
    writeFileSync(join(dir, '.env'), 'LOCAL=1\n');
    writeFileSync(join(dir, '.env.example'), '# development only\n');
    assert.equal(spawnSync('git', ['add', '.'], { cwd: dir }).status, 0);
    assert.deepEqual(gitTrackedFiles(dir).sort(), ['.env.example', '.gitignore']);
    assert.deepEqual(checkTrackedEnvFiles(gitTrackedFiles(dir)), []);
    assert.equal(spawnSync('git', ['add', '-f', '.env'], { cwd: dir }).status, 0);
    assert.match(checkTrackedEnvFiles(gitTrackedFiles(dir)).join(), /^\.env is tracked/);
  });
});

const fingerprint = (data) => createHash('sha256').update(data).digest('hex');
const catalogSource = (entries) => `export const DEVELOPMENT_SECRET_FINGERPRINTS = new Map([\n${entries.map(([fp, label]) => `  ['${fp}', '${label}'], // x`).join('\n')}\n]);\n`;
/** A generated fixture: two keys, a two-entry key ring, a service token and its published digest; template and catalog agree. */
function secretFixture() {
  const key = randomBytes(32);
  const padded = randomBytes(33);
  const ring = [randomBytes(32), randomBytes(32)];
  let token;
  do token = randomBytes(32).toString('base64url'); while (!(/[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)));
  const values = { key: key.toString('base64'), padded: padded.toString('base64'), ring: ring.map((k, i) => `k${i + 1}:${k.toString('base64')}`).join(','), token, digest: fingerprint(token) };
  const template = ['# Development only.', 'PORT=3000', 'DATABASE_URL=postgres://app:local-password@localhost:5432/app', `X_KEY=${values.key}`, `X_PADDED_KEY="${values.padded}"  # quoted`,
    `X_KEYS=${values.ring}`, `X_TOKEN=${values.token}`, `X_TOKENS=caller:${values.digest}`, 'X_POLICY=\'{"callers":{"a":{"operations":["x.read"]}}}\'', 'EMPTY=      # a placeholder', '# COMMENTED_KEY=not-a-value', ''].join('\n');
  const catalog = [[fingerprint(key), 'X_KEY'], [fingerprint(padded), 'X_PADDED_KEY'], [fingerprint(ring[0]), 'X_KEYS'], [fingerprint(ring[1]), 'X_KEYS'], [fingerprint(token), 'X_TOKEN']];
  return { values, template, catalog };
}
const noLeak = (problems, values) => {
  for (const problem of problems) {
    for (const secret of Object.values(values).flatMap((v) => v.split(/[,:]/))) if (secret.length >= 16) assert.ok(!problem.includes(secret), 'a diagnostic must not contain a template value');
    assert.doesNotMatch(problem, /[0-9a-f]{64}/, 'a diagnostic must not contain a fingerprint');
    assert.doesNotMatch(problem.replaceAll(DEVELOPMENT_SECRET_CATALOG, '<catalog>'), /[A-Za-z0-9+/_-]{40,}/, 'a diagnostic must not contain anything secret-shaped');
  }
};

test('V2 A2.5: the published development secrets and the fingerprint catalog are the same set, in both directions', () => {
  const { values, template, catalog } = secretFixture();
  const check = (text, entries) => checkDevelopmentSecretCatalog({ '.env.example': text }, catalogSource(entries));
  assert.deepEqual(check(template, catalog), []);
  // Templates are read together: a secret may live in a service template.
  assert.deepEqual(checkDevelopmentSecretCatalog({ '.env.example': '# development only\n', 'apps/x-service/.env.example': template }, catalogSource(catalog)), []);

  const without = (label, nth = 0) => { let seen = 0; return catalog.filter(([, l]) => l !== label || seen++ !== nth); };
  const missing = (label, variable, nth) => {
    const problems = check(template, without(label, nth));
    assert.deepEqual(problems, [`.env.example: ${variable} is published development secret material that is not in the development-secret catalog (${DEVELOPMENT_SECRET_CATALOG}); production would accept it. Add its fingerprint, or do not publish it`], label);
    noLeak(problems, values);
  };
  missing('X_KEY', 'X_KEY');
  missing('X_PADDED_KEY', 'X_PADDED_KEY'); // quoted, with an inline comment
  missing('X_KEYS', 'X_KEYS', 1); // the second ring entry alone
  // The token's fingerprint is also its published digest: without it, the token AND the digest are uncataloged.
  const tokenProblems = check(template, without('X_TOKEN'));
  assert.deepEqual(tokenProblems.map((p) => /^\.env\.example: (\w+) is published/.exec(p)[1]), ['X_TOKEN', 'X_TOKENS']);
  noLeak(tokenProblems, values);
  // A digest of something that is not a published token is refused on its own.
  const strayDigest = check(`${template}Y_TOKENS=other:${fingerprint('unpublished')}\n`, catalog);
  assert.deepEqual(strayDigest.map((p) => /^\.env\.example: (\w+) /.exec(p)[1]), ['Y_TOKENS']);

  // Reverse (OD-A2.5-3): a catalog entry whose value is no longer published.
  const stale = check(template.replace(/^X_KEY=.*\n/m, ''), catalog);
  assert.deepEqual(stale, [`${DEVELOPMENT_SECRET_CATALOG}: the catalog entry for X_KEY matches no value of a tracked .env.example; remove the entry or restore the published value`]);
  noLeak(stale, values);
  const extra = check(template, [...catalog, [fingerprint('never published'), 'Z_KEY']]);
  assert.match(extra.join(), /the catalog entry for Z_KEY matches no value/);
  assert.equal(extra.length, 1);

  // Structural, never a count: an empty pair and a one-secret pair both agree; an unreadable catalog is reported, not passed.
  assert.deepEqual(check('# development only\nX_KEY=' + values.key + '\n', [catalog[0]]), []);
  assert.match(check(template, []).join(), /no development-secret fingerprint could be read/);
  assert.match(checkDevelopmentSecretCatalog({ '.env.example': template }, undefined).join(), /no development-secret fingerprint could be read/);
  // Not secret-shaped: short values, URLs, JSON, words, a comment.
  assert.deepEqual(check('# development only\nA=short\nB=postgres://u:p@h:5432/d\nC=this-is-a-long-lowercase-placeholder-value-for-a-test-bucket\nD=\'{"a":1}\'\n' + template.split('\n').slice(1).join('\n'), catalog), []);
  assert.deepEqual(envAssignments('A=1\n  export B="x y" # c\n#C=3\nD=   # none\nE=a#b\n\nnot a line\n'), [{ name: 'A', value: '1' }, { name: 'B', value: 'x y' }, { name: 'D', value: '' }, { name: 'E', value: 'a#b' }]);
});

test('V2 A2.5: the real catalog and the real templates agree, and the catalog is read in full', () => {
  const catalogText = repoFile(DEVELOPMENT_SECRET_CATALOG);
  const catalog = developmentSecretCatalog(catalogText);
  assert.equal(catalog.size, (catalogText.match(/'[0-9a-f]{64}'/g) ?? []).length, 'every fingerprint literal of the catalog is parsed');
  assert.ok(catalog.size > 0);
  const templates = Object.fromEntries(gitTrackedFiles(new URL('..', import.meta.url).pathname).filter(isEnvTemplate).map((rel) => [rel, repoFile(rel)]));
  assert.ok('.env.example' in templates);
  assert.deepEqual(checkDevelopmentSecretCatalog(templates, catalogText), []);
});

test('V2 A2.5: every template says it is for development only, and the root template is consumed by Compose', () => {
  const compose = { 'docker-compose.yml': 'services:\n  a:\n    environment:\n      A: ${A_PASSWORD:?set it}\n      B: ${B_URL}\n      C: "${C_PORT:-3000}"\n      D: $D_NAME\n' };
  const root = '# Local stack.\n# Development only: never use these values elsewhere.\n\nA_PASSWORD=x\nB_URL=y\nC_PORT=1\nD_NAME=z\n';
  assert.deepEqual(checkEnvTemplates({ '.env.example': root, 'apps/x-service/.env.example': '# x-service, DEVELOPMENT-ONLY template\nANY_NAME=1\n' }, compose), []);
  assert.deepEqual(checkEnvTemplates({ '.env.example': root.replace('Development only', 'Local'), 'apps/x-service/.env.example': 'A=1\n# development only\n' }, compose), [
    '.env.example: must open with a comment that says the template is for development only',
    'apps/x-service/.env.example: must open with a comment that says the template is for development only', // not in the opening comment
  ]);
  assert.deepEqual(checkEnvTemplates({ '.env.example': `${root}UNUSED_VALUE=1\nA_PASS=2\n# COMMENTED=3\n` }, compose), [
    '.env.example: UNUSED_VALUE is not referenced by any Compose file (docker-compose.yml); remove it or reference it',
    '.env.example: A_PASS is not referenced by any Compose file (docker-compose.yml); remove it or reference it', // a prefix of A_PASSWORD is not a reference
  ]);
  // A second Compose file counts; service templates are never matched against Compose or a loader.
  assert.deepEqual(checkEnvTemplates({ '.env.example': `${root}OVERLAY_ONLY=1\n` }, { ...compose, 'docker-compose.observability.yml': 'x: ${OVERLAY_ONLY}' }), []);
  assert.match(checkEnvTemplates({ 'apps/x-service/.env.example': '# development only\n' }, compose).join(), /\.env\.example \(the root local-development template\) is missing or not tracked/);
});

test('V2 A2.5: process.env is read only at the configuration boundary (loaders and command-line tools)', () => {
  const read = 'export const v = process.env.X_VALUE;';
  const allowed = {
    'apps/x-service/src/config/x-config.ts': 'export function loadXConfig(env: NodeJS.ProcessEnv = process.env) { return env; }',
    'libs/service-kit/src/config/base-config.ts': 'export function loadBaseConfig(name: string, env = process.env) { return env; }',
    'apps/x-service/src/cli/main.ts': "const url = process.env.MIGRATION_DATABASE_URL; process.env.X_EVENTS = 'off'; const { A_NAME } = process.env;",
    'libs/service-kit/src/cli/migrate.ts': read,
    // Tests, comments, strings and types are not reads; another object's env is not the process environment.
    'apps/x-service/src/a.spec.ts': read,
    'apps/x-service/test/a.e2e-spec.ts': read,
    'libs/service-kit/src/a.int-spec.ts': read,
    'apps/x-service/src/b.ts': "// process.env.X is read by the loader\nconst s = 'process.env.X'; const t = `${'process'}.env`; /* const { env } = process */",
    'apps/x-service/src/c.ts': 'export function f(env: NodeJS.ProcessEnv, e: typeof process.env) { return [env.X_VALUE, e, config.env, options.process]; }',
    'apps/x-service/scripts/tool.mjs': read, // outside src
  };
  for (const [rel, text] of Object.entries(allowed)) assert.deepEqual(checkSource(rel, text), [], rel);

  const forms = {
    'property': read,
    'bracket key': "export const v = process.env['X_VALUE'];",
    'double-quoted key': 'export const v = process.env["X_VALUE"];',
    'bracket env': "export const v = process['env'].X_VALUE;",
    'whole object': 'export const all = { ...process.env };',
    'passed on': 'load(process.env);',
    'destructured': 'const { env } = process;',
    'destructured, renamed': 'const { env: e, argv } = process;',
    'assigned destructuring': 'let env; ({ env } = process);',
    'through globalThis': 'export const v = globalThis.process.env.X_VALUE;',
    'parenthesized': 'export const v = (process).env.X_VALUE;',
    'named import': "import { env } from 'node:process'; export const v = env.X_VALUE;",
    'write': "process.env.X_VALUE = 'on';",
  };
  const runtime = ['apps/x-service/src/main.ts', 'apps/x-service/src/deep/module/a.ts', 'libs/service-kit/src/events/bus.ts', 'libs/audit-contract/src/index.ts',
    'apps/x-service/src/config/x-config.token.ts', 'apps/x-service/src/config/helper.ts', 'libs/service-kit/src/config/config.ts', 'libs/audit-contract/src/cli/tool.ts'];
  for (const rel of runtime) {
    for (const [label, text] of Object.entries(forms)) {
      // Only this guard's finding is compared: the audit contract's own rule also (rightly) refuses its node:process import.
      assert.deepEqual(checkSource(rel, text).filter((p) => p.includes('process.env')), [`${rel}: reads process.env directly; configuration is read once by the service configuration loader (src/config/*-config.ts) and reaches the rest of the service as a typed value`], `${rel}: ${label}`);
    }
  }
  assert.equal(PROCESS_ENV_BOUNDARY.length, 4, 'the boundary is the reviewed allowlist: loaders, the kit base loader, service CLIs, kit CLIs');
  assert.equal(sourceFacts('a.ts', read).readsProcessEnv, true);
  assert.equal(sourceFacts('a.ts', 'const x = config.env;').readsProcessEnv, false);
});

test('V2 A2.5: a README documents every literal variable its service reads (high-confidence; computed names are outside)', () => {
  const loader = [
    "const a = reader.required('X_URL'); const b = reader.int('X_TTL_SECONDS', { default: 1, min: 1, max: 9 }); const c = reader.bool('X_ENABLED', true);",
    "const d = reader.oneOf('X_MODE', ['a', 'b'], 'a'); const e = reader.secret('X_SECRET'); const f = reader.url('X_BASE', ['https:']); const g = reader.get('X_OPTIONAL') ?? reader.optional('X_OTHER', 'd');",
    "const h = readKey(reader, 'X_HASH_KEY', rules); const i = readOptionalKey(reader, 'X_OLD_KEY', rules); const j = readKeyRing(reader, 'X_KEYS', 'X_ACTIVE_KEY_ID', rules);",
    "const k = int(env, 'X_LIMIT', 1, 1, 9); const l = required(src, 'X_REQUIRED'); const m = secretBytes(src, 'X_PEPPER', true); const n = env.X_ISSUER ?? env['X_AUDIENCE']; const o = src.get('X_FROM_SOURCE');",
    // Computed names and look-alikes: none of these is a literal read.
    "const p = reader.int(`X_${name}_RATE`, opts); const q = rule(env, 'LOGIN_IP', 5, 300); const r = Symbol('X_CONFIG'); const s = map.get('X_NOT_ENV'); const t = headers.get('X_HEADER');",
    "throw new ConfigError('X_MENTIONED must be set'); const u = 'X_STRING'; // reader.get('X_COMMENTED')",
  ].join('\n');
  const names = ['X_URL', 'X_TTL_SECONDS', 'X_ENABLED', 'X_MODE', 'X_SECRET', 'X_BASE', 'X_OPTIONAL', 'X_OTHER', 'X_HASH_KEY', 'X_OLD_KEY', 'X_KEYS', 'X_ACTIVE_KEY_ID', 'X_LIMIT', 'X_REQUIRED', 'X_PEPPER', 'X_ISSUER', 'X_AUDIENCE', 'X_FROM_SOURCE'];
  assert.deepEqual(sourceFacts('apps/x-service/src/config/x-config.ts', loader).configNames.sort(), [...names].sort());
  const readme = (list) => `# x-service\n\n| Variable | Meaning |\n|---|---|\n${list.map((n) => `| \`${n}\` | … |`).join('\n')}\n| \`OTHER_SERVICE_URL\` | an integration variable nothing here reads |\n`;
  const sources = { 'apps/x-service/src/config/x-config.ts': loader, 'apps/x-service/src/storage/storage-config.ts': "export const s = (reader) => reader.int('X_STORAGE_TIMEOUT_MS', o);" };
  assert.deepEqual(checkReadmeEnvironmentCoverage('x-service', readme([...names, 'X_STORAGE_TIMEOUT_MS']), sources), []);
  assert.deepEqual(checkReadmeEnvironmentCoverage('x-service', readme(names.filter((n) => n !== 'X_TTL_SECONDS')), sources), [
    'apps/x-service/README.md does not document X_TTL_SECONDS, which apps/x-service/src/config/x-config.ts reads',
    'apps/x-service/README.md does not document X_STORAGE_TIMEOUT_MS, which apps/x-service/src/storage/storage-config.ts reads',
  ]);
  // A longer name or a wildcard is not a mention of the variable.
  assert.match(checkReadmeEnvironmentCoverage('x-service', readme([...names.filter((n) => n !== 'X_KEYS'), 'X_KEYS_PREVIOUS', 'X_STORAGE_*_TIMEOUT_MS', 'X_STORAGE_TIMEOUT_MS']), sources).join(), /^apps\/x-service\/README\.md does not document X_KEYS, which/);
  assert.match(checkReadmeEnvironmentCoverage('x-service', undefined, sources).join(), /README\.md is missing/);
  assert.match(checkReadmeEnvironmentCoverage('x-service', readme(names), { 'apps/x-service/src/a.ts': 'export const a = 1;' }).join(), /no literal configuration read was found/);
  // V2 A4.2: the kit's readDocsCredentials reads SWAGGER_PASSWORD and SWAGGER_USERNAME for its caller: both must be documented.
  const docsSources = { ...sources, 'apps/x-service/src/config/docs.ts': 'export const docs = (reader) => readDocsCredentials(reader);' };
  assert.deepEqual(sourceFacts('apps/x-service/src/config/docs.ts', docsSources['apps/x-service/src/config/docs.ts']).configNames.sort(), ['SWAGGER_PASSWORD', 'SWAGGER_USERNAME']);
  assert.deepEqual(checkReadmeEnvironmentCoverage('x-service', readme([...names, 'X_STORAGE_TIMEOUT_MS', 'SWAGGER_PASSWORD', 'SWAGGER_USERNAME']), docsSources), []);
  assert.deepEqual(checkReadmeEnvironmentCoverage('x-service', readme([...names, 'X_STORAGE_TIMEOUT_MS', 'SWAGGER_PASSWORD']), docsSources), [
    'apps/x-service/README.md does not document SWAGGER_USERNAME, which apps/x-service/src/config/docs.ts reads',
  ]);
  // Not a read: the helper merely named, a method of another object, or a look-alike function; and the other helpers are unchanged.
  for (const text of ["const f = readDocsCredentials; const g = 'readDocsCredentials(reader)';", 'const c = kit.helpers.readDocsCredentialsX(reader);', 'const d = readDocsCredentialsFor(reader);']) {
    assert.deepEqual(sourceFacts('apps/x-service/src/config/y.ts', text).configNames, [], text);
  }
  assert.deepEqual(sourceFacts('apps/x-service/src/config/z.ts', "const k = readKey(reader, 'X_HASH_KEY', rules); const d = readDocsCredentials(reader);").configNames.sort(), ['SWAGGER_PASSWORD', 'SWAGGER_USERNAME', 'X_HASH_KEY']);
  // What the runner feeds it: the service's non-test source outside its command-line tools.
  assert.equal(isServiceConfigSource('x-service', 'apps/x-service/src/storage/storage-config.ts'), true);
  for (const rel of ['apps/x-service/src/cli/main.ts', 'apps/x-service/src/config/x-config.spec.ts', 'apps/x-service/test/a.e2e-spec.ts', 'apps/y-service/src/a.ts', 'apps/x-service/src/a.d.ts', 'apps/x-service/README.md']) {
    assert.equal(isServiceConfigSource('x-service', rel), false, rel);
  }
});

test('V2 A2.5: no environment file enters a Docker build context (static evaluation of .dockerignore)', () => {
  const rules = 'node_modules\n**/dist\n*.md\n# no environment file\n**/.env\n**/.env.*\n';
  assert.deepEqual(checkDockerContext(rules), []);
  assert.deepEqual(checkDockerContext(repoFile('.dockerignore')), []);
  assert.deepEqual(checkDockerContext('node_modules\n**/dist\n'), DOCKER_CONTEXT_EXCLUDED.map((p) => `.dockerignore lets ${p} into the build context (expected rules: **/.env and **/.env.*, with no later rule re-including it)`));
  // Root-only rules leave the packages' files in; a later negation re-includes (the last matching rule wins).
  assert.deepEqual(checkDockerContext('.env\n.env.*\n').map((p) => /lets (\S+) into/.exec(p)[1]), ['apps/auth-service/.env', 'apps/auth-service/.env.local', 'libs/service-kit/.env']);
  assert.deepEqual(checkDockerContext(`${rules}!**/.env\n`).map((p) => /lets (\S+) into/.exec(p)[1]), ['.env', 'apps/auth-service/.env', 'libs/service-kit/.env']);
  assert.deepEqual(checkDockerContext(`!**/.env\n${rules}`), [], 'an earlier negation is overridden');
  assert.match(checkDockerContext(`${rules}apps\n`).join('\n'), /\.dockerignore excludes apps\/auth-service\/src\/main\.ts, which an image build needs/);
  assert.match(checkDockerContext(`${rules}**/*.sh\n`).join('\n'), /excludes apps\/auth-service\/deploy\/provision-and-deploy\.sh/);
  assert.match(checkDockerContext(undefined).join(), /\.dockerignore is missing/);
  const excludes = (pattern, path) => dockerIgnoreExcludes(`${pattern}\n`, path);
  assert.equal(excludes('**/.env', '.env'), true); // ** matches no directory too
  assert.equal(excludes('**/.env', 'a/b/.env'), true);
  assert.equal(excludes('*/.env', 'a/b/.env'), false); // * does not cross a separator
  assert.equal(excludes('**/.env.*', 'a/.envrc'), false);
  assert.equal(excludes('**/.env.*', 'a/src/env.ts'), false);
  assert.equal(excludes('.en?', '.env'), true);
  assert.equal(excludes('**/test', 'apps/a/test/x.ts'), true); // a directory rule covers what is under it
  assert.equal(excludes('.env', '.envx'), false);
});

test('V2 A2.5: the runner wires every configuration and secret guard, on Git-backed inputs', () => {
  const sf = ts.createSourceFile('check-repo.mjs', repoFile('scripts/check-repo.mjs'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const named = (name) => calls.filter((c) => c.expression.text === name);
  const pushed = (name) => named(name).filter((c) => ts.isSpreadElement(c.parent) && ts.isCallExpression(c.parent.parent) && c.parent.parent.expression.getText() === 'problems.push');
  for (const guard of ['checkEnvIgnorePolicy', 'checkDockerContext', 'checkTrackedEnvFiles', 'checkDevelopmentSecretCatalog', 'checkEnvTemplates', 'checkReadmeEnvironmentCoverage']) {
    assert.equal(pushed(guard).length, 1, `${guard} is called once and its problems are reported`);
  }
  const arg = (name, i = 0) => pushed(name)[0].arguments[i].getText();
  assert.equal(arg('checkEnvIgnorePolicy'), 'gitIgnoreProbe(root)', 'the ignore rules are evaluated by Git on the repository');
  assert.equal(arg('checkDockerContext'), "readOrUndefined('.dockerignore')");
  assert.equal(named('gitTrackedFiles').length, 1);
  assert.equal(named('gitTrackedFiles')[0].arguments[0].getText(), 'root', 'the tracked files come from the index of the repository');
  assert.equal(arg('checkTrackedEnvFiles'), 'tracked');
  assert.equal(arg('checkDevelopmentSecretCatalog'), 'templates');
  assert.equal(arg('checkDevelopmentSecretCatalog', 1), 'readOrUndefined(DEVELOPMENT_SECRET_CATALOG)');
  assert.equal(arg('checkEnvTemplates'), 'templates');
  const templatesFrom = sf.getFullText().match(/const templates = ([^\n]+)/)?.[1] ?? '';
  assert.match(templatesFrom, /^Object\.fromEntries\(\(tracked \?\? \[\]\)\.filter\(isEnvTemplate\)/, 'the templates are the tracked .env.example files');
  assert.equal(named('isServiceConfigSource').length, 1, 'the README coverage reads the service source');
  // The process.env boundary lives in checkSource, which the runner already calls for every source file (A1.4 wiring test above).
  assert.equal(named('checkSource').length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.1: the migrated operator CLIs read their configuration through the kit's EnvReader and nothing else.
// ---------------------------------------------------------------------------------------------------------------------------------

test('V2 A15.1: a migrated operator CLI hands process.env to EnvReader and reads it in no other way', () => {
  const good = "import { EnvReader } from '../config/config.js';\nconst url = new EnvReader(process.env).get('X_URL'); // process.env.X_URL is not read\nconst s = 'process.env.X';";
  const resolvers = "export function brokerUrl(reader) { return reader.required('RABBITMQ_URL'); } // never process.env";
  const files = (overrides = {}) => ({ ...Object.fromEntries(ENV_READER_CLIS.map((rel) => [rel, good])), [ENV_READER_CLI_RESOLVERS]: resolvers, ...overrides });
  assert.deepEqual(checkEnvReaderClis(files()), []);
  assert.deepEqual(sourceFacts('a.ts', good).envReaderUses, 1);
  assert.deepEqual(sourceFacts('a.ts', good).directEnvUses, 0);
  // Other accepted spellings of the same thing: a named reader, parentheses, more than one reader.
  for (const text of ["const reader = new EnvReader((process.env)); reader.get('X');", "const a = new EnvReader(process.env); const b = new EnvReader(process.env, readFile);"]) {
    assert.deepEqual(checkEnvReaderClis(files({ [ENV_READER_CLIS[0]]: text })), [], text);
  }

  const direct = {
    'named read': "const url = process.env.X_URL;",
    'named read next to the reader': "const r = new EnvReader(process.env); const id = process.env.X_ID;",
    'fallback chain': "const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;",
    'bracket read': "const r = new EnvReader(process.env); const url = process.env['X_URL'];",
    'destructuring': "const r = new EnvReader(process.env); const { X_URL } = process.env;",
    'destructured env': "const { env } = process; const r = new EnvReader(env);",
    'write': "const r = new EnvReader(process.env); process.env.X_EVENTS = 'off';",
    'spread copy': "const r = new EnvReader({ ...process.env });",
    'aliased': "const env = process.env; const r = new EnvReader(env);",
    'another reader class': "const r = new OtherReader(process.env);",
    'second argument': "const r = new EnvReader(fake, process.env);",
  };
  for (const rel of ENV_READER_CLIS) {
    for (const [label, text] of Object.entries(direct)) {
      const problems = checkEnvReaderClis(files({ [rel]: text }));
      assert.equal(problems.length, 1, `${rel}: ${label}`);
      assert.match(problems[0], new RegExp(`^${rel.replace(/[.]/g, '\\.')}: reads process\\.env directly; this operator CLI reads its configuration through the kit's EnvReader`), label);
    }
  }
  // A listed CLI that stops using the reader, or disappears, is reported: the inventory cannot go stale silently.
  assert.match(checkEnvReaderClis(files({ [ENV_READER_CLIS[1]]: 'export const x = 1;' })).join(), /does not read its configuration through new EnvReader\(process\.env\)/);
  assert.match(checkEnvReaderClis(files({ [ENV_READER_CLIS[2]]: undefined })).join(), /is missing; update ENV_READER_CLIS if it moved/);
  assert.equal(checkEnvReaderClis({}).length, ENV_READER_CLIS.length + 1);
  // The shared resolvers take a reader: they never reach the environment, not even to build one.
  for (const text of ["export const brokerUrl = (reader) => process.env.RABBITMQ_URL ?? reader.required('RABBITMQ_URL');", 'export const reader = () => new EnvReader(process.env);']) {
    assert.deepEqual(checkEnvReaderClis(files({ [ENV_READER_CLI_RESOLVERS]: text })), [`${ENV_READER_CLI_RESOLVERS}: reads process.env; the resolvers read only through the EnvReader they are given (V2 A15.1)`]);
  }
  assert.match(checkEnvReaderClis(files({ [ENV_READER_CLI_RESOLVERS]: undefined })).join(), /cli-config\.ts \(the operator CLIs' configuration resolvers\) is missing/);

  // The inventory is the six A15.1 CLIs, A3M.5's retention CLI and (V2 A4.3) Auth's migration CLI; Auth's main.ts and the Organization
  // ownership CLI (A5 / F6 / F7) are not in it, and the path boundary of A2.5 still admits every CLI directory (nothing was removed).
  assert.equal(ENV_READER_CLIS.length, 9); // V2 A3M.5 added nawara-outbox-retention; V2 A4.3 added Auth's migrate.ts; S1c-3 R2a Payment's read-only re-emission dry run
  assert.deepEqual(ENV_READER_CLIS.filter((rel) => /auth-service|organization-service/.test(rel)), ['apps/auth-service/src/cli/migrate.ts']);
  // V2 A4.3: the forms Auth's migration CLI had before (and would drift back to) are refused for it.
  for (const text of [
    "const url = process.env.MIGRATION_DATABASE_URL; if (!url) throw new MigrationError('x');",
    "const url = new EnvReader(process.env).get('MIGRATION_DATABASE_URL') ?? process.env.DATABASE_URL;",
  ]) {
    assert.deepEqual(checkEnvReaderClis(files({ 'apps/auth-service/src/cli/migrate.ts': text })).map((p) => p.split(':')[0]), ['apps/auth-service/src/cli/migrate.ts'], text);
  }
  for (const rel of [...ENV_READER_CLIS, 'apps/auth-service/src/cli/main.ts', 'apps/organization-service/src/cli/ownership.ts']) {
    assert.ok(PROCESS_ENV_BOUNDARY.some((allowed) => allowed.test(rel)), rel);
    assert.deepEqual(checkSource(rel, "const v = process.env.X_VALUE;"), [], rel); // A2.5 is unchanged: the new rule is a separate check
  }
  // The real files satisfy it.
  assert.deepEqual(checkEnvReaderClis(Object.fromEntries([...ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS].map((rel) => [rel, repoFile(rel)]))), []);
});

test('V2 A15.1: the runner checks the migrated operator CLIs', () => {
  const sf = ts.createSourceFile('check-repo.mjs', repoFile('scripts/check-repo.mjs'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'checkEnvReaderClis') calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.equal(calls.length, 1, 'checkEnvReaderClis is called once');
  assert.ok(ts.isSpreadElement(calls[0].parent) && calls[0].parent.parent.expression.getText() === 'problems.push', 'its problems are reported');
  assert.equal(calls[0].arguments[0].getText(), 'Object.fromEntries([...ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS].map((rel) => [rel, readOrUndefined(rel)]))', 'every listed CLI and the resolvers are read from the repository');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.2: one Node major for developers, CI and the images.
// ---------------------------------------------------------------------------------------------------------------------------------

test('V2 A15.2: .nvmrc, engines, Core CI and every application Dockerfile name the same Node major', () => {
  const ci = (version = "'22'", extra = '') => `name: Core CI\non: pull_request\nenv:\n  NODE_VERSION: ${version}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@x\n        with:\n          node-version: \${{ env.NODE_VERSION }}\n${extra}`;
  const dockerfile = (major = '22') => `FROM node:${major}-alpine@sha256:${'a'.repeat(64)} AS build\nRUN true\nFROM node:${major}-alpine@sha256:${'a'.repeat(64)} AS runtime\n`;
  const input = (o = {}) => ({ nvmrc: '22\n', packageJson: '{"engines":{"node":"22.x"}}', ciText: ci(), dockerfiles: { 'apps/x-service/Dockerfile': dockerfile(), 'apps/y-service/Dockerfile': dockerfile() }, ...o });
  assert.deepEqual(checkNodeToolchain(input()), []);
  // Other spellings of the same major pass: the guard compares majors, not text.
  assert.deepEqual(checkNodeToolchain(input({ nvmrc: 'v22.14.0\n', packageJson: '{"engines":{"node":"^22.12.0"}}', ciText: ci('22.x') })), []);
  for (const [text, major] of [['22', 22], ['22.x', 22], ['v22.4.1', 22], ['^22.12.0', 22], ['~22.1', 22], [' 20 ', 20], ['>=22', undefined], ['22 || 24', undefined], ['lts/*', undefined], ['', undefined]]) {
    assert.equal(nodeMajor(text), major, text);
  }

  const one = (o, pattern) => {
    const problems = checkNodeToolchain(input(o));
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], pattern);
  };
  one({ packageJson: '{"engines":{"node":"24.x"}}' }, /^package\.json engines\.node says Node 24, but \.nvmrc says 22: developers, CI and the images must use the same Node major$/);
  one({ packageJson: '{"name":"x"}' }, /^package\.json engines\.node does not name one Node major \(got "nothing"\); \.nvmrc says 22$/);
  one({ packageJson: '{"engines":{"node":">=22"}}' }, /^package\.json engines\.node does not name one Node major \(got ">=22"\)/);
  one({ packageJson: 'not json' }, /^package\.json engines\.node does not name one Node major/);
  one({ ciText: ci("'24'") }, /^core-ci\.yml NODE_VERSION says Node 24, but \.nvmrc says 22/);
  one({ ciText: ci("'22'", '  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/setup-node@x\n        with:\n          node-version: 20\n') }, /^core-ci\.yml job "b" node-version says Node 20, but \.nvmrc says 22/);
  one({ ciText: ci("'22'", '  b:\n    runs-on: ubuntu-latest\n    env:\n      NODE_VERSION: 24\n    steps: []\n') }, /^core-ci\.yml job "b" NODE_VERSION says Node 24/);
  one({ ciText: 'name: Core CI\non: pull_request\njobs: {}\n' }, /^core-ci\.yml declares no Node version/);
  one({ dockerfiles: { 'apps/x-service/Dockerfile': dockerfile(), 'apps/y-service/Dockerfile': dockerfile().replace(/node:22-alpine(@\S+) AS runtime/, 'node:24-alpine$1 AS runtime') } },
    /^apps\/y-service\/Dockerfile \(FROM node:24-alpine\) says Node 24, but \.nvmrc says 22/);
  one({ dockerfiles: { 'apps/x-service/Dockerfile': 'FROM alpine:3.20\n' } }, /^apps\/x-service\/Dockerfile: base image alpine:3\.20 is not a Node image/);
  one({ dockerfiles: {} }, /^no application Dockerfile was found/);
  // .nvmrc is the reference: moving it alone reports every other source; a missing or unusable one stops the check with one message.
  assert.equal(checkNodeToolchain(input({ nvmrc: '20\n' })).length, 1 + 1 + 2); // engines, CI, one per Dockerfile
  for (const nvmrc of [undefined, '', 'lts/iron\n']) assert.deepEqual(checkNodeToolchain(input({ nvmrc })), ['.nvmrc is missing or does not name one Node major (for example "22"); the Node toolchain cannot be checked']);
  // The digest of a pinned image never reaches a diagnostic.
  for (const p of checkNodeToolchain(input({ nvmrc: '20\n' }))) assert.doesNotMatch(p, /sha256/);
});

test('V2 A15.2: the real repository declares one Node major, and the runner checks it', () => {
  const dockerfiles = Object.fromEntries(['auth', 'billing', 'payment', 'organization', 'notification', 'file', 'audit', 'release'].map((s) => [`apps/${s}-service/Dockerfile`, repoFile(`apps/${s}-service/Dockerfile`)]));
  assert.deepEqual(checkNodeToolchain({ nvmrc: repoFile('.nvmrc'), packageJson: repoFile('package.json'), ciText: repoFile('.github/workflows/core-ci.yml'), dockerfiles }), []);
  const runner = repoFile('scripts/check-repo.mjs');
  assert.equal(runner.split('checkNodeToolchain(').length - 1, 1, 'checkNodeToolchain is called once');
  assert.match(runner, /problems\.push\(\.\.\.checkNodeToolchain\(\{ nvmrc: readOrUndefined\('\.nvmrc'\), packageJson: readOrUndefined\('package\.json'\), ciText: readOrUndefined\('\.github\/workflows\/core-ci\.yml'\), dockerfiles \}\)\);/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.4: new-service registration guards.
// ---------------------------------------------------------------------------------------------------------------------------------

test('V2 A15.4: every application and library workspace is in the Core CI matrix, and every image in the smoke matrix', () => {
  const ci = (node, images) => `name: Core CI\non: pull_request\njobs:\n  node:\n    strategy:\n      matrix:\n        include:\n${node.map((w) => `          - name: '${w}'\n            workspace: '${w}'\n`).join('')}  images:\n    strategy:\n      matrix:\n        service: [${images.join(', ')}]\n`;
  const workspaces = ['@nawara/service-kit', 'x-service', 'y-service'];
  assert.deepEqual(checkCiWorkspaceCoverage(ci(workspaces, ['x-service', 'y-service']), { workspaces, imageApps: ['x-service', 'y-service'] }), []);
  // An app without a Dockerfile needs no image entry; a library never does.
  assert.deepEqual(checkCiWorkspaceCoverage(ci(workspaces, ['x-service']), { workspaces, imageApps: ['x-service'] }), []);
  assert.deepEqual(checkCiWorkspaceCoverage(ci(['@nawara/service-kit', 'x-service'], ['x-service', 'y-service']), { workspaces, imageApps: ['x-service', 'y-service'] }),
    ['core-ci.yml: workspace y-service is not in the "node" matrix: CI would never lint, type-check, test or build it (add it; see docs/NEW-SERVICE-CHECKLIST.md)']);
  assert.deepEqual(checkCiWorkspaceCoverage(ci(workspaces, ['x-service']), { workspaces, imageApps: ['x-service', 'y-service'] }),
    ['core-ci.yml: apps/y-service has a Dockerfile but is not in the "images" matrix: CI would never build or boot its image (add it, and its case in scripts/smoke-core-image.sh)']);
  assert.match(checkCiWorkspaceCoverage(ci(workspaces, ['x-service']), { workspaces: [...workspaces, '@nawara/new-lib'], imageApps: [] }).join(), /workspace @nawara\/new-lib is not in the "node" matrix/);
  assert.match(checkCiWorkspaceCoverage('name: Core CI\njobs: {}\n', { workspaces, imageApps: [] }).join('\n'), /job "node" has no matrix\.include[\s\S]*job "images" has no matrix\.service/);
  // The real workflow covers every real workspace, and the runner checks it with workspaces read from the manifests.
  const apps = ['auth', 'billing', 'payment', 'organization', 'notification', 'file', 'audit', 'release'].map((s) => `${s}-service`);
  assert.deepEqual(checkCiWorkspaceCoverage(repoFile('.github/workflows/core-ci.yml'), { workspaces: [...apps, '@nawara/service-kit', '@nawara/audit-contract'], imageApps: apps }), []);
  const runner = repoFile('scripts/check-repo.mjs');
  assert.equal(runner.split('checkCiWorkspaceCoverage(').length - 1, 1);
  assert.match(runner, /checkCiWorkspaceCoverage\(readOrUndefined\('\.github\/workflows\/core-ci\.yml'\), \{ workspaces: \[\.\.\.appPackages\.keys\(\), \.\.\.libWorkspaces\], imageApps \}\)/);
});

test('V2 A15.4 / A4.5: the product-term check covers every application under apps/ automatically, Auth included: no application is exempt', () => {
  // A service that exists in no list anywhere is checked, in its source and its migrations; so is Auth (V2 A4.5).
  for (const rel of ['apps/booking-service/src/a.ts', 'apps/zz-new-service/db/migrations/0001_x.sql', 'apps/accounting-service/src/b.ts', 'apps/auth-service/src/a.ts', 'apps/auth-service/db/migrations/0012_x.sql']) {
    assert.match(checkSource(rel, '// a student books a lesson').join(), /product-specific term/, rel);
  }
  // Outside src and migrations nothing changes, for any service.
  assert.deepEqual(checkSource('apps/booking-service/test/a.e2e-spec.ts', '// a student books').filter((p) => /product-specific/.test(p)), []);
  assert.deepEqual(checkSource('apps/auth-service/test/a.e2e-spec.ts', '// a student books').filter((p) => /product-specific/.test(p)), []);
  // Generic text stays clean.
  assert.deepEqual(checkSource('apps/booking-service/src/a.ts', 'export const capacity = 3; // a booking for an organization member').filter((p) => /product-specific/.test(p)), []);
});

/** Every real Auth file the product-term check reads (`src/**` and `db/migrations/**`), as repository-relative paths. */
const authGenericityFiles = () => ['apps/auth-service/src', 'apps/auth-service/db/migrations'].flatMap((dir) =>
  readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => `${e.parentPath.slice(e.parentPath.indexOf(dir))}/${e.name}`)).sort();

test('V2 A4.5: Auth\'s real files: only the two historical migrations use a product term, and only in their reviewed lines', () => {
  const termed = (rel, text) => checkSource(rel, text).some((p) => /product-specific term/.test(p));
  // Read as another service's files (no historical line set aside): the rule itself finds exactly the two migrations. Before A4.5 it
  // also found src/onboarding/dto.ts (an OpenAPI example, reworded by OD-A4.5-3).
  assert.deepEqual(authGenericityFiles().filter((rel) => termed(rel.replace('apps/auth-service/', 'apps/zz-probe-service/'), repoFile(rel))), [
    'apps/auth-service/db/migrations/0004_organization_join_codes_and_membership.sql',
    'apps/auth-service/db/migrations/0007_multi_organization_membership.sql',
  ]);
  // Read at their real paths, every Auth file passes: the two migrations unchanged, thanks to their exact reviewed lines.
  assert.deepEqual(authGenericityFiles().filter((rel) => termed(rel, repoFile(rel))), []);
  // The rule for the other services is unchanged: source, migrations and identifier shapes.
  for (const [rel, text] of [['apps/billing-service/src/a.ts', 'const studentId = 1;'], ['apps/file-service/db/migrations/0009_x.sql', 'CREATE TABLE lesson_slots (id uuid);'], ['libs/service-kit/src/a.ts', '// drivers']]) {
    assert.match(checkSource(rel, text).join(), /product-specific term/, rel);
  }
});

test('V2 A4.5: the historical-line exception is exact (path and whole line) and can never become a general exemption', () => {
  const [M0004, M0007] = [...GENERICITY_HISTORICAL_LINES.keys()];
  const [L0004] = GENERICITY_HISTORICAL_LINES.get(M0004);
  const [L0007] = GENERICITY_HISTORICAL_LINES.get(M0007);
  const termed = (rel, text) => checkSource(rel, text).some((p) => /product-specific term/.test(p));
  // The inventory: exactly two reviewed lines, in exactly the two applied migrations, each still present verbatim (not stale).
  assert.deepEqual([...GENERICITY_HISTORICAL_LINES.keys()], [
    'apps/auth-service/db/migrations/0004_organization_join_codes_and_membership.sql',
    'apps/auth-service/db/migrations/0007_multi_organization_membership.sql',
  ]);
  for (const [rel, lines] of GENERICITY_HISTORICAL_LINES) {
    assert.match(rel, /^apps\/auth-service\/db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/, `${rel}: only a top-level migration file`);
    assert.equal(lines.length, 1, `${rel}: one reviewed line`);
    for (const line of lines) assert.ok(repoFile(rel).split('\n').includes(line), `${rel}: the reviewed line still exists verbatim`);
  }
  assert.equal(termed(M0004, repoFile(M0004)), false);
  assert.equal(termed(M0007, repoFile(M0007)), false);
  // 1, 2: new terminology in Auth source or in a new Auth migration.
  assert.ok(termed('apps/auth-service/src/onboarding/dto.ts', "description: 'e.g. \"student\"'"));
  assert.ok(termed('apps/auth-service/db/migrations/0012_audience.sql', 'ALTER TABLE x ADD COLUMN "driverId" uuid;'));
  // 3: any other term inside the historical migration (another line) is reported.
  assert.ok(termed(M0004, `${repoFile(M0004)}\n-- a lesson`));
  // 4: the reviewed line modified or with an appended term is no longer the reviewed line.
  assert.ok(termed(M0004, repoFile(M0004).replace(L0004, `${L0004} (and instructor)`)));
  assert.ok(termed(M0007, repoFile(M0007).replace(L0007, L0007.replace('"driver"', '"vehicle"'))));
  assert.ok(termed(M0004, repoFile(M0004).replace(L0004, L0004.trimStart()))); // even its indentation is part of the line
  // 5: the reviewed text copied into another file (another migration, the other historical migration, a source file).
  assert.ok(termed('apps/auth-service/db/migrations/0012_x.sql', L0004));
  assert.ok(termed(M0007, `${repoFile(M0007)}\n${L0004}`));
  assert.ok(termed('apps/auth-service/src/x.ts', L0007));
  // 6: the same path under src/, a down/ migration or another service never carries the exception.
  assert.ok(termed('apps/auth-service/src/0004_organization_join_codes_and_membership.sql', L0004));
  assert.ok(termed('apps/auth-service/db/migrations/down/0004_organization_join_codes_and_membership.down.sql', L0004));
  assert.ok(termed(M0004.replace('auth-service', 'billing-service'), L0004));
});

test('V2 A4.5: no service-wide genericity exemption exists or can return', () => {
  const checks = repoFile('scripts/lib/checks.mjs');
  // 7, 8: the former mechanism is gone, and no application-level exemption is consulted by the product-term check.
  assert.doesNotMatch(checks, /GENERICITY_LEGACY_EXEMPT/);
  const sf = ts.createSourceFile('checks.mjs', checks, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === 'checkSource');
  const inScope = fn?.body?.statements.find((st) => ts.isVariableStatement(st) && st.declarationList.declarations[0]?.name.getText(sf) === 'inNewCore');
  assert.ok(inScope, 'checkSource decides the product-term scope in one inNewCore declaration');
  assert.equal(inScope.getText(sf), "const inNewCore = coreApp !== undefined || relPath.startsWith('libs/audit-contract/');");
  for (const app of ['auth-service', 'billing-service', 'zz-new-service']) assert.ok(checkSource(`apps/${app}/src/a.ts`, '// classroom').join().includes('product-specific term'), app);
});

// V2 A3M.2: per-service event contracts.
test('V2 A3M.2: event contracts agree across services; every app with event traffic declares one', () => {
  const f = (type, more = {}) => ({ type, ...more });
  const producer = (produces, service = 'p-service') => JSON.stringify({ service, produces, consumes: [] });
  const consumer = (consumes, service = 'c-service') => JSON.stringify({ service, produces: [], consumes });
  const paid = { name: 'thing.paid', version: 1, payload: { id: f('uuid'), amount: f('integer'), org: f('string', { nullable: true }), kind: f('enum', { values: ['a', 'b'] }), at: f('datetime', { optional: true }) } };
  const needs = (requires, more = {}) => ({ source: 'p-service', name: 'thing.paid', version: 1, requires, ...more });
  const run = (contracts, required = Object.keys(contracts)) => checkEventContracts(contracts, required);
  const ok = { 'p-service': producer([paid]), 'c-service': consumer([needs({ id: f('id'), amount: f('integer'), org: f('string', { nullable: true }), kind: f('enum', { values: ['a', 'b', 'c'] }) })]) };
  assert.deepEqual(run(ok), []);

  const fails = (contracts, pattern, required) => assert.match(run(contracts, required).join('\n'), pattern);
  // a field the consumer requires is missing at the producer
  fails({ ...ok, 'c-service': consumer([needs({ id: f('id'), missing: f('string') })]) }, /the required field missing is not declared by the producer/);
  // an incompatible version, and an unknown event or source
  fails({ ...ok, 'c-service': consumer([needs({ id: f('id') }, { version: 2 })]) }, /publishes thing\.paid at version 1, not 2/);
  fails({ ...ok, 'c-service': consumer([needs({ id: f('id') }, { name: 'thing.unknown' })]) }, /p-service publishes no event named thing\.unknown/);
  fails({ ...ok, 'c-service': consumer([needs({ id: f('id') }, { source: 'x-service' })]) }, /x-service publishes no event named thing\.paid/);
  // nullability, optionality and type mismatches
  fails({ ...ok, 'c-service': consumer([needs({ org: f('string') })]) }, /field org may be null at the producer but the consumer requires a value/);
  fails({ ...ok, 'c-service': consumer([needs({ at: f('datetime') })]) }, /field at may be absent at the producer/);
  fails({ ...ok, 'c-service': consumer([needs({ amount: f('string') })]) }, /field amount is a integer at the producer but the consumer requires a string/);
  fails({ ...ok, 'c-service': consumer([needs({ kind: f('enum', { values: ['a'] }) })]) }, /field kind may be b, which the consumer does not accept/);
  // two producers for one name; an audit event; a code-bearing event outside auth-service; bad grammar and versions
  fails({ ...ok, 'q-service': producer([paid], 'q-service') }, /already published by p-service: an event has exactly one producer/);
  fails({ 'p-service': producer([{ ...paid, name: 'audit.thing.paid' }]) }, /audit events are governed by @nawara\/audit-contract/);
  fails({ 'p-service': producer([{ ...paid, codeBearing: true }]) }, /only auth-service may publish a code-bearing event/);
  assert.deepEqual(run({ 'auth-service': producer([{ ...paid, codeBearing: true }], 'auth-service') }), []);
  fails({ 'p-service': producer([{ ...paid, name: 'Thing' }]) }, /the name must be dotted lowercase/);
  fails({ 'p-service': producer([{ ...paid, version: 0 }]) }, /the version must be a positive integer/);
  fails({ 'p-service': producer([{ ...paid, payload: { id: f('number') } }]) }, /type must be one of/);
  fails({ 'p-service': producer([{ ...paid, payload: { k: f('enum') } }]) }, /an enum must list its string values/);
  fails({ 'p-service': '{ not json' }, /not valid JSON/);
  fails({ 'p-service': producer([paid], 'other-service') }, /"service" must be "p-service"/);
  // registration: an app with event traffic and no contract; the named exemption
  fails({ ...ok, 'n-service': undefined }, /apps\/n-service\/contracts\/events\.json is missing/, ['p-service', 'c-service', 'n-service']);
  assert.deepEqual(run(ok, [...Object.keys(ok), 'audit-service']), []);
  assert.deepEqual([...EVENT_CONTRACT_EXEMPT.keys()], ['audit-service']);
  // the presence scan (a scan of source text, not a proof: emit sites are bound by each producer's compile-time typing)
  assert.equal(usesEventTraffic(['await this.outbox.enqueue(q, ev);']), true);
  assert.equal(usesEventTraffic(['const sub = await this.bus.subscribe({ queue: Q, bindings, handler });']), true);
  assert.equal(usesEventTraffic(['await this.writer.write(q, input);']), false);

  // The real contracts agree, and they hold the inventory: 18 produced events, 13 consumed entries.
  const real = Object.fromEntries(['auth-service', 'payment-service', 'billing-service', 'notification-service'].map((a) => [a, repoFile(`apps/${a}/contracts/events.json`)]));
  assert.deepEqual(checkEventContracts(real, ['auth-service', 'payment-service', 'billing-service', 'notification-service', 'audit-service']), []);
  const all = Object.values(real).map((t) => JSON.parse(t));
  assert.equal(all.flatMap((c) => c.produces).length, 18);
  assert.equal(all.flatMap((c) => c.consumes).length, 13);
  const runner = repoFile('scripts/check-repo.mjs');
  assert.equal(runner.split('checkEventContracts(').length - 1, 1);
  assert.match(runner, /if \(usesEventTraffic\(texts\)\) required\.push\(app\);/);
});

// V2 A3M.5: outbox retention eligibility.
test('V2 A3M.5: outbox retention stays limited to reviewed services that let the outbox generate their event ids', () => {
  const core = repoFile('libs/service-kit/src/events/outbox-retention.ts');
  const cli = repoFile('libs/service-kit/src/cli/outbox-retention.ts');
  const clean = { 'apps/auth-service/src/a.ts': 'await this.outbox.enqueue(q, { name, payload, version: 1 });', 'apps/auth-service/src/b.ts': 'await this.writer.write(q, input, options);' };
  const sources = (over = {}) => ({ 'auth-service': { ...clean, ...over }, 'organization-service': { 'apps/organization-service/src/a.ts': 'await this.writer.write(q, { action });' } });
  const run = (kit = {}, over = {}) => checkOutboxRetentionEligibility({ core, cli, ...kit }, sources(over));
  const fails = (problems, pattern) => assert.match(problems.join('\n'), pattern);
  assert.deepEqual(OUTBOX_RETENTION_APPROVED_SERVICES, ['auth-service', 'organization-service']);
  assert.deepEqual(run(), []);

  // an approved producer starting to supply a stable id: at the enqueue call, through the audit writer, or in an options object built first
  fails(run({}, { 'apps/auth-service/src/x.ts': 'await this.outbox.enqueue(q, { id: user.id, name, payload });' }), /apps\/auth-service\/src\/x\.ts: line 1: supplies an id to the outbox/);
  fails(run({}, { 'apps/auth-service/src/x.ts': 'await this.writer.write(q, input, { eventId: user.id });' }), /builds an eventId/);
  fails(run({}, { 'apps/auth-service/src/x.ts': 'const options = { eventId };\nawait audit.record(q, input, options);' }), /line 1: builds an eventId/);
  fails(run({}, { 'apps/auth-service/src/x.ts': 'await this.outbox.enqueue(q, { ...event });' }), /passes a spread object to \.enqueue/);
  // an approved producer using a deterministic event-id generator
  fails(run({}, { 'apps/auth-service/src/x.ts': "import { deterministicEventId } from './id.js';\nconst id = deterministicEventId(a, b);" }), /uses deterministicEventId \(a derived event id\)/);
  assert.match(run({}, { 'apps/auth-service/src/x.ts': 'await this.outbox.enqueue(q, { id: user.id, name, payload });' }).join(), /needs a retention-safety review and the service's removal from the approved list/);
  // an unapproved service added to the kit's list, a service removed, a list that is not a literal
  fails(run({ core: core.replace("['auth-service', 'organization-service'] as const", "['auth-service', 'organization-service', 'payment-service'] as const") }), /OUTBOX_RETENTION_VERIFIED_SERVICES is \[auth-service, organization-service, payment-service\] but the approved list is \[auth-service, organization-service\]/);
  fails(run({ core: core.replace("['auth-service', 'organization-service'] as const", "['auth-service'] as const") }), /but the approved list is/);
  fails(run({ core: core.replace("['auth-service', 'organization-service'] as const", 'SERVICES') }), /must be a literal list/);
  // the CLI no longer requiring or checking --service, losing the database-owner check, or gaining a bypass; the id rule weakened
  fails(run({ cli: cli.replace('--service <name> is required', '--service is optional') }), /must require --service and check it/);
  fails(run({ cli: cli.replace('isRetentionService(service)', 'true') }), /must require --service and check it/);
  fails(run({ cli: cli.replace('retentionDatabaseOwner(args.service)', 'actual.owner') }), /must check that the database is owned by the role provisioned for --service/);
  fails(run({ cli: `${cli}\n// else if (a === '--all-services') all = true;` }), /has an option that widens the retention scope \(--all-services\)/);
  fails(run({ cli: `${cli}\n// '--include-deterministic'` }), /widens the retention scope \(--include-deterministic\)/);
  fails(run({ core: core.replace("= '4'", "IN ('4', '5')") }), /eligibility must stay restricted to random \(version 4\) ids/);
  // missing files and a missing approved service are reported, not thrown
  assert.match(checkOutboxRetentionEligibility({ core: undefined, cli }, sources()).join(), /is missing/);
  fails(checkOutboxRetentionEligibility({ core, cli }, { 'auth-service': clean }), /apps\/organization-service\/src was not found/);
  // the scanner itself: what it sees, and one thing it does not (stated in the guard's own limits)
  assert.deepEqual(outboxIdSources('a.ts', 'await outbox.enqueue(q, { name, payload });'), []);
  assert.deepEqual(outboxIdSources('a.ts', 'const ev = { id: stable, name, payload };\nawait outbox.enqueue(q, ev);'), []); // not seen: an id in an event built elsewhere
  // the real kit files, CLI and services pass, and the runner calls the check with the approved services' sources
  const runner = repoFile('scripts/check-repo.mjs');
  assert.equal(runner.split('checkOutboxRetentionEligibility(').length - 1, 1);
  assert.match(runner, /for \(const service of OUTBOX_RETENTION_APPROVED_SERVICES\)/);
});

// V2 A5.4-T1: the Auth → Organization Service dependency boundary (ADR-0042 decision 8, ADR-0063 §5).
test('A5.4-T1: auth-service reaches Organization Service only from its approved administrative operations', () => {
  const SRC = 'apps/auth-service/src/';
  const srcDir = new URL('../apps/auth-service/src/', import.meta.url);
  const real = {};
  const collect = (dir, prefix) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) collect(new URL(`${name.name}/`, dir), `${prefix}${name.name}/`);
      else if (name.name.endsWith('.ts') && !name.name.endsWith('.spec.ts') && !name.name.endsWith('.d.ts')) real[`${SRC}${prefix}${name.name}`] = readFileSync(new URL(name.name, dir), 'utf8');
    }
  };
  collect(srcDir, '');
  const run = (changes = {}) => checkAuthOrganizationBoundary({ ...real, ...changes });
  const edit = (rel, from, to) => {
    const text = real[SRC + rel];
    assert.ok(text.includes(from), `${rel} no longer contains: ${from}`);
    return { [SRC + rel]: text.replace(from, to) };
  };
  const add = (rel, extra) => ({ [SRC + rel]: `${real[SRC + rel]}\n${extra}\n` });
  const fails = (problems, pattern) => assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got:\n${problems.join('\n') || '(no problem)'}`);

  // 1. the real auth-service passes, with every approved administrative caller in place
  assert.deepEqual(run(), []);
  assert.deepEqual(AUTH_ORGANIZATION_OPERATIONS.map((op) => op.operation), ['join-code creation', 'organization-admin invitation creation', 'operator platform-assignment grant', 'owner bootstrap (command line)', 'hierarchy reference repair']);
  assert.equal(AUTH_ORGANIZATION_CLIENT, `${SRC}hierarchy/hierarchy-reference.ts`);

  // 2. a DIRECT forbidden dependency: a never-call module imports the client (each static form)
  const importClient = "import { HierarchyReference } from '../hierarchy/hierarchy-reference.js';";
  fails(run(add('auth/auth.service.ts', importClient)), /auth\/auth\.service\.ts: imports the Organization Service client/);
  fails(run(add('auth/grants.service.ts', "import type { HierarchyReference } from '../hierarchy/hierarchy-reference.js';\nexport type T = HierarchyReference;")), /auth\/grants\.service\.ts: imports the Organization Service client/);
  fails(run(add('auth/session.service.ts', "const h = await import('../hierarchy/hierarchy-reference.js');")), /auth\/session\.service\.ts: imports the Organization Service client/);
  fails(run(add('platform/platform-access.service.ts', "export { HierarchyReference } from '../hierarchy/hierarchy-reference.js';")), /platform-access\.service\.ts: (imports|re-exports) the Organization Service client/);
  fails(run({ [`${SRC}auth/new-flow.service.ts`]: `${importClient}\nexport const x = HierarchyReference;` }), /auth\/new-flow\.service\.ts: imports the Organization Service client/);
  // a holder may not re-export the client either (that would let any module obtain it without importing it)
  fails(run(add('onboarding/onboarding.service.ts', 'export { HierarchyReference };')), /onboarding\.service\.ts: re-exports the Organization Service client/);

  // 3. in a holder, a never-call METHOD may not touch the client (the class serves registration and join too)
  const firstTouch = 'if (!(await this.hierarchy.firstTouchOrganization(organizationId))) throw notFound();';
  fails(run(edit('onboarding/onboarding.service.ts', '  async resolve(rawCode: string, client: ClientInfo) {', '  async resolve(rawCode: string, client: ClientInfo) {\n    await this.hierarchy.firstTouchOrganization(rawCode);')),
    /onboarding\.service\.ts: OnboardingService\.resolve → Organization Service client .*only OnboardingService\.create may reach it/);
  fails(run(edit('onboarding/invitation.service.ts', '  async accept(', '  async touch() { return this.hierarchy.ensure(\'organization\', \'x\'); }\n  async accept(')),
    /invitation\.service\.ts: InvitationService\.touch → Organization Service client/);
  fails(run(edit('platform/assignment.service.ts', '  async revoke(', '  async leak() { return this.hierarchy; }\n  async revoke(')), /assignment\.service\.ts: AssignmentService\.leak → Organization Service client/);
  assert.ok(real[`${SRC}onboarding/onboarding.service.ts`].includes(firstTouch)); // the approved first touch itself is still there

  // 4. an INDIRECT forbidden dependency: a never-call path calls an administrative operation
  fails(run(edit('auth/auth.service.ts', 'await this.onboarding.guardGuessing(client);', 'await this.onboarding.guardGuessing(client);\n    await this.onboarding.create({} as never, \'o\', {} as never, undefined, \'ip\');')),
    /auth\/auth\.service\.ts: AuthService\.\w+ → OnboardingService\.create → Organization Service \(join-code creation\); its only approved callers are membership\/organization\.controller\.ts#OrganizationController\.createJoinCode/);
  // through a new intermediate service, the chain breaks at the first unapproved hop
  fails(run({ [`${SRC}auth/helper.service.ts`]: "import { AssignmentService } from '../platform/assignment.service.js';\nexport class Helper {\n  constructor(private readonly assignments: AssignmentService) {}\n  go() { return this.assignments.grant({} as never, 'a', 'b', undefined, 'ip'); }\n}" }),
    /auth\/helper\.service\.ts: Helper\.go → AssignmentService\.grant → Organization Service \(operator platform-assignment grant\)/);
  // obtained from the container instead of injected, and from another method of the holder itself
  fails(run(add('auth/session.service.ts', "import { InvitationService } from '../onboarding/invitation.service.js';\nexport const sneak = (moduleRef: { get(t: unknown): InvitationService }) => moduleRef.get(InvitationService).create({} as never, 'o', {} as never, undefined, 'ip');")),
    /auth\/session\.service\.ts: sneak → InvitationService\.create → Organization Service/);
  fails(run(edit('onboarding/onboarding.service.ts', '  async resolve(rawCode: string, client: ClientInfo) {', '  async resolve(rawCode: string, client: ClientInfo) {\n    await this.create({} as never, rawCode, {} as never, undefined, client.ip);')),
    /onboarding\.service\.ts: OnboardingService\.resolve → OnboardingService\.create → Organization Service/);
  // another handler of the same controller, and a second caller of the command-line bootstrap
  fails(run(edit('membership/organization.controller.ts', 'return this.invitations.create(this.actor(req), org, dto, su, this.ip(req));', 'return this.onboarding.create(this.actor(req), org, dto as never, su, this.ip(req));')),
    /organization\.controller\.ts: OrganizationController\.createInvitation → OnboardingService\.create/);
  fails(run(add('cli/check-config.ts', "import { bootstrapOwner } from './owner-tools.js';\nexport const again = () => bootstrapOwner(undefined as never, undefined as never, undefined as never, { companyName: 'c', email: 'e', password: 'p' });")),
    /cli\/check-config\.ts: again → bootstrapOwner → Organization Service \(owner bootstrap \(command line\)\)/);
  // an approved handler is an entry point: its own class does not call it
  fails(run(edit('platform/platform.controller.ts', '  @Post(\'admin/operators/:id/platform-assignments\')', '  viaHandler() { return this.grant(\'a\', {} as never, {} as never); }\n\n  @Post(\'admin/operators/:id/platform-assignments\')')),
    /platform\.controller\.ts: PlatformController\.viaHandler → PlatformController\.grant \(an approved Organization Service entry point\)/);

  // 5. no second client: outbound HTTP and the Organization Service credential stay in their modules
  fails(run(add('auth/auth.service.ts', "export const ping = () => fetch('http://organization-service/organization/companies/x');")), /auth\/auth\.service\.ts: ping calls fetch/);
  fails(run(add('auth/grants.service.ts', "import { request } from 'node:https';\nexport const r = request;")), /auth\/grants\.service\.ts: imports node:https/);
  fails(run(add('tokens/token.service.ts', "import { request } from 'undici';\nexport const r = request;")), /tokens\/token\.service\.ts: imports undici/);
  fails(run(add('auth/session.service.ts', 'export const url = (c: { hierarchy: { client?: { baseUrl: string } } }) => c.hierarchy.client?.baseUrl;')), /auth\/session\.service\.ts: url reads auth-service's Organization Service credential/);
  fails(run(add('members/member-security.service.ts', "export const name = 'ORGANIZATION_SERVICE_TOKEN';")), /member-security\.service\.ts: .* reads auth-service's Organization Service credential/);

  // 6. the permitted administrative dependencies still pass when their own code changes shape
  assert.deepEqual(run(edit('onboarding/onboarding.service.ts', firstTouch, `const known = await this.hierarchy.firstTouchOrganization(organizationId);\n    if (!known) throw notFound();`)), []);
  assert.deepEqual(run(edit('platform/platform.controller.ts', 'return this.assignments.grant({ userId: req.actor.userId, sid: req.actor.sid }, id, dto.platformId, su, this.ip(req));', 'const granted = await this.assignments.grant({ userId: req.actor.userId, sid: req.actor.sid }, id, dto.platformId, su, this.ip(req));\n    return granted;')), []);
  // a never-call path keeps using the same holder for its own, never-call, methods
  assert.match(real[`${SRC}auth/auth.service.ts`], /this\.onboarding\.redeem\(/);

  // 7. the policy cannot drift: a renamed method or file is reported, and a never-call path can never be listed as approved
  fails(run(edit('onboarding/onboarding.service.ts', '  async create(', '  async createCode(')), /onboarding\.service\.ts#OnboardingService\.create: named by the Auth → Organization Service boundary policy but not found/);
  const without = { ...real };
  delete without[`${SRC}auth/grants.service.ts`];
  fails(checkAuthOrganizationBoundary(without), /auth\/grants\.service\.ts: named by the Auth → Organization Service boundary policy but not found/);
  assert.deepEqual(checkAuthOrganizationBoundary({}), ['auth-service sources were not found; the Auth → Organization Service boundary cannot be checked']);
  const approved = AUTH_ORGANIZATION_OPERATIONS.flatMap((op) => [`${op.holder}#${op.owner ? `${op.owner}.${op.member}` : op.member}`, ...op.callers]);
  for (const key of approved) {
    assert.ok(!AUTH_NEVER_CALL.modules.includes(key.split('#')[0]), `${key} is in a never-call module`);
    assert.ok(!AUTH_NEVER_CALL.contexts.includes(key), `${key} is a never-call context`);
  }
  // decision 8's list is named: login and logout, sessions, registration and join, onboarding resolution, /auth/me and /auth/grants, access reads
  for (const rel of ['auth/auth.service.ts', 'auth/auth.controller.ts', 'auth/session.service.ts', 'auth/grants.service.ts', 'platform/platform-access.service.ts', 'onboarding/onboarding.controller.ts']) {
    assert.ok(AUTH_NEVER_CALL.modules.includes(SRC + rel), `${rel} must stay a never-call module`);
  }
  for (const ctx of ['onboarding/onboarding.service.ts#OnboardingService.redeem', 'onboarding/invitation.service.ts#InvitationService.accept', 'platform/platform.controller.ts#PlatformController.platformAccess', 'platform/platform.controller.ts#PlatformController.organization']) {
    assert.ok(AUTH_NEVER_CALL.contexts.includes(SRC + ctx), `${ctx} must stay a never-call context`);
  }

  // 8. inheritance: no class extends a holder or an approved controller, so an operation cannot be inherited and called from anywhere
  const onb = "import { OnboardingService } from '../onboarding/onboarding.service.js';";
  const file = (rel, text) => ({ [SRC + rel]: text });
  // direct subclassing fails on the relationship itself, even when the subclass calls nothing
  fails(run(file('auth/sub.service.ts', `${onb}\nexport class Sub extends OnboardingService {}`)),
    /auth\/sub\.service\.ts: class Sub extends OnboardingService inherits from an Organization Service holder \(onboarding\/onboarding\.service\.ts\); no class may extend one/);
  // indirect subclassing through an intermediate class, in another file, reports the whole chain; the intermediate is reported too
  const indirect = run({ ...file('auth/mid.service.ts', `${onb}\nexport class Mid extends OnboardingService {}`), ...file('auth/leaf.service.ts', "import { Mid } from './mid.service.js';\nexport class Leaf extends Mid {}") });
  fails(indirect, /auth\/leaf\.service\.ts: class Leaf extends Mid extends OnboardingService inherits from an Organization Service holder/);
  fails(indirect, /auth\/mid\.service\.ts: class Mid extends OnboardingService inherits from an Organization Service holder/);
  // the other holders, an alias, a namespace import, a re-export, a default export, a class expression and a mixin are followed
  fails(run(file('auth/a.ts', "import { InvitationService as Base } from '../onboarding/invitation.service.js';\nexport class A extends Base {}")), /auth\/a\.ts: class A extends InvitationService inherits from an Organization Service holder/);
  fails(run(file('auth/b.ts', "import * as p from '../platform/assignment.service.js';\nexport class B extends p.AssignmentService {}")), /auth\/b\.ts: class B extends AssignmentService inherits from an Organization Service holder/);
  fails(run({ ...file('auth/barrel.ts', "export { OnboardingService as Onb } from '../onboarding/onboarding.service.js';"), ...file('auth/c.ts', "import { Onb } from './barrel.js';\nexport class C extends Onb {}") }), /auth\/c\.ts: class C extends OnboardingService inherits/);
  fails(run({ ...file('auth/star.ts', "export * from '../onboarding/onboarding.service.js';"), ...file('auth/d.ts', "import { OnboardingService } from './star.js';\nexport class D extends OnboardingService {}") }), /auth\/d\.ts: class D extends OnboardingService inherits/);
  fails(run({ ...file('auth/def.ts', `${onb}\nexport default class Def extends OnboardingService {}`), ...file('auth/e.ts', "import Def from './def.js';\nexport class E extends Def {}") }), /auth\/e\.ts: class E extends Def extends OnboardingService inherits/);
  fails(run(file('auth/f.ts', `${onb}\nexport const F = class extends OnboardingService {};`)), /auth\/f\.ts: class F extends OnboardingService inherits/);
  fails(run(file('auth/g.ts', `${onb}\nconst Mixin = <T>(base: T) => base;\nexport class G extends Mixin(OnboardingService) {}`)), /auth\/g\.ts: class G extends OnboardingService inherits/);
  // an interface that extends a holder is the same relationship as a type, and a service typed with it is followed
  fails(run(file('auth/i.ts', `${onb}\nexport interface Like extends OnboardingService {}`)), /auth\/i\.ts: interface Like extends OnboardingService inherits from an Organization Service holder/);
  fails(run(file('auth/i.ts', `${onb}\ninterface Like extends OnboardingService {}\nexport class Uses {\n  constructor(private readonly o: Like) {}\n  go() { return this.o.create({} as never, 'o', {} as never, undefined, 'ip'); }\n}`)),
    /auth\/i\.ts: Uses\.go → OnboardingService\.create → Organization Service/);
  // an approved administrative controller cannot be subclassed either
  fails(run(file('membership/sub.controller.ts', "import { OrganizationController } from './organization.controller.js';\nexport class SubController extends OrganizationController {}")),
    /membership\/sub\.controller\.ts: class SubController extends OrganizationController inherits from an approved administrative controller \(membership\/organization\.controller\.ts\)/);
  fails(run(file('platform/sub.controller.ts', "import { PlatformController } from './platform.controller.js';\nexport class P2 extends PlatformController {}")), /platform\/sub\.controller\.ts: class P2 extends PlatformController inherits from an approved administrative controller/);
  // an inherited operation cannot bypass the caller restrictions: `super.create`, `this.create` and an instance of the subclass are all refused
  const viaSuper = run(file('auth/sub.service.ts', `${onb}\nexport class Sub extends OnboardingService {\n  go() { return super.create({} as never, 'o', {} as never, undefined, 'ip'); }\n}`));
  fails(viaSuper, /auth\/sub\.service\.ts: class Sub extends OnboardingService inherits/);
  fails(viaSuper, /auth\/sub\.service\.ts: Sub\.go → OnboardingService\.create → Organization Service \(join-code creation\); its only approved callers are/);
  fails(run(file('auth/sub.service.ts', `${onb}\nexport class Sub extends OnboardingService {\n  go() { return this.create({} as never, 'o', {} as never, undefined, 'ip'); }\n}`)), /auth\/sub\.service\.ts: Sub\.go → OnboardingService\.create → Organization Service/);
  fails(run({ ...file('auth/sub.service.ts', `${onb}\nexport class Sub extends OnboardingService {}`), ...file('auth/user.service.ts', "import { Sub } from './sub.service.js';\nexport class User {\n  constructor(private readonly sub: Sub) {}\n  go() { return this.sub.create({} as never, 'o', {} as never, undefined, 'ip'); }\n}") }),
    /auth\/user\.service\.ts: User\.go → OnboardingService\.create → Organization Service/);
  // unrelated inheritance stays permitted: an external base, a never-call service, a local base class, and a cycle does not hang
  assert.deepEqual(run({
    ...file('auth/errors2.ts', 'export class Refused extends Error {}'),
    ...file('auth/base.service.ts', 'export class Base {}\nexport class Derived extends Base {}'),
    ...file('auth/grants2.service.ts', "import { GrantsService } from './grants.service.js';\nexport class Grants2 extends GrantsService {}"),
    ...file('auth/cycle.ts', "import { Two } from './cycle2.js';\nexport class One extends Two {}"),
    ...file('auth/cycle2.ts', "import { One } from './cycle.js';\nexport class Two extends One {}"),
  }), []);
  // the real services and controllers still pass (case 1), and the real code has no subclass of a holder
  assert.ok(!Object.values(real).some((text) => /extends\s+(OnboardingService|InvitationService|AssignmentService|OrganizationController|PlatformController)\b/.test(text)));

  // 9. declared-type indirection: an operation called through a name that only STANDS FOR the holder is still that operation
  const args = "({} as never, 'o', {} as never, undefined, 'ip')";
  const joinCode = /→ OnboardingService\.create → Organization Service \(join-code creation\); its only approved callers are membership\/organization\.controller\.ts#OrganizationController\.createJoinCode/;
  const uses = (declaration, type) => `${declaration}\nexport class Uses {\n  constructor(private readonly o: ${type}) {}\n  go() { return this.o.create${args}; }\n}`;
  // a same-file type alias, and an alias of an alias
  fails(run(file('auth/t.ts', uses(`${onb}\ntype Onb = OnboardingService;`, 'Onb'))), /auth\/t\.ts: Uses\.go → OnboardingService\.create/);
  fails(run(file('auth/t.ts', uses(`${onb}\ntype Onb = OnboardingService;\ntype Again = Onb | undefined;`, 'Again'))), joinCode);
  // an imported type alias, through `import type`, a re-export and a second alias in another file
  const aliasFile = file('auth/alias.ts', `${onb}\nexport type Onb = OnboardingService;`);
  fails(run({ ...aliasFile, ...file('auth/t.ts', uses("import type { Onb } from './alias.js';", 'Onb')) }), /auth\/t\.ts: Uses\.go → OnboardingService\.create/);
  fails(run({ ...aliasFile, ...file('auth/barrel.ts', "export type { Onb as Svc } from './alias.js';"), ...file('auth/t.ts', uses("import type { Svc } from './barrel.js';\ntype Mine = Svc;", 'Mine')) }), joinCode);
  // typeof and InstanceType<typeof …>, directly and behind an alias
  fails(run(file('auth/t.ts', uses(onb, 'InstanceType<typeof OnboardingService>'))), joinCode);
  fails(run(file('auth/t.ts', uses(`${onb}\ntype Ctor = typeof OnboardingService;\ntype Inst = InstanceType<Ctor>;`, 'Inst'))), joinCode);
  // a cast that names the class or one of its aliases: on the receiver, doubled, in angle brackets, and kept in a variable
  const cast = (expression, declaration = onb) => file('auth/t.ts', `${declaration}\nexport class Uses {\n  constructor(private readonly x: unknown) {}\n  go() { ${expression} }\n}`);
  fails(run(cast(`return (this.x as OnboardingService).create${args};`)), joinCode);
  fails(run(cast(`return (this.x as unknown as OnboardingService).create${args};`)), joinCode);
  fails(run(cast(`return (<OnboardingService>this.x).create${args};`)), joinCode);
  fails(run(cast(`const o = this.x as OnboardingService;\n    return o.create${args};`)), joinCode);
  fails(run(cast(`return (this.x as Onb).create${args};`, `${onb}\ntype Onb = OnboardingService;`)), joinCode);
  // import aliases in these declarations: a renamed import, a namespace import, and a generic constraint
  fails(run(file('auth/t.ts', uses("import { OnboardingService as O } from '../onboarding/onboarding.service.js';\ntype A = O;", 'A'))), joinCode);
  fails(run(file('auth/t.ts', uses("import * as onbs from '../onboarding/onboarding.service.js';", 'onbs.OnboardingService'))), joinCode);
  fails(run(file('auth/t.ts', uses("import * as onbs from '../onboarding/onboarding.service.js';\ntype A = onbs.OnboardingService;", 'A'))), joinCode);
  fails(run(file('auth/t.ts', `${onb}\nexport const go = <T extends OnboardingService>(o: T) => o.create${args};`)), /auth\/t\.ts: go → OnboardingService\.create/);
  // the other holders, and an approved controller handler reached through a typed, aliased or cast instance
  fails(run(file('auth/t.ts', "import { AssignmentService } from '../platform/assignment.service.js';\ntype A = AssignmentService;\nexport const go = (a: A) => a.grant({} as never, 'a', 'b', undefined, 'ip');")), /auth\/t\.ts: go → AssignmentService\.grant → Organization Service \(operator platform-assignment grant\)/);
  const ctl = "import { OrganizationController } from '../membership/organization.controller.js';";
  fails(run(file('auth/t.ts', `${ctl}\nexport const go = (c: OrganizationController) => c.createJoinCode('o', {} as never, {} as never);`)),
    /auth\/t\.ts: go → OrganizationController\.createJoinCode \(an approved Organization Service entry point\); only its route may run it/);
  fails(run(file('auth/t.ts', `${ctl}\ntype C = OrganizationController;\nexport const go = (c: unknown) => (c as C).createInvitation('o', {} as never, {} as never);`)), /auth\/t\.ts: go → OrganizationController\.createInvitation \(an approved/);
  // ordinary unrelated aliases and casts do not fail, nor does a holder alias that calls only never-call or unrelated methods
  assert.deepEqual(run({
    ...file('auth/ok1.ts', "import { GrantsService } from './grants.service.js';\ntype G = GrantsService;\nexport const a = (g: G) => g.forUser('u');\nexport const b = (x: unknown) => (x as GrantsService).forUser('u');"),
    ...file('auth/ok2.ts', "type Maker = { create(): void };\nexport const c = (m: Maker) => m.create();\nexport const d = (x: unknown) => (x as Maker).create();\nexport const e = <T extends Maker>(m: T) => m.create();"),
    ...file('auth/ok3.ts', `${onb}\ntype Onb = OnboardingService;\nexport const f = (o: Onb) => o.list({} as never, 'o');\nexport const g = (x: unknown) => (x as OnboardingService).resolve('c', {} as never);`),
    ...file('auth/ok4.ts', `${onb}\nexport type Shape = { service: OnboardingService; many: OnboardingService[] };\nexport const h = (s: { create(): void }, _shape?: Shape) => s.create();`),
  }), []);
  // the earlier protections are unchanged by this rule (cases 2 to 8 above ran against the same check)
  assert.deepEqual(run(), []);

  // the runner calls the check once, with auth-service's non-test sources
  const runner = readFileSync(new URL('./check-repo.mjs', import.meta.url), 'utf8');
  assert.equal(runner.split('checkAuthOrganizationBoundary(').length - 1, 1);
  assert.match(runner, /apps\/auth-service\/src/);
});

// V2 A5.4-A3 O2: the producer scope of the four reference-repair audit actions (ADR-0061 §6, ADR-0064; A3 design §11.3).
// This check replaced the two "producer-less" assertions of libs/audit-contract/test (reference-repair-catalog.spec.ts and
// reference-repair-batch2.spec.ts); `legacy` below is their logic, kept here to prove the replacement covers at least what they did.
test('A5.4-A3 O2: the reference-repair audit actions are named only inside their approved producer scope', () => {
  const real = {};
  const collect = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      if (entry.isDirectory()) collect(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`);
      else if (repairAuditScanned(`${prefix}${entry.name}`)) real[`${prefix}${entry.name}`] = readFileSync(new URL(entry.name, dir), 'utf8');
    }
  };
  for (const top of ['apps', 'libs']) collect(new URL(`../${top}/`, import.meta.url), `${top}/`);
  const run = (changes = {}) => checkRepairAuditProducerScope({ ...real, ...changes });
  const fails = (problems, path) => assert.ok(problems.some((p) => p.startsWith(`${path}: names the reference-repair audit action`)), `expected a problem for ${path}, got:\n${problems.join('\n') || '(no problem)'}`);
  const use = (action) => `await central.write(q, { action: '${action}' });\n`;
  /** The two replaced assertions, as they were: a path they would have reported. */
  const legacy = (path, text) => {
    const noDotOrBuild = !path.split('/').some((seg) => seg === 'node_modules' || seg === 'dist' || seg.startsWith('.'));
    const batch1 = path.startsWith('apps/') && /\.(ts|js|mjs|json)$/.test(path) && /hierarchy\.reference_repair(ed|_denied)/.test(text);
    const batch2 = (path.startsWith('apps/') || path.startsWith('libs/')) && !path.startsWith('libs/audit-contract/')
      && /\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(path) && /reference_repair_unresolved|reference_anchor_mismatch/.test(text);
    return noDotOrBuild && (batch1 || batch2);
  };

  // 0. the approved scope, as a literal: widening it is a deliberate, reviewed edit of this test
  assert.deepEqual(REPAIR_AUDIT_ACTIONS, ['hierarchy.reference_repaired', 'hierarchy.reference_repair_denied', 'hierarchy.reference_repair_unresolved', 'hierarchy.reference_anchor_mismatch_detected']);
  assert.equal(REPAIR_AUDIT_PRODUCER, 'apps/auth-service/src/hierarchy/reference-repair.service.ts');
  assert.deepEqual(REPAIR_AUDIT_TESTS, ['apps/auth-service/test/reference-repair.e2e-spec.ts', 'apps/auth-service/test/reference-repair-local.e2e-spec.ts', 'apps/auth-service/test/reference-repair-proof.e2e-spec.ts']);
  assert.deepEqual(REPAIR_AUDIT_SCAN, { roots: ['apps/', 'libs/'], excluded: 'libs/audit-contract/', extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'] });
  // the producer is application source, the three others are test files that no image contains; the two lists never overlap
  assert.ok(REPAIR_AUDIT_PRODUCER.startsWith('apps/auth-service/src/') && !REPAIR_AUDIT_PRODUCER.endsWith('.spec.ts'));
  for (const t of REPAIR_AUDIT_TESTS) assert.ok(t.startsWith('apps/auth-service/test/') && t !== REPAIR_AUDIT_PRODUCER, t);
  // the four names are the catalog's own (the contract library is the one place that declares them)
  const catalog = readFileSync(new URL('../libs/audit-contract/src/catalog.ts', import.meta.url), 'utf8');
  for (const action of REPAIR_AUDIT_ACTIONS) assert.ok(catalog.includes(`'${action}': {`), `${action} is not declared in the audit catalog`);

  // 1. the real repository passes, WHATEVER its phase: before A5.4-A3 (the four approved files do not exist and nothing names the
  //    actions) and after it (they exist and name them). What is asserted is the behavior, not a snapshot of either phase.
  const approved = [REPAIR_AUDIT_PRODUCER, ...REPAIR_AUDIT_TESTS];
  const fragments = ['reference_repaired', 'reference_repair_denied', 'reference_repair_unresolved', 'reference_anchor_mismatch'];
  const names = (text) => fragments.some((fragment) => text.includes(fragment));
  assert.ok(Object.keys(real).length > 500, 'the scan found too few files to be the real repository');
  assert.deepEqual(run(), []);
  // in the real tree, every file that names a protected action is one of the four approved paths (none today; at most those four later)
  assert.deepEqual(Object.keys(real).filter((path) => names(real[path]) && !approved.includes(path)), []);
  // ...and whatever the two replaced assertions would have reported in the real tree is one of those four paths too
  assert.deepEqual(Object.keys(real).filter((path) => legacy(path, real[path]) && !approved.includes(path)), []);
  // both phases, built from the real tree so that this test holds in either: `before` has none of the four files, `after` has all of them
  const all4 = REPAIR_AUDIT_ACTIONS.map(use).join('');
  const before = Object.fromEntries(Object.entries(real).filter(([path]) => !approved.includes(path)));
  const after = { ...before, ...Object.fromEntries(approved.map((path) => [path, all4])) };
  for (const path of approved) assert.equal(before[path], undefined);
  assert.equal(Object.keys(before).some((path) => names(before[path])), false); // the producer-less state, as a fixture
  assert.deepEqual(Object.keys(after).filter((path) => names(after[path])).sort(), [...approved].sort()); // the four files, nothing else
  for (const [phase, tree] of [['before A3', before], ['after A3', after]]) {
    assert.deepEqual(checkRepairAuditProducerScope(tree), [], phase);
    // in either phase, each protected action in an unauthorized location is refused: an Auth source file, another service, a shared
    // library, an unlisted Auth test, and paths that only look approved
    for (const action of REPAIR_AUDIT_ACTIONS) {
      for (const path of ['apps/auth-service/src/auth/auth.service.ts', 'apps/auth-service/src/hierarchy/hierarchy-reference.ts', 'apps/organization-service/src/main.ts',
        'apps/audit-service/src/main.ts', 'libs/service-kit/src/index.ts', 'apps/auth-service/test/onboarding.e2e-spec.ts',
        'apps/audit-service/src/hierarchy/reference-repair.service.ts', 'apps/auth-service/src/hierarchy/reference-repair.service.ts.bak.ts',
        'apps/auth-service/src/hierarchy/reference-repair.controller.ts', 'apps/auth-service/test/reference-repair-extra.e2e-spec.ts']) {
        const problems = checkRepairAuditProducerScope({ ...tree, [path]: `${tree[path] ?? ''}\n${use(action)}` });
        assert.equal(problems.length, 1, `${phase}: ${path} naming ${action} must be the one problem, got:\n${problems.join('\n') || '(no problem)'}`);
        assert.ok(problems[0].startsWith(`${path}: names the reference-repair audit action`) && problems[0].includes(action), `${phase}: ${problems[0]}`);
      }
    }
  }

  // 2. each protected action, named in an Auth source file outside the scope, is refused; the message names the file and the action
  for (const action of REPAIR_AUDIT_ACTIONS) {
    const problems = run({ 'apps/auth-service/src/auth/auth.service.ts': `${real['apps/auth-service/src/auth/auth.service.ts']}\n${use(action)}` });
    fails(problems, 'apps/auth-service/src/auth/auth.service.ts');
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes(action) && problems[0].includes(REPAIR_AUDIT_PRODUCER));
  }
  // the hierarchy module itself is not the producer: only the one service file is
  fails(run({ 'apps/auth-service/src/hierarchy/hierarchy-reference.ts': use('hierarchy.reference_anchor_mismatch_detected') }), 'apps/auth-service/src/hierarchy/hierarchy-reference.ts');
  fails(run({ 'apps/auth-service/src/hierarchy/reference-repair.controller.ts': use('hierarchy.reference_repaired') }), 'apps/auth-service/src/hierarchy/reference-repair.controller.ts');

  // 3. another service, and a shared library, may not name them either
  for (const path of ['apps/organization-service/src/admin/admin.controller.ts', 'apps/audit-service/src/ingestion/ingestion.service.ts', 'libs/service-kit/src/events/outbox.service.ts', 'apps/billing-service/src/new.ts']) {
    fails(run({ [path]: use('hierarchy.reference_repair_unresolved') }), path);
  }

  // 4. a test file outside the three approved ones (an Auth test, a unit spec beside the source, another service's test)
  for (const path of ['apps/auth-service/test/onboarding.e2e-spec.ts', 'apps/auth-service/test/audit-actions.e2e-spec.ts', 'apps/auth-service/src/hierarchy/reference-repair.service.spec.ts', 'apps/audit-service/test/query.e2e-spec.ts']) {
    fails(run({ [path]: `expect(rows[0].name).toBe('audit.hierarchy.reference_repair_denied');` }), path);
  }

  // 5. every scanned extension, including data and plain JavaScript modules
  for (const ext of REPAIR_AUDIT_SCAN.extensions) {
    const path = `apps/auth-service/src/fixtures/actions${ext}`;
    fails(run({ [path]: '{ "action": "hierarchy.reference_repaired" }' }), path);
  }
  fails(run({ 'apps/auth-service/scripts/emit.mjs': use('hierarchy.reference_repair_denied') }), 'apps/auth-service/scripts/emit.mjs');
  fails(run({ 'libs/service-kit/fixtures/events.json': '["hierarchy.reference_anchor_mismatch_detected"]' }), 'libs/service-kit/fixtures/events.json');

  // 6. a path that only LOOKS approved: another service or library, a prefix, a suffix, a sibling, a different case
  for (const path of [
    'apps/audit-service/src/hierarchy/reference-repair.service.ts', 'libs/service-kit/src/hierarchy/reference-repair.service.ts',
    'apps/auth-service/src/hierarchy/reference-repair.service.ts.bak.ts', 'apps/auth-service/src/hierarchy/reference-repair.service.tsx',
    'apps/auth-service/src/hierarchy/reference-repair.service.js', 'apps/auth-service/src/hierarchy/x-reference-repair.service.ts',
    'apps/auth-service/src/hierarchy/reference-repair.service/index.ts', 'apps/auth-service/src/hierarchy/Reference-Repair.service.ts',
    'apps/auth-service/src/legacy/apps/auth-service/src/hierarchy/reference-repair.service.ts',
    'apps/auth-service/test/reference-repair.e2e-spec.ts.json', 'apps/auth-service/test/helpers/reference-repair.e2e-spec.ts',
    'apps/auth-service/test/reference-repair-extra.e2e-spec.ts', 'apps/organization-service/test/reference-repair.e2e-spec.ts',
  ]) {
    fails(run({ [path]: use('hierarchy.reference_repaired') }), path);
  }

  // 7. a name separated from its `hierarchy.` prefix, or built by concatenation of the prefix, is still seen
  fails(run({ 'apps/auth-service/src/owner/owner.controller.ts': "const action = `hierarchy.${'reference_repair_denied'}`;" }), 'apps/auth-service/src/owner/owner.controller.ts');
  fails(run({ 'apps/auth-service/src/owner/owner.controller.ts': "const a = 'reference_anchor_mismatch';" }), 'apps/auth-service/src/owner/owner.controller.ts');

  // 8. the approved scope: the one producer and the three tests may name all four actions (the post-A3 state); nothing else changes
  const all = REPAIR_AUDIT_ACTIONS.map(use).join('');
  assert.deepEqual(run({ [REPAIR_AUDIT_PRODUCER]: all }), []);
  for (const t of REPAIR_AUDIT_TESTS) assert.deepEqual(run({ [t]: all }), []);
  assert.deepEqual(run(Object.fromEntries([REPAIR_AUDIT_PRODUCER, ...REPAIR_AUDIT_TESTS].map((path) => [path, all]))), []);
  // ...and with the producer in place, a second producer is still refused (the check stays effective after A3)
  const afterA3 = Object.fromEntries([REPAIR_AUDIT_PRODUCER, ...REPAIR_AUDIT_TESTS].map((path) => [path, all]));
  fails(run({ ...afterA3, 'apps/auth-service/src/platform/assignment.service.ts': use('hierarchy.reference_anchor_mismatch_detected') }), 'apps/auth-service/src/platform/assignment.service.ts');
  assert.equal(run({ ...afterA3, 'apps/auth-service/src/platform/assignment.service.ts': use('hierarchy.reference_anchor_mismatch_detected') }).length, 1);

  // 9. what stays outside the scan, as before: the contract library (it declares the actions), documentation, other roots
  assert.deepEqual(run({ 'libs/audit-contract/src/extra.ts': all, 'libs/audit-contract/test/extra.spec.ts': all }), []);
  assert.deepEqual(run({ 'docs/architecture/x.md': all, 'apps/auth-service/README.md': all, 'scripts/x.mjs': all }), []);
  assert.equal(repairAuditScanned('libs/audit-contract-extra/src/a.ts'), true); // only the contract library itself is excluded, not a look-alike
  fails(run({ 'libs/audit-contract-extra/src/a.ts': all }), 'libs/audit-contract-extra/src/a.ts');

  // 10. PARITY with the two replaced assertions: whatever they reported, this check reports (it is equal or wider)
  const cases = [];
  const paths = ['apps/auth-service/src/auth/auth.service.ts', 'apps/auth-service/test/tokens.e2e-spec.ts', 'apps/audit-service/src/a.ts', 'apps/organization-service/src/a.js', 'apps/auth-service/a.mjs', 'apps/auth-service/a.json',
    'apps/auth-service/src/a.tsx', 'apps/auth-service/src/a.mts', 'apps/auth-service/src/a.cts', 'apps/auth-service/src/a.cjs', 'libs/service-kit/src/a.ts', 'libs/service-kit/test/a.json', 'libs/audit-contract/src/a.ts', 'apps/auth-service/src/a.md'];
  for (const path of paths) for (const action of REPAIR_AUDIT_ACTIONS) cases.push([path, use(action)]);
  let legacyHits = 0;
  for (const [path, text] of cases) {
    if (!legacy(path, text)) continue;
    legacyHits += 1;
    fails(run({ [path]: text }), path);
  }
  assert.ok(legacyHits >= 30, `the parity battery exercised only ${legacyHits} legacy hits`);
  // ...and it is wider where they were not: the first two actions under libs/ and in every extension (the first assertion read apps/ and four extensions only)
  assert.equal(legacy('libs/service-kit/src/a.ts', use('hierarchy.reference_repaired')), false);
  fails(run({ 'libs/service-kit/src/a.ts': use('hierarchy.reference_repaired') }), 'libs/service-kit/src/a.ts');
  assert.equal(legacy('apps/auth-service/src/a.tsx', use('hierarchy.reference_repair_denied')), false);
  fails(run({ 'apps/auth-service/src/a.tsx': use('hierarchy.reference_repair_denied') }), 'apps/auth-service/src/a.tsx');

  // the runner calls the check once, over apps/ and libs/, and the two replaced assertions are gone from the library tests
  const runner = readFileSync(new URL('./check-repo.mjs', import.meta.url), 'utf8');
  assert.equal(runner.split('checkRepairAuditProducerScope(').length - 1, 1);
  assert.match(runner, /for \(const top of \['apps', 'libs'\]\) read\(join\(root, top\)\)/);
  assert.match(runner, /if \(\['node_modules', 'dist', '\.git'\]\.includes\(name\)\) continue;/); // nothing else is skipped (dot-directories are read)
  for (const spec of ['reference-repair-catalog.spec.ts', 'reference-repair-batch2.spec.ts']) {
    const text = readFileSync(new URL(`../libs/audit-contract/test/${spec}`, import.meta.url), 'utf8');
    assert.ok(!/is producer-less/.test(text) && /check:repo/.test(text), `${spec} must point to the repository check that replaced its producer-less assertion`);
  }
});


// ================================================================================ Core V2 M2 B1: the restricted scheduled backup
const SCHED = 'core-backup-scheduled.yml';
const SCHEDULED = workflow(SCHED);
const schedProblems = (text, file = SCHED) => checkWorkflowSafety(file, text).join('\n');
const SSH_LINE = '          ssh -F /dev/null -T -n -i "$d/key" -p "$BACKUP_SSH_PORT" \\\n';
const SSH_TARGET = '            -- "$BACKUP_SSH_USER@$BACKUP_SSH_HOST"\n';
const GUARD_LINE = `    if: ${SCHEDULED_BACKUP_GUARD}\n`;
const repoText = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const ENTRY = repoText('infra/backup/scheduled-backup.sh');
const BACKUP_SH = repoText('infra/backup/backup.sh');
const TEMPLATE = repoText('infra/backup/scheduled-backup.authorized_keys.template');
const VERIFIER = repoText('infra/backup/verify-scheduled-backup-install.sh');

test('B1: the scheduled backup workflow passes: schedule-only at 02:17 UTC, inactive by guard, production-backup, no action, no token', () => {
  assert.deepEqual(checkWorkflowSafety(SCHED, SCHEDULED), []);
  const doc = parse(SCHEDULED);
  assert.deepEqual(Object.keys(doc.on), ['schedule']);
  assert.equal(doc.on.schedule[0].cron, SCHEDULED_BACKUP_CRON);
  assert.equal(SCHEDULED_BACKUP_CRON, '17 2 * * *');
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(Object.keys(doc.jobs), ['backup']);
  const job = doc.jobs.backup;
  assert.equal(job.if, SCHEDULED_BACKUP_GUARD);
  assert.equal(job.environment, BACKUP_ENVIRONMENT);
  assert.equal(job.concurrency.group, PRODUCTION_GROUP);
  assert.equal(job.steps.length, 1);
  assert.equal(job.steps[0].uses, undefined);
  assert.deepEqual(Object.keys(job.steps[0].env).sort(), [...SCHEDULED_BACKUP_SECRETS].sort());
  assert.doesNotMatch(JSON.stringify(job), /DEPLOY_SSH_|toJSON/);
  assert.ok(job.steps[0].run.trimEnd().endsWith('-- "$BACKUP_SSH_USER@$BACKUP_SSH_HOST"'), 'no remote command');
});

test('B1: every weakening of the scheduled backup workflow is refused', () => {
  const cases = [
    ['a manual trigger', 'on:\n  schedule:\n', 'on:\n  workflow_dispatch:\n  schedule:\n', /on its schedule only/],
    ['a push trigger', 'on:\n  schedule:\n', 'on:\n  push:\n    branches: [main]\n  schedule:\n', /on its schedule only/],
    ['a workflow_call trigger', 'on:\n  schedule:\n', 'on:\n  workflow_call:\n  schedule:\n', /on its schedule only/],
    ['another cron', "- cron: '17 2 * * *'", "- cron: '*/5 * * * *'", /exactly one cron '17 2 \* \* \*'/],
    ['a second cron', "    - cron: '17 2 * * *'\n", "    - cron: '17 2 * * *'\n    - cron: '17 14 * * *'\n", /exactly one cron/],
    ['no guard', GUARD_LINE, '', /guarded by exactly/],
    ['a weakened guard', "vars.CORE_BACKUP_SCHEDULE == 'enabled'", "vars.CORE_BACKUP_SCHEDULE != 'disabled'", /guarded by exactly/],
    ['a guard without main', GUARD_LINE, "    if: vars.CORE_BACKUP_SCHEDULE == 'enabled'\n", /guarded by exactly[\s\S]*restricted to refs\/heads\/main/],
    ['the production environment', 'environment: production-backup', 'environment: production', /BACKUP_SSH_\* credentials are used only[\s\S]*must be in a workflow_dispatch-only workflow[\s\S]*must declare "environment: production-backup"/],
    ['no environment', '    environment: production-backup\n', '', /must declare a protected environment/],
    ['an expression environment', 'environment: production-backup', 'environment: ${{ vars.ENVIRONMENT }}', /literal name/],
    ['a deploy password', 'BACKUP_SSH_KEY: ${{ secrets.BACKUP_SSH_KEY }}', 'BACKUP_SSH_KEY: ${{ secrets.DEPLOY_SSH_PASSWORD }}', /never uses the DEPLOY_SSH_\*/],
    ['every secret at once', '          BACKUP_SSH_KEY: ${{ secrets.BACKUP_SSH_KEY }}\n', '          BACKUP_SSH_KEY: ${{ secrets.BACKUP_SSH_KEY }}\n          ALL: ${{ toJSON(secrets) }}\n', /never uses the DEPLOY_SSH_\* credentials or every secret at once/],
    ['an extra env value', '          BACKUP_SSH_KEY: ${{ secrets.BACKUP_SSH_KEY }}\n', '          BACKUP_SSH_KEY: ${{ secrets.BACKUP_SSH_KEY }}\n          EXTRA: x\n', /step env must be exactly/],
    ['a secret interpolated into the script', '          umask 077\n', '          umask 077\n          echo "${{ secrets.BACKUP_SSH_HOST }}"\n', /no expression is interpolated/],
    ['no host-key checking', 'StrictHostKeyChecking=yes', 'StrictHostKeyChecking=no', /weakens host-key checking[\s\S]*must pass -o StrictHostKeyChecking=yes/],
    ['accept-new host keys', 'StrictHostKeyChecking=yes', 'StrictHostKeyChecking=accept-new', /weakens host-key checking/],
    ['an unpinned known-hosts file', '-o UserKnownHostsFile="$d/known_hosts"', '-o UserKnownHostsFile=~/.ssh/known_hosts', /must pass -o UserKnownHostsFile="\$d\/known_hosts"/],
    ['the global known-hosts file', ' -o GlobalKnownHostsFile=/dev/null', '', /must pass -o GlobalKnownHostsFile=\/dev\/null/],
    ['an ssh config file', SSH_LINE, SSH_LINE.replace('-F /dev/null ', ''), /must pass -F \/dev\/null/],
    ['an agent', ' -o ForwardAgent=no', ' -o ForwardAgent=yes', /must pass -o ForwardAgent=no/],
    ['a remote command', SSH_TARGET, '            -- "$BACKUP_SSH_USER@$BACKUP_SSH_HOST" /bin/sh\n', /must end with -- "\$BACKUP_SSH_USER@\$BACKUP_SSH_HOST"/],
    ['a script on stdin', SSH_TARGET, '            -- "$BACKUP_SSH_USER@$BACKUP_SSH_HOST" <backup.sh\n', /must end with/],
    ['a proxy command', ' -o ConnectTimeout=30', ' -o ConnectTimeout=30 -o ProxyCommand=nc', /proxy, local command/],
    ['environment passing', ' -o ConnectTimeout=30', ' -o ConnectTimeout=30 -o SendEnv=LC_ALL', /proxy, local command, environment passing/],
    ['a port forwarding', ' -o ConnectTimeout=30', ' -o ConnectTimeout=30 -L 5432:localhost:5432', /forwarding option/],
    ['a download', '          umask 077\n', '          umask 077\n          curl -fsS -o "$RUNNER_TEMP/x" https://example.invalid/x\n', /transfer, fetch, decode or interpreter/],
    ['a decoded script', '          umask 077\n', '          umask 077\n          echo eA== | base64 -d >"$RUNNER_TEMP/x"\n', /transfer, fetch, decode or interpreter/],
    ['a pipe into a shell', '          umask 077\n', '          umask 077\n          echo true | bash\n', /pipes a script into a shell/],
    ['a second ssh', '          umask 077\n', '          umask 077\n          ssh -V\n', /exactly one ssh invocation/],
    ['an scp', '          umask 077\n', '          umask 077\n          scp x y:\n', /transfer[\s\S]*exactly one ssh invocation/],
    ['a checkout step', '    steps:\n', '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n', /exactly one step/],
    ['a shell override', '        run: |\n', '        shell: sh\n        run: |\n', /may only have name, env and run/],
    ['another queue', 'group: production-deploy-core-api', 'group: backups', /concurrency group must be/],
    ['a cancellable run', 'cancel-in-progress: false', 'cancel-in-progress: true', /cancel-in-progress must be explicitly false/],
    ['a second job', 'jobs:\n', 'jobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n', /exactly one job, "backup"/],
    ['token permissions', 'permissions: {}', 'permissions:\n  contents: read', /must declare "permissions: \{\}"/],
    ['job permissions', '    timeout-minutes: 30\n', '    timeout-minutes: 30\n    permissions:\n      contents: write\n', /"permissions" is not allowed/],
    ['a self-hosted runner', 'runs-on: ubuntu-latest', 'runs-on: self-hosted', /runs-on must be ubuntu-latest/],
    ['no timeout', '    timeout-minutes: 30\n', '', /timeout-minutes must be an integer/],
    ['a workflow-level secret', 'permissions: {}\n', 'permissions: {}\nenv:\n  K: ${{ secrets.BACKUP_SSH_KEY }}\n', /never set at workflow level/],
    ['a reusable workflow', '    timeout-minutes: 30\n', '    timeout-minutes: 30\n    uses: ./.github/workflows/other.yml\n', /"uses" is not allowed/],
  ];
  for (const [label, from, to, re] of cases) assert.match(schedProblems(swap(SCHEDULED, from, to)), re, label);
});

test('B1: production-backup, the BACKUP_SSH_* credentials and the guard are refused in every other workflow', () => {
  assert.match(schedProblems(SCHEDULED, 'core-backup-copy.yml'), /reserved for the scheduled backup job of core-backup-scheduled\.yml[\s\S]*activation guard CORE_BACKUP_SCHEDULE is read only/);
  const other = (job, on = 'workflow_dispatch:') => `name: o\non:\n  ${on}\njobs:\n  x:\n${job}`;
  const dispatchBackupKey = other("    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$K\"\n        env:\n          K: ${{ secrets.BACKUP_SSH_KEY }}\n");
  assert.match(schedProblems(dispatchBackupKey, 'o.yml'), /must declare a protected environment[\s\S]*BACKUP_SSH_\* credentials are used only/);
  const productionBackupKey = other("    if: github.ref == 'refs/heads/main'\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$K\"\n        env:\n          K: ${{ secrets['BACKUP_SSH_KEY'] }}\n");
  assert.match(schedProblems(productionBackupKey, 'o.yml'), /BACKUP_SSH_\* credentials are used only/);
  const guardRead = other("    if: vars.CORE_BACKUP_SCHEDULE == 'enabled'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n");
  assert.match(schedProblems(guardRead, 'o.yml'), /read only by core-backup-scheduled\.yml/);
  assert.match(schedProblems(other("    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n").replace("  x:\n", "  x:\n    environment: production-backup\n"), 'o.yml'), /reserved for the scheduled backup/);
});

test('B1: a native ssh, scp or sftp is production access in any workflow (environment, main only, the queue, never automatic)', () => {
  const job = (run, extra = '') => `name: n\non:\n  push:\n    branches: [main]\njobs:\n  x:\n${extra}    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          ${run}\n`;
  for (const run of ['ssh user@host true', 'scp a host:b', 'sftp host', 'ssh-keyscan host', 'rsync -e ssh a host:b', 'docker run x ssh host']) {
    assert.match(schedProblems(job(run), 'n.yml'), /must declare a protected environment[\s\S]*never automatically[\s\S]*restricted to refs\/heads\/main[\s\S]*no concurrency group/, run);
  }
  for (const run of ['ssh-keygen -t ed25519 -f k -N ""', 'echo "$RUNNER_TEMP/backup-ssh.x"', 'cat ~/.ssh/config.d/x']) {
    assert.deepEqual(checkWorkflowSafety('n.yml', job(run)), [], run);
  }
  const manual = `name: m\non:\n  workflow_dispatch:\njobs:\n  x:\n    if: github.ref == 'refs/heads/main'\n    environment: production\n    concurrency:\n      group: ${PRODUCTION_GROUP}\n      cancel-in-progress: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: ssh host true\n`;
  assert.deepEqual(checkWorkflowSafety('m.yml', manual), [], 'a manual native ssh behind the production approval is the existing model');
});

test('B1: core-backup.yml stays manual-only behind production; its schedule stays removed', () => {
  assert.deepEqual(checkWorkflowSafety('core-backup.yml', workflow('core-backup.yml')), []);
  assert.deepEqual(Object.keys(parse(workflow('core-backup.yml')).on), ['workflow_dispatch']);
  assert.doesNotMatch(workflow('core-backup.yml'), /vars\s*\.\s*CORE_BACKUP_SCHEDULE/);
});

test('B1: the entry script pins and the authorized_keys template pass and match the repository', () => {
  assert.deepEqual(checkScheduledBackupEntry({ entry: ENTRY, backupSh: BACKUP_SH, template: TEMPLATE }), []);
  assert.equal(ENTRY.match(/^readonly BACKUP_SH_SHA256='([0-9a-f]{64})'$/m)[1], createHash('sha256').update(BACKUP_SH).digest('hex'));
});

test('B1: every weakening of the entry script or the template is refused', () => {
  const entry = (from, to) => checkScheduledBackupEntry({ entry: swap(ENTRY, from, to), backupSh: BACKUP_SH, template: TEMPLATE }).join('\n');
  const pin = ENTRY.match(/^readonly BACKUP_SH_SHA256='([0-9a-f]{64})'$/m)[1];
  assert.match(entry(pin, '0'.repeat(64)), /BACKUP_SH_SHA256 .* must equal the SHA-256/);
  assert.match(checkScheduledBackupEntry({ entry: ENTRY, backupSh: `${BACKUP_SH}# changed\n`, template: TEMPLATE }).join(), /must equal the SHA-256 of infra\/backup\/backup\.sh/);
  assert.match(entry("readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", "readonly INSTALL_DIR='/home/ubuntu/nawara-core/backup/bin'"), /INSTALL_DIR must be/);
  assert.match(entry('readonly OWNER_UID=0', 'readonly OWNER_UID=1000'), /OWNER_UID must be 0/);
  assert.match(entry("readonly SERVICES='auth-service organization-service'", "readonly SERVICES='auth-service organization-service audit-service'"), /SERVICES must be exactly/);
  assert.match(entry('log "finished: exit $rc"\n', 'log "finished: exit $rc"\nbash -c "$SSH_ORIGINAL_COMMAND"\n'), /SSH_ORIGINAL_COMMAND is only ever tested/);
  assert.match(entry('[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64', 'true'), /SSH_ORIGINAL_COMMAND is only ever tested/);
  assert.match(entry('flock -n 9 || refuse 75 ', 'flock 9 || refuse 75 '), /flock -n/);
  assert.match(entry('[ "$EUID" -ne 0 ] || refuse 65 ', 'true || refuse 65 '), /must refuse to run as root/);
  assert.match(entry('env -i HOME="$HOME" PATH="$PATH" BACKUP_SERVICES', 'HOME="$HOME" PATH="$PATH" BACKUP_SERVICES'), /must be run with "env -i"/);
  assert.match(entry('log "finished: exit $rc"\n', 'log "finished: exit $rc"\neval "$X"\n'), /no eval and no sourcing/);
  assert.match(entry('log "finished: exit $rc"\n', 'log "finished: exit $rc"\nsource "$HOME/x"\n'), /no eval and no sourcing/);
  assert.match(checkScheduledBackupEntry({ entry: '', backupSh: BACKUP_SH, template: TEMPLATE }).join(), /scheduled-backup\.sh is missing/);
  const template = (t) => checkScheduledBackupEntry({ entry: ENTRY, backupSh: BACKUP_SH, template: t }).join('\n');
  assert.match(template(TEMPLATE.replace('restrict,', '')), /must hold exactly one line/);
  assert.match(template(TEMPLATE.replace('restrict,', 'restrict,port-forwarding,')), /must hold exactly one line/);
  assert.match(template(`${TEMPLATE}ssh-ed25519 REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY second\n`), /must hold exactly one line/);
  assert.match(template(TEMPLATE.replace('REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY', `AAAAC3NzaC1lZDI1NTE5AAAA${'x'.repeat(40)}`)), /must hold no key material/);
});

test('E2: the installation verifier passes and carries the entry and template pins', () => {
  assert.deepEqual(checkScheduledBackupVerifier({ verifier: VERIFIER, entry: ENTRY, template: TEMPLATE }), []);
});

test('E2: a verifier that drifts from the pins, writes, or runs a mutating command is refused', () => {
  const v = (from, to) => checkScheduledBackupVerifier({ verifier: swap(VERIFIER, from, to), entry: ENTRY, template: TEMPLATE }).join('\n');
  assert.match(checkScheduledBackupVerifier({ verifier: '', entry: ENTRY, template: TEMPLATE }).join(), /verify-scheduled-backup-install\.sh is missing/);
  assert.match(v("readonly INSTALL_DIR='/usr/local/libexec/nawara-core-backup'", "readonly INSTALL_DIR='/opt/x'"), /must pin readonly INSTALL_DIR=/);
  assert.match(v('readonly OWNER_UID=0', 'readonly OWNER_UID=1000'), /must pin readonly OWNER_UID=0/);
  assert.match(v('readonly RUN_AS_UID=0', 'readonly RUN_AS_UID=1000'), /must pin readonly RUN_AS_UID=0/);
  assert.match(v("readonly TRUST_ROOT='/'", "readonly TRUST_ROOT='/usr'"), /must pin readonly TRUST_ROOT='\/'/);
  assert.match(v("readonly KEY_COMMENT='nawara-core-scheduled-backup'", "readonly KEY_COMMENT='x'"), /must pin readonly KEY_COMMENT=/);
  assert.match(v('restrict,command=', 'command='), /must pin readonly FORCED_OPTIONS=/);
  const template = TEMPLATE.replace('restrict,command=', 'restrict,no-pty,command=');
  assert.match(checkScheduledBackupVerifier({ verifier: VERIFIER, entry: ENTRY, template }).join(), /FORCED_OPTIONS must equal the template's options/);
  assert.match(v('[ "$EUID" -eq "$RUN_AS_UID" ] || usage ', '[ 1 ] || usage '), /must refuse to run as anyone but root/);
  for (const cmd of ['rm -f "$f"', 'chmod 0644 "$f"', 'docker exec x true', 'sudo -n true', 'install -m 0555 a b', 'sed -i s/a/b/ "$f"', 'curl https://x']) {
    assert.match(v('ENTRY_OK=0\n', `ENTRY_OK=0\n${cmd}\n`), /must stay read-only/, cmd);
  }
  for (const write of ['echo x >"$HOME/x"', 'echo x >> /tmp/x', 'printf x > "$f"']) {
    assert.match(v('ENTRY_OK=0\n', `ENTRY_OK=0\n${write}\n`), /must write no file/, write);
  }
  assert.deepEqual(checkScheduledBackupVerifier({ verifier: swap(VERIFIER, 'ENTRY_OK=0\n', 'ENTRY_OK=0\n# rm -rf / in a comment is fine\ntrue >/dev/null 2>&1\n'), entry: ENTRY, template: TEMPLATE }), []);
});

// ================================================================================ Core V2 M2 T6: the network probe
const PROBE = workflow(PROBE_WORKFLOW);
const probeProblems = (text, file = PROBE_WORKFLOW) => checkWorkflowSafety(file, text).join('\n');
const PROBE_STEP = '      - name: Probe the SSH port and host key (no authentication)\n        env:\n';
const VALIDATE_STEP = '      - name: Validate the probe configuration\n        env:\n';
const AFTER_TAILSCALE = "          use-cache: 'false'\n";
const PROBE_RUN = '        run: |\n          set -euo pipefail\n          if timeout';
const KEYSCAN = 'keys=$(ssh-keyscan -T 10 -t ecdsa -p "$DEPLOY_SSH_PORT" "$TS_PROBE_HOST" 2>/dev/null';
const COMPARE = 'if [ -n "$fp" ] && [ "$fp" = "$DEPLOY_SSH_FINGERPRINT" ]; then';

test('T6: the network probe passes: dispatch-only without inputs, main, production, the queue, id-token only, validate → Tailscale → probe', () => {
  assert.deepEqual(checkWorkflowSafety(PROBE_WORKFLOW, PROBE), []);
  assert.deepEqual(checkActionPins(PROBE_WORKFLOW, PROBE), []);
  const doc = parse(PROBE);
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
  assert.equal(doc.on.workflow_dispatch, null, 'no inputs');
  assert.deepEqual(doc.permissions, {});
  assert.deepEqual(Object.keys(doc.jobs), [PROBE_JOB]);
  const job = doc.jobs[PROBE_JOB];
  assert.equal(job.if, PROBE_GUARD);
  assert.equal(job.environment, 'production');
  assert.deepEqual(job.concurrency, { group: PRODUCTION_GROUP, 'cancel-in-progress': false });
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 10);
  assert.deepEqual(job.permissions, { 'id-token': 'write' });
  assert.equal(job.steps.length, 3);
  assert.deepEqual(job.steps.map((s) => s.uses), [undefined, TAILSCALE_ACTION, undefined], 'no checkout, no other action');
  assert.deepEqual(job.steps[1].with, PROBE_TAILSCALE_WITH);
  assert.equal(PROBE_TAILSCALE_WITH.tags, 'tag:nawara-ci-probe');
  assert.equal(PROBE_TAG, 'tag:nawara-ci-probe');
  assert.equal(TAILSCALE_ACTION, 'tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd');
  assert.equal(TAILSCALE_ACTION_RELEASE, 'v4.2.0');
  assert.equal(TAILSCALE_CLIENT_VERSION, '1.94.2');
  assert.equal(TAILSCALE_CLIENT_SHA256, 'c6f99a5d774c7783b56902188d69e9756fc3dddfb08ac6be4cb2585f3fecdc32');
  assert.deepEqual(job.steps[0].env, PROBE_ENV);
  assert.deepEqual(job.steps[2].env, PROBE_ENV);
  assert.deepEqual([...PROBE_SECRETS].sort(), ['DEPLOY_SSH_FINGERPRINT', 'DEPLOY_SSH_PORT', 'TS_PROBE_HOST', 'TS_PROBE_OIDC_AUDIENCE', 'TS_PROBE_OIDC_CLIENT_ID']);
  assert.doesNotMatch(JSON.stringify(doc), /DEPLOY_SSH_(HOST|USER|PASSWORD)|BACKUP_SSH_|toJSON|appleboy|actions\/checkout|backup/i);
});

test('T6: every relaxation of the probe workflow is refused', () => {
  const cases = [
    // triggers and inputs
    ['a push trigger', 'on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  push:\n    branches: [main]\n', /workflow_dispatch only[\s\S]*never automatically/],
    ['a schedule', 'on:\n  workflow_dispatch:\n', "on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 * * * *'\n", /workflow_dispatch only/],
    ['a reusable-workflow trigger', 'on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  workflow_call:\n', /workflow_dispatch only/],
    ['a pull_request_target trigger', 'on:\n  workflow_dispatch:\n', 'on:\n  pull_request_target:\n', /must be in a workflow_dispatch-only workflow[\s\S]*never automatically[\s\S]*workflow_dispatch only/],
    ['an input', 'on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n    inputs:\n      host:\n        required: true\n', /takes no input/],
    // the job's gates
    ['no main guard', `    if: ${PROBE_GUARD}\n`, '', /guarded by exactly[\s\S]*restricted to refs\/heads\/main/],
    ['a widened guard', PROBE_GUARD, "startsWith(github.ref, 'refs/heads/')", /guarded by exactly/],
    ['no environment', '    environment: production\n', '', /must declare a protected environment[\s\S]*must declare "environment: production"/],
    ['another environment', '    environment: production\n', '    environment: staging\n', /not an approved production environment[\s\S]*must declare "environment: production"/],
    ['an expression environment', '    environment: production\n', '    environment: ${{ vars.ENV }}\n', /literal name/],
    ['another queue', 'group: production-deploy-core-api', 'group: probes', /concurrency group must be/],
    ['a cancellable run', 'cancel-in-progress: false', 'cancel-in-progress: true', /cancel-in-progress must be explicitly false/],
    ['a self-hosted runner', 'runs-on: ubuntu-24.04', 'runs-on: self-hosted', /runs-on must be exactly ubuntu-24\.04/],
    ['a floating runner label', 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest', /runs-on must be exactly ubuntu-24\.04/],
    ['a longer timeout', 'timeout-minutes: 10', 'timeout-minutes: 60', /timeout-minutes must be exactly 10/],
    ['no timeout', '    timeout-minutes: 10\n', '', /timeout-minutes must be exactly 10/],
    ['a second job', 'jobs:\n', 'jobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n', /exactly one job, "probe"/],
    ['a job env', '    timeout-minutes: 10\n', '    timeout-minutes: 10\n    env:\n      X: y\n', /"env" not allowed on the probe job/],
    ['a reusable workflow', '    timeout-minutes: 10\n', '    timeout-minutes: 10\n    uses: ./.github/workflows/other.yml\n', /"uses" not allowed on the probe job/],
    ['continue-on-error', '    timeout-minutes: 10\n', '    timeout-minutes: 10\n    continue-on-error: true\n', /"continue-on-error" not allowed/],
    // permissions
    ['contents on the job', '      id-token: write\n', '      id-token: write\n      contents: read\n', /permissions must be exactly "id-token: write"/],
    ['no job permissions', '    permissions:\n      id-token: write\n', '', /permissions must be exactly "id-token: write"/],
    ['write-all on the job', '    permissions:\n      id-token: write\n', '    permissions: write-all\n', /permissions must be exactly "id-token: write"/],
    ['workflow-level id-token', 'permissions: {}\n', 'permissions:\n  id-token: write\n', /must declare "permissions: \{\}"/],
    ['a workflow-level env', 'permissions: {}\n', 'permissions: {}\nenv:\n  H: ${{ secrets.TS_PROBE_HOST }}\n', /TS_\* secrets are never set at workflow level[\s\S]*no workflow-level "env"/],
    // the Tailscale step
    ['a floating tag', `uses: ${TAILSCALE_ACTION} # v4.2.0`, 'uses: tailscale/github-action@v4', /must be pinned to a full 40-hex|second step must be exactly/],
    ['another commit', TAILSCALE_ACTION, `tailscale/github-action@${'0'.repeat(40)}`, /second step must be exactly[\s\S]*must be written exactly/],
    ['another release comment', '# v4.2.0', '# v4.1.3', /must be written exactly/],
    ['the latest client', 'version: 1.94.2', 'version: latest', /input version must be exactly 1\.94\.2/],
    ['an unpinned client', `          sha256sum: ${TAILSCALE_CLIENT_SHA256}\n`, '', /input sha256sum must be exactly/],
    ['another checksum', TAILSCALE_CLIENT_SHA256, 'f'.repeat(64), /input sha256sum must be exactly/],
    ['the cache', "use-cache: 'false'", "use-cache: 'true'", /input use-cache must be exactly false/],
    ['the deploy tag', 'tags: tag:nawara-ci-probe', 'tags: tag:nawara-ci-prod', /input tags must be exactly tag:nawara-ci-probe/],
    ['a second tag', 'tags: tag:nawara-ci-probe', 'tags: tag:nawara-ci-probe,tag:nawara-ci-prod', /input tags must be exactly/],
    ['another OIDC client', 'secrets.TS_PROBE_OIDC_CLIENT_ID', 'secrets.TS_OIDC_CLIENT_ID', /may read only[\s\S]*found secrets\.TS_OIDC_CLIENT_ID[\s\S]*oauth-client-id must be exactly/],
    ['a reusable auth key', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          authkey: \${{ secrets.TS_PROBE_HOST }}\n`, /accepts only[\s\S]*found: authkey/],
    ['an OAuth secret', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          oauth-secret: \${{ secrets.TS_PROBE_OIDC_AUDIENCE }}\n`, /found: oauth-secret/],
    ['an exit node', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          args: --exit-node=100.64.0.1\n`, /found: args/],
    ['route advertisement', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          args: --advertise-routes=10.0.0.0/8\n`, /found: args/],
    ['Tailscale SSH', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          args: --ssh\n`, /found: args/],
    ['daemon arguments', AFTER_TAILSCALE, `${AFTER_TAILSCALE}          tailscaled-args: --tun=userspace-networking\n`, /found: tailscaled-args/],
    ['a skippable join', "        uses: tailscale/", "        continue-on-error: true\n        uses: tailscale/", /Tailscale step may only have name, uses and with/],
    // secrets and credentials
    ['the deploy user', PROBE_STEP, `${PROBE_STEP}          DEPLOY_SSH_USER: \${{ secrets.DEPLOY_SSH_USER }}\n`, /may read only[\s\S]*found secrets\.DEPLOY_SSH_USER[\s\S]*probe step env must be exactly/],
    ['the deploy password', PROBE_STEP, `${PROBE_STEP}          DEPLOY_SSH_PASSWORD: \${{ secrets.DEPLOY_SSH_PASSWORD }}\n`, /found secrets\.DEPLOY_SSH_PASSWORD/],
    ['the deploy host', 'TS_PROBE_HOST: ${{ secrets.TS_PROBE_HOST }}', 'TS_PROBE_HOST: ${{ secrets.DEPLOY_SSH_HOST }}', /found secrets\.DEPLOY_SSH_HOST[\s\S]*env TS_PROBE_HOST must be exactly/],
    ['a bracketed deploy password', VALIDATE_STEP, `${VALIDATE_STEP}          P: \${{ secrets['DEPLOY_SSH_PASSWORD'] }}\n`, /found secrets\.DEPLOY_SSH_PASSWORD/],
    ['a backup key', PROBE_STEP, `${PROBE_STEP}          BACKUP_SSH_KEY: \${{ secrets.BACKUP_SSH_KEY }}\n`, /BACKUP_SSH_\* credentials are used only[\s\S]*found secrets\.BACKUP_SSH_KEY/],
    ['every secret at once', PROBE_STEP, `${PROBE_STEP}          ALL: \${{ toJSON(secrets) }}\n`, /never reads every secret at once/],
    ['a host as a variable', 'TS_PROBE_HOST: ${{ secrets.TS_PROBE_HOST }}', 'TS_PROBE_HOST: ${{ vars.TS_PROBE_HOST }}', /env TS_PROBE_HOST must be exactly \$\{\{ secrets\.TS_PROBE_HOST \}\}/],
    // steps and scripts
    ['a checkout', '    steps:\n', '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n', /exactly three steps/],
    ['the SSH action', '    steps:\n', `    steps:\n${HOST_KEY_GUARD_STEP}      - uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5\n        with:\n          fingerprint: \${{ secrets.DEPLOY_SSH_FINGERPRINT }}\n          script: |\n            set -euo pipefail\n            true\n`, /exactly three steps/],
    ['the SSH action instead of a step', VALIDATE_STEP, `      - name: Validate the probe configuration\n        uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5\n        env:\n`, /validate step may only have name, env and run[\s\S]*validate step must contact nothing/],
    ['an SSH login', COMPARE, `ssh -p "$DEPLOY_SSH_PORT" "u@$TS_PROBE_HOST" true\n          ${COMPARE}`, /runs an SSH login or a file transfer[\s\S]*exactly one remote tool/],
    ['a remote command over sshpass', COMPARE, `sshpass -e ssh "$TS_PROBE_HOST" uptime\n          ${COMPARE}`, /runs an SSH login/],
    ['a file transfer', COMPARE, `scp x "$TS_PROBE_HOST":\n          ${COMPARE}`, /runs an SSH login or a file transfer/],
    ['the backup script', COMPARE, `bash infra/backup/backup.sh\n          ${COMPARE}`, /refers to a backup or a repository script/],
    ['a backup dispatch', COMPARE, `gh workflow run core-backup.yml --ref main\n          ${COMPARE}`, /network, transfer[\s\S]*refers to a backup/],
    ['a download', COMPARE, `curl -fsS https://example.invalid/x\n          ${COMPARE}`, /network, transfer, decode/],
    ['a Tailscale command', COMPARE, `tailscale status\n          ${COMPARE}`, /network, transfer, decode/],
    ['a netcat', COMPARE, `nc -z "$TS_PROBE_HOST" 22\n          ${COMPARE}`, /network, transfer, decode/],
    ['a pipe into a shell', COMPARE, `echo true | bash\n          ${COMPARE}`, /pipes a script into a shell/],
    ['command tracing', PROBE_RUN, '        run: |\n          set -euo pipefail\n          set -x\n          if timeout', /enables command tracing/],
    ['xtrace', PROBE_RUN, '        run: |\n          set -euo pipefail\n          set -o xtrace\n          if timeout', /enables command tracing/],
    ['a printed address', COMPARE, `echo "reached $TS_PROBE_HOST"\n          ${COMPARE}`, /prints a variable or command output/],
    ['a printed fingerprint', COMPARE, `printf '%s\\n' "$fp"\n          ${COMPARE}`, /prints a variable or command output/],
    ['a printed scan', COMPARE, `{ echo "$keys"; }\n          ${COMPARE}`, /prints a variable or command output/],
    ['a file written', COMPARE, `echo PASS >"$RUNNER_TEMP/x"\n          ${COMPARE}`, /writes a file/],
    ['an interpolated secret', COMPARE, `test -n "\${{ secrets.TS_PROBE_HOST }}"\n          ${COMPARE}`, /no expression is interpolated/],
    ['no strict mode', PROBE_RUN, '        run: |\n          if timeout', /must start with "set -euo pipefail"/],
    ['a second keyscan', COMPARE, `ssh-keyscan -t rsa "$TS_PROBE_HOST" 2>/dev/null\n          ${COMPARE}`, /exactly one remote tool/],
    ['a keyscan of another host', KEYSCAN, 'keys=$(ssh-keyscan -T 10 -t ecdsa -p "$DEPLOY_SSH_PORT" example.invalid 2>/dev/null', /exactly one remote tool/],
    ['a keyscan of every key type', KEYSCAN, 'keys=$(ssh-keyscan -T 10 -p "$DEPLOY_SSH_PORT" "$TS_PROBE_HOST" 2>/dev/null', /exactly one remote tool/],
    ['no TCP test', 'if timeout 10 bash -c \'exec 3<>"/dev/tcp/$0/$1"\' "$TS_PROBE_HOST" "$DEPLOY_SSH_PORT" 2>/dev/null; then', 'if true; then', /must test the TCP connection/],
    ['no comparison', COMPARE, 'if [ -n "$fp" ]; then', /must compare the scanned fingerprint/],
    ['an inverted comparison', COMPARE, 'if [ -n "$fp" ] || [ "$fp" = "$DEPLOY_SSH_FINGERPRINT" ]; then', /must compare the scanned fingerprint/],
    ['key generation', COMPARE, `ssh-keygen -t ed25519 -N "" -f k\n          ${COMPARE}`, /ssh-keygen may only print a fingerprint/],
    ['no key type check', '[ "$(awk \'{print $2}\' <<<"$keys")" = ecdsa-sha2-nistp256 ]', 'true', /exactly one ecdsa-sha2-nistp256/],
    ['no key count check', '[ "$(grep -c . <<<"$keys" || true)" = 1 ] && ', '', /exactly one ecdsa-sha2-nistp256/],
    ['no CIDR check', 'ipaddress.IPv4Network("100.64.0.0/10")', 'ipaddress.IPv4Network("0.0.0.0/0")', /inside 100\.64\.0\.0\/10/],
    ['no IPv4 parse', 'ipaddress.IPv4Address(os.environ.get("TS_PROBE_HOST", ""))', 'ipaddress.ip_address("100.64.0.1")', /parsed as an IPv4 address/],
    ['no port check', '[[ $DEPLOY_SSH_PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( DEPLOY_SSH_PORT <= 65535 ))', 'true', /checked to be a TCP port/],
    ['no fingerprint format check', '[[ $DEPLOY_SSH_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]', 'true', /checked to be a SHA256 fingerprint/],
    ['a validation that cannot fail', 'exit 1; }\n          echo "PASS destination', 'true; }\n          echo "PASS destination', /must exit 1 on each failed check/],
    ['a contact before the join', '          echo "PASS destination: a tailnet IPv4 address"\n', '          ssh-keyscan "$TS_PROBE_HOST" 2>/dev/null\n          echo "PASS destination: a tailnet IPv4 address"\n', /validate step must contact nothing/],
    ['a skippable probe', '      - name: Probe the SSH port and host key (no authentication)\n', '      - name: Probe the SSH port and host key (no authentication)\n        continue-on-error: true\n', /probe step may only have name, env and run/],
    ['a conditional validation', '      - name: Validate the probe configuration\n', "      - name: Validate the probe configuration\n        if: false\n", /validate step may only have name, env and run/],
    ['a shell override', PROBE_RUN, `        shell: sh\n${PROBE_RUN}`, /probe step may only have name, env and run/],
  ];
  for (const [label, from, to, re] of cases) assert.match(probeProblems(swap(PROBE, from, to)), re, label);
});

test('T6/T7: the tailnet identity stays in the two tailnet jobs: id-token, the Tailscale action and TS_* secrets are refused anywhere else', () => {
  // A copy of the probe under another name gets none of the probe's allowances.
  assert.match(probeProblems(PROBE, 'core-network-probe-copy.yml'), /id-token: write is allowed only on the network probe job[\s\S]*Tailscale action is used only by the network probe job[\s\S]*TS_\* secrets are read only by the tailnet jobs/);
  // So does a copy of the backup.
  assert.match(probeProblems(workflow(BACKUP_WORKFLOW), 'core-backup-copy.yml'), /id-token: write is allowed only[\s\S]*Tailscale action is used only[\s\S]*TS_\* secrets are read only by the tailnet jobs[\s\S]*found secrets\.TS_BACKUP_/);
  const tailscaleStep = (prefix, tag) => `      - uses: ${TAILSCALE_ACTION} # ${TAILSCALE_ACTION_RELEASE}\n        with:\n          oauth-client-id: \${{ secrets.${prefix}OIDC_CLIENT_ID }}\n          audience: \${{ secrets.${prefix}OIDC_AUDIENCE }}\n          tags: ${tag}\n`;
  // Every other production SSH workflow stays without a tailnet identity (unchanged files; adding one is refused).
  for (const name of PRODUCTION_WORKFLOWS.filter((n) => n !== BACKUP_WORKFLOW)) {
    const text = workflow(name);
    assert.doesNotMatch(text, /tailscale|id-token|TS_/i, name);
    const join = text.replace(/\n {6}- uses: appleboy\/ssh-action@/, `\n${tailscaleStep('TS_BACKUP_', BACKUP_TAG).trimEnd()}\n      - uses: appleboy/ssh-action@`);
    assert.notEqual(join, text, name);
    assert.match(probeProblems(join, name), /Tailscale action is used only by the network probe job[\s\S]*TS_\* secrets are read only by the tailnet jobs[\s\S]*found secrets\.TS_BACKUP_OIDC_CLIENT_ID/, name);
    const edited = parseDocument(text);
    const sshJob = Object.entries(parse(text).jobs).find(([, j]) => (j.steps ?? []).some((st) => String(st.uses ?? '').startsWith('appleboy/ssh-action')))[0];
    edited.setIn(['jobs', sshJob, 'permissions', 'id-token'], 'write');
    assert.match(probeProblems(String(edited), name), /id-token: write is allowed only/, name);
  }
  // Every workflow but the two tailnet ones: no id-token unless it is an image workflow's build-image job; no action, no TS_* secret.
  for (const name of readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((n) => n.endsWith('.yml') && n !== PROBE_WORKFLOW && n !== BACKUP_WORKFLOW)) {
    const doc = parse(workflow(name));
    for (const [jobId, job] of Object.entries(doc.jobs)) {
      const perms = job.permissions ?? doc.permissions ?? {};
      if (perms === 'write-all' || perms['id-token'] === 'write') assert.equal(jobId, 'build-image', `${name} ${jobId}`);
      assert.doesNotMatch(JSON.stringify(job), /tailscale\/|secrets\.TS_/, `${name} ${jobId}`);
    }
  }
  const other = (job, perms = '') => `name: o\non:\n  workflow_dispatch:\n${perms}jobs:\n  x:\n${job}`;
  assert.match(probeProblems(other('    permissions:\n      id-token: write\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n'), 'o.yml'), /id-token: write is allowed only/);
  assert.match(probeProblems(other('    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n', 'permissions:\n  id-token: write\n'), 'o.yml'), /id-token: write is allowed only/);
  for (const secret of ['TS_PROBE_HOST', 'TS_BACKUP_HOST', 'TS_OTHER']) {
    assert.match(probeProblems(other(`    runs-on: ubuntu-latest\n    steps:\n      - run: echo "$H"\n        env:\n          H: \${{ secrets['${secret}'] }}\n`), 'o.yml'), new RegExp(`TS_\\* secrets are read only by the tailnet jobs[\\s\\S]*found secrets\\.${secret}`), secret);
  }
  // Each tailnet job reads only its own prefix: the backup never the probe's identity, the probe never the backup's.
  assert.match(probeProblems(swap(workflow(BACKUP_WORKFLOW), 'secrets.TS_BACKUP_OIDC_CLIENT_ID', 'secrets.TS_PROBE_OIDC_CLIENT_ID'), BACKUP_WORKFLOW), /found secrets\.TS_PROBE_OIDC_CLIENT_ID[\s\S]*may read only/);
  assert.match(probeProblems(swap(PROBE, 'secrets.TS_PROBE_OIDC_CLIENT_ID', 'secrets.TS_BACKUP_OIDC_CLIENT_ID')), /may read only[\s\S]*found secrets\.TS_BACKUP_OIDC_CLIENT_ID|found secrets\.TS_BACKUP_OIDC_CLIENT_ID[\s\S]*may read only/);
  // The image build keeps its attestation token (unchanged rule).
  assert.deepEqual(checkWorkflowSafety('auth-service-docker-build.yml', BUILD), []);
  // A probe job anywhere but core-network-probe.yml is not the probe: renaming the job in the real file is refused too.
  assert.match(probeProblems(swap(PROBE, 'jobs:\n  probe:\n', 'jobs:\n  check:\n')), /id-token: write is allowed only[\s\S]*exactly one job, "probe"/);
  assert.match(probeProblems(swap(workflow(BACKUP_WORKFLOW), 'jobs:\n  backup:\n', 'jobs:\n  run:\n'), BACKUP_WORKFLOW), /id-token: write is allowed only[\s\S]*exactly one job, "backup"/);
});

// ================================================================================ Core V2 M2 T7: the manual backup over the tailnet
const BACKUP_WF = workflow(BACKUP_WORKFLOW);
const backupProblems = (text, file = BACKUP_WORKFLOW) => checkWorkflowSafety(file, text).join('\n');
const DEST_STEP = '      - name: Validate the private backup destination\n';
const JOIN_STEP = '      - name: Join the tailnet (ephemeral node, tag:nawara-ci-prod)\n';
const SSH_STEP = '      - uses: appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5\n';
const BACKUP_JOIN_END = "          use-cache: 'false'\n";
const blockOf = (text, header) => {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `fixture drift: ${header}`);
  const next = text.slice(start + header.length).search(/\n {6}(- |# )/);
  return text.slice(start, start + header.length + next + 1);
};

test('T7: the manual backup joins the tailnet and keeps every existing control', () => {
  assert.deepEqual(checkWorkflowSafety(BACKUP_WORKFLOW, BACKUP_WF), []);
  assert.deepEqual(checkActionPins(BACKUP_WORKFLOW, BACKUP_WF), []);
  const doc = parse(BACKUP_WF);
  // Unchanged: trigger, input, workflow permissions, guard, environment, queue, runner, no timeout.
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(doc.on.workflow_dispatch.inputs), ['services']);
  assert.equal(doc.on.workflow_dispatch.inputs.services.required, true);
  assert.equal(doc.on.workflow_dispatch.inputs.services.default, 'auth-service');
  assert.deepEqual(doc.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(doc.jobs), [BACKUP_JOB]);
  const job = doc.jobs[BACKUP_JOB];
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.equal(job.environment, 'production');
  assert.deepEqual(job.concurrency, { group: PRODUCTION_GROUP, 'cancel-in-progress': false });
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['timeout-minutes'], undefined, 'the backup timeout behaviour is unchanged');
  // New: the job token, the destination check and the join, in order before the unchanged SSH step.
  assert.deepEqual(job.permissions, BACKUP_PERMISSIONS);
  assert.deepEqual(job.steps.map((s) => s.name ?? s.uses.split('@')[0]), ['actions/checkout', undefined, 'Require the pinned production host key',
    'Validate the private backup destination', 'Join the tailnet (ephemeral node, tag:nawara-ci-prod)', 'appleboy/ssh-action'].map((n, i) => (i === 1 ? job.steps[1].name : n)));
  assert.equal(job.steps[1].run.trim(), BACKUP_PACKAGE_RUN);
  assert.deepEqual(job.steps[3].env, BACKUP_DESTINATION_ENV);
  assert.equal(job.steps[4].uses, TAILSCALE_ACTION);
  assert.deepEqual(job.steps[4].with, BACKUP_TAILSCALE_WITH);
  assert.equal(BACKUP_TAILSCALE_WITH.tags, 'tag:nawara-ci-prod');
  assert.equal(job.steps[5].uses, BACKUP_SSH_ACTION);
  const { script, ...sshWith } = job.steps[5].with;
  assert.deepEqual(sshWith, BACKUP_SSH_WITH);
  assert.equal(sshWith.host, job.steps[3].env.TS_BACKUP_HOST, 'the SSH host is the validated value');
  assert.equal(sshWith.port, job.steps[3].env.DEPLOY_SSH_PORT, 'the SSH port is the validated value, without the former || 22');
  assert.deepEqual(script.trim().split('\n').map((l) => l.trim()), BACKUP_REMOTE_SCRIPT);
  assert.deepEqual(job.steps[5].env, { BACKUP_SERVICES: '${{ inputs.services }}' });
  assert.doesNotMatch(JSON.stringify(doc), /DEPLOY_SSH_HOST|TS_PROBE_|toJSON|proxy_|PLUGIN_|"SSH_/);
  assert.deepEqual([...BACKUP_JOB_SECRETS].sort(), ['DEPLOY_SSH_FINGERPRINT', 'DEPLOY_SSH_PASSWORD', 'DEPLOY_SSH_PORT', 'DEPLOY_SSH_USER', 'TS_BACKUP_HOST', 'TS_BACKUP_OIDC_AUDIENCE', 'TS_BACKUP_OIDC_CLIENT_ID']);
});

test('T7: the network probe is unchanged by T7 and still passes every T6 rule', () => {
  assert.deepEqual(checkWorkflowSafety(PROBE_WORKFLOW, PROBE), []);
  assert.equal(createHash('sha256').update(PROBE).digest('hex'), createHash('sha256').update(workflow(PROBE_WORKFLOW)).digest('hex'));
  assert.doesNotMatch(PROBE, /TS_BACKUP_|tag:nawara-ci-prod\b/);
});

test('T7: every relaxation of the backup job is refused', () => {
  const dest = blockOf(BACKUP_WF, DEST_STEP);
  const join = blockOf(BACKUP_WF, JOIN_STEP);
  const cases = [
    // destination
    ['the shared LAN host', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: ${{ secrets.DEPLOY_SSH_HOST }}', /SSH input host must be exactly[\s\S]*never reads DEPLOY_SSH_HOST/],
    ['a LAN fallback', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: ${{ secrets.TS_BACKUP_HOST || secrets.DEPLOY_SSH_HOST }}', /SSH input host must be exactly[\s\S]*no fallback/],
    ['a literal host', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: 203.0.113.7', /SSH input host must be exactly/],
    ['two hosts', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: ${{ secrets.TS_BACKUP_HOST }},203.0.113.7', /SSH input host must be exactly/],
    ['a port suffix', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: ${{ secrets.TS_BACKUP_HOST }}:22', /SSH input host must be exactly/],
    ['a variable host', 'host: ${{ secrets.TS_BACKUP_HOST }}', 'host: ${{ vars.TS_BACKUP_HOST }}', /SSH input host must be exactly/],
    ['the port fallback', 'port: ${{ secrets.DEPLOY_SSH_PORT }}\n', 'port: ${{ secrets.DEPLOY_SSH_PORT || 22 }}\n', /SSH input port must be exactly[\s\S]*no fallback/],
    ['a literal port', 'port: ${{ secrets.DEPLOY_SSH_PORT }}\n', 'port: 22\n', /SSH input port must be exactly/],
    ['validating another host', '          TS_BACKUP_HOST: ${{ secrets.TS_BACKUP_HOST }}\n', '          TS_BACKUP_HOST: ${{ secrets.TS_PROBE_HOST }}\n', /destination check, must read exactly[\s\S]*found secrets\.TS_PROBE_HOST/],
    ['validating another port', "          DEPLOY_SSH_PORT: ${{ secrets.DEPLOY_SSH_PORT }}\n        run: |\n          set -euo pipefail\n          python3", "          DEPLOY_SSH_PORT: '2222'\n        run: |\n          set -euo pipefail\n          python3", /destination check, must read exactly/],
    ['no CIDR check', 'ipaddress.IPv4Network("100.64.0.0/10")', 'ipaddress.IPv4Network("0.0.0.0/0")', /inside 100\.64\.0\.0\/10/],
    ['a lenient parse', 'ipaddress.IPv4Address(os.environ.get("TS_BACKUP_HOST", ""))', 'ipaddress.ip_address(os.environ.get("TS_BACKUP_HOST", "").split(",")[0])', /parsed as exactly one IPv4 address/],
    ['no port check', '[[ $DEPLOY_SSH_PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( DEPLOY_SSH_PORT <= 65535 ))', 'true', /checked to be one TCP port/],
    ['a check that cannot fail', 'exit 1; }\n          echo "PASS destination', 'true; }\n          echo "PASS destination', /must exit 1 on each failed check/],
    ['a printed destination', '          echo "PASS destination: one tailnet IPv4 address"\n', '          echo "PASS destination: $TS_BACKUP_HOST"\n', /prints a variable/],
    ['tracing', '          set -euo pipefail\n          python3', '          set -euo pipefail\n          set -x\n          python3', /enables command tracing/],
    ['a contact before the join', '          echo "PASS port: one TCP port"\n', '          echo "PASS port: one TCP port"\n          ssh-keyscan "$TS_BACKUP_HOST" 2>/dev/null\n', /must contact nothing/],
    ['a GITHUB_ENV write in the check', '          echo "PASS port: one TCP port"\n', '          echo "PASS port: one TCP port"\n          echo "SSH_HOST=203.0.113.7" >> "$GITHUB_ENV"\n', /writes a file[\s\S]*must not set SSH_HOST/],
    // skipping and ordering
    ['a skippable check', DEST_STEP, `${DEST_STEP}        continue-on-error: true\n`, /destination check step may only have/],
    ['a conditional check', DEST_STEP, `${DEST_STEP}        if: false\n`, /destination check step may only have/],
    ['a skippable join', JOIN_STEP, `${JOIN_STEP}        continue-on-error: true\n`, /Tailscale step may only have/],
    ['a conditional join', JOIN_STEP, `${JOIN_STEP}        if: always()\n`, /Tailscale step may only have/],
    ['a conditional SSH step', SSH_STEP, SSH_STEP.replace('\n', "\n        if: success() || failure()\n"), /SSH step may only have/],
    ['no check', dest, '', /exactly six steps/],
    ['no join', join, '', /exactly six steps/],
    ['a checkout of another ref', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n', '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          ref: other\n', /checkout step may only have name, uses/],
    ['another package step', BACKUP_PACKAGE_RUN, 'echo "BACKUP_B64=$(base64 -w0 other.sh)" >> "$GITHUB_ENV"', /step 2 must be exactly/],
    // permissions
    ['workflow-level id-token', 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n', /workflow permissions must be exactly "contents: read"/],
    ['no job id-token', '      contents: read\n      id-token: write\n', '      contents: read\n', /job permissions must be exactly/],
    ['no job contents', '      contents: read\n      id-token: write\n', '      id-token: write\n', /job permissions must be exactly/],
    ['write-all on the job', '    permissions:\n      contents: read\n      id-token: write\n', '    permissions: write-all\n', /job permissions must be exactly/],
    ['an extra job permission', '      id-token: write\n', '      id-token: write\n      packages: write\n', /job permissions must be exactly/],
    // the Tailscale step
    ['the probe tag', 'tags: tag:nawara-ci-prod', 'tags: tag:nawara-ci-probe', /input tags must be exactly tag:nawara-ci-prod/],
    ['a second tag', 'tags: tag:nawara-ci-prod', 'tags: tag:nawara-ci-prod,tag:nawara-ci-probe', /input tags must be exactly/],
    ['the probe identity', 'secrets.TS_BACKUP_OIDC_AUDIENCE', 'secrets.TS_PROBE_OIDC_AUDIENCE', /found secrets\.TS_PROBE_OIDC_AUDIENCE[\s\S]*input audience must be exactly/],
    ['another action commit', `uses: ${TAILSCALE_ACTION} # v4.2.0`, `uses: tailscale/github-action@${'1'.repeat(40)} # v4.2.0`, /step 5 must be exactly[\s\S]*must be written exactly/],
    ['a floating action', `uses: ${TAILSCALE_ACTION} # v4.2.0`, 'uses: tailscale/github-action@v4', /step 5 must be exactly/],
    ['the latest client', 'version: 1.94.2', 'version: latest', /input version must be exactly 1\.94\.2/],
    ['another checksum', TAILSCALE_CLIENT_SHA256, 'e'.repeat(64), /input sha256sum must be exactly/],
    ['the cache', `use-cache: 'false'\n      - uses: appleboy`, `use-cache: 'true'\n      - uses: appleboy`, /input use-cache must be exactly false/],
    ['an auth key', BACKUP_JOIN_END, `${BACKUP_JOIN_END}          authkey: \${{ secrets.TS_BACKUP_HOST }}\n`, /found: authkey/],
    ['an OAuth secret', BACKUP_JOIN_END, `${BACKUP_JOIN_END}          oauth-secret: \${{ secrets.TS_BACKUP_OIDC_AUDIENCE }}\n`, /found: oauth-secret/],
    ['an exit node', BACKUP_JOIN_END, `${BACKUP_JOIN_END}          args: --exit-node=100.64.0.1\n`, /found: args/],
    ['Tailscale SSH', BACKUP_JOIN_END, `${BACKUP_JOIN_END}          args: --ssh\n`, /found: args/],
    // SSH authentication and the remote script stay as they were
    ['another user', 'username: ${{ secrets.DEPLOY_SSH_USER }}', 'username: ${{ secrets.BACKUP_SSH_USER }}', /SSH input username must be exactly[\s\S]*BACKUP_SSH_\* credentials are used only/],
    ['another password', 'password: ${{ secrets.DEPLOY_SSH_PASSWORD }}', 'password: ${{ secrets.TS_BACKUP_HOST }}', /SSH input password must be exactly/],
    ['no pin', '          fingerprint: ${{ secrets.DEPLOY_SSH_FINGERPRINT }}\n          envs:', '          envs:', /must pin the production host key[\s\S]*SSH input fingerprint must be exactly/],
    ['a forwarded tailnet value', 'envs: BACKUP_B64,BACKUP_SERVICES', 'envs: BACKUP_B64,BACKUP_SERVICES,TS_BACKUP_HOST', /SSH input envs must be exactly/],
    ['every variable forwarded', 'envs: BACKUP_B64,BACKUP_SERVICES', 'envs: BACKUP_B64,BACKUP_SERVICES\n          allenvs: true', /may set only[\s\S]*found: allenvs/],
    ['a changed remote script', '| BACKUP_SERVICES="$BACKUP_SERVICES" bash -s', '| BACKUP_SERVICES="auth-service organization-service audit-service" bash -s', /remote script must stay exactly/],
    ['another service source', 'BACKUP_SERVICES: ${{ inputs.services }}', "BACKUP_SERVICES: auth-service", /SSH step env must stay exactly/],
    ['another SSH action pin', 'appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2 # v1.2.5', `appleboy/ssh-action@${'2'.repeat(40)} # v1.2.5`, /step 6 must be exactly/],
    ['a proxy', 'envs: BACKUP_B64,BACKUP_SERVICES', 'envs: BACKUP_B64,BACKUP_SERVICES\n          proxy_host: 203.0.113.7', /must not use a proxy[\s\S]*found: proxy_host/],
    ['a protocol switch', 'envs: BACKUP_B64,BACKUP_SERVICES', 'envs: BACKUP_B64,BACKUP_SERVICES\n          protocol: tcp6', /found: protocol/],
    // job and workflow shape
    ['another environment', '    environment: production\n', '    environment: production-backup\n', /reserved for the scheduled backup[\s\S]*must declare "environment: production"/],
    ['no main guard', "    if: github.ref == 'refs/heads/main'\n", '', /guarded by exactly[\s\S]*restricted to refs\/heads\/main/],
    ['a cancellable run', 'cancel-in-progress: false', 'cancel-in-progress: true', /cancel-in-progress must be explicitly false/],
    ['a self-hosted runner', 'runs-on: ubuntu-latest', 'runs-on: self-hosted', /runs-on must stay ubuntu-latest/],
    ['a job working directory', '    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: infra\n', /"defaults" not allowed on the backup job/],
    ['a workflow env', 'permissions:\n  contents: read\n', 'permissions:\n  contents: read\nenv:\n  X: y\n', /no workflow-level "env"/],
    ['a second input', '        default: auth-service\n', '        default: auth-service\n      host:\n        required: false\n', /keeps exactly one input/],
    ['a schedule', 'on:\n  workflow_dispatch:\n', "on:\n  schedule:\n    - cron: '0 2 * * *'\n  workflow_dispatch:\n", /must be in a workflow_dispatch-only workflow/],
    ['a second job', 'jobs:\n', 'jobs:\n  other:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n', /exactly one job, "backup"/],
    ['every secret at once', '          BACKUP_SERVICES: ${{ inputs.services }}\n', '          BACKUP_SERVICES: ${{ inputs.services }}\n          ALL: ${{ toJSON(secrets) }}\n', /never reads every secret at once[\s\S]*SSH step env must stay exactly/],
  ];
  // Each part between [\s\S]* must be reported, in any order.
  for (const [label, from, to, re] of cases) {
    const out = backupProblems(swap(BACKUP_WF, from, to));
    for (const part of re.source.split('[\\s\\S]*')) assert.match(out, new RegExp(part), `${label}: ${part}`);
  }
});

test('T7: every reordering of guard → destination check → Tailscale → SSH is refused', () => {
  // The original YAML nodes are moved (their pin comments kept), so only the order differs.
  const reordered = (order) => {
    const d = parseDocument(BACKUP_WF);
    const seq = d.getIn(['jobs', BACKUP_JOB, 'steps']);
    seq.items = order.map((i) => seq.items[i]);
    return backupProblems(String(d));
  };
  for (const [label, order, re] of [
    ['the join after the SSH step', [0, 1, 2, 3, 5, 4], /step 5 must be exactly[\s\S]*step 6 must be exactly/],
    ['the check after the join', [0, 1, 2, 4, 3, 5], /step 4, the destination check[\s\S]*step 5 must be exactly/],
    ['the join before the guard', [0, 1, 4, 2, 3, 5], /step 3 must be the host-key guard/],
    ['the check before the guard', [0, 1, 3, 2, 4, 5], /step 3 must be the host-key guard[\s\S]*step 4, the destination check/],
    ['the SSH step first', [5, 0, 1, 2, 3, 4], /step 1 must be the pinned actions\/checkout/],
    ['the guard after the SSH step', [0, 1, 3, 4, 5, 2], /must be preceded by the host-key guard step/],
  ]) {
    const out = reordered(order);
    for (const part of re.source.split('[\\s\\S]*')) assert.match(out, new RegExp(part), `${label}: ${part}`);
  }
  assert.equal(reordered([0, 1, 2, 3, 4, 5]), '', 'control: the real order passes');
});

test('T7: no drone-ssh override variable, $GITHUB_ENV override or extra SSH input in any production SSH workflow (files unchanged)', () => {
  const OVERRIDES = ['PLUGIN_HOST', 'SSH_HOST', 'PLUGIN_PORT', 'SSH_PORT', 'PLUGIN_USERNAME', 'SSH_PASSWORD', 'PLUGIN_FINGERPRINT', 'PROXY_SSH_HOST', 'INPUT_HOST', 'INPUT_ALLENVS', 'DEBUG', 'plugin_host'];
  for (const name of PRODUCTION_WORKFLOWS) {
    const text = workflow(name);
    assert.deepEqual(checkWorkflowSafety(name, text), [], name);
    const doc = parseDocument(text);
    const sshJob = Object.entries(parse(text).jobs).find(([, j]) => (j.steps ?? []).some((st) => String(st.uses ?? '').startsWith('appleboy/ssh-action')))[0];
    const sshAt = parse(text).jobs[sshJob].steps.findIndex((st) => String(st.uses ?? '').startsWith('appleboy/ssh-action'));
    for (const key of OVERRIDES) {
      for (const [level, path] of [['workflow', ['env', key]], ['job', ['jobs', sshJob, 'env', key]], ['SSH-step', ['jobs', sshJob, 'steps', sshAt, 'env', key]]]) {
        const d = doc.clone();
        d.setIn(path, '203.0.113.7');
        assert.match(checkWorkflowSafety(name, String(d)).join('\n'), new RegExp(`no drone-ssh override variable may be set at ${level} level \\(found: ${key}\\)`), `${name} ${level} ${key}`);
      }
    }
    for (const input of ['proxy_host', 'protocol', 'allenvs', 'debug', 'key', 'key_path', 'timeout', 'sync', 'request_pty', 'script_path']) {
      const d = doc.clone();
      d.setIn(['jobs', sshJob, 'steps', sshAt, 'with', input], 'x');
      assert.match(checkWorkflowSafety(name, String(d)).join('\n'), new RegExp(`may set only ${SSH_ACTION_INPUTS.join(', ')} \\(found: ${input}\\)`), `${name} ${input}`);
    }
    // A step before the SSH step that writes an override, or $GITHUB_ENV in any non-literal form, or $GITHUB_PATH.
    for (const [run, re] of [
      ['echo "SSH_HOST=203.0.113.7" >> "$GITHUB_ENV"', /must not set SSH_HOST/],
      ['echo "PLUGIN_PORT=22" >> "$GITHUB_ENV"', /must not set PLUGIN_PORT/],
      ['echo "SSH_FINGERPRINT=x" >> "$GITHUB_ENV"', /must not set SSH_FINGERPRINT/],
      ['echo "X=1" >> "$GITHUB_ENV"; echo "SSH_HOST=h" >> "$GITHUB_ENV"', /may only be written as one literal line/],
      ['printf "SSH_HOST=h\\n" >> $GITHUB_ENV', /may only be written as one literal line/],
      ['cat >> "$GITHUB_ENV" <<EOF', /may only be written as one literal line/],
      ['f="$GITHUB_ENV"', /may only be written as one literal line/],
      ['echo "/tmp/x" >> "$GITHUB_PATH"', /never writes \$GITHUB_PATH/],
    ]) {
      const d = doc.clone();
      d.setIn(['jobs', sshJob, 'steps', 0], d.createNode({ name: 'x', run }));
      assert.match(checkWorkflowSafety(name, String(d)).join('\n'), re, `${name}: ${run}`);
    }
  }
  // The existing literal package lines stay accepted (ROTATE_B64, PROVISION_B64, BACKUP_B64): legitimate behaviour is preserved.
  for (const name of ['auth-db-credential-rotate.yml', 'core-rabbitmq-provision.yml', 'core-backup.yml']) assert.match(workflow(name), /_B64=\$\(base64 -w0 [^)]+\)" >> "\$GITHUB_ENV"/, name);
});

test('T7: no committed .host or .port file can choose a production SSH destination', () => {
  assert.deepEqual(checkDroneSshFiles(gitTrackedFiles(new URL('..', import.meta.url).pathname)), []);
  assert.deepEqual(checkDroneSshFiles(['README.md', 'apps/x/host.ts', '.hosts', 'port']), []);
  for (const path of ['.host', '.port', 'infra/.host', 'apps/auth-service/.port']) assert.match(checkDroneSshFiles([path]).join(), /drone-ssh \(the production SSH client\) can read its destination/, path);
  assert.match(checkDroneSshFiles(undefined).join(), /cannot run/);
});

test('S1b: event provenance (an unkeyed body digest) is allowed only in reviewed services that consume no code-bearing event', async () => {
  const { EVENT_PROVENANCE_APPROVED_SERVICES, checkEventProvenanceOptIn } = await import('./lib/checks.mjs');
  assert.deepEqual(EVENT_PROVENANCE_APPROVED_SERVICES, ['billing-service', 'audit-service', 'notification-service']);
  const contract = (service, produces, consumes) => JSON.stringify({ service, produces, consumes });
  const contracts = {
    'auth-service': contract('auth-service', [{ name: 'member.contact_verification_requested', version: 1, codeBearing: true, payload: {} }, { name: 'user.registered', version: 1, payload: {} }], []),
    'payment-service': contract('payment-service', [{ name: 'payment.succeeded', version: 1, payload: {} }], []),
    'billing-service': contract('billing-service', [], [{ source: 'payment-service', name: 'payment.succeeded', version: 1, requires: {} }]),
  };
  const optIn = "await bus.subscribe({ queue, bindings, handler, provenance: { ownerOf, store: new PgProvenanceStore(db) } });";
  const billing = { 'apps/billing-service/src/c.ts': optIn };
  assert.deepEqual(checkEventProvenanceOptIn(contracts, { 'billing-service': billing, 'notification-service': { 'apps/notification-service/src/c.ts': 'bus.subscribe({ queue, handler })' } }), []);
  // any other service naming the store or passing `provenance:` is refused (Notification, Audit, ...)
  for (const text of [optIn, 'subscribe({ queue, handler, provenance: p })', "import { PgProvenanceStore } from '@nawara/service-kit';", 'class S implements ProvenanceStore {}']) {
    for (const app of ['payment-service', 'file-service']) {
      assert.match(checkEventProvenanceOptIn(contracts, { 'billing-service': billing, [app]: { [`apps/${app}/src/c.ts`]: text } }).join(), /is not on EVENT_PROVENANCE_APPROVED_SERVICES/, `${app}: ${text}`);
    }
  }
  // an approved service that consumes a code-bearing event, or has no contract, is refused
  const consumesCode = { ...contracts, 'billing-service': contract('billing-service', [], [{ source: 'auth-service', name: 'member.contact_verification_requested', version: 1, requires: {} }]) };
  assert.match(checkEventProvenanceOptIn(consumesCode, { 'billing-service': billing }).join(), /consumes the code-bearing auth-service member\.contact_verification_requested/);
  const noContract = { ...contracts };
  delete noContract['billing-service'];
  assert.match(checkEventProvenanceOptIn(noContract, { 'billing-service': billing }).join(), /must declare what it consumes/);
  // a non-code-bearing event of the same producer is fine
  const consumesPlain = { ...contracts, 'billing-service': contract('billing-service', [], [{ source: 'auth-service', name: 'user.registered', version: 1, requires: {} }]) };
  assert.deepEqual(checkEventProvenanceOptIn(consumesPlain, { 'billing-service': billing }), []);
});

test('S1b-2: Audit keeps event provenance only behind its admission boundary; removing any part of it is refused', async () => {
  const { AUDIT_ADMISSION_FILES, KIT_EVENT_BUS, auditAdmissionProblems, checkEventProvenanceOptIn } = await import('./lib/checks.mjs');
  const root = new URL('..', import.meta.url).pathname;
  const files = Object.fromEntries([...Object.values(AUDIT_ADMISSION_FILES), KIT_EVENT_BUS].map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
  assert.deepEqual(auditAdmissionProblems(files), []); // the repository as it stands
  const contracts = Object.fromEntries(['billing-service', 'payment-service', 'auth-service'].map((app) => [app, readFileSync(join(root, 'apps', app, 'contracts/events.json'), 'utf8')]));
  const audit = { 'audit-service': { [AUDIT_ADMISSION_FILES.consumer]: files[AUDIT_ADMISSION_FILES.consumer] } };
  assert.deepEqual(checkEventProvenanceOptIn(contracts, audit, files), []);
  assert.match(checkEventProvenanceOptIn(contracts, audit, {}).join(), /admission boundary/); // opted in, boundary files unreadable: refused
  assert.deepEqual(checkEventProvenanceOptIn(contracts, { 'audit-service': { 'apps/audit-service/src/x.ts': 'bus.subscribe({ queue, handler })' } }, {}), []); // not opted in
  const mutate = (rel, from, to) => {
    assert.ok(files[rel].includes(from), `${rel} no longer contains ${from}`);
    return { ...files, [rel]: files[rel].replace(from, to) };
  };
  const mutations = [
    [AUDIT_ADMISSION_FILES.consumer, 'admission: (e, body) => this.ingestion.admit(e, body),', '', /must pass `admission:/],
    [AUDIT_ADMISSION_FILES.consumer, 'deadLetterPolicy: auditDeadLetterPolicy,', 'deadLetterPolicy: () => ({ body: "original", headers: {} }),', /must pass `deadLetterPolicy: auditDeadLetterPolicy`/],
    [AUDIT_ADMISSION_FILES.ingestion, 'decision = auditAdmission(event, body);', 'decision = { admitted: true };', /must decide through `auditAdmission\(`/],
    [AUDIT_ADMISSION_FILES.admission, 'if (!isCanonicalJsonBody(body))', 'if (false)', /must check canonical bytes/],
    [AUDIT_ADMISSION_FILES.admission, 'if (!mayRetainRefusedAuditBody(event))', 'if (false)', /must check canonical bytes/],
    [AUDIT_ADMISSION_FILES.admission, 'const refusal = contractRefusal(event);', 'const refusal = undefined;', /must check canonical bytes/],
    [AUDIT_ADMISSION_FILES.admission, 'if (refusal) return', 'if (false) return', /must check canonical bytes/],
    [AUDIT_ADMISSION_FILES.admission, '    validateAuditEvent(event);', '', /must check canonical bytes/],
    [AUDIT_ADMISSION_FILES.deadLetterPolicy, 'isCanonicalJsonBody(body) && ', '', /must keep an original body only when it is canonical/],
    [KIT_EVENT_BUS, 'if (sub.admission) admit(sub, event, msg.content);', '', /must run `admission` before provenance/],
  ];
  for (const [rel, from, to, expected] of mutations) assert.match(auditAdmissionProblems(mutate(rel, from, to)).join('\n'), expected, `${rel}: ${from}`);
  // admission moved AFTER provenance in the kit bus is refused too
  const bus = files[KIT_EVENT_BUS];
  const admitLine = '      if (sub.admission) admit(sub, event, msg.content);\n';
  assert.ok(bus.includes(admitLine));
  const moved = bus.replace(admitLine, '').replace('      handlerStarted = performance.now();', `${admitLine}      handlerStarted = performance.now();`);
  assert.match(auditAdmissionProblems({ ...files, [KIT_EVENT_BUS]: moved }).join(), /must run `admission` before provenance/);
});

test('S1b-3: Notification keeps event provenance only as a KEYED commitment; Billing and Audit stay unkeyed; every regression is refused', async () => {
  const { AUDIT_ADMISSION_FILES, KIT_EVENT_BUS, KIT_PROVENANCE, NOTIFICATION_KEYED_FILES, checkEventProvenanceOptIn, keyedCommitmentProblems } = await import('./lib/checks.mjs');
  const root = new URL('..', import.meta.url).pathname;
  const read = (rel) => readFileSync(join(root, rel), 'utf8');
  const files = Object.fromEntries([...Object.values(AUDIT_ADMISSION_FILES), ...Object.values(NOTIFICATION_KEYED_FILES), KIT_EVENT_BUS, KIT_PROVENANCE].map((rel) => [rel, read(rel)]));
  const notificationSources = { [NOTIFICATION_KEYED_FILES.consumer]: files[NOTIFICATION_KEYED_FILES.consumer], [NOTIFICATION_KEYED_FILES.config]: files[NOTIFICATION_KEYED_FILES.config] };
  const billingConsumer = 'apps/billing-service/src/payment-integration/payment-event-consumer.ts';
  const sources = {
    'notification-service': notificationSources,
    'billing-service': { [billingConsumer]: read(billingConsumer) },
    'audit-service': { [AUDIT_ADMISSION_FILES.consumer]: files[AUDIT_ADMISSION_FILES.consumer] },
  };
  const contracts = Object.fromEntries(['billing-service', 'payment-service', 'auth-service', 'notification-service'].map((app) => [app, read(`apps/${app}/contracts/events.json`)]));
  assert.deepEqual(keyedCommitmentProblems(files, notificationSources), []); // the repository as it stands
  assert.deepEqual(checkEventProvenanceOptIn(contracts, sources, files), []);
  const mutate = (rel, from, to) => {
    assert.ok(files[rel].includes(from), `${rel} no longer contains ${from}`);
    return { ...files, [rel]: files[rel].replace(from, to) };
  };
  const keyedMutations = [
    [NOTIFICATION_KEYED_FILES.consumer, 'keyedStore: new PgKeyedProvenanceStore(this.db, keys)', 'store: new PgProvenanceStore(this.db)', /must pass `provenance: \{ ownerOf: intakeEventOwner, keyedStore/],
    [NOTIFICATION_KEYED_FILES.consumer, "if (!this.config.provenanceKeys) return 'intake:provenance_keys_missing';", '', /must refuse to start without the provenance key ring/],
    [NOTIFICATION_KEYED_FILES.consumer, "if (!keys) throw new Error('intake:provenance_keys_missing');", '', /must refuse to start without the provenance key ring/],
    [NOTIFICATION_KEYED_FILES.config, "readOptionalKeyEntries(reader, 'NOTIFICATION_PROVENANCE_KEYS'", "readOptionalKeyEntries(reader, 'NOTIFICATION_SECRET_KEYS'", /must read the dedicated NOTIFICATION_PROVENANCE_KEYS ring/],
    [NOTIFICATION_KEYED_FILES.config, "['NOTIFICATION_PROVENANCE_KEYS', k] as const", "['NOTIFICATION_OTHER', k] as const", /keep it distinct from every other key/],
    [NOTIFICATION_KEYED_FILES.migration, '"bodyMac"               text NOT NULL,', '"bodyMac"               text NOT NULL,\n  "bodySha256" text,', /no unkeyed body digest/],
    [KIT_PROVENANCE, 'if (mac === undefined) macs.set(keyId, (mac = bodyMac(key, body)));', "if (mac === undefined) macs.set(keyId, (mac = createHash('sha256').update(body).digest('hex')));", /`PgKeyedProvenanceStore` must exist and never compute an unkeyed digest/],
    [KIT_EVENT_BUS, 'await p.keyedStore.record(sub.queue, { ...o, body: Buffer.from(msg.content) })', 'await p.keyedStore.record(sub.queue, { ...o, bodySha256: bodySha256(msg.content), body: Buffer.from(msg.content) })', /must give a keyed store the facts and the raw bytes only/],
  ];
  for (const [rel, from, to, expected] of keyedMutations) {
    const mutated = mutate(rel, from, to);
    const src = Object.fromEntries(Object.keys(notificationSources).map((k) => [k, mutated[k]]));
    assert.match(keyedCommitmentProblems(mutated, src).join('\n'), expected, `${rel}: ${from}`);
  }
  // an unkeyed digest anywhere in Notification's source is refused, even outside the fixed files
  assert.match(keyedCommitmentProblems(files, { ...notificationSources, 'apps/notification-service/src/x.ts': "import { bodySha256 } from '@nawara/service-kit';" }).join(), /names an unkeyed body digest/);
  // Billing or Audit switched to the keyed store (or off the unkeyed one) is a reviewed change, refused here
  for (const [app, rel] of [['billing-service', billingConsumer], ['audit-service', AUDIT_ADMISSION_FILES.consumer]]) {
    const text = sources[app][rel];
    const switched = text.replace('store: new PgProvenanceStore(this.db)', 'keyedStore: new PgKeyedProvenanceStore(this.db, ring)');
    assert.notEqual(switched, text, `${rel} no longer uses the unkeyed store`);
    const changedFiles = rel in files ? { ...files, [rel]: switched } : files;
    assert.match(checkEventProvenanceOptIn(contracts, { ...sources, [app]: { [rel]: switched } }, changedFiles).join('\n'), new RegExp(`apps/${app}: its event provenance must stay on the unkeyed store`));
  }
});

test('S1c-1: the replay classification stays OBSERVE-ONLY and keyed for Notification; the evidence comparison is recorded; every regression is refused', async () => {
  const { AUDIT_ADMISSION_FILES, KIT_EVENT_BUS, KIT_PROVENANCE, NOTIFICATION_KEYED_FILES, keyedCommitmentProblems } = await import('./lib/checks.mjs');
  const root = new URL('..', import.meta.url).pathname;
  const files = Object.fromEntries([...Object.values(AUDIT_ADMISSION_FILES), ...Object.values(NOTIFICATION_KEYED_FILES), KIT_EVENT_BUS, KIT_PROVENANCE].map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
  const sources = { [NOTIFICATION_KEYED_FILES.consumer]: files[NOTIFICATION_KEYED_FILES.consumer], [NOTIFICATION_KEYED_FILES.config]: files[NOTIFICATION_KEYED_FILES.config] };
  assert.deepEqual(keyedCommitmentProblems(files, sources), []);
  const mutate = (rel, from, to) => {
    assert.ok(files[rel].includes(from), `${rel} no longer contains ${from}`);
    return { ...files, [rel]: files[rel].replace(from, to) };
  };
  const mutations = [
    [KIT_EVENT_BUS, "if (msg.fields.exchange === '') await this.classifyReplay(msg, sub, who);\n        return true;", "if (msg.fields.exchange === '') await this.classifyReplay(msg, sub, who);\n        return false;", /must stay observe-only/],
    [KIT_EVENT_BUS, "    this.observe({ type: 'replay', queue: sub.queue, outcome: result.outcome, original: result.original });", "    this.observe({ type: 'replay', queue: sub.queue, outcome: result.outcome, original: result.original });\n    if (result.outcome === 'replay_mismatch') this.settle(() => ch.nack(msg, false, false), sub);", /must stay observe-only/],
    [KIT_EVENT_BUS, "    this.observe({ type: 'replay', queue: sub.queue, outcome: result.outcome, original: result.original });", "    this.observe({ type: 'replay', queue: sub.queue, outcome: result.outcome, original: result.original });\n    if (result.outcome === 'replay_no_provenance') throw new Error('refused');", /must stay observe-only/],
    [KIT_EVENT_BUS, 'p.keyedStore.classifyReplay!(sub.queue, { ...candidate, body: Buffer.from(msg.content) })', 'p.keyedStore.classifyReplay!(sub.queue, { ...candidate, bodySha256: bodySha256(msg.content), body: Buffer.from(msg.content) })', /give a keyed store the raw bytes only/],
    [NOTIFICATION_KEYED_FILES.comparisonMigration, "comparison IN ('differs', 'unverifiable')", "comparison IN ('differs', 'unverifiable', 'equal')", /must record the evidence `comparison`/],
    [NOTIFICATION_KEYED_FILES.comparisonMigration, 'ALTER TABLE event_provenance_conflict ADD COLUMN comparison text;', 'ALTER TABLE event_provenance_conflict ADD COLUMN comparison text;\nALTER TABLE event_provenance_conflict ADD COLUMN "bodySha256" text;', /no unkeyed body digest/],
  ];
  for (const [rel, from, to, expected] of mutations) assert.match(keyedCommitmentProblems(mutate(rel, from, to), sources).join('\n'), expected, `${rel}: ${from}`);
});

test('Core V2 S1c-3 R1: producer re-emission stays the restricted S0-C4 foundation', async () => {
  const { checkEventReemission, KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS, KIT_OUTBOX_RELAY, KIT_PACKAGE, REEMISSION_INTEGRATED_SERVICES } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const contracts = {};
  for (const app of ['payment-service', 'auth-service', 'notification-service', 'billing-service']) contracts[app] = read(`apps/${app}/contracts/events.json`);
  const files = Object.fromEntries([KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS, KIT_OUTBOX_RELAY, KIT_PACKAGE].map((rel) => [rel, read(rel)]));
  assert.deepEqual(checkEventReemission(contracts, files), []);
  assert.deepEqual(REEMISSION_INTEGRATED_SERVICES, []); // R1 activates no producer
  const withFile = (rel, from, to) => {
    assert.ok(files[rel].includes(from), `fixture drifted: ${from}`);
    return { ...files, [rel]: files[rel].replace(from, to) };
  };
  const cases = [
    ['a widened approval', withFile(KIT_REEMISSION, "Object.freeze({ name: 'payment.expired', version: 1 }),", "Object.freeze({ name: 'payment.expired', version: 1 }),\n    Object.freeze({ name: 'payment.created', version: 1 }),"), /REEMISSION_APPROVALS must be exactly/],
    ['a wildcard approval', withFile(KIT_REEMISSION, "name: 'payment.expired'", "name: 'payment.*'"), /REEMISSION_APPROVALS must be exactly/],
    ['another version', withFile(KIT_REEMISSION, "name: 'payment.failed', version: 1", "name: 'payment.failed', version: 2"), /REEMISSION_APPROVALS must be exactly/],
    ['a code-bearing event dropped from the denylist', withFile(KIT_REEMISSION, "  'admin.operator_code_issued',\n", ''), /CODE_BEARING_EVENTS must name the code-bearing admin\.operator_code_issued/],
    ['a relay with its own envelope', withFile(KIT_OUTBOX_RELAY, 'outboxEnvelope(r, this.opts.source)', '{ id: r.id } as never'), /the relay must build its envelopes/],
    ['an ordinary publish with mandatory', withFile(KIT_EVENT_BUS, 'ch.publish(this.exchange, message.routingKey, message.content, message.options);', 'ch.publish(this.exchange, message.routingKey, message.content, { ...message.options, mandatory: true });'), /`publish` must build its message/],
    ['a second serializer in the bus', withFile(KIT_EVENT_BUS, 'const message = eventMessage(event, userId);', 'const message = { ...eventMessage(event, userId), content: Buffer.from(JSON.stringify(event.payload)) };'), /serializes a payload itself/],
    ['a re-emission without the identity check', withFile(KIT_EVENT_BUS, 'event.headers.source !== this.publisherUserId || ', ''), /`publishReemission` must consume an issued plan/],
    ['a re-emission to the default exchange', withFile(KIT_EVENT_BUS, 'ch.publish(this.exchange, message.routingKey, message.content, { ...message.options, mandatory: true }', "ch.sendToQueue('q', message.content, { ...message.options, mandatory: true }"), /`publishReemission` must consume an issued plan/],
    ['publication before the durable intent', withFile(KIT_REEMISSION, '      receipt = await this.opts.attempts.commitIntent(intent);', '      await this.opts.publisher.publishReemission(plan as never);\n      receipt = await this.opts.attempts.commitIntent(intent);'), /`reemit` must check the request/],
    ['a re-emission command', withFile(KIT_PACKAGE, '"nawara-migrate":', '"nawara-reemit": "./dist/cli/reemit.js",\n    "nawara-migrate":'), /no kit command re-emits/],
  ];
  for (const [title, mutated, expected] of cases) assert.match(checkEventReemission(contracts, mutated).join('\n'), expected, title);
  // an approval its producer's contract does not declare
  const contract = JSON.parse(contracts['payment-service']);
  contract.produces = contract.produces.filter((e) => e.name !== 'payment.expired');
  assert.match(checkEventReemission({ ...contracts, 'payment-service': JSON.stringify(contract) }, files).join(), /re-emission approval payment\.expired@1 must be an event payment-service produces/);
  // a newly code-bearing contract event the denylist does not name
  const auth = JSON.parse(contracts['auth-service']);
  auth.produces.push({ name: 'member.recovery_code_issued', version: 1, codeBearing: true, payload: {} });
  assert.match(checkEventReemission({ ...contracts, 'auth-service': JSON.stringify(auth) }, files).join(), /CODE_BEARING_EVENTS must name the code-bearing member\.recovery_code_issued/);
  // no application (and no kit CLI) uses the foundation before its integration is reviewed
  for (const [owner, rel] of [['billing-service', 'apps/billing-service/src/recovery.ts'], ['auth-service', 'apps/auth-service/src/recovery.ts'], ['libs/service-kit/src/cli', 'libs/service-kit/src/cli/reemit.ts']]) {
    assert.match(checkEventReemission(contracts, files, { [owner]: { [rel]: 'new ProducerReemission({ policy })' } }).join(), /is not on REEMISSION_INTEGRATED_SERVICES/);
  }
});

test('Core V2 S1c-3 R2a: payment-service is eligibility-only (read-only inspection; no publishing, authorizing or recording machinery)', async () => {
  const { checkEventReemission, KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS, KIT_OUTBOX_RELAY, KIT_PACKAGE, REEMISSION_INTEGRATED_SERVICES, REEMISSION_ELIGIBILITY_ONLY_SERVICES } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const contracts = {};
  for (const app of ['payment-service', 'auth-service', 'notification-service', 'billing-service']) contracts[app] = read(`apps/${app}/contracts/events.json`);
  const files = Object.fromEntries([KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS, KIT_OUTBOX_RELAY, KIT_PACKAGE].map((rel) => [rel, read(rel)]));
  const eligibility = 'apps/payment-service/src/reemission/reemission-eligibility.ts';
  const cli = 'apps/payment-service/src/cli/reemission-dry-run.ts';
  const payment = { [eligibility]: read(eligibility), [cli]: read(cli) };
  assert.deepEqual(REEMISSION_INTEGRATED_SERVICES, []);
  assert.deepEqual(REEMISSION_ELIGIBILITY_ONLY_SERVICES, ['payment-service']);
  assert.deepEqual(checkEventReemission(contracts, files, { 'payment-service': payment }), []); // the read-only parts are allowed
  const mutate = (rel, from, to) => {
    assert.ok(payment[rel].includes(from), `fixture drifted: ${from}`);
    return { ...payment, [rel]: payment[rel].replace(from, to) };
  };
  const added = (text) => ({ ...payment, 'apps/payment-service/src/reemission/recover.ts': text });
  const cases = [
    ['constructing the publisher', added("import { ProducerReemission } from '@nawara/service-kit';\nnew ProducerReemission(opts);"), /names the re-emission publishing/],
    ['calling publishReemission', added('await bus.publishReemission(plan);'), /names the re-emission publishing/],
    ['an always-denying authorizer around the publisher', added('const authorizer: ReemissionAuthorizer = { verify: async () => { throw new Error(); } };'), /names the re-emission publishing/],
    ['an attempt writer', added('await attempts.commitIntent(intent);'), /names the re-emission publishing/],
    ['a claimed audit intent', added('return { attemptId, intentCommitted: true, auditIntentRecorded: true };'), /names the re-emission publishing/],
    ['an uncataloged audit action', added("await writer.write(q, { action: 'payment.event_reemitted' });"), /names the re-emission publishing/],
    ['a broker connection in the dry run', mutate(cli, "import { ConfigError, DbService, EnvReader } from '@nawara/service-kit';", "import { ConfigError, DbService, EnvReader, RabbitMqEventBus } from '@nawara/service-kit';"), /imports no broker, outbox or audit writer and writes no SQL/],
    ['a write in the dry run', mutate(eligibility, 'return { mode:', "await q.query('INSERT INTO payment_reemission_attempt VALUES (1)');\n  return { mode:"), /imports no broker, outbox or audit writer and writes no SQL/],
    ['an unapproved event in the policy', mutate(eligibility, "{ name: 'payment.expired', version: 1 },", "{ name: 'payment.expired', version: 1 },\n  { name: 'payment.created', version: 1 },"), /re-emission policy must list only its S0-C4 approvals/],
    ['a wildcard policy', mutate(eligibility, "{ name: 'payment.expired', version: 1 },", "{ name: 'payment.*', version: 1 },"), /re-emission policy must list only its S0-C4 approvals/],
    ['another version', mutate(eligibility, "{ name: 'payment.failed', version: 1 },", "{ name: 'payment.failed', version: 2 },"), /re-emission policy must list only its S0-C4 approvals/],
  ];
  for (const [title, sources, expected] of cases) assert.match(checkEventReemission(contracts, files, { 'payment-service': sources }).join('\n'), expected, title);
  // the read-only inspection stays forbidden for every other service, and code-bearing Auth recovery stays impossible
  assert.match(checkEventReemission(contracts, files, { 'auth-service': { 'apps/auth-service/src/r.ts': "inspectReemissionEligibility(opts, { eventId, eventName: 'admin.operator_code_issued' })" } }).join(), /auth-service is not on REEMISSION_INTEGRATED_SERVICES/);
  assert.match(checkEventReemission(contracts, files, { 'billing-service': { 'apps/billing-service/src/r.ts': 'migrationOwnership(files)' } }).join(), /billing-service is not on REEMISSION_INTEGRATED_SERVICES/);
});

// ─────────────────────────────────────────────────────────────── Core V2 S1d-1: the catalog-driven topic permission generator
{
  const tp = await import('./lib/topic-permissions.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const APPS = readdirSync(new URL('../apps/', import.meta.url));
  const CONTRACTS = Object.fromEntries(APPS.flatMap((a) => {
    try {
      return [[a, read(`apps/${a}/contracts/events.json`)]];
    } catch {
      return [];
    }
  }));
  const CATALOG = read('libs/audit-contract/src/catalog.ts');
  const manifest = (domainEvents = { 'auth-service': 'inactive', 'billing-service': 'active', 'payment-service': 'active' }) => ({ environment: 'test', domainEvents });
  const gen = (over = {}) => tp.generateTopicPermissions({ contracts: CONTRACTS, auditCatalog: CATALOG, apps: APPS, activation: manifest(), ...over });
  const refused = (over, pattern, title) => assert.throws(() => gen(over), (e) => e instanceof tp.TopicPermissionError && pattern.test(e.message), title);
  const contract = (app) => JSON.parse(CONTRACTS[app]);
  const withContract = (app, c) => ({ ...CONTRACTS, [app]: JSON.stringify(c) });
  const auditOf = (out, s) => out.identities[s].write.keys.filter((k) => k.startsWith('audit.'));
  const matches = (regex, key) => new RegExp(regex).test(key);

  test('S1d-1 determinism: the same sources and manifest give identical output, whatever the input order', () => {
    const a = gen();
    assert.deepEqual(gen(), a);
    const reordered = gen({ contracts: Object.fromEntries(Object.entries(CONTRACTS).reverse()), apps: [...APPS].reverse(),
      activation: manifest({ 'payment-service': 'active', 'billing-service': 'active', 'auth-service': 'inactive' }) });
    assert.equal(JSON.stringify(reordered), JSON.stringify(a));
    const shuffled = CATALOG.replace("  'file.deleted': {", "  'zz.reordered_marker': { producer: 'file-service' },\n  'file.deleted': {");
    assert.deepEqual(gen({ auditCatalog: shuffled }).identities['file-service'].write.keys, ['audit.file.deleted', 'audit.file.integrity_incident', 'audit.zz.reordered_marker']);
    for (const id of Object.values(a.identities)) for (const g of [id.write, id.read]) assert.deepEqual(g.keys, [...g.keys].sort());
  });

  test('S1d-1 ownership: each producer gets exactly its own domain events and audit actions, and nothing of anyone else', () => {
    const out = gen();
    const catalog = tp.parseAuditCatalog(CATALOG);
    for (const [service, id] of Object.entries(out.identities)) {
      const ownAudit = catalog.actions.filter((a) => a.producer === service && !tp.LOCAL_AUDIT_PRODUCERS.includes(service)).map((a) => `audit.${a.action}`).sort();
      assert.deepEqual(auditOf(out, service), ownAudit, `${service} audit actions`);
      const domain = id.write.keys.filter((k) => !k.startsWith('audit.'));
      assert.deepEqual(domain, id.domainEvents === 'active' ? contract(service).produces.map((e) => e.name).sort() : [], `${service} domain events`);
      for (const k of id.write.keys) for (const [other, o] of Object.entries(out.identities)) if (other !== service) assert.ok(!o.write.keys.includes(k), `${k} granted to ${service} and ${other}`);
    }
    // the investigation's counts
    const counts = Object.fromEntries(Object.entries(out.identities).map(([s, id]) => [s, [id.write.keys.length, id.read.keys.length]]));
    // auth-service: 28 + the three authorization receipt actions (Core V2 S2-Audit.2, D1)
    assert.deepEqual(counts, { 'audit-service': [0, 1], 'auth-service': [31, 0], 'billing-service': [12, 4], 'file-service': [2, 0], 'notification-service': [0, 9], 'organization-service': [7, 0], 'payment-service': [10, 0], 'release-service': [4, 0] });
  });

  test('S1d-1 Payment: its five ordinary events and five audit actions; not the re-emission allow-list; no unregistered action', () => {
    const p = gen().identities['payment-service'];
    assert.deepEqual(p.write.keys, ['audit.payment.cancelled', 'audit.payment.created', 'audit.payment.expired', 'audit.payment.failed', 'audit.payment.succeeded',
      'payment.cancelled', 'payment.created', 'payment.expired', 'payment.failed', 'payment.succeeded']);
    assert.ok(p.write.keys.includes('payment.created')); // the producer catalog, not the S0-C4 re-emission allow-list
    assert.ok(!p.write.keys.some((k) => /reemit/.test(k)));
    assert.deepEqual(p.read, { keys: [], regex: tp.DENY_ALL }); // producer only
    assert.ok(!matches(p.write.regex, 'payment.refunded') && !matches(p.write.regex, 'audit.payment.event_reemitted'));
  });

  test('S1d-1 Billing: one identity, its own writes and exactly the four Payment events it binds', () => {
    const b = gen().identities['billing-service'];
    assert.deepEqual(b.read.keys, ['payment.cancelled', 'payment.expired', 'payment.failed', 'payment.succeeded']);
    assert.ok(b.write.keys.includes('invoice.created') && !b.write.keys.some((k) => k.startsWith('payment.') || k.startsWith('billing.') || k.startsWith('refund.')));
    assert.ok(!b.read.keys.includes('payment.created'));
    for (const other of ['payment-service', 'notification-service', 'auth-service']) assert.ok(!gen().identities[other].read.keys.some((k) => b.read.keys.includes(k)));
  });

  test('S1d-1 consumers: Notification binds its nine names; Audit only its documented `audit.#` binding; neither publishes', () => {
    const out = gen();
    const n = out.identities['notification-service'];
    assert.deepEqual(n.read.keys, contract('notification-service').consumes.map((e) => e.name).sort());
    assert.equal(n.read.keys.length, 9);
    assert.equal(n.write.regex, tp.DENY_ALL);
    const a = out.identities['audit-service'];
    assert.deepEqual(a.read, { keys: ['audit.#'], regex: '^(audit\\.#)$', bindingException: 'audit-all-actions' });
    assert.ok(matches(a.read.regex, 'audit.#') && !matches(a.read.regex, '#') && !matches(a.read.regex, 'payment.#') && !matches(a.read.regex, 'audit.#.x'));
    assert.equal(a.write.regex, tp.DENY_ALL); // its own action is recorded locally, never published
    // + the legal-hold records of Core V2 S2-Audit.4: written locally by audit-service, never published
    assert.deepEqual(a.localOnlyAuditActions, ['audit.audit_legal_hold.placed', 'audit.audit_legal_hold.released', 'audit.platform_query.executed']);
  });

  test('S1d-1 activation: Auth domain events only when explicitly active; unknown, missing or extra declarations fail closed', () => {
    const inactive = gen().identities['auth-service'];
    assert.equal(inactive.domainEvents, 'inactive');
    assert.equal(inactive.deniedInactive.length, 12);
    assert.ok(inactive.deniedInactive.includes('member.contact_verification_requested'));
    assert.ok(inactive.write.keys.every((k) => k.startsWith('audit.')));
    const active = gen({ activation: manifest({ 'auth-service': 'active', 'billing-service': 'active', 'payment-service': 'active' }) }).identities['auth-service'];
    assert.equal(active.write.keys.length, 43); // 31 audit actions (S2-Audit.2: +3) + 12 domain events
    assert.ok(matches(active.write.regex, 'admin.operator_code_issued'));
    refused({ activation: undefined }, /an activation manifest is required/, 'no manifest');
    refused({ activation: manifest({ 'billing-service': 'active', 'payment-service': 'active' }) }, /does not declare auth-service/, 'missing producer');
    refused({ activation: manifest({ 'auth-service': 'on', 'billing-service': 'active', 'payment-service': 'active' }) }, /must be active or inactive/, 'unknown state');
    refused({ activation: manifest({ 'auth-service': 'inactive', 'billing-service': 'active', 'payment-service': 'active', 'file-service': 'active' }) }, /declares file-service, which declares no domain event/, 'undeclared family');
    refused({ activation: { environment: 'test', domainEvents: {}, defaults: 'active' } }, /exactly `environment` and `domainEvents`/, 'extra field');
    refused({ activation: { domainEvents: manifest().domainEvents } }, /exactly `environment` and `domainEvents`/, 'no environment');
    // the code-bearing names stay Auth's even while inactive: nobody else may declare them
    const c = contract('billing-service');
    c.produces.push({ name: 'member.contact_verification_requested', version: 1, payload: {} });
    refused({ contracts: withContract('billing-service', c) }, /two owners/, 'a code-bearing name claimed by another producer');
  });

  test('S1d-1 regex security: exact, anchored, escaped; no prefix, suffix or wildcard widening; an empty set denies all', () => {
    const r = tp.exactKeyRegex(['payment.created', 'audit.payment.created']);
    assert.equal(r, '^(audit\\.payment\\.created|payment\\.created)$');
    for (const ok of ['payment.created', 'audit.payment.created']) assert.ok(matches(r, ok));
    for (const no of ['payment.created.x', 'x.payment.created', 'paymentXcreated', 'payment.createdd', 'payment.', 'payment.#', 'payment.*', '', 'audit.payment.created\n']) assert.ok(!matches(r, no), no);
    assert.equal(tp.escapeRegex('a.b*c+d?e^f$g(h)i[j]k{l}m|n\\o'), 'a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\[j\\]k\\{l\\}m\\|n\\\\o');
    assert.ok(!matches(tp.exactKeyRegex(['a.(b|c)']), 'a.b')); // metacharacters stay literal
    assert.equal(tp.exactKeyRegex([]), tp.DENY_ALL);
    for (const k of ['', 'payment.created', 'audit.x', '#', '.*', '\n']) assert.ok(!matches(tp.DENY_ALL, k), `DENY_ALL matched ${JSON.stringify(k)}`);
    // no grant anywhere is a wildcard, a prefix or a bare `^$`
    for (const id of Object.values(gen().identities)) for (const g of [id.write, id.read]) {
      assert.ok(g.regex === tp.DENY_ALL || /^\^\(.+\)\$$/.test(g.regex), g.regex);
      assert.ok(!/\.\*|\\\.\$|^\^\$$/.test(g.regex) && g.regex !== '' && g.regex !== '.*', g.regex);
    }
  });

  test('S1d-1 contract changes: a new event or action reaches only its owner; removal drops it; unowned or contradictory input fails closed', () => {
    const c = contract('payment-service');
    c.produces.push({ name: 'payment.disputed', version: 1, payload: {} });
    const added = gen({ contracts: withContract('payment-service', c) });
    assert.ok(added.identities['payment-service'].write.keys.includes('payment.disputed'));
    assert.ok(!Object.entries(added.identities).some(([s, id]) => s !== 'payment-service' && id.write.keys.includes('payment.disputed')));
    const action = CATALOG.replace("  'file.deleted': {", "  'file.archived': { producer: 'file-service' },\n  'file.deleted': {");
    const withAction = gen({ auditCatalog: action });
    assert.ok(withAction.identities['file-service'].write.keys.includes('audit.file.archived'));
    assert.ok(!Object.entries(withAction.identities).some(([s, id]) => s !== 'file-service' && id.write.keys.includes('audit.file.archived')));
    const removed = contract('billing-service');
    removed.produces = [];
    assert.ok(!gen({ contracts: withContract('billing-service', removed), activation: manifest({ 'auth-service': 'inactive', 'payment-service': 'active' }) }).identities['billing-service'].write.keys.includes('invoice.created'));
    // unowned / contradictory / invalid sources
    refused({ auditCatalog: CATALOG.replace("producer: 'file-service', category: 'business'", "producer: 'nobody-service', category: 'business'") }, /unknown producer nobody-service/, 'unknown audit producer');
    refused({ auditCatalog: CATALOG.replace("producer: 'file-service', category: 'business'", "category: 'business'") }, /has no literal producer/, 'missing audit ownership');
    refused({ auditCatalog: CATALOG.replace("  'file.deleted': {", "  'File Deleted!': { producer: 'file-service' },\n  'file.deleted': {") }, /not a valid name/, 'invalid action');
    refused({ auditCatalog: CATALOG.replace("  'file.deleted': {", "  ...EXTRA,\n  'file.deleted': {") }, /literal '<action>'/, 'a spread in the catalog');
    const dup = contract('payment-service');
    dup.produces.push({ ...dup.produces[0] });
    refused({ contracts: withContract('payment-service', dup) }, /declared twice/, 'a duplicate event');
    const foreign = contract('billing-service');
    foreign.produces.push({ name: 'payment.created', version: 1, payload: {} });
    refused({ contracts: withContract('billing-service', foreign) }, /two owners/, 'another producer\'s domain event');
    const auditName = contract('payment-service');
    auditName.produces.push({ name: 'audit.billing.invoice_issued', version: 1, payload: {} });
    refused({ contracts: withContract('payment-service', auditName) }, /audit\.\* keys belong to the audit catalog only/, 'a domain event in the audit namespace');
    const wildcard = contract('payment-service');
    wildcard.produces.push({ name: 'payment.*', version: 1, payload: {} });
    refused({ contracts: withContract('payment-service', wildcard) }, /produces an invalid event/, 'a wildcard event');
    const prefix = contract('payment-service');
    prefix.produces.push({ name: 'payment', version: 1, payload: {} });
    refused({ contracts: withContract('payment-service', prefix) }, /produces an invalid event/, 'a prefix event');
    const meta = contract('payment-service');
    meta.produces.push({ name: 'payment.(created|x)', version: 1, payload: {} });
    refused({ contracts: withContract('payment-service', meta) }, /produces an invalid event/, 'regex metacharacters');
    const consumesUnknown = contract('billing-service');
    consumesUnknown.consumes.push({ source: 'payment-service', name: 'payment.refunded', version: 1, requires: {} });
    refused({ contracts: withContract('billing-service', consumesUnknown) }, /does not declare/, 'consuming an undeclared event');
    const wrongService = contract('billing-service');
    wrongService.service = 'payment-service';
    refused({ contracts: withContract('billing-service', wrongService) }, /must name its own service/, 'a contract for another service');
    refused({ contracts: { ...CONTRACTS, 'ghost-service': CONTRACTS['payment-service'] } }, /unknown application ghost-service/, 'an unknown service');
    refused({ apps: [] }, /application list is empty/, 'no applications');
  });

  test('S1d-1 check:repo: the current sources pass; a broken binding exception, an Audit publisher or an invalid catalog are reported', () => {
    const base = { contracts: CONTRACTS, apps: APPS, auditCatalog: CATALOG, files: { [tp.AUDIT_BINDINGS_FILE]: read(tp.AUDIT_BINDINGS_FILE) }, auditSources: {} };
    assert.deepEqual(tp.checkTopicPermissionSources(base), []);
    assert.match(tp.checkTopicPermissionSources({ ...base, files: { [tp.AUDIT_BINDINGS_FILE]: read(tp.AUDIT_BINDINGS_FILE).replace("['audit.#']", "['#']") } }).join(), /documented read exception/);
    assert.match(tp.checkTopicPermissionSources({ ...base, auditSources: { 'apps/audit-service/src/x.ts': 'EventsModule.forRoot({})' } }).join(), /local-only/);
    assert.match(tp.checkTopicPermissionSources({ ...base, auditCatalog: CATALOG.replace("producer: 'file-service', category: 'business'", "category: 'business'") }).join(), /no literal producer/);
    // it never reads provision.sh: its old broad grants do not fail it
    assert.ok(!/provision\.sh/.test(tp.checkTopicPermissionSources.toString().replace(/\/\/.*$/gm, '')));
  });
}

// ─────────────────────────────────────────────────────────────── Core V2 S1d-2: provision.sh carries exactly the generated grants
{
  const tp = await import('./lib/topic-permissions.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const APPS = readdirSync(new URL('../apps/', import.meta.url));
  const CONTRACTS = Object.fromEntries(APPS.flatMap((a) => {
    try {
      return [[a, read(`apps/${a}/contracts/events.json`)]];
    } catch {
      return [];
    }
  }));
  const base = { contracts: CONTRACTS, apps: APPS, auditCatalog: read('libs/audit-contract/src/catalog.ts'), provision: read(tp.PROVISION_FILE), activation: read(tp.ACTIVATION_FILE) };
  const check = (over = {}) => tp.checkProvisionTopicGrants({ ...base, ...over }).join('\n');
  const edit = (text, from, to) => {
    assert.ok(text.includes(from), `fixture drifted: ${from.slice(0, 80)}`);
    return text.split(from).join(to);
  };
  const regenerated = (over) => {
    const block = tp.renderProvisionTopicGrants(tp.generateTopicPermissions({ ...base, ...over, activation: JSON.parse(over.activation ?? base.activation) }));
    const current = tp.generatedBlockOf(base.provision);
    const at = base.provision.indexOf(current);
    return base.provision.slice(0, at) + block + base.provision.slice(at + current.length);
  };
  const authWrite = tp.generateTopicPermissions({ ...base, activation: JSON.parse(base.activation) }).identities['auth-service'].write.regex;

  test('S1d-2 the committed provisioning grants are exactly the generated ones; the activation file is the reviewed production state', () => {
    assert.equal(check(), '');
    assert.deepEqual(JSON.parse(base.activation), { environment: 'production', domainEvents: { 'auth-service': 'inactive', 'billing-service': 'active', 'payment-service': 'active' } });
    assert.match(base.provision, /^SERVICES="\$\{RABBITMQ_SERVICES:-audit-service auth-service\}"$/m, 'the default selection is unchanged');
  });

  test('S1d-2 drift: any edit of the generated block is refused (widening, removal, extra identity, altered key, wildcard)', () => {
    const stale = /generated topic grants are stale or edited/;
    assert.match(check({ provision: edit(base.provision, `TOPIC_WRITE='${authWrite}'`, "TOPIC_WRITE='^audit\\.'") }), stale, 'a broad prefix');
    assert.match(check({ provision: edit(base.provision, `TOPIC_WRITE='${authWrite}'`, "TOPIC_WRITE='.*'") }), stale, 'a wildcard');
    assert.match(check({ provision: edit(base.provision, 'audit\\.account\\.disabled|', '') }), stale, 'a removed key');
    assert.match(check({ provision: edit(base.provision, 'audit\\.account\\.disabled|', 'audit\\.account\\.deleted|') }), stale, 'an altered key');
    assert.match(check({ provision: edit(base.provision, "TOPIC_READ='^(payment\\.cancelled|", "TOPIC_READ='^(payment\\.created|payment\\.cancelled|") }), stale, 'Billing reading payment.created');
    assert.match(check({ provision: edit(base.provision, "    *) return 1 ;;\n  esac\n}\n# END GENERATED", "    ghost-service)\n      TOPIC_WRITE='.*'\n      TOPIC_READ='.*' ;;\n    *) return 1 ;;\n  esac\n}\n# END GENERATED") }), stale, 'an extra identity');
    assert.match(check({ provision: edit(base.provision, '# END GENERATED TOPIC GRANTS\n', '') }), /block .* is missing or malformed/, 'missing markers');
  });

  test('S1d-2 drift: a source or activation change without a regenerated block is refused, and regenerating resolves it (one direction only)', () => {
    const stale = /generated topic grants are stale or edited/;
    const auditActive = JSON.stringify({ environment: 'production', domainEvents: { 'auth-service': 'active', 'billing-service': 'active', 'payment-service': 'active' } });
    assert.match(check({ activation: auditActive }), stale, 'Auth activated without regenerating');
    assert.equal(check({ activation: auditActive, provision: regenerated({ activation: auditActive }) }), '');
    const c = JSON.parse(CONTRACTS['payment-service']);
    c.produces.push({ name: 'payment.disputed', version: 1, payload: {} });
    const contracts = { ...CONTRACTS, 'payment-service': JSON.stringify(c) };
    assert.match(check({ contracts }), stale, 'a new event without a reviewed grant');
    assert.equal(check({ contracts, provision: regenerated({ contracts }) }), '');
    const moved = edit(base.auditCatalog, "producer: 'file-service', category: 'business'", "producer: 'release-service', category: 'business'");
    assert.match(check({ auditCatalog: moved }), stale, 'stale audit ownership');
  });

  test('S1d-2 no grant outside the generated block, no identity without generated grants, a fail-closed activation file', () => {
    assert.match(check({ provision: edit(base.provision, 'producer() { PERM_CONF=', "TOPIC_WRITE='^audit\\.'\nproducer() { PERM_CONF=") }), /a topic grant is set outside the generated block/);
    assert.match(check({ provision: edit(base.provision, '    *) return 1 ;;\n  esac\n  topic_grants_for', '    ghost-service) producer ;;\n    *) return 1 ;;\n  esac\n  topic_grants_for') }), /must be exactly those with generated topic grants/);
    assert.match(check({ provision: edit(base.provision, '  topic_grants_for "$1" || return 1\n', '  topic_grants_for "$1" || true\n') }), /must take the topic grants from topic_grants_for/);
    assert.match(check({ provision: base.provision + '\nctl set_topic_permissions -p "$VHOST" x nawara.events ".*" ".*"\n' }), /must be set once/);
    assert.match(check({ activation: JSON.stringify({ environment: 'staging', domainEvents: JSON.parse(base.activation).domainEvents }) }), /environment must be production/);
    assert.match(check({ activation: JSON.stringify({ environment: 'production', domainEvents: { 'auth-service': 'inactive', 'payment-service': 'active' } }) }), /does not declare billing-service/);
    assert.match(check({ activation: JSON.stringify({ environment: 'production', domainEvents: { ...JSON.parse(base.activation).domainEvents, 'auth-service': 'enabled' } }) }), /must be active or inactive/);
    assert.match(check({ activation: undefined }), /missing or not valid JSON/);
    assert.match(check({ provision: undefined }), /provision\.sh is missing/);
  });

  test('S1d-2 the rendered block is safe bash: single-quoted exact grants, refusing any other service, never a quote break-out', () => {
    const block = tp.generatedBlockOf(base.provision);
    assert.ok(block.split('\n').filter((l) => /TOPIC_(WRITE|READ)=/.test(l)).every((l) => /^ {6}TOPIC_(WRITE|READ)='(\^\(\?!\)\$|\^\([a-z0-9_\\.|#]+\)\$)'( ;;)?$/.test(l)));
    assert.match(block, /\n {4}\*\) return 1 ;;\n/);
    const out = tp.generateTopicPermissions({ ...base, activation: JSON.parse(base.activation) });
    out.identities['auth-service'].write.regex = "^(x')$";
    assert.throws(() => tp.renderProvisionTopicGrants(out), /cannot be quoted safely/);
  });
}

test('Core V2 S1e-1: only audit-service may use the compatibility phase; a consumer of code-bearing events never keeps a refused body', async () => {
  const { checkEnforcementPolicies } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const contracts = Object.fromEntries(['auth-service', 'billing-service', 'notification-service', 'payment-service'].map((a) => [a, read(`apps/${a}/contracts/events.json`)]));
  assert.deepEqual(checkEnforcementPolicies(contracts, {}), []);
  const src = (app, text) => ({ [app]: { [`apps/${app}/src/x.ts`]: text } });
  assert.deepEqual(checkEnforcementPolicies(contracts, src('audit-service', 'enforcement: auditCompatibilityEnforcement()')), []);
  for (const app of ['billing-service', 'notification-service', 'payment-service']) {
    assert.match(checkEnforcementPolicies(contracts, src(app, 'enforcement: auditCompatibilityEnforcement()')).join(), /only audit-service may use the compatibility phase/, app);
  }
  assert.match(checkEnforcementPolicies(contracts, src('notification-service', "strictEnforcement({ refusedBody: 'original_reviewed' })")).join(), /consumes a code-bearing event/);
  // (a one-line fixture: the S1e-4 Notification check below reports its missing consumer, not a code-bearing problem)
  assert.doesNotMatch(checkEnforcementPolicies(contracts, src('notification-service', "strictEnforcement({ refusedBody: 'dead_letter_policy' })")).join(), /consumes a code-bearing event/);
  // Payment events carry no code: Billing may keep a refused body (its real files, which the S1e-2 financial check also reads)
  const billing = Object.fromEntries(['apps/billing-service/src/payment-integration/payment-event-consumer.ts', 'apps/billing-service/src/payment-integration/payment-event-origin.ts'].map((rel) => [rel, read(rel)]));
  assert.deepEqual(checkEnforcementPolicies(contracts, { 'billing-service': billing }), []);
});

test('Core V2 S1e-4: Notification\'s intake is strict, redacts every code-bearing dead letter and runs only on the trusted envelope', async () => {
  const { checkEnforcementPolicies, STRICT_NOTIFICATION_CONSUMER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const contracts = Object.fromEntries(['auth-service', 'notification-service'].map((a) => [a, read(`apps/${a}/contracts/events.json`)]));
  const n = STRICT_NOTIFICATION_CONSUMER;
  const real = Object.fromEntries(Object.values(n).map((rel) => [rel, read(rel)]));
  assert.deepEqual(checkEnforcementPolicies(contracts, { 'notification-service': real }), []);
  const mutate = (rel, from, to) => {
    assert.ok(real[rel].includes(from), `fixture drifted: ${from}`);
    return { 'notification-service': { ...real, [rel]: real[rel].replace(from, to) } };
  };
  const mutations = [
    [n.consumer, '        enforcement: this.enforcement,\n', '', /must be strict/],
    [n.consumer, "strictEnforcement({ refusedBody: 'dead_letter_policy' })", "strictEnforcement({ refusedBody: 'original_reviewed' })", /consumes a code-bearing event/],
    [n.consumer, 'deadLetterPolicy: notificationDeadLetterPolicy,', '', /must pass `deadLetterPolicy: notificationDeadLetterPolicy`/],
    [n.consumer, 'handler: (e, trust) => this.handle(e, trust),', 'handler: (e) => this.handle(e, undefined),', /only on the trusted envelope/],
    [n.consumer, 'await this.intake.handle(trusted);', 'await this.intake.handle(event);', /only on the trusted envelope/],
    [n.deadLetterPolicy, 'CODE_BEARING_EVENTS.has(m.name)', 'false', /must redact every code-bearing event/],
    [n.deadLetterPolicy, '!isCanonicalJsonBody(body)', 'false', /must redact every code-bearing event/],
    [n.trustedEvent, 'delete headers.correlationId;', 'headers.correlationId = event.headers.correlationId;', /never take a delivery's own correlation header/],
  ];
  for (const [rel, from, to, expected] of mutations) assert.match(checkEnforcementPolicies(contracts, mutate(rel, from, to)).join('\n'), expected, `${rel}: ${from}`);
  assert.match(checkEnforcementPolicies(contracts, { 'notification-service': {} }).join(), /the Notification intake consumer was not found/);
});

test('Core V2 OD-BRK-1/2a: only Notification adopts the no-broker-dead-lettering option, and the kit\'s default topology is unchanged', async () => {
  const { checkBrokerDeadLettering, BROKER_DEAD_LETTERING_ADOPTERS, KIT_EVENT_BUS } = await import('./lib/checks.mjs');
  const bus = readFileSync(new URL(`../${KIT_EVENT_BUS}`, import.meta.url), 'utf8');
  assert.deepEqual(BROKER_DEAD_LETTERING_ADOPTERS, ['notification-service']); // OD-BRK-2a; Billing (OD-BRK-3) and Audit (OD-BRK-4) not yet
  assert.deepEqual(checkBrokerDeadLettering({}, bus), []);
  assert.deepEqual(checkBrokerDeadLettering({ 'notification-service': { 'apps/notification-service/src/x.ts': 'brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: \'external\' })' } }, bus), []);
  for (const [app, text] of [['billing-service', 'import { noBrokerDeadLettering } from \'@nawara/service-kit\';'], ['audit-service', 'brokerDeadLettering: opt,'], ['payment-service', 'brokerDeadLettering: noBrokerDeadLettering(x)']]) {
    assert.match(checkBrokerDeadLettering({ [app]: { [`apps/${app}/src/x.ts`]: text } }, bus).join(), /may not opt out of broker dead-lettering yet/, app);
  }
  const mutations = [
    ["      if (!isolated) await ch.assertExchange(dlx, 'fanout', { durable: true });", "      await ch.assertExchange(dlx, 'fanout', { durable: true });"],
    ["      if (!isolated) await ch.bindQueue(deadQueueName(sub.queue), dlx, '');", ''],
    ["isolated ? { durable: true } : { durable: true, arguments: { 'x-dead-letter-exchange': dlx } }", '{ durable: true }'],
    ["      if (!sub.brokerDeadLettering) await ch.bindQueue(deadQueueName(sub.queue), `${this.exchange}.dlx`, '');", ''],
    ['const isolated = sub.brokerDeadLettering !== undefined;', 'const isolated = true;'],
  ];
  for (const [from, to] of mutations) {
    assert.ok(bus.includes(from), `fixture drifted: ${from}`);
    assert.match(checkBrokerDeadLettering({}, bus.replace(from, to)).join(), /default topology .* must stay unchanged/, from);
  }
  assert.match(checkBrokerDeadLettering({}, undefined).join(), /default topology/);
});

test('Core V2 OD-BRK-2a: the embedded verifier equals its file; Notification is isolated and granted only behind the pre/post-grant gate', async () => {
  const { checkNotificationTopologyGate, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const provision = read(PROVISION_SCRIPT);
  const verifier = read(TOPOLOGY_VERIFIER);
  assert.deepEqual(checkNotificationTopologyGate(provision, verifier), []);
  const mutate = (from, to, text = provision) => {
    assert.ok(text.includes(from), `fixture drifted: ${from}`);
    return text.replace(from, to);
  };
  const cases = [
    [mutate('add L1 PASS latch_inactive', 'add L1 PASS latch_ok'), verifier, /embedded topology verifier must equal/],
    [provision, mutate('add L1 PASS latch_inactive', 'add L1 PASS latch_ok', verifier), /embedded topology verifier must equal/],
    [mutate('  notification-service) isolated_consumer notification.events ;;', '  notification-service) consumer notification.events ;;'), verifier, /isolated_consumer role/],
    [mutate('PERM_WRITE="^(amq\\\\.default|${q}|', 'PERM_WRITE="^(amq\\\\.default|${x}\\\\.dlx|${q}|'), verifier, /never name the dead-letter exchange/],
    [mutate('    notification_verify pre-grant || die', '    true || die'), verifier, /verified before its grant/],
    [mutate('    if ! notification_verify post-grant; then', '    if false; then'), verifier, /verified before its grant/],
    [mutate('        ctl clear_permissions -p "$VHOST" "$s" >/dev/null || true\n', ''), verifier, /verified before its grant/],
  ];
  for (const [p, v, expected] of cases) assert.match(checkNotificationTopologyGate(p, v).join('\n'), expected);
  // UNKNOWN treated as PASS (in both copies, so the embedding still matches)
  const unknownPasses = (t) => t.replace('case $result in PASS) exit 0 ;; FAIL) exit 1 ;; *) exit 3 ;; esac', 'case $result in PASS | UNKNOWN) exit 0 ;; *) exit 1 ;; esac');
  assert.match(checkNotificationTopologyGate(unknownPasses(provision), unknownPasses(verifier)).join(), /only PASS may exit 0/);
  assert.match(checkNotificationTopologyGate(undefined, verifier).join(), /not found/);
});

test('Core V2 S1e-2: Billing\'s payment-event subscription is strict and its handler never reads the trusted values from delivery headers', async () => {
  const { checkEnforcementPolicies, STRICT_FINANCIAL_CONSUMERS } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = STRICT_FINANCIAL_CONSUMERS['billing-service'];
  const sources = { 'billing-service': { [files.consumer]: read(files.consumer), [files.origin]: read(files.origin) } };
  assert.deepEqual(checkEnforcementPolicies({}, sources), []);
  const mutate = (rel, from, to) => {
    assert.ok(sources['billing-service'][rel].includes(from), `fixture drifted: ${from}`);
    return { 'billing-service': { ...sources['billing-service'], [rel]: sources['billing-service'][rel].replace(from, to) } };
  };
  const strict = "enforcement: strictEnforcement({ refusedBody: 'original_reviewed' }),";
  assert.match(checkEnforcementPolicies({}, mutate(files.consumer, strict, '')).join(), /must declare `enforcement: strictEnforcement/);
  assert.match(checkEnforcementPolicies({}, mutate(files.consumer, strict, 'enforcement: auditCompatibilityEnforcement(),')).join(), /only audit-service may use the compatibility phase/);
  assert.match(checkEnforcementPolicies({}, mutate(files.consumer, 'settledAt = new Date(t.occurredAt);', 'settledAt = new Date(event.headers.occurredAt);')).join(), /reads a delivery header Billing must take from the trusted envelope/);
  assert.match(checkEnforcementPolicies({}, mutate(files.consumer, 'const correlationId = t.correlationId ??', 'const correlationId = event.headers.correlationId ??')).join(), /reads a delivery header/);
  assert.match(checkEnforcementPolicies({}, { 'billing-service': {} }).join(), /the financial consumer was not found/);
});

test('Core V2 OD-BRK-2b-1: the topology monitor pins the verifier, the grant and every installed hash; contains in order; is inert in the repository', async () => {
  const { checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, read(`${TOPOLOGY_MONITOR_DIR}/${n}`)]));
  const base = { files, verifier: read(TOPOLOGY_VERIFIER), provision: read(PROVISION_SCRIPT), workflows: { 'core-ci.yml': read('.github/workflows/core-ci.yml') } };
  assert.deepEqual(checkTopologyMonitor(base), []);
  const mutate = (file, from, to) => {
    assert.ok(files[file].includes(from), `fixture drifted: ${file}: ${from}`);
    return checkTopologyMonitor({ ...base, files: { ...files, [file]: files[file].replace(from, to) } }).join('\n');
  };
  // the containment order, the bounds and the state machine
  assert.match(mutate('verify-and-contain.sh', '  persist_latch || log', '  : || log'), /persist the intent/);
  assert.match(mutate('verify-and-contain.sh', '    if confirm; then\n      sleep "$CONFIRM_INTERVAL"\n      if confirm; then CONTAINMENT=confirmed; break; fi\n    fi', '    CONTAINMENT=confirmed; break'), /confirm twice/);
  assert.match(mutate('verify-and-contain.sh', 'readonly MAX_ATTEMPTS=3', 'readonly MAX_ATTEMPTS=1000'), /small bound/);
  assert.match(mutate('verify-and-contain.sh', 'if [ "$ST_STREAK" -ge 3 ]; then', 'if [ "$ST_STREAK" -ge 30 ]; then'), /third consecutive UNKNOWN/);
  assert.match(mutate('verify-and-contain.sh', '        NEW_CONTAINMENT=1\n        contain verifier_fail ;;', '        save_state FAIL ;;'), /a FAIL contains at once/);
  assert.match(mutate('verify-and-contain.sh', '    revoke\n', '    revoke\n    ctl set_permissions -p "$VHOST" "$SERVICE" x x x\n'), /never grant/);
  assert.match(mutate('recover-notification-topology.sh', 'write_atomic "$LATCH" "$LATCH_INACTIVE" 644', 'ctl set_permissions -p nawara-core notification-service x x x; write_atomic "$LATCH" "$LATCH_INACTIVE" 644'), /never grant/);
  // pins: the verifier, the grant, the locations, the installation hashes
  assert.match(checkTopologyMonitor({ ...base, verifier: `${base.verifier}# drift\n` }).join(), /VERIFIER_SHA256 must equal/);
  assert.match(mutate('verify-and-contain.sh', "readonly TOPIC_READ='^(admin\\.operator_code_issued|", "readonly TOPIC_READ='^(audit\\.#|admin\\.operator_code_issued|"), /TOPIC_WRITE \/ TOPIC_READ must equal/);
  assert.match(mutate('recover-notification-topology.sh', "readonly ROLE_CONF='^(nawara\\.events|", "readonly ROLE_CONF='^(nawara\\.events\\.dlx|nawara\\.events|"), /ROLE_CONF must be the approved isolated role/);
  assert.match(mutate('topology-watchdog.sh', "readonly STATE_DIR='/var/lib/nawara-core-topology-monitor'", "readonly STATE_DIR='/tmp/x'"), /STATE_DIR must be/);
  assert.match(mutate('verify-and-contain.sh', "readonly OWNER_UID=0", 'readonly OWNER_UID=1000'), /OWNER_UID must be 0/);
  // OD-BRK-2b-I: an installed file's authority is the Owner-signed manifest, so no hash may be pinned on the server
  assert.match(mutate('verify-topology-monitor-install.sh', "readonly TRUST_ROOT='/'", `readonly TRUST_ROOT='/'\nreadonly SHA_VERIFY_AND_CONTAIN='${'0'.repeat(64)}'`), /no hash pinned on the server/);
  assert.match(mutate('nawara-core-topology-monitor.timer', 'OnUnitActiveSec=5min', 'OnUnitActiveSec=1h'), /both timers run every 5 minutes/);
  // client commands, sourcing, the trigger and its templates
  assert.match(mutate('topology-trigger.sh', 'env -i PATH="$PATH" "$SUDO" -n /usr/bin/systemctl start "$MONITOR_SERVICE" || rc=$?', '"$SUDO" -n /usr/bin/systemctl start "$MONITOR_SERVICE" || rc=$?'), /through sudo -n, with an empty environment/);
  assert.match(mutate('topology-trigger.sh', '[ "$EUID" -ne 0 ] || refuse 65 ', ': || refuse 65 '), /refuse to run as root/);
  assert.match(mutate('verify-and-contain.sh', 'log() {', 'bash -c "$SSH_ORIGINAL_COMMAND"\nlog() {'), /SSH_ORIGINAL_COMMAND is only ever tested/);
  assert.match(mutate('topology-watchdog.sh', 'log() {', '. /etc/nawara/override\nlog() {'), /no eval and no sourcing/);
  assert.match(mutate('topology-trigger.sudoers.template', 'NOPASSWD: /usr/bin/systemctl start nawara-core-topology-monitor.service', 'NOPASSWD: /usr/bin/systemctl *'), /exactly the one rule/);
  assert.match(mutate('topology-trigger.authorized_keys.template', 'restrict,command=', 'command='), /exactly one line/);
  assert.match(mutate('nawara-core-topology-monitor.service', 'SuccessExitStatus=10 20', 'SuccessExitStatus=10 20 21'), /count only 10 and 20 as success/);
  assert.match(mutate('nawara-core-topology-monitor.service', 'UMask=0077', 'UMask=0077\nStateDirectory=nawara-core-topology-monitor'), /never create its state/);
  // inert: no workflow may install or start it; a missing file is reported
  assert.match(checkTopologyMonitor({ ...base, workflows: { 'x.yml': 'run: sudo install-topology-monitor.sh && systemctl enable nawara-core-topology-monitor.timer' } }).join(), /must not install, enable or start the topology monitor/);
  const { [TOPOLOGY_MONITOR_FILES[0]]: _gone, ...fewer } = files;
  assert.match(checkTopologyMonitor({ ...base, files: fewer }).join(), /verify-and-contain\.sh: missing/);
});

test('Core V2 OD-BRK-2b-R: the recovery is signed, incident-bound, unexpired and single-use; incidents come first and from /dev/urandom', async () => {
  const { checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, read(`${TOPOLOGY_MONITOR_DIR}/${n}`)]));
  const base = { files, verifier: read(TOPOLOGY_VERIFIER), provision: read(PROVISION_SCRIPT), workflows: {} };
  assert.deepEqual(checkTopologyMonitor(base), []);
  const mutate = (file, from, to) => {
    assert.ok(files[file].includes(from), `fixture drifted: ${file}: ${from}`);
    return checkTopologyMonitor({ ...base, files: { ...files, [file]: files[file].replace(from, to) } }).join('\n');
  };
  const R = 'recover-notification-topology.sh';
  assert.match(mutate(R, 'verdict=$(env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$TRUSTED_SIGNERS" -I "$PRINCIPAL" -n "$NAMESPACE" -s "$WORK/authorization.sig" <"$WORK/authorization" 2>/dev/null)', 'verdict=$(echo Good)'), /verified with ssh-keygen -Y verify/);
  assert.match(mutate(R, `readonly SIGNER_RE='^nawara-core-owner namespaces=`, `readonly SIGNER_RE='^[a-z*-]+ namespaces=`), /exactly one line for the exact principal/);
  assert.match(mutate(R, "readonly PRINCIPAL='nawara-core-owner'", "readonly PRINCIPAL='*'"), /PRINCIPAL must be nawara-core-owner/);
  assert.match(mutate(R, "readonly NAMESPACE='nawara-core-topology-recovery'", "readonly NAMESPACE='file'"), /NAMESPACE must be/);
  assert.match(mutate(R, 'readonly MAX_VALIDITY=3600', 'readonly MAX_VALIDITY=86400'), /MAX_VALIDITY must be at most 3600/);
  assert.match(mutate(R, '[ "$A_INCIDENT" = "$INCIDENT" ] || stop authorization_incident', ': || stop authorization_incident'), /name the current incident/);
  assert.match(mutate(R, '[ "$NOW" -le "$A_NOT_AFTER" ] || stop authorization_expired', ': || stop authorization_expired'), /unexpired/);
  assert.match(mutate(R, '! grep -qF " nonce=$A_NONCE " -- "$CONSUMED" || stop authorization_replay', ': || stop authorization_replay'), /consumed nonce is refused/);
  assert.match(mutate(R, '[ "$#" -eq 0 ] || usage ', '[ "$#" -le 1 ] || usage '), /takes no argument/);
  assert.match(mutate(R, 'log() {', 'IFS= read -r typed; log() {'), /no typed-reference authorization/);
  const M = 'verify-and-contain.sh';
  assert.match(mutate(M, '  if [ "$ST_INCIDENT" = none ]; then\n    ST_INCIDENT=$(new_incident)', '  if true; then\n    ST_INCIDENT=$(new_incident)'), /incident only when there is none/);
  assert.match(mutate(M, '  persist_incident || log', '  : || log'), /state, incident binding, then latch/);
  assert.match(mutate(M, 'head -c 16 /dev/urandom', 'date +%s%N | head -c 16'), /from \/dev\/urandom/);
  assert.match(mutate(M, "readonly INCIDENT_FILE='/var/lib/nawara-core-topology/notification-service.incident'", "readonly INCIDENT_FILE='/tmp/incident'"), /INCIDENT_FILE must be/);
});

test('Core V2 OD-BRK-2b-I: the installation is authenticated by an Owner-signed manifest; upgrades are monotonic; protected state is never replaced', async () => {
  const { checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, TOPOLOGY_MONITOR_ARTIFACTS, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const { MANIFEST_ARTIFACTS } = await import('./topology-monitor-manifest.mjs');
  assert.deepEqual(MANIFEST_ARTIFACTS.map(([n]) => n), TOPOLOGY_MONITOR_ARTIFACTS, 'the generator lists the installer\'s artifacts, in its order');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, read(`${TOPOLOGY_MONITOR_DIR}/${n}`)]));
  const base = { files, verifier: read(TOPOLOGY_VERIFIER), provision: read(PROVISION_SCRIPT), workflows: {} };
  assert.deepEqual(checkTopologyMonitor(base), []);
  const mutate = (file, from, to) => {
    assert.ok(files[file].includes(from), `fixture drifted: ${file}: ${from}`);
    return checkTopologyMonitor({ ...base, files: { ...files, [file]: files[file].replace(from, to) } }).join('\n');
  };
  const I = 'install-topology-monitor.sh';
  const V = 'verify-topology-monitor-install.sh';
  assert.match(mutate(I, 'verdict=$(env -i PATH="$SAFE_PATH" timeout 10 ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE"', 'verdict=$(env -i PATH="$SAFE_PATH" timeout 10 echo'), /verified with ssh-keygen -Y verify against the installation trust key/);
  assert.match(mutate(V, 'ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$INSTALL_STATE/installed/manifest.sig"', 'true -s "$INSTALL_STATE/installed/manifest.sig"'), /verified with ssh-keygen -Y verify/);
  assert.match(mutate(I, `readonly SIGNER_RE='^nawara-core-owner namespaces=`, `readonly SIGNER_RE='^[a-z*-]+ namespaces=`), /exactly one line for the exact principal, restricted to the installation namespace/);
  assert.match(mutate(I, "readonly INSTALL_NAMESPACE='nawara-core-topology-install'", "readonly INSTALL_NAMESPACE='nawara-core-topology-recovery'"), /INSTALL_NAMESPACE must be/);
  assert.match(mutate(I, '[ "$M_VERSION" -gt "$CUR_VERSION" ] || refuse downgrade', '[ "$M_VERSION" -ge 1 ] || refuse downgrade'), /strictly higher, signed version/);
  assert.match(mutate(I, 'if absent "$LATCH"; then', 'if true; then'), /created only when absent/);
  assert.match(mutate(I, 'if absent "$STATE_DIR/state"; then', 'if true; then'), /created only when absent/);
  assert.match(mutate(I, 'log "$TXN_KIND complete', 'rm -f "$STATE_DIR/recovery-consumed"; log "$TXN_KIND complete'), /never touches the nonce ledger/);
  assert.match(mutate(I, 'log "$TXN_KIND complete', 'systemctl enable --now nawara-core-topology-monitor.timer; log "$TXN_KIND complete'), /never enables, starts or reloads a unit/);
  assert.match(mutate(V, 'printf \'RESULT: PASS', 'rm -f /tmp/x; printf \'RESULT: PASS'), /must stay read-only/);
  assert.match(mutate(V, 'st=$("$SYSTEMCTL" is-enabled "$u" 2>/dev/null || true)', 'st=$("$SYSTEMCTL" enable "$u" 2>/dev/null || true)'), /may only read units' enablement/);
  assert.match(mutate(I, "readonly SCRIPTS='verify-and-contain.sh topology-watchdog.sh", "readonly SCRIPTS='topology-watchdog.sh verify-and-contain.sh"), /the manifest's artifacts are exactly/);
  // the transaction is recorded before any artifact changes
  assert.match(mutate(I, `mv -- "$TMPM/staging" "$TXN/staging"
txn_phase staged
txn_phase applying`, `mv -- "$TMPM/staging" "$TXN/staging"
apply_artifacts
txn_phase staged
txn_phase applying`), /recorded before any artifact is applied/);
});

test('Core V2 OD-BRK-2b-A: the external alert carrier keeps A5-R3\'s endpoints, stays off the containment path and never fakes a heartbeat', async () => {
  const { checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, read(`${TOPOLOGY_MONITOR_DIR}/${n}`)]));
  const base = { files, verifier: read(TOPOLOGY_VERIFIER), provision: read(PROVISION_SCRIPT), workflows: {} };
  assert.deepEqual(checkTopologyMonitor(base), []);
  const mutate = (file, from, to) => {
    assert.ok(files[file].includes(from), `fixture drifted: ${file}: ${from}`);
    return checkTopologyMonitor({ ...base, files: { ...files, [file]: files[file].replace(from, to) } }).join('\n');
  };
  const C = 'topology-alert-carrier.sh';
  const U = 'nawara-core-topology-alert.service';
  // the fixed providers, HTTPS only, the system trust store
  assert.match(mutate(C, "readonly PUSHOVER_URL='https://api.pushover.net/1/messages.json'", "readonly PUSHOVER_URL='https://alerts.example.invalid/1/messages.json'"), /A5-R3's fixed HTTPS endpoints/);
  assert.match(mutate(C, "readonly HC_URL_RE='^https://hc-ping\\.com/", "readonly HC_URL_RE='^https?://[^/]+/"), /A5-R3's fixed HTTPS endpoints/);
  assert.match(mutate(C, "readonly CA_FILE=''", "readonly CA_FILE='/tmp/ca.pem'"), /system trust store/);
  assert.match(mutate(C, "--proto '=https' --proto-redir '=https' --max-redirs 0 -o \"$RESP\" -w '%{http_code}' 2>/dev/null) || rc=$?\n  body=$(head -c 2000", "--proto '=https' --max-redirs 3 -o \"$RESP\" -w '%{http_code}' 2>/dev/null) || rc=$?\n  body=$(head -c 2000"), /HTTPS only, certificate verification on, no redirect/);
  assert.match(mutate(C, 'curl_tls() {', "curl_tls() { echo insecure; }\ncurl_tls2() {"), /HTTPS only, certificate verification on/);
  assert.match(mutate(C, '| env -i PATH="$SAFE_PATH" timeout -k 2 $((CURL_TIMEOUT + 2)) curl -q --config - --silent', '| env -i PATH="$SAFE_PATH" timeout -k 2 $((CURL_TIMEOUT + 2)) curl -q --data "token=$PO_TOKEN" --config /etc/x --silent'), /curl --config - \(secrets on stdin only\)/);
  // never the broker, never a unit, never the producers' files, never the Auth carrier
  assert.match(mutate(C, 'INTEGRITY=$(integrity)', 'docker exec nawara-core-rabbitmq rabbitmqctl list_users >/dev/null\nINTEGRITY=$(integrity)'), /never administers the broker or a unit \(found "docker"\)/);
  assert.match(mutate(C, 'INTEGRITY=$(integrity)', 'systemctl start nawara-core-topology-monitor.service\nINTEGRITY=$(integrity)'), /found "systemctl"/);
  assert.match(mutate(C, 'INTEGRITY=$(integrity)', ': > "$SPOOL"\nINTEGRITY=$(integrity)'), /only READS the producers' spool/);
  assert.match(mutate(C, 'INTEGRITY=$(integrity)', 'rm -f -- "$STATE_DIR/alerts.jsonl"\nINTEGRITY=$(integrity)'), /only READS the producers' spool/);
  assert.match(mutate(C, 'INTEGRITY=$(integrity)', 'exec 7>>"$STATE_DIR/lock"\nINTEGRITY=$(integrity)'), /never takes the monitor's lock/);
  assert.match(mutate(C, "readonly CARRIER_DIR='/var/lib/nawara-core-topology-alert'", "readonly CARRIER_DIR='/var/lib/nawara-auth-readiness-alert'"), /CARRIER_DIR must be/);
  // the minimum event contract and the heartbeat semantics
  assert.match(mutate(C, '[recovery_refused]=critical', '[recovery_denied]=critical'), /must define recovery_refused/);
  assert.match(mutate(C, 'none:UNKNOWN) M_STATUS=10 ;;', 'none:UNKNOWN) M_STATUS=0 ;;'), /a success heartbeat \(exit status 0\) is only a monitor PASS/);
  assert.match(mutate(C, 'ok | contained) W_STATUS=0 ;;', 'ok | contained | monitor_overdue) W_STATUS=0 ;;'), /or a watchdog run that found no problem/);
  assert.match(mutate(C, 'if [ $((NOW - run)) -gt "$HB_FRESH" ]; then', 'if false; then'), /only for a NEW run that completed within HB_FRESH/);
  assert.match(mutate(C, 'if [ "$run" -le "${!sent}" ]; then', 'if false; then'), /only for a NEW run/);
  // containment never waits for an alert; the new local line comes after the persisted intent, before the broker changes
  assert.match(mutate('verify-and-contain.sh', 'ctl() {', 'notify() { curl -s https://alerts.example.invalid; }\nctl() {'), /never calls the network or the carrier/);
  assert.match(mutate('topology-watchdog.sh', 'log() {', 'log() { /usr/local/libexec/nawara-core-topology/topology-alert-carrier.sh; }\nlog0() {'), /never calls the network or the carrier/);
  assert.match(mutate('verify-and-contain.sh', '  if [ "$NEW_CONTAINMENT" = 1 ]; then alert critical containment_started "$1"; fi\n', ''), /a new containment is recorded locally \(containment_started\)/);
  // the unit: no capability, no broker or Auth carrier path, no environment, exactly its credentials
  assert.match(mutate(U, 'InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/var/lib/docker -/var/lib/containerd -/opt/nawara-core\n', ''), /no broker or Auth carrier path/);
  assert.match(mutate(U, 'InaccessiblePaths=-/etc/nawara-auth-readiness-alert -/var/lib/nawara-auth-readiness-alert\n', ''), /no broker or Auth carrier path/);
  assert.match(mutate(U, 'UMask=0077', 'UMask=0077\nEnvironmentFile=-/etc/nawara-core-topology-alert/carrier.env'), /no environment/);
  assert.match(mutate(U, 'UMask=0077', 'UMask=0077\nReadWritePaths=/var/lib/nawara-core-topology-monitor'), /no writable path but its own state/);
  assert.match(mutate(U, 'UMask=0077', 'UMask=0077\nLoadCredential=rabbitmq.admin:/opt/nawara-core/.env'), /exactly its four credentials/);
  assert.match(mutate(U, 'CapabilityBoundingSet=\n', 'CapabilityBoundingSet=CAP_DAC_OVERRIDE\n'), /no capability/);
  assert.match(mutate('nawara-core-topology-alert.timer', 'OnUnitActiveSec=60', 'OnUnitActiveSec=1s'), /every 60 s/);
  // the signed artifact set: the carrier is in it, a credential never is, and every list agrees
  assert.match(mutate(C, "topology-alert-carrier.sh'\nreadonly UNITS=", "'\nreadonly UNITS="), /SCRIPTS and UNITS \(its integrity sentinel\) must equal the installer's/);
  assert.match(mutate('install-topology-monitor.sh', 'fresh_operational_state() {', 'carrier_credentials() { install -m 0400 pushover.token /etc/nawara-core-topology-alert/pushover.token; }\nfresh_operational_state() {'), /no carrier credential is ever an artifact or installed by the installer/);
  assert.match(mutate('install-topology-monitor.sh', ' nawara-core-topology-alert.service nawara-core-topology-alert.timer\'', '\''), /the manifest's artifacts are exactly/);
});

test('Core V2 OD-BRK-2b-W: activated means operational, the alert spool has one bounded lock, and the watchdog is a sandboxed observer', async () => {
  const { checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, PROVISION_SCRIPT, TOPOLOGY_VERIFIER } = await import('./lib/checks.mjs');
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const files = Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, read(`${TOPOLOGY_MONITOR_DIR}/${n}`)]));
  const base = { files, verifier: read(TOPOLOGY_VERIFIER), provision: read(PROVISION_SCRIPT), workflows: {} };
  assert.deepEqual(checkTopologyMonitor(base), []);
  const mutate = (file, from, to) => {
    assert.ok(files[file].includes(from), `fixture drifted: ${file}: ${from}`);
    return checkTopologyMonitor({ ...base, files: { ...files, [file]: files[file].replace(from, to) } }).join('\n');
  };
  const V = 'verify-topology-monitor-install.sh';
  const W = 'nawara-core-topology-watchdog.service';
  // W1: a listed timer disabled, stopped or failed, or its service failed, never passes; a started timer is an activation
  const w1 = /an activated installation passes only with every listed timer enabled and active/;
  assert.match(mutate(V, 'inactive) ac=0; fail "timer (timer_inactive)', 'inactive) ac=1; ok "timer (timer_inactive)'), w1);
  assert.match(mutate(V, 'disabled | static | indirect) en=0; fail "timer (timer_disabled)', 'disabled | static | indirect) en=1; ok "timer (timer_disabled)'), w1);
  assert.match(mutate(V, 'failed) ac=0; fail "timer (timer_failed)', 'failed) ac=1; ok "timer (timer_failed)'), w1);
  assert.match(mutate(V, 'enabled-runtime) en=0; fail "timer (runtime_only)', 'enabled-runtime) en=1; ok "timer (runtime_only)'), w1);
  assert.match(mutate(V, 'failed) fail "service (service_failed)', 'failed) ok "service (service_failed)'), w1);
  assert.match(mutate(V, 'AC[$u]=$("$SYSTEMCTL" is-active "$u" 2>/dev/null || true)', 'AC[$u]=active'), w1);
  assert.match(mutate(V, 'active | activating | deactivating | reloading | refreshing | failed) [[ " $ENABLED " == *" $u "* ]] || ENABLED+=" $u" ;;', 'active | activating | deactivating | reloading | refreshing | failed) ;;'), w1);
  assert.match(mutate(V, 'AC[$u]=$("$SYSTEMCTL" is-active "$u" 2>/dev/null || true)', 'AC[$u]=$("$SYSTEMCTL" start "$u" 2>/dev/null || true)'), /may only read units' enablement/);
  // W2: one bounded lock; without it a line is parked, never appended; each run flushes
  const w2 = /every append and trim of alerts\.jsonl holds STATE_DIR\/alerts\.lock/;
  for (const n of ['verify-and-contain.sh', 'topology-watchdog.sh', 'recover-notification-topology.sh']) {
    assert.match(mutate(n, 'flock -w "$SPOOL_LOCK_WAIT" 7', 'flock -w 600 7'), w2, `${n}: an unbounded wait`);
    assert.match(mutate(n, 'readonly SPOOL_LOCK_WAIT=2', 'readonly SPOOL_LOCK_WAIT=30'), w2, `${n}: a long wait`);
    assert.match(mutate(n, '/alerts.lock"', '/alerts-other.lock"'), w2, `${n}: another lock`);
  }
  assert.match(mutate('verify-and-contain.sh', '    log "alert spool lock unavailable within ${SPOOL_LOCK_WAIT}s: the line is parked for the next writer that holds it"\n    return 0',
    '    log "alert spool lock unavailable within ${SPOOL_LOCK_WAIT}s: the line is parked for the next writer that holds it"\n    printf \'%s\\n\' "$1" >>"$STATE_DIR/alerts.jsonl"\n    return 0'), w2, 'an unlocked append in the fallback');
  assert.match(mutate('topology-watchdog.sh', '  spool_append "{\\"v\\":1,', '  append alerts.jsonl "{\\"v\\":1,'), w2, 'the watchdog appending outside the lock');
  assert.match(mutate('recover-notification-topology.sh', '    log "alert spool lock unavailable within ${SPOOL_LOCK_WAIT}s: the line is parked for the next writer that holds it"\n  else',
    '    log "alert spool lock unavailable within ${SPOOL_LOCK_WAIT}s: the line is parked for the next writer that holds it"\n    printf \'%s\\n\' "$line" >>"$f"\n  else'), w2, 'the recovery appending without the lock');
  assert.match(mutate('topology-watchdog.sh', '\nspool_flush || true\n', '\n'), /flush the parked alert lines once a run/);
  // W3: the watchdog's sandbox
  const w3 = /an observer sandbox/;
  for (const d of ['PrivateNetwork=yes', 'RestrictAddressFamilies=AF_UNIX', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
    'InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/var/lib/docker -/var/lib/containerd -/opt/nawara-core',
    'InaccessiblePaths=-/var/lib/nawara-core-topology-install -/var/lib/nawara-core-topology-monitor/recovery']) {
    assert.match(mutate(W, `\n${d}\n`, '\n'), w3, `without ${d}`);
  }
  assert.match(mutate(W, 'RestrictAddressFamilies=AF_UNIX', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6'), w3);
  assert.match(mutate(W, 'ReadWritePaths=/var/lib/nawara-core-topology-monitor', 'ReadWritePaths=/var/lib/nawara-core-topology-monitor\nReadWritePaths=/var/lib/nawara-core-topology'), w3);
  assert.match(mutate(W, 'TimeoutStartSec=60', 'TimeoutStartSec=60\nRestart=on-failure'), w3, 'never restarted outside its timer');
  assert.match(mutate(W, 'CapabilityBoundingSet=\n', 'CapabilityBoundingSet=CAP_SYS_ADMIN\n'), w3);
  assert.match(mutate(W, 'TimeoutStartSec=60', 'TimeoutStartSec=60\nExecStartPost=/usr/bin/systemctl start nawara-core-topology-monitor.service'), w3, 'never restarts the monitor');
  // C1: a parked line is published durably (synced before and after its rename); a merged one is removed only after the spool is synced
  for (const n of ['verify-and-contain.sh', 'topology-watchdog.sh', 'recover-notification-topology.sh']) {
    assert.match(mutate(n, 'if printf \'%s\' "$1" >"$tmp" && sync -- "$tmp" && mv -f -- "$tmp" "$name"; then', 'if printf \'%s\' "$1" >"$tmp" && mv -f -- "$tmp" "$name"; then'), w2, `${n}: renamed before its content is synced`);
    assert.match(mutate(n, '    sync -- "$d" || log', '    true || log'), w2, `${n}: the rename never synced`);
    assert.match(mutate(n, 'mkdir -m 700 -- "$d" 2>/dev/null && sync -- "$STATE_DIR" || return 1', 'mkdir -m 700 -- "$d" 2>/dev/null || return 1'), w2, `${n}: a new directory never synced`);
  }
  assert.match(mutate('verify-and-contain.sh', 'if sync -- "$STATE_DIR/alerts.jsonl"; then rm -f -- "${merged[@]}" || rc=1; else rc=1; fi', 'rm -f -- "${merged[@]}" || rc=1'), w2, 'removed before the spool is synced');
  assert.match(mutate('topology-watchdog.sh', 'if append alerts.jsonl "$(head -c 2048 -- "$p")"; then merged+=("$p"); else rc=1; break; fi', 'append alerts.jsonl "$(head -c 2048 -- "$p")" && rm -f -- "$p" || rc=1'), w2, 'each file removed right after its append');
  assert.match(mutate('recover-notification-topology.sh', 'if sync -- "$f"; then rm -f -- "${merged[@]}" || ok=0; else ok=0; fi', 'rm -f -- "${merged[@]}" || ok=0'), w2, 'the recovery removing before the sync');
  // C4: the watchdog never reaches recovery material or authority, and writes only its own records, check-in and the spool
  const c4 = /an observer: it never touches recovery material or authority/;
  const WD = 'topology-watchdog.sh';
  const at = 'spool_flush || true\n';
  for (const [what, line] of [
    ['the single-use ledger', 'rm -f -- "$STATE_DIR/recovery-consumed"'],
    ['the ledger, by its own name', ': > "$STATE_DIR/recovery-consumed"'],
    ['the monitor\'s state', ': > "$STATE_DIR/state"'],
    ['the monitor\'s state, atomically', 'write_atomic "$STATE_DIR/state" "x"'],
    ['the inbox', 'ls -- "$STATE_DIR/recovery" >/dev/null'],
    ['the recovery guard', '/usr/local/libexec/nawara-core-topology/recover-notification-topology.sh'],
    ['the trust key', 'cat /etc/nawara-core-topology/recovery-allowed-signers >/dev/null'],
    ['the incident history', 'append incidents.jsonl "{}"'],
    ['the broker', 'docker exec nawara-core-rabbitmq rabbitmqctl list_users >/dev/null'],
    ['a unit', '"$SYSTEMCTL" start nawara-core-topology-monitor.service'],
    ['a copy elsewhere', 'cp -- "$STATE_DIR/state" /tmp/x'],
    ['another directory as its spool', 'd="$STATE_DIR/recovery"'],
  ]) assert.match(mutate(WD, at, `${at}${line}\n`), c4, what);
  assert.match(mutate(WD, 'local f="$STATE_DIR/$1" n', 'local f="/var/lib/nawara-core-topology/$1" n'), c4, 'records outside the state directory');
  assert.match(mutate(W, 'ReadWritePaths=/var/lib/nawara-core-topology-monitor', 'ReadWritePaths=/var/lib/nawara-core-topology-monitor/recovery'), w3, 'the inbox writable');
  assert.match(mutate(W, 'TimeoutStartSec=60', 'TimeoutStartSec=60\nExecStart=/usr/local/libexec/nawara-core-topology/recover-notification-topology.sh'), /one command, and no recovery path/, 'the recovery guard as a second command');
  assert.match(mutate(W, 'UMask=0077', 'UMask=0077\nReadOnlyPaths=/var/lib/nawara-core-topology-monitor/recovery'), /one command, and no recovery path/, 'the inbox made readable');
});
