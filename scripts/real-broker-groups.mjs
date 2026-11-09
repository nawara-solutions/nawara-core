#!/usr/bin/env node
// Core V2 A1: the real-broker suites run in Core CI as explicitly assigned groups, each in its own job (own runner, PostgreSQL,
// RabbitMQ, ports, broker users and queues), the suites of a group in sequence. This module is the fail-closed guard around that
// split. Node built-ins only (the plan and verify jobs run it without npm ci).
//
//   plan                 validate the manifest against the discovered suites; print the matrix (`matrix=<json>`, for $GITHUB_OUTPUT)
//   run <group> <dir>    validate again, run the group's suites (npm run test:e2e -w @nawara/e2e-real-broker, unchanged config) with a
//                        JUnit report, then refuse a report that does not hold exactly the group's suites; writes <dir>/<group>.junit.xml
//                        and <dir>/<group>.timing.json
//   verify <dir>         every group's report present once; together they hold every discovered suite exactly once; every test passed,
//                        none failed, errored or skipped; a per-suite timing table (and $GITHUB_STEP_SUMMARY when set)
//
// The guard never fixes an expected test count: a suite added with tests is accepted once it is assigned to a group, and a suite that
// runs no test, or a skipped test, is refused.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUITE_DIR = 'test/e2e-real-broker';
export const MANIFEST = `${SUITE_DIR}/ci-groups.json`;
export const VITEST_CONFIG = `${SUITE_DIR}/vitest.config.ts`;
const SPEC = /\.e2e-spec\.ts$/;
const SUITE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.e2e-spec\.ts$/;
const GROUP_ID = /^[a-z][a-z0-9-]{0,30}$/;

/** Every *.e2e-spec.ts under the suite directory (vitest's include '**\/*.e2e-spec.ts', node_modules and .git excluded), sorted. */
export function discoverSuites(root = REPO_ROOT) {
  const base = join(root, SUITE_DIR);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (SPEC.test(name)) found.push(relative(base, p).split(sep).join('/'));
    }
  };
  walk(base);
  return found.sort();
}

/**
 * The discovery above mirrors the vitest configuration; if that configuration changes what it includes, or lets files run in
 * parallel inside one job, this refuses until the guard is reviewed with it.
 */
export function checkVitestConfig(text) {
  const problems = [];
  const include = [...text.matchAll(/include:\s*\[([^\]]*)\]/g)].map((m) => m[1].trim());
  if (include.length !== 1 || include[0] !== "'**/*.e2e-spec.ts'") {
    problems.push(`${VITEST_CONFIG}: include must be exactly ['**/*.e2e-spec.ts'] (the suite discovery of ${MANIFEST} mirrors it)`);
  }
  if (/\bexclude\s*:/.test(text)) problems.push(`${VITEST_CONFIG}: an exclude list would make the discovery of ${MANIFEST} wrong`);
  if (!/fileParallelism:\s*false/.test(text)) problems.push(`${VITEST_CONFIG}: fileParallelism must stay false (a group's suites run in sequence)`);
  return problems;
}

/** The manifest's shape, and every discovered suite in exactly one group, nothing else. */
export function checkManifest(manifest, discovered) {
  const problems = [];
  const groups = manifest?.groups;
  if (!Array.isArray(groups) || groups.length === 0) return [`${MANIFEST}: needs a non-empty "groups" list`];
  const ids = new Set();
  const seen = new Map(); // suite -> group
  for (const [i, g] of groups.entries()) {
    const id = g?.id;
    if (typeof id !== 'string' || !GROUP_ID.test(id)) { problems.push(`${MANIFEST}: group ${i + 1} needs an id matching ${GROUP_ID}`); continue; }
    if (ids.has(id)) problems.push(`${MANIFEST}: group id "${id}" appears twice`);
    ids.add(id);
    if (!Array.isArray(g.suites) || g.suites.length === 0) { problems.push(`${MANIFEST}: group "${id}" has no suites`); continue; }
    for (const s of g.suites) {
      if (typeof s !== 'string' || !SUITE_PATH.test(s) || s.split('/').includes('..')) { problems.push(`${MANIFEST}: group "${id}": "${s}" is not a suite path`); continue; }
      if (seen.has(s)) problems.push(`${MANIFEST}: ${s} is assigned twice (groups "${seen.get(s)}" and "${id}")`);
      else seen.set(s, id);
    }
  }
  const known = new Set(discovered);
  for (const s of seen.keys()) if (!known.has(s)) problems.push(`${MANIFEST}: ${s} does not exist (an unknown or removed suite)`);
  for (const s of discovered) if (!seen.has(s)) problems.push(`${MANIFEST}: ${s} is in no group: Core CI would never run it (assign it to one group)`);
  // vitest selects files by substring: a suite path inside another suite's path would also select that other suite.
  for (const a of discovered) for (const b of discovered) if (a !== b && b.includes(a)) problems.push(`${SUITE_DIR}: ${a} is a substring of ${b}: a group's file filter would select both`);
  return problems;
}

export function loadManifest(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
}

/** All static problems of the split at `root`: the configuration, then the manifest against the discovered suites. */
export function checkRealBrokerGroups(root = REPO_ROOT) {
  let manifest;
  try { manifest = loadManifest(root); } catch (e) { return [`${MANIFEST}: unreadable (${e instanceof Error ? e.message : String(e)})`]; }
  return [...checkVitestConfig(readFileSync(join(root, VITEST_CONFIG), 'utf8')), ...checkManifest(manifest, discoverSuites(root))];
}

export const PLAN_JOB = 'e2e-real-broker-plan';
export const GROUP_JOB = 'e2e-real-broker';
export const VERIFY_JOB = 'e2e-real-broker-verify';
const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const expr = (v) => String(v ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();

/**
 * The Core CI jobs around the split (`doc`: the parsed core-ci.yml): the matrix comes only from the plan job's validated output; each
 * group job runs its suites only through this guard, on its own PostgreSQL and RabbitMQ, and always uploads its report; the verify job
 * always runs and checks every report. Nothing in them may turn a failure into a success.
 */
export function checkRealBrokerJobs(doc) {
  const problems = [];
  const jobs = doc?.jobs ?? {};
  const where = (id) => `core-ci.yml job "${id}"`;
  const runs = (job, re) => asList(job?.steps).filter((s) => re.test(String(s?.run ?? '')));
  for (const id of [PLAN_JOB, GROUP_JOB, VERIFY_JOB]) {
    const job = jobs[id];
    if (!job) { problems.push(`${where(id)} is missing (the real-broker split needs the plan, group and verify jobs)`); continue; }
    if ('continue-on-error' in job || asList(job.steps).some((s) => s && 'continue-on-error' in s)) problems.push(`${where(id)}: must not continue on error`);
    if (asList(job.steps).some((s) => /\|\|\s*(true|:)\s*$/m.test(String(s?.run ?? '')))) problems.push(`${where(id)}: a step swallows its failure ("|| true")`);
  }
  const plan = jobs[PLAN_JOB];
  if (plan) {
    const step = runs(plan, /^node scripts\/real-broker-groups\.mjs plan >> "\$GITHUB_OUTPUT"$/);
    if (step.length !== 1 || step[0].id !== 'plan') problems.push(`${where(PLAN_JOB)}: exactly one step (id "plan") must run: node scripts/real-broker-groups.mjs plan >> "$GITHUB_OUTPUT"`);
    if (expr(plan.outputs?.matrix) !== 'steps.plan.outputs.matrix') problems.push(`${where(PLAN_JOB)}: outputs.matrix must be the plan step's output`);
  }
  const group = jobs[GROUP_JOB];
  if (group) {
    if (!asList(group.needs).includes(PLAN_JOB)) problems.push(`${where(GROUP_JOB)}: must need ${PLAN_JOB}`);
    if (expr(group.strategy?.matrix) !== `fromJSON(needs.${PLAN_JOB}.outputs.matrix)`) problems.push(`${where(GROUP_JOB)}: the matrix must be exactly the plan job's output (never a hand-written group list)`);
    if (group.strategy?.['fail-fast'] !== false) problems.push(`${where(GROUP_JOB)}: fail-fast must be false (every group reports)`);
    if (group.if !== undefined) problems.push(`${where(GROUP_JOB)}: must not be conditional`);
    for (const svc of ['postgres', 'rabbitmq']) if (!group.services?.[svc]) problems.push(`${where(GROUP_JOB)}: needs its own ${svc} service container`);
    const run = runs(group, /^node scripts\/real-broker-groups\.mjs run "\$GROUP" "\$RUNNER_TEMP\/real-broker-report"$/);
    if (run.length !== 1 || expr(run[0].env?.GROUP) !== 'matrix.group' || run[0].if !== undefined) problems.push(`${where(GROUP_JOB)}: exactly one unconditional step must run the group through the guard (node scripts/real-broker-groups.mjs run "$GROUP" ..., GROUP = matrix.group)`);
    if (runs(group, /test:e2e\b|vitest/).length > 0) problems.push(`${where(GROUP_JOB)}: runs the suites outside the guard`);
    const upload = asList(group.steps).filter((s) => String(s?.uses ?? '').startsWith('actions/upload-artifact@'));
    if (upload.length !== 1 || expr(upload[0].if) !== 'always()' || upload[0].with?.name !== 'real-broker-report-${{ matrix.group }}') problems.push(`${where(GROUP_JOB)}: must always upload its report as real-broker-report-<group>`);
  }
  const verify = jobs[VERIFY_JOB];
  if (verify) {
    if (expr(verify.if) !== 'always()') problems.push(`${where(VERIFY_JOB)}: must have "if: always()" (it reports a failed or missing group)`);
    for (const n of [PLAN_JOB, GROUP_JOB]) if (!asList(verify.needs).includes(n)) problems.push(`${where(VERIFY_JOB)}: must need ${n}`);
    const dl = asList(verify.steps).filter((s) => String(s?.uses ?? '').startsWith('actions/download-artifact@'));
    if (dl.length !== 1 || dl[0].with?.pattern !== 'real-broker-report-*') problems.push(`${where(VERIFY_JOB)}: must download every real-broker-report-* artifact`);
    if (runs(verify, /^node scripts\/real-broker-groups\.mjs verify "\$RUNNER_TEMP\/real-broker-reports"$/).length !== 1) problems.push(`${where(VERIFY_JOB)}: exactly one step must run: node scripts/real-broker-groups.mjs verify "$RUNNER_TEMP/real-broker-reports"`);
    if (asList(verify.steps).some((s) => s?.if !== undefined)) problems.push(`${where(VERIFY_JOB)}: its steps must not be conditional`);
  }
  for (const [id, job] of Object.entries(jobs)) {
    if (id !== GROUP_JOB && runs(job, /test:e2e -w @nawara\/e2e-real-broker|test:e2e:real-broker/).length > 0) problems.push(`${where(id)}: runs the real-broker suites outside the group jobs`);
  }
  return problems;
}

export function matrixOf(manifest) {
  return { group: manifest.groups.map((g) => g.id) };
}

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};

/** A vitest JUnit report: per suite file, its declared counts and its counted test cases (failure, error and skipped elements). */
export function parseJunit(xml) {
  const suites = [];
  const re = /<testsuite\s[^>]*>[\s\S]*?<\/testsuite>|<testsuite\s[^>]*\/>/g;
  for (const block of xml.match(re) ?? []) {
    const open = block.match(/<testsuite\s[^>]*>/)[0];
    const cases = block.match(/<testcase\s/g)?.length ?? 0;
    suites.push({
      name: attr(open, 'name'),
      tests: Number(attr(open, 'tests')),
      failures: Number(attr(open, 'failures')),
      errors: Number(attr(open, 'errors')),
      skipped: Number(attr(open, 'skipped') ?? 0),
      time: Number(attr(open, 'time')),
      cases,
      failureElements: block.match(/<failure[\s>]/g)?.length ?? 0,
      errorElements: block.match(/<error[\s>]/g)?.length ?? 0,
      skippedElements: block.match(/<skipped[\s/>]/g)?.length ?? 0,
    });
  }
  return suites;
}

/** One group's report: exactly its suites, each with at least one test, every test passed (nothing failed, errored or skipped). */
export function checkGroupReport(groupId, suites, parsed) {
  const problems = [];
  const where = `group "${groupId}"`;
  const names = parsed.map((s) => s.name);
  const expected = new Set(suites);
  for (const n of names) if (!expected.has(n)) problems.push(`${where}: its report holds ${n}, which is not assigned to it`);
  for (const s of suites) {
    const c = names.filter((n) => n === s).length;
    if (c === 0) problems.push(`${where}: ${s} did not run (no result in the report)`);
    if (c > 1) problems.push(`${where}: ${s} appears ${c} times in the report`);
  }
  for (const s of parsed) {
    const at = `${where}: ${s.name}`;
    if (!Number.isInteger(s.tests) || s.tests < 1 || s.cases !== s.tests) problems.push(`${at}: ran no test, or its counts disagree (tests=${s.tests}, cases=${s.cases})`);
    if (s.failures !== 0 || s.failureElements !== 0) problems.push(`${at}: ${Math.max(s.failures || 0, s.failureElements)} failed`);
    if (s.errors !== 0 || s.errorElements !== 0) problems.push(`${at}: ${Math.max(s.errors || 0, s.errorElements)} errored`);
    if (s.skipped !== 0 || s.skippedElements !== 0) problems.push(`${at}: ${Math.max(s.skipped || 0, s.skippedElements)} skipped (a certification test never passes by being skipped)`);
  }
  return problems;
}

/** All groups' reports together (`reports`: group id -> array of report texts found for it; unknown ids included). */
export function checkAllReports(manifest, discovered, reports) {
  const problems = [...checkManifest(manifest, discovered)];
  const ids = manifest.groups.map((g) => g.id);
  for (const id of Object.keys(reports)) if (!ids.includes(id)) problems.push(`a report for unknown group "${id}"`);
  const rows = [];
  for (const g of manifest.groups) {
    const texts = reports[g.id] ?? [];
    if (texts.length !== 1) { problems.push(`group "${g.id}": ${texts.length === 0 ? 'no report (the job is missing, was cancelled or crashed before reporting)' : `${texts.length} reports`}`); continue; }
    const parsed = parseJunit(texts[0]);
    problems.push(...checkGroupReport(g.id, g.suites, parsed));
    for (const s of parsed) rows.push({ group: g.id, suite: s.name, tests: s.tests, seconds: s.time });
  }
  const ran = new Set(rows.map((r) => r.suite));
  for (const s of discovered) if (!ran.has(s)) problems.push(`${s}: no group ran it`);
  return { problems, rows, tests: rows.reduce((a, r) => a + (Number.isInteger(r.tests) ? r.tests : 0), 0) };
}

/** Reports under `dir` (any depth: download-artifact puts each artifact in its own folder), by group id from `<id>.junit.xml`. */
export function collectReports(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const m = name.match(/^(.+)\.junit\.xml$/);
        if (m) (out[m[1]] ??= []).push(readFileSync(p, 'utf8'));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function fail(problems) {
  for (const p of problems) console.error(`real-broker groups: ${p}`);
  process.exit(1);
}

function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === 'plan') {
    const problems = checkRealBrokerGroups();
    if (problems.length) fail(problems);
    const manifest = loadManifest();
    for (const g of manifest.groups) console.error(`group ${g.id}: ${g.suites.length} suites`);
    process.stdout.write(`matrix=${JSON.stringify(matrixOf(manifest))}\n`);
    return;
  }
  if (cmd === 'run') {
    const [groupId, outDir] = args;
    if (!groupId || !outDir) fail(['usage: run <group> <dir>']);
    const problems = checkRealBrokerGroups();
    if (problems.length) fail(problems);
    const group = loadManifest().groups.find((g) => g.id === groupId);
    if (!group) fail([`no group "${groupId}" in ${MANIFEST}`]);
    const dir = resolve(outDir);
    mkdirSync(dir, { recursive: true });
    const junit = join(dir, `${groupId}.junit.xml`);
    const startedAt = new Date();
    console.log(`group ${groupId}: ${group.suites.length} suites, in sequence: ${group.suites.join(' ')}`);
    const r = spawnSync('npm', ['run', 'test:e2e', '-w', '@nawara/e2e-real-broker', '--', '--reporter=default', '--reporter=junit', `--outputFile.junit=${junit}`, ...group.suites],
      { cwd: REPO_ROOT, stdio: 'inherit' });
    const finishedAt = new Date();
    const exitCode = r.status ?? 1;
    const timing = { group: groupId, suites: group.suites, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), wallSeconds: (finishedAt - startedAt) / 1000, exitCode };
    if (existsSync(junit)) timing.suiteSeconds = Object.fromEntries(parseJunit(readFileSync(junit, 'utf8')).map((s) => [s.name, s.time]));
    writeFileSync(join(dir, `${groupId}.timing.json`), `${JSON.stringify(timing, null, 2)}\n`);
    if (!existsSync(junit)) fail([`group "${groupId}": vitest wrote no JUnit report (exit ${exitCode})`]);
    const reportProblems = checkGroupReport(groupId, group.suites, parseJunit(readFileSync(junit, 'utf8')));
    if (reportProblems.length) fail(reportProblems);
    if (exitCode !== 0) fail([`group "${groupId}": vitest exited ${exitCode}`]);
    console.log(`group ${groupId}: passed in ${timing.wallSeconds.toFixed(1)} s`);
    return;
  }
  if (cmd === 'verify') {
    const [dir] = args;
    if (!dir) fail(['usage: verify <dir>']);
    const config = checkVitestConfig(readFileSync(join(REPO_ROOT, VITEST_CONFIG), 'utf8'));
    const { problems, rows, tests } = checkAllReports(loadManifest(), discoverSuites(), collectReports(dir));
    const table = ['| group | suite | tests | seconds |', '|---|---|---:|---:|', ...rows.map((r) => `| ${r.group} | ${r.suite} | ${r.tests} | ${Number(r.seconds).toFixed(1)} |`)].join('\n');
    const timings = Object.values(collectTimings(dir)).map((t) => `| ${t.group} | ${t.wallSeconds?.toFixed?.(1) ?? '?'} | ${t.exitCode} |`);
    const summary = `### Real-broker suites: ${rows.length} suites, ${tests} tests\n\n${table}\n\n| group | wall seconds | exit |\n|---|---:|---:|\n${timings.join('\n')}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    if (config.length || problems.length) fail([...config, ...problems]);
    console.log(`real-broker groups: every discovered suite ran exactly once; ${tests} tests passed; none failed or skipped`);
    return;
  }
  fail(['usage: real-broker-groups.mjs plan | run <group> <dir> | verify <dir>']);
}

function collectTimings(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.timing.json')) { try { const t = JSON.parse(readFileSync(p, 'utf8')); out[t.group] = t; } catch { /* reported as missing by verify */ } }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
