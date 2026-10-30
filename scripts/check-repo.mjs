#!/usr/bin/env node
// Runs the repository's static safety and architecture checks. Exit code 1 lists every violation.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ON_DEMAND_WORKFLOWS, checkOnDemandWorkflow, checkActionPins, checkScheduledBackupEntry, checkScheduledBackupVerifier, checkAuthErrorCoverage, checkAuthOrganizationBoundary, checkRepairAuditProducerScope, repairAuditScanned, checkCiAggregate, checkCiCoverage, checkDigestDeploy, checkImageBuild, checkImagePins, checkLocalGrafana, checkLocalObservability, checkTypedConfirmation, checkHierarchyFixtures, checkNoPlatformIdOnFinancialRecords, checkSource, checkWorkflowSafety, CALLER_POLICY_MODULES, checkCallerPolicyInventory, workspaceAppPackages, DEVELOPMENT_SECRET_CATALOG, checkDevelopmentSecretCatalog, checkDockerContext, checkEnvIgnorePolicy, checkEnvTemplates, checkReadmeEnvironmentCoverage, checkTrackedEnvFiles, checkDroneSshFiles, gitIgnoreProbe, gitTrackedFiles, isEnvTemplate, isServiceConfigSource, ENV_READER_CLIS, ENV_READER_CLI_RESOLVERS, checkEnvReaderClis, checkNodeToolchain, checkCiWorkspaceCoverage, checkEventContracts, usesEventTraffic, checkOutboxRetentionEligibility, OUTBOX_RETENTION_APPROVED_SERVICES, checkEventProvenanceOptIn, AUDIT_ADMISSION_FILES, KIT_EVENT_BUS, KIT_PROVENANCE, NOTIFICATION_KEYED_FILES, checkEventReemission, checkEnforcementPolicies, checkBrokerDeadLettering, checkNotificationTopologyGate, PROVISION_SCRIPT, TOPOLOGY_VERIFIER, checkTopologyMonitor, TOPOLOGY_MONITOR_DIR, TOPOLOGY_MONITOR_FILES, KIT_REEMISSION, KIT_SERIALIZATION, KIT_OUTBOX_RELAY, KIT_PACKAGE } from './lib/checks.mjs';
import { ACTIVATION_FILE, AUDIT_BINDINGS_FILE, PROVISION_FILE, checkProvisionTopicGrants, checkTopicPermissionSources } from './lib/topic-permissions.mjs';

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
  if (ON_DEMAND_WORKFLOWS.includes(f)) problems.push(...checkOnDemandWorkflow(f, text)); // Core V2 Phase 3
  if (IMAGE_BUILDS[f]) problems.push(...checkImageBuild(f, text, IMAGE_BUILDS[f]));
}
// Core V2 M2 B1: the installed side of the scheduled backup (the entry script's pins, the authorized_keys template).
problems.push(...checkScheduledBackupEntry({
  entry: readOptional(join(root, 'infra/backup/scheduled-backup.sh')),
  backupSh: readFileSync(join(root, 'infra/backup/backup.sh'), 'utf8'),
  template: readOptional(join(root, 'infra/backup/scheduled-backup.authorized_keys.template')),
}));
// Core V2 M2 E2: the read-only console verification of the installation matches those pins.
problems.push(...checkScheduledBackupVerifier({
  verifier: readOptional(join(root, 'infra/backup/verify-scheduled-backup-install.sh')),
  entry: readOptional(join(root, 'infra/backup/scheduled-backup.sh')),
  template: readOptional(join(root, 'infra/backup/scheduled-backup.authorized_keys.template')),
}));
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
  // Core V2 M2 T7: no committed file can choose a production SSH destination (drone-ssh reads .host).
  problems.push(...checkDroneSshFiles(tracked));
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
// V2 A15.2: developers (.nvmrc, engines), CI and the application images use the same Node major.
{
  const dockerfiles = {};
  for (const app of readdirSync(join(root, 'apps'))) {
    const text = readOrUndefined(`apps/${app}/Dockerfile`);
    if (text !== undefined) dockerfiles[`apps/${app}/Dockerfile`] = text;
  }
  problems.push(...checkNodeToolchain({ nvmrc: readOrUndefined('.nvmrc'), packageJson: readOrUndefined('package.json'), ciText: readOrUndefined('.github/workflows/core-ci.yml'), dockerfiles }));
}
// V2 A15.4: every application and library workspace is covered by Core CI's per-workspace matrix, and every image by the smoke matrix.
{
  const libWorkspaces = readdirSync(join(root, 'libs')).map((dir) => readOptional(join(root, 'libs', dir, 'package.json'))).filter(Boolean)
    .map((text) => JSON.parse(text).name);
  const imageApps = [...appPackages.values()].filter((dir) => readOrUndefined(`apps/${dir}/Dockerfile`) !== undefined);
  problems.push(...checkCiWorkspaceCoverage(readOrUndefined('.github/workflows/core-ci.yml'), { workspaces: [...appPackages.keys(), ...libWorkspaces], imageApps }));
}
// V2 A3M.2: the per-service event contracts agree (producer ownership, consumer requirements), and every app with event traffic has one.
{
  const contracts = {};
  const required = [];
  for (const app of readdirSync(join(root, 'apps'))) {
    const text = readOrUndefined(`apps/${app}/contracts/events.json`);
    if (text !== undefined) contracts[app] = text;
    const src = join(root, 'apps', app, 'src');
    const texts = [];
    try {
      for (const f of walk(src)) if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts')) texts.push(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (usesEventTraffic(texts)) required.push(app);
  }
  problems.push(...checkEventContracts(contracts, required));
  // Core V2 S1b: event provenance (an unkeyed body digest) only in reviewed services that receive no code-bearing event.
  const sources = {};
  for (const app of appPackages.values()) {
    const files = {};
    try {
      for (const f of walk(join(root, 'apps', app, 'src'))) {
        if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts')) files[relative(root, f).split('\\').join('/')] = readFileSync(f, 'utf8');
      }
    } catch {
      continue;
    }
    sources[app] = files;
  }
  const boundary = {};
  for (const rel of [...Object.values(AUDIT_ADMISSION_FILES), ...Object.values(NOTIFICATION_KEYED_FILES), KIT_EVENT_BUS, KIT_PROVENANCE]) boundary[rel] = readOrUndefined(rel);
  problems.push(...checkEventProvenanceOptIn(contracts, sources, boundary));
  problems.push(...checkEnforcementPolicies(contracts, sources)); // Core V2 S1e-1 (S0-C6)
  problems.push(...checkBrokerDeadLettering(sources, readOrUndefined(KIT_EVENT_BUS))); // Core V2 OD-BRK-1
  problems.push(...checkNotificationTopologyGate(readOrUndefined(PROVISION_SCRIPT), readOrUndefined(TOPOLOGY_VERIFIER))); // Core V2 OD-BRK-2a
  problems.push(...checkTopologyMonitor({ // Core V2 OD-BRK-2b-1
    files: Object.fromEntries(TOPOLOGY_MONITOR_FILES.map((n) => [n, readOrUndefined(`${TOPOLOGY_MONITOR_DIR}/${n}`)]).filter(([, t]) => t !== undefined)),
    verifier: readOrUndefined(TOPOLOGY_VERIFIER),
    provision: readOrUndefined(PROVISION_SCRIPT),
    workflows: Object.fromEntries(readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(join(wfDir, f), 'utf8')])),
  }));
  // Core V2 S1c-3 R1: producer re-emission stays the restricted S0-C4 foundation, unused until an integration is reviewed.
  const cli = {};
  for (const f of walk(join(root, 'libs/service-kit/src/cli'))) if (f.endsWith('.ts')) cli[relative(root, f).split('\\').join('/')] = readFileSync(f, 'utf8');
  const reemission = {};
  for (const rel of [KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS, KIT_OUTBOX_RELAY, KIT_PACKAGE]) reemission[rel] = readOrUndefined(rel);
  problems.push(...checkEventReemission(contracts, reemission, { ...sources, 'libs/service-kit/src/cli': cli }));
}
// Core V2 S1d-1 (ADR-0057 S0-C5): the topic permission generator's sources are valid, deterministic and exact. It never reads provision.sh.
{
  const apps = readdirSync(join(root, 'apps')).filter((a) => statSync(join(root, 'apps', a)).isDirectory());
  const contracts = {};
  for (const app of apps) {
    const text = readOrUndefined(`apps/${app}/contracts/events.json`);
    if (text !== undefined) contracts[app] = text;
  }
  const auditSources = {};
  try {
    for (const f of walk(join(root, 'apps/audit-service/src'))) {
      if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts')) auditSources[relative(root, f).split('\\').join('/')] = readFileSync(f, 'utf8');
    }
  } catch {
    // reported below as a missing binding file
  }
  problems.push(...checkTopicPermissionSources({
    contracts, apps, auditCatalog: readOrUndefined('libs/audit-contract/src/catalog.ts') ?? '',
    files: { [AUDIT_BINDINGS_FILE]: readOrUndefined(AUDIT_BINDINGS_FILE) }, auditSources,
  }));
  // Core V2 S1d-2: provision.sh carries exactly the generated grants for the reviewed activation file (never the reverse).
  problems.push(...checkProvisionTopicGrants({
    contracts, apps, auditCatalog: readOrUndefined('libs/audit-contract/src/catalog.ts') ?? '',
    provision: readOrUndefined(PROVISION_FILE), activation: readOrUndefined(ACTIVATION_FILE),
  }));
}
// V2 A3M.5: the manual outbox retention stays limited to the reviewed services, which still let the outbox generate their event ids.
{
  const serviceSources = {};
  for (const service of OUTBOX_RETENTION_APPROVED_SERVICES) {
    const sources = {};
    try {
      for (const f of walk(join(root, 'apps', service, 'src'))) {
        if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts')) sources[relative(root, f).split('\\').join('/')] = readFileSync(f, 'utf8');
      }
    } catch {
      // reported by the check as a missing approved service
    }
    serviceSources[service] = sources;
  }
  problems.push(...checkOutboxRetentionEligibility(
    { core: readOrUndefined('libs/service-kit/src/events/outbox-retention.ts'), cli: readOrUndefined('libs/service-kit/src/cli/outbox-retention.ts') },
    serviceSources,
  ));
}
// V2 A5.4-T1: auth-service reaches Organization Service only from its approved administrative operations (ADR-0042 decision 8, ADR-0063 §5).
{
  const sources = {};
  try {
    for (const f of walk(join(root, 'apps/auth-service/src'))) {
      if (f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts')) sources[relative(root, f).split('\\').join('/')] = readFileSync(f, 'utf8');
    }
  } catch {
    // reported by the check: no auth-service sources
  }
  problems.push(...checkAuthOrganizationBoundary(sources));
}
// V2 A5.4-A3 O2: the four reference-repair audit actions are named only inside their approved producer scope (ADR-0061 §6, ADR-0064).
{
  // Its own walk: only installed dependencies, build output and the git directory are skipped, so nothing the two replaced library
  // assertions read is left out (they also skipped every dot-directory; this reads those too).
  const sources = {};
  const read = (dir) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.git'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) read(p);
      else {
        const rel = relative(root, p).split('\\').join('/');
        if (repairAuditScanned(rel)) sources[rel] = readFileSync(p, 'utf8');
      }
    }
  };
  for (const top of ['apps', 'libs']) read(join(root, top));
  problems.push(...checkRepairAuditProducerScope(sources));
}

if (problems.length > 0) {
  console.error(`repository checks failed (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('repository checks passed: workflow safety, scheduled-backup pins and installation verifier, CI coverage, architecture boundaries, caller-policy delegation, hierarchy fixtures, financial isolation, auth error-code coverage, local observability, local alert rules, local Grafana, configuration and secret hygiene, operator CLI configuration, Node toolchain, CI workspace coverage, event contracts, event provenance opt-in, producer re-emission foundation, consumer enforcement policies, broker dead-lettering topology, Notification topology gate, Notification topology monitor and containment, topic permission sources, generated provisioning topic grants, outbox retention eligibility, Auth to Organization dependency boundary, reference-repair audit producer scope');
