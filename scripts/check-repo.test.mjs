import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CI_AGGREGATE, PRODUCTION_GROUP, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkActionPins, checkDigestDeploy, checkHierarchyFixtures, checkImageBuild, checkImagePins, checkLocalObservability, checkTypedConfirmation, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety, SBOM_GENERATOR, checkMetricsClientImport, metricsClientReferences } from './lib/checks.mjs';
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

test('V2 A12.2a: auth-service installs the metrics foundation right after its request-context middleware (security review P4)', () => {
  const text = readFileSync(new URL('../apps/auth-service/src/main.ts', import.meta.url), 'utf8');
  const sf = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = sf.statements.find((st) => ts.isFunctionDeclaration(st) && st.name?.text === 'bootstrap');
  assert.ok(fn?.body, 'bootstrap() exists');
  const calls = fn.body.statements.filter(ts.isExpressionStatement).map((st) => st.expression.getText(sf).replace(/\s+/g, ' '));
  const at = (prefix) => calls.findIndex((c) => c.startsWith(prefix));
  const ctx = at('app.use(requestContextMiddleware)');
  const metrics = at("installMetrics(app, { serviceName: 'auth-service', metrics: cfg.metrics }, logger)");
  assert.ok(ctx >= 0 && metrics === ctx + 1, `installMetrics directly after app.use(requestContextMiddleware): ${calls.join(' | ')}`);
  assert.equal(calls[metrics + 1], 'app.use(helmet())');
  assert.ok(at('app.use(shutdownAdmission(') < ctx, 'shutdown admission still first');
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
    fails(checkLocalObservability(BASE, OVERLAY.replace("    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n\nvolumes:", "    read_only: true\n    cap_drop: [ALL]\n    security_opt: ['no-new-privileges:true']\n    ports: ['127.0.0.1:9187:9187']\n\nvolumes:"), PROM), /postgres-exporter publishes the metrics listener \(9187\)/);
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
