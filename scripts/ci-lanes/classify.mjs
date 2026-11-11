// Core V2 Smart CI (Stage 0, SHADOW). Classifies a pull request's changes into the lane Core CI COULD use: `docs` or `full`. In Stage 0 the
// lane is only reported: every Core CI job still runs and `core-ci-passed` still requires every job to succeed. Fail-closed: anything not
// proven documentation is `full`; any error is `full`.
//
// SELF-CONTAINED ON PURPOSE: Core CI runs this file from the pull request's BASE commit (`git show <base>:scripts/ci-lanes/classify.mjs`), so a
// pull request can never select its own classifier. It therefore imports Node built-ins only.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANES = ['docs', 'full'];

/** Documentation that nothing executes, by exact path shape. Markdown only. */
const DOCS_ALLOW = [/^docs\/.+\.md$/, /^[^/]+\.md$/, /^(apps|libs)\/[^/]+\/README\.md$/];
/** Markdown a test reads: not inert, so it is `full`. (Runbooks read by `test:deploy` and service READMEs read by `check:repo` are checked by
 * the repository checks, which every lane runs, so they stay documentation.) */
export const DOCS_CONSUMED = new Map([
  ['docs/architecture/audit-event-catalog.md', 'libs/audit-contract test/catalog.spec.ts compares the catalog with this document'],
]);
/** Always `full`: CI workflows and this classifier, scripts, test infrastructure, infrastructure, shared libraries, dependency manifests,
 * migrations, and the financial, authentication, authorization and audit services. Everything not proven documentation is `full` anyway. */
const ALWAYS_FULL = [
  /^\.github\//, /^scripts\//, /^test\//, /^infra\//, /^libs\//, /(^|\/)package(-lock)?\.json$/, /\/db\/migrations\//,
  /^apps\/(payment|billing|auth|audit|organization)-service\//,
];

/** Core CI's jobs other than the aggregate (check:repo verifies this list equals the workflow's). */
export const ALL_JOBS = ['classify', 'repo-checks', 'node', 'images', 'infra', 'e2e-real-broker-plan', 'e2e-real-broker', 'e2e-real-broker-verify',
  'e2e-auth-organization', 'e2e-shared-platform'];

/** The jobs a lane requires. `full` is every job. Stage 0 enforces `full` always; `docs` is defined and tested for a later stage only. */
export function requiredJobs(lane) {
  if (lane === 'docs') return ['classify', 'repo-checks'];
  if (lane === 'full') return [...ALL_JOBS];
  throw new Error(`unknown lane ${lane}`);
}

/** Parse `git diff --raw -M -z --no-abbrev`. Throws on anything unexpected. */
export function parseRawZ(text) {
  const parts = text.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const out = [];
  for (let i = 0; i < parts.length;) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([ACDMRTUX])(\d*)$/.exec(parts[i++]);
    if (!m) throw new Error(`unparseable diff header: ${JSON.stringify(parts[i - 1])}`);
    const [, oldMode, newMode, status] = m;
    const entry = status === 'R' || status === 'C'
      ? { status, oldPath: parts[i++], path: parts[i++], oldMode, newMode }
      : { status, oldPath: null, path: parts[i++], oldMode, newMode };
    if (entry.path === undefined || (entry.oldPath === undefined)) throw new Error('truncated diff');
    out.push(entry);
  }
  return out;
}

/** The decision for one event and its changed entries (the pull request's changes against its merge base). */
export function classify({ event, entries }) {
  const full = (why) => ({ lane: 'full', reasons: [why], required: requiredJobs('full') });
  if (event !== 'pull_request') return full(`event ${event}: only a pull request may use a reduced lane`);
  if (!Array.isArray(entries) || entries.length === 0) return full('no changed files detected: fail closed');
  const paths = [];
  for (const e of entries) {
    if (!['A', 'M', 'D', 'R', 'C'].includes(e.status)) return full(`unsupported change status ${e.status} on ${e.path}`);
    if ([e.oldMode, e.newMode].some((mode) => mode === '120000' || mode === '160000')) return full(`symlink or submodule change: ${e.path}`);
    if (e.oldMode !== '000000' && e.newMode !== '000000' && e.oldMode !== e.newMode) return full(`mode change: ${e.path}`);
    if ([e.oldMode, e.newMode].includes('100755')) return full(`executable file: ${e.path}`);
    paths.push(e.path, ...(e.oldPath ? [e.oldPath] : []));
  }
  const unique = [...new Set(paths)];
  for (const p of unique) if (ALWAYS_FULL.some((re) => re.test(p))) return full(`always-full path: ${p}`);
  for (const p of unique) if (DOCS_CONSUMED.has(p)) return full(`documentation read by a test: ${p} (${DOCS_CONSUMED.get(p)})`);
  const notDocs = unique.find((p) => !DOCS_ALLOW.some((re) => re.test(p)));
  if (notDocs !== undefined) return full(`not documentation: ${notDocs}`);
  return { lane: 'docs', reasons: [`${unique.length} documentation file(s) only`], required: requiredJobs('docs') };
}

/** The lane-aware verdict a later stage's `core-ci-passed` would apply (NOT used by CI in Stage 0): the classification succeeded, the lane is
 * known, every job the lane requires succeeded, and every other job was skipped. A failed, cancelled, missing or unknown job fails. */
export function gate({ lane, classifyResult, needs }) {
  const lines = [];
  if (classifyResult !== 'success') return { ok: false, lines: [`classify: ${classifyResult}`] };
  if (!LANES.includes(lane)) return { ok: false, lines: [`unknown lane ${lane}`] };
  const required = new Set(requiredJobs(lane));
  let ok = true;
  for (const job of ALL_JOBS) {
    const result = needs?.[job]?.result;
    const want = required.has(job) ? 'success' : 'skipped';
    lines.push(`${job}: ${result ?? 'missing'} (lane ${lane} requires ${want})`);
    if (result !== want) ok = false;
  }
  for (const job of Object.keys(needs ?? {})) if (!ALL_JOBS.includes(job)) { ok = false; lines.push(`${job}: not a known job`); }
  return { ok, lines };
}

/** The changed entries of `head` against its merge base with `base`, from git. Throws on any git failure. */
export function changedEntries(base, head, cwd = process.cwd()) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const mergeBase = git(['merge-base', base, head]).trim();
  return parseRawZ(git(['diff', '--raw', '-M', '-z', '--no-abbrev', mergeBase, head]));
}

/** CLI: `node classify.mjs <event> <base> <head>` prints one JSON line. CI_FORCE_FULL=1 forces `full`. Any failure is `full`, never `docs`. */
export function main(argv, env) {
  const [event, base, head] = argv;
  if (env.CI_FORCE_FULL === '1') return { lane: 'full', reasons: ['CI_FORCE_FULL=1 (emergency override)'], required: requiredJobs('full') };
  try {
    if (event !== 'pull_request') return classify({ event, entries: [] });
    return classify({ event, entries: changedEntries(base, head) });
  } catch (e) {
    return { lane: 'full', reasons: [`change detection failed: ${String(e?.message ?? e).split('\n')[0]}`], required: requiredJobs('full') };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2), process.env))}\n`);
}
