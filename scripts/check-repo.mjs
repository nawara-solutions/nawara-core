#!/usr/bin/env node
// Runs the repository's static safety and architecture checks. Exit code 1 lists every violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkDigestDeploy, checkImageBuild, checkTypedConfirmation, checkHierarchyFixtures, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety } from './lib/checks.mjs';

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
// V2-A.2: production deployments that take an exact, already-built image digest (the image repository each may deploy).
const DIGEST_DEPLOYMENTS = {
  'auth-service-deploy.yml': 'nawara-core-auth-service',
  'organization-service-deploy.yml': 'nawara-core-organization-service',
  'audit-service-deploy.yml': 'nawara-core-audit-service',
};
// V2 A0: immutable image builds (workflow → the image repository and the service it builds).
const IMAGE_BUILDS = {
  'auth-service-docker-build.yml': { repository: 'nawara-core-auth-service', app: 'auth-service' },
  'organization-service-image.yml': { repository: 'nawara-core-organization-service', app: 'organization-service' },
  'audit-service-image.yml': { repository: 'nawara-core-audit-service', app: 'audit-service' },
};
// V2-A.3 (A3.5): production operations that must keep their typed confirmation (workflow → the exact phrase).
const CONFIRMED_OPERATIONS = {
  'auth-service-deploy.yml': 'deploy auth-service',
  'organization-service-deploy.yml': 'deploy organization-service',
  'audit-service-deploy.yml': 'deploy audit-service',
  'auth-db-credential-rotate.yml': 'rotate auth_app',
};
for (const f of readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
  const text = readFileSync(join(wfDir, f), 'utf8');
  problems.push(...checkWorkflowSafety(f, text));
  if (f === 'core-ci.yml') problems.push(...checkCiCoverage(f, text), ...checkCiAggregate(f, text));
  if (DIGEST_DEPLOYMENTS[f]) problems.push(...checkDigestDeploy(f, text, DIGEST_DEPLOYMENTS[f]));
  if (CONFIRMED_OPERATIONS[f]) problems.push(...checkTypedConfirmation(f, text, CONFIRMED_OPERATIONS[f]));
  if (IMAGE_BUILDS[f]) problems.push(...checkImageBuild(f, text, IMAGE_BUILDS[f]));
}
for (const f of new Set([...Object.keys(DIGEST_DEPLOYMENTS), ...Object.keys(CONFIRMED_OPERATIONS), ...Object.keys(IMAGE_BUILDS)])) {
  try {
    readFileSync(join(wfDir, f));
  } catch {
    problems.push(`${f} (a protected production workflow) is missing`);
  }
}
try {
  readFileSync(join(wfDir, 'core-ci.yml'));
} catch {
  problems.push('core-ci.yml is missing');
}

for (const base of ['apps', 'libs']) {
  for (const file of walk(join(root, base))) {
    const isSql = file.endsWith('.sql'); // schemas too (Stage 17.3): a product concept must not enter a Core table either
    if ((!/\.(ts|mjs|js)$/.test(file) && !isSql) || file.endsWith('.d.ts')) continue;
    const rel = relative(root, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    problems.push(...checkSource(rel, text));
    if (!isSql) problems.push(...checkAuthErrorCoverage(rel, text));
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
