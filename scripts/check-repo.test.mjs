import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CI_AGGREGATE, PRODUCTION_GROUP, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkDigestDeploy, checkHierarchyFixtures, checkImageBuild, checkTypedConfirmation, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety } from './lib/checks.mjs';

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
  assert.match(checkWorkflowSafety('b.yml', BUILD + deployJob).join(), /never automatically \(found: pull_request, push\)/);
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
  assert.deepEqual(checkDigestDeploy('auth-service-deploy.yml', DEPLOY, AUTH), []);
});

test('D: a digest deployment that builds (rebuilding main) is refused', () => {
  const buildStep = `      - uses: docker/build-push-action@v7
        with:
          push: true
          tags: \${{ env.IMAGE_NAME }}:sha-\${{ github.sha }}
      - uses: appleboy/ssh-action@v1`;
  assert.match(checkDigestDeploy('d.yml', swap(DEPLOY, '      - uses: appleboy/ssh-action@v1', buildStep), AUTH).join(), /must never build an image/);
  for (const cmd of ['docker build -t x .', 'docker buildx build --push .']) {
    const bad = swap(DEPLOY, '          docker buildx imagetools inspect "$REF" >/dev/null', `          ${cmd}\n          docker buildx imagetools inspect "$REF" >/dev/null`);
    assert.match(checkDigestDeploy('d.yml', bad, AUTH).join(), /must never build an image/);
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
  assert.match(checkDigestDeploy('d.yml', loose, AUTH).join(), /job "verify": the digest must be validated against/);
  const looseDeploy = DEPLOY.slice(0, DEPLOY.lastIndexOf(VALIDATE)) + VALIDATE.replace('{64}', '+') + DEPLOY.slice(DEPLOY.lastIndexOf(VALIDATE) + VALIDATE.length);
  assert.match(checkDigestDeploy('d.yml', looseDeploy, AUTH).join(), /job "deploy": the digest must be re-validated/);
  // verify's validation moved after the registry login
  const late = swap(swap(DEPLOY, VALIDATE, ''), '      - uses: docker/login-action@v4\n', `      - uses: docker/login-action@v4\n${VALIDATE}`);
  assert.match(checkDigestDeploy('d.yml', late, AUTH).join(), /job "verify": the digest must be validated .* before any registry step/);
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
  assert.deepEqual(checkDigestDeploy('auth-service-deploy.yml', DEPLOY, AUTH), []);
  const noEnv = swap(DEPLOY, '    environment: production\n', '');
  assert.match(checkDigestDeploy('d.yml', noEnv, AUTH).join(), /must be bound to the "production" environment/);
  const onVerify = swap(swap(DEPLOY, '    environment: production\n', ''), '  verify:\n    if:', '  verify:\n    environment: production\n    if:');
  const msgs = checkDigestDeploy('d.yml', onVerify, AUTH).join();
  assert.match(msgs, /job "verify": must not declare an environment/);
  assert.match(msgs, /job "deploy": must be bound to the "production" environment/);
  assert.match(checkDigestDeploy('d.yml', swap(DEPLOY, '    needs: verify\n', ''), AUTH).join(), /must need the "verify" job/);
  const verifyGone = DEPLOY.replace(/\n {2}verify:\n[\s\S]*?\n {2}deploy:\n/, '\n  deploy:\n');
  assert.match(checkDigestDeploy('d.yml', verifyGone, AUTH).join(), /the "verify" job is missing/);
  const sshOnVerify = swap(DEPLOY, '      - id: artifact\n', '      - run: echo "$H"\n        env:\n          H: ${{ secrets.DEPLOY_SSH_HOST }}\n      - id: artifact\n');
  assert.match(checkDigestDeploy('d.yml', sshOnVerify, AUTH).join(), /job "verify": must not use production SSH or the DEPLOY_SSH_\* credentials/);
  const renamed = swap(swap(DEPLOY, '\n  deploy:\n    needs: verify\n', '\n  ship:\n    needs: verify\n'), 'jobs:\n', 'jobs:\n');
  assert.match(checkDigestDeploy('d.yml', renamed, AUTH).join(), /the SSH job must be "deploy"/);
  const noConfirmVerify = DEPLOY.replace("  verify:\n    if: github.ref == 'refs/heads/main' && inputs.confirm == 'deploy auth-service'\n", "  verify:\n    if: github.ref == 'refs/heads/main'\n");
  assert.match(checkDigestDeploy('d.yml', noConfirmVerify, AUTH).join(), /job "verify": must require the typed confirmation/);
});

test('F: deploying anything but exactly IMAGE_NAME@digest is refused', () => {
  for (const image of ['${{ env.IMAGE_NAME }}:production', '${{ env.IMAGE_NAME }}:sha-${{ github.sha }}', 'ghcr.io/other/repo@${{ inputs.digest }}', '${{ steps.verify.outputs.ref }}']) {
    const bad = swap(DEPLOY, 'IMAGE: ${{ env.IMAGE_NAME }}@${{ inputs.digest }}', `IMAGE: ${image}`);
    assert.match(checkDigestDeploy('d.yml', bad, AUTH).join(), /must deploy exactly/);
  }
  const foreign = swap(DEPLOY, 'IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/nawara-core-auth-service', 'IMAGE_NAME: ghcr.io/${{ github.repository_owner }}/nawara-core-organization-service');
  assert.match(checkDigestDeploy('d.yml', foreign, AUTH).join(), /IMAGE_NAME must be fixed to the nawara-core-auth-service repository/);
});

test('F: dropping the artifact verification (existence, revision label, ancestry) is refused', () => {
  const noAncestry = swap(DEPLOY, '          git merge-base --is-ancestor "$rev" HEAD || { echo "refused: revision $rev is not an ancestor of main" >&2; exit 1; }\n', '');
  assert.match(checkDigestDeploy('d.yml', noAncestry, AUTH).join(), /revision label checked as an ancestor of main/);
});

test('G: the digest deployment keeps the production queue, never cancels, main only, typed confirmation, read-only packages', () => {
  const noQueue = swap(DEPLOY, `    concurrency:
      group: production-deploy-core-api
      cancel-in-progress: false
`, '');
  assert.match(checkWorkflowSafety('d.yml', noQueue).join(), /has no concurrency group/);
  assert.match(checkWorkflowSafety('d.yml', swap(DEPLOY, '      cancel-in-progress: false\n', '      cancel-in-progress: true\n')).join(), /cancel-in-progress must be explicitly false/);
  const noConfirm = swap(DEPLOY, " && inputs.confirm == 'deploy auth-service'", '');
  assert.match(checkDigestDeploy('d.yml', noConfirm, AUTH).join(), /typed confirmation/);
  assert.match(checkDigestDeploy('d.yml', swap(DEPLOY, '      packages: read', '      packages: write'), AUTH).join(), /packages/);
  assert.match(checkDigestDeploy('d.yml', swap(DEPLOY, '  workflow_dispatch:\n', '  push:\n    branches: [main]\n  workflow_dispatch:\n'), AUTH).join(), /workflow_dispatch only/);
  const optional = swap(DEPLOY, 'sha256:<64 hex>, from a build-image run summary)"\n        required: true', 'sha256:<64 hex>, from a build-image run summary)"\n        required: false');
  assert.match(checkDigestDeploy('d.yml', optional, AUTH).join(), /"digest" input must exist and be required/);
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

test('A0: the three real image builds satisfy the immutable-build contract (Auth develop job included)', () => {
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
  assert.match(checkImageBuild('o.yml', swap(ORG_IMAGE, 'on:\n  push:\n', 'on:\n  workflow_dispatch:\n  push:\n'), C).join(), /not on workflow_dispatch/);
});

test('A0: a non-build-image job stays pull_request-only and never publishes sha-, :production or :latest (Auth build-develop)', () => {
  const AUTH_BUILD = workflow('auth-service-docker-build.yml');
  const C = IMAGE_BUILD_FILES['auth-service-docker-build.yml'];
  assert.match(checkImageBuild('a.yml', swap(AUTH_BUILD, '          tags: ${{ env.IMAGE_NAME }}:develop', '          tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}'), C).join(), /only build-image publishes the immutable sha- tag/);
  assert.match(checkImageBuild('a.yml', swap(AUTH_BUILD, "  build-develop:\n    if: github.event_name == 'pull_request'\n", "  build-develop:\n    if: github.event_name == 'push'\n"), C).join(), /must be pull_request-only/);
});

test('A0: Organization and Audit deploy exactly a verified digest (same contract as Auth)', () => {
  for (const [name, [repository, phrase]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name);
    assert.deepEqual(checkDigestDeploy(name, text, repository), [], name);
    assert.deepEqual(checkTypedConfirmation(name, text, phrase), [], name);
    assert.deepEqual(checkWorkflowSafety(name, text), [], name);
  }
  const ORG = workflow('organization-service-deploy.yml');
  const rebuild = swap(ORG, '      - uses: appleboy/ssh-action@v1', '      - uses: docker/build-push-action@v7\n        with:\n          push: true\n          tags: ${{ env.IMAGE_NAME }}:sha-${{ github.sha }}\n      - uses: appleboy/ssh-action@v1');
  assert.match(checkDigestDeploy('o.yml', rebuild, 'nawara-core-organization-service').join(), /must never build an image/);
  assert.match(checkDigestDeploy('o.yml', ORG, 'nawara-core-audit-service').join(), /IMAGE_NAME must be fixed to the nawara-core-audit-service repository/);
  // verify's confirmation is enforced by the digest-deploy contract; deploy's (the production job) by the typed-confirmation contract
  const noConfirmVerify = swap(ORG, " && inputs.confirm == 'deploy organization-service'", '');
  assert.match(checkDigestDeploy('o.yml', noConfirmVerify, 'nawara-core-organization-service').join(), /job "verify": must require the typed confirmation/);
  const deployIf = "  deploy:\n    needs: verify\n    if: github.ref == 'refs/heads/main' && inputs.confirm == 'deploy organization-service'\n";
  const noConfirmDeploy = swap(ORG, deployIf, "  deploy:\n    needs: verify\n    if: github.ref == 'refs/heads/main'\n");
  assert.match(checkTypedConfirmation('o.yml', noConfirmDeploy, 'deploy organization-service').join(), /job "deploy": must require the typed confirmation/);
  assert.match(checkTypedConfirmation('o.yml', ORG, 'deploy audit-service').join(), /must require the typed confirmation \(inputs\.confirm == 'deploy audit-service'\)/);
});

test('A0.3 (D9): every digest deployment refuses a revision that is not a literal commit SHA before the ancestry check', () => {
  const LABEL_CHECK = '          [[ "$rev" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: no org.opencontainers.image.revision label (not a build-image artifact)" >&2; exit 1; }\n';
  for (const [name, [repository]] of Object.entries(DEPLOY_FILES)) {
    const text = workflow(name);
    assert.deepEqual(checkDigestDeploy(name, text, repository), [], name);
    // D9: the label is still extracted (the label name stays in the step) and the ancestry check stays, but the format check is gone
    const removed = swap(text, LABEL_CHECK, '');
    assert.ok(removed.includes('org.opencontainers.image.revision') && removed.includes('merge-base --is-ancestor'), name);
    assert.match(checkDigestDeploy(name, removed, repository).join(), /must be refused unless it matches \^\[0-9a-f\]\{40\}\$/, `${name}: D9`);
    // weakened variants: a looser pattern, no refusal, or the check placed after the ancestry check
    for (const weaker of [
      LABEL_CHECK.replace('{40}', '+'),
      LABEL_CHECK.replace(' >&2; exit 1; }', ' >&2; }'),
    ]) {
      assert.match(checkDigestDeploy(name, swap(text, LABEL_CHECK, weaker), repository).join(), /must be refused unless it matches/, `${name}: weaker`);
    }
    const ANC = '          git merge-base --is-ancestor "$rev" HEAD || { echo "refused: revision $rev is not an ancestor of main" >&2; exit 1; }\n';
    const after = swap(swap(text, LABEL_CHECK, ''), ANC, ANC + LABEL_CHECK);
    assert.match(checkDigestDeploy(name, after, repository).join(), /before the ancestry check/, `${name}: order`);
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

