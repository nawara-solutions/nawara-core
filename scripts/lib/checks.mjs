// Static checks the repository enforces on itself. Pure functions (text in, problems out) so they are unit-testable.
import { parse } from 'yaml';

/** Every production deployment path and the production image tag share ONE queue, so they can never race each other. */
export const PRODUCTION_GROUP = 'production-deploy-core-api';

const asArray = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function triggerBranches(doc, event) {
  const on = doc.on ?? doc.true; // YAML 1.1 parsers may read the key `on` as boolean true
  const t = on?.[event];
  return t && typeof t === 'object' ? asArray(t.branches) : [];
}

/** The events a workflow runs on, whatever form `on:` takes (a name, a list of names or a map). */
function triggerNames(doc) {
  const on = doc?.on ?? doc?.true;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === 'object' ? Object.keys(on) : [];
}

/** V2-A.2: events that run without an explicit human decision to change production. A production SSH job never runs on them. */
const AUTOMATIC_EVENTS = ['push', 'pull_request', 'pull_request_target', 'workflow_run'];
/** V2-A.2: mutable pointers a merge must never move (they are frozen and deprecated; the digest is the deployment authority). */
const MUTABLE_PRODUCTION_TAG = /:(production|latest)\b/;
const INPUT_INTERPOLATION = /\$\{\{\s*(inputs|github\.event\.inputs)\./;
/**
 * V2-A.3 (A3.5): the GitHub environments a production job may declare. Each is a protected environment that holds the production SSH
 * credentials. `production-backup` (a future scheduled-backup environment) is deliberately NOT listed: it does not exist yet.
 */
export const PRODUCTION_ENVIRONMENTS = ['production'];
/** A use of the production SSH credentials, in any spelling, or of every secret at once. */
const PRODUCTION_CREDENTIAL = /secrets\s*(?:\.\s*|\[\s*\\?['"])DEPLOY_SSH_|toJSON\(\s*secrets\s*\)/;

const usesSsh = (steps) => steps.some((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));

/** The environment a job declares (`environment: name` or `environment: {name}`), as written. */
function environmentOf(job) {
  const env = job?.environment;
  if (env === undefined || env === null) return undefined;
  return typeof env === 'object' ? String(env.name ?? '') : String(env);
}

function firstCommandLine(script) {
  return String(script ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
}

function concurrencyProblems(where, cfg) {
  const out = [];
  if (!cfg || typeof cfg !== 'object' || typeof cfg.group !== 'string') return [`${where}: has no concurrency group`];
  if (cfg.group !== PRODUCTION_GROUP) out.push(`${where}: concurrency group must be "${PRODUCTION_GROUP}" (got "${cfg.group}")`);
  if (cfg['cancel-in-progress'] !== false) out.push(`${where}: cancel-in-progress must be explicitly false (a running production deployment is never cancelled)`);
  return out;
}

/** Safety rules for anything that deploys to, or publishes the image of, production. */
export function checkWorkflowSafety(fileName, text) {
  const problems = [];
  const doc = parse(text);
  const jobs = doc?.jobs ?? {};
  let deploys = false;

  const triggers = triggerNames(doc);
  const automatic = triggers.filter((t) => AUTOMATIC_EVENTS.includes(t));

  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = asArray(job.steps);
    const where = `${fileName} job "${jobId}"`;
    for (const step of steps) {
      const shell = [step.run, step.with?.script].filter((v) => v !== undefined).map(String).join('\n');
      if (INPUT_INTERPOLATION.test(shell)) problems.push(`${where}: a workflow input is interpolated into a shell script (pass it through env and validate it)`);
      if (triggers.includes('push')) {
        const tags = String(step.uses ?? '').startsWith('docker/build-push-action') ? String(step.with?.tags ?? '') : '';
        if (MUTABLE_PRODUCTION_TAG.test(tags) || MUTABLE_PRODUCTION_TAG.test(String(step.run ?? ''))) {
          problems.push(`${where}: a push-triggered workflow must not publish or move :production or :latest (V2-A.2: build an immutable sha- image; the digest is the deployment authority)`);
        }
      }
    }
    const ssh = steps.filter((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));
    const pushesProdTag = steps.some((s) => String(s.uses ?? '').startsWith('docker/build-push-action') && String(s.with?.tags ?? '').includes(':production'));

    // V2-A.3 (A3.5): production credentials and production SSH only inside an approved, protected environment, and a protected
    // environment only behind an explicit dispatch (never push, pull_request, workflow_run or a schedule waiting for approval).
    const environment = environmentOf(job);
    const usesProduction = usesSsh(steps) || PRODUCTION_CREDENTIAL.test(JSON.stringify(job));
    if (usesProduction) {
      if (environment === undefined) {
        problems.push(`${where}: a job using production SSH or the DEPLOY_SSH_* credentials must declare a protected environment (${PRODUCTION_ENVIRONMENTS.join(', ')})`);
      } else if (environment.includes('${{')) {
        problems.push(`${where}: the environment must be a literal name, never an expression (got "${environment}")`);
      } else if (!PRODUCTION_ENVIRONMENTS.includes(environment)) {
        problems.push(`${where}: environment "${environment}" is not an approved production environment (${PRODUCTION_ENVIRONMENTS.join(', ')})`);
      }
    }
    if (environment !== undefined && PRODUCTION_ENVIRONMENTS.includes(environment) && (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch')) {
      problems.push(`${where}: a job bound to the "${environment}" environment must be in a workflow_dispatch-only workflow (found: ${triggers.join(', ') || 'nothing'}); a scheduled or automatic run would wait for manual approval`);
    }

    if (ssh.length > 0) {
      deploys = true;
      if (automatic.length > 0) {
        problems.push(`${where}: a production SSH job must only run on workflow_dispatch or schedule, never automatically (found: ${automatic.join(', ')})`);
      }
      for (const step of ssh) {
        const first = firstCommandLine(step.with?.script);
        if ('script_stop' in (step.with ?? {})) problems.push(`${where}: "script_stop" is not an input of appleboy/ssh-action@v1 and is silently ignored; failure handling comes from "set -euo pipefail"`);
        if (first !== 'set -euo pipefail') problems.push(`${where}: the remote script must start with "set -euo pipefail" (starts with: ${first ?? 'nothing'})`);
        if (/\$\{\{\s*secrets\./.test(String(step.with?.script ?? ''))) problems.push(`${where}: a secret is interpolated into the remote script (pass it through env instead)`);
      }
      const guard = String(job.if ?? '');
      if (!guard.includes('refs/heads/main')) problems.push(`${where}: a production deployment must be restricted to refs/heads/main`);
      problems.push(...concurrencyProblems(where, job.concurrency ?? doc.concurrency));
    }
    if (pushesProdTag) {
      problems.push(...concurrencyProblems(`${where} (publishes the :production image)`, job.concurrency ?? doc.concurrency));
      if (!String(job.if ?? '').includes('refs/heads/main')) problems.push(`${where}: publishing :production must be restricted to refs/heads/main`);
    }
  }

  if (deploys) {
    const branches = triggerBranches(doc, 'push');
    const stale = branches.filter((b) => b !== 'main');
    if (stale.length > 0) problems.push(`${fileName}: a deployment workflow must not trigger on branches other than main (found: ${stale.join(', ')})`);
  }
  return problems;
}

/**
 * V2-A.3 (A3.5): a production operation that requires a typed confirmation keeps it. The workflow must require a `confirm` input, and
 * every job using production SSH or bound to a production environment must test `inputs.confirm == '<phrase>'` with exactly that phrase.
 */
export function checkTypedConfirmation(fileName, text, phrase) {
  const problems = [];
  const doc = parse(text);
  const on = doc?.on ?? doc?.true;
  if (on?.workflow_dispatch?.inputs?.confirm?.required !== true) problems.push(`${fileName}: the "confirm" input must exist and be required`);
  const expected = `inputs.confirm == '${phrase}'`;
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    const production = usesSsh(asArray(job.steps)) || PRODUCTION_ENVIRONMENTS.includes(environmentOf(job) ?? '');
    if (production && !String(job.if ?? '').includes(expected)) {
      problems.push(`${fileName} job "${jobId}": must require the typed confirmation (${expected})`);
    }
  }
  return problems;
}

const DIGEST_PATTERN = '^sha256:[0-9a-f]{64}$';
const BUILDS = /\bdocker\s+(buildx\s+)?build\b|\bbuildx\s+bake\b/;

/**
 * V2-A.2: a digest deployment workflow deploys ONE EXACT, ALREADY-BUILT image of `repository` and never builds. It runs only on an
 * explicit dispatch with a digest and a typed confirmation; the digest is validated before any network step, resolved and checked
 * (existence, revision label, ancestry of main) before the SSH step, and the SSH step deploys exactly IMAGE_NAME@digest.
 */
export function checkDigestDeploy(fileName, text, repository) {
  const problems = [];
  const doc = parse(text);
  const triggers = triggerNames(doc);
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') problems.push(`${fileName}: a digest deployment must run on workflow_dispatch only (found: ${triggers.join(', ') || 'nothing'})`);
  const on = doc?.on ?? doc?.true;
  const inputs = on?.workflow_dispatch?.inputs ?? {};
  for (const name of ['digest', 'confirm']) {
    if (inputs[name]?.required !== true) problems.push(`${fileName}: the "${name}" input must exist and be required`);
  }
  const imageName = String(doc?.env?.IMAGE_NAME ?? '');
  if (!imageName.startsWith('ghcr.io/') || !imageName.endsWith(`/${repository}`)) problems.push(`${fileName}: IMAGE_NAME must be fixed to the ${repository} repository (got "${imageName}")`);
  if (doc?.permissions?.packages === 'write') problems.push(`${fileName}: a digest deployment must not have packages: write`);

  const jobs = Object.entries(doc?.jobs ?? {});
  const deployJobs = jobs.filter(([, job]) => usesSsh(asArray(job.steps)));
  if (deployJobs.length !== 1) problems.push(`${fileName}: exactly one job must deploy over SSH (found ${deployJobs.length})`);

  for (const [jobId, job] of jobs) {
    const where = `${fileName} job "${jobId}"`;
    for (const step of asArray(job.steps)) {
      if (String(step.uses ?? '').startsWith('docker/build-push-action') || BUILDS.test(String(step.run ?? ''))) {
        problems.push(`${where}: a digest deployment must never build an image (it deploys an existing artifact)`);
      }
    }
    if (job.permissions?.packages === 'write') problems.push(`${where}: a digest deployment must not have packages: write`);
  }

  const fromDigestInput = (s) => Object.values(s.env ?? {}).some((v) => /^\$\{\{\s*inputs\.digest\s*\}\}$/.test(String(v).trim()));
  const isValidation = (s) => String(s.run ?? '').includes(DIGEST_PATTERN) && fromDigestInput(s);
  const isVerification = (s) => /imagetools inspect/.test(String(s.run ?? '')) && /org\.opencontainers\.image\.revision/.test(String(s.run ?? ''))
    && /merge-base --is-ancestor/.test(String(s.run ?? ''));
  const guarded = (where, job) => {
    const guard = String(job.if ?? '');
    if (!guard.includes('refs/heads/main')) problems.push(`${where}: must be restricted to refs/heads/main`);
    if (!/inputs\.confirm\s*==\s*'[^']+'/.test(guard)) problems.push(`${where}: must require the typed confirmation input`);
    if (job.permissions?.packages !== 'read') problems.push(`${where}: packages permission must be exactly read`);
  };

  // V2-A.3 (A3.5): verify (no environment, no production credentials) → approval → deploy (the protected environment, SSH only).
  const verify = (doc?.jobs ?? {}).verify;
  if (!verify) {
    problems.push(`${fileName}: the "verify" job is missing (validation and artifact verification run before the production approval)`);
  } else {
    const where = `${fileName} job "verify"`;
    guarded(where, verify);
    if (environmentOf(verify) !== undefined) problems.push(`${where}: must not declare an environment (it runs before the production approval, without production credentials)`);
    if (usesSsh(asArray(verify.steps)) || PRODUCTION_CREDENTIAL.test(JSON.stringify(verify))) problems.push(`${where}: must not use production SSH or the DEPLOY_SSH_* credentials`);
    const steps = asArray(verify.steps);
    const validateAt = steps.findIndex(isValidation);
    const verifyAt = steps.findIndex(isVerification);
    const loginAt = steps.findIndex((s) => String(s.uses ?? '').startsWith('docker/login-action'));
    if (validateAt < 0 || (loginAt >= 0 && validateAt > loginAt)) {
      problems.push(`${where}: the digest must be validated against ${DIGEST_PATTERN} (from env) before any registry step`);
    }
    if (verifyAt < 0 || verifyAt < validateAt) {
      problems.push(`${where}: the artifact must be resolved and its revision label checked as an ancestor of main, after validation`);
    }
  }

  for (const [jobId, job] of deployJobs) {
    const where = `${fileName} job "${jobId}"`;
    if (jobId !== 'deploy') problems.push(`${where}: the SSH job must be "deploy"`);
    guarded(where, job);
    if (environmentOf(job) !== 'production') problems.push(`${where}: must be bound to the "production" environment (got "${environmentOf(job) ?? 'none'}")`);
    if (!asArray(job.needs).map(String).includes('verify')) problems.push(`${where}: must need the "verify" job (nothing is approved or deployed before verification)`);
    const steps = asArray(job.steps);
    const sshAt = steps.findIndex((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));
    const validateAt = steps.findIndex(isValidation);
    if (validateAt < 0 || validateAt > sshAt) problems.push(`${where}: the digest must be re-validated against ${DIGEST_PATTERN} (from env) before the SSH step`);
    const image = String(steps[sshAt]?.env?.IMAGE ?? '').trim();
    if (!/^\$\{\{\s*env\.IMAGE_NAME\s*\}\}@\$\{\{\s*inputs\.digest\s*\}\}$/.test(image)) {
      problems.push(`${where}: the SSH step must deploy exactly \${{ env.IMAGE_NAME }}@\${{ inputs.digest }} (got "${image}")`);
    }
  }
  return problems;
}

/** CI must actually run what it claims: every check below has to appear as a step of the matrix job. */
/** V2-A.3 (A3.2): the stable aggregate check of Core CI, the one check a `main` ruleset requires. */
export const CI_AGGREGATE = 'core-ci-passed';
const AGGREGATE_RESULT_RULE = 'all(.[]; .result == "success")';

/**
 * The aggregate must exist under its stable id and name, need EVERY other job of the workflow, always run (a skipped required check
 * counts as passed), and succeed only when every needed job succeeded. The workflow must report on every pull request to main: no
 * path filter. Nothing may turn a failure into a success (continue-on-error).
 */
export function checkCiAggregate(fileName, text) {
  const problems = [];
  const doc = parse(text);
  const jobs = doc?.jobs ?? {};
  const on = doc?.on ?? doc?.true;
  const pr = on && typeof on === 'object' && !Array.isArray(on) ? on.pull_request : undefined;
  if (pr === undefined && !(Array.isArray(on) ? on.includes('pull_request') : on === 'pull_request')) {
    problems.push(`${fileName}: must run on pull_request (the required check would never report)`);
  } else if (pr && typeof pr === 'object') {
    for (const filter of ['paths', 'paths-ignore']) {
      if (filter in pr) problems.push(`${fileName}: pull_request must have no ${filter} filter (${CI_AGGREGATE} must report on every pull request, including documentation-only ones)`);
    }
    if ('branches' in pr && !asArray(pr.branches).includes('main')) problems.push(`${fileName}: pull_request must cover main`);
    if ('branches-ignore' in pr) problems.push(`${fileName}: pull_request must not ignore branches`);
  }

  const job = jobs[CI_AGGREGATE];
  if (!job) return [...problems, `${fileName}: the aggregate job "${CI_AGGREGATE}" is missing`];
  const where = `${fileName} job "${CI_AGGREGATE}"`;
  if (job.name !== CI_AGGREGATE) problems.push(`${where}: its name must be exactly "${CI_AGGREGATE}" (the stable required-check name)`);
  if ('strategy' in job) problems.push(`${where}: must not be a matrix (its check name must stay stable)`);
  const condition = String(job.if ?? '').replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  if (condition !== 'always()') problems.push(`${where}: must have "if: always()" (a skipped required check counts as passed)`);
  if ('continue-on-error' in job) problems.push(`${where}: must not set continue-on-error`);

  const others = Object.keys(jobs).filter((id) => id !== CI_AGGREGATE);
  const needs = asArray(job.needs).map(String);
  const missing = others.filter((id) => !needs.includes(id));
  if (missing.length > 0) problems.push(`${where}: must need every other job (missing: ${missing.join(', ')})`);
  const unknown = needs.filter((id) => !others.includes(id));
  if (unknown.length > 0) problems.push(`${where}: needs unknown jobs (${unknown.join(', ')})`);

  const steps = asArray(job.steps);
  const verdict = steps.filter((s) => String(s.run ?? '').includes(AGGREGATE_RESULT_RULE));
  const fromNeeds = (s) => Object.values(s.env ?? {}).some((v) => /^\$\{\{\s*toJSON\(needs\)\s*\}\}$/.test(String(v).trim()));
  if (verdict.length !== 1 || !fromNeeds(verdict[0])) {
    problems.push(`${where}: exactly one step must decide from toJSON(needs) with jq '${AGGREGATE_RESULT_RULE}'`);
  } else if (firstCommandLine(verdict[0].run) !== 'set -euo pipefail') {
    problems.push(`${where}: the deciding step must start with "set -euo pipefail"`);
  }
  if (steps.some((s) => 'continue-on-error' in s || 'if' in s)) problems.push(`${where}: its steps must not be conditional or continue on error`);
  if (steps.some((s) => /\|\|\s*(true|:)\s*$/m.test(String(s.run ?? '')))) problems.push(`${where}: a step swallows its failure ("|| true")`);

  for (const id of others) {
    if ('continue-on-error' in (jobs[id] ?? {})) problems.push(`${fileName} job "${id}": must not set continue-on-error (it would report success to ${CI_AGGREGATE} after failing)`);
  }
  return problems;
}

export function checkCiCoverage(fileName, text) {
  const problems = [];
  const doc = parse(text);
  const runs = Object.values(doc?.jobs ?? {}).flatMap((j) => asArray(j.steps)).map((s) => String(s.run ?? ''));
  const has = (re) => runs.some((r) => re.test(r));
  for (const [label, re] of [['lint', /npm run lint/], ['typecheck', /npm run typecheck/], ['unit tests', /npm (run )?test\b/], ['build', /npm run build/], ['repository checks', /npm run check:repo/]]) {
    if (!has(re)) problems.push(`${fileName}: no step runs ${label}`);
  }
  if (!('permissions' in (doc ?? {}))) problems.push(`${fileName}: set top-level permissions (least privilege)`);
  return problems;
}

const PRODUCT_TERMS = /\b(student|teacher|driver|lesson|classroom|instructor|vehicle)s?\b/i;
/**
 * Identifiers split into words before matching (Stage 17.3): `instructorId`, `student_documents`, `driverPhoto` and plurals were
 * invisible to a whole-word match, and those are exactly the shapes a schema or a DTO would use.
 */
const identifierWords = (text) => text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
const DOMAIN_DECLARATION = /\b(?:class|interface|type|enum|function|const)\s+\w*(Invoice|Refund|Ledger|Journal|Wallet|Settlement|Payout|Payment|Product|Tax)\w*/;
// The kit reads Auth's identity contract (an organization id, a membership status) but holds no organization or membership logic.
const REFERENCE_WRITE_ALLOWLIST = new Set(['apps/auth-service/src/hierarchy/hierarchy-authority.ts', 'apps/auth-service/src/hierarchy/hierarchy-reference.ts']);
const KIT_IDENTITY_CONTRACT_ALLOWLIST = new Set(['libs/service-kit/src/service-auth/auth-client.ts']);

/**
 * Stage 17.5: invisible bidirectional control characters (U+202A–U+202E, U+2066–U+2069) make source read differently from how it runs
 * ("Trojan Source", CVE-2021-42574). Code and SQL must write them as escapes (`\u202E`). The one exception is a migration that is
 * already applied and checksummed (forward-only: it cannot be edited); its constraint is behaviourally correct and tested.
 */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;
const BIDI_ALLOWLIST = new Set(['apps/file-service/db/migrations/0001_file_schema.sql']);

/**
 * Stage 18.4: the audit contract's dependency direction. Producers and audit-service depend on `@nawara/audit-contract`; the contract
 * depends on nothing at runtime (its src imports only its own files); the kit never depends on it (Audit is a domain contract above the
 * transport); the consumer entry point (`/consumer`) is audit-service's; the `/testing` entry point is for tests only.
 */
function checkAuditContractDirection(relPath, spec) {
  const problems = [];
  const isContract = spec === '@nawara/audit-contract' || spec.startsWith('@nawara/audit-contract/');
  if (relPath.startsWith('libs/service-kit/') && isContract) {
    problems.push(`${relPath}: the service-kit must not depend on the audit contract (${spec}); audit is a domain contract above the kit`);
  }
  if (relPath.startsWith('libs/audit-contract/src/') && !spec.startsWith('./')) {
    problems.push(`${relPath}: the audit contract has no runtime dependency (${spec}); its source imports only its own files`);
  }
  const consumerAllowed = relPath.startsWith('apps/audit-service/') || relPath.startsWith('libs/audit-contract/');
  if (spec === '@nawara/audit-contract/consumer' && !consumerAllowed) {
    problems.push(`${relPath}: only audit-service may use the audit consumer API (${spec}); producers use AuditEventWriter`);
  }
  const isTest = /(^|\/)test\//.test(relPath) || /\.(e2e-|int-)?spec\.ts$/.test(relPath);
  if (spec === '@nawara/audit-contract/testing' && !isTest) problems.push(`${relPath}: ${spec} is test tooling; production code must not import it`);
  return problems;
}

/** No product concepts in Core services or the kit; no financial-domain declarations in the kit; no cross-service source imports. */
export function checkSource(relPath, text) {
  const problems = [];
  if (BIDI_CONTROL.test(text) && !BIDI_ALLOWLIST.has(relPath)) problems.push(`${relPath}: contains an invisible bidirectional control character (write it as an escape)`);
  const inKit = relPath.startsWith('libs/service-kit/');
  const inNewCore = /^apps\/(billing|payment|accounting|notification|organization|file|audit|release)-service\/(src|db\/migrations)\//.test(relPath)
    || relPath.startsWith('libs/audit-contract/');
  if ((inKit || inNewCore) && PRODUCT_TERMS.test(identifierWords(text))) problems.push(`${relPath}: contains a product-specific term (Core must stay generic)`);
  if (inKit && relPath.includes('/src/') && DOMAIN_DECLARATION.test(text) && !KIT_IDENTITY_CONTRACT_ALLOWLIST.has(relPath)) {
    problems.push(`${relPath}: declares a financial-domain concept; the service-kit holds technical infrastructure only`);
  }
  // Stage 21.C.2 (ADR-0040 decision 1): after the cutover Auth's hierarchy tables are a reference cache that ONLY the reference-cache
  // protocol writes. The database gate (migration 0008) opens for a transaction that sets `nawara.reference_write`; only the protocol
  // (`HierarchyReference.ensure`) and the helper that defines the gate may name it, so no other Auth path can place a hierarchy row.
  if (relPath.startsWith('apps/auth-service/src/') && !REFERENCE_WRITE_ALLOWLIST.has(relPath) && !relPath.endsWith('.spec.ts')
    && (/\bwithReferenceWrite\b/.test(text) || /nawara\.reference_write/.test(text))) {
    problems.push(`${relPath}: opens the hierarchy reference-write gate; only the reference-cache protocol (hierarchy/hierarchy-reference.ts) may place hierarchy rows`);
  }
  const app = /^apps\/([a-z-]+)\//.exec(relPath)?.[1];
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const other = /(?:^|\/)apps\/([a-z-]+)\//.exec(spec)?.[1] ?? (/^(?:\.\.\/)+([a-z-]+-service)\b/.exec(spec)?.[1]);
    if (other && other !== app) problems.push(`${relPath}: imports another service's source (${spec}); services talk over APIs and events only`);
    problems.push(...checkAuditContractDirection(relPath, spec));
  }
  return problems;
}

/**
 * The hierarchy snapshot contract (ADR-0040 decision 5): auth-service (the exporter) and organization-service (the importer) share NO code,
 * only this golden artifact. It is written by auth-service's real exporter, so if either copy changes without the other the two
 * implementations have drifted and the repository check fails.
 */
export function checkHierarchyFixtures(authText, orgText) {
  const problems = [];
  if (authText === undefined) problems.push('apps/auth-service/test/fixtures/hierarchy-snapshot.v1.json is missing');
  if (orgText === undefined) problems.push('apps/organization-service/test/fixtures/hierarchy-snapshot.v1.json is missing');
  if (authText !== undefined && orgText !== undefined && authText !== orgText) {
    problems.push('the hierarchy snapshot golden fixtures of auth-service and organization-service differ: the exporter and the importer have drifted');
  }
  return problems;
}

const AUTH_ERRORS_FILE = 'apps/auth-service/src/errors.ts';
// health.controller.ts's ServiceUnavailableException is infra readiness (Stage 13.2), not a business error: allowlisted by file, not by class.
const AUTH_INFRA_EXCEPTION_ALLOWLIST = new Set(['apps/auth-service/src/health/health.controller.ts']);
const NEST_HTTP_EXCEPTION_CTOR = /\bnew\s+(BadRequest|Unauthorized|Forbidden|NotFound|Conflict|Gone|PayloadTooLarge|UnsupportedMediaType|UnprocessableEntity|TooManyRequests|InternalServerError|NotImplemented|BadGateway|ServiceUnavailable|GatewayTimeout|HttpVersionNotSupported|MethodNotAllowed|RequestTimeout|PreconditionFailed|ImATeapot)Exception\s*\(/;

/**
 * Auth error-code coverage (Stage 13.2, ADR-0044 follow-on): every business error auth-service raises must carry
 * a stable, machine-readable `code` (`errors.ts`'s `authError()`/`notFound()`/`unauthenticated()`/`forbidden()`),
 * not a raw Nest exception class or an uncoded `HttpException`, so a future call site cannot silently regress
 * to the pre-Stage-13.2 uncoded shape.
 */
export function checkAuthErrorCoverage(relPath, text) {
  const problems = [];
  if (!relPath.startsWith('apps/auth-service/src/') || relPath === AUTH_ERRORS_FILE) return problems;
  if (!AUTH_INFRA_EXCEPTION_ALLOWLIST.has(relPath) && NEST_HTTP_EXCEPTION_CTOR.test(text)) {
    problems.push(`${relPath}: throws a raw Nest HTTP exception class; use authError()/notFound()/unauthenticated()/forbidden() from errors.ts so every business error carries a stable code (Stage 13.2)`);
  }
  for (const m of text.matchAll(/new\s+HttpException\s*\(/g)) {
    const idx = m.index ?? 0;
    if (!/\bcode\s*:/.test(text.slice(idx, idx + 300))) {
      problems.push(`${relPath}: throws a raw HttpException with no "code" field (near offset ${idx}); use authError() from errors.ts, or include an explicit code`);
    }
  }
  return problems;
}

/**
 * Financial isolation (ADR-0042 DEC-5): a Billing invoice and a Payment record carry NO platformId. Platform scope is resolved through
 * organization-service and is never a stored reference on a financial record. (Billing's own `platform_currency` is currency
 * configuration, not transaction ownership, and lives in its own migration.)
 */
export function checkNoPlatformIdOnFinancialRecords(relPath, text) {
  const problems = [];
  const financial = /^apps\/(billing-service\/db\/migrations\/\d+_invoice[a-z_]*|payment-service\/db\/migrations\/\d+_payment[a-z_]*)\.sql$/.test(relPath);
  if (financial && /platformId|platform_id/i.test(text.replace(/--.*$/gm, ''))) {
    problems.push(`${relPath}: a financial record must not carry a platformId (Platform scope is resolved through organization-service, ADR-0042)`);
  }
  return problems;
}
