#!/usr/bin/env node
// Runs the repository's static safety and architecture checks. Exit code 1 lists every violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkActionPins, checkAuthErrorCoverage, checkCiAggregate, checkCiCoverage, checkDigestDeploy, checkImageBuild, checkImagePins, checkLocalGrafana, checkLocalObservability, checkTypedConfirmation, checkHierarchyFixtures, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety, CALLER_POLICY_MODULES, checkCallerPolicyInventory, workspaceAppPackages, DEVELOPMENT_SECRET_CATALOG, checkDevelopmentSecretCatalog, checkDockerContext, checkEnvIgnorePolicy, checkEnvTemplates, checkReadmeEnvironmentCoverage, checkTrackedEnvFiles, gitIgnoreProbe, gitTrackedFiles, isEnvTemplate, isServiceConfigSource, ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS, checkEnvReaderClis } from './lib/checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// A file a check needs but that may be missing: its absence is then reported by the check itself (an empty text fails it).
const readOptional = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
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
  problems.push(...checkActionPins(f, text));
  if (DIGEST_DEPLOYMENTS[f]) {
    // V2 A14: the provenance signer of a deployment is the image workflow of the same repository.
    const signerWorkflow = Object.keys(IMAGE_BUILDS).find((w) => IMAGE_BUILDS[w].repository === DIGEST_DEPLOYMENTS[f]);
    problems.push(...checkDigestDeploy(f, text, DIGEST_DEPLOYMENTS[f], { signerWorkflow }));
  }
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
// V2 A14: pinned base images (every application Dockerfile; the production PostgreSQL of the three deployed services).
{
  const dockerfiles = {};
  for (const app of readdirSync(join(root, 'apps'))) {
    try { dockerfiles[`apps/${app}/Dockerfile`] = readFileSync(join(root, 'apps', app, 'Dockerfile'), 'utf8'); } catch { /* an app without an image */ }
  }
  const deployScripts = Object.fromEntries(['auth-service', 'organization-service', 'audit-service']
    .map((svc) => [`apps/${svc}/deploy/provision-and-deploy.sh`, readFileSync(join(root, 'apps', svc, 'deploy/provision-and-deploy.sh'), 'utf8')]));
  problems.push(...checkImagePins(dockerfiles, deployScripts));
}
// V2 A12.5.1: the local observability overlay stays opt-in, loopback-only, pinned and credential-free.
problems.push(...checkLocalObservability(
  readFileSync(join(root, 'docker-compose.yml'), 'utf8'),
  readFileSync(join(root, 'docker-compose.observability.yml'), 'utf8'),
  readFileSync(join(root, 'infra/observability/prometheus/prometheus.yml'), 'utf8'),
  // V2 A12.6.3: the alert rules and their promtool tests (a missing file is reported, not thrown).
  readOptional(join(root, 'infra/observability/prometheus/rules/nawara-core.rules.yml')),
  readOptional(join(root, 'infra/observability/prometheus/tests/nawara-core.rules.test.yml')),
));
// V2 A12.6.1: local Grafana: loopback-only, no default or anonymous access, no call home, one Prometheus datasource, deterministic dashboards.
{
  const grafana = join(root, 'infra/observability/grafana');
  const dashboards = {};
  for (const file of walk(join(grafana, 'dashboards'))) if (file.endsWith('.json')) dashboards[relative(root, file)] = readFileSync(file, 'utf8');
  problems.push(...checkLocalGrafana(
    readFileSync(join(root, 'docker-compose.observability.yml'), 'utf8'),
    readFileSync(join(grafana, 'provisioning/datasources/prometheus.yml'), 'utf8'),
    readFileSync(join(grafana, 'provisioning/dashboards/nawara-core.yml'), 'utf8'),
    dashboards,
    readFileSync(join(root, '.env.example'), 'utf8'),
  ));
}
try {
  readFileSync(join(wfDir, 'core-ci.yml'));
} catch {
  problems.push('core-ci.yml is missing');
}

// V2 A1.4: the workspace applications by package name (from their manifests), so a bare workspace-package import is a cross-service import.
const appPackages = workspaceAppPackages(Object.fromEntries(readdirSync(join(root, 'apps'))
  .filter((dir) => readOptional(join(root, 'apps', dir, 'package.json')) !== '')
  .map((dir) => [dir, readFileSync(join(root, 'apps', dir, 'package.json'), 'utf8')])));
if (appPackages.size === 0) problems.push('no workspace application manifest (apps/*/package.json) was found; the dependency-direction guard cannot run');
for (const base of ['apps', 'libs']) {
  for (const file of walk(join(root, base))) {
    const isSql = file.endsWith('.sql'); // schemas too (Stage 17.3): a product concept must not enter a Core table either
    if ((!/\.(ts|mjs|js)$/.test(file) && !isSql) || file.endsWith('.d.ts')) continue;
    const rel = relative(root, file).split('\\').join('/');
    const text = readFileSync(file, 'utf8');
    problems.push(...checkSource(rel, text, { appPackages }));
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
// V2 A1.4: every governed caller-policy module delegates its document to the kit's parseCallerPolicy, bound to its variable.
problems.push(...checkCallerPolicyInventory(Object.fromEntries(Object.keys(CALLER_POLICY_MODULES).map((rel) => [rel, readOrUndefined(rel)]))));
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

// V2 A2.5: configuration and secret hygiene. Git answers what is ignored and what is tracked (the index, never the disk: a developer's
// ignored local .env must not fail the check); everything else is read as text. No value is ever printed.
{
  problems.push(...checkEnvIgnorePolicy(gitIgnoreProbe(root)));
  problems.push(...checkDockerContext(readOrUndefined('.dockerignore')));
  const tracked = gitTrackedFiles(root);
  problems.push(...checkTrackedEnvFiles(tracked));
  const templates = Object.fromEntries((tracked ?? []).filter(isEnvTemplate).map((rel) => [rel, readOptional(join(root, rel))]));
  problems.push(...checkDevelopmentSecretCatalog(templates, readOrUndefined(DEVELOPMENT_SECRET_CATALOG)));
  const composeFiles = readdirSync(root).filter((name) => /^docker-compose(\..+)?\.ya?ml$/.test(name));
  problems.push(...checkEnvTemplates(templates, Object.fromEntries(composeFiles.map((name) => [name, readFileSync(join(root, name), 'utf8')]))));
  for (const app of appPackages.values()) {
    const sources = {};
    for (const file of walk(join(root, 'apps', app, 'src'))) {
      const rel = relative(root, file).split('\\').join('/');
      if (isServiceConfigSource(app, rel)) sources[rel] = readFileSync(file, 'utf8');
    }
    problems.push(...checkReadmeEnvironmentCoverage(app, readOrUndefined(`apps/${app}/README.md`), sources));
  }
}
// V2 A15.1: the migrated operator CLIs read their configuration only through the kit's EnvReader.
problems.push(...checkEnvReaderClis(Object.fromEntries([...ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS].map((rel) => [rel, readOrUndefined(rel)]))));

if (problems.length > 0) {
  console.error(`repository checks failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('repository checks passed: workflow safety, CI coverage, architecture boundaries, caller-policy delegation, hierarchy fixtures, financial isolation, auth error-code coverage, local observability, local alert rules, local Grafana, configuration and secret hygiene, operator CLI configuration');
