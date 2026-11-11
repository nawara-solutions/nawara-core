// Core V2 Smart CI (Stage 1) classifier and lane-aware gate tests. Deterministic: synthetic diffs and temporary git repositories, never the
// checkout's own history (CI checks out shallow). CLASSIFY_MODULE overrides the module under test (negative controls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MOD = process.env.CLASSIFY_MODULE ?? fileURLToPath(new URL('./classify.mjs', import.meta.url));
const { classify, gate, parseRawZ, requiredJobs, ALL_JOBS, main } = await import(pathToFileURL(MOD).href);
const e = (path, status = 'M', o = {}) => ({ status, path, oldPath: null, oldMode: status === 'A' ? '000000' : '100644', newMode: status === 'D' ? '000000' : '100644', ...o });
const lane = (entries, event = 'pull_request') => classify({ event, entries }).lane;
const pr = (args) => gate({ event: 'pull_request', ...args });
const needsFor = (laneName, override = {}) => {
  const req = new Set(requiredJobs(laneName));
  return Object.fromEntries(ALL_JOBS.map((j) => [j, { result: override[j] ?? (req.has(j) ? 'success' : 'skipped') }]));
};

/** A temporary repository: `base` commit, then a branch with `changes`; returns {dir, base, head}. */
function repo(changes) {
  const dir = mkdtempSync(join(tmpdir(), 'smart-ci-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.invalid');
  git('config', 'user.name', 'ci');
  const put = (p, body = `${p}\n`) => { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), body); };
  for (const p of ['README.md', 'docs/a.md', 'docs/b.md', 'apps/billing-service/src/x.ts', 'apps/notification-service/src/n.ts', 'scripts/s.mjs']) put(p);
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  changes({ dir, put, git });
  git('add', '-A'); git('commit', '-q', '-m', 'change');
  // main moves on after the branch point: the merge base, not the base tip, defines the change
  git('checkout', '-q', 'main'); put('apps/billing-service/src/later.ts'); git('add', '-A'); git('commit', '-q', '-m', 'main later');
  const mainTip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'pr');
  return { dir, base, mainTip, head: git('rev-parse', 'HEAD'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const cli = (r, event = 'pull_request', env = {}) => {
  const out = execFileSync('node', [MOD, event, r.mainTip, r.head], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse(out);
};

test('two Markdown documents → docs', () => assert.equal(lane([e('docs/architecture/a.md'), e('docs/runbooks/b.md')]), 'docs'));
test('root and service README documents → docs', () => assert.equal(lane([e('README.md'), e('apps/notification-service/README.md')]), 'docs'));
test('any service source, even outside the financial services → full (TARGETED is not enabled)', () => {
  assert.equal(lane([e('apps/notification-service/src/x.ts')]), 'full');
});
test('Payment reconciliation and Billing source → full', () => {
  assert.equal(lane([e('apps/payment-service/src/reconciliation/reconciliation.service.ts')]), 'full');
  assert.equal(lane([e('apps/billing-service/src/refunds/refund-evidence.ts')]), 'full');
});
test('a database migration → full', () => {
  assert.equal(lane([e('apps/notification-service/db/migrations/0009_x.sql', 'A')]), 'full');
  assert.equal(lane([e('apps/billing-service/db/migrations/0056_x.sql', 'A')]), 'full');
});
test('a shared library → full', () => {
  assert.equal(lane([e('libs/service-kit/src/events/rabbitmq-event-bus.ts')]), 'full');
  assert.equal(lane([e('libs/audit-contract/src/catalog.ts')]), 'full');
});
test('a workflow, this classifier, scripts and test infrastructure → full', () => {
  assert.equal(lane([e('.github/workflows/core-ci.yml')]), 'full');
  assert.equal(lane([e('scripts/ci-lanes/classify.mjs')]), 'full');
  assert.equal(lane([e('.github/workflows/README.md')]), 'full');
  assert.equal(lane([e('test/e2e-real-broker/ci-groups.json')]), 'full');
  assert.equal(lane([e('package-lock.json')]), 'full');
});
test('an unknown file → full (only allowlisted Markdown reaches docs)', () => {
  for (const p of ['Dockerfile', '.gitattributes', '.npmrc', '.nvmrc', 'docs/a.markdown', 'docs/a.MD', 'docs/a.md.sh', 'docs/a.mdx', 'docs/.md/x.ts', 'apps/notification-service/docs/x.md', 'apps/notification-service/src/README.md', 'libs/x/README.md', 'docker-compose.yml', 'LICENSE']) {
    assert.equal(lane([e(p, 'A')]), 'full', p);
  }
  assert.equal(lane([e('tools/new-thing.sh', 'A')]), 'full');
  assert.equal(lane([e('docs/diagram.png', 'A')]), 'full');
  assert.equal(lane([e('.claude/agents/x.md')]), 'full');
});
test('mixed documentation and code → never docs', () => {
  assert.equal(lane([e('docs/a.md'), e('apps/notification-service/src/x.ts')]), 'full');
  assert.equal(lane([e('docs/a.md'), e('apps/billing-service/src/x.ts')]), 'full');
});
test('deleted and renamed files: both paths count', () => {
  assert.equal(lane([e('docs/old.md', 'D')]), 'docs');
  assert.equal(lane([{ status: 'R', oldPath: 'docs/a.md', path: 'docs/b.md', oldMode: '100644', newMode: '100644' }]), 'docs');
  assert.equal(lane([{ status: 'R', oldPath: 'apps/billing-service/src/x.ts', path: 'docs/x.md', oldMode: '100644', newMode: '100644' }]), 'full');
  assert.equal(lane([{ status: 'R', oldPath: 'docs/x.md', path: 'scripts/x.mjs', oldMode: '100644', newMode: '100644' }]), 'full');
  assert.equal(lane([e('apps/payment-service/src/x.ts', 'D')]), 'full');
});
test('documentation read by a test → full', () => assert.equal(lane([e('docs/architecture/audit-event-catalog.md')]), 'full'));
test('a documentation name cannot hide executable behavior: symlink, submodule, executable bit, mode change → full', () => {
  assert.equal(lane([e('docs/a.md', 'A', { newMode: '120000' })]), 'full');
  assert.equal(lane([e('docs/a.md', 'A', { newMode: '160000' })]), 'full');
  assert.equal(lane([e('docs/a.md', 'M', { oldMode: '100644', newMode: '100755' })]), 'full');
  assert.equal(lane([e('docs/run.md', 'A', { newMode: '100755' })]), 'full');
  assert.equal(lane([e('CONTRIBUTING.md', 'M', { oldMode: '120000', newMode: '120000' })]), 'full');
  // A renamed document that becomes executable (or a symlink) in the same change.
  assert.equal(lane([{ status: 'R', oldPath: 'docs/a.md', path: 'docs/b.md', oldMode: '100644', newMode: '100755' }]), 'full');
  assert.equal(lane([{ status: 'R', oldPath: 'docs/a.md', path: 'docs/b.md', oldMode: '100644', newMode: '120000' }]), 'full');
});
test('change detection failure → full (no entries, unknown status, unparseable diff, bad reference)', () => {
  assert.equal(lane([]), 'full');
  assert.equal(lane([e('docs/a.md', 'X')]), 'full');
  assert.throws(() => parseRawZ('garbage\0'));
  const r = repo(({ put }) => put('docs/a.md', 'changed\n'));
  try {
    const out = JSON.parse(execFileSync('node', [MOD, 'pull_request', 'no-such-ref', r.head], { cwd: r.dir, encoding: 'utf8' }));
    assert.equal(out.lane, 'full');
    assert.match(out.reasons[0], /change detection failed/);
  } finally { r.cleanup(); }
});
test('only a pull request may be reduced: push, merge_group, dispatch and schedule → full', () => {
  for (const ev of ['push', 'merge_group', 'workflow_dispatch', 'schedule']) assert.equal(lane([e('docs/a.md')], ev), 'full');
  assert.equal(main(['push', 'a', 'b'], {}).lane, 'full');
});
test('CI_FORCE_FULL=1 forces full', () => {
  const r = repo(({ put }) => put('docs/a.md', 'changed\n'));
  try {
    assert.equal(cli(r).lane, 'docs');
    assert.equal(cli(r, 'pull_request', { CI_FORCE_FULL: '1' }).lane, 'full');
  } finally { r.cleanup(); }
});
test('git: the change is measured from the MERGE BASE (main moving on adds nothing), with renames, deletions and modes', () => {
  const cases = [
    ['a documentation edit', ({ put }) => put('docs/a.md', 'changed\n'), 'docs'],
    ['a documentation rename and a deletion', ({ git }) => { git('mv', 'docs/a.md', 'docs/c.md'); git('rm', '-q', 'docs/b.md'); }, 'docs'],
    ['a code file renamed into docs', ({ git }) => git('mv', 'apps/notification-service/src/n.ts', 'docs/n.md'), 'full'],
    ['a deleted billing file', ({ git }) => git('rm', '-q', 'apps/billing-service/src/x.ts'), 'full'],
    ['a docs symlink', ({ dir }) => symlinkSync('../scripts/s.mjs', join(dir, 'docs/link.md')), 'full'],
    ['an executable docs file', ({ put, dir }) => { put('docs/run.md'); chmodSync(join(dir, 'docs/run.md'), 0o755); }, 'full'],
    ['a classifier change', ({ put }) => put('scripts/ci-lanes/classify.mjs', '// x\n'), 'full'],
    ['a classifier change hidden among documentation', ({ put }) => { put('docs/a.md', 'changed\n'); put('scripts/ci-lanes/classify.mjs', '// x\n'); }, 'full'],
    ['a documentation rename that becomes executable', ({ git, dir }) => { git('mv', 'docs/a.md', 'docs/c.md'); chmodSync(join(dir, 'docs/c.md'), 0o755); }, 'full'],
    ['a workflow change', ({ put }) => put('.github/workflows/core-ci.yml', 'x: 1\n'), 'full'],
  ];
  for (const [name, change, want] of cases) {
    const r = repo(change);
    try { assert.equal(cli(r).lane, want, name); } finally { r.cleanup(); }
  }
});
test('gate: docs passes only with the required jobs succeeded and every other job SKIPPED', () => {
  assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: needsFor('docs') }).ok, true);
  assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: needsFor('docs', { 'repo-checks': 'skipped' }) }).ok, false);
  assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: needsFor('docs', { 'repo-checks': 'failure' }) }).ok, false);
  assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: needsFor('docs', { 'repo-checks': 'cancelled' }) }).ok, false);
  // A job outside the docs lane that ran, whatever its result, is not silently ignored.
  for (const result of ['failure', 'cancelled', 'success']) assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: needsFor('docs', { node: result }) }).ok, false, result);
});
test('gate: full requires every job succeeded; a classification failure, unknown lane, missing or unknown job fails', () => {
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: needsFor('full') }).ok, true);
  for (const job of ALL_JOBS) {
    for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
      assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: needsFor('full', { [job]: result ?? 'missing' }) }).ok, false, `${job} ${result}`);
    }
  }
  assert.equal(pr({ lane: 'docs', classifyResult: 'failure', needs: needsFor('docs') }).ok, false);
  assert.equal(pr({ lane: 'docs', classifyResult: undefined, needs: needsFor('docs') }).ok, false);
  const missing = needsFor('full'); delete missing.images;
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: missing }).ok, false);
  const noClassify = needsFor('docs'); delete noClassify.classify;
  assert.equal(pr({ lane: 'docs', classifyResult: 'success', needs: noClassify }).ok, false);
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: { ...needsFor('full'), surprise: { result: 'success' } } }).ok, false);
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: null }).ok, false);
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: [] }).ok, false);
});
test('gate: a forged or malformed lane cannot pass', () => {
  for (const forged of ['targeted', 'DOCS', 'docs ', 'Full', '', null, undefined, 1, ['docs'], { lane: 'docs' }]) {
    assert.equal(pr({ lane: forged, classifyResult: 'success', needs: needsFor('docs') }).ok, false, JSON.stringify(forged));
  }
});
test('gate: a reduced job set cannot pass as full', () => {
  assert.equal(pr({ lane: 'full', classifyResult: 'success', needs: needsFor('docs') }).ok, false);
});
test('gate: a push (or any non-pull-request event) and CI_FORCE_FULL=1 can only be full', () => {
  for (const event of ['push', 'merge_group', 'workflow_dispatch', 'schedule', '', undefined]) {
    assert.equal(gate({ event, lane: 'docs', classifyResult: 'success', needs: needsFor('docs') }).ok, false, String(event));
  }
  assert.equal(gate({ event: 'push', lane: 'full', classifyResult: 'success', needs: needsFor('full') }).ok, true);
  assert.equal(gate({ event: undefined, lane: 'full', classifyResult: 'success', needs: needsFor('full') }).ok, false);
  assert.equal(pr({ lane: 'docs', forceFull: '1', classifyResult: 'success', needs: needsFor('docs') }).ok, false);
  assert.equal(pr({ lane: 'full', forceFull: '1', classifyResult: 'success', needs: needsFor('full') }).ok, true);
});
