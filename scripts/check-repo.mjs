#!/usr/bin/env node
// Runs the repository's static safety and architecture checks. Exit code 1 lists every violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAuthErrorCoverage, checkCiCoverage, checkHierarchyFixtures, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety } from './lib/checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', '.venv', '__pycache__'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const wfDir = join(root, '.github/workflows');
for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
  const text = readFileSync(join(wfDir, f), 'utf8');
  problems.push(...checkWorkflowSafety(f, text));
  if (f === 'core-ci.yml') problems.push(...checkCiCoverage(f, text));
}
try {
  readFileSync(join(wfDir, 'core-ci.yml'));
} catch {
  problems.push('core-ci.yml is missing');
}

for (const base of ['apps', 'libs']) {
  for (const file of walk(join(root, base))) {
    if (!/\.(ts|mjs|js)$/.test(file) || file.endsWith('.d.ts')) continue;
    const rel = relative(root, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    problems.push(...checkSource(rel, text));
    problems.push(...checkAuthErrorCoverage(rel, text));
  }
}

const readOrUndefined = (rel) => {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    return undefined;
  }
};
problems.push(...checkHierarchyFixtures(
  readOrUndefined('apps/auth-service/test/fixtures/hierarchy-snapshot.v1.json'),
  readOrUndefined('apps/organization-service/test/fixtures/hierarchy-snapshot.v1.json'),
));
for (const svc of ['billing-service', 'payment-service']) {
  const dir = join(root, 'apps', svc, 'db/migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    problems.push(...checkNoPlatformIdOnFinancialRecords(`apps/${svc}/db/migrations/${f}`, readFileSync(join(dir, f), 'utf8')));
  }
}

if (problems.length > 0) {
  console.error(`repository checks failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('repository checks passed: workflow safety, CI coverage, architecture boundaries, hierarchy fixtures, financial isolation, auth error-code coverage');
