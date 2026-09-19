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

const PRODUCT_TERMS = /\b(student|teacher|driver|lesson|classroom|instructor|vehicle)\b/i;
const DOMAIN_DECLARATION = /\b(?:class|interface|type|enum|function|const)\s+\w*(Invoice|Refund|Ledger|Journal|Wallet|Settlement|Payout|Payment|Product|Tax)\w*/;
// The kit reads Auth's identity contract (an organization id, a membership status) but holds no organization or membership logic.
const KIT_IDENTITY_CONTRACT_ALLOWLIST = new Set(['libs/service-kit/src/service-auth/auth-client.ts']);

/** No product concepts in Core services or the kit; no financial-domain declarations in the kit; no cross-service source imports. */
export function checkSource(relPath, text) {
  const problems = [];
  const inKit = relPath.startsWith('libs/service-kit/');
  const inNewCore = /^apps\/(billing|payment|accounting|notification)-service\/src\//.test(relPath);
  if ((inKit || inNewCore) && PRODUCT_TERMS.test(text)) problems.push(`${relPath}: contains a product-specific term (Core must stay generic)`);
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
