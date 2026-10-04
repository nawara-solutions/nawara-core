// V2-A.2, extended by V2 A0: executes the REAL shell steps of every digest-deployment workflow (auth-service, organization-service,
// audit-service: digest validation and artifact verification) against a fake docker CLI and a throwaway git history, so a loosened
// regex or a dropped revision/ancestry check fails here, not in production. Nothing here touches a registry, a server or the real
// repository. (The file keeps its V2-A.2 name for traceability.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ROOT } from './lib/harness.mjs';

const SERVICES = ['auth-service', 'organization-service', 'audit-service'];
// V2 A14: the image workflow that must have signed each service's provenance.
const SIGNER = { 'auth-service': 'auth-service-docker-build.yml', 'organization-service': 'organization-service-image.yml', 'audit-service': 'audit-service-image.yml' };
const REPO = 'nawara-solutions/nawara-core';
const digest = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;

function bash(script, env, cwd = tmpdir()) {
  const r = spawnSync('bash', ['-c', script], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A git history with one main commit (an ancestor of HEAD) and one side commit (e.g. a PR merge ref) that is not. */
function history() {
  const dir = mkdtempSync(join(tmpdir(), 'v2a2-git-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'earlier main');
  const earlier = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  git('commit', '-q', '--allow-empty', '-m', 'pull request build');
  const side = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'current main');
  return { dir, earlier, side, head: git('rev-parse', 'HEAD') };
}

/** A fake `docker` that knows a set of digests in ONE image repository and answers `buildx imagetools inspect`. */
function fakeDocker(images, IMAGE_NAME) {
  const bin = mkdtempSync(join(tmpdir(), 'v2a2-bin-'));
  writeFileSync(join(bin, 'images.json'), JSON.stringify(images));
  const script = `#!/usr/bin/env node
const images = require(${JSON.stringify(join(bin, 'images.json'))});
const a = process.argv.slice(2);
if (a[0] !== 'buildx' || a[1] !== 'imagetools' || a[2] !== 'inspect') { console.error('unexpected docker call: ' + a.join(' ')); process.exit(2); }
const ref = a[3];
const image = ref.startsWith(${JSON.stringify(`${IMAGE_NAME}@`)}) ? images[ref.split('@')[1]] : undefined;
if (!image) { console.error('ERROR: ' + ref + ': not found'); process.exit(1); }
if (a[4] === '--format') { if (a[5] !== '{{json .Image}}') process.exit(3); process.stdout.write(JSON.stringify(image)); }
`;
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

const labelled = (rev) => ({ architecture: 'amd64', os: 'linux', config: { Labels: { 'org.opencontainers.image.revision': rev } } });

/**
 * V2 A14: a fake `gh` that behaves like `gh attestation verify` (gh 2.86, verified against a real public attestation in A14.2): it looks
 * up the attestations stored for the digest of `oci://<IMAGE_NAME>@<digest>`, enforces --repo, --signer-workflow, --source-ref,
 * --source-digest, --predicate-type and --deny-self-hosted-runners exactly, and prints the documented JSON array
 * ({attestation, verificationResult: {statement, signature.certificate, …}}). `mode` simulates a broken or hostile gh.
 */
function fakeGh(atts, IMAGE_NAME, mode, bin) {
  writeFileSync(join(bin, 'atts.json'), JSON.stringify({ atts, mode: mode ?? null }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const { atts, mode } = JSON.parse(fs.readFileSync(${JSON.stringify(join(bin, 'atts.json'))}, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(bin, 'gh-calls.jsonl'))}, JSON.stringify(a) + '\\n');
const opt = (n) => { const k = a.indexOf(n); return k >= 0 ? a[k + 1] : undefined; };
if (a[0] !== 'attestation' || a[1] !== 'verify') { console.error('unexpected gh call'); process.exit(2); }
if (mode === 'exit') { console.error('Error: failed to fetch attestations (simulated outage)'); process.exit(1); }
if (mode === 'timeout') process.exit(124);
const subj = a[2] || '';
const prefix = ${JSON.stringify(`oci://${IMAGE_NAME}@`)};
const digest = subj.startsWith(prefix) ? subj.slice(prefix.length) : null;
const found = (digest && atts[digest]) || [];
if (found.length === 0) { console.error('Error: HTTP 404: Not Found (attestations for ' + (digest || subj) + ')'); process.exit(1); }
const ok = found.filter((t) => t.repo === opt('--repo') && t.repo + '/.github/workflows/' + t.workflow === opt('--signer-workflow')
  && t.ref === opt('--source-ref') && t.commit === opt('--source-digest') && (t.predicate || 'https://slsa.dev/provenance/v1') === opt('--predicate-type')
  && (!a.includes('--deny-self-hosted-runners') || t.runner === 'github-hosted'));
if (ok.length === 0) { console.error('Error: verifying with issuer "sigstore.dev": no attestation matched the policy'); process.exit(1); }
const out = ok.map((t) => ({ attestation: { bundle: {} }, verificationResult: {
  mediaType: 'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
  statement: { _type: 'https://in-toto.io/Statement/v1', predicateType: t.predicate || 'https://slsa.dev/provenance/v1',
    subject: [{ name: ${JSON.stringify(IMAGE_NAME)}, digest: { sha256: (mode === 'otherSubject' ? 'e'.repeat(64) : digest.slice(7)) } }] },
  signature: { certificate: { issuer: 'https://token.actions.githubusercontent.com',
    buildSignerURI: 'https://github.com/' + t.repo + '/.github/workflows/' + (mode === 'otherSigner' ? 'core-ci.yml' : t.workflow) + '@' + t.ref,
    sourceRepositoryURI: 'https://github.com/' + t.repo, sourceRepositoryRef: t.ref, sourceRepositoryDigest: t.commit, runnerEnvironment: t.runner } },
  verifiedTimestamps: [{ type: 'Tlog' }] } }));
if (mode === 'malformed') { process.stdout.write('[{"verificationResult": '); process.exit(0); }
if (mode === 'empty') { process.stdout.write('[]'); process.exit(0); }
if (mode === 'object') { process.stdout.write(JSON.stringify(out[0])); process.exit(0); }
process.stdout.write(JSON.stringify(out));
`);
  chmodSync(join(bin, 'gh'), 0o755);
}

/** The trusted attestation of a main build of `svc` at `commit` for `d` (overridable per case). */
const trusted = (svc, commit, over = {}) => ({ repo: REPO, workflow: SIGNER[svc], ref: 'refs/heads/main', commit, runner: 'github-hosted', ...over });

function runVerify(VERIFY, IMAGE_NAME, images, ref, atts, mode) {
  const h = history();
  const bin = fakeDocker(typeof images === 'function' ? images(h) : images, IMAGE_NAME);
  fakeGh(typeof atts === 'function' ? atts(h) : (atts ?? {}), IMAGE_NAME, mode, bin);
  const summary = join(h.dir, 'summary.md');
  const output = join(h.dir, 'output.txt');
  const r = bash(VERIFY, { PATH: `${bin}:${process.env.PATH}`, REF: ref, GH_TOKEN: 'fake-token', GITHUB_SHA: h.head, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output }, h.dir);
  const calls = existsSync(join(bin, 'gh-calls.jsonl')) ? readFileSync(join(bin, 'gh-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...r, h, calls, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '', output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

for (const svc of SERVICES) {
  const workflow = parse(readFileSync(join(ROOT, `.github/workflows/${svc}-deploy.yml`), 'utf8'));
  // V2-A.3 (A3.5): validation and artifact verification run in the `verify` job, before the production approval.
  const steps = workflow.jobs.verify.steps;
  const stepRun = (name) => {
    const step = steps.find((s) => s.name === name);
    assert.ok(step?.run, `step "${name}" not found in ${svc}-deploy.yml`);
    return step.run;
  };
  const VALIDATE = stepRun('validate the digest');
  const VERIFY = stepRun('verify the artifact');
  const IMAGE_NAME = `ghcr.io/nawara-solutions/nawara-core-${svc}`;
  // By default every labelled image carries the trusted attestation of a main build at its label's commit (V2 A14); a case may
  // replace the attestations (`atts`: digest → [attestation]) or make gh misbehave (`mode`).
  const autoAtts = (imgs) => Object.fromEntries(Object.entries(imgs).map(([d, im]) => {
    const rev = (im.config ?? im['linux/amd64']?.config)?.Labels?.['org.opencontainers.image.revision'];
    return [d, rev ? [trusted(svc, rev)] : []];
  }));
  const verify = (images, ref, atts, mode) => runVerify(VERIFY, IMAGE_NAME, images, ref,
    atts ?? ((h) => autoAtts(typeof images === 'function' ? images(h) : images)), mode);

  test(`${svc}: the deploy job re-checks the digest with the very same validation before its SSH step`, () => {
    const recheck = workflow.jobs.deploy.steps.find((s) => s.name === 'validate the digest');
    assert.equal(recheck?.run, VALIDATE);
  });

  test(`${svc}: digest validation accepts exactly sha256:<64 lowercase hex>`, () => {
    assert.equal(bash(VALIDATE, { DIGEST: digest('0a') }).code, 0);
  });

  test(`${svc}: digest validation refuses every malformed or hostile value, and never evaluates it`, () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'v2a2-')), 'pwned');
    const bad = [
      '', 'sha256:', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(64)}`,
      `${'a'.repeat(64)}`, 'production', ':production', `${IMAGE_NAME}@${digest('0a')}`, `${digest('0a')}\n`, ` ${digest('0a')}`,
      `sha256:$(touch ${marker})${'a'.repeat(40)}`, `${digest('0a')}; touch ${marker}`,
    ];
    for (const value of bad) assert.notEqual(bash(VALIDATE, { DIGEST: value }).code, 0, `accepted: ${JSON.stringify(value)}`);
    assert.equal(existsSync(marker), false, 'an input was evaluated by the shell');
  });

  test(`${svc}: artifact verification accepts a revision-labelled image whose revision is the current main`, () => {
    const r = verify((h) => ({ [digest('1b')]: labelled(h.head) }), `${IMAGE_NAME}@${digest('1b')}`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.summary, new RegExp(`index digest: \`${digest('1b')}\``));
    assert.match(r.summary, new RegExp(`revision: \`${r.h.head}\``));
    assert.equal(r.output, `revision=${r.h.head}\n`, 'the only output handed to the deploy job is the verified revision');
  });

  test(`${svc}: artifact verification accepts an EARLIER main artifact (rollback to a labelled main build, OD-4)`, () => {
    const r = verify((h) => ({ [digest('2c')]: labelled(h.earlier) }), `${IMAGE_NAME}@${digest('2c')}`);
    assert.equal(r.code, 0, r.out);
  });

  test(`${svc}: artifact verification accepts the multi-platform shape (linux/amd64 entry)`, () => {
    const r = verify((h) => ({ [digest('3d')]: { 'linux/amd64': labelled(h.head), 'linux/arm64': labelled(h.head) } }), `${IMAGE_NAME}@${digest('3d')}`);
    assert.equal(r.code, 0, r.out);
  });

  test(`${svc}: artifact verification refuses a digest that does not exist in the ${svc} repository`, () => {
    const r = verify({}, `${IMAGE_NAME}@${digest('4e')}`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`does not exist in the ${svc} repository`));
    assert.equal(r.summary, '');
  });

  test(`${svc}: artifact verification refuses an unlabelled (legacy) image, OD-3`, () => {
    const r = verify({ [digest('5f')]: { architecture: 'amd64', os: 'linux', config: { Labels: null } } }, `${IMAGE_NAME}@${digest('5f')}`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no org\.opencontainers\.image\.revision label/);
  });

  test(`${svc}: artifact verification refuses an image whose revision is not on main (a pull-request build such as :develop)`, () => {
    const r = verify((h) => ({ [digest('6a')]: labelled(h.side) }), `${IMAGE_NAME}@${digest('6a')}`);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /is not an ancestor of main/);
  });

  test(`${svc}: artifact verification refuses a malformed or unknown revision label`, () => {
    for (const rev of ['main', 'abc', `${'0'.repeat(40)}`, `$(id)`]) {
      const r = verify({ [digest('7b')]: labelled(rev) }, `${IMAGE_NAME}@${digest('7b')}`);
      assert.notEqual(r.code, 0, `accepted revision ${rev}`);
    }
  });

  test(`${svc}: artifact verification refuses a digest from ANOTHER service's repository`, () => {
    const other = SERVICES.find((x) => x !== svc);
    const r = verify((h) => ({ [digest('8c')]: labelled(h.head) }), `ghcr.io/nawara-solutions/nawara-core-${other}@${digest('8c')}`);
    assert.notEqual(r.code, 0);
  });

  // ------------------------------------------------------------------ V2 A14: the trusted provenance of the exact digest
  const D = digest('9a');
  const ref = `${IMAGE_NAME}@${D}`;
  const img = (h) => ({ [D]: labelled(h.head) });

  test(`${svc}: A14: the trusted main-build provenance of the exact digest is verified with the exact identity, then accepted`, () => {
    const r = verify(img, ref);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.calls, [['attestation', 'verify', `oci://${ref}`, '--repo', REPO, '--signer-workflow', `${REPO}/.github/workflows/${SIGNER[svc]}`,
      '--source-ref', 'refs/heads/main', '--source-digest', r.h.head, '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners', '--format', 'json']]);
    assert.match(r.summary, new RegExp(`provenance verified: ${SIGNER[svc].replace(/[.]/g, '\\.')}@refs/heads/main`));
  });

  for (const [label, atts, mode, re] of [
    ['no attestation (a legacy or unattested image)', () => ({}), undefined, /no trusted build provenance/],
    ['an attestation from another repository', (h) => ({ [D]: [trusted(svc, h.head, { repo: 'nawara-solutions/other' })] }), undefined, /no trusted build provenance/],
    ['an attestation signed by another workflow', (h) => ({ [D]: [trusted(svc, h.head, { workflow: 'core-ci.yml' })] }), undefined, /no trusted build provenance/],
    ['a pull-request build (refs/pull/1/merge)', (h) => ({ [D]: [trusted(svc, h.head, { ref: 'refs/pull/1/merge' })] }), undefined, /no trusted build provenance/],
    ['another branch (refs/heads/develop)', (h) => ({ [D]: [trusted(svc, h.head, { ref: 'refs/heads/develop' })] }), undefined, /no trusted build provenance/],
    ['provenance of another commit than the label', (h) => ({ [D]: [trusted(svc, h.earlier)] }), undefined, /no trusted build provenance/],
    ['a self-hosted runner', (h) => ({ [D]: [trusted(svc, h.head, { runner: 'self-hosted' })] }), undefined, /no trusted build provenance/],
    ['another predicate (an SBOM only)', (h) => ({ [D]: [trusted(svc, h.head, { predicate: 'https://spdx.dev/Document' })] }), undefined, /no trusted build provenance/],
    ['an attestation for another digest only', (h) => ({ [digest('9b')]: [trusted(svc, h.head)] }), undefined, /no trusted build provenance/],
    ['gh failing (attestation service unavailable)', undefined, 'exit', /no trusted build provenance/],
    ['gh timing out', undefined, 'timeout', /no trusted build provenance/],
    ['malformed JSON', undefined, 'malformed', /verified provenance does not describe/],
    ['an empty result', undefined, 'empty', /verified provenance does not describe/],
    ['an unexpected structure (an object, not an array)', undefined, 'object', /verified provenance does not describe/],
    ['a result for another subject digest', undefined, 'otherSubject', /verified provenance does not describe/],
    ['a result signed by another workflow', undefined, 'otherSigner', /verified provenance does not describe/],
  ]) {
    test(`${svc}: A14: refused (fail closed) when ${label}`, () => {
      const r = verify(img, ref, atts, mode);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, re);
      assert.equal(r.output, '', 'no revision is handed to the deploy job');
      assert.equal(r.summary, '', 'nothing is reported as verified');
    });
  }

  test(`${svc}: A14: an unlabelled legacy image is refused before any provenance lookup; ancestry still applies after it`, () => {
    const legacy = verify({ [D]: { architecture: 'amd64', os: 'linux', config: { Labels: null } } }, ref);
    assert.notEqual(legacy.code, 0); assert.deepEqual(legacy.calls, [], 'no gh call for an unlabelled image');
    const side = verify((h) => ({ [D]: labelled(h.side) }), ref);
    assert.notEqual(side.code, 0); assert.match(side.out, /is not an ancestor of main/, 'a valid provenance of a commit off main is still refused');
  });
}
