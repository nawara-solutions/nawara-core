// Static checks the repository enforces on itself. Pure functions (text in, problems out) so they are unit-testable.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
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
/** V2 A0.3: the revision label of a digest deployment must be a literal 40-hex commit SHA, refused otherwise, before the ancestry check. */
const REVISION_PATTERN = '^[0-9a-f]{40}$';
const REVISION_CHECK = /\[\[\s*"\$([A-Za-z_]\w*)"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]\s*\|\|[^\n]*\bexit 1\b/;
const ANCESTRY_CHECK = /git merge-base --is-ancestor\s+"\$([A-Za-z_]\w*)"\s+HEAD/;
/** Inputs of every Core service image besides the service itself: the libraries built inside it, the workspace manifests, the context. */
const SHARED_IMAGE_INPUTS = ['libs/service-kit/**', 'libs/audit-contract/**', 'package.json', 'package-lock.json', '.dockerignore'];

/**
 * V2 A0: an immutable image build. On a push to main (only), job `build-image` builds the service image once, pushes exactly
 * `IMAGE_NAME:sha-<commit>` with the revision and source labels, and captures and validates the INDEX digest. No job of the workflow
 * may use a production environment, the production SSH credentials, SSH or the production queue: building never deploys. Any other
 * job (auth-service's `build-develop`) is pull_request-only and never publishes a `sha-`, `:production` or `:latest` tag. The trigger
 * paths must cover every input of the image, including the workflow itself.
 */
export function checkImageBuild(fileName, text, { repository, app }) {
  const problems = [];
  const doc = parse(text);
  const on = doc?.on ?? doc?.true;
  const push = on && typeof on === 'object' ? on.push : undefined;
  if (!push || typeof push !== 'object') {
    problems.push(`${fileName}: an image build must run on push to main`);
  } else {
    const branches = asArray(push.branches).map(String);
    if (branches.length !== 1 || branches[0] !== 'main') problems.push(`${fileName}: an image build must run on push to main only (got: ${branches.join(', ') || 'no branch filter'})`);
    const paths = asArray(push.paths).map(String);
    const required = [`apps/${app}/**`, ...SHARED_IMAGE_INPUTS, `.github/workflows/${fileName}`];
    const missing = required.filter((r) => !paths.includes(r));
    if (missing.length > 0) problems.push(`${fileName}: push paths must include every image input (missing: ${missing.join(', ')})`);
  }
  // V2 A14 (D3): a pull request never publishes; only a push to main does.
  const unexpected = triggerNames(doc).filter((t) => t !== 'push');
  if (unexpected.length > 0) problems.push(`${fileName}: an image build runs only on push to main, never on ${unexpected.join(', ')} (pull requests are validated by Core CI without publishing)`);
  const imageName = String(doc?.env?.IMAGE_NAME ?? '');
  if (imageName !== `ghcr.io/\${{ github.repository_owner }}/${repository}`) problems.push(`${fileName}: IMAGE_NAME must be ghcr.io/\${{ github.repository_owner }}/${repository} (got "${imageName}")`);

  const jobs = doc?.jobs ?? {};
  const pushStep = (job) => asArray(job?.steps).find((st) => String(st.uses ?? '').startsWith('docker/build-push-action'));
  for (const [jobId, job] of Object.entries(jobs)) {
    const where = `${fileName} job "${jobId}"`;
    if (environmentOf(job) !== undefined) problems.push(`${where}: an image build must not declare an environment (building never deploys)`);
    if (usesSsh(asArray(job.steps)) || PRODUCTION_CREDENTIAL.test(JSON.stringify(job))) problems.push(`${where}: an image build must not use production SSH or the DEPLOY_SSH_* credentials`);
    if (job.concurrency?.group === PRODUCTION_GROUP || doc?.concurrency?.group === PRODUCTION_GROUP) problems.push(`${where}: an image build must not join the production queue`);
    if (job.permissions?.packages === 'write' && !pushStep(job)) problems.push(`${where}: packages: write only on a job that builds and pushes an image`);
    if (jobId !== 'build-image') problems.push(`${where}: an image workflow has exactly one job, build-image (V2 A14: no pull-request build publishes)`);
    if (jobId !== 'build-image' && (job.permissions?.['id-token'] === 'write' || job.permissions?.attestations === 'write')) problems.push(`${where}: only build-image may sign attestations`);
  }

  const build = jobs['build-image'];
  if (!build) return [...problems, `${fileName}: the "build-image" job is missing`];
  const where = `${fileName} job "build-image"`;
  const guard = String(build.if ?? '');
  if (!guard.includes("github.event_name == 'push'") || !guard.includes('refs/heads/main')) problems.push(`${where}: must be restricted to a push to refs/heads/main`);
  const steps = asArray(build.steps);
  const buildAt = steps.findIndex((st) => String(st.uses ?? '').startsWith('docker/build-push-action'));
  const step = steps[buildAt];
  if (!step) return [...problems, `${where}: no docker/build-push-action step`];
  if (step.id !== 'build') problems.push(`${where}: the build-push step must have id: build (its digest output is the deployment authority)`);
  if (String(step.with?.tags ?? '').trim() !== '${{ env.IMAGE_NAME }}:sha-${{ github.sha }}') problems.push(`${where}: the only tag must be \${{ env.IMAGE_NAME }}:sha-\${{ github.sha }} (got "${String(step.with?.tags ?? '').trim()}")`);
  const labels = String(step.with?.labels ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!labels.includes('org.opencontainers.image.revision=${{ github.sha }}')) problems.push(`${where}: the label org.opencontainers.image.revision=\${{ github.sha }} is required (deployments verify it)`);
  if (!labels.some((l) => l.startsWith('org.opencontainers.image.source='))) problems.push(`${where}: the label org.opencontainers.image.source is required`);
  const recorded = steps.slice(buildAt + 1).some((st) => Object.values(st.env ?? {}).some((v) => /^\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}$/.test(String(v).trim()))
    && String(st.run ?? '').includes(DIGEST_PATTERN));
  if (!recorded) problems.push(`${where}: the index digest (steps.build.outputs.digest) must be captured and validated against ${DIGEST_PATTERN} after the build`);
  // V2 A14: full BuildKit provenance and an SPDX SBOM from a digest-pinned generator (both inside the index the attestation covers).
  if (String(step.with?.provenance ?? '').trim() !== 'mode=max') problems.push(`${where}: the build-push step must set provenance: mode=max`);
  if (String(step.with?.attests ?? '').trim() !== SBOM_ATTEST) problems.push(`${where}: the build-push step must set exactly attests: ${SBOM_ATTEST} (the frozen SBOM generator; got "${String(step.with?.attests ?? '').trim()}")`);
  // V2 A14: the trusted provenance: a GitHub artifact attestation for the exact index digest, after the build, pushed next to the image.
  const attestAt = steps.findIndex((st) => String(st.uses ?? '').startsWith('actions/attest-build-provenance@'));
  const attest = steps[attestAt];
  if (!attest || attestAt < buildAt) {
    problems.push(`${where}: an actions/attest-build-provenance step must attest the image after the build`);
  } else {
    if (String(attest.with?.['subject-name'] ?? '').trim() !== '${{ env.IMAGE_NAME }}') problems.push(`${where}: the attestation subject-name must be exactly \${{ env.IMAGE_NAME }} (no tag)`);
    if (String(attest.with?.['subject-digest'] ?? '').trim() !== '${{ steps.build.outputs.digest }}') problems.push(`${where}: the attestation subject-digest must be exactly \${{ steps.build.outputs.digest }} (the index digest)`);
    if (attest.with?.['push-to-registry'] !== true) problems.push(`${where}: the attestation must be pushed to the registry (push-to-registry: true)`);
  }
  const perms = build.permissions ?? {};
  if (perms['id-token'] !== 'write' || perms.attestations !== 'write') problems.push(`${where}: build-image needs id-token: write and attestations: write (the attestation) at job level`);
  for (const k of ['id-token', 'attestations', 'packages']) if (doc?.permissions?.[k] === 'write') problems.push(`${fileName}: ${k}: write must be granted to build-image only, never at workflow level`);
  return problems;
}

// V2 A14.2a: THE SBOM generator: one frozen identity (name, version and digest), the same for every image build. It runs inside the
// build with the build context, so "something pinned" is not enough: changing it is a reviewed change of this constant.
export const SBOM_GENERATOR = 'docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9';
const SBOM_ATTEST = `type=sbom,generator=${SBOM_GENERATOR}`;
/**
 * V2 A14: the verify step must prove the trusted provenance of the exact digest: `gh attestation verify oci://$REF` pinned to this
 * repository, the service's own image workflow (the signer), refs/heads/main, the label's commit (same variable as the literal-SHA and
 * ancestry checks, between them), the SLSA v1 predicate and GitHub-hosted runners; refused on failure; then a jq re-check of the
 * certificate and the signed subject. No caller-supplied bundle, trusted root or looser identity; no `|| true`.
 */
const ATTESTATION_REPO = 'nawara-solutions/nawara-core';
function attestationProblems(where, step, run, revisionCheck, ancestry, signerWorkflow) {
  const problems = [];
  const wf = signerWorkflow ?? '<the service image workflow>';
  if (String(step.env?.REF ?? '').trim() !== '${{ env.IMAGE_NAME }}@${{ inputs.digest }}') problems.push(`${where}: REF must be exactly \${{ env.IMAGE_NAME }}@\${{ inputs.digest }} (the provenance is verified for that exact digest)`);
  if (!/^\$\{\{\s*github\.token\s*\}\}$/.test(String(step.env?.GH_TOKEN ?? '').trim())) problems.push(`${where}: GH_TOKEN must be \${{ github.token }} for gh attestation verify`);
  const at = run.indexOf('gh attestation verify');
  if (at < 0) return [...problems, `${where}: the provenance must be verified with gh attestation verify (no attestation check: refused)`];
  // The command is the `$(gh attestation verify …)` substitution; its refusal must follow it directly (not some later `|| {`).
  const close = run.indexOf(')', at);
  const cmd = close < 0 ? run.slice(at) : run.slice(at, close + 1);
  const flags = [
    ['the exact digest', /gh attestation verify\s+"oci:\/\/\$REF"/],
    [`--repo ${ATTESTATION_REPO}`, new RegExp(`--repo ${ATTESTATION_REPO.replace('/', '\\/')}(\\s|$)`)],
    [`--signer-workflow ${ATTESTATION_REPO}/.github/workflows/${wf}`, new RegExp(`--signer-workflow ${ATTESTATION_REPO.replace('/', '\\/')}\\/\\.github\\/workflows\\/${String(wf).replace(/[.]/g, '\\.')}(\\s|$)`)],
    ['--source-ref refs/heads/main', /--source-ref refs\/heads\/main(\s|$)/],
    ['--predicate-type https://slsa.dev/provenance/v1', /--predicate-type https:\/\/slsa\.dev\/provenance\/v1(\s|$)/],
    ['--deny-self-hosted-runners', /--deny-self-hosted-runners(\s|$)/],
    ['--format json', /--format json(\s|\)|$)/],
  ];
  for (const [name, re] of flags) if (!re.test(cmd)) problems.push(`${where}: gh attestation verify must use ${name}`);
  const source = /--source-digest\s+"\$([A-Za-z_]\w*)"/.exec(cmd);
  if (!source || !revisionCheck || source[1] !== revisionCheck[1]) problems.push(`${where}: gh attestation verify must bind --source-digest to the checked revision variable`);
  if (revisionCheck && ancestry && !(revisionCheck.index < at && at < ancestry.index)) problems.push(`${where}: the provenance must be verified after the literal-SHA check and before the ancestry check`);
  if (/--bundle|--custom-trusted-root|--cert-identity-regex|--no-public-good|--owner\b/.test(cmd)) problems.push(`${where}: gh attestation verify must not take a caller-supplied bundle, trusted root or looser identity`);
  if (close < 0 || !/^\s*\\?\s*\|\|\s*\{[^}]*\bexit 1\b/.test(run.slice(close + 1))) problems.push(`${where}: a failed gh attestation verify must refuse (|| { …; exit 1; })`);
  const jqAt = run.indexOf('jq -e', at);
  // The jq program ends where it reads the verified output (<<<"$verified"); its refusal must follow directly.
  const fed = jqAt < 0 ? -1 : run.indexOf('<<<"$verified"', jqAt);
  const jqEnd = fed < 0 ? -1 : fed + '<<<"$verified"'.length;
  const jq = jqAt < 0 ? '' : run.slice(jqAt, jqEnd < 0 ? undefined : jqEnd);
  const signer = `https://github.com/${ATTESTATION_REPO}/.github/workflows/${wf}@refs/heads/main`;
  const jqNeeds = [
    ['the signed subject digest', /index\(\$d\)/], ['the digest argument', /--arg d "\$\{REF##\*@sha256:\}"/],
    ['the signer', /\$c\.buildSignerURI == \$signer/], ['the signer argument', new RegExp(`--arg signer "${signer.replace(/[.]/g, '\\.').replace(/\//g, '\\/')}"`)],
    ['the source repository', new RegExp(`\\$c\\.sourceRepositoryURI == "https:\\/\\/github\\.com\\/${ATTESTATION_REPO.replace('/', '\\/')}"`)],
    ['the source ref', /\$c\.sourceRepositoryRef == "refs\/heads\/main"/], ['the source commit', /\$c\.sourceRepositoryDigest == \$rev/],
    ['the runner', /\$c\.runnerEnvironment == "github-hosted"/], ['the predicate', /predicateType == "https:\/\/slsa\.dev\/provenance\/v1"/],
    ['at least one verified result', /length >= 1/],
  ];
  if (!jq) problems.push(`${where}: the verified provenance must be re-checked with jq -e`);
  else {
    for (const [name, re] of jqNeeds) if (!re.test(jq)) problems.push(`${where}: the jq re-check must check ${name}`);
    if (jqEnd < 0 || !/^\s*(>\s*\/dev\/null)?\s*\\?\s*\|\|\s*\{[^}]*\bexit 1\b/.test(run.slice(jqEnd))) problems.push(`${where}: a failed jq re-check must refuse (|| { …; exit 1; })`);
    if (ancestry && jqAt > ancestry.index) problems.push(`${where}: the jq re-check must run before the ancestry check`);
  }
  return problems;
}

const BUILDS = /\bdocker\s+(buildx\s+)?build\b|\bbuildx\s+bake\b/;

/**
 * V2 A14.2a (D4, strict cutover): the canonical `verify` job (scripts/lib/digest-deploy-verify.yml). A shape check cannot prove that no
 * success path skips the trust checks (an early `exit 0`, an allow-listed digest, a bypass variable, a shadowing `gh()` function, a
 * conditional around the call, `continue-on-error`, a step `if`, `defaults.run.shell`, BASH_ENV through $GITHUB_ENV, …), so the job must
 * EQUAL the reviewed canonical one: the whole job (condition, runner, permissions, outputs, every step with every key) and every trust
 * script byte for byte. The only normalization: an action's commit SHA (checkActionPins keeps every reference a full SHA with its exact
 * release comment), so a reviewed Dependabot SHA bump does not need a template edit.
 */
const CANONICAL_VERIFY_TEMPLATE = readFileSync(new URL('./digest-deploy-verify.yml', import.meta.url), 'utf8');
function canonicalVerifyJob(service, signerWorkflow) {
  return parse(CANONICAL_VERIFY_TEMPLATE.replaceAll('<SIGNER>', signerWorkflow).replaceAll('<SERVICE>', service));
}
const normalizePins = (v, key) => (Array.isArray(v) ? v.map((x) => normalizePins(x))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizePins(x, k)]))
  : key === 'uses' && typeof v === 'string' ? v.replace(/@[0-9a-f]{40}$/, '@<full commit sha>') : v);
/** The first path where `actual` differs from `expected` (key order ignored), or null. */
function firstDifference(expected, actual, path = '') {
  if (expected === actual) return null;
  if (typeof expected !== typeof actual || expected === null || actual === null || typeof expected !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) {
    return path || '(root)';
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    const d = firstDifference(expected[k], actual[k], Array.isArray(expected) ? `${path}[${k}]` : `${path}.${k}`);
    if (d) return d;
  }
  return null;
}
function canonicalVerifyProblems(fileName, doc, repository, signerWorkflow) {
  const service = String(repository).replace(/^nawara-core-/, '');
  if (!signerWorkflow) return [`${fileName}: no signer workflow is known for ${repository}: the canonical verify job cannot be checked (refused)`];
  const expected = canonicalVerifyJob(service, signerWorkflow);
  const problems = [];
  const diff = firstDifference(normalizePins(expected), normalizePins(doc?.jobs?.verify));
  if (diff) problems.push(`${fileName} job "verify": must equal the canonical verify job (scripts/lib/digest-deploy-verify.yml) exactly; differs at verify${diff} (no bypass, no allow-list, no early success: D4)`);
  const deploy = doc?.jobs?.deploy;
  if (deploy && String(deploy.if ?? '') !== String(expected.if)) problems.push(`${fileName} job "deploy": its condition must be exactly "${expected.if}" (no always(), failure(), !cancelled() or other path that runs without a successful verify)`);
  if (deploy && JSON.stringify(asArray(deploy.needs)) !== '["verify"]') problems.push(`${fileName} job "deploy": must need exactly the "verify" job`);
  // Workflow-wide settings reach the verify scripts too: a default shell, or an environment such as BASH_ENV, would change them.
  if (doc?.defaults !== undefined) problems.push(`${fileName}: a digest deployment must not set workflow-level defaults (they would change how the verify scripts run)`);
  const env = Object.keys(doc?.env ?? {});
  if (env.length !== 1 || env[0] !== 'IMAGE_NAME') problems.push(`${fileName}: the workflow-level env must be exactly IMAGE_NAME (got: ${env.join(', ') || 'nothing'})`);
  return problems;
}

/**
 * V2-A.2: a digest deployment workflow deploys ONE EXACT, ALREADY-BUILT image of `repository` and never builds. It runs only on an
 * explicit dispatch with a digest and a typed confirmation; the digest is validated before any network step, resolved and checked
 * (existence, revision label, ancestry of main) before the SSH step, and the SSH step deploys exactly IMAGE_NAME@digest.
 */
export function checkDigestDeploy(fileName, text, repository, { signerWorkflow } = {}) {
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
    } else {
      // The extracted revision must be refused unless it is a literal commit SHA BEFORE the ancestry check: otherwise a label such as
      // `main` (a ref git resolves) would pass `merge-base --is-ancestor` (V2 A0.3, control D9).
      const run = String(steps[verifyAt].run);
      const revisionCheck = REVISION_CHECK.exec(run);
      const ancestry = ANCESTRY_CHECK.exec(run);
      if (!revisionCheck || !ancestry || revisionCheck[1] !== ancestry[1] || revisionCheck.index > ancestry.index) {
        problems.push(`${where}: the extracted revision must be refused unless it matches ${REVISION_PATTERN} (a literal commit SHA), before the ancestry check on the same variable`);
      }
      problems.push(...attestationProblems(where, steps[verifyAt], run, revisionCheck, ancestry, signerWorkflow));
    }
    if (verify.permissions?.attestations !== 'read') problems.push(`${where}: needs attestations: read (gh attestation verify) and nothing more`);
  }
  problems.push(...canonicalVerifyProblems(fileName, doc, repository, signerWorkflow));
  for (const [jobId, job] of jobs) {
    if (job.permissions?.['id-token'] || job.permissions?.attestations === 'write') problems.push(`${fileName} job "${jobId}": a deployment never signs (no id-token, no attestations: write)`);
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
/**
 * V2 A14 (D2): every external action is pinned to a full 40-hex commit SHA with its exact release as a comment
 * (`owner/repo@<sha> # vX.Y.Z`). Local `./` actions are allowed. No exceptions.
 */
const PINNED_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
export function checkActionPins(fileName, text) {
  const problems = [];
  const doc = parse(text);
  const refs = [];
  for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
    if (job?.uses) refs.push([jobId, String(job.uses)]);
    for (const st of asArray(job?.steps)) if (st?.uses !== undefined) refs.push([jobId, String(st.uses)]);
  }
  const lines = text.split('\n');
  for (const [jobId, ref] of refs) {
    if (ref.startsWith('./')) continue;
    const where = `${fileName} job "${jobId}"`;
    if (!PINNED_ACTION.test(ref)) { problems.push(`${where}: ${ref} must be pinned to a full 40-hex commit SHA (no tag, branch or short SHA)`); continue; }
    const commented = lines.filter((l) => new RegExp(`uses:\\s*${ref.replace(/[.]/g, '\\.').replace(/\//g, '\\/')}\\s+#\\s*v\\d+\\.\\d+\\.\\d+\\s*$`).test(l)).length;
    const total = lines.filter((l) => new RegExp(`uses:\\s*${ref.replace(/[.]/g, '\\.').replace(/\//g, '\\/')}(\\s|$)`).test(l)).length;
    if (commented !== total || total === 0) problems.push(`${where}: ${ref} must carry its exact release as a comment (# vX.Y.Z)`);
  }
  return problems;
}

/**
 * V2 A14: the production base images are pinned as tag@sha256:<digest> and identical everywhere: every FROM of the application
 * Dockerfiles (`dockerfiles`: path → text) and the DB_IMAGE of the production deploy scripts (`deployScripts`: path → text).
 */
const PINNED_IMAGE = /^[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;
export function checkImagePins(dockerfiles, deployScripts) {
  const problems = [];
  const froms = new Set();
  for (const [path, text] of Object.entries(dockerfiles)) {
    const lines = text.split('\n').filter((l) => /^FROM\s/i.test(l));
    if (lines.length === 0) problems.push(`${path}: no FROM line`);
    for (const l of lines) {
      const image = l.trim().split(/\s+/)[1] ?? '';
      if (!PINNED_IMAGE.test(image)) problems.push(`${path}: FROM ${image} must be pinned as <image>:<tag>@sha256:<64 hex>`);
      froms.add(image);
    }
  }
  if (froms.size > 1) problems.push(`application Dockerfiles must all use the same pinned base image (found: ${[...froms].join(', ')})`);
  if ([...froms].some((i) => !i.startsWith('node:22-alpine@'))) problems.push('application Dockerfiles must use the pinned node:22-alpine base');
  const dbs = new Set();
  for (const [path, text] of Object.entries(deployScripts)) {
    const m = /^DB_IMAGE=(\S*)$/m.exec(text);
    if (!m) { problems.push(`${path}: no DB_IMAGE`); continue; }
    if (!PINNED_IMAGE.test(m[1]) || !m[1].startsWith('postgres:')) problems.push(`${path}: DB_IMAGE=${m[1]} must be a pinned postgres:<tag>@sha256:<64 hex>`);
    dbs.add(m[1]);
  }
  if (dbs.size > 1) problems.push(`the production deploy scripts must all use the same pinned PostgreSQL image (found: ${[...dbs].join(', ')})`);
  return problems;
}

/**
 * V2 A12.5.1: the local observability overlay stays opt-in, loopback-only and credential-free. `base` is docker-compose.yml,
 * `overlay` docker-compose.observability.yml, `prometheus` its scrape configuration (all text). Checked on the parsed YAML:
 * - the base file never sets METRICS_ENABLED (normal development keeps the kit default: off);
 * - no file publishes a kit metrics listener (9464), the RabbitMQ Prometheus endpoint (15692, A12.5.2) or postgres-exporter (9187,
 *   A12.5.3) to the host;
 * - postgres-exporter (A12.5.3) uses the observability_monitor role, with its password interpolated from the environment and never in a
 *   connection URL, and only the overlay passes MONITORING_PASSWORD (the base file never creates the monitoring role);
 * - every overlay image is pinned as <image>:<tag>@sha256:<64 hex>, and every port it publishes is bound to 127.0.0.1;
 * - Prometheus gets no admin, lifecycle or remote-write-receiver flag, no Docker socket and no privileged mode;
 * - the scrape configuration holds no credential and no remote write, and has one job for each Core service plus `rabbitmq` and
 *   `postgres`.
 */
export const KIT_METRICS_PORT = 9464;
export const RABBITMQ_PROMETHEUS_PORT = 15692;
export const POSTGRES_EXPORTER_PORT = 9187;
const INTERNAL_METRICS_PORTS = [String(KIT_METRICS_PORT), String(RABBITMQ_PROMETHEUS_PORT), String(POSTGRES_EXPORTER_PORT)];
export const MONITORING_ROLE = 'observability_monitor';
export const LOCAL_SCRAPE_JOBS = ['auth-service', 'billing-service', 'payment-service', 'organization-service', 'notification-service', 'file-service',
  'audit-service', 'release-service', 'rabbitmq', 'postgres'];
const FORBIDDEN_PROMETHEUS_FLAGS = ['--web.enable-admin-api', '--web.enable-lifecycle', '--web.enable-remote-write-receiver'];
const FORBIDDEN_SCRAPE_KEYS = new Set(['basic_auth', 'authorization', 'bearer_token', 'bearer_token_file', 'oauth2', 'password', 'password_file', 'remote_write']);
function publishedPorts(service) {
  return (service?.ports ?? []).map((p) => {
    if (typeof p === 'object' && p !== null) return { hostIp: p.host_ip ?? '', published: String(p.published ?? ''), target: String(p.target ?? '') };
    const parts = String(p).split(':');
    const target = parts.pop() ?? '';
    const published = parts.pop() ?? '';
    return { hostIp: parts.join(':'), published, target };
  });
}
function forbiddenKeys(node, path = '') {
  if (Array.isArray(node)) return node.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (node === null || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => [...(FORBIDDEN_SCRAPE_KEYS.has(k) ? [`${path}${k}`] : []), ...forbiddenKeys(v, `${path}${k}.`)]);
}
export function checkLocalObservability(base, overlay, prometheus) {
  const problems = [];
  let b, o, p;
  try { b = parse(base); o = parse(overlay); p = parse(prometheus); } catch (e) { return [`observability configuration is not valid YAML: ${e.message}`]; }
  for (const [name, svc] of Object.entries(b?.services ?? {})) {
    const env = svc?.environment;
    const set = Array.isArray(env) ? env.some((e) => String(e).startsWith('METRICS_ENABLED=')) : env !== null && typeof env === 'object' && 'METRICS_ENABLED' in env;
    if (set) problems.push(`docker-compose.yml: ${name} sets METRICS_ENABLED; metrics are enabled only by docker-compose.observability.yml`);
  }
  for (const [file, doc] of [['docker-compose.yml', b], ['docker-compose.observability.yml', o]]) {
    for (const [name, svc] of Object.entries(doc?.services ?? {})) {
      for (const port of publishedPorts(svc)) {
        const internal = INTERNAL_METRICS_PORTS.find((p) => port.target === p || port.published === p);
        if (internal) problems.push(`${file}: ${name} publishes the metrics listener (${internal}) to the host`);
      }
    }
  }
  for (const [name, svc] of Object.entries(o?.services ?? {})) {
    if (svc?.image !== undefined && !PINNED_IMAGE.test(String(svc.image))) problems.push(`docker-compose.observability.yml: ${name} image ${svc.image} must be pinned as <image>:<tag>@sha256:<64 hex>`);
    for (const port of publishedPorts(svc)) if (port.hostIp !== '127.0.0.1') problems.push(`docker-compose.observability.yml: ${name} must publish ports on 127.0.0.1 only`);
    if (svc?.privileged) problems.push(`docker-compose.observability.yml: ${name} must not be privileged`);
    if ((svc?.volumes ?? []).some((v) => String(typeof v === 'object' ? v.source : v).includes('docker.sock'))) problems.push(`docker-compose.observability.yml: ${name} must not mount the Docker socket`);
  }
  const envOf = (svc) => {
    const env = svc?.environment;
    if (Array.isArray(env)) return Object.fromEntries(env.map((e) => String(e).split(/=(.*)/s).slice(0, 2)));
    return env !== null && typeof env === 'object' ? env : {};
  };
  if ('MONITORING_PASSWORD' in envOf(b?.services?.postgres)) problems.push('docker-compose.yml: postgres must not receive MONITORING_PASSWORD; only docker-compose.observability.yml creates the monitoring role');
  const exporter = o?.services?.['postgres-exporter'];
  if (!exporter) problems.push('docker-compose.observability.yml: no postgres-exporter service');
  else {
    const env = envOf(exporter);
    if ('DATA_SOURCE_NAME' in env) problems.push('docker-compose.observability.yml: postgres-exporter must not use DATA_SOURCE_NAME (a password in a URL); use DATA_SOURCE_URI with DATA_SOURCE_USER / DATA_SOURCE_PASS');
    if (String(env.DATA_SOURCE_URI ?? '').includes('@')) problems.push('docker-compose.observability.yml: postgres-exporter DATA_SOURCE_URI must not embed credentials');
    if (env.DATA_SOURCE_USER !== MONITORING_ROLE) problems.push(`docker-compose.observability.yml: postgres-exporter must connect as ${MONITORING_ROLE} (never a superuser, migrator or runtime role)`);
    if (!/^\$\{[A-Z0-9_]+(?::?[?-][^}]*)?\}$/.test(String(env.DATA_SOURCE_PASS ?? ''))) problems.push('docker-compose.observability.yml: postgres-exporter DATA_SOURCE_PASS must be interpolated from the environment, never written out');
  }
  const prom = o?.services?.prometheus;
  if (!prom) problems.push('docker-compose.observability.yml: no prometheus service');
  else for (const flag of (prom.command ?? []).map(String)) if (FORBIDDEN_PROMETHEUS_FLAGS.some((f) => flag.startsWith(f))) problems.push(`docker-compose.observability.yml: prometheus must not run with ${flag}`);
  for (const key of forbiddenKeys(p)) problems.push(`infra/observability/prometheus/prometheus.yml: ${key} is not allowed (no credential or remote write in the local scrape configuration)`);
  if (!Array.isArray(p?.scrape_configs) || p.scrape_configs.length === 0) problems.push('infra/observability/prometheus/prometheus.yml: no scrape_configs');
  else {
    const jobs = new Set(p.scrape_configs.map((j) => j?.job_name));
    for (const job of LOCAL_SCRAPE_JOBS) if (!jobs.has(job)) problems.push(`infra/observability/prometheus/prometheus.yml: no scrape job ${job}`);
  }
  return problems;
}

/**
 * V2 A12.6.1: the LOCAL Grafana in docker-compose.observability.yml and its repository provisioning. `overlay` is the overlay text,
 * `datasources` / `providers` the provisioning YAML, `dashboards` a map of repository path to dashboard JSON text, `envExample` the
 * .env.example text. Grafana:
 * - runs the pinned OSS image, published on 127.0.0.1:3100 only, read-only, all capabilities dropped, `no-new-privileges`, its runtime
 *   state in tmpfs (no volume for /var/lib/grafana) and its provisioning mounted read-only;
 * - has no anonymous access, no sign-up, and an admin password interpolated from the environment (never written out, never `admin`);
 * - never calls home and installs nothing: reporting, update checks, news, Gravatar, feedback links, plugin preinstall / auto-update /
 *   admin are off, and no plugin is requested;
 * - has exactly one datasource: Prometheus, uid `nawara-prometheus`, `http://prometheus:9090`, proxy access, no credential.
 * Dashboards are deterministic, reference that datasource by uid only, select series by `job` (only `nawara_service_info` carries
 * `service`), never fabricate zeroes with `or vector(0)`, and read readiness only where it ran (the kit exports 0 before the first run).
 */
export const GRAFANA_DATASOURCE_UID = 'nawara-prometheus';
export const GRAFANA_FOLDER = 'Nawara Core';
const GRAFANA_REQUIRED_ENV = {
  GF_AUTH_ANONYMOUS_ENABLED: 'false',
  GF_USERS_ALLOW_SIGN_UP: 'false',
  GF_USERS_ALLOW_ORG_CREATE: 'false',
  GF_SECURITY_DISABLE_GRAVATAR: 'true',
  GF_ANALYTICS_REPORTING_ENABLED: 'false',
  GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
  GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
  GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: 'false',
  GF_NEWS_NEWS_FEED_ENABLED: 'false',
  GF_PLUGINS_PREINSTALL_DISABLED: 'true',
  GF_PLUGINS_PREINSTALL_AUTO_UPDATE: 'false',
  GF_PLUGINS_PLUGIN_ADMIN_ENABLED: 'false',
};
const GRAFANA_FORBIDDEN_ENV = ['GF_INSTALL_PLUGINS', 'GF_PLUGINS_PREINSTALL', 'GF_PLUGINS_PREINSTALL_SYNC', 'GF_PLUGINS_PREINSTALL_ASYNC', 'GF_AUTH_ANONYMOUS_ORG_ROLE',
  'GF_SECURITY_ADMIN_PASSWORD__FILE', 'GF_AUTH_DISABLE_LOGIN_FORM', 'GF_AUTH_PROXY_ENABLED'];
const INTERPOLATED = /^\$\{[A-Z0-9_]+(?::?[?-][^}]*)?\}$/;
const DASHBOARD_VOLATILE_KEYS = ['id', 'version', 'iteration', 'created', 'updated', '__inputs', '__requires', '__elements'];
function walkJson(node, visit, path = '') {
  if (Array.isArray(node)) { node.forEach((v, i) => walkJson(v, visit, `${path}[${i}]`)); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) { visit(k, v, `${path}${path ? '.' : ''}${k}`); walkJson(v, visit, `${path}${path ? '.' : ''}${k}`); }
}
export function checkLocalGrafana(overlay, datasources, providers, dashboards, envExample) {
  const problems = [];
  const where = 'docker-compose.observability.yml: grafana';
  let o, ds, pv;
  try { o = parse(overlay); ds = parse(datasources); pv = parse(providers); } catch (e) { return [`Grafana configuration is not valid YAML: ${e.message}`]; }
  const g = o?.services?.grafana;
  if (!g) problems.push(`${where}: no grafana service`);
  else {
    if (!String(g.image ?? '').startsWith('grafana/grafana:') || !PINNED_IMAGE.test(String(g.image))) problems.push(`${where} must run grafana/grafana:<tag>@sha256:<64 hex> (the OSS image, pinned)`);
    const ports = publishedPorts(g);
    if (ports.length !== 1 || ports[0].hostIp !== '127.0.0.1' || ports[0].published !== '3100' || ports[0].target !== '3000') problems.push(`${where} must publish exactly 127.0.0.1:3100:3000`);
    if (g.read_only !== true) problems.push(`${where} must be read_only`);
    if (!asArray(g.cap_drop).includes('ALL')) problems.push(`${where} must drop all capabilities`);
    if (!asArray(g.security_opt).some((x) => /^no-new-privileges(:true)?$/.test(String(x)))) problems.push(`${where} must set no-new-privileges`);
    if (g.user !== undefined) problems.push(`${where} must keep the image's non-root user (no user override)`);
    if (g.privileged || g.network_mode === 'host' || g.pid === 'host' || g.cap_add) problems.push(`${where} must not be privileged, use the host network or PID namespace, or add capabilities`);
    for (const v of asArray(g.volumes)) {
      const text = typeof v === 'object' ? `${v.source}:${v.target}${v.read_only ? ':ro' : ''}` : String(v);
      const [source = '', target = ''] = text.split(':');
      if (!source.startsWith('./')) problems.push(`${where} volume ${text} must be a repository bind mount (runtime state is tmpfs, never a volume)`);
      if (!text.endsWith(':ro')) problems.push(`${where} volume ${text} must be read-only`);
      if (target === '/var/lib/grafana' || text.includes('docker.sock')) problems.push(`${where} volume ${text} is not allowed`);
    }
    if (!asArray(g.tmpfs).some((t) => String(typeof t === 'object' ? t.target : t).split(':')[0] === '/var/lib/grafana')) problems.push(`${where} must keep /var/lib/grafana in tmpfs`);
    const env = g.environment && typeof g.environment === 'object' && !Array.isArray(g.environment) ? g.environment : null;
    if (!env) problems.push(`${where} environment must be a map`);
    else {
      for (const [k, v] of Object.entries(GRAFANA_REQUIRED_ENV)) if (String(env[k]) !== v) problems.push(`${where} must set ${k}=${v}`);
      for (const k of GRAFANA_FORBIDDEN_ENV) if (k in env) problems.push(`${where} must not set ${k}`);
      if (!INTERPOLATED.test(String(env.GF_SECURITY_ADMIN_PASSWORD ?? ''))) problems.push(`${where} GF_SECURITY_ADMIN_PASSWORD must be interpolated from the environment, never written out`);
      for (const k of Object.keys(env)) if (/^GF_DATABASE_|^GF_REMOTE_CACHE_|^GF_UNIFIED_ALERTING_|^GF_SMTP_/.test(k)) problems.push(`${where} must not set ${k}`);
    }
  }
  const passwordLine = /^GRAFANA_ADMIN_PASSWORD=(.*)$/m.exec(envExample ?? '');
  if (!passwordLine) problems.push('.env.example: no GRAFANA_ADMIN_PASSWORD placeholder');
  else if (passwordLine[1].trim() === '' || passwordLine[1].trim() === 'admin') problems.push('.env.example: GRAFANA_ADMIN_PASSWORD must be a non-empty placeholder other than admin');

  const list = asArray(ds?.datasources);
  if (list.length !== 1) problems.push(`infra/observability/grafana/provisioning/datasources: exactly one datasource is allowed (found ${list.length})`);
  for (const d of list) {
    if (d?.type !== 'prometheus' || d?.uid !== GRAFANA_DATASOURCE_UID || d?.url !== 'http://prometheus:9090' || d?.access !== 'proxy') {
      problems.push(`infra/observability/grafana/provisioning/datasources: the datasource must be type prometheus, uid ${GRAFANA_DATASOURCE_UID}, url http://prometheus:9090, access proxy`);
    }
    for (const k of ['basicAuth', 'basicAuthUser', 'user', 'password', 'secureJsonData', 'withCredentials', 'database']) if (d && k in d) problems.push(`infra/observability/grafana/provisioning/datasources: ${k} is not allowed (Prometheus needs no credential)`);
  }
  if (asArray(ds?.deleteDatasources).length) problems.push('infra/observability/grafana/provisioning/datasources: deleteDatasources is not used');
  const provs = asArray(pv?.providers);
  if (provs.length !== 1 || provs[0]?.folder !== GRAFANA_FOLDER || provs[0]?.type !== 'file' || provs[0]?.allowUiUpdates !== false || provs[0]?.disableDeletion !== true) {
    problems.push(`infra/observability/grafana/provisioning/dashboards: one file provider, folder "${GRAFANA_FOLDER}", allowUiUpdates false, disableDeletion true`);
  }

  const uids = new Map();
  for (const [file, text] of Object.entries(dashboards)) {
    let d;
    try { d = JSON.parse(text); } catch (e) { problems.push(`${file}: not valid JSON (${e.message})`); continue; }
    if (typeof d?.uid !== 'string' || !/^[a-z0-9-]{1,40}$/.test(d.uid)) problems.push(`${file}: a fixed lowercase uid is required`);
    else if (uids.has(d.uid)) problems.push(`${file}: uid ${d.uid} is also used by ${uids.get(d.uid)}`);
    else uids.set(d.uid, file);
    for (const k of DASHBOARD_VOLATILE_KEYS) if (d && k in d) problems.push(`${file}: top-level "${k}" is not allowed (dashboards are deterministic: no numeric id, version, timestamp or export inputs)`);
    walkJson(d, (k, v, path) => {
      if (k === 'datasource' && v !== null && !(typeof v === 'object' && v.type === 'prometheus' && v.uid === GRAFANA_DATASOURCE_UID)) {
        problems.push(`${file}: ${path} must be {"type":"prometheus","uid":"${GRAFANA_DATASOURCE_UID}"}`);
      }
      if (k === 'expr' && typeof v === 'string') {
        if (/\bor\s+vector\s*\(/.test(v)) problems.push(`${file}: ${path} uses "or vector(...)" (a fabricated value hides no data)`);
        if (/nawara_readiness_/.test(v) && !/nawara_readiness_last_run_timestamp_seconds(\{[^}]*\})?\s*>\s*0\b/.test(v)) {
          problems.push(`${file}: ${path} reads readiness without "nawara_readiness_last_run_timestamp_seconds > 0" (before the first /ready run the kit exports 0: "not run" must never read as not ready)`);
        }
        if (/\bservice\s*(=~|!~|!=|=)/.test(v) || /\b(by|without)\s*\([^)]*\bservice\b/.test(v)) {
          if (!v.includes('nawara_service_info')) problems.push(`${file}: ${path} selects on "service"; use "job" (only nawara_service_info carries service)`);
        }
      }
    });
  }
  if (!uids.has('nawara-core-overview')) problems.push('infra/observability/grafana/dashboards: the Core overview dashboard (uid nawara-core-overview) is missing');
  return problems;
}

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

/**
 * V2 A12.2 (A12.2a: syntax-aware): the metrics client library (prom-client, or its successor @prometheus-io/client) is referenced ONLY
 * by the kit's metrics module, so every metric goes through BoundedMetrics and its closed label policy; a raw constructor elsewhere
 * could label a series with an identifier, a token or free text.
 *
 * The source is PARSED (the TypeScript compiler API, already a workspace dependency), never regex-stripped, so a string or template
 * that merely looks like a comment ("a//b", "apps/*\/src") can neither hide an import nor create one. A reference is a STATIC module
 * specifier (a string or a template literal without substitutions, escapes decoded) in: an import or export declaration, an import
 * type, `import x = require()`, a dynamic `import()`, `require()`, `module.require()`, `require.resolve()`, or a function obtained from
 * `createRequire(...)` (called directly or through a variable). Comments, ordinary strings and lookalike packages are not references.
 * A fully computed specifier, an npm alias in package metadata or a relative path into the kit's source cannot be decided statically:
 * those stay with owner review (the A14.4 trust boundary).
 */
const METRICS_CLIENT = /^(?:prom-client|@prometheus-io\/client)(?:\/|$)/;
export const METRICS_CLIENT_HOME = 'libs/service-kit/src/metrics/';
const PARSED = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

const staticSpecifier = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
const unwrap = (node) => (node && ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node);
const calleeName = (node) => {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  return undefined;
};
const isCreateRequireCall = (node) => {
  const n = unwrap(node);
  return !!n && ts.isCallExpression(n) && calleeName(n.expression) === 'createRequire';
};

/** The static metrics-client module specifiers a source file references (empty when none). */
export function metricsClientReferences(relPath, text) {
  const kind = /\.[cm]?ts$|\.tsx$/.test(relPath) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const requireAliases = new Set();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isCreateRequireCall(node.initializer)) requireAliases.add(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isCreateRequireCall(node.right)) requireAliases.add(node.left.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);

  const specifiers = [];
  const visit = (node) => {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = staticSpecifier(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = staticSpecifier(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec = staticSpecifier(node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword // import('x')
        || (ts.isIdentifier(callee) && (callee.text === 'require' || requireAliases.has(callee.text))) // require('x'), r('x')
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require') // module.require('x')
        || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && ['require', ...requireAliases].includes(calleeName(callee.expression) ?? '')) // require.resolve('x')
        || isCreateRequireCall(callee); // createRequire(url)('x')
      if (loads) spec = staticSpecifier(node.arguments[0]);
    }
    if (spec !== undefined && METRICS_CLIENT.test(spec)) specifiers.push(spec);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specifiers;
}

export function checkMetricsClientImport(relPath, text) {
  if (relPath.startsWith(METRICS_CLIENT_HOME) || !PARSED.test(relPath) || relPath.endsWith('.d.ts')) return [];
  return metricsClientReferences(relPath, text).length > 0
    ? [`${relPath}: imports the metrics client library; only ${METRICS_CLIENT_HOME} may (create metrics through the kit's BoundedMetrics)`]
    : [];
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
  problems.push(...checkMetricsClientImport(relPath, text));
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
