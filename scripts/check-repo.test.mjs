import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ALERT_CATALOG, BROKER_ALARMS, CI_AGGREGATE, CORE_JOBS, GRAFANA_DASHBOARDS, PROMETHEUS_SELF_METRICS, PRODUCTION_GROUP, checkAlertRules, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkActionPins, checkDigestDeploy, checkHierarchyFixtures, checkImageBuild, checkImagePins, checkLocalGrafana, checkLocalObservability, checkTypedConfirmation, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety, SBOM_GENERATOR, checkMetricsClientImport, metricsClientReferences, CALLER_POLICY_MODULES, checkCallerPolicyInventory, checkCallerPolicyModule, staticModuleSpecifiers, workspaceAppPackages, DEVELOPMENT_SECRET_CATALOG, DOCKER_CONTEXT_EXCLUDED, ENV_PATHS_IGNORED, PROCESS_ENV_BOUNDARY, checkDevelopmentSecretCatalog, checkDockerContext, checkEnvIgnorePolicy, checkEnvTemplates, checkReadmeEnvironmentCoverage, checkTrackedEnvFiles, developmentSecretCatalog, dockerIgnoreExcludes, envAssignments, gitIgnoreProbe, gitTrackedFiles, isEnvTemplate, isServiceConfigSource, sourceFacts, ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS, checkEnvReaderClis, checkNodeToolchain, nodeMajor, checkCiWorkspaceCoverage, GENERICITY_HISTORICAL_LINES, checkEventContracts, usesEventTraffic, EVENT_CONTRACT_EXEMPT, checkOutboxRetentionEligibility, outboxIdSources, OUTBOX_RETENTION_APPROVED_SERVICES } from './lib/checks.mjs';
import ts from 'typescript';

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
      - uses: appleboy/ssh-action@v1
        with:
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
const ALL_WORKFLOWS = ['audit-service-deploy.yml', 'audit-service-image.yml', 'auth-db-credential-rotate.yml', 'auth-service-deploy.yml', 'auth-service-docker-build.yml',
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

test('V2 A1.4: the caller-policy inventory is exactly the seven A1.3 consumers, each bound to its variable (Auth is not one)', () => {
  assert.deepEqual(CALLER_POLICY_MODULES, {
    'apps/billing-service/src/admission/caller-admission.policy.ts': 'BILLING_SERVICE_POLICY',
    'apps/payment-service/src/authorization/caller-admission.policy.ts': 'PAYMENT_SERVICE_POLICY',
    'apps/organization-service/src/authorization/service-policy.ts': 'SERVICE_POLICY',
    'apps/notification-service/src/api/caller-policy.ts': 'NOTIFICATION_SERVICE_POLICY',
    'apps/file-service/src/policy/caller-policy.ts': 'FILE_SERVICE_POLICY',
    'apps/audit-service/src/policy/caller-policy.ts': 'AUDIT_SERVICE_POLICY',
    'apps/release-service/src/policy/caller-policy.ts': 'RELEASE_SERVICE_POLICY',
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
  // An existing service that is not governed (Auth) gains a policy read: refused too.
  ungoverned("export const raw = reader.get('AUTH_SERVICE_POLICY');\n", 'apps/auth-service/src/config/auth-config.ts');

  const allowed = {
    'apps/billing-service/src/config/billing-config.ts': "const p = parseBillingServicePolicy(reader.get('BILLING_SERVICE_POLICY'), registeredCallers(t));", // governed
    'apps/organization-service/src/config/organization-config.ts': "servicePolicyRaw: reader.get('SERVICE_POLICY'),", // governed
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
  assert.equal(ENV_READER_CLIS.length, 8); // V2 A3M.5 added nawara-outbox-retention; V2 A4.3 added Auth's migrate.ts
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
