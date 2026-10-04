import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CI_AGGREGATE, PRODUCTION_GROUP, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkDigestDeploy, checkHierarchyFixtures, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety } from './lib/checks.mjs';

const deploy = ({ script = 'set -euo pipefail\ndocker pull "$IMAGE"', concurrency = `concurrency:\n      group: ${PRODUCTION_GROUP}\n      cancel-in-progress: false`, guard = "if: github.ref == 'refs/heads/main'", push = 'workflow_dispatch:' } = {}) => `
name: d
on:
  ${push}
jobs:
  deploy:
    ${guard}
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

test('A: an SSH deployment on push (or any automatic event) is refused; dispatch and schedule are allowed', () => {
  for (const event of ['push:\n    branches: [main]', 'pull_request:\n    branches: [main]', 'workflow_run:\n    workflows: [x]']) {
    assert.match(checkWorkflowSafety('d.yml', deploy({ push: event })).join(), /must only run on workflow_dispatch or schedule, never automatically/);
  }
  assert.deepEqual(checkWorkflowSafety('d.yml', deploy({ push: 'schedule:\n    - cron: "0 2 * * *"' })), []);
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
  const loose = swap(DEPLOY, '^sha256:[0-9a-f]{64}$ ]] || { echo "refused: the digest must', '^sha256:.+$ ]] || { echo "refused: the digest must');
  assert.match(checkDigestDeploy('d.yml', loose, AUTH).join(), /must be validated against/);
  const late = swap(swap(DEPLOY, `      - name: validate the digest
        env:
          DIGEST: \${{ inputs.digest }}
        run: |
          set -euo pipefail
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "refused: the digest must be sha256:<64 lowercase hex>" >&2; exit 1; }
`, ''), '      - uses: appleboy/ssh-action@v1', `      - name: validate the digest
        env:
          DIGEST: \${{ inputs.digest }}
        run: |
          set -euo pipefail
          [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
      - uses: appleboy/ssh-action@v1`);
  assert.match(checkDigestDeploy('d.yml', late, AUTH).join(), /validated .* before any registry or SSH step/);
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

