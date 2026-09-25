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

  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = asArray(job.steps);
    const where = `${fileName} job "${jobId}"`;
    const ssh = steps.filter((s) => String(s.uses ?? '').startsWith('appleboy/ssh-action'));
    const pushesProdTag = steps.some((s) => String(s.uses ?? '').startsWith('docker/build-push-action') && String(s.with?.tags ?? '').includes(':production'));

    if (ssh.length > 0) {
      deploys = true;
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

/** CI must actually run what it claims: every check below has to appear as a step of the matrix job. */
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
const KIT_IDENTITY_CONTRACT_ALLOWLIST = new Set(['libs/service-kit/src/service-auth/auth-client.ts']);

/**
 * Stage 17.5: invisible bidirectional control characters (U+202A–U+202E, U+2066–U+2069) make source read differently from how it runs
 * ("Trojan Source", CVE-2021-42574). Code and SQL must write them as escapes (`\u202E`). The one exception is a migration that is
 * already applied and checksummed (forward-only: it cannot be edited); its constraint is behaviourally correct and tested.
 */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;
const BIDI_ALLOWLIST = new Set(['apps/file-service/db/migrations/0001_file_schema.sql']);

/** No product concepts in Core services or the kit; no financial-domain declarations in the kit; no cross-service source imports. */
export function checkSource(relPath, text) {
  const problems = [];
  if (BIDI_CONTROL.test(text) && !BIDI_ALLOWLIST.has(relPath)) problems.push(`${relPath}: contains an invisible bidirectional control character (write it as an escape)`);
  const inKit = relPath.startsWith('libs/service-kit/');
  const inNewCore = /^apps\/(billing|payment|accounting|notification|organization|file|audit)-service\/(src|db\/migrations)\//.test(relPath);
  if ((inKit || inNewCore) && PRODUCT_TERMS.test(identifierWords(text))) problems.push(`${relPath}: contains a product-specific term (Core must stay generic)`);
  if (inKit && relPath.includes('/src/') && DOMAIN_DECLARATION.test(text) && !KIT_IDENTITY_CONTRACT_ALLOWLIST.has(relPath)) {
    problems.push(`${relPath}: declares a financial-domain concept; the service-kit holds technical infrastructure only`);
  }
  const app = /^apps\/([a-z-]+)\//.exec(relPath)?.[1];
  for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const other = /(?:^|\/)apps\/([a-z-]+)\//.exec(spec)?.[1] ?? (/^(?:\.\.\/)+([a-z-]+-service)\b/.exec(spec)?.[1]);
    if (other && other !== app) problems.push(`${relPath}: imports another service's source (${spec}); services talk over APIs and events only`);
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
