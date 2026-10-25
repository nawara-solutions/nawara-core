// Static checks the repository enforces on itself. Pure functions (text in, problems out) so they are unit-testable.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
/**
 * V2-A.3 A3.6: the production host key is pinned. appleboy/ssh-action (drone-ssh / easyssh-proxy) accepts ANY host key when its
 * `fingerprint` is empty, so every SSH step reads exactly this secret, and a guard step before it stops the job while the secret is
 * absent or malformed. drone-ssh also reads the fingerprint from PLUGIN_FINGERPRINT and SSH_FINGERPRINT (before INPUT_FINGERPRINT), so
 * no fingerprint variable may be set in an `env:` other than the guard's own.
 */
export const HOST_KEY_SECRET = 'DEPLOY_SSH_FINGERPRINT';
const HOST_KEY_EXPRESSION = /^\$\{\{\s*secrets\.DEPLOY_SSH_FINGERPRINT\s*\}\}$/;
/** The guard's script, line by line (compared after trimming each line). */
export const HOST_KEY_GUARD_RUN = [
  '[[ $DEPLOY_SSH_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] \\',
  '|| { echo "::error::DEPLOY_SSH_FINGERPRINT is missing or is not a SHA256 host-key fingerprint; nothing was sent to the server"; exit 1; }',
];
const FINGERPRINT_VARIABLE = /FINGERPRINT/i;

/**
 * Core V2 M2 B1: the scheduled backup. ONE workflow, schedule-only, in its own environment `production-backup` (main only, no
 * interactive reviewer) with only the dedicated BACKUP_SSH_* secrets. It runs nothing from the repository on the server: one native SSH
 * session, host key pinned, no remote command; the server's `restrict,command=` line runs the installed entry script
 * (infra/backup/scheduled-backup.sh). Inactive until the repository variable CORE_BACKUP_SCHEDULE is `enabled`.
 */
export const BACKUP_ENVIRONMENT = 'production-backup';
export const SCHEDULED_BACKUP_WORKFLOW = 'core-backup-scheduled.yml';
export const SCHEDULED_BACKUP_CRON = '17 2 * * *';
export const SCHEDULED_BACKUP_GUARD = "github.ref == 'refs/heads/main' && vars.CORE_BACKUP_SCHEDULE == 'enabled'";
export const SCHEDULED_BACKUP_SECRETS = ['BACKUP_SSH_HOST', 'BACKUP_SSH_PORT', 'BACKUP_SSH_USER', 'BACKUP_SSH_KEY', 'BACKUP_SSH_KNOWN_HOSTS'];
export const SCHEDULED_BACKUP_INSTALL_DIR = '/usr/local/libexec/nawara-core-backup';
export const SCHEDULED_BACKUP_SERVICES = 'auth-service organization-service';
/** The only remote target of the scheduled job: no command after it (the server's forced command decides what runs). */
const SCHEDULED_BACKUP_TARGET = '-- "$BACKUP_SSH_USER@$BACKUP_SSH_HOST"';
/** The ssh options the scheduled job must pass: no config file, no agent, no password, the pinned host key only, nothing forwarded. */
export const SCHEDULED_BACKUP_SSH_OPTIONS = ['-F /dev/null', '-T', '-n', 'BatchMode=yes', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no', 'StrictHostKeyChecking=yes', 'UserKnownHostsFile="$d/known_hosts"', 'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no',
  'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'RequestTTY=no'];
/** What the scheduled job's shell must never do: weaken the host key, fetch or decode a script, pipe into a shell, or run a local command. */
const SCHEDULED_BACKUP_FORBIDDEN = [
  [/StrictHostKeyChecking=(?!yes\b)/, 'weakens host-key checking'],
  [/(^|[^\w.-])(ssh-keyscan|scp|sftp|rsync|curl|wget|git|base64|eval|source|python3?|node|perl)(?=\s|$)/m, 'runs a transfer, fetch, decode or interpreter command'],
  [/\bbash\s+-s\b|\|\s*(ba|z|da)?sh\b/, 'pipes a script into a shell'],
  [/ProxyCommand|ProxyJump|LocalCommand|PermitLocalCommand|SendEnv|SetEnv|RemoteCommand|-J\s|-W\s|-[LRD]\s/, 'uses an ssh proxy, local command, environment passing, remote command or forwarding option'],
];
/** A use of the scheduled-backup credentials, in any spelling. */
const BACKUP_CREDENTIAL = /secrets\s*(?:\.\s*|\[\s*\\?['"])BACKUP_SSH_/;
/** A native remote shell or transfer: production access as much as the SSH action is. */
const NATIVE_REMOTE_SHELL = /(^|[^\w.$/-])(ssh|scp|sftp|ssh-keyscan)(?=\s|$)/m;
/** The activation guard of the scheduled backup; read by no other workflow (the removed mechanism of core-backup.yml stays removed). */
const SCHEDULE_GUARD_READ = /vars\s*(?:\.\s*|\[\s*['"])CORE_BACKUP_SCHEDULE\b/;

/**
 * Core V2 M2 T6: the network probe. ONE workflow, dispatch-only, one job behind the `production` approval, that joins the tailnet as an
 * ephemeral tag:nawara-ci-probe node (GitHub OIDC → Tailscale workload identity federation), reaches the SSH port of TS_PROBE_HOST and
 * compares the server's ECDSA host key with DEPLOY_SSH_FINGERPRINT without authenticating. It is the only job that may hold
 * `id-token: write` in a production environment, use the Tailscale action or read a TS_* secret. No checkout, no SSH login, no remote
 * command, no backup; never DEPLOY_SSH_HOST/USER/PASSWORD or BACKUP_SSH_*.
 */
export const PROBE_WORKFLOW = 'core-network-probe.yml';
export const PROBE_JOB = 'probe';
export const PROBE_GUARD = "github.ref == 'refs/heads/main'";
export const PROBE_RUNNER = 'ubuntu-24.04';
export const PROBE_TIMEOUT_MINUTES = 10;
/** The reviewed action release, at its commit (the tag v4.2.0 points directly to it), and the client it installs. */
export const TAILSCALE_ACTION = 'tailscale/github-action@d1b6cd204f8dceda5b3eaad7f1f767be390056cd';
export const TAILSCALE_ACTION_RELEASE = 'v4.2.0';
export const TAILSCALE_CLIENT_VERSION = '1.94.2';
/** Tailscale's published SHA-256 of tailscale_1.94.2_amd64.tgz, independently verified against the downloaded tarball (2026-10-17). */
export const TAILSCALE_CLIENT_SHA256 = 'c6f99a5d774c7783b56902188d69e9756fc3dddfb08ac6be4cb2585f3fecdc32';
export const PROBE_TAG = 'tag:nawara-ci-probe';
/** The Tailscale step's inputs, exactly: OIDC client id and audience, the tag, the pinned client, no cache. Nothing else is accepted. */
export const PROBE_TAILSCALE_WITH = {
  'oauth-client-id': '${{ secrets.TS_PROBE_OIDC_CLIENT_ID }}',
  audience: '${{ secrets.TS_PROBE_OIDC_AUDIENCE }}',
  tags: PROBE_TAG,
  version: TAILSCALE_CLIENT_VERSION,
  sha256sum: TAILSCALE_CLIENT_SHA256,
  'use-cache': 'false',
};
/** The env of both script steps, exactly: the tailnet destination and the two values the probe checks, read and never changed. */
export const PROBE_ENV = {
  TS_PROBE_HOST: '${{ secrets.TS_PROBE_HOST }}',
  DEPLOY_SSH_PORT: '${{ secrets.DEPLOY_SSH_PORT }}',
  DEPLOY_SSH_FINGERPRINT: '${{ secrets.DEPLOY_SSH_FINGERPRINT }}',
};
/** Every secret the probe may read (in its env and the Tailscale inputs); any other secret reference is refused. */
export const PROBE_SECRETS = ['TS_PROBE_OIDC_CLIENT_ID', 'TS_PROBE_OIDC_AUDIENCE', 'TS_PROBE_HOST', 'DEPLOY_SSH_PORT', 'DEPLOY_SSH_FINGERPRINT'];
/** What a tailnet job's own scripts (the probe's two steps, the backup's destination check) must never do. */
const TAILNET_SCRIPT_FORBIDDEN = [
  [/(^|[^\w.$/-])(ssh|scp|sftp|sshpass|rsync)(?=\s|$)/m, 'runs an SSH login or a file transfer'],
  [/(^|[^\w.-])(nc|ncat|netcat|socat|telnet|curl|wget|gh|git|docker|tailscale|base64|eval|source|sudo|node|perl)(?=\s|$)/m, 'runs a network, transfer, decode, privilege or interpreter command'],
  [/\bbash\s+-s\b|\|\s*(ba|z|da)?sh\b/, 'pipes a script into a shell'],
  [/\bset\s+-[a-wyz]*x|\bset\s+-o\s+xtrace|\bxtrace\b/, 'enables command tracing (it would print the values)'],
  [/(?<!<)>{1,2}\s*(?!\/dev\/null\b|&)[^\s]/, 'writes a file (output only to the log)'],
];
/** What the probe's scripts must never do: the tailnet rules, and no backup or repository script. */
const PROBE_FORBIDDEN = [...TAILNET_SCRIPT_FORBIDDEN, [/backup|infra\//i, 'refers to a backup or a repository script']];
/** A use of any TS_* secret, in any spelling: only the two tailnet jobs read them, each its own prefix. */
const TAILNET_CREDENTIAL = /secrets\s*(?:\.\s*|\[\s*\\?['"])TS_/;

/**
 * Core V2 M2 T7: the manual backup reaches Server 1 over the tailnet. Its one job joins as an ephemeral tag:nawara-ci-prod node (its own
 * federated credential, TS_BACKUP_OIDC_*) after a fail-closed check that TS_BACKUP_HOST is exactly one IPv4 address inside 100.64.0.0/10,
 * then runs the unchanged SSH step against that address. The job is pinned whole: checkout (no ref) → package → host-key guard →
 * destination check → Tailscale → SSH, with the login, the host-key pin, the forwarded variables and the remote script exactly as before.
 */
export const BACKUP_WORKFLOW = 'core-backup.yml';
export const BACKUP_JOB = 'backup';
export const BACKUP_TAG = 'tag:nawara-ci-prod';
export const BACKUP_PERMISSIONS = { contents: 'read', 'id-token': 'write' };
export const BACKUP_TAILSCALE_WITH = {
  'oauth-client-id': '${{ secrets.TS_BACKUP_OIDC_CLIENT_ID }}',
  audience: '${{ secrets.TS_BACKUP_OIDC_AUDIENCE }}',
  tags: BACKUP_TAG,
  version: TAILSCALE_CLIENT_VERSION,
  sha256sum: TAILSCALE_CLIENT_SHA256,
  'use-cache': 'false',
};
/** The destination check reads exactly the two values the SSH step connects to, through the same secret expressions. */
export const BACKUP_DESTINATION_ENV = {
  TS_BACKUP_HOST: '${{ secrets.TS_BACKUP_HOST }}',
  DEPLOY_SSH_PORT: '${{ secrets.DEPLOY_SSH_PORT }}',
};
/** The SSH step's inputs, exactly (besides the script): the tailnet host and the validated port; login and pin as before. */
export const BACKUP_SSH_WITH = {
  host: BACKUP_DESTINATION_ENV.TS_BACKUP_HOST,
  username: '${{ secrets.DEPLOY_SSH_USER }}',
  password: '${{ secrets.DEPLOY_SSH_PASSWORD }}',
  port: BACKUP_DESTINATION_ENV.DEPLOY_SSH_PORT,
  fingerprint: '${{ secrets.DEPLOY_SSH_FINGERPRINT }}',
  envs: 'BACKUP_B64,BACKUP_SERVICES',
};
export const BACKUP_SSH_ACTION = 'appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2';
export const BACKUP_REMOTE_SCRIPT = ['set -euo pipefail', `printf '%s' "$BACKUP_B64" | base64 -d | BACKUP_SERVICES="$BACKUP_SERVICES" bash -s`];
export const BACKUP_PACKAGE_RUN = 'echo "BACKUP_B64=$(base64 -w0 infra/backup/backup.sh)" >> "$GITHUB_ENV"';
/** Every secret the backup job may read; DEPLOY_SSH_HOST (the shared LAN destination) is not among them. */
export const BACKUP_JOB_SECRETS = ['TS_BACKUP_OIDC_CLIENT_ID', 'TS_BACKUP_OIDC_AUDIENCE', 'TS_BACKUP_HOST', 'DEPLOY_SSH_USER', 'DEPLOY_SSH_PASSWORD', 'DEPLOY_SSH_PORT', 'DEPLOY_SSH_FINGERPRINT'];
/** The two tailnet jobs: each its own workflow, job and TS_* prefix. Nothing else may hold id-token in production, the action or TS_*. */
const TAILNET_JOBS = [
  { file: PROBE_WORKFLOW, job: PROBE_JOB, prefix: 'TS_PROBE_', label: 'the network probe job' },
  { file: BACKUP_WORKFLOW, job: BACKUP_JOB, prefix: 'TS_BACKUP_', label: 'the manual backup job' },
];
const TAILNET_JOB_LIST = TAILNET_JOBS.map((t) => `${t.label} ("${t.job}" of ${t.file}, ${t.prefix}*)`).join(' and ');

/**
 * Core V2 M2 T7: drone-ssh (inside appleboy/ssh-action) reads every connection setting from PLUGIN_*, SSH_* (PROXY_SSH_* for the proxy)
 * BEFORE the action's INPUT_* values, and `host` from a `.host` file when no variable is set; DEBUG prints its configuration. Any such
 * variable at workflow, job or SSH-step level, or written to $GITHUB_ENV by an earlier step, would silently replace the reviewed host,
 * port, user, password or host-key pin. The action's own INPUT_* names are reserved too.
 */
const DRONE_SSH_OVERRIDE = /^(PLUGIN_|SSH_|PROXY_|INPUT_)|^DEBUG$/i;
/** The only inputs of appleboy/ssh-action a production SSH step may set (no proxy, protocol, key, timeout, allenvs, debug or sync). */
export const SSH_ACTION_INPUTS = ['host', 'username', 'password', 'port', 'fingerprint', 'envs', 'script'];
/** The one accepted form of a $GITHUB_ENV write in a production SSH job: one literal NAME=value line, nothing else on it. */
const GITHUB_ENV_LITERAL_WRITE = /^echo "([A-Za-z_][A-Za-z0-9_]*)=[^"\n]*" >> "\$GITHUB_ENV"$/;
/** Every `secrets.NAME` reference, in any spelling. */
const SECRET_REFERENCE = /secrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*\\?['"]([A-Za-z_][A-Za-z0-9_]*)\\?['"]\s*\])/g;

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

/**
 * Core V2 M2 T7: no connection setting of a production SSH step can come from anywhere but its reviewed inputs: only the allowed
 * inputs, no drone-ssh override variable at workflow, job or SSH-step level, and $GITHUB_ENV written only as one literal NAME=value
 * line per write whose NAME is not an override (any other use of $GITHUB_ENV, or $GITHUB_PATH, cannot be ruled out and is refused).
 */
function sshOverrideProblems(where, doc, job, steps) {
  const out = [];
  for (const step of steps) {
    if (!String(step.uses ?? '').startsWith('appleboy/ssh-action')) continue;
    const extra = Object.keys(step.with ?? {}).filter((k) => !SSH_ACTION_INPUTS.includes(k));
    if (extra.length > 0) out.push(`${where}: the SSH step may set only ${SSH_ACTION_INPUTS.join(', ')} (found: ${extra.join(', ')}); no proxy, protocol, key, timeout, allenvs, debug or sync input`);
    const keys = Object.keys(step.env && typeof step.env === 'object' ? step.env : {}).filter((k) => DRONE_SSH_OVERRIDE.test(k));
    if (keys.length > 0) out.push(`${where}: no drone-ssh override variable may be set at SSH-step level (found: ${keys.join(', ')}); it would replace the reviewed connection settings`);
  }
  for (const [level, env] of [['workflow', doc?.env], ['job', job.env]]) {
    const keys = Object.keys(env && typeof env === 'object' ? env : {}).filter((k) => DRONE_SSH_OVERRIDE.test(k));
    if (keys.length > 0) out.push(`${where}: no drone-ssh override variable may be set at ${level} level (found: ${keys.join(', ')}); it would replace the reviewed connection settings`);
  }
  for (const step of steps) {
    for (const line of String(step.run ?? '').split('\n')) {
      if (/GITHUB_PATH/.test(line)) out.push(`${where}: a production SSH job never writes $GITHUB_PATH (it could replace the tools the SSH action runs)`);
      if (!/GITHUB_ENV/.test(line)) continue;
      const name = line.trim().match(GITHUB_ENV_LITERAL_WRITE)?.[1];
      if (name === undefined) out.push(`${where}: $GITHUB_ENV may only be written as one literal line, echo "NAME=value" >> "$GITHUB_ENV" (found: "${line.trim()}"); any other form cannot be ruled out as a connection override`);
      else if (DRONE_SSH_OVERRIDE.test(name) || FINGERPRINT_VARIABLE.test(name)) out.push(`${where}: $GITHUB_ENV must not set ${name}: drone-ssh would read it instead of the reviewed input`);
    }
  }
  return out;
}

/** V2-A.3 A3.6: every production SSH step pins the host key, behind a fail-closed guard; no fingerprint override in any env. */
function hostKeyPinProblems(where, doc, job, steps) {
  const out = [];
  const isGuard = (s) => String(s?.env?.[HOST_KEY_SECRET] ?? '').trim().match(HOST_KEY_EXPRESSION) !== null && s.if === undefined
    && s['continue-on-error'] === undefined && s.shell === undefined && s.uses === undefined
    && String(s.run ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n') === HOST_KEY_GUARD_RUN.join('\n');
  steps.forEach((step, i) => {
    if (!String(step.uses ?? '').startsWith('appleboy/ssh-action')) return;
    const fingerprint = step.with?.fingerprint;
    if (fingerprint === undefined) {
      out.push(`${where}: the SSH step must pin the production host key (fingerprint: \${{ secrets.${HOST_KEY_SECRET} }}); without it any host key is accepted`);
    } else if (!HOST_KEY_EXPRESSION.test(String(fingerprint).trim())) {
      out.push(`${where}: the SSH step's fingerprint must be exactly \${{ secrets.${HOST_KEY_SECRET} }} (no literal, other secret or variable)`);
    }
    const proxy = Object.keys(step.with ?? {}).filter((k) => k.startsWith('proxy_'));
    if (proxy.length > 0) out.push(`${where}: the SSH step must not use a proxy (found: ${proxy.join(', ')})`);
    if (!steps.slice(0, i).some(isGuard)) {
      out.push(`${where}: the SSH step must be preceded by the host-key guard step (env ${HOST_KEY_SECRET} from the secret, the exact check, exit 1; no if, continue-on-error or shell override)`);
    }
  });
  const envs = [['workflow', doc?.env], ['job', job.env], ...steps.map((s, i) => [`step ${i + 1}`, isGuard(s) ? {} : s.env])];
  for (const [level, env] of envs) {
    const keys = Object.keys(env && typeof env === 'object' ? env : {}).filter((k) => FINGERPRINT_VARIABLE.test(k));
    if (keys.length > 0) out.push(`${where}: no fingerprint variable may be set at ${level} level (found: ${keys.join(', ')}); drone-ssh would read it instead of the pinned input`);
  }
  return out;
}

function concurrencyProblems(where, cfg) {
  const out = [];
  if (!cfg || typeof cfg !== 'object' || typeof cfg.group !== 'string') return [`${where}: has no concurrency group`];
  if (cfg.group !== PRODUCTION_GROUP) out.push(`${where}: concurrency group must be "${PRODUCTION_GROUP}" (got "${cfg.group}")`);
  if (cfg['cancel-in-progress'] !== false) out.push(`${where}: cancel-in-progress must be explicitly false (a running production deployment is never cancelled)`);
  return out;
}

/** Core V2 M2 B1: the scheduled-backup workflow as a whole: schedule-only at the approved time, no permissions, one job. */
function scheduledBackupWorkflowProblems(fileName, doc, triggers) {
  const out = [];
  if (triggers.length !== 1 || triggers[0] !== 'schedule') {
    out.push(`${fileName}: the scheduled backup runs on its schedule only (found: ${triggers.join(', ') || 'nothing'}); manual backups stay in core-backup.yml behind the production approval`);
  }
  const on = doc?.on ?? doc?.true;
  const crons = asArray(on?.schedule).map((s) => s?.cron);
  if (crons.length !== 1 || crons[0] !== SCHEDULED_BACKUP_CRON) out.push(`${fileName}: the schedule must be exactly one cron '${SCHEDULED_BACKUP_CRON}' (found: ${crons.join(', ') || 'none'})`);
  const perms = doc?.permissions;
  if (!perms || typeof perms !== 'object' || Object.keys(perms).length !== 0) out.push(`${fileName}: the workflow must declare "permissions: {}" (no token permission at all)`);
  for (const key of ['env', 'defaults', 'concurrency']) if (doc?.[key] !== undefined) out.push(`${fileName}: no workflow-level "${key}"`);
  const jobIds = Object.keys(doc?.jobs ?? {});
  if (jobIds.length !== 1 || jobIds[0] !== 'backup') out.push(`${fileName}: exactly one job, "backup" (found: ${jobIds.join(', ') || 'none'})`);
  const job = doc?.jobs?.backup;
  if (job && job.environment !== BACKUP_ENVIRONMENT) out.push(`${fileName} job "backup": must declare "environment: ${BACKUP_ENVIRONMENT}" as a literal name`);
  return out;
}

/** Core V2 M2 B1: the scheduled-backup job: the guard, the queue, one native ssh session with a pinned host key and no remote command. */
function scheduledBackupJobProblems(where, jobId, job) {
  const out = [];
  if (jobId !== 'backup') out.push(`${where}: the scheduled backup job must be "backup"`);
  if (String(job.if ?? '').replace(/\s+/g, ' ').trim() !== SCHEDULED_BACKUP_GUARD) {
    out.push(`${where}: the job must be guarded by exactly "if: ${SCHEDULED_BACKUP_GUARD}" (main only; inactive until the owner enables it)`);
  }
  // The production queue is checked with every native ssh job (checkWorkflowSafety); the job's own concurrency is required there.
  if (job.concurrency === undefined) out.push(`${where}: the job must declare its own concurrency (the production queue)`);
  if (job['runs-on'] !== 'ubuntu-latest') out.push(`${where}: runs-on must be ubuntu-latest (a GitHub-hosted, ephemeral runner)`);
  const timeout = job['timeout-minutes'];
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60) out.push(`${where}: timeout-minutes must be an integer from 1 to 60`);
  for (const key of ['uses', 'with', 'secrets', 'container', 'services', 'permissions', 'strategy', 'needs', 'outputs', 'defaults', 'env', 'continue-on-error']) {
    if (job[key] !== undefined) out.push(`${where}: "${key}" is not allowed on the scheduled backup job`);
  }
  const steps = asArray(job.steps);
  if (steps.length !== 1) return [...out, `${where}: exactly one step (found ${steps.length}); no checkout, no action`];
  const step = steps[0];
  const extra = Object.keys(step).filter((k) => !['name', 'env', 'run'].includes(k));
  if (extra.length > 0) out.push(`${where}: the step may only have name, env and run (found: ${extra.join(', ')}); no action, no shell override`);
  const env = step.env ?? {};
  const keys = Object.keys(env).sort();
  if (keys.join() !== [...SCHEDULED_BACKUP_SECRETS].sort().join()) out.push(`${where}: the step env must be exactly ${SCHEDULED_BACKUP_SECRETS.join(', ')}`);
  for (const k of keys) {
    if (SCHEDULED_BACKUP_SECRETS.includes(k) && String(env[k]).replace(/\s+/g, '') !== `\${{secrets.${k}}}`) out.push(`${where}: env ${k} must be exactly \${{ secrets.${k} }}`);
  }
  if (PRODUCTION_CREDENTIAL.test(JSON.stringify(job))) out.push(`${where}: the scheduled backup never uses the DEPLOY_SSH_* credentials or every secret at once`);
  const run = String(step.run ?? '');
  if (run.includes('${{')) out.push(`${where}: no expression is interpolated into the script (pass values through env)`);
  if (firstCommandLine(run) !== 'set -euo pipefail') out.push(`${where}: the script must start with "set -euo pipefail"`);
  for (const [re, why] of SCHEDULED_BACKUP_FORBIDDEN) if (re.test(run)) out.push(`${where}: the script ${why}`);
  const joined = run.replace(/\\\n\s*/g, ' ');
  const invocations = joined.split('\n').map((l) => l.trim()).filter((l) => /^ssh(\s|$)/.test(l));
  const shells = (joined.match(new RegExp(NATIVE_REMOTE_SHELL.source, 'gm')) ?? []).length;
  if (invocations.length !== 1 || shells !== 1) {
    out.push(`${where}: exactly one ssh invocation, as a command of its own (found ${invocations.length} ssh line(s), ${shells} remote-shell command(s))`);
  } else {
    const inv = invocations[0];
    for (const opt of SCHEDULED_BACKUP_SSH_OPTIONS) {
      const present = opt.startsWith('-') ? new RegExp(`(^|\\s)${opt.replace(/[/]/g, '\\/')}(\\s|$)`).test(inv) : inv.includes(`-o ${opt}`);
      if (!present) out.push(`${where}: the ssh invocation must pass ${opt.startsWith('-') ? opt : `-o ${opt}`}`);
    }
    if (!inv.endsWith(SCHEDULED_BACKUP_TARGET)) out.push(`${where}: the ssh invocation must end with ${SCHEDULED_BACKUP_TARGET}: no remote command, no input redirection (the server's forced command decides what runs)`);
  }
  return out;
}

/** Core V2 M2 T6: the token permissions a job effectively has (its own block, or the workflow's when it declares none). */
function effectivePermissions(doc, job) {
  const perms = job?.permissions !== undefined ? job.permissions : doc?.permissions;
  if (perms === 'write-all') return { 'id-token': 'write', contents: 'write', attestations: 'write', packages: 'write' };
  return perms && typeof perms === 'object' ? perms : {};
}

/** Core V2 M2 T6: the probe workflow as a whole: dispatch-only without inputs, no token permission at workflow level, one job. */
function probeWorkflowProblems(fileName, doc, triggers) {
  const out = [];
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    out.push(`${fileName}: the network probe runs on workflow_dispatch only (found: ${triggers.join(', ') || 'nothing'}); never automatically, on a schedule or as a reusable workflow`);
  }
  const dispatch = (doc?.on ?? doc?.true)?.workflow_dispatch;
  if (dispatch !== null && dispatch !== undefined && (typeof dispatch !== 'object' || Object.keys(dispatch).length > 0)) {
    out.push(`${fileName}: the network probe takes no input (found: workflow_dispatch ${JSON.stringify(dispatch)})`);
  }
  const perms = doc?.permissions;
  if (!perms || typeof perms !== 'object' || Object.keys(perms).length !== 0) out.push(`${fileName}: the workflow must declare "permissions: {}" (the job alone holds id-token: write)`);
  const extra = Object.keys(doc ?? {}).filter((k) => !['name', 'on', 'true', 'permissions', 'jobs'].includes(k));
  if (extra.length > 0) out.push(`${fileName}: no workflow-level ${extra.map((k) => `"${k}"`).join(', ')}`);
  const jobIds = Object.keys(doc?.jobs ?? {});
  if (jobIds.length !== 1 || jobIds[0] !== PROBE_JOB) out.push(`${fileName}: exactly one job, "${PROBE_JOB}" (found: ${jobIds.join(', ') || 'none'})`);
  return out;
}

/** Core V2 M2 T6: the probe job: main only, the production approval and queue, id-token only, validate → Tailscale → probe, nothing else. */
function probeJobProblems(where, job) {
  const out = [];
  const allowedKeys = ['name', 'if', 'environment', 'concurrency', 'runs-on', 'timeout-minutes', 'permissions', 'steps'];
  const extra = Object.keys(job).filter((k) => !allowedKeys.includes(k));
  if (extra.length > 0) out.push(`${where}: ${extra.map((k) => `"${k}"`).join(', ')} not allowed on the probe job (no reusable workflow, container, service, env, matrix or continue-on-error)`);
  if (String(job.if ?? '').replace(/\s+/g, ' ').trim() !== PROBE_GUARD) out.push(`${where}: the job must be guarded by exactly "if: ${PROBE_GUARD}" (main only)`);
  if (job.environment !== 'production') out.push(`${where}: must declare "environment: production" as a literal name (the required reviewer approves every run)`);
  if (job.concurrency === undefined) out.push(`${where}: the job must declare its own concurrency (the production queue)`);
  if (job['runs-on'] !== PROBE_RUNNER) out.push(`${where}: runs-on must be exactly ${PROBE_RUNNER} (a GitHub-hosted, ephemeral runner)`);
  if (job['timeout-minutes'] !== PROBE_TIMEOUT_MINUTES) out.push(`${where}: timeout-minutes must be exactly ${PROBE_TIMEOUT_MINUTES}`);
  const perms = job.permissions;
  if (!perms || typeof perms !== 'object' || Object.keys(perms).length !== 1 || perms['id-token'] !== 'write') {
    out.push(`${where}: the job permissions must be exactly "id-token: write" (found: ${JSON.stringify(perms ?? null)}); no contents, no checkout`);
  }

  const steps = asArray(job.steps);
  for (const step of steps) {
    for (const m of JSON.stringify(step).matchAll(SECRET_REFERENCE)) {
      const name = m[1] ?? m[2];
      if (!PROBE_SECRETS.includes(name)) out.push(`${where}: the probe may read only ${PROBE_SECRETS.join(', ')} (found secrets.${name})`);
    }
  }
  if (/toJSON\(\s*secrets\s*\)/.test(JSON.stringify(job))) out.push(`${where}: the probe never reads every secret at once`);
  if (steps.length !== 3) return [...out, `${where}: exactly three steps, validate → Tailscale → probe (found ${steps.length}); no checkout, no other action`];
  const [validate, tailscale, probe] = steps;

  const scriptStep = (label, step) => {
    const keys = Object.keys(step).filter((k) => !['name', 'env', 'run'].includes(k));
    if (keys.length > 0) out.push(`${where}: the ${label} step may only have name, env and run (found: ${keys.join(', ')}); no action, condition, shell override or continue-on-error`);
    const env = step.env ?? {};
    const names = Object.keys(env).sort();
    if (names.join() !== Object.keys(PROBE_ENV).sort().join()) out.push(`${where}: the ${label} step env must be exactly ${Object.keys(PROBE_ENV).join(', ')}`);
    for (const k of names) {
      if (PROBE_ENV[k] !== undefined && String(env[k]).replace(/\s+/g, '') !== PROBE_ENV[k].replace(/\s+/g, '')) out.push(`${where}: the ${label} step env ${k} must be exactly ${PROBE_ENV[k]}`);
    }
    const run = String(step.run ?? '');
    if (run.includes('${{')) out.push(`${where}: no expression is interpolated into the ${label} script (pass values through env)`);
    if (firstCommandLine(run) !== 'set -euo pipefail') out.push(`${where}: the ${label} script must start with "set -euo pipefail"`);
    for (const [re, why] of PROBE_FORBIDDEN) if (re.test(run)) out.push(`${where}: the ${label} script ${why}`);
    // Only fixed words are printed: no echo or printf line expands a variable or a command (the values would reach the log).
    for (const line of run.split('\n')) {
      const printed = line.match(/(?:^|[;&|{]\s*)(echo|printf)\s+(.*)$/)?.[2];
      if (printed !== undefined && /\$/.test(printed)) out.push(`${where}: the ${label} script prints a variable or command output ("${line.trim()}"); only PASS/FAIL words are printed`);
    }
    return run;
  };

  const validateRun = scriptStep('validate', validate);
  if (validate.uses !== undefined || NATIVE_REMOTE_SHELL.test(validateRun)) out.push(`${where}: the validate step must contact nothing (it runs before the tailnet join)`);
  for (const [needle, why] of [['ipaddress.IPv4Network("100.64.0.0/10")', 'the destination is checked to be inside 100.64.0.0/10'],
    ['ipaddress.IPv4Address(os.environ.get("TS_PROBE_HOST", ""))', 'TS_PROBE_HOST is parsed as an IPv4 address'],
    ['[[ $DEPLOY_SSH_PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( DEPLOY_SSH_PORT <= 65535 ))', 'DEPLOY_SSH_PORT is checked to be a TCP port'],
    ['[[ $DEPLOY_SSH_FINGERPRINT =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]', 'DEPLOY_SSH_FINGERPRINT is checked to be a SHA256 fingerprint']]) {
    if (!validateRun.includes(needle)) out.push(`${where}: the validate step must fail closed unless ${why}`);
  }
  if ((validateRun.match(/exit 1/g) ?? []).length < 3) out.push(`${where}: the validate step must exit 1 on each failed check`);

  const tsKeys = Object.keys(tailscale).filter((k) => !['name', 'uses', 'with'].includes(k));
  if (tsKeys.length > 0) out.push(`${where}: the Tailscale step may only have name, uses and with (found: ${tsKeys.join(', ')})`);
  if (tailscale.uses !== TAILSCALE_ACTION) out.push(`${where}: the second step must be exactly ${TAILSCALE_ACTION} # ${TAILSCALE_ACTION_RELEASE} (got "${tailscale.uses ?? 'no action'}")`);
  const withKeys = Object.keys(tailscale.with ?? {});
  const unexpected = withKeys.filter((k) => !(k in PROBE_TAILSCALE_WITH));
  if (unexpected.length > 0) out.push(`${where}: the Tailscale step accepts only ${Object.keys(PROBE_TAILSCALE_WITH).join(', ')} (found: ${unexpected.join(', ')}); no auth key, OAuth secret, args, routes, exit node or Tailscale SSH`);
  for (const [k, v] of Object.entries(PROBE_TAILSCALE_WITH)) {
    if (String(tailscale.with?.[k] ?? '').replace(/\s+/g, '') !== v.replace(/\s+/g, '')) out.push(`${where}: the Tailscale input ${k} must be exactly ${v}`);
  }

  const probeRun = scriptStep('probe', probe);
  const remote = probeRun.match(new RegExp(NATIVE_REMOTE_SHELL.source, 'gm')) ?? [];
  if (remote.length !== 1 || !/(^|[^\w.-])ssh-keyscan -T 10 -t ecdsa -p "\$DEPLOY_SSH_PORT" "\$TS_PROBE_HOST" 2>\/dev\/null/m.test(probeRun)) {
    out.push(`${where}: the probe script runs exactly one remote tool, ssh-keyscan -T 10 -t ecdsa -p "$DEPLOY_SSH_PORT" "$TS_PROBE_HOST" 2>/dev/null (found ${remote.length} remote-shell command(s))`);
  }
  if (/ssh-keygen(?![^\n]*\s-l\s)/.test(probeRun)) out.push(`${where}: ssh-keygen may only print a fingerprint (-l)`);
  if (!probeRun.includes('timeout 10 bash -c \'exec 3<>"/dev/tcp/$0/$1"\' "$TS_PROBE_HOST" "$DEPLOY_SSH_PORT"')) out.push(`${where}: the probe script must test the TCP connection to "$TS_PROBE_HOST" "$DEPLOY_SSH_PORT" with a timeout`);
  if (!probeRun.includes('[ -n "$fp" ] && [ "$fp" = "$DEPLOY_SSH_FINGERPRINT" ]')) out.push(`${where}: the probe script must compare the scanned fingerprint with "$DEPLOY_SSH_FINGERPRINT" (non-empty, exact)`);
  if (!probeRun.includes('[ "$(grep -c . <<<"$keys" || true)" = 1 ] && [ "$(awk \'{print $2}\' <<<"$keys")" = ecdsa-sha2-nistp256 ]')) out.push(`${where}: the probe script must require exactly one ecdsa-sha2-nistp256 host key`);
  return out;
}

/** Core V2 M2 T7: core-backup.yml as a whole: unchanged trigger and input, contents: read only at workflow level, one job. */
function backupWorkflowProblems(fileName, doc) {
  const out = [];
  const inputs = (doc?.on ?? doc?.true)?.workflow_dispatch?.inputs ?? {};
  if (Object.keys(inputs).join() !== 'services' || inputs.services?.required !== true || inputs.services?.default !== 'auth-service') {
    out.push(`${fileName}: the manual backup keeps exactly one input, "services" (required, default auth-service)`);
  }
  const perms = doc?.permissions;
  if (!perms || typeof perms !== 'object' || Object.keys(perms).join() !== 'contents' || perms.contents !== 'read') {
    out.push(`${fileName}: the workflow permissions must be exactly "contents: read" (id-token: write belongs to the backup job alone)`);
  }
  const extra = Object.keys(doc ?? {}).filter((k) => !['name', 'on', 'true', 'permissions', 'jobs'].includes(k));
  if (extra.length > 0) out.push(`${fileName}: no workflow-level ${extra.map((k) => `"${k}"`).join(', ')} (no env, defaults or concurrency outside the job)`);
  const jobIds = Object.keys(doc?.jobs ?? {});
  if (jobIds.length !== 1 || jobIds[0] !== BACKUP_JOB) out.push(`${fileName}: exactly one job, "${BACKUP_JOB}" (found: ${jobIds.join(', ') || 'none'})`);
  return out;
}

const sameExpression = (a, b) => String(a ?? '').replace(/\s+/g, '') === String(b ?? '').replace(/\s+/g, '');

/**
 * Core V2 M2 T7: the manual backup job, pinned whole: main only behind the production approval and queue; contents: read and id-token:
 * write; checkout (no ref) → package → host-key guard → destination check → Tailscale → SSH, none skippable; the SSH step connects to the
 * validated TS_BACKUP_HOST and DEPLOY_SSH_PORT with the unchanged login, pin, variables and remote script; DEPLOY_SSH_HOST never.
 */
function backupJobProblems(where, job) {
  const out = [];
  const allowedKeys = ['name', 'if', 'environment', 'concurrency', 'runs-on', 'permissions', 'steps'];
  const extra = Object.keys(job).filter((k) => !allowedKeys.includes(k));
  if (extra.length > 0) out.push(`${where}: ${extra.map((k) => `"${k}"`).join(', ')} not allowed on the backup job (no env, defaults, container, reusable workflow, matrix or continue-on-error)`);
  if (String(job.if ?? '').replace(/\s+/g, ' ').trim() !== "github.ref == 'refs/heads/main'") out.push(`${where}: the job must be guarded by exactly "if: github.ref == 'refs/heads/main'" (main only)`);
  if (job.environment !== 'production') out.push(`${where}: must declare "environment: production" as a literal name (the required reviewer approves every run)`);
  if (job['runs-on'] !== 'ubuntu-latest') out.push(`${where}: runs-on must stay ubuntu-latest (a GitHub-hosted, ephemeral runner)`);
  const perms = job.permissions;
  if (!perms || typeof perms !== 'object' || Object.keys(perms).sort().join() !== Object.keys(BACKUP_PERMISSIONS).sort().join()
    || Object.entries(BACKUP_PERMISSIONS).some(([k, v]) => perms[k] !== v)) {
    out.push(`${where}: the job permissions must be exactly "contents: read" and "id-token: write" (found: ${JSON.stringify(perms ?? null)})`);
  }
  const text = JSON.stringify(job);
  for (const m of text.matchAll(SECRET_REFERENCE)) {
    const name = m[1] ?? m[2];
    if (!BACKUP_JOB_SECRETS.includes(name)) out.push(`${where}: the backup job may read only ${BACKUP_JOB_SECRETS.join(', ')} (found secrets.${name})`);
  }
  if (/DEPLOY_SSH_HOST/.test(text)) out.push(`${where}: the backup job never reads DEPLOY_SSH_HOST (the shared LAN destination); it connects to TS_BACKUP_HOST only`);
  if (/toJSON\(\s*secrets\s*\)/.test(text)) out.push(`${where}: the backup job never reads every secret at once`);

  const steps = asArray(job.steps);
  const order = 'checkout → package → host-key guard → destination check → Tailscale → SSH';
  if (steps.length !== 6) return [...out, `${where}: exactly six steps, ${order} (found ${steps.length})`];
  const [checkout, pack, guard, destination, tailscale, ssh] = steps;
  const onlyKeys = (label, step, keys) => {
    const bad = Object.keys(step).filter((k) => !keys.includes(k));
    if (bad.length > 0) out.push(`${where}: the ${label} step may only have ${keys.join(', ')} (found: ${bad.join(', ')}); no condition, continue-on-error, shell override or working directory`);
  };

  onlyKeys('checkout', checkout, ['name', 'uses']);
  if (!/^actions\/checkout@[0-9a-f]{40}$/.test(String(checkout.uses ?? ''))) out.push(`${where}: step 1 must be the pinned actions/checkout, with no inputs (no other ref, repository or path) (${order})`);
  onlyKeys('package', pack, ['name', 'run']);
  if (String(pack.run ?? '').trim() !== BACKUP_PACKAGE_RUN) out.push(`${where}: step 2 must be exactly: ${BACKUP_PACKAGE_RUN} (${order})`);
  onlyKeys('host-key guard', guard, ['name', 'env', 'run']);
  const guardRun = String(guard.run ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
  if (Object.keys(guard.env ?? {}).join() !== HOST_KEY_SECRET || !HOST_KEY_EXPRESSION.test(String(guard.env?.[HOST_KEY_SECRET] ?? '').trim()) || guardRun !== HOST_KEY_GUARD_RUN.join('\n')) {
    out.push(`${where}: step 3 must be the host-key guard (${order})`);
  }

  onlyKeys('destination check', destination, ['name', 'env', 'run']);
  const env = destination.env ?? {};
  if (Object.keys(env).sort().join() !== Object.keys(BACKUP_DESTINATION_ENV).sort().join()
    || Object.entries(BACKUP_DESTINATION_ENV).some(([k, v]) => !sameExpression(env[k], v))) {
    out.push(`${where}: step 4, the destination check, must read exactly ${Object.entries(BACKUP_DESTINATION_ENV).map(([k, v]) => `${k}: ${v}`).join(', ')} (${order})`);
  }
  const run = String(destination.run ?? '');
  if (destination.uses !== undefined || NATIVE_REMOTE_SHELL.test(run)) out.push(`${where}: the destination check must contact nothing (it runs before the tailnet join)`);
  if (run.includes('${{')) out.push(`${where}: no expression is interpolated into the destination check (pass values through env)`);
  if (firstCommandLine(run) !== 'set -euo pipefail') out.push(`${where}: the destination check must start with "set -euo pipefail"`);
  for (const [re, why] of TAILNET_SCRIPT_FORBIDDEN) if (re.test(run)) out.push(`${where}: the destination check ${why}`);
  for (const line of run.split('\n')) {
    const printed = line.match(/(?:^|[;&|{]\s*)(echo|printf)\s+(.*)$/)?.[2];
    if (printed !== undefined && /\$/.test(printed)) out.push(`${where}: the destination check prints a variable or command output ("${line.trim()}"); only PASS/FAIL words are printed`);
  }
  for (const [needle, why] of [['ipaddress.IPv4Network("100.64.0.0/10")', 'the destination is checked to be inside 100.64.0.0/10'],
    ['ipaddress.IPv4Address(os.environ.get("TS_BACKUP_HOST", ""))', 'TS_BACKUP_HOST is parsed as exactly one IPv4 address'],
    ['[[ $DEPLOY_SSH_PORT =~ ^[1-9][0-9]{0,4}$ ]] && (( DEPLOY_SSH_PORT <= 65535 ))', 'DEPLOY_SSH_PORT is checked to be one TCP port']]) {
    if (!run.includes(needle)) out.push(`${where}: the destination check must fail closed unless ${why}`);
  }
  if ((run.match(/exit 1/g) ?? []).length < 2) out.push(`${where}: the destination check must exit 1 on each failed check`);

  onlyKeys('Tailscale', tailscale, ['name', 'uses', 'with']);
  if (tailscale.uses !== TAILSCALE_ACTION) out.push(`${where}: step 5 must be exactly ${TAILSCALE_ACTION} # ${TAILSCALE_ACTION_RELEASE} (got "${tailscale.uses ?? 'no action'}") (${order})`);
  const tsUnexpected = Object.keys(tailscale.with ?? {}).filter((k) => !(k in BACKUP_TAILSCALE_WITH));
  if (tsUnexpected.length > 0) out.push(`${where}: the Tailscale step accepts only ${Object.keys(BACKUP_TAILSCALE_WITH).join(', ')} (found: ${tsUnexpected.join(', ')}); no auth key, OAuth secret, args, routes, exit node or Tailscale SSH`);
  for (const [k, v] of Object.entries(BACKUP_TAILSCALE_WITH)) {
    if (!sameExpression(tailscale.with?.[k], v)) out.push(`${where}: the Tailscale input ${k} must be exactly ${v}`);
  }

  onlyKeys('SSH', ssh, ['name', 'uses', 'with', 'env']);
  if (ssh.uses !== BACKUP_SSH_ACTION) out.push(`${where}: step 6 must be exactly ${BACKUP_SSH_ACTION} # v1.2.5 (got "${ssh.uses ?? 'no action'}") (${order})`);
  for (const [k, v] of Object.entries(BACKUP_SSH_WITH)) {
    if (!sameExpression(ssh.with?.[k], v)) out.push(`${where}: the SSH input ${k} must be exactly ${v}${k === 'host' || k === 'port' ? ' (the value the destination check validated; no fallback)' : ' (unchanged)'}`);
  }
  const script = String(ssh.with?.script ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
  if (script !== BACKUP_REMOTE_SCRIPT.join('\n')) out.push(`${where}: the remote script must stay exactly: ${BACKUP_REMOTE_SCRIPT.join(' / ')}`);
  if (Object.keys(ssh.env ?? {}).join() !== 'BACKUP_SERVICES' || !sameExpression(ssh.env?.BACKUP_SERVICES, '${{ inputs.services }}')) {
    out.push(`${where}: the SSH step env must stay exactly BACKUP_SERVICES: \${{ inputs.services }}`);
  }
  return out;
}

/**
 * Core V2 M2 B1: the installed side of the scheduled backup. The entry script's pins equal the repository (the SHA-256 of backup.sh, the
 * install directory, the services), it never runs a client command, and the authorized_keys template holds exactly the restricted line
 * with a placeholder instead of a key.
 */
export function checkScheduledBackupEntry({ entry, backupSh, template }) {
  const out = [];
  const where = 'infra/backup/scheduled-backup.sh';
  if (!entry) return [`${where} is missing (the forced-command entry of ${SCHEDULED_BACKUP_WORKFLOW})`];
  const pin = entry.match(/^readonly BACKUP_SH_SHA256='([0-9a-f]{64})'$/m)?.[1];
  const actual = createHash('sha256').update(backupSh ?? '').digest('hex');
  if (pin !== actual) out.push(`${where}: BACKUP_SH_SHA256 (${pin ?? 'missing'}) must equal the SHA-256 of infra/backup/backup.sh (${actual}); after a reviewed backup.sh change, update the pin and reinstall (runbook §2)`);
  if (!entry.includes(`readonly INSTALL_DIR='${SCHEDULED_BACKUP_INSTALL_DIR}'`)) out.push(`${where}: INSTALL_DIR must be '${SCHEDULED_BACKUP_INSTALL_DIR}'`);
  if (!/^readonly OWNER_UID=0$/m.test(entry)) out.push(`${where}: OWNER_UID must be 0 (root-owned installation)`);
  if (!entry.includes(`readonly SERVICES='${SCHEDULED_BACKUP_SERVICES}'`)) out.push(`${where}: SERVICES must be exactly '${SCHEDULED_BACKUP_SERVICES}'`);
  const original = entry.match(/SSH_ORIGINAL_COMMAND/g) ?? [];
  if (original.length !== 1 || !entry.includes('[ -z "${SSH_ORIGINAL_COMMAND:-}" ] && [ "$#" -eq 0 ] || refuse 64')) {
    out.push(`${where}: SSH_ORIGINAL_COMMAND is only ever tested for emptiness, then refused (exit 64); it is never run or printed`);
  }
  if (!entry.includes('[ "$EUID" -ne 0 ] || refuse 65 ')) out.push(`${where}: the entry must refuse to run as root (exit 65; M2 E2: the key belongs to the runtime user only)`);
  if (!/^\s*flock -n 9 \|\| refuse 75 /m.test(entry)) out.push(`${where}: the run must take the lock with "flock -n" and refuse with exit 75`);
  if (!/^env -i HOME="\$HOME" PATH="\$PATH" BACKUP_SERVICES="\$SERVICES" bash --noprofile --norc -- "\$INSTALL_DIR\/backup\.sh" \|\| rc=\$\?$/m.test(entry)) {
    out.push(`${where}: backup.sh must be run with "env -i" and only HOME, PATH and BACKUP_SERVICES`);
  }
  if (/(^|[;&|\s])(eval|source|\.)\s/m.test(entry.replace(/^\s*#.*$/gm, ''))) out.push(`${where}: no eval and no sourcing`);
  if (entry.includes('PRIVATE KEY')) out.push(`${where}: must not contain a private-key marker`);
  const lines = String(template ?? '').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const line = `restrict,command="${SCHEDULED_BACKUP_INSTALL_DIR}/scheduled-backup.sh" ssh-ed25519 REPLACE_WITH_THE_SCHEDULED_BACKUP_PUBLIC_KEY nawara-core-scheduled-backup`;
  if (lines.length !== 1 || lines[0] !== line) out.push(`infra/backup/scheduled-backup.authorized_keys.template: must hold exactly one line, ${line}`);
  if (/AAAA[0-9A-Za-z+/]{20,}|PRIVATE KEY/.test(String(template ?? ''))) out.push('infra/backup/scheduled-backup.authorized_keys.template: must hold no key material');
  return out;
}

/** Core V2 M2 E2: the pins of the read-only installation verifier, and what makes it read-only. */
const SCHEDULED_BACKUP_VERIFIER_PINS = [
  `readonly INSTALL_DIR='${SCHEDULED_BACKUP_INSTALL_DIR}'`, 'readonly OWNER_UID=0', 'readonly OWNER_GID=0', 'readonly RUN_AS_UID=0', "readonly TRUST_ROOT='/'",
  "readonly KEY_COMMENT='nawara-core-scheduled-backup'", `readonly FORCED_OPTIONS='restrict,command="${SCHEDULED_BACKUP_INSTALL_DIR}/scheduled-backup.sh"'`,
];
const SCHEDULED_BACKUP_VERIFIER_FORBIDDEN = /(^|[;&|(\s])(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chgrp|install|tee|truncate|dd|sed\s+-i|docker|systemctl|service|curl|wget|nc|ssh-keyscan|scp|sftp|rsync|eval|source|sudo|su|crontab|gh)(?=\s|$)/m;

/**
 * Core V2 M2 E2: infra/backup/verify-scheduled-backup-install.sh, the console verification of the installation, must check exactly
 * what the entry script and the authorized_keys template pin, and must stay read-only (no write, move, delete, mode change, container,
 * network or privilege command; no redirection into a file).
 */
export function checkScheduledBackupVerifier({ verifier, entry, template }) {
  const where = 'infra/backup/verify-scheduled-backup-install.sh';
  if (!verifier) return [`${where} is missing (the read-only verification of the E2 installation)`];
  const out = [];
  for (const pin of SCHEDULED_BACKUP_VERIFIER_PINS) if (!verifier.includes(`\n${pin}\n`)) out.push(`${where}: must pin ${pin}`);
  const options = String(template ?? '').split('\n').find((l) => l.startsWith('restrict,'))?.split(' ')[0];
  if (!options || !verifier.includes(`readonly FORCED_OPTIONS='${options}'`)) out.push(`${where}: FORCED_OPTIONS must equal the template's options (${options ?? 'none'})`);
  if (entry && !entry.includes(`readonly INSTALL_DIR='${SCHEDULED_BACKUP_INSTALL_DIR}'`)) out.push(`${where}: the entry script's INSTALL_DIR differs from the verifier's`);
  const code = verifier.replace(/(^|\s)#(\s.*)?$/gm, '');
  const forbidden = SCHEDULED_BACKUP_VERIFIER_FORBIDDEN.exec(code);
  if (forbidden) out.push(`${where}: must stay read-only (found "${forbidden[2]}")`);
  const unquoted = code.replace(/[0-9]?>\s*\/dev\/null|[0-9]?>&[0-9]/g, '').replace(/'[^'\n]*'|"[^"\n]*"/g, 'S');
  if (/>{1,2}[ \t]*[^ \t\n&(]/.test(unquoted)) out.push(`${where}: must write no file (output only to the console, /dev/null or stderr)`);
  if (!/^\[ "\$EUID" -eq "\$RUN_AS_UID" \] \|\| usage /m.test(verifier)) out.push(`${where}: must refuse to run as anyone but root`);
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
    // Core V2 M2 B1: a native ssh / scp / sftp in a step, or the scheduled-backup credentials, are production access too.
    const nativeShell = steps.some((s) => NATIVE_REMOTE_SHELL.test(String(s.run ?? '')));
    const backupCredential = BACKUP_CREDENTIAL.test(JSON.stringify(job));
    const usesProduction = usesSsh(steps) || PRODUCTION_CREDENTIAL.test(JSON.stringify(job)) || nativeShell || backupCredential;
    if (usesProduction) {
      if (environment === undefined) {
        problems.push(`${where}: a job using production SSH or the DEPLOY_SSH_* credentials must declare a protected environment (${PRODUCTION_ENVIRONMENTS.join(', ')}); the scheduled backup alone uses "${BACKUP_ENVIRONMENT}" in ${SCHEDULED_BACKUP_WORKFLOW}`);
      } else if (environment.includes('${{')) {
        problems.push(`${where}: the environment must be a literal name, never an expression (got "${environment}")`);
      } else if (environment === BACKUP_ENVIRONMENT) {
        // Checked below: reserved for the scheduled backup job.
      } else if (!PRODUCTION_ENVIRONMENTS.includes(environment)) {
        problems.push(`${where}: environment "${environment}" is not an approved production environment (${PRODUCTION_ENVIRONMENTS.join(', ')})`);
      }
    }
    if (backupCredential && environment !== BACKUP_ENVIRONMENT) {
      problems.push(`${where}: the BACKUP_SSH_* credentials are used only by the scheduled backup job of ${SCHEDULED_BACKUP_WORKFLOW}, in the "${BACKUP_ENVIRONMENT}" environment`);
    }
    if (environment === BACKUP_ENVIRONMENT) {
      if (fileName !== SCHEDULED_BACKUP_WORKFLOW) {
        problems.push(`${where}: environment "${BACKUP_ENVIRONMENT}" is not an approved production environment for ${fileName}: it is reserved for the scheduled backup job of ${SCHEDULED_BACKUP_WORKFLOW}`);
      } else {
        problems.push(...scheduledBackupJobProblems(where, jobId, job));
      }
    }
    // Core V2 M2 T6/T7: the tailnet identity belongs to the two tailnet jobs alone (the network probe, the manual backup): id-token in
    // production, the Tailscale action and the TS_* secrets, each job only its own TS_* prefix.
    const isProbeJob = fileName === PROBE_WORKFLOW && jobId === PROBE_JOB;
    const isBackupJob = fileName === BACKUP_WORKFLOW && jobId === BACKUP_JOB;
    const tailnetJob = TAILNET_JOBS.find((t) => t.file === fileName && t.job === jobId);
    if (effectivePermissions(doc, job)['id-token'] === 'write' && !tailnetJob && !(jobId === 'build-image' && environment === undefined)) {
      problems.push(`${where}: id-token: write is allowed only on the network probe job ("${PROBE_JOB}" of ${PROBE_WORKFLOW}), the manual backup job ("${BACKUP_JOB}" of ${BACKUP_WORKFLOW}) and an image workflow's build-image job (its attestation)`);
    }
    if (steps.some((s) => /^tailscale\//i.test(String(s.uses ?? ''))) && !tailnetJob) {
      problems.push(`${where}: the Tailscale action is used only by the network probe job ("${PROBE_JOB}" of ${PROBE_WORKFLOW}) and the manual backup job ("${BACKUP_JOB}" of ${BACKUP_WORKFLOW})`);
    }
    for (const m of JSON.stringify(job).matchAll(SECRET_REFERENCE)) {
      const name = m[1] ?? m[2];
      if (!name.startsWith('TS_') || (tailnetJob && name.startsWith(tailnetJob.prefix))) continue;
      problems.push(`${where}: the TS_* secrets are read only by the tailnet jobs, each its own prefix: ${TAILNET_JOB_LIST} (found secrets.${name})`);
    }
    if (isProbeJob) problems.push(...probeJobProblems(where, job));
    if (isBackupJob) problems.push(...backupJobProblems(where, job));
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
      problems.push(...hostKeyPinProblems(where, doc, job, steps));
      problems.push(...sshOverrideProblems(where, doc, job, steps));
      const guard = String(job.if ?? '');
      if (!guard.includes('refs/heads/main')) problems.push(`${where}: a production deployment must be restricted to refs/heads/main`);
      problems.push(...concurrencyProblems(where, job.concurrency ?? doc.concurrency));
    } else if (nativeShell) {
      // Core V2 M2 B1: a native ssh session to production obeys the same rules as the SSH action: never automatic, main only, the queue.
      deploys = true;
      if (automatic.length > 0) {
        problems.push(`${where}: a production SSH job must only run on workflow_dispatch or schedule, never automatically (found: ${automatic.join(', ')})`);
      }
      if (!String(job.if ?? '').includes('refs/heads/main')) problems.push(`${where}: a production deployment must be restricted to refs/heads/main`);
      problems.push(...concurrencyProblems(where, job.concurrency ?? doc.concurrency));
    }
    if (pushesProdTag) {
      problems.push(...concurrencyProblems(`${where} (publishes the :production image)`, job.concurrency ?? doc.concurrency));
      if (!String(job.if ?? '').includes('refs/heads/main')) problems.push(`${where}: publishing :production must be restricted to refs/heads/main`);
    }
  }

  // Core V2 M2 B1: the scheduled backup's guard, workflow and credentials stay where they belong.
  if (fileName !== SCHEDULED_BACKUP_WORKFLOW && SCHEDULE_GUARD_READ.test(text)) {
    problems.push(`${fileName}: the activation guard CORE_BACKUP_SCHEDULE is read only by ${SCHEDULED_BACKUP_WORKFLOW} (the schedule of core-backup.yml stays removed)`);
  }
  const outsideJobs = { ...doc };
  delete outsideJobs.jobs;
  if (BACKUP_CREDENTIAL.test(JSON.stringify(outsideJobs))) problems.push(`${fileName}: the BACKUP_SSH_* credentials are never set at workflow level`);
  if (fileName === SCHEDULED_BACKUP_WORKFLOW) problems.push(...scheduledBackupWorkflowProblems(fileName, doc, triggers));
  if (TAILNET_CREDENTIAL.test(JSON.stringify(outsideJobs))) problems.push(`${fileName}: the TS_* secrets are never set at workflow level`);
  if (fileName === PROBE_WORKFLOW) problems.push(...probeWorkflowProblems(fileName, doc, triggers));
  if (fileName === BACKUP_WORKFLOW) problems.push(...backupWorkflowProblems(fileName, doc));
  if (TAILNET_JOBS.some((t) => t.file === fileName) && !text.split('\n').some((l) => l.trim() === `uses: ${TAILSCALE_ACTION} # ${TAILSCALE_ACTION_RELEASE}`)) {
    problems.push(`${fileName}: the Tailscale action must be written exactly "uses: ${TAILSCALE_ACTION} # ${TAILSCALE_ACTION_RELEASE}"`);
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
 * V2 A12.6.3 (alerting foundation), when `rules` / `ruleTests` (the rule file and its promtool tests, text) are given, see
 * `checkAlertRules`; always:
 * - no `alerting:` block and no Alertmanager (deferred, D6a); `rule_files` is exactly the read-only rules directory glob;
 * - exactly one self-scrape job `prometheus` (localhost:9090, plain /metrics) keeping exactly the approved families through one
 *   `metric_relabel_configs` keep rule, and no other job scraping Prometheus;
 * - the rules directory is mounted read-only, the tests directory never, and every Prometheus bind mount is read-only.
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
export function checkLocalObservability(base, overlay, prometheus, rules, ruleTests) {
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
  problems.push(...checkPrometheusAlerting(prom, p));
  if (rules !== undefined || ruleTests !== undefined) problems.push(...checkAlertRules(rules, ruleTests));
  return problems;
}

/** V2 A12.6.3: the Prometheus families the self-scrape keeps (the Prometheus alerts and rule-health evidence need nothing else). */
export const PROMETHEUS_SELF_METRICS = ['prometheus_config_last_reload_successful', 'prometheus_config_last_reload_success_timestamp_seconds',
  'prometheus_rule_evaluation_failures_total', 'prometheus_rule_group_last_evaluation_timestamp_seconds', 'prometheus_rule_group_iterations_missed_total',
  'process_start_time_seconds', 'process_resident_memory_bytes', 'prometheus_tsdb_head_series'];
export const PROMETHEUS_RULE_GLOB = '/etc/prometheus/rules/*.rules.yml';
const PROMETHEUS_RULES_MOUNT = './infra/observability/prometheus/rules:/etc/prometheus/rules:ro';
function checkPrometheusAlerting(prom, p) {
  const problems = [];
  const where = 'infra/observability/prometheus/prometheus.yml';
  if (p && typeof p === 'object') {
    if ('alerting' in p || /alertmanager/i.test(JSON.stringify(p))) problems.push(`${where}: no alerting block or Alertmanager (deferred until a concrete receiver exists, D6a)`);
    const files = asArray(p.rule_files);
    if (files.length !== 1 || files[0] !== PROMETHEUS_RULE_GLOB) problems.push(`${where}: rule_files must be exactly ["${PROMETHEUS_RULE_GLOB}"]`);
    const jobs = asArray(p.scrape_configs);
    const self = jobs.filter((j) => j?.job_name === 'prometheus');
    if (self.length !== 1) problems.push(`${where}: exactly one self-scrape job "prometheus" is required (found ${self.length})`);
    else {
      const j = self[0];
      const targets = asArray(j.static_configs).flatMap((c) => asArray(c?.targets));
      if (asArray(j.static_configs).length !== 1 || targets.length !== 1 || targets[0] !== 'localhost:9090') problems.push(`${where}: the prometheus job must scrape exactly localhost:9090 (its own port, nothing published)`);
      for (const k of Object.keys(j)) if (!['job_name', 'static_configs', 'metric_relabel_configs'].includes(k)) problems.push(`${where}: the prometheus job must not set ${k} (plain http /metrics, no relabelling of targets)`);
      const keep = asArray(j.metric_relabel_configs);
      const rule = keep[0] ?? {};
      if (keep.length !== 1 || rule.action !== 'keep' || JSON.stringify(rule.source_labels) !== '["__name__"]' || Object.keys(rule).some((k) => !['source_labels', 'regex', 'action'].includes(k))
        || !sameSet(String(rule.regex ?? '').split('|'), PROMETHEUS_SELF_METRICS)) {
        problems.push(`${where}: the prometheus job must keep exactly ${PROMETHEUS_SELF_METRICS.join(', ')} (one metric_relabel_configs keep rule on __name__)`);
      }
    }
    for (const j of jobs) {
      if (j?.job_name === 'prometheus') continue;
      const targets = asArray(j?.static_configs).flatMap((c) => asArray(c?.targets)).map(String);
      if (targets.some((t) => /^(localhost|127\.0\.0\.1|prometheus):9090$/.test(t))) problems.push(`${where}: job ${j?.job_name} scrapes Prometheus; only the allowlisted "prometheus" job may`);
    }
  }
  if (prom) {
    const mounts = asArray(prom.volumes).map((v) => (typeof v === 'object' ? `${v.source}:${v.target}${v.read_only ? ':ro' : ''}` : String(v)));
    if (mounts.filter((m) => m === PROMETHEUS_RULES_MOUNT).length !== 1) problems.push(`docker-compose.observability.yml: prometheus must mount the rules exactly once, read-only (${PROMETHEUS_RULES_MOUNT})`);
    for (const m of mounts) {
      if (/prometheus\/tests/.test(m)) problems.push(`docker-compose.observability.yml: prometheus must not mount the rule tests (${m})`);
      if (m.startsWith('./') && !m.endsWith(':ro')) problems.push(`docker-compose.observability.yml: prometheus bind mount ${m} must be read-only`);
      if (m.includes('/etc/prometheus/rules') && m !== PROMETHEUS_RULES_MOUNT) problems.push(`docker-compose.observability.yml: prometheus rules mount ${m} must be ${PROMETHEUS_RULES_MOUNT}`);
    }
  }
  return problems;
}

/**
 * V2 A12.6.3: the LOCAL alert rules (`rules`: infra/observability/prometheus/rules/nawara-core.rules.yml) and their promtool tests
 * (`ruleTests`: infra/observability/prometheus/tests/nawara-core.rules.test.yml), as text.
 * - exactly the approved catalog (`ALERT_CATALOG`: 17 alerts in four groups; V2 A3M.4 added DeadLetterCopyFailing), no deferred or rejected alert (SettleFailures, readiness,
 *   self-scrape, DLQ depth, broker backlog, long transactions, TSDB);
 * - alert rules only (no recording rule yet), unique CamelCase names in named groups; keys alert, expr, for, labels, annotations;
 * - labels: `severity` only, critical or warning; annotations: `summary` / `description`, static text with only `$value` and the
 *   approved labels (job, instance, rule_group), no URL;
 * - expressions: no `or vector(`, no readiness metric (dashboard only, A12.6.0), no detailed broker metric, no label_replace/label_join;
 *   every series bounded to its job (`up` / `nawara_*` to the eight Core jobs or rabbitmq / postgres / prometheus; `pg_*` postgres,
 *   `rabbitmq_*` rabbitmq, `prometheus_*` prometheus); matchers and groupings only on approved labels; outbox gauges read only once
 *   their stats were read (the A12.6.2 rule); A12.6.3.2: labels job, instance, queue, pool, datname, alarm, rule_group; selection-only
 *   matchers outcome (dead-letter outcomes), status_class ("5xx", !="aborted"), wait_event_type ("Lock"); no bare `{…}` selector and
 *   no label_replace except BrokerResourceAlarm's exact form over the three aggregate alarm families; HttpServerErrorRatio has both a
 *   ratio and an absolute 5xx floor; PgLockWaits counts waiting sessions, never locks held; no uncollected PostgreSQL data;
 * - tests load exactly the rule file, and every alert has a test where it fires and one where it does not; no test names an unknown alert.
 */
export const ALERT_SEVERITIES = ['critical', 'warning'];
const ALERT_LABELS = new Set(['job', 'instance', 'queue', 'pool', 'datname', 'alarm', 'rule_group']);
const ALERT_JOBS = new Set(['rabbitmq', 'postgres', 'prometheus']);
/** V2 A12.6.3: the complete approved alert catalog (A12.6.3.1 + A12.6.3.2, plus A3M.4's DeadLetterCopyFailing), in its four groups. */
export const ALERT_CATALOG = {
  'core-services': ['CoreServiceDown', 'DbPoolWaiting', 'HttpServerErrorRatio'],
  'core-messaging': ['ConsumerDetached', 'MessagesDeadLettered', 'DeadLetterCopyFailing', 'OutboxBacklogAging', 'OutboxStatsStale'],
  infrastructure: ['RabbitMQDown', 'PostgreSQLDown', 'PostgresExporterDown', 'BrokerResourceAlarm', 'PgConnectionPressure', 'PgDeadlocks', 'PgLockWaits'],
  prometheus: ['PrometheusRuleFailures', 'PrometheusConfigReloadFailed'],
};
// Deferred or rejected by the owner (A12.6.3.0): never an alert here.
const DEFERRED_ALERTS = /SettleFailure|Readiness|NotReady|SelfScrape|DLQ|Dlq|DeadLetterQueue|Depth|Backlog(?!Aging)|LongTransaction|LongRunning|Tsdb|TSDB|Alertmanager/;
const DEAD_LETTER_OUTCOMES = ['dead_lettered_malformed', 'dead_lettered_permanent', 'dead_lettered_retries_exhausted', 'dead_letter_unannotated'];
// Labels a rule may SELECT on (never propagate: each rule aggregates them away), with the only values allowed.
const SELECTION_MATCHERS = {
  // V2 A3M.4: DeadLetterCopyFailing selects the one deferral outcome, exactly (an unconfirmed dead-letter copy, held and requeued).
  outcome: (x) => (x.op === '=~' && x.value.split('|').every((v) => DEAD_LETTER_OUTCOMES.includes(v))) || (x.op === '=' && x.value === 'dead_letter_deferred'),
  status_class: (x) => (x.op === '=' && x.value === '5xx') || (x.op === '!=' && x.value === 'aborted'),
  wait_event_type: (x) => x.op === '=' && x.value === 'Lock',
};
export const BROKER_ALARMS = ['memory_used_watermark', 'free_disk_space_watermark', 'file_descriptor_limit'];
// The one reviewed label transformation: BrokerResourceAlarm names which of the three aggregate alarm families is raised.
const BROKER_ALARM_EXPR = /^label_replace\(\{__name__=~"rabbitmq_alarms_\(([a-z_|]+)\)",job="rabbitmq"\}, "alarm", "\$1", "__name__", "rabbitmq_alarms_\(\.\+\)"\) == 1$/;
const RULES_FILE = 'infra/observability/prometheus/rules/nawara-core.rules.yml';
const RULE_TESTS_FILE = 'infra/observability/prometheus/tests/nawara-core.rules.test.yml';
export function checkAlertRules(rulesText, testsText) {
  const problems = [];
  let r, t;
  try { r = parse(String(rulesText ?? '')); } catch (e) { return [`${RULES_FILE}: not valid YAML (${e.message})`]; }
  try { t = parse(String(testsText ?? '')); } catch (e) { return [`${RULE_TESTS_FILE}: not valid YAML (${e.message})`]; }
  const groups = asArray(r?.groups);
  if (groups.length === 0) problems.push(`${RULES_FILE}: no rule group`);
  const found = Object.fromEntries(groups.map((g) => [g?.name, asArray(g?.rules).map((x) => x?.alert)]));
  if (!sameSet(Object.keys(found), Object.keys(ALERT_CATALOG))) problems.push(`${RULES_FILE}: the groups must be exactly ${Object.keys(ALERT_CATALOG).join(', ')}`);
  for (const [group, names] of Object.entries(ALERT_CATALOG)) {
    for (const n of names) if (!asArray(found[group]).includes(n)) problems.push(`${RULES_FILE}: alert ${n} is missing from group ${group}`);
  }
  const allAlerts = Object.values(found).flat();
  for (const n of allAlerts) {
    if (DEFERRED_ALERTS.test(String(n))) problems.push(`${RULES_FILE}: ${n} is deferred or rejected (A12.6.3.0); not an alert here`);
    else if (!Object.values(ALERT_CATALOG).flat().includes(n)) problems.push(`${RULES_FILE}: ${n} is not in the approved alert catalog`);
  }
  const groupNames = new Set();
  const alerts = new Set();
  for (const g of groups) {
    if (typeof g?.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(g.name) || groupNames.has(g.name)) problems.push(`${RULES_FILE}: group "${g?.name}" needs a unique lowercase name`);
    groupNames.add(g?.name);
    for (const k of Object.keys(g ?? {})) if (!['name', 'rules'].includes(k)) problems.push(`${RULES_FILE}: group ${g?.name} must not set ${k} (the global 30 s evaluation interval applies)`);
    for (const rule of asArray(g?.rules)) {
      const at = `${RULES_FILE}: ${rule?.alert ?? rule?.record ?? '?'}`;
      if (!('alert' in (rule ?? {}))) { problems.push(`${at}: alert rules only`); continue; }
      if (!/^[A-Z][A-Za-z0-9]+$/.test(String(rule.alert)) || alerts.has(rule.alert)) problems.push(`${at}: needs a unique CamelCase alert name`);
      alerts.add(rule.alert);
      for (const k of Object.keys(rule)) if (!['alert', 'expr', 'for', 'labels', 'annotations'].includes(k)) problems.push(`${at}: must not set ${k}`);
      const labels = rule.labels ?? {};
      if (Object.keys(labels).join() !== 'severity' || !ALERT_SEVERITIES.includes(labels.severity)) problems.push(`${at}: labels must be exactly severity: critical | warning`);
      for (const [k, v] of Object.entries(rule.annotations ?? {})) {
        if (!['summary', 'description'].includes(k)) problems.push(`${at}: annotation ${k} is not allowed (summary, description)`);
        const text = String(v);
        if (text.includes('://')) problems.push(`${at}: annotation ${k} must not contain a URL`);
        for (const [, inner] of text.matchAll(/\{\{([^}]*)\}\}/g)) {
          const m = /^\s*(\$value|\$labels\.([a-z_]+))\s*$/.exec(inner);
          if (!m || (m[2] && !ALERT_LABELS.has(m[2]))) problems.push(`${at}: annotation ${k} may use only $value and $labels.${[...ALERT_LABELS].join(' / ')} ({{${inner}}})`);
        }
      }
      const e = String(rule.expr ?? '');
      if (/\bor\s+vector\s*\(/.test(e)) problems.push(`${at}: uses "or vector(...)" (a fabricated value)`);
      if (/\bnawara_readiness_/.test(e)) problems.push(`${at}: readiness is dashboard only, never an alert (its gauges change only when /ready is called)`);
      if (/\brabbitmq_detailed_/.test(e)) problems.push(`${at}: detailed broker metrics are not scraped`);
      const broker = BROKER_ALARM_EXPR.exec(e.trim());
      const brokerOk = rule.alert === 'BrokerResourceAlarm' && broker && sameSet(broker[1].split('|'), BROKER_ALARMS);
      if (rule.alert === 'BrokerResourceAlarm' && !brokerOk) problems.push(`${at}: must be exactly label_replace({__name__=~"rabbitmq_alarms_(${BROKER_ALARMS.join('|')})",job="rabbitmq"}, "alarm", "$1", "__name__", "rabbitmq_alarms_(.+)") == 1`);
      // The exact BrokerResourceAlarm form is verified above; its quoted __name__ regex is not a series to scan.
      const scanned = brokerOk ? '' : e;
      if (!brokerOk && /\blabel_(replace|join)\s*\(/.test(e)) problems.push(`${at}: must not create labels (label_replace / label_join; only BrokerResourceAlarm's reviewed form may)`);
      if (!brokerOk && /(^|[^A-Za-z0-9_\s])\s*\{/.test(e)) problems.push(`${at}: selects series without a metric name (a bare {…} selector)`);
      if (UNSUPPORTED_POSTGRES.test(e)) problems.push(`${at}: uses PostgreSQL data that is not collected (statements, query text, per-table / per-index, I/O timing)`);
      if (rule.alert === 'HttpServerErrorRatio') {
        if (!/\)\s*>\s*0?\.\d+/.test(e) || !/\bincrease\(nawara_http_server_requests_total\{[^}]*status_class="5xx"[^}]*\}\[5m\]\)\)\s*>=\s*[1-9]/.test(e)) {
          problems.push(`${at}: needs both an error ratio threshold and an absolute 5xx floor (increase(...status_class="5xx"...[5m]) >= N)`);
        }
      }
      if (rule.alert === 'PgLockWaits' && (!/\bpg_stat_activity_count\{[^}]*wait_event_type="Lock"/.test(e) || /\bpg_locks_count\b/.test(e))) problems.push(`${at}: must count sessions waiting on a lock (pg_stat_activity_count{wait_event_type="Lock"}), not locks held`);
      for (const [, , list] of e.matchAll(/\b(by|without|on|ignoring)\s*\(([^)]*)\)/g)) {
        for (const l of list.split(',').map((x) => x.trim()).filter(Boolean)) if (!ALERT_LABELS.has(l)) problems.push(`${at}: groups or matches on "${l}" (approved: ${[...ALERT_LABELS].join(', ')})`);
      }
      const bounded = (s, allowed) => s.matchers.some((x) => x.label === 'job' && allowed(x));
      for (const s of selectorsOf(scanned, 'up\\b')) if (!bounded(s, (x) => isCoreJobs(x) && x.value !== '$job' || (x.op === '=' && ALERT_JOBS.has(x.value)))) problems.push(`${at}: up must select the Core jobs (exact list) or job rabbitmq / postgres / prometheus`);
      for (const s of selectorsOf(scanned, 'nawara_')) if (!bounded(s, (x) => isCoreJobs(x) && x.value !== '$job')) problems.push(`${at}: ${s.metric} must be bounded to the Core jobs`);
      for (const [prefix, job] of [['pg_', 'postgres'], ['rabbitmq_', 'rabbitmq'], ['prometheus_', 'prometheus'], ['process_', null]]) {
        for (const s of selectorsOf(scanned, prefix)) if (!bounded(s, (x) => (job ? x.op === '=' && x.value === job : isCoreJobs(x) && x.value !== '$job' || (x.op === '=' && ALERT_JOBS.has(x.value))))) problems.push(`${at}: ${s.metric} must select ${job ? `job="${job}"` : 'a bounded job'}`);
      }
      for (const s of [...selectorsOf(scanned, '[a-z_]')]) {
        for (const x of s.matchers) {
          if (x.label === 'job' || ALERT_LABELS.has(x.label)) continue;
          if (SELECTION_MATCHERS[x.label]?.(x)) continue;
          problems.push(`${at}: ${s.metric} matches on "${x.label}${x.op}\"${x.value}\"" (approved: ${[...ALERT_LABELS].join(', ')}; selection only: outcome=~<dead-letter outcomes> or ="dead_letter_deferred", status_class="5xx" / !="aborted", wait_event_type="Lock")`);
        }
      }
      if (/\bnawara_outbox_(pending_events|retrying_events|oldest_pending_age_seconds)\b/.test(e)
        && !/\band\s+on\s*\(\s*job\s*,\s*instance\s*\)\s*\(\s*nawara_outbox_stats_timestamp_seconds(\{[^}]*\})?\s*>\s*0\s*\)/.test(e)) {
        problems.push(`${at}: reads outbox gauges without "and on (job, instance) (nawara_outbox_stats_timestamp_seconds > 0)"`);
      }
    }
  }
  if (JSON.stringify(t?.rule_files) !== '["../rules/nawara-core.rules.yml"]') problems.push(`${RULE_TESTS_FILE}: rule_files must be exactly ["../rules/nawara-core.rules.yml"]`);
  const fires = new Set();
  const quiet = new Set();
  for (const test of asArray(t?.tests)) {
    for (const a of asArray(test?.alert_rule_test)) {
      if (!alerts.has(a?.alertname)) problems.push(`${RULE_TESTS_FILE}: tests the unknown alert ${a?.alertname}`);
      (asArray(a?.exp_alerts).length ? fires : quiet).add(a?.alertname);
    }
  }
  for (const a of alerts) {
    if (!fires.has(a)) problems.push(`${RULE_TESTS_FILE}: no test where ${a} fires`);
    if (!quiet.has(a)) problems.push(`${RULE_TESTS_FILE}: no test where ${a} does not fire`);
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
        // V2 A12.6.2: the outbox gauges are 0 until the relay's first successful aggregate read; a panel shows them only for a job
        // and instance whose stats timestamp is set.
        if (/\bnawara_outbox_(pending_events|retrying_events|oldest_pending_age_seconds)\b/.test(v)
          && !/\band\s+on\s*\(\s*job\s*,\s*instance\s*\)\s*\(\s*nawara_outbox_stats_timestamp_seconds(\{[^}]*\})?\s*>\s*0\s*\)/.test(v)) {
          problems.push(`${file}: ${path} reads outbox gauges without "and on (job, instance) (nawara_outbox_stats_timestamp_seconds > 0)" (before the first successful stats read the kit exports 0: "not read yet" must never read as no pending work)`);
        }
        if (/\bservice\s*(=~|!~|!=|=)/.test(v) || /\b(by|without)\s*\([^)]*\bservice\b/.test(v)) {
          if (!v.includes('nawara_service_info')) problems.push(`${file}: ${path} selects on "service"; use "job" (only nawara_service_info carries service)`);
        }
      }
    });
    if (d && typeof d === 'object') problems.push(...checkDashboardSemantics(file, d, text));
  }
  for (const [uid, title] of Object.entries(GRAFANA_DASHBOARDS)) {
    if (!uids.has(uid)) problems.push(`infra/observability/grafana/dashboards: the "${title}" dashboard (uid ${uid}) is missing`);
  }
  return problems;
}

/**
 * V2 A12.6.2: the provisioned dashboards (uid → title) and the one bounded variable each operational dashboard has: its name, the metric
 * its values come from (the label of the same name), and how its source selector must be bounded. A variable is never multi-value, "All"
 * or free text, and a panel uses it only as an exact match (`<name>="$<name>"`), never as a regular expression.
 */
export const GRAFANA_DASHBOARDS = {
  'nawara-core-overview': 'Core · Overview',
  'nawara-core-service': 'Core · Service',
  'nawara-core-messaging': 'Core · Messaging',
  'nawara-core-postgresql': 'Core · PostgreSQL',
};
export const CORE_JOBS = ['auth-service', 'billing-service', 'payment-service', 'organization-service', 'notification-service', 'file-service', 'audit-service', 'release-service'];
const DASHBOARD_VARIABLES = {
  'nawara-core-service': { name: 'job', metric: 'nawara_service_info' },
  'nawara-core-messaging': { name: 'queue', metric: 'nawara_event_consumer_up' },
  'nawara-core-postgresql': { name: 'datname', metric: 'pg_database_size_bytes' },
};
const DASHBOARD_PANEL_TYPES = new Set(['row', 'stat', 'timeseries', 'text']);
const GRAFANA_BUILTIN_VARIABLES = new Set(['__range', '__interval', '__rate_interval']);
const LITERAL_ALTERNATION = /^[a-z0-9_.-]+(\|[a-z0-9_.-]+)*$/;
// Detailed / per-object broker metrics, and labels that identify one broker object (the aggregated endpoint has none of them).
const RABBITMQ_PER_OBJECT_LABEL = /^(queue|vhost|channel|connection|exchange|consumer_tag)$/;
// PostgreSQL capabilities that are not collected locally (A12.5.3): statement statistics, per-table / per-index collectors, I/O timing.
const UNSUPPORTED_POSTGRES = /\bpg_stat_statements|\bpg_stat(io)?_user_(tables|indexes)|\bpg_stat_database_blk_(read|write)_time\b|\bquery\s*(=~|!~|!=|=)|\bby\s*\([^)]*\bquery\b/;
const matchersOf = (body) => [...(body ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].map(([, label, op, value]) => ({ label, op, value }));
const selectorsOf = (expr, prefix) => [...expr.matchAll(new RegExp(`\\b(${prefix}[a-zA-Z0-9_]*)\\b(\\s*\\{([^}]*)\\})?`, 'g'))].map((m) => ({ metric: m[1], braces: m[2] !== undefined, matchers: matchersOf(m[3]) }));
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const isCoreJobs = (m) => m.label === 'job' && ((m.op === '=~' && sameSet(m.value.split('|'), CORE_JOBS)) || (m.op === '=' && (CORE_JOBS.includes(m.value) || m.value === '$job')));

function checkDashboardSemantics(file, d, text) {
  const problems = [];
  const at = (where, msg) => problems.push(`${file}: ${where} ${msg}`);
  const expected = DASHBOARD_VARIABLES[d.uid];
  if (GRAFANA_DASHBOARDS[d.uid] && d.title !== GRAFANA_DASHBOARDS[d.uid]) at('title', `must be "${GRAFANA_DASHBOARDS[d.uid]}" for uid ${d.uid}`);
  if (d.editable !== false) at('editable', 'must be false (provisioned from the repository)');
  if (asArray(d.links).length) at('links', 'must be empty (no external link)');
  if (text.includes('://')) at('content', 'must not contain a URL (no external dashboard, link or service)');
  walkJson(d, (k, v, path) => {
    if (['gnetId', 'rawSql', 'rawQuery', 'sql'].includes(k)) at(path, 'is not allowed (no Grafana.com dashboard, no SQL)');
    if (/password|secret|token|apikey|credential/i.test(k)) at(path, 'is not allowed (dashboards hold no credential)');
  });

  // Variables: only the expected one, a bounded label_values() over its own metric, single-valued, never free text.
  const vars = asArray(d.templating?.list);
  if (!expected && vars.length) at('templating', 'must define no variable');
  if (expected && (vars.length !== 1 || vars[0]?.name !== expected.name)) at('templating', `must define exactly the variable "${expected.name}"`);
  for (const v of vars) {
    const where = `variable ${v?.name}`;
    if (v?.type !== 'query') at(where, 'must be a query variable (no textbox, custom, constant or ad hoc filter)');
    if (v?.multi === true || v?.includeAll === true || v?.allValue !== undefined) at(where, 'must be single-valued (no multi-value, "All" or custom all value)');
    if (v?.regex) at(where, 'must not post-filter values with a regex');
    const def = typeof v?.query === 'string' ? v.query : v?.query?.query;
    const m = /^label_values\(([a-z_]+)\{([^}]*)\},\s*([a-z_]+)\)$/.exec(String(def ?? ''));
    if (!m || v?.definition !== def) { at(where, 'must be label_values(<metric>{<bounded selector>}, <label>), the same in "query" and "definition"'); continue; }
    const [, metric, body, label] = m;
    const matchers = matchersOf(body);
    if (label !== v.name || (expected && (v.name !== expected.name || metric !== expected.metric))) at(where, `must read the label "${v.name}" from ${expected?.metric ?? 'its own metric'}`);
    if (body.includes('$')) at(where, 'must not depend on another variable');
    for (const x of matchers) if (x.op === '=~' && !LITERAL_ALTERNATION.test(x.value)) at(where, `matcher ${x.label}=~"${x.value}" must be a literal alternation`);
    if (v.name === 'job' || v.name === 'queue') {
      if (!matchers.some((x) => x.label === 'job' && x.op === '=~' && sameSet(x.value.split('|'), CORE_JOBS))) at(where, 'must be bounded to the eight Core jobs (job=~"<the Core jobs>")');
    }
    if (v.name === 'datname') {
      if (!matchers.some((x) => x.label === 'job' && x.op === '=' && x.value === 'postgres')) at(where, 'must select job="postgres"');
      const dbs = matchers.find((x) => x.label === 'datname' && x.op === '=~');
      if (!dbs || dbs.value.split('|').some((n) => /^template/.test(n))) at(where, 'must be bounded to an explicit list of databases without template databases');
    }
  }

  const ids = new Set();
  let usesVariable = false;
  for (const panel of asArray(d.panels)) {
    const where = `panel ${panel?.id} "${panel?.title}"`;
    if (!DASHBOARD_PANEL_TYPES.has(panel?.type)) at(where, `has type "${panel?.type}": only ${[...DASHBOARD_PANEL_TYPES].join(', ')} (no plugin panel)`);
    if (ids.has(panel?.id)) at(where, 'reuses a panel id');
    ids.add(panel?.id);
    if (asArray(panel?.links).length) at(where, 'must not have links');
    if (panel?.type === 'text' && /<\s*(script|iframe|img)/i.test(String(panel?.options?.content ?? ''))) at(where, 'text must be plain markdown (no script, frame or image)');
    const exprs = asArray(panel?.targets).map((t) => String(t?.expr ?? ''));
    const all = exprs.join('\n');
    if (/\brabbitmq_/.test(all) && /\bnawara_/.test(all)) at(where, 'mixes broker (rabbitmq_*) and application (nawara_*) metrics: the two layers stay separate');
    if (/\brabbitmq_global_messages_dead_lettered_/.test(all) && (!/mechanics/i.test(panel.title) || /\bdlq\b/i.test(panel.title))) {
      at(where, 'shows broker dead-letter counters: its title must say "mechanics" and never "DLQ" (retry TTL cycling is dead-lettering too; parked messages are the application outcome)');
    }
    if (/\brabbitmq_queue_messages(_ready|_unacked)?\b/.test(all) && !/aggregate/i.test(panel.title)) at(where, 'shows broker queue totals: its title must say "aggregate" (retry and dead-letter queues are included)');
    for (const e of exprs) {
      for (const s of selectorsOf(e, 'rabbitmq_')) {
        if (/^rabbitmq_detailed_/.test(s.metric)) at(where, `uses ${s.metric} (the detailed endpoint is not scraped)`);
        if (!s.matchers.some((x) => x.label === 'job' && x.op === '=' && x.value === 'rabbitmq')) at(where, `${s.metric} must select job="rabbitmq"`);
        for (const x of s.matchers) if (RABBITMQ_PER_OBJECT_LABEL.test(x.label)) at(where, `${s.metric} selects the per-object label "${x.label}" (aggregate broker metrics only)`);
      }
      if (/\brabbitmq_/.test(e) && /\b(by|without|on|ignoring)\s*\([^)]*\b(queue|vhost|channel|connection|exchange)\b/.test(e)) at(where, 'groups broker metrics by a per-object label (aggregate broker metrics only)');
      for (const s of selectorsOf(e, 'pg_')) if (!s.matchers.some((x) => x.label === 'job' && x.op === '=' && x.value === 'postgres')) at(where, `${s.metric} must select job="postgres"`);
      if (UNSUPPORTED_POSTGRES.test(e)) at(where, 'uses PostgreSQL data that is not collected (statements, query text, per-table / per-index, I/O timing)');
      // Variables: exact match on the dashboard's own variable only.
      for (const [, name] of e.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
        if (GRAFANA_BUILTIN_VARIABLES.has(name)) continue;
        if (!expected || name !== expected.name) at(where, `uses the unknown variable $${name}`);
      }
      if (expected) {
        const residue = e.split(`${expected.name}="$${expected.name}"`).join('');
        if (residue.includes(`$${expected.name}`) || residue.includes(`\${${expected.name}`)) at(where, `uses $${expected.name} other than as the exact match ${expected.name}="$${expected.name}" (never a regex)`);
        if (e.includes(`${expected.name}="$${expected.name}"`)) usesVariable = true;
      }
      if (expected) {
        // Operational dashboards: every Core metric is bounded to the Core jobs (or the selected one).
        for (const s of selectorsOf(e, 'nawara_')) if (!s.matchers.some(isCoreJobs)) at(where, `${s.metric} must be bounded to the Core jobs (job=~"<the Core jobs>" or job="$job")`);
      }
      if (d.uid === 'nawara-core-service') {
        for (const prefix of ['nawara_', 'process_', 'nodejs_', 'up\\b']) {
          for (const s of selectorsOf(e, prefix)) if (!s.matchers.some((x) => x.label === 'job' && x.op === '=' && x.value === '$job')) at(where, `${s.metric} must select job="$job"`);
        }
      }
    }
  }
  if (expected && !usesVariable) at('panels', `never filter by ${expected.name}="$${expected.name}"`);
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

/**
 * V2 A4.5 (OD-A4.5-1, OD-A4.5-2): no application is exempt from the product-term check (A15.4 had exempted all of Auth). The only
 * exceptions are two comment LINES of Auth migrations that are applied in production and can never be edited (the migration runner
 * refuses a modified applied migration): each is exempt by its exact path and its exact full line, and nothing else in either file.
 * Only a top-level migration file can carry an exception (see `historicalLinesRemoved`); an entry is added only after review.
 */
export const GENERICITY_HISTORICAL_LINES = new Map([
  ['apps/auth-service/db/migrations/0004_organization_join_codes_and_membership.sql', ['  -- Opaque registration audience label chosen by the platform ("student", "teacher", ...). Auth never']],
  ['apps/auth-service/db/migrations/0007_multi_organization_membership.sql', ['-- A platform-specific label ("teacher", "driver", ...) can never be stored on a user again.']],
]);
const HISTORICAL_MIGRATION = /^apps\/[a-z0-9-]+\/db\/migrations\/\d{4}_[a-z0-9_]+\.sql$/;
/** The text with the reviewed historical lines of THIS file removed (whole-line equality only); any other file is returned unchanged. */
function historicalLinesRemoved(relPath, text) {
  const allowed = HISTORICAL_MIGRATION.test(relPath) ? GENERICITY_HISTORICAL_LINES.get(relPath) : undefined;
  return allowed ? text.split('\n').filter((line) => !allowed.includes(line)).join('\n') : text;
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

/**
 * ONE syntax-aware pass over a source file (A12.2a; generalized in V2 A1.4 so every source guard shares it): every STATIC module
 * specifier, in the forms listed above, plus the two caller-policy signals the A1.4 completeness rule needs. A use of the kit's
 * `parseCallerPolicy` is a named import of it from any module or a call to it; a policy read is a configuration read of a variable of
 * the `SERVICE_POLICY` family (`reader.get / required / optional('…')`, `process.env.…`, `process.env['…']`).
 *
 * V2 A2.5 adds two configuration facts from the same pass. `readsProcessEnv`: the file reaches the process environment in any form
 * (`process.env`, `process['env']`, `globalThis.process.env`, `const { env } = process`, `({ env } = process)`,
 * `import { env } from 'node:process'`); a comment, a string or a type (`NodeJS.ProcessEnv`, `typeof process.env`) is not a read.
 * `configNames`: the LITERAL environment variable names the file passes to a configuration read: the first argument of an
 * `EnvReader` method called on `reader` (or Auth's `src`), a name passed to one of the known configuration helpers
 * (`CONFIG_NAME_HELPERS`: `readKey(reader, 'X_KEY', …)`, `int(env, 'X_TTL', …)`), and `env.X` / `env['X']`. A computed name (a
 * template with substitutions, or a prefix a helper completes) is not literal and is not listed: the list is high-confidence, not complete.
 *
 * V2 A15.1 splits the process-environment accesses in two: `envReaderUses` counts `new EnvReader(process.env)` (the environment handed
 * whole to the kit's reader), `directEnvUses` every other access (a named read, a bracket read, a destructuring, a spread, a write).
 */
export function sourceFacts(relPath, text) {
  // One parse per file and run: the source guards and the A2.5 README coverage read the same facts (callers never mutate them).
  const cached = FACTS.get(relPath);
  if (cached?.text === text) return cached.facts;
  const facts = parseSourceFacts(relPath, text);
  FACTS.set(relPath, { text, facts });
  return facts;
}
const FACTS = new Map();
function parseSourceFacts(relPath, text) {
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
  let usesCallerPolicy = false;
  const policyReads = [];
  let readsProcessEnv = false;
  let envReaderUses = 0;
  let directEnvUses = 0;
  const configNames = new Set();
  const visit = (node) => {
    if (isProcessEnvAccess(node)) {
      readsProcessEnv = true;
      if (isEnvReaderArgument(node)) envReaderUses += 1;
      else directEnvUses += 1;
    }
    for (const name of literalConfigNames(node)) configNames.add(name);
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      spec = staticSpecifier(node.moduleSpecifier);
      const named = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : undefined;
      if (named && ts.isNamedImports(named) && named.elements.some((el) => (el.propertyName ?? el.name).text === CALLER_POLICY_PARSER)) usesCallerPolicy = true;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = staticSpecifier(node.moduleReference.expression);
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
      if (calleeName(callee) === CALLER_POLICY_PARSER) usesCallerPolicy = true;
      const read = staticSpecifier(node.arguments[0]);
      if (ts.isPropertyAccessExpression(callee) && CONFIG_READS.has(callee.name.text) && read !== undefined && POLICY_VARIABLE.test(read)) policyReads.push(read);
    } else if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression) && POLICY_VARIABLE.test(node.name.text)) policyReads.push(node.name.text);
    else if (ts.isElementAccessExpression(node) && isProcessEnv(node.expression)) {
      const read = staticSpecifier(node.argumentExpression);
      if (read !== undefined && POLICY_VARIABLE.test(read)) policyReads.push(read);
    }
    if (spec !== undefined) specifiers.push(spec);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, usesCallerPolicy, policyReads, readsProcessEnv, envReaderUses, directEnvUses, configNames: [...configNames] };
}
const CALLER_POLICY_PARSER = 'parseCallerPolicy';
const CONFIG_READS = new Set(['get', 'required', 'optional']); // the kit ConfigReader's string reads
const POLICY_VARIABLE = /^(?:[A-Z][A-Z0-9]*_)?SERVICE_POLICY$/;
const isProcessEnv = (node) => {
  const n = unwrap(node);
  return ts.isPropertyAccessExpression(n) && n.name.text === 'env' && ts.isIdentifier(unwrap(n.expression)) && unwrap(n.expression).text === 'process';
};

const isProcessObject = (node) => {
  const n = unwrap(node);
  return !!n && ((ts.isIdentifier(n) && n.text === 'process') || (ts.isPropertyAccessExpression(n) && n.name.text === 'process'));
};
const PROCESS_MODULES = new Set(['node:process', 'process']);
const bindsEnv = (name) => !!name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === 'env';
/** V2 A2.5: one syntax node that reaches the process environment (see `sourceFacts`). */
function isProcessEnvAccess(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'env' && isProcessObject(node.expression);
  if (ts.isElementAccessExpression(node)) return isProcessObject(node.expression) && staticSpecifier(node.argumentExpression) === 'env';
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && isProcessObject(node.initializer)) {
    return node.name.elements.some((el) => bindsEnv(el.propertyName ?? el.name));
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isProcessObject(node.right)) {
    const left = unwrap(node.left);
    return ts.isObjectLiteralExpression(left) && left.properties.some((p) => bindsEnv(p.name));
  }
  if (ts.isImportDeclaration(node) && PROCESS_MODULES.has(staticSpecifier(node.moduleSpecifier) ?? '')) {
    const named = node.importClause?.namedBindings;
    return !!named && ts.isNamedImports(named) && named.elements.some((el) => (el.propertyName ?? el.name).text === 'env');
  }
  return false;
}
/** V2 A15.1: `process.env` as the first argument of `new EnvReader(...)`: the whole environment handed to the kit's reader. */
function isEnvReaderArgument(node) {
  let child = node;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) { child = parent; parent = parent.parent; }
  return !!parent && ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'EnvReader' && parent.arguments?.[0] === child;
}
const ENV_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const ENV_READER_METHODS = new Set(['get', 'required', 'optional', 'int', 'bool', 'oneOf', 'secret', 'url']); // the kit's EnvReader
const ENV_READERS = new Set(['reader', 'src']); // an EnvReader by convention; `src` is Auth's SecretSource (A4 converges it)
/** Helper functions that take a literal variable name: the kit's key helpers, Auth's loader helpers, Notification's loader helpers. */
const CONFIG_NAME_HELPERS = new Set(['readKey', 'readOptionalKey', 'readKeyRing', 'decodeKey', 'int', 'required', 'secretBytes', 'matching', 'providerUrl']);
/** V2 A4.2: kit helpers that read fixed variable names of their own; a call to one is a read of those names by the calling service. */
const KIT_HELPER_READS = new Map([['readDocsCredentials', ['SWAGGER_PASSWORD', 'SWAGGER_USERNAME']]]);
const isEnvObject = (node) => {
  const n = unwrap(node);
  return !!n && ((ts.isIdentifier(n) && n.text === 'env') || isProcessEnvAccess(n));
};
/** V2 A2.5: the literal environment variable names one syntax node reads (see `sourceFacts`). */
function literalConfigNames(node) {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = unwrap(callee.expression);
      const reads = ENV_READER_METHODS.has(callee.name.text) && ts.isIdentifier(receiver) && ENV_READERS.has(receiver.text);
      const name = reads ? staticSpecifier(node.arguments[0]) : undefined;
      return name !== undefined && ENV_NAME.test(name) ? [name] : [];
    }
    if (ts.isIdentifier(callee) && KIT_HELPER_READS.has(callee.text)) return [...KIT_HELPER_READS.get(callee.text)];
    if (ts.isIdentifier(callee) && CONFIG_NAME_HELPERS.has(callee.text)) return node.arguments.map(staticSpecifier).filter((a) => a !== undefined && ENV_NAME.test(a));
    return [];
  }
  if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) return ENV_NAME.test(node.name.text) ? [node.name.text] : [];
  if (ts.isElementAccessExpression(node) && isEnvObject(node.expression)) {
    const name = staticSpecifier(node.argumentExpression);
    return name !== undefined && ENV_NAME.test(name) ? [name] : [];
  }
  return [];
}

/** Every static module specifier a source file references (A1.4: the shared collector behind the metrics and dependency guards). */
export function staticModuleSpecifiers(relPath, text) {
  return sourceFacts(relPath, text).specifiers;
}

/** The static metrics-client module specifiers a source file references (empty when none). */
export function metricsClientReferences(relPath, text) {
  return staticModuleSpecifiers(relPath, text).filter((spec) => METRICS_CLIENT.test(spec));
}

/** `specifiers`: the file's already-collected static specifiers (checkSource shares its one pass); computed when omitted. */
export function checkMetricsClientImport(relPath, text, specifiers) {
  if (relPath.startsWith(METRICS_CLIENT_HOME) || !PARSED.test(relPath) || relPath.endsWith('.d.ts')) return [];
  return (specifiers ?? staticModuleSpecifiers(relPath, text)).some((spec) => METRICS_CLIENT.test(spec))
    ? [`${relPath}: imports the metrics client library; only ${METRICS_CLIENT_HOME} may (create metrics through the kit's BoundedMetrics)`]
    : [];
}

/**
 * V2 A1.4 (ADR-0056 §11; A1.3): the governed caller-policy modules, each bound to its environment variable. Every one parses its
 * policy document with the kit's `parseCallerPolicy` (envelope, registration cross-check, unknown and duplicate keys) and keeps only its
 * own dimension checks. A service that reads a `…SERVICE_POLICY` variable or uses `parseCallerPolicy` must have its module here.
 */
export const CALLER_POLICY_MODULES = {
  'apps/billing-service/src/admission/caller-admission.policy.ts': 'BILLING_SERVICE_POLICY',
  'apps/payment-service/src/authorization/caller-admission.policy.ts': 'PAYMENT_SERVICE_POLICY',
  'apps/organization-service/src/authorization/service-policy.ts': 'SERVICE_POLICY',
  'apps/notification-service/src/api/caller-policy.ts': 'NOTIFICATION_SERVICE_POLICY',
  'apps/file-service/src/policy/caller-policy.ts': 'FILE_SERVICE_POLICY',
  'apps/audit-service/src/policy/caller-policy.ts': 'AUDIT_SERVICE_POLICY',
  'apps/release-service/src/policy/caller-policy.ts': 'RELEASE_SERVICE_POLICY',
};
const CALLER_POLICY_APPS = new Set(Object.keys(CALLER_POLICY_MODULES).map((p) => p.split('/')[1]));
const KIT = '@nawara/service-kit';

/**
 * One governed caller-policy module (parsed, never regex-matched, so a comment or string mentioning `JSON.parse` is not a call):
 * a named, non-aliased value import of `parseCallerPolicy` from the kit; a call to it whose spec carries `variable: '<its variable>'`;
 * and no local document parser (`JSON.parse`, `JSON['parse']`, the kit's `parseJsonStrict` called directly). Wrapper shapes are free.
 */
export function checkCallerPolicyModule(relPath, text, variable) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let imported = false;
  let aliased = false;
  let calls = 0;
  let bound = false;
  const parsers = new Set();
  const isVariableBinding = (arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === 'variable' && staticSpecifier(p.initializer) === variable);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && staticSpecifier(node.moduleSpecifier) === KIT && !node.importClause?.isTypeOnly) {
      const named = node.importClause?.namedBindings;
      for (const el of named && ts.isNamedImports(named) ? named.elements : []) {
        if ((el.propertyName ?? el.name).text !== CALLER_POLICY_PARSER || el.isTypeOnly) continue;
        if (el.propertyName && el.name.text !== CALLER_POLICY_PARSER) aliased = true;
        else imported = true;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === CALLER_POLICY_PARSER) {
        calls += 1;
        if (node.arguments.some(isVariableBinding)) bound = true;
      }
      const isJson = (n) => ts.isIdentifier(unwrap(n)) && unwrap(n).text === 'JSON';
      if ((ts.isPropertyAccessExpression(callee) && isJson(callee.expression) && callee.name.text === 'parse')
        || (ts.isElementAccessExpression(callee) && isJson(callee.expression) && staticSpecifier(callee.argumentExpression) === 'parse')) parsers.add('JSON.parse');
      if (calleeName(callee) === 'parseJsonStrict') parsers.add('parseJsonStrict');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const problems = [];
  const at = `${relPath} (governed caller-policy module for ${variable})`;
  if (aliased) problems.push(`${at}: imports parseCallerPolicy under an alias; import it by its name from ${KIT} so the shared parser stays visible`);
  else if (!imported) problems.push(`${at}: must import parseCallerPolicy from ${KIT}; the policy document is parsed by the kit's shared parser (ADR-0056 §11)`);
  if (calls === 0) problems.push(`${at}: never calls parseCallerPolicy; the policy document must be parsed by the kit's shared parser (ADR-0056 §11)`);
  else if (!bound) problems.push(`${at}: no parseCallerPolicy call is bound to ${variable} (its spec must carry variable: '${variable}')`);
  for (const parser of parsers) {
    problems.push(`${at}: calls ${parser}; a governed caller-policy module must not parse the policy document itself (the kit's parser refuses duplicate keys and unknown properties)`);
  }
  return problems;
}

/** The inventory as a whole: `files` maps each governed path to its text, or undefined when the file is missing. */
export function checkCallerPolicyInventory(files) {
  const problems = [];
  for (const [relPath, variable] of Object.entries(CALLER_POLICY_MODULES)) {
    const text = files[relPath];
    if (text === undefined) problems.push(`${relPath} (the governed caller-policy module for ${variable}) is missing; update CALLER_POLICY_MODULES if it moved`);
    else problems.push(...checkCallerPolicyModule(relPath, text, variable));
  }
  return problems;
}

/** V2 A1.4: workspace package name → application directory, read from each `apps/<dir>/package.json` (never a naming convention). */
export function workspaceAppPackages(manifests) {
  const packages = new Map();
  for (const [dir, text] of Object.entries(manifests)) {
    const name = JSON.parse(text).name;
    if (typeof name === 'string' && name !== '') packages.set(name, dir);
  }
  return packages;
}

const bareName = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-z]+:/.test(spec)) return undefined; // relative, absolute, node: / file: …
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};
/** The application a module specifier reaches into, if any: an `apps/<x>/` path, a relative `../<x>-service` path, or a workspace package. */
const targetApp = (spec, appPackages) =>
  /(?:^|\/)apps\/([a-z-]+)\//.exec(spec)?.[1] ?? /^(?:\.\.\/)+([a-z-]+-service)\b/.exec(spec)?.[1] ?? appPackages?.get(bareName(spec) ?? '');

/**
 * No product concepts in Core services or the kit; no financial-domain declarations in the kit; no cross-service source imports and no
 * library → application import (V2 A1.4: every module-loading form, from the shared syntax-aware pass; `appPackages` from
 * `workspaceAppPackages` adds the bare workspace-package form); every caller-policy consumer governed (A1.4).
 */
export function checkSource(relPath, text, { appPackages } = {}) {
  const problems = [];
  if (BIDI_CONTROL.test(text) && !BIDI_ALLOWLIST.has(relPath)) problems.push(`${relPath}: contains an invisible bidirectional control character (write it as an escape)`);
  const inKit = relPath.startsWith('libs/service-kit/');
  // V2 A15.4 / A4.5: every application under apps/ is in scope (a new service enters it automatically), Auth included; only the reviewed
  // historical migration lines are set aside.
  const coreApp = /^apps\/([a-z0-9-]+)\/(?:src|db\/migrations)\//.exec(relPath)?.[1];
  const inNewCore = coreApp !== undefined || relPath.startsWith('libs/audit-contract/');
  if ((inKit || inNewCore) && PRODUCT_TERMS.test(identifierWords(historicalLinesRemoved(relPath, text)))) problems.push(`${relPath}: contains a product-specific term (Core must stay generic)`);
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
  const regexSpecifiers = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of regexSpecifiers) problems.push(...checkAuditContractDirection(relPath, spec)); // unchanged since Stage 19
  const facts = PARSED.test(relPath) && !relPath.endsWith('.d.ts') ? sourceFacts(relPath, text) : undefined;
  for (const spec of new Set(facts ? facts.specifiers : regexSpecifiers)) {
    const other = targetApp(spec, appPackages);
    if (!other || other === app) continue;
    problems.push(app
      ? `${relPath}: imports another service's source (${spec}); services talk over APIs and events only`
      : `${relPath}: a shared library imports application source (${spec}); libraries never depend on an application (ADR-0056)`);
  }
  if (facts) problems.push(...checkMetricsClientImport(relPath, text, facts.specifiers));
  const isTest = /(^|\/)test\//.test(relPath) || /\.(e2e-|int-)?spec\.ts$/.test(relPath);
  if (facts && app && relPath.startsWith(`apps/${app}/src/`) && !isTest && !CALLER_POLICY_APPS.has(app) && (facts.usesCallerPolicy || facts.policyReads.length > 0)) {
    const what = facts.usesCallerPolicy ? 'uses parseCallerPolicy' : `reads ${facts.policyReads[0]}`;
    problems.push(`${relPath}: ${what}, but ${app} has no governed caller-policy module; add it to CALLER_POLICY_MODULES (scripts/lib/checks.mjs, V2 A1.4)`);
  }
  // V2 A2.5: the process environment is read once, at the configuration boundary (the service loader) and by command-line tools.
  if (facts?.readsProcessEnv && /^(?:apps|libs)\/[a-z-]+\/src\//.test(relPath) && !isTest && !PROCESS_ENV_BOUNDARY.some((allowed) => allowed.test(relPath))) {
    problems.push(`${relPath}: reads process.env directly; configuration is read once by the service configuration loader (src/config/*-config.ts) and reaches the rest of the service as a typed value`);
  }
  return problems;
}

/**
 * V2 A2.5: where non-test source may reach `process.env`: each service's configuration loader, the kit's base loader, and the
 * command-line tools of a service or of the kit (their convergence belongs to A15, A4 and A5, not to this guard).
 */
export const PROCESS_ENV_BOUNDARY = [
  /^apps\/[a-z-]+\/src\/config\/[a-z-]+-config\.ts$/,
  /^libs\/service-kit\/src\/config\/base-config\.ts$/,
  /^apps\/[a-z-]+\/src\/cli\//,
  /^libs\/service-kit\/src\/cli\//,
];

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

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A2.5: configuration and secret hygiene guards. Every diagnostic names a path, a variable or a rule and NEVER a value: a template
// value, a decoded key and a fingerprint are all kept out of the messages.
// ---------------------------------------------------------------------------------------------------------------------------------

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
/** The only environment-like file that may be committed: a development template. */
export const ENV_TEMPLATE = '.env.example';
export const isEnvTemplate = (path) => baseName(path) === ENV_TEMPLATE;

/** Paths a correct `.gitignore` ignores (a real or local environment file, at the root or in a package) and keeps trackable (the templates). */
export const ENV_PATHS_IGNORED = ['.env', '.env.local', '.env.production', 'apps/auth-service/.env', 'apps/auth-service/.env.local'];
export const ENV_PATHS_TRACKABLE = ['.env.example', 'apps/auth-service/.env.example'];

/**
 * The behaviour of `.gitignore`, not its text: `isIgnored(path)` answers with Git's own evaluation of the rules (true, false, or
 * undefined when Git could not answer). Any spelling of the rules that keeps the behaviour passes.
 */
export function checkEnvIgnorePolicy(isIgnored) {
  const problems = [];
  for (const [paths, expected] of [[ENV_PATHS_IGNORED, true], [ENV_PATHS_TRACKABLE, false]]) {
    for (const path of paths) {
      const ignored = isIgnored(path);
      if (ignored === undefined) problems.push(`.gitignore: Git could not evaluate the ignore rules for ${path} (git check-ignore failed); the environment ignore policy cannot be verified`);
      else if (ignored !== expected) {
        problems.push(expected
          ? `.gitignore no longer ignores ${path}: a real environment file could be committed (expected rules: .env, .env.*, !.env.example)`
          : `.gitignore ignores ${path}: the committed development templates must stay trackable (expected rule: !.env.example)`);
      }
    }
  }
  return problems;
}

const git = (cwd, args) => spawnSync('git', ['-c', 'core.excludesFile=', ...args], { cwd, encoding: 'utf8' });
/**
 * The Git-backed `isIgnored` of the runner (and of the tests, on a fixture directory): `git check-ignore --no-index` judges a path by
 * the ignore rules alone, so a tracked template answers correctly. A user-level excludes file is switched off: only the repository's
 * rules count. Exit 0 = ignored, 1 = not ignored, anything else = Git could not answer.
 */
export function gitIgnoreProbe(cwd) {
  return (path) => {
    const status = git(cwd, ['check-ignore', '--no-index', '-q', '--', path]).status;
    return status === 0 ? true : status === 1 ? false : undefined;
  };
}
/** The files Git tracks under `cwd` (the index, not the disk: an ignored local `.env` is not one), or undefined when Git could not answer. */
export function gitTrackedFiles(cwd) {
  const result = git(cwd, ['ls-files', '-z']);
  return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : undefined;
}

/**
 * No tracked environment file except the templates: a basename `.env`, `.env.<anything>` or `<anything>.env` (`prod.env`,
 * `secrets.env`) is refused wherever it is; `.env.example` is the one name allowed. The content is not read: this is not a scanner.
 */
/**
 * Core V2 M2 T7: drone-ssh reads `host` from a `.host` file in its working directory (the checkout) when no variable sets it; no such
 * file, nor a `.port`, may be committed anywhere, so no repository content can choose a production SSH destination.
 */
export function checkDroneSshFiles(trackedPaths) {
  if (trackedPaths === undefined) return ['Git could not list the tracked files (git ls-files failed); the drone-ssh destination-file guard cannot run'];
  return trackedPaths
    .filter((path) => ['.host', '.port'].includes(baseName(path)))
    .map((path) => `${path} is tracked: drone-ssh (the production SSH client) can read its destination from such a file; remove it`);
}

export function checkTrackedEnvFiles(trackedPaths) {
  if (trackedPaths === undefined) return ['Git could not list the tracked files (git ls-files failed); the tracked environment-file guard cannot run'];
  return trackedPaths
    .filter((path) => { const name = baseName(path); return name !== ENV_TEMPLATE && (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')); })
    .map((path) => `${path} is tracked: only ${ENV_TEMPLATE} templates may be committed (remove it from the index; a real environment file never enters the repository)`);
}

/**
 * The active assignments of an environment template, in order: `NAME=value` lines (an optional `export`), comments and blank lines
 * skipped. A quoted value is taken up to its closing quote; an unquoted one ends at an inline `#` comment and is trimmed.
 */
export function envAssignments(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = /^(['"])(.*?)\1/.exec(raw);
    out.push({ name: m[1], value: quoted ? quoted[2] : raw.replace(/(^|\s)#.*$/, '').trim() });
  }
  return out;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** Standard, canonical base64 (as the kit's `decodeKey` reads it), or undefined. */
function canonicalBase64(text) {
  const m = /^([A-Za-z0-9+/]+)(={0,2})$/.exec(text);
  if (!m || m[1].length % 4 === 1 || (m[2] !== '' && (m[1].length + m[2].length) % 4 !== 0)) return undefined;
  const bytes = Buffer.from(m[1], 'base64');
  return bytes.toString('base64').replace(/=+$/, '') === m[1] ? bytes : undefined;
}
const KEY_ID_PREFIX = /^[A-Za-z0-9_-]{1,32}:/; // a key-ring or caller entry: "id:material"
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43,}$/; // a generated service token: 32 or more random bytes, base64url
const looksGenerated = (text) => /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text);
/**
 * The catalog fingerprints one template value may match, by SHAPE (never by variable name). A value is one secret or a list of
 * `id:secret` entries. A 64-hex entry is a published token digest: it is itself a fingerprint. Canonical base64 of 32 bytes or more is
 * key material (fingerprint of the decoded bytes, or of the text when it is used as a textual secret). A base64url string of 43
 * characters or more that looks generated is a service token (fingerprint of its text). Anything else is not a published secret here.
 */
function publishedSecretFingerprints(value) {
  const secrets = [];
  for (const entry of value.split(',')) {
    const text = entry.trim().replace(KEY_ID_PREFIX, '').trim();
    if (/^[0-9a-f]{64}$/.test(text)) { secrets.push([text]); continue; }
    const key = canonicalBase64(text);
    if (key && key.length >= 32) secrets.push([sha256(key), sha256(Buffer.from(text, 'utf8'))]);
    else if (TOKEN_SHAPE.test(text) && looksGenerated(text)) secrets.push([sha256(Buffer.from(text, 'utf8'))]);
  }
  return secrets;
}

export const DEVELOPMENT_SECRET_CATALOG = 'libs/service-kit/src/config/development-keys.ts';
/** The catalog as written in the kit: fingerprint → the runtime variable it names. Read as text; the checker repeats no fingerprint. */
export function developmentSecretCatalog(catalogText) {
  return new Map([...String(catalogText ?? '').matchAll(/\[\s*'([0-9a-f]{64})'\s*,\s*'([A-Za-z0-9_]+)'\s*\]/g)].map((m) => [m[1], m[2]]));
}

/**
 * The published development secrets and the kit's fingerprint catalog are the SAME SET, in both directions (OD-A2.5-3), whatever its
 * size. `templates` maps each tracked `.env.example` to its text.
 * - Every secret-shaped value of a template is in the catalog: otherwise production would accept a secret this repository publishes.
 * - Every catalog fingerprint matches a template value: otherwise the catalog refuses, and documents, a secret nobody publishes.
 * Adding or removing a development secret therefore changes a template and the catalog together.
 */
export function checkDevelopmentSecretCatalog(templates, catalogText) {
  const catalog = developmentSecretCatalog(catalogText);
  if (catalog.size === 0) return [`${DEVELOPMENT_SECRET_CATALOG}: no development-secret fingerprint could be read; the catalog guard cannot run (update developmentSecretCatalog if its form changed)`];
  const problems = [];
  const matched = new Set();
  for (const [path, text] of Object.entries(templates)) {
    for (const { name, value } of envAssignments(text)) {
      for (const candidates of publishedSecretFingerprints(value)) {
        const hit = candidates.find((fingerprint) => catalog.has(fingerprint));
        if (hit) matched.add(hit);
        else problems.push(`${path}: ${name} is published development secret material that is not in the development-secret catalog (${DEVELOPMENT_SECRET_CATALOG}); production would accept it. Add its fingerprint, or do not publish it`);
      }
    }
  }
  for (const [fingerprint, label] of catalog) {
    if (!matched.has(fingerprint)) problems.push(`${DEVELOPMENT_SECRET_CATALOG}: the catalog entry for ${label} matches no value of a tracked ${ENV_TEMPLATE}; remove the entry or restore the published value`);
  }
  return problems;
}

/**
 * Every tracked template opens with a comment block that says it is for development only (any wording containing "development only").
 * The root template is the local Compose template: each variable it sets is consumed by a Compose file (`composeTexts`: path → text).
 * The reverse is not required (Compose may default a variable), and service templates are not matched against their loaders.
 */
export function checkEnvTemplates(templates, composeTexts) {
  const problems = [];
  for (const [path, text] of Object.entries(templates)) {
    const lines = String(text).split(/\r?\n/);
    const end = lines.findIndex((l) => !l.trim().startsWith('#'));
    const header = (end < 0 ? lines : lines.slice(0, end)).join('\n');
    if (!/development[- ]only/i.test(header)) problems.push(`${path}: must open with a comment that says the template is for development only`);
  }
  const root = templates[ENV_TEMPLATE];
  if (root === undefined) return [...problems, `${ENV_TEMPLATE} (the root local-development template) is missing or not tracked`];
  const compose = Object.values(composeTexts).join('\n');
  for (const { name } of envAssignments(root)) {
    if (!new RegExp(`\\$(?:\\{${name}\\b|${name}\\b)`).test(compose)) {
      problems.push(`${ENV_TEMPLATE}: ${name} is not referenced by any Compose file (${Object.keys(composeTexts).join(', ')}); remove it or reference it`);
    }
  }
  return problems;
}

/**
 * Whether a `.dockerignore` keeps `path` out of the build context, with Docker's documented rules: `**` matches any number of
 * directories (including none), `*` any run without a separator, `?` one such character; `!` re-includes; the LAST matching rule
 * wins; a rule matching a directory covers everything under it. No Docker daemon.
 */
export function dockerIgnoreExcludes(text, path) {
  let excluded = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const rule = line.trim();
    if (rule === '' || rule.startsWith('#')) continue;
    const negate = rule.startsWith('!');
    const pattern = rule.replace(/^!/, '').trim().replace(/^\/+|\/+$/g, '');
    if (pattern === '') continue;
    const body = pattern.split('/').map((segment) => (segment === '**' ? '(?:.*/)?'
      : `${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}/`)).join('').replace(/\/$/, '');
    if (new RegExp(`^${body}(?:/.*)?$`).test(path)) excluded = !negate;
  }
  return excluded;
}
export const DOCKER_CONTEXT_EXCLUDED = ['.env', '.env.local', 'apps/auth-service/.env', 'apps/auth-service/.env.local', 'libs/service-kit/.env'];
export const DOCKER_CONTEXT_REQUIRED = ['package.json', 'apps/auth-service/src/main.ts', 'apps/auth-service/deploy/provision-and-deploy.sh'];
/** No environment file enters an image build context (a build-stage layer would keep it); what a build needs stays in it. */
export function checkDockerContext(dockerignoreText) {
  if (dockerignoreText === undefined) return ['.dockerignore is missing: environment files would enter every image build context'];
  return [
    ...DOCKER_CONTEXT_EXCLUDED.filter((path) => !dockerIgnoreExcludes(dockerignoreText, path))
      .map((path) => `.dockerignore lets ${path} into the build context (expected rules: **/.env and **/.env.*, with no later rule re-including it)`),
    ...DOCKER_CONTEXT_REQUIRED.filter((path) => dockerIgnoreExcludes(dockerignoreText, path))
      .map((path) => `.dockerignore excludes ${path}, which an image build needs: an environment rule is too broad`),
  ];
}

const mentions = (text, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text);
/**
 * High-confidence README coverage (OD-A2.5-1 = B): every LITERAL variable name a service's own source reads (`sourceFacts`'s
 * `configNames`, over `sources`: path → text of its non-test `src` files outside `src/cli`) appears in the service README. Computed
 * names, the kit's own base variables (read in the kit, documented as groups) and command-line tools are outside it by construction;
 * the reverse direction is not enforced (a README legitimately names other services' variables).
 */
export function checkReadmeEnvironmentCoverage(app, readmeText, sources) {
  const readme = `apps/${app}/README.md`;
  if (readmeText === undefined) return [`${readme} is missing: ${app} has no environment reference`];
  const readBy = new Map();
  for (const [path, text] of Object.entries(sources)) {
    for (const name of sourceFacts(path, text).configNames) if (!readBy.has(name)) readBy.set(name, path);
  }
  if (readBy.size === 0) return [`apps/${app}: no literal configuration read was found in its source; the README coverage guard cannot run (update sourceFacts if the loader changed form)`];
  return [...readBy].filter(([name]) => !mentions(readmeText, name))
    .map(([name, path]) => `${readme} does not document ${name}, which ${path} reads`);
}
/** The source files the README coverage reads: a service's non-test `src` TypeScript outside its command-line tools. */
export const isServiceConfigSource = (app, relPath) => relPath.startsWith(`apps/${app}/src/`) && !relPath.startsWith(`apps/${app}/src/cli/`)
  && /\.ts$/.test(relPath) && !relPath.endsWith('.d.ts') && !/(^|\/)test\//.test(relPath) && !/\.(e2e-|int-)?spec\.ts$/.test(relPath);

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.1: the operator CLIs that read their configuration through the kit's EnvReader stay on it.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The generic operator CLIs migrated by A15.1. Each reads its settings through `new EnvReader(process.env)` (surrounding whitespace
 * removed, `NAME` or `NAME_FILE`, both together refused, value-free errors) and reaches the process environment in no other way.
 * The path allowlist (`PROCESS_ENV_BOUNDARY`) still admits every CLI directory. V2 A4.3 added Auth's migration CLI; Auth's `main.ts` is
 * not listed (it hands an environment copy to the service loader and reads the bootstrap password byte for byte, OD-A4.3-1), nor is the
 * Organization ownership CLI (A5 / F6 / F7).
 */
export const ENV_READER_CLIS = [
  'libs/service-kit/src/cli/migrate.ts',
  'libs/service-kit/src/cli/dlq.ts',
  'libs/service-kit/src/cli/check-dlq-depth.ts',
  'libs/service-kit/src/cli/check-outbox-lag.ts',
  'libs/service-kit/src/cli/outbox-retention.ts',
  'apps/notification-service/src/cli/secret-keys.ts',
  'apps/audit-service/src/cli/retention.ts',
  'apps/payment-service/src/cli/reemission-dry-run.ts',
  'apps/auth-service/src/cli/migrate.ts',
];
/** The kit CLIs' shared resolvers: they take a reader and never reach the process environment themselves. */
export const ENV_READER_CLI_RESOLVERS = 'libs/service-kit/src/cli/cli-config.ts';

/** `files` maps each listed path (and the resolvers' path) to its text, or undefined when the file is missing. */
export function checkEnvReaderClis(files) {
  const problems = [];
  const resolvers = files[ENV_READER_CLI_RESOLVERS];
  if (resolvers === undefined) problems.push(`${ENV_READER_CLI_RESOLVERS} (the operator CLIs' configuration resolvers) is missing; update ENV_READER_CLI_RESOLVERS if it moved`);
  else if (sourceFacts(ENV_READER_CLI_RESOLVERS, resolvers).readsProcessEnv) {
    problems.push(`${ENV_READER_CLI_RESOLVERS}: reads process.env; the resolvers read only through the EnvReader they are given (V2 A15.1)`);
  }
  for (const relPath of ENV_READER_CLIS) {
    const text = files[relPath];
    if (text === undefined) { problems.push(`${relPath} (an operator CLI that reads its configuration through EnvReader) is missing; update ENV_READER_CLIS if it moved`); continue; }
    const facts = sourceFacts(relPath, text);
    if (facts.directEnvUses > 0) {
      problems.push(`${relPath}: reads process.env directly; this operator CLI reads its configuration through the kit's EnvReader (new EnvReader(process.env)), which gives NAME_FILE, trimming and the NAME + NAME_FILE refusal (V2 A15.1)`);
    } else if (facts.envReaderUses === 0) {
      problems.push(`${relPath}: does not read its configuration through new EnvReader(process.env); update ENV_READER_CLIS (scripts/lib/checks.mjs) only if the CLI no longer reads the environment (V2 A15.1)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.2: one Node major for developers, CI and the images.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The major of a Node version declaration (`22`, `22.x`, `v22.4.1`, `^22.12.0`, `~22.1`), or undefined when it is not a single major. */
export function nodeMajor(declaration) {
  const m = /^[v^~]?(\d+)(?:\.(?:x|\d+)){0,2}$/.exec(String(declaration ?? '').trim());
  return m ? Number(m[1]) : undefined;
}

/**
 * The Node major is declared in four places, and a developer, CI and the images must run the same one: `.nvmrc` (the reference),
 * the root `package.json` `engines.node`, every Node version of Core CI (`NODE_VERSION` and any literal `node-version`), and the base
 * image of every application Dockerfile (`FROM node:<major>…`). `dockerfiles` maps a path to its text. Advisory for developers (npm
 * only warns on another major); the point of the guard is that the four cannot drift apart silently.
 */
export function checkNodeToolchain({ nvmrc, packageJson, ciText, dockerfiles }) {
  const expected = nodeMajor(nvmrc);
  if (expected === undefined) return ['.nvmrc is missing or does not name one Node major (for example "22"); the Node toolchain cannot be checked'];
  const problems = [];
  const mismatch = (where, declared) => {
    const major = nodeMajor(declared);
    if (major === undefined) problems.push(`${where} does not name one Node major (got "${declared ?? 'nothing'}"); .nvmrc says ${expected}`);
    else if (major !== expected) problems.push(`${where} says Node ${major}, but .nvmrc says ${expected}: developers, CI and the images must use the same Node major`);
  };
  let engines;
  try { engines = JSON.parse(packageJson ?? '').engines?.node; } catch { engines = undefined; }
  mismatch('package.json engines.node', engines);

  const ci = parse(ciText ?? '');
  const versions = [];
  if (ci?.env?.NODE_VERSION !== undefined) versions.push(['core-ci.yml NODE_VERSION', String(ci.env.NODE_VERSION)]);
  for (const [jobId, job] of Object.entries(ci?.jobs ?? {})) {
    if (job?.env?.NODE_VERSION !== undefined) versions.push([`core-ci.yml job "${jobId}" NODE_VERSION`, String(job.env.NODE_VERSION)]);
    for (const step of asArray(job?.steps)) {
      const v = step?.with?.['node-version'];
      if (v !== undefined && !String(v).includes('${{')) versions.push([`core-ci.yml job "${jobId}" node-version`, String(v)]);
    }
  }
  if (versions.length === 0) problems.push('core-ci.yml declares no Node version (NODE_VERSION or a literal node-version); the CI Node major cannot be checked');
  for (const [where, declared] of versions) mismatch(where, declared);

  const files = Object.entries(dockerfiles ?? {});
  if (files.length === 0) problems.push('no application Dockerfile was found; the image Node major cannot be checked');
  for (const [path, text] of files) {
    const images = String(text).split('\n').filter((l) => /^FROM\s/i.test(l)).map((l) => l.trim().split(/\s+/)[1] ?? '');
    for (const image of new Set(images)) { // one finding per distinct base image of a file (build and runtime stages usually share it)
      const m = /^node:([^@\s]+)/.exec(image);
      if (!m) { problems.push(`${path}: base image ${image.split('@')[0]} is not a Node image; the image Node major cannot be checked`); continue; }
      mismatch(`${path} (FROM node:${m[1]})`, m[1].split('-')[0]);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// V2 A15.4: a new workspace cannot silently miss Core CI.
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Every application and library workspace (`apps/*`, `libs/*`, by package name) has an entry in Core CI's per-workspace matrix (job
 * `node`: lint, typecheck, unit tests, build and its integration suite), and every application with a Dockerfile has one in the image
 * smoke matrix (job `images`: build the image and boot it with a production-shaped configuration). This is CI coverage only: it never
 * asks for an image publishing or deployment workflow, which only a production-bound service gets, by separate owner-authorized work.
 * The `test/*` packages are not per-workspace jobs: each is run by its own cross-service job.
 */
export function checkCiWorkspaceCoverage(ciText, { workspaces, imageApps }) {
  const doc = parse(ciText ?? '');
  const node = asArray(doc?.jobs?.node?.strategy?.matrix?.include).map((e) => String(e?.workspace ?? ''));
  const images = asArray(doc?.jobs?.images?.strategy?.matrix?.service).map(String);
  const problems = [];
  if (node.length === 0) problems.push('core-ci.yml: job "node" has no matrix.include workspaces; the per-workspace coverage cannot be checked');
  if (images.length === 0) problems.push('core-ci.yml: job "images" has no matrix.service list; the image smoke coverage cannot be checked');
  if (problems.length > 0) return problems;
  for (const ws of workspaces) {
    if (!node.includes(ws)) problems.push(`core-ci.yml: workspace ${ws} is not in the "node" matrix: CI would never lint, type-check, test or build it (add it; see docs/NEW-SERVICE-CHECKLIST.md)`);
  }
  for (const app of imageApps) {
    if (!images.includes(app)) problems.push(`core-ci.yml: apps/${app} has a Dockerfile but is not in the "images" matrix: CI would never build or boot its image (add it, and its case in scripts/smoke-core-image.sh)`);
  }
  return problems;
}

/**
 * V2 A3M.2 (ADR-0057 §11, Proposed; A3M record §11): the per-service event contracts (`apps/<app>/contracts/events.json`, each the
 * rendering of the service's own `src/events/event-catalog.ts`, kept equal by that service's unit test). Read as JSON only: no
 * application source is imported or parsed. Checks:
 * - grammar: event names as the kit's `EVENT_NAME`, never `audit.*` (audit events are governed by `@nawara/audit-contract`), versions
 *   positive integers, fields typed from a closed set, `enum` with its values, flags only `true`;
 * - ownership: one producer per event name; `codeBearing` (a one-time code in the payload, ADR-0052 decision 5) only from auth-service;
 * - consumers: every consumed `(source, name, version)` is published by that source at that version, and every required field is
 *   declared there with a compatible type, not nullable or optional unless the consumer accepts it;
 * - registration: every application whose source writes to the outbox (`outbox.enqueue(`) or subscribes to the bus (`.subscribe({`)
 *   has a contract file, except the named exemption.
 * Limits: registration is a presence scan of source text, not a proof that every emit site is cataloged; emit sites are bound to their
 * catalog by each producer's compile-time typing (Auth's `DomainEvents.emit`, Payment's `PaymentEventName`) and builder tests.
 */
export const EVENT_CONTRACT_EXEMPT = new Map([['audit-service', 'consumes only audit.* events, governed by @nawara/audit-contract (ADR-0049)']]);
const CONTRACT_EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const CONTRACT_FIELD_TYPES = new Set(['id', 'uuid', 'string', 'datetime', 'integer', 'object', 'array', 'enum']);
const CODE_BEARING_PRODUCER = 'auth-service';
const EVENT_TRAFFIC = [/\boutbox\.enqueue\(/, /\.subscribe\(\{/];

/** Whether an application's (non-test) source text writes events to the outbox or subscribes to the bus. */
export function usesEventTraffic(sourceTexts) {
  return sourceTexts.some((text) => EVENT_TRAFFIC.some((re) => re.test(text)));
}

function contractFieldProblems(where, fields) {
  const problems = [];
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) return [`${where}: the payload must declare at least one field`];
  for (const [name, f] of Object.entries(fields)) {
    const at = `${where}.${name}`;
    if (f === null || typeof f !== 'object' || !CONTRACT_FIELD_TYPES.has(f.type)) { problems.push(`${at}: type must be one of ${[...CONTRACT_FIELD_TYPES].join(', ')}`); continue; }
    if (f.type === 'enum' && (!Array.isArray(f.values) || f.values.length === 0 || !f.values.every((v) => typeof v === 'string'))) problems.push(`${at}: an enum must list its string values`);
    if (f.type !== 'enum' && f.values !== undefined) problems.push(`${at}: only an enum has values`);
    for (const flag of ['nullable', 'optional']) if (f[flag] !== undefined && f[flag] !== true) problems.push(`${at}: ${flag} is either absent or true`);
    for (const k of Object.keys(f)) if (!['type', 'values', 'nullable', 'optional'].includes(k)) problems.push(`${at}: unknown key "${k}"`);
  }
  return problems;
}

/** Why a producer field cannot satisfy a consumer requirement, or undefined when it can. */
function incompatibility(required, produced) {
  if (produced === undefined) return 'is not declared by the producer';
  if (produced.nullable && !required.nullable) return 'may be null at the producer but the consumer requires a value';
  if (produced.optional && !required.optional) return 'may be absent at the producer but the consumer requires it';
  const r = required.type;
  const p = produced.type;
  if (r === p && r !== 'enum') return undefined;
  if (r === 'id' && p === 'uuid') return undefined;
  if (r === 'string' && ['string', 'id', 'uuid', 'datetime', 'enum'].includes(p)) return undefined;
  if (r === 'enum' && p === 'enum') {
    const extra = (produced.values ?? []).filter((v) => !(required.values ?? []).includes(v));
    return extra.length === 0 ? undefined : `may be ${extra.join(', ')}, which the consumer does not accept`;
  }
  return `is a ${p} at the producer but the consumer requires a ${r}`;
}

/**
 * `contracts`: application directory -> the text of its contracts/events.json (undefined when absent). `required`: the applications whose
 * source has event traffic (`usesEventTraffic`).
 */
export function checkEventContracts(contracts, required) {
  const problems = [];
  const file = (app) => `apps/${app}/contracts/events.json`;
  const parsed = new Map();
  for (const app of required) {
    if (EVENT_CONTRACT_EXEMPT.has(app)) continue;
    if (contracts[app] === undefined) problems.push(`${file(app)} is missing: apps/${app} publishes or consumes events, so it declares them (src/events/event-catalog.ts, ADR-0057 §11)`);
  }
  for (const [app, text] of Object.entries(contracts)) {
    if (text === undefined) continue;
    let c;
    try { c = JSON.parse(text); } catch (e) { problems.push(`${file(app)}: not valid JSON (${e.message})`); continue; }
    if (c?.service !== app) problems.push(`${file(app)}: "service" must be "${app}"`);
    if (!Array.isArray(c?.produces) || !Array.isArray(c?.consumes)) { problems.push(`${file(app)}: "produces" and "consumes" must be arrays`); continue; }
    parsed.set(app, c);
  }
  const producers = new Map();
  for (const [app, c] of parsed) {
    for (const [i, e] of c.produces.entries()) {
      const at = `${file(app)}: produces[${i}] ${e?.name ?? '?'}`;
      if (typeof e?.name !== 'string' || !CONTRACT_EVENT_NAME.test(e.name)) { problems.push(`${at}: the name must be dotted lowercase (the kit's EVENT_NAME)`); continue; }
      if (e.name.startsWith('audit.')) problems.push(`${at}: audit events are governed by @nawara/audit-contract, never declared here`);
      if (!Number.isSafeInteger(e.version) || e.version < 1) problems.push(`${at}: the version must be a positive integer`);
      if (e.codeBearing !== undefined && e.codeBearing !== true) problems.push(`${at}: codeBearing is either absent or true`);
      if (e.codeBearing === true && app !== CODE_BEARING_PRODUCER) problems.push(`${at}: only ${CODE_BEARING_PRODUCER} may publish a code-bearing event (ADR-0052 decision 5)`);
      problems.push(...contractFieldProblems(`${at} payload`, e.payload));
      if (producers.has(e.name)) problems.push(`${at}: already published by ${producers.get(e.name).app}: an event has exactly one producer`);
      else producers.set(e.name, { app, event: e });
    }
  }
  for (const [app, c] of parsed) {
    const seen = new Set();
    for (const [i, e] of c.consumes.entries()) {
      const at = `${file(app)}: consumes[${i}] ${e?.source ?? '?'} ${e?.name ?? '?'}`;
      const key = `${e?.source}|${e?.name}|${e?.version}`;
      if (seen.has(key)) problems.push(`${at}: declared twice`);
      seen.add(key);
      if (typeof e?.name !== 'string' || !CONTRACT_EVENT_NAME.test(e.name)) { problems.push(`${at}: the name must be dotted lowercase (the kit's EVENT_NAME)`); continue; }
      if (e.name.startsWith('audit.')) { problems.push(`${at}: audit events are governed by @nawara/audit-contract, never declared here`); continue; }
      if (!Number.isSafeInteger(e.version) || e.version < 1) problems.push(`${at}: the version must be a positive integer`);
      const fieldProblems = contractFieldProblems(`${at} requires`, e.requires);
      problems.push(...fieldProblems);
      const producer = producers.get(e.name);
      if (producer === undefined || producer.app !== e.source) { problems.push(`${at}: ${e.source} publishes no event named ${e.name}`); continue; }
      if (producer.event.version !== e.version) { problems.push(`${at}: ${e.source} publishes ${e.name} at version ${producer.event.version}, not ${e.version}`); continue; }
      if (fieldProblems.length > 0) continue;
      for (const [name, req] of Object.entries(e.requires)) {
        const why = incompatibility(req, producer.event.payload?.[name]);
        if (why) problems.push(`${at}: the required field ${name} ${why}`);
      }
    }
  }
  return problems;
}

/**
 * V2 A3M.5 (A3M record §14): the manual outbox retention deletes only rows of a service on the kit's reviewed list
 * (`OUTBOX_RETENTION_VERIFIED_SERVICES`), and only rows with a random id. A random id is safe to delete only because the OUTBOX generated
 * it: a producer that supplies or derives its event id relies on the outbox row to write a repeated operation's event once. This guard
 * keeps the list honest:
 * - the kit's list is exactly the approved one here (adding a service is a reviewed change in both places);
 * - the CLI requires `--service`, checks it against that list and has no option that widens the scope;
 * - an approved service's (non-test) source never derives an event id (`deterministicEventId`) and never supplies one: no `id` property in
 *   the event passed to `.enqueue(...)`, no `eventId` property built anywhere, no spread object at those calls.
 * Limits: this reads syntax. It is not a proof of every possible data flow: an `id` put into an event object that is built elsewhere and
 * passed to `.enqueue` in a variable is not seen. A producer that changes how it makes its
 * event ids needs a retention-safety review; the guard catches the direct forms, the review covers the rest.
 */
export const OUTBOX_RETENTION_APPROVED_SERVICES = ['auth-service', 'organization-service'];
const RETENTION_CORE = 'libs/service-kit/src/events/outbox-retention.ts';
const RETENTION_CLI = 'libs/service-kit/src/cli/outbox-retention.ts';
const RETENTION_BYPASS = /--all-services|--include-deterministic|--any-service|--force\b/;

/** The ways one source file supplies or derives an outbox event id, as short descriptions (empty when it does neither). */
export function outboxIdSources(relPath, text) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [];
  const at = (node) => `line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  const propertyNamed = (obj, name) => obj.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && p.name.getText(sf) === name);
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === 'deterministicEventId') found.push(`${at(node)}: uses deterministicEventId (a derived event id)`);
    // Anywhere, not only at the call: an options object built first and passed on is caught too.
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText(sf) === 'eventId') {
      found.push(`${at(node)}: builds an eventId (an event id supplied to the audit writer)`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        if (method === 'enqueue' && propertyNamed(arg, 'id')) found.push(`${at(arg)}: supplies an id to the outbox (.enqueue({ id }))`);
        if ((method === 'enqueue' || method === 'write') && arg.properties.some((p) => ts.isSpreadAssignment(p))) {
          found.push(`${at(arg)}: passes a spread object to .${method}(...); an id inside it cannot be ruled out`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * `kit`: { core, cli } source texts of the retention module and its CLI. `serviceSources`: approved service -> { relPath: text } of its
 * non-test source.
 */
export function checkOutboxRetentionEligibility(kit, serviceSources) {
  const problems = [];
  if (kit?.core === undefined || kit?.cli === undefined) return [`${RETENTION_CORE} or ${RETENTION_CLI} is missing; update the outbox retention guard if they moved`];
  const m = /OUTBOX_RETENTION_VERIFIED_SERVICES\s*=\s*\[([^\]]*)\]\s*as const/.exec(kit.core);
  const listed = m ? [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]) : undefined;
  if (listed === undefined) problems.push(`${RETENTION_CORE}: OUTBOX_RETENTION_VERIFIED_SERVICES must be a literal list (\`[...] as const\`) so the reviewed services can be read`);
  else if (listed.join('|') !== OUTBOX_RETENTION_APPROVED_SERVICES.join('|')) {
    problems.push(`${RETENTION_CORE}: OUTBOX_RETENTION_VERIFIED_SERVICES is [${listed.join(', ')}] but the approved list is [${OUTBOX_RETENTION_APPROVED_SERVICES.join(', ')}]: a service becomes eligible for outbox retention only after a retention-safety review (A3M record §14), recorded in both places`);
  }
  if (!/--service <name> is required/.test(kit.cli) || !/isRetentionService\(service\)/.test(kit.cli)) {
    problems.push(`${RETENTION_CLI}: must require --service and check it against OUTBOX_RETENTION_VERIFIED_SERVICES before opening a connection`);
  }
  if (!/retentionDatabaseOwner\(args\.service\)/.test(kit.cli)) problems.push(`${RETENTION_CLI}: must check that the database is owned by the role provisioned for --service (ADR-0032)`);
  const bypass = RETENTION_BYPASS.exec(kit.cli) ?? RETENTION_BYPASS.exec(kit.core);
  if (bypass) problems.push(`${RETENTION_CLI}: has an option that widens the retention scope (${bypass[0]}); none is allowed`);
  if (!/substring\(id::text from 15 for 1\) = '4'/.test(kit.core)) problems.push(`${RETENTION_CORE}: eligibility must stay restricted to random (version 4) ids`);
  for (const service of OUTBOX_RETENTION_APPROVED_SERVICES) {
    const sources = serviceSources?.[service];
    if (!sources || Object.keys(sources).length === 0) { problems.push(`apps/${service}/src was not found: an approved outbox-retention service must exist and be checked`); continue; }
    for (const [relPath, text] of Object.entries(sources)) {
      for (const why of outboxIdSources(relPath, text)) {
        problems.push(`${relPath}: ${why}. ${service} is approved for outbox retention because the outbox generates its event ids; a supplied or derived id needs a retention-safety review and the service's removal from the approved list first (A3M record §14)`);
      }
    }
  }
  return problems;
}

/**
 * Core V2 S1b (ADR-0057 §13.2): a consumer that opts into the kit's event provenance keeps an UNKEYED SHA-256 of every delivered body,
 * permanently. Over a body holding a low-entropy secret (a one-time code, ADR-0052 decision 5) that digest is an offline oracle for the
 * secret, which the producer purges and the consumer seals for exactly this reason. So the opt-in is an allowlist, each entry with the
 * basis on which its digests were reviewed:
 * - only a service on `EVENT_PROVENANCE_APPROVED_SERVICES` may name the provenance store or pass `provenance:` in its (non-test) source;
 *   adding one is a reviewed change here;
 * - `contract` (billing-service): the service has an event contract and consumes no event its producer's contract marks `codeBearing`;
 * - `audit-admission` (audit-service, Core V2 S1b-2, ADR-0057 §13.2 "Audit admission" / S0-C1): Audit has no event contract (its events
 *   are governed by `@nawara/audit-contract`), so its basis is the admission boundary, checked in its fixed files: the subscription that
 *   passes `provenance:` also passes `admission:` and `auditDeadLetterPolicy`; the admission calls `isCanonicalJsonBody`, then
 *   `mayRetainRefusedAuditBody`, then `validateAuditEvent` (canonical bytes, the Stage 18.8 screen, the full contract) and the consumer's
 *   hook goes through it; the dead-letter policy judges the raw bytes too; and the kit bus runs `admission` BEFORE provenance.
 * - `keyed-commitment` (notification-service, Core V2 S1b-3, ADR-0057 §13.2 "S0-C2"): Notification consumes Auth's code-bearing events, so
 *   its basis is the KEYED body commitment, checked in its fixed files (`keyedCommitmentProblems`): the intake subscription passes
 *   `keyedStore: new PgKeyedProvenanceStore(` and no unkeyed `store:`; the intake refuses to start without the provenance key ring; the
 *   configuration reads the dedicated ring and keeps it distinct from every other key; no Notification source or migration names an
 *   unkeyed body digest; and the kit's keyed store and keyed bus path never compute one.
 * - `contract` and `audit-admission` stay on the UNKEYED store (`store: new PgProvenanceStore(`, never `keyedStore`): a change of their mode
 *   is a reviewed change here.
 * Limits: a presence and order scan of source text, not a proof of every data flow; the real-broker suites prove the behaviour.
 */
export const EVENT_PROVENANCE_APPROVED = Object.freeze({ 'billing-service': 'contract', 'audit-service': 'audit-admission', 'notification-service': 'keyed-commitment' });
export const EVENT_PROVENANCE_APPROVED_SERVICES = Object.keys(EVENT_PROVENANCE_APPROVED);
const PROVENANCE_OPT_IN = /ProvenanceStore\b|\bprovenance\s*:/;
export const AUDIT_ADMISSION_FILES = Object.freeze({
  consumer: 'apps/audit-service/src/ingestion/audit-consumer.ts',
  ingestion: 'apps/audit-service/src/ingestion/ingestion.service.ts',
  admission: 'apps/audit-service/src/ingestion/admission.ts',
  deadLetterPolicy: 'apps/audit-service/src/ingestion/dead-letter-policy.ts',
});
export const KIT_EVENT_BUS = 'libs/service-kit/src/events/rabbitmq-event-bus.ts';
export const KIT_PROVENANCE = 'libs/service-kit/src/events/provenance.ts';
export const NOTIFICATION_KEYED_FILES = Object.freeze({
  consumer: 'apps/notification-service/src/intake/event-consumer.ts',
  config: 'apps/notification-service/src/config/notification-config.ts',
  migration: 'apps/notification-service/db/migrations/0003_event_provenance.sql',
  comparisonMigration: 'apps/notification-service/db/migrations/0004_provenance_conflict_comparison.sql',
});
const UNKEYED_DIGEST = /\bbodySha256\b|\bPgProvenanceStore\b|\bevaluateProvenance\(/;

/** The text of the function `name` in `text` (from its declaration to the next top-level declaration), or undefined. */
function functionBody(text, name) {
  const at = text.search(new RegExp(`(^|\\n)(export )?function ${name}\\(`));
  if (at < 0) return undefined;
  const rest = text.slice(at + 1);
  const next = rest.search(/\n(export |function |const |class |\/\*\*)/);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Whether every one of `needles` occurs in `text`, in this order. */
function inOrder(text, needles) {
  let from = 0;
  for (const n of needles) {
    const i = text.indexOf(n, from);
    if (i < 0) return false;
    from = i + n.length;
  }
  return true;
}

/** Core V2 S1b-2: the Audit admission boundary in its fixed files (see above). `files`: relPath -> text (undefined when absent). */
export function auditAdmissionProblems(files) {
  const problems = [];
  const why = 'Audit keeps event provenance only behind its admission boundary (ADR-0057 §13.2 "Audit admission")';
  const consumer = files[AUDIT_ADMISSION_FILES.consumer];
  const subscribe = consumer === undefined ? undefined : consumer.slice(consumer.indexOf('.subscribe({'), consumer.indexOf('});', consumer.indexOf('.subscribe({')));
  if (subscribe === undefined || consumer.indexOf('.subscribe({') < 0 || !/\bprovenance\s*:/.test(subscribe)) {
    problems.push(`${AUDIT_ADMISSION_FILES.consumer}: the provenance subscription was not found where the guard reads it; ${why}`);
  } else {
    if (!/\badmission\s*:\s*\(e, body\) => this\.ingestion\.admit\(e, body\)/.test(subscribe)) problems.push(`${AUDIT_ADMISSION_FILES.consumer}: the subscription that passes \`provenance:\` must pass \`admission: (e, body) => this.ingestion.admit(e, body)\`; ${why}`);
    if (!/\bdeadLetterPolicy\s*:\s*auditDeadLetterPolicy\b/.test(subscribe)) problems.push(`${AUDIT_ADMISSION_FILES.consumer}: the subscription that passes \`provenance:\` must pass \`deadLetterPolicy: auditDeadLetterPolicy\`; ${why}`);
  }
  const ingestion = files[AUDIT_ADMISSION_FILES.ingestion] ?? '';
  const admitAt = ingestion.indexOf('\n  admit(');
  const admit = admitAt < 0 ? '' : ingestion.slice(admitAt, ingestion.indexOf('\n  }\n', admitAt));
  if (!admit.includes('auditAdmission(')) problems.push(`${AUDIT_ADMISSION_FILES.ingestion}: \`admit\` must decide through \`auditAdmission(\`; ${why}`);
  const admission = functionBody(files[AUDIT_ADMISSION_FILES.admission] ?? '', 'auditAdmission');
  const contract = functionBody(files[AUDIT_ADMISSION_FILES.admission] ?? '', 'contractRefusal');
  const ordered = ['if (!isCanonicalJsonBody(body)) return', 'if (!mayRetainRefusedAuditBody(event)) return', 'const refusal = contractRefusal(event);', 'if (refusal) return'];
  if (admission === undefined || !inOrder(admission, ordered) || contract === undefined || !contract.includes('validateAuditEvent(event)')) {
    problems.push(`${AUDIT_ADMISSION_FILES.admission}: \`auditAdmission\` must check canonical bytes (\`isCanonicalJsonBody\`), then the Stage 18.8 screen (\`mayRetainRefusedAuditBody\`), then the full contract (\`validateAuditEvent\`); ${why}`);
  }
  const policy = functionBody(files[AUDIT_ADMISSION_FILES.deadLetterPolicy] ?? '', 'auditDeadLetterPolicy');
  if (policy === undefined || !policy.includes('isCanonicalJsonBody(') || !policy.includes('mayRetainRefusedAuditBody(')) {
    problems.push(`${AUDIT_ADMISSION_FILES.deadLetterPolicy}: \`auditDeadLetterPolicy\` must keep an original body only when it is canonical (\`isCanonicalJsonBody\`) and passes \`mayRetainRefusedAuditBody\`; ${why}`);
  }
  const bus = files[KIT_EVENT_BUS];
  const deliver = bus === undefined ? undefined : bus.slice(bus.indexOf('private async deliver('), bus.indexOf('private async provenanceCommitted('));
  if (deliver === undefined || !inOrder(deliver, ['if (sub.admission) admit(', 'if (sub.provenance'])) problems.push(`${KIT_EVENT_BUS}: \`deliver\` must run \`admission\` before provenance; ${why}`);
  return problems;
}

/**
 * Core V2 S1b-3: Notification's keyed body commitment in its fixed files (see above). `files`: relPath -> text (undefined when absent);
 * `sources`: Notification's non-test source, relPath -> text.
 */
export function keyedCommitmentProblems(files, sources = {}) {
  const problems = [];
  const why = 'Notification keeps event provenance only as a KEYED body commitment, never an unkeyed digest (ADR-0057 §13.2 "S0-C2")';
  const consumer = files[NOTIFICATION_KEYED_FILES.consumer] ?? '';
  const at = consumer.indexOf('.subscribe({');
  const subscribe = at < 0 ? '' : consumer.slice(at, consumer.indexOf('});', at));
  if (!/\bprovenance\s*:\s*\{\s*ownerOf:\s*intakeEventOwner,\s*keyedStore:\s*new PgKeyedProvenanceStore\(this\.db, keys\)\s*\}/.test(subscribe) || /\bstore\s*:/.test(subscribe)) {
    problems.push(`${NOTIFICATION_KEYED_FILES.consumer}: the intake subscription must pass \`provenance: { ownerOf: intakeEventOwner, keyedStore: new PgKeyedProvenanceStore(this.db, keys) }\` and no unkeyed \`store:\`; ${why}`);
  }
  if (!consumer.includes("if (!this.config.provenanceKeys) return 'intake:provenance_keys_missing';") || !consumer.includes("if (!keys) throw new Error('intake:provenance_keys_missing');")) {
    problems.push(`${NOTIFICATION_KEYED_FILES.consumer}: the intake must refuse to start without the provenance key ring (\`intake:provenance_keys_missing\`); ${why}`);
  }
  const config = files[NOTIFICATION_KEYED_FILES.config] ?? '';
  if (!config.includes("readOptionalKeyEntries(reader, 'NOTIFICATION_PROVENANCE_KEYS'") || !config.includes("['NOTIFICATION_PROVENANCE_KEYS', k] as const")) {
    problems.push(`${NOTIFICATION_KEYED_FILES.config}: must read the dedicated NOTIFICATION_PROVENANCE_KEYS ring and keep it distinct from every other key (assertDistinctKeys); ${why}`);
  }
  for (const [relPath, text] of Object.entries(sources)) {
    if (UNKEYED_DIGEST.test(text)) problems.push(`${relPath}: names an unkeyed body digest (\`bodySha256\`, \`PgProvenanceStore\` or \`evaluateProvenance(\`); ${why}`);
  }
  const migration = files[NOTIFICATION_KEYED_FILES.migration];
  if (migration === undefined || /bodySha256/i.test(migration) || !['"bodyCommitmentVersion"', '"bodyMacKeyId"', '"bodyMac"'].every((c) => migration.includes(c))) {
    problems.push(`${NOTIFICATION_KEYED_FILES.migration}: must store \`bodyCommitmentVersion\`, \`bodyMacKeyId\` and \`bodyMac\` and no unkeyed body digest; ${why}`);
  }
  // Core V2 S1c-1 (S0-C3): conflict evidence records `differs` or `unverifiable`, and no later migration adds an unkeyed body digest
  const comparison = files[NOTIFICATION_KEYED_FILES.comparisonMigration];
  if (comparison === undefined || /bodySha256/i.test(comparison) || !comparison.includes("comparison IN ('differs', 'unverifiable')")) {
    problems.push(`${NOTIFICATION_KEYED_FILES.comparisonMigration}: must record the evidence \`comparison\` (\`differs\` or \`unverifiable\`) and no unkeyed body digest; ${why}`);
  }
  const kit = files[KIT_PROVENANCE] ?? '';
  const keyedStore = kit.indexOf('export class PgKeyedProvenanceStore');
  if (keyedStore < 0 || /bodySha256|createHash\(/.test(kit.slice(keyedStore))) problems.push(`${KIT_PROVENANCE}: \`PgKeyedProvenanceStore\` must exist and never compute an unkeyed digest; ${why}`);
  const bus = files[KIT_EVENT_BUS] ?? '';
  const committed = bus.slice(bus.indexOf('private async provenanceCommitted('), bus.indexOf('private async onFailure('));
  if (!committed.includes('evaluateProvenanceFacts(') || !/p\.keyedStore\s*\n?\s*\?\s*await p\.keyedStore\.record\(sub\.queue, \{ \.\.\.o, body: Buffer\.from\(msg\.content\) \}\)/.test(committed)) {
    problems.push(`${KIT_EVENT_BUS}: \`provenanceCommitted\` must give a keyed store the facts and the raw bytes only (\`evaluateProvenanceFacts\`, no unkeyed digest on that path); ${why}`);
  }
  // Core V2 S1c-1 (S0-C3): the replay classification gives a keyed store the raw bytes only, and is OBSERVE-ONLY: it never settles, refuses or
  // throws, and the default-exchange branch always goes on to the handler
  const replayAt = bus.indexOf('private async classifyReplay(');
  const replay = replayAt < 0 ? '' : bus.slice(replayAt, bus.indexOf('\n  }\n', replayAt));
  if (!replay.includes('p.keyedStore.classifyReplay!(sub.queue, { ...candidate, body: Buffer.from(msg.content) })') || /\b(ack|nack|settle)\(|\bthrow\b|return false/.test(replay)
    || !committed.includes("if (msg.fields.exchange === '') await this.classifyReplay(msg, sub, who);\n        return true;")) {
    problems.push(`${KIT_EVENT_BUS}: \`classifyReplay\` must stay observe-only (no ack, nack, settle, throw or refusal; the default-exchange branch returns true) and give a keyed store the raw bytes only; ${why}`);
  }
  return problems;
}

/**
 * `contracts`: application directory -> the text of its contracts/events.json. `sources`: application directory -> { relPath: text } of
 * its non-test source. `files`: the fixed files of the Audit admission boundary and of Notification's keyed commitment (`AUDIT_ADMISSION_FILES`,
 * `NOTIFICATION_KEYED_FILES`, `KIT_EVENT_BUS`, `KIT_PROVENANCE`) -> text.
 */
export function checkEventProvenanceOptIn(contracts, sources, files = {}) {
  const problems = [];
  for (const [app, appFiles] of Object.entries(sources)) {
    if (EVENT_PROVENANCE_APPROVED_SERVICES.includes(app)) continue;
    for (const [relPath, text] of Object.entries(appFiles)) {
      if (PROVENANCE_OPT_IN.test(text)) problems.push(`${relPath}: opts into event provenance, but ${app} is not on EVENT_PROVENANCE_APPROVED_SERVICES: the unkeyed body digest needs a review that the service never receives a low-entropy secret (ADR-0057 §13.2, ADR-0052 decision 5)`);
    }
  }
  const parsed = new Map();
  for (const [app, text] of Object.entries(contracts)) {
    try { parsed.set(app, JSON.parse(text)); } catch { /* reported by checkEventContracts */ }
  }
  const codeBearing = new Set();
  for (const [app, c] of parsed) for (const e of Array.isArray(c?.produces) ? c.produces : []) if (e?.codeBearing === true) codeBearing.add(`${app}|${e.name}`);
  for (const [app, basis] of Object.entries(EVENT_PROVENANCE_APPROVED)) {
    const appSources = sources[app] ?? {};
    const optedIn = Object.values(appSources).some((text) => PROVENANCE_OPT_IN.test(text));
    if (basis === 'keyed-commitment') {
      if (optedIn) problems.push(...keyedCommitmentProblems(files, appSources));
      continue;
    }
    // the unkeyed bases stay unkeyed: a store of their own kind, never the keyed one (a mode change is a reviewed change here)
    if (optedIn && (!Object.values(appSources).some((t) => /\bstore:\s*new PgProvenanceStore\(/.test(t)) || Object.values(appSources).some((t) => /\bkeyedStore\b/.test(t)))) {
      problems.push(`apps/${app}: its event provenance must stay on the unkeyed store (\`store: new PgProvenanceStore(\`, no \`keyedStore\`) as reviewed for the ${basis} basis; a change of mode is a reviewed change to EVENT_PROVENANCE_APPROVED`);
    }
    if (basis === 'audit-admission') {
      if (optedIn) problems.push(...auditAdmissionProblems(files));
      continue;
    }
    const c = parsed.get(app);
    if (c === undefined) { problems.push(`apps/${app}/contracts/events.json is missing or invalid: an event-provenance service must declare what it consumes`); continue; }
    for (const e of Array.isArray(c.consumes) ? c.consumes : []) {
      if (codeBearing.has(`${e?.source}|${e?.name}`)) problems.push(`apps/${app}/contracts/events.json: consumes the code-bearing ${e.source} ${e.name}, so ${app} cannot keep event provenance: its unkeyed body digest would expose the code (ADR-0052 decision 5)`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 S1c-3 R1: the restricted producer re-emission foundation

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4"): the kit's re-emission foundation stays a restricted library, never a publisher.
 * - `REEMISSION_APPROVALS` in the kit equals the S0-C4 decision below, entry for entry (no wildcard, no other producer, version 1), and
 *   each entry is an event its producer's contract declares, at that version, and not code-bearing;
 * - `CODE_BEARING_EVENTS` in the kit names every produced event any contract marks `codeBearing` (the contracts are the authority);
 * - ONE serialization path (pipeline v1): the relay builds envelopes with `outboxEnvelope`, `publish` and `publishReemission` build the
 *   message with `eventMessage`, nothing else in the bus serializes a payload, and the ordinary `publish` never sets `mandatory`;
 * - `publishReemission` consumes an issued plan first, refuses a `source` that is not its own broker user, publishes to its topic exchange
 *   (never `sendToQueue`) with `mandatory`;
 * - `ProducerReemission.reemit` runs its checks in order: request, code-bearing, authorization, the row, the durable intent, the
 *   `publishing` state, and only then the publish;
 * - no kit CLI or bin re-emits, and no application uses the foundation until its integration is reviewed and listed in
 *   `REEMISSION_INTEGRATED_SERVICES` (empty: nothing can publish a re-emission);
 * - Core V2 S1c-3 R2a: a service on `REEMISSION_ELIGIBILITY_ONLY_SERVICES` (payment-service) may use the READ-ONLY parts (its policy,
 *   ownership evidence, `inspectReemissionEligibility`), but none of its source may name the publishing, authorizing or recording
 *   machinery (`ProducerReemission`, `publishReemission`, the publisher / authorizer / attempt-store interfaces, `commitIntent`,
 *   `auditIntentRecorded`, an `event_reemitted` audit action); a file that uses the read-only parts imports no broker, outbox or audit
 *   writer and writes no SQL; and its policy names only S0-C4 approvals of that service, with no pattern.
 * Limits: a presence and order scan of source text; `test/reemission.spec.ts` and `test/reemission.int-spec.ts` prove the behaviour.
 */
export const S0C4_REEMISSION_APPROVALS = Object.freeze({
  'payment-service': Object.freeze(['payment.succeeded@1', 'payment.failed@1', 'payment.cancelled@1', 'payment.expired@1']),
});
export const REEMISSION_INTEGRATED_SERVICES = Object.freeze([]);
export const REEMISSION_ELIGIBILITY_ONLY_SERVICES = Object.freeze(['payment-service']);
const REEMISSION_PUBLISHING = /\b(ProducerReemission|publishReemission|ReemissionPublisher|ReemissionAuthorizer|ReemissionAttemptStore|ProducerReemissionOptions|consumeIssuedReemissionPlan|commitIntent|appendTransition|auditIntentRecorded|DurableIntentReceipt)\b|event_reemitted/;
const REEMISSION_READ_ONLY_FILE_FORBIDS = /from '(amqplib|@nawara\/audit-contract)'|\b(RabbitMqEventBus|EventsModule|OutboxService|OutboxRelay|AuditEventWriter)\b|\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE)\b/i;
export const KIT_REEMISSION = 'libs/service-kit/src/events/reemission.ts';
export const KIT_SERIALIZATION = 'libs/service-kit/src/events/serialization.ts';
export const KIT_OUTBOX_RELAY = 'libs/service-kit/src/events/outbox-relay.ts';
export const KIT_PACKAGE = 'libs/service-kit/package.json';
const REEMISSION_USE = /\b(ProducerReemission|publishReemission|reemissionPolicy|REEMISSION_APPROVALS|inspectReemissionEligibility|migrationOwnership)\b/;

/** The text between `start` and the first `end` after it, or '' when `start` is absent. */
function between(text, start, end) {
  const at = text.indexOf(start);
  if (at < 0) return '';
  const stop = text.indexOf(end, at + start.length);
  return text.slice(at, stop < 0 ? undefined : stop);
}

/**
 * `contracts`: application directory -> contracts/events.json text. `files`: KIT_REEMISSION, KIT_SERIALIZATION, KIT_EVENT_BUS,
 * KIT_OUTBOX_RELAY, KIT_PACKAGE -> text. `sources`: application directory -> { relPath: text } of its non-test source, plus the kit's
 * CLI sources under the key `libs/service-kit/src/cli`.
 */
export function checkEventReemission(contracts, files, sources = {}) {
  const problems = [];
  const why = 'producer re-emission stays the restricted S0-C4 foundation (ADR-0057 §13.7 "S0-C4")';
  const kit = files[KIT_REEMISSION] ?? '';
  const parsed = new Map();
  for (const [app, text] of Object.entries(contracts)) {
    try { parsed.set(app, JSON.parse(text)); } catch { /* reported by checkEventContracts */ }
  }
  // the approvals, entry for entry
  const approvals = between(kit, 'export const REEMISSION_APPROVALS', '\n});');
  const found = {};
  let producer;
  for (const line of approvals.split('\n')) {
    const p = /^\s*'([^']+)': Object\.freeze\(\[/.exec(line);
    if (p) { producer = p[1]; found[producer] = []; continue; }
    const e = /\{ name: '([^']+)', version: (\d+) \}/.exec(line);
    if (e && producer) found[producer].push(`${e[1]}@${e[2]}`);
  }
  const expected = Object.fromEntries(Object.entries(S0C4_REEMISSION_APPROVALS).map(([k, v]) => [k, [...v]]));
  if (approvals === '' || JSON.stringify(found) !== JSON.stringify(expected) || /[*#]/.test(approvals.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, ''))) {
    problems.push(`${KIT_REEMISSION}: REEMISSION_APPROVALS must be exactly the S0-C4 approvals (${JSON.stringify(expected)}), with no pattern; widening it is an architecture decision first; ${why}`);
  }
  const codeBearing = new Set();
  for (const [, c] of parsed) for (const e of Array.isArray(c?.produces) ? c.produces : []) if (e?.codeBearing === true) codeBearing.add(e.name);
  for (const [app, entries] of Object.entries(S0C4_REEMISSION_APPROVALS)) {
    const produced = Array.isArray(parsed.get(app)?.produces) ? parsed.get(app).produces : [];
    for (const entry of entries) {
      const [name, version] = entry.split('@');
      const declared = produced.find((e) => e?.name === name);
      if (!declared || declared.version !== Number(version) || declared.codeBearing === true) {
        problems.push(`apps/${app}/contracts/events.json: the re-emission approval ${entry} must be an event ${app} produces, at that version, and not code-bearing; ${why}`);
      }
    }
  }
  const denied = between(kit, 'export const CODE_BEARING_EVENTS', ']);');
  for (const name of codeBearing) {
    if (!denied.includes(`'${name}'`)) problems.push(`${KIT_REEMISSION}: CODE_BEARING_EVENTS must name the code-bearing ${name} (its contract marks it codeBearing); code-bearing events are never re-emitted (ADR-0052 decision 5); ${why}`);
  }
  // one serialization path
  const serialization = files[KIT_SERIALIZATION] ?? '';
  if (!serialization.includes('export function outboxEnvelope(') || !serialization.includes('content: Buffer.from(JSON.stringify(event.payload)),')) {
    problems.push(`${KIT_SERIALIZATION}: must define pipeline v1 (\`outboxEnvelope\`, and \`eventMessage\` serializing exactly \`JSON.stringify(event.payload)\`); ${why}`);
  }
  const relay = files[KIT_OUTBOX_RELAY] ?? '';
  if (!relay.includes('outboxEnvelope(r, this.opts.source)')) problems.push(`${KIT_OUTBOX_RELAY}: the relay must build its envelopes with \`outboxEnvelope(r, this.opts.source)\` (pipeline v1); ${why}`);
  const bus = files[KIT_EVENT_BUS] ?? '';
  const publish = between(bus, '\n  async publish(event: EventEnvelope)', '\n  }\n');
  const reemit = between(bus, '\n  async publishReemission(', '\n  }\n');
  if (!publish.includes('eventMessage(event, userId)') || /mandatory/.test(publish)) problems.push(`${KIT_EVENT_BUS}: \`publish\` must build its message with \`eventMessage(event, userId)\` and never set \`mandatory\`; ${why}`);
  if (/JSON\.stringify\(event\.payload\)/.test(bus)) problems.push(`${KIT_EVENT_BUS}: serializes a payload itself; only \`eventMessage\` (serialization.ts) does; ${why}`);
  if (!inOrder(reemit, ['if (!consumeIssuedReemissionPlan(plan)) throw', 'event.headers.source !== this.publisherUserId', "this.exchange === ''", 'eventMessage(event, this.publisherUserId)', 'ch.publish(this.exchange, message.routingKey, message.content, { ...message.options, mandatory: true }'])
    || /sendToQueue/.test(reemit)) {
    problems.push(`${KIT_EVENT_BUS}: \`publishReemission\` must consume an issued plan, refuse a source that is not its own broker user and the default exchange, build the message with \`eventMessage\` and publish it to its topic exchange with \`mandatory\`; ${why}`);
  }
  const reemitFlow = between(kit, '\n  async reemit(input: unknown)', '\n  /** Step 4');
  if (!inOrder(reemitFlow, ['reemissionRequest(input)', 'isCodeBearingEvent(request.eventName)', 'this.opts.authorizer.verify(', 'this.selectRow(', 'outboxEnvelope(row, policy.producer)', 'this.opts.attempts.commitIntent(intent)', "to: 'publishing'", 'issued.add(plan)', 'this.opts.publisher.publishReemission(plan)'])
    || (reemitFlow.match(/publishReemission\(/g) ?? []).length !== 1) {
    problems.push(`${KIT_REEMISSION}: \`reemit\` must check the request, code-bearing names, the authorization and the row, record the durable intent and the publishing state, and only then publish (exactly once); ${why}`);
  }
  // no CLI, no bin, no application until its integration is reviewed
  if (/reemi/i.test(between(files[KIT_PACKAGE] ?? '', '"bin"', '}'))) problems.push(`${KIT_PACKAGE}: no kit command re-emits events; ${why}`);
  for (const owner of REEMISSION_ELIGIBILITY_ONLY_SERVICES) {
    if (REEMISSION_INTEGRATED_SERVICES.includes(owner)) problems.push(`${owner} is both eligibility-only and integrated; ${why}`);
    const approved = S0C4_REEMISSION_APPROVALS[owner] ?? [];
    for (const [relPath, text] of Object.entries(sources[owner] ?? {})) {
      if (REEMISSION_PUBLISHING.test(text)) {
        problems.push(`${relPath}: names the re-emission publishing, authorizing or recording machinery, but ${owner} is eligibility-only (read-only inspection; publication is separately authorized); ${why}`);
      }
      // a file that uses the read-only parts, directly or through the service's own re-emission module
      if (!REEMISSION_USE.test(text) && !/reemission/i.test(relPath) && !/\/reemission\/[\w-]+\.js'/.test(text)) continue;
      if (REEMISSION_READ_ONLY_FILE_FORBIDS.test(text)) problems.push(`${relPath}: uses the read-only re-emission inspection, so it imports no broker, outbox or audit writer and writes no SQL; ${why}`);
      const policy = between(text, 'reemissionPolicy(', ']);');
      if (policy !== '') {
        const entries = [...policy.matchAll(/\{ name: '([^']+)', version: (\d+) \}/g)].map((m) => `${m[1]}@${m[2]}`);
        if (entries.length === 0 || entries.some((e) => !approved.includes(e)) || /[*#]/.test(policy)) {
          problems.push(`${relPath}: the ${owner} re-emission policy must list only its S0-C4 approvals (${approved.join(', ')}), with no pattern; ${why}`);
        }
      }
    }
  }
  for (const [owner, appFiles] of Object.entries(sources)) {
    if (REEMISSION_INTEGRATED_SERVICES.includes(owner) || REEMISSION_ELIGIBILITY_ONLY_SERVICES.includes(owner)) continue;
    for (const [relPath, text] of Object.entries(appFiles)) {
      if (REEMISSION_USE.test(text)) problems.push(`${relPath}: uses the re-emission foundation, but ${owner} is not on REEMISSION_INTEGRATED_SERVICES: a producer integration is a separately authorized, reviewed change; ${why}`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 S1e-1: consumer enforcement policies

/**
 * Core V2 S1e-1 (ADR-0057 "S0-C6"): the two enforcement-policy rules a source scan can hold, beside the kit's own runtime checks:
 * - only audit-service may name `auditCompatibilityEnforcement` (the compatibility phase is Audit's alone; the kit also refuses it on any
 *   other queue at subscribe, so a financial consumer can never run in it);
 * - a service that consumes an event its producer's contract marks `codeBearing` never declares `refusedBody: 'original_reviewed'`: a
 *   refused delivery of such an event must go through a redacting dead-letter policy, never keep its code.
 * `contracts`: application -> contracts/events.json text; `sources`: application -> { relPath: text } of its non-test source.
 */
export const ENFORCEMENT_COMPATIBILITY_SERVICES = Object.freeze(['audit-service']);
/**
 * Core V2 S1e-2 (ADR-0057 §13.5, "S0-C6"): the financial consumer's subscription is strict, and its handler takes the envelope values it
 * relies on from the trusted envelope only (a verified original's, or the recorded original's for a replay), never the delivery headers.
 */
export const STRICT_FINANCIAL_CONSUMERS = Object.freeze({
  'billing-service': Object.freeze({
    consumer: 'apps/billing-service/src/payment-integration/payment-event-consumer.ts',
    origin: 'apps/billing-service/src/payment-integration/payment-event-origin.ts',
  }),
});
/**
 * Core V2 S1e-4 (ADR-0057 "S0-C6" Notification, ADR-0052 decision 5): Notification's intake is strict from its first deployment, with a
 * dead-letter policy that never keeps a code-bearing body, and intake sees only the trusted envelope (never a replay's own correlation).
 */
export const STRICT_NOTIFICATION_CONSUMER = Object.freeze({
  consumer: 'apps/notification-service/src/intake/event-consumer.ts',
  deadLetterPolicy: 'apps/notification-service/src/intake/dead-letter-policy.ts',
  trustedEvent: 'apps/notification-service/src/intake/trusted-event.ts',
});
function notificationEnforcementProblems(files, why) {
  const problems = [];
  const n = STRICT_NOTIFICATION_CONSUMER;
  const consumer = files[n.consumer];
  if (consumer === undefined) return [`${n.consumer}: the Notification intake consumer was not found; ${why}`];
  const at = consumer.indexOf('.subscribe({');
  const subscribe = at < 0 ? '' : consumer.slice(at, consumer.indexOf('});', at));
  if (!/strictEnforcement\(\{\s*refusedBody:\s*'dead_letter_policy'\s*\}\)/.test(consumer) || !/\benforcement:\s*this\.enforcement\b/.test(subscribe)) {
    problems.push(`${n.consumer}: the intake subscription must be strict (\`enforcement: this.enforcement\`, \`strictEnforcement({ refusedBody: 'dead_letter_policy' })\`): verified-only, no other mode; ${why}`);
  }
  if (!/\bdeadLetterPolicy:\s*notificationDeadLetterPolicy\b/.test(subscribe)) problems.push(`${n.consumer}: the intake subscription must pass \`deadLetterPolicy: notificationDeadLetterPolicy\` (a code-bearing body is never kept); ${why}`);
  if (!/handler:\s*\(e, trust\) => this\.handle\(e, trust\)/.test(subscribe) || !/trustedIntakeEvent\(event, trust\)/.test(consumer) || !/this\.intake\.handle\(trusted\)/.test(consumer) || /this\.intake\.handle\(event\)/.test(consumer)) {
    problems.push(`${n.consumer}: the intake must run only on the trusted envelope (\`trustedIntakeEvent(event, trust)\`, then \`this.intake.handle(trusted)\`); ${why}`);
  }
  const policy = files[n.deadLetterPolicy] ?? '';
  if (!policy.includes('CODE_BEARING_EVENTS.has(') || !policy.includes('isCanonicalJsonBody(body)') || !policy.includes('carriesCode(JSON.parse(body')) {
    problems.push(`${n.deadLetterPolicy}: \`notificationDeadLetterPolicy\` must redact every code-bearing event and keep a body only when its canonical bytes carry no \`code\`; ${why}`);
  }
  if (/\bevent\.headers\.correlationId\b/.test(files[n.trustedEvent] ?? 'event.headers.correlationId')) problems.push(`${n.trustedEvent}: the trusted envelope must never take a delivery's own correlation header (a replay's is not trusted); ${why}`);
  return problems;
}
export function checkEnforcementPolicies(contracts, sources) {
  const problems = [];
  const why = 'consumer enforcement follows ADR-0057 S0-C6';
  const parsed = new Map();
  for (const [app, text] of Object.entries(contracts)) {
    try { parsed.set(app, JSON.parse(text)); } catch { /* reported by checkEventContracts */ }
  }
  const codeBearing = new Set();
  for (const [app, c] of parsed) for (const e of Array.isArray(c?.produces) ? c.produces : []) if (e?.codeBearing === true) codeBearing.add(`${app}|${e.name}`);
  for (const [app, files] of Object.entries(sources)) {
    const consumesCode = (parsed.get(app)?.consumes ?? []).some((e) => codeBearing.has(`${e?.source}|${e?.name}`));
    for (const [relPath, text] of Object.entries(files)) {
      if (!ENFORCEMENT_COMPATIBILITY_SERVICES.includes(app) && /\bauditCompatibilityEnforcement\b/.test(text)) problems.push(`${relPath}: only audit-service may use the compatibility phase (auditCompatibilityEnforcement); ${why}`);
      if (consumesCode && /refusedBody\s*:\s*['"]original_reviewed['"]/.test(text)) problems.push(`${relPath}: ${app} consumes a code-bearing event, so a refusal must use its redacting dead-letter policy (refusedBody 'dead_letter_policy'), never keep the original body; ${why}`);
    }
  }
  if (sources['notification-service'] !== undefined) problems.push(...notificationEnforcementProblems(sources['notification-service'], why));
  for (const [app, files] of Object.entries(STRICT_FINANCIAL_CONSUMERS)) {
    if (sources[app] === undefined) continue; // the application was not scanned
    const consumer = sources[app][files.consumer];
    if (consumer === undefined) { problems.push(`${files.consumer}: the financial consumer was not found; ${why}`); continue; }
    const at = consumer.indexOf('.subscribe({');
    const subscribe = at < 0 ? '' : consumer.slice(at, consumer.indexOf('});', at));
    if (!/\benforcement:\s*strictEnforcement\(/.test(subscribe)) problems.push(`${files.consumer}: the financial subscription must declare \`enforcement: strictEnforcement(...)\` (verified-only, no other mode); ${why}`);
    for (const rel of [files.consumer, files.origin]) {
      if (/\bevent\.headers\.(occurredAt|version|source|correlationId)\b/.test(sources[app]?.[rel] ?? '')) problems.push(`${rel}: reads a delivery header Billing must take from the trusted envelope (occurredAt, version, source, correlationId); ${why}`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 OD-BRK-1: opt-in broker dead-lettering topology

/**
 * Core V2 OD-BRK-1 (ADR-0057 §8 "OD-BRK-0"): `noBrokerDeadLettering()` is an opt-in kit capability; adopting it is a service's own,
 * separately authorized slice (OD-BRK-2 Notification, OD-BRK-3 Billing), because an opted-in consumer is production-ready only after the
 * protected effective-topology verification. So:
 * - only the services listed here may name it (none yet: the list grows with each adoption slice);
 * - the kit's DEFAULT declaration is unchanged: the work queue keeps `x-dead-letter-exchange` and `.dead` stays bound to the fanout,
 *   both only skipped for an opted-in subscription.
 * `sources`: application -> { relPath: text } of its non-test source; `bus`: the kit bus's text.
 */
export const BROKER_DEAD_LETTERING_ADOPTERS = Object.freeze(['notification-service']); // OD-BRK-2a; Billing is OD-BRK-3, Audit OD-BRK-4
export function checkBrokerDeadLettering(sources, bus) {
  const problems = [];
  const why = 'broker dead-lettering topology follows ADR-0057 §8 "OD-BRK-0" (adoption is a separately authorized slice)';
  for (const [app, files] of Object.entries(sources)) {
    if (BROKER_DEAD_LETTERING_ADOPTERS.includes(app)) continue;
    for (const [rel, text] of Object.entries(files)) {
      if (/\bnoBrokerDeadLettering\b|\bbrokerDeadLettering\s*:/.test(text)) problems.push(`${rel}: ${app} may not opt out of broker dead-lettering yet; ${why}`);
    }
  }
  const attach = bus === undefined ? '' : bus.slice(bus.indexOf('private async attach('), bus.indexOf('private async attach(') + 4000);
  if (!/const isolated = sub\.brokerDeadLettering !== undefined;/.test(attach)
    || !/if \(!isolated\) await ch\.assertExchange\(dlx, 'fanout'/.test(attach)
    || !/if \(!isolated\) await ch\.bindQueue\(deadQueueName\(sub\.queue\), dlx, ''\)/.test(attach)
    || !/isolated \? \{ durable: true \} : \{ durable: true, arguments: \{ 'x-dead-letter-exchange': dlx \} \}/.test(attach)
    || !/if \(!sub\.brokerDeadLettering\) await ch\.bindQueue\(deadQueueName\(sub\.queue\), `\$\{this\.exchange\}\.dlx`, ''\)/.test(bus ?? '')) {
    problems.push(`${'libs/service-kit/src/events/rabbitmq-event-bus.ts'}: the default topology (work queue -> \`<exchange>.dlx\`, \`.dead\` bound to it) must stay unchanged and be skipped ONLY for an opted-in subscription; ${why}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 OD-BRK-2a: Notification's isolated topology and its gate

/**
 * Core V2 OD-BRK-2a (ADR-0057 §8 "OD-BRK-0"): the protected workflow streams infra/rabbitmq/provision.sh ALONE to the server, so the
 * effective-topology verifier is embedded in it verbatim; and notification-service's grant stays behind the fail-closed gate:
 * - the embedded block equals infra/rabbitmq/verify-topology.sh byte for byte;
 * - notification-service has the isolated consumer role (never `<exchange>.dlx`);
 * - its grant is preceded by the pre-grant verification and followed by the post-grant one, which withdraws a grant this run made.
 */
export const TOPOLOGY_VERIFIER = 'infra/rabbitmq/verify-topology.sh';
export const PROVISION_SCRIPT = 'infra/rabbitmq/provision.sh';
export function checkNotificationTopologyGate(provision, verifier) {
  const problems = [];
  const why = 'Notification is granted only behind the effective-topology gate (ADR-0057 §8 "OD-BRK-0", OD-BRK-2a)';
  if (provision === undefined || verifier === undefined) return [`${PROVISION_SCRIPT} / ${TOPOLOGY_VERIFIER}: not found; ${why}`];
  const begin = "verify_topology() {\n  bash -s -- \"$@\" <<'NAWARA_TOPOLOGY_VERIFIER'\n";
  const at = provision.indexOf(begin);
  const end = at < 0 ? -1 : provision.indexOf('\nNAWARA_TOPOLOGY_VERIFIER\n}', at);
  if (at < 0 || end < 0 || provision.slice(at + begin.length, end + 1) !== verifier) problems.push(`${PROVISION_SCRIPT}: the embedded topology verifier must equal ${TOPOLOGY_VERIFIER} byte for byte; ${why}`);
  if (/^NAWARA_TOPOLOGY_VERIFIER$/m.test(verifier)) problems.push(`${TOPOLOGY_VERIFIER}: must not contain the heredoc terminator line; ${why}`);
  if (!/^\s*notification-service\) isolated_consumer notification\.events ;;$/m.test(provision)) problems.push(`${PROVISION_SCRIPT}: notification-service must have the isolated_consumer role; ${why}`);
  const role = provision.slice(provision.indexOf('isolated_consumer() {'), provision.indexOf('\n}', provision.indexOf('isolated_consumer() {')));
  if (!role.startsWith('isolated_consumer() {') || /dlx/.test(role)) problems.push(`${PROVISION_SCRIPT}: the isolated_consumer role must never name the dead-letter exchange; ${why}`);
  const loop = provision.slice(provision.indexOf('for s in $SERVICES; do\n  permissions_for "$s"'));
  const pre = loop.indexOf('notification_verify pre-grant || die');
  const grant = loop.indexOf('ctl set_permissions -p "$VHOST" "$s"');
  const post = loop.indexOf('if ! notification_verify post-grant; then');
  const withdraw = loop.indexOf('ctl clear_permissions -p "$VHOST" "$s"');
  if (!(pre >= 0 && grant > pre && post > grant && withdraw > post)) problems.push(`${PROVISION_SCRIPT}: notification-service must be verified before its grant (pre-grant) and after it (post-grant, withdrawing a new grant on failure); ${why}`);
  if (!/case \$result in PASS\) exit 0 ;; FAIL\) exit 1 ;; \*\) exit 3 ;; esac\s*$/.test(verifier)) problems.push(`${TOPOLOGY_VERIFIER}: only PASS may exit 0 (UNKNOWN is never PASS); ${why}`);
  return problems;
}

// ─────────────────────────────────────────────────────────────── Core V2 OD-BRK-2b-1: Notification's topology monitor and containment

export const TOPOLOGY_MONITOR_DIR = 'infra/rabbitmq/topology-monitor';
export const TOPOLOGY_MONITOR_FILES = [
  'verify-and-contain.sh', 'topology-watchdog.sh', 'topology-trigger.sh', 'recover-notification-topology.sh', 'install-topology-monitor.sh',
  'verify-topology-monitor-install.sh', 'nawara-core-topology-monitor.service', 'nawara-core-topology-monitor.timer',
  'nawara-core-topology-watchdog.service', 'nawara-core-topology-watchdog.timer', 'topology-trigger.authorized_keys.template', 'topology-trigger.sudoers.template',
  'topology-alert-carrier.sh', 'nawara-core-topology-alert.service', 'nawara-core-topology-alert.timer',
];
const TOPOLOGY_MONITOR_LOCATIONS = {
  INSTALL_DIR: '/usr/local/libexec/nawara-core-topology', STATE_DIR: '/var/lib/nawara-core-topology-monitor',
  LATCH: '/var/lib/nawara-core-topology/notification-service.containment', BROKER: 'nawara-core-rabbitmq', SERVICE: 'notification-service', VHOST: 'nawara-core',
  OWNER_UID: '0', RUN_AS_UID: '0', UNIT_DIR: '/etc/systemd/system', SAFE_PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  // OD-BRK-2b-R: the incident binding next to the latch, and the signed recovery's trust anchor and binding
  INCIDENT_FILE: '/var/lib/nawara-core-topology/notification-service.incident', TRUSTED_SIGNERS: '/etc/nawara-core-topology/recovery-allowed-signers',
  PRINCIPAL: 'nawara-core-owner', NAMESPACE: 'nawara-core-topology-recovery', OPERATION: 'notification.topology_recovery',
  // OD-BRK-2b-I: the authenticated installation (its own state, its own trust key and namespace)
  INSTALL_STATE: '/var/lib/nawara-core-topology-install', INSTALL_TRUST: '/etc/nawara-core-topology/install-allowed-signers', INSTALL_NAMESPACE: 'nawara-core-topology-install',
  STATE_SCHEMA: '2',
  // OD-BRK-2b-A: the external alert carrier's own state directory and systemd credentials (never the Auth carrier's)
  CARRIER_DIR: '/var/lib/nawara-core-topology-alert', CRED_DIR: '/run/credentials/nawara-core-topology-alert.service', CARRIER_ETC: '/etc/nawara-core-topology-alert',
};
/** OD-BRK-2b-I: the artifacts a signed manifest lists, in its fixed order (the installer, the verifier and the generator agree). */
export const TOPOLOGY_MONITOR_ARTIFACTS = [
  'verify-and-contain.sh', 'topology-watchdog.sh', 'topology-trigger.sh', 'recover-notification-topology.sh', 'install-topology-monitor.sh',
  'verify-topology-monitor-install.sh', 'topology-alert-carrier.sh', 'verify-topology.sh', 'nawara-core-topology-monitor.service', 'nawara-core-topology-monitor.timer',
  'nawara-core-topology-watchdog.service', 'nawara-core-topology-watchdog.timer', 'nawara-core-topology-alert.service', 'nawara-core-topology-alert.timer',
];
/** OD-BRK-2b-A: the carrier's fixed provider endpoints (A5-R3's: infra/alerting/auth-readiness-alert.sh) and its minimum event contract. */
const TOPOLOGY_ALERT_PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const TOPOLOGY_ALERT_HC_URL_RE = '^https://hc-ping\\.com/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{22}/[a-z0-9_-]{1,100})$';
const TOPOLOGY_ALERT_CODES = ['topology_verification_fail', 'topology_verification_unknown', 'topology_unknown_escalated', 'containment_started',
  'containment_confirmed', 'containment_unconfirmed', 'monitor_overdue', 'monitor_stalled', 'monitor_killed', 'monitor_timer_inactive',
  'watchdog_state_invalid', 'recovery_authorized', 'recovery_refused', 'installation_integrity_failed', 'heartbeat_delivery_failed'];
const pinOf = (text, name) => text?.match(new RegExp(`^readonly ${name}=(?:'([^']*)'|(\\S+))$`, 'm'))?.slice(1).find((v) => v !== undefined);

/**
 * Core V2 OD-BRK-2b-1 (ADR-0057 §8 "OD-BRK-0" D2): the scheduled monitor and emergency containment of Notification's effective topology,
 * kept consistent with OD-BRK-2a and inert in the repository:
 * - every script pins the same locations, the monitor and the recovery guard pin the SHA-256 of infra/rabbitmq/verify-topology.sh and
 *   the approved role and topic grant of infra/rabbitmq/provision.sh, and the installation verifier pins every installed file's SHA-256;
 * - the containment persists its intent (state, then latch) before revoking, closes connections, and confirms twice; a client command is
 *   only ever refused; no eval, no sourcing;
 * - the trigger can only start the monitor unit through the exact sudoers rule; the key template holds no key;
 * - no workflow installs, enables or starts any of it (a merge never activates a production control).
 * `files`: name -> text of TOPOLOGY_MONITOR_DIR; `verifier`, `provision`: the OD-BRK-2a files; `workflows`: name -> text.
 */
export function checkTopologyMonitor({ files = {}, verifier, provision, workflows = {} }) {
  const problems = [];
  const why = 'the topology monitor and containment follow OD-BRK-2b-1 (ADR-0057 §8 "OD-BRK-0" D2)';
  const at = (n) => `${TOPOLOGY_MONITOR_DIR}/${n}`;
  for (const n of TOPOLOGY_MONITOR_FILES) if (files[n] === undefined) problems.push(`${at(n)}: missing; ${why}`);
  if (problems.length > 0 || verifier === undefined || provision === undefined) return problems.length ? problems : [`${TOPOLOGY_VERIFIER} / ${PROVISION_SCRIPT}: not found; ${why}`];
  const sha = (t) => createHash('sha256').update(t).digest('hex');
  const scripts = ['verify-and-contain.sh', 'topology-watchdog.sh', 'topology-trigger.sh', 'recover-notification-topology.sh', 'install-topology-monitor.sh', 'verify-topology-monitor-install.sh', 'topology-alert-carrier.sh'];
  // locations: one value everywhere a script pins it
  for (const n of scripts) {
    for (const [name, value] of Object.entries(TOPOLOGY_MONITOR_LOCATIONS)) {
      const got = pinOf(files[n], name);
      if (got !== undefined && got !== value) problems.push(`${at(n)}: ${name} must be ${value} (found ${got}); ${why}`);
    }
    const code = files[n].replace(/^\s*#.*$/gm, '');
    if (/(^\s*|[;&|(]\s*|\b(?:then|do|else)\s+)(eval|source|\.)\s/m.test(code)) problems.push(`${at(n)}: no eval and no sourcing; ${why}`);
    if (/PRIVATE KEY/.test(files[n])) problems.push(`${at(n)}: must not contain a private-key marker; ${why}`);
  }
  // the verifier pin and the approved grant (OD-BRK-2a)
  const verifierSha = sha(verifier);
  for (const n of ['verify-and-contain.sh', 'recover-notification-topology.sh']) {
    if (pinOf(files[n], 'VERIFIER_SHA256') !== verifierSha) problems.push(`${at(n)}: VERIFIER_SHA256 must equal the SHA-256 of ${TOPOLOGY_VERIFIER} (${verifierSha}); ${why}`);
    if (pinOf(files[n], 'ROLE_CONF') !== '^(nawara\\.events|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$') problems.push(`${at(n)}: ROLE_CONF must be the approved isolated role (OD-BRK-2a); ${why}`);
    if (pinOf(files[n], 'ROLE_WRITE') !== '^(amq\\.default|notification\\.events|notification\\.events\\.retry|notification\\.events\\.dead)$') problems.push(`${at(n)}: ROLE_WRITE must be the approved isolated role (OD-BRK-2a); ${why}`);
    const grant = provision.match(/^\s*notification-service\)\n\s*TOPIC_WRITE='([^']*)'\n\s*TOPIC_READ='([^']*)' ;;$/m);
    if (!grant || pinOf(files[n], 'TOPIC_WRITE') !== grant[1] || pinOf(files[n], 'TOPIC_READ') !== grant[2]) problems.push(`${at(n)}: TOPIC_WRITE / TOPIC_READ must equal notification-service's generated grant in ${PROVISION_SCRIPT}; ${why}`);
  }
  if (!/^\s*notification-service\) isolated_consumer notification\.events ;;$/m.test(provision)) problems.push(`${PROVISION_SCRIPT}: notification-service must keep the isolated_consumer role the monitor pins; ${why}`);
  // OD-BRK-2b-I: the installation is authenticated by an Owner-signed manifest, never by hashes kept on the server
  const inst = files['install-topology-monitor.sh'];
  const instCode = inst.replace(/^\s*#.*$/gm, '');
  const ver = files['verify-topology-monitor-install.sh'];
  const verCode = ver.replace(/(^|\s)#(\s.*)?$/gm, ''); // full-line and inline comments
  const artifactOrder = `${pinOf(inst, 'SCRIPTS')} verify-topology.sh ${pinOf(inst, 'UNITS')}`.split(' ');
  if (artifactOrder.join(' ') !== TOPOLOGY_MONITOR_ARTIFACTS.join(' ') || !inst.includes('ARTIFACTS="$SCRIPTS verify-topology.sh $UNITS"')) problems.push(`${at('install-topology-monitor.sh')}: the manifest's artifacts are exactly ${TOPOLOGY_MONITOR_ARTIFACTS.join(', ')}, in this order; ${why}`);
  if (pinOf(ver, 'SCRIPTS') !== pinOf(inst, 'SCRIPTS') || pinOf(ver, 'UNITS') !== pinOf(inst, 'UNITS')) problems.push(`${at('verify-topology-monitor-install.sh')}: SCRIPTS and UNITS must equal the installer's; ${why}`);
  if (/^readonly SHA_[A-Z_]+=/m.test(ver)) problems.push(`${at('verify-topology-monitor-install.sh')}: no hash pinned on the server: the installed record signed by the Owner is the only authority; ${why}`);
  // the MANIFEST itself (not only some other document) is verified against the installation trust key, principal and namespace
  for (const [n, code, cmd] of [
    ['install-topology-monitor.sh', instCode, 'ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$dir/manifest.sig" <"$dir/manifest"'],
    ['verify-topology-monitor-install.sh', verCode, 'ssh-keygen -Y verify -f "$INSTALL_TRUST" -I "$PRINCIPAL" -n "$INSTALL_NAMESPACE" -s "$INSTALL_STATE/installed/manifest.sig" <"$INSTALL_STATE/installed/manifest"'],
  ]) {
    if (!code.includes(cmd)) problems.push(`${at(n)}: the manifest is verified with ssh-keygen -Y verify against the installation trust key, principal and namespace; ${why}`);
  }
  if (pinOf(inst, 'SIGNER_RE') !== '^nawara-core-owner namespaces="nawara-core-topology-install" (ssh-ed25519|sk-ssh-ed25519@openssh\\.com) [A-Za-z0-9+/]{40,400}={0,2}$') problems.push(`${at('install-topology-monitor.sh')}: the installation trust key must be exactly one line for the exact principal, restricted to the installation namespace; ${why}`);
  if (!instCode.includes('[ "$M_VERSION" -gt "$CUR_VERSION" ] || refuse downgrade')) problems.push(`${at('install-topology-monitor.sh')}: an upgrade needs a strictly higher, signed version (no silent downgrade); ${why}`);
  const mk = instCode.lastIndexOf('mkdir -m 700 -- "$TXN"'); const staged = instCode.indexOf('txn_phase staged', mk); const applyAt = instCode.indexOf('apply_artifacts', staged);
  if (mk < 0 || !(mk < staged && staged < applyAt) || /apply_artifacts|install -o|fresh_operational_state/.test(instCode.slice(instCode.lastIndexOf('stage "$TMPM"'), staged))) problems.push(`${at('install-topology-monitor.sh')}: the transaction is recorded before any artifact is applied; ${why}`);
  for (const needle of ['if absent "$STATE_DIR/state"; then', 'if absent "$LATCH"; then', 'if absent "$INCIDENT_FILE"; then']) {
    if (!instCode.includes(needle)) problems.push(`${at('install-topology-monitor.sh')}: protected state is created only when absent, never replaced (${needle}); ${why}`);
  }
  if (/recovery-consumed|incidents\.jsonl|TRUSTED_SIGNERS|recovery-allowed-signers/.test(instCode)) problems.push(`${at('install-topology-monitor.sh')}: the installer never touches the nonce ledger, the incident history or the recovery trust key; ${why}`);
  if (/\bsystemctl\b/.test(instCode)) problems.push(`${at('install-topology-monitor.sh')}: the installer never enables, starts or reloads a unit; ${why}`);
  if (/nawara-core-topology-alert\/|pushover|healthchecks/i.test(instCode) || TOPOLOGY_MONITOR_ARTIFACTS.some((a) => /pushover|healthchecks|token|credential/i.test(a))) problems.push(`${at('install-topology-monitor.sh')}: no carrier credential is ever an artifact or installed by the installer (OD-BRK-2b-A); ${why}`);
  const verForbidden = /(^|[;&|(\s])(rm|mv|cp|ln|mkdir|rmdir|touch|chmod|chown|chgrp|install|tee|truncate|dd|sed\s+-i|docker|service|curl|wget|nc|scp|sftp|rsync|eval|source|sudo|su|crontab)(?=\s|$)/m.exec(verCode);
  if (verForbidden) problems.push(`${at('verify-topology-monitor-install.sh')}: must stay read-only (found "${verForbidden[2]}"); ${why}`);
  if (/(^|[^0-9&])>{1,2}[ \t]*[^ \t\n&(/]/.test(verCode.replace(/[0-9]?>\s*\/dev\/null|[0-9]?>&[0-9]/g, '').replace(/'[^'\n]*'|"[^"\n]*"/g, 'S'))) problems.push(`${at('verify-topology-monitor-install.sh')}: must write no file; ${why}`);
  if (!/"\$SYSTEMCTL" is-enabled/.test(verCode) || /"\$SYSTEMCTL" (enable|start|stop|disable|daemon-reload|restart|mask|unmask)/.test(verCode)) problems.push(`${at('verify-topology-monitor-install.sh')}: may only read units' enablement (never change it); ${why}`);
  // OD-BRK-2b-A: the external alert carrier (A5-R3's providers and acceptance rules), isolated and never on the containment path
  const car = files['topology-alert-carrier.sh'];
  const carCode = car.replace(/(^|\s)#(\s.*)?$/gm, '');
  const whyA = 'the external alert carrier follows OD-BRK-2b-A (docs/runbooks/rabbitmq-topology-containment.md §7)';
  if (pinOf(car, 'PUSHOVER_URL') !== TOPOLOGY_ALERT_PUSHOVER_URL || pinOf(car, 'HC_URL_RE') !== TOPOLOGY_ALERT_HC_URL_RE || pinOf(ver, 'HC_URL_RE') !== TOPOLOGY_ALERT_HC_URL_RE || pinOf(car, 'CA_FILE') !== '') {
    problems.push(`${at('topology-alert-carrier.sh')}: the provider endpoints are A5-R3's fixed HTTPS endpoints (${TOPOLOGY_ALERT_PUSHOVER_URL}, hc-ping.com) with the system trust store (CA_FILE=''); ${whyA}`);
  }
  const carForbidden = /(^|[;&|(\s])(docker|rabbitmqctl|systemctl|sudo|eval|source|wget|nc)(?=\s|$)/m.exec(carCode);
  if (carForbidden) problems.push(`${at('topology-alert-carrier.sh')}: the carrier never administers the broker or a unit (found "${carForbidden[2]}"); ${whyA}`);
  const curls = carCode.match(/\bcurl -q[^\n]*(\n[^\n]*){0,1}/g) ?? [];
  if (curls.length !== 2 || curls.some((c) => !c.includes('--config -') || !c.includes("--proto '=https'") || !c.includes("--proto-redir '=https'") || !c.includes('--max-redirs 0') || /\s(-k|-x)\s/.test(c.slice(c.indexOf('curl')))) || /\binsecure\b|\bproxy\b|--cacert|capath/i.test(carCode)) {
    problems.push(`${at('topology-alert-carrier.sh')}: every provider call is curl --config - (secrets on stdin only), HTTPS only, certificate verification on, no redirect; ${whyA}`);
  }
  if (carCode.split('\n').some((l) => /\$\{?(STATE_DIR|SPOOL)\b/.test(l) && /(^|[\s;&|(])(mv|rm|chmod|chown|touch|truncate|tee|ln|install|mkdir|flock)\s|>>?\s*"?\$\{?(STATE_DIR|SPOOL)/.test(l)) || /STATE_DIR\/lock|nawara-auth-readiness-alert/.test(carCode)) {
    problems.push(`${at('topology-alert-carrier.sh')}: the carrier only READS the producers' spool and records: it never writes there, never takes the monitor's lock and never touches the Auth carrier; ${whyA}`);
  }
  for (const code of TOPOLOGY_ALERT_CODES) if (!new RegExp(`\\[${code}\\]=(critical|warning|info)`).test(car)) problems.push(`${at('topology-alert-carrier.sh')}: the event contract must define ${code}; ${whyA}`);
  if ((carCode.match(/M_STATUS=0\b/g) ?? []).length !== 1 || !carCode.includes('none:PASS) M_STATUS=0 ;;') || (carCode.match(/W_STATUS=0\b/g) ?? []).length !== 1 || !carCode.includes('ok | contained) W_STATUS=0 ;;')) {
    problems.push(`${at('topology-alert-carrier.sh')}: a success heartbeat (exit status 0) is only a monitor PASS without containment, or a watchdog run that found no problem; ${whyA}`);
  }
  const fresh = carCode.indexOf('if [ $((NOW - run)) -gt "$HB_FRESH" ]; then'); const pinged = carCode.indexOf('if ping_check "$url" "$status"; then');
  if (fresh < 0 || pinged < 0 || fresh > pinged || !carCode.includes('if [ "$run" -le "${!sent}" ]; then')) problems.push(`${at('topology-alert-carrier.sh')}: a heartbeat is sent only for a NEW run that completed within HB_FRESH (never fabricated, never an old run); ${whyA}`);
  for (const n of ['verify-and-contain.sh', 'topology-watchdog.sh', 'recover-notification-topology.sh']) {
    if (/\b(curl|wget)\b|topology-alert-carrier|nawara-core-topology-alert|pushover|healthchecks/i.test(files[n].replace(/^\s*#.*$/gm, ''))) problems.push(`${at(n)}: never calls the network or the carrier (containment never waits for an alert); ${whyA}`);
  }
  const au = files['nawara-core-topology-alert.service'];
  const auNeeds = ['ExecStart=/usr/local/libexec/nawara-core-topology/topology-alert-carrier.sh', 'CapabilityBoundingSet=', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'StateDirectory=nawara-core-topology-alert',
    'InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/run/containerd -/var/lib/docker -/var/lib/containerd -/opt/nawara-core', 'InaccessiblePaths=-/etc/nawara-auth-readiness-alert -/var/lib/nawara-auth-readiness-alert',
    ...['pushover.token', 'pushover.user', 'healthchecks-monitor.url', 'healthchecks-watchdog.url'].map((c) => `LoadCredential=${c}:/etc/nawara-core-topology-alert/${c}`)];
  if (auNeeds.some((d) => !au.split('\n').includes(d)) || /^(User|DynamicUser|Group|ReadWritePaths|Environment|EnvironmentFile|PassEnvironment|SupplementaryGroups)=/m.test(au) || (au.match(/^LoadCredential=/gm) ?? []).length !== 4) {
    problems.push(`${at('nawara-core-topology-alert.service')}: no capability, no broker or Auth carrier path, no environment, no writable path but its own state, exactly its four credentials; ${whyA}`);
  }
  if (!/^OnUnitActiveSec=60$/m.test(files['nawara-core-topology-alert.timer'])) problems.push(`${at('nawara-core-topology-alert.timer')}: the carrier runs every 60 s; ${whyA}`);
  if (pinOf(car, 'SCRIPTS') !== pinOf(inst, 'SCRIPTS') || pinOf(car, 'UNITS') !== pinOf(inst, 'UNITS')) problems.push(`${at('topology-alert-carrier.sh')}: SCRIPTS and UNITS (its integrity sentinel) must equal the installer's; ${whyA}`);
  // the containment sequence and the state machine
  const m = files['verify-and-contain.sh'];
  const contain = m.slice(m.indexOf('contain() { # contain <reason>'), m.indexOf('\n}\n', m.indexOf('contain() { # contain <reason>')));
  const order = ['if [ "$ST_INCIDENT" = none ]; then', 'save_state ', 'persist_incident ', 'persist_latch ', 'revoke', 'close_all_user_connections', 'if confirm; then', 'if confirm; then CONTAINMENT=confirmed'].map((s) => contain.indexOf(s));
  if (order.some((i) => i < 0) || order.some((i, k) => k > 0 && i <= order[k - 1])) problems.push(`${at('verify-and-contain.sh')}: containment must create an incident only when there is none, persist the intent (state, incident binding, then latch) before revoking, then close connections, then confirm twice; ${why}`);
  const started = contain.indexOf('if [ "$NEW_CONTAINMENT" = 1 ]; then alert critical containment_started "$1"; fi');
  if (started < 0 || started < contain.indexOf('persist_latch ') || started > contain.indexOf('revoke')) problems.push(`${at('verify-and-contain.sh')}: a new containment is recorded locally (containment_started) after its intent is persisted and before the broker changes (OD-BRK-2b-A); ${why}`);
  if (!/^new_incident\(\) \{[\s\S]*?head -c 16 \/dev\/urandom[\s\S]*?^\}/m.test(m)) problems.push(`${at('verify-and-contain.sh')}: an incident id comes from /dev/urandom (OD-BRK-2b-R); ${why}`);
  // OD-BRK-2b-R: the signed, incident-bound, single-use recovery
  const rec = files['recover-notification-topology.sh'];
  const recCode = rec.replace(/^\s*#.*$/gm, '');
  const recIdx = (needle) => recCode.indexOf(needle);
  if (!rec.includes('[ "$#" -eq 0 ] || usage ')) problems.push(`${at('recover-notification-topology.sh')}: recovery takes no argument (nothing a caller passes selects a file, a service or a vhost); ${why}`);
  if (/\bread -r\b|RECOVER \$SERVICE/.test(recCode)) problems.push(`${at('recover-notification-topology.sh')}: no typed-reference authorization (the signature is the only authorization); ${why}`);
  if (!recCode.includes('ssh-keygen -Y verify -f "$TRUSTED_SIGNERS" -I "$PRINCIPAL" -n "$NAMESPACE" -s "$WORK/authorization.sig" <"$WORK/authorization"')) problems.push(`${at('recover-notification-topology.sh')}: the authorization is verified with ssh-keygen -Y verify against the pinned trusted key, principal and namespace, on its private copy; ${why}`);
  if (pinOf(rec, 'SIGNER_RE') !== '^nawara-core-owner namespaces="nawara-core-topology-recovery" (ssh-ed25519|sk-ssh-ed25519@openssh\\.com) [A-Za-z0-9+/]{40,400}={0,2}$') problems.push(`${at('recover-notification-topology.sh')}: the trusted key must be exactly one line for the exact principal, restricted to the namespace (ssh-keygen accepts wildcard principals); ${why}`);
  if (!/^readonly MAX_VALIDITY=([1-9][0-9]{0,3})$/m.test(rec) || Number(pinOf(rec, 'MAX_VALIDITY')) > 3600) problems.push(`${at('recover-notification-topology.sh')}: MAX_VALIDITY must be at most 3600 seconds; ${why}`);
  if (!recCode.includes('[ "$A_INCIDENT" = "$INCIDENT" ] || stop authorization_incident') || !recCode.includes('[ "$NOW" -le "$A_NOT_AFTER" ] || stop authorization_expired')) problems.push(`${at('recover-notification-topology.sh')}: the authorization must name the current incident and be unexpired; ${why}`);
  const consume = recIdx('>>"$CONSUMED" && chmod 600 -- "$CONSUMED" && sync -- "$CONSUMED"');
  const replay = recIdx('! grep -qF " nonce=$A_NONCE " -- "$CONSUMED" || stop authorization_replay');
  const clearState = recIdx('contained=0\\nincident=none');
  const clearLatch = recIdx('write_atomic "$LATCH" "$LATCH_INACTIVE" 644');
  if (replay < 0 || consume < 0 || !(replay < consume && consume < clearState && clearState < clearLatch)) problems.push(`${at('recover-notification-topology.sh')}: a consumed nonce is refused, and the nonce is durably consumed before the state and then the latch are cleared; ${why}`);
  if (!/^readonly MAX_ATTEMPTS=[1-5]$/m.test(m)) problems.push(`${at('verify-and-contain.sh')}: MAX_ATTEMPTS must be a small bound (1 to 5); ${why}`);
  if (!m.includes('if [ "$ST_STREAK" -ge 3 ]; then') || !/FAIL\)\n\s*NEW_CONTAINMENT=1\n\s*contain verifier_fail ;;/.test(m)) problems.push(`${at('verify-and-contain.sh')}: a FAIL contains at once and the third consecutive UNKNOWN contains; ${why}`);
  if (/set_permissions|set_topic_permissions|delete_queue|purge_queue|delete_user/.test(m.replace(/^\s*#.*$/gm, '')) || /set_permissions|set_topic_permissions|delete_queue|purge_queue|delete_user/.test(files['recover-notification-topology.sh'].replace(/^\s*#.*$/gm, ''))) {
    problems.push(`${TOPOLOGY_MONITOR_DIR}: the monitor and the recovery guard never grant, purge or delete; ${why}`);
  }
  for (const n of ['verify-and-contain.sh', 'topology-watchdog.sh', 'topology-trigger.sh', 'recover-notification-topology.sh']) {
    const uses = (files[n].replace(/^\s*#.*$/gm, '').match(/SSH_ORIGINAL_COMMAND/g) ?? []).length;
    if (uses !== 1 || !/\[ -z "\$\{SSH_ORIGINAL_COMMAND:-\}" \]/.test(files[n])) problems.push(`${at(n)}: SSH_ORIGINAL_COMMAND is only ever tested for emptiness, then refused; ${why}`);
  }
  // the trigger and its templates
  const t = files['topology-trigger.sh'];
  if (pinOf(t, 'SUDO') !== '/usr/bin/sudo' || pinOf(t, 'MONITOR_SERVICE') !== 'nawara-core-topology-monitor.service' || !/^env -i PATH="\$PATH" "\$SUDO" -n \/usr\/bin\/systemctl start "\$MONITOR_SERVICE" \|\| rc=\$\?$/m.test(t)) {
    problems.push(`${at('topology-trigger.sh')}: the trigger can only start ${'nawara-core-topology-monitor.service'} through sudo -n, with an empty environment; ${why}`);
  }
  if (!t.includes('[ "$EUID" -ne 0 ] || refuse 65 ')) problems.push(`${at('topology-trigger.sh')}: the trigger must refuse to run as root; ${why}`);
  const lines = (n) => files[n].split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const key = 'restrict,command="/usr/local/libexec/nawara-core-topology/topology-trigger.sh" ssh-ed25519 REPLACE_WITH_THE_TOPOLOGY_TRIGGER_PUBLIC_KEY nawara-core-topology-trigger';
  if (lines('topology-trigger.authorized_keys.template').join('\n') !== key || /AAAA[0-9A-Za-z+/]{20,}/.test(files['topology-trigger.authorized_keys.template'])) problems.push(`${at('topology-trigger.authorized_keys.template')}: must hold exactly one line, ${key}; ${why}`);
  const rule = 'REPLACE_WITH_THE_RUNTIME_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start nawara-core-topology-monitor.service';
  if (lines('topology-trigger.sudoers.template').join('\n') !== `Defaults!/usr/bin/systemctl env_reset\n${rule}`) problems.push(`${at('topology-trigger.sudoers.template')}: must hold exactly the one rule, ${rule}; ${why}`);
  // the units
  const unit = (n) => files[n];
  if (!/^ExecStart=\/usr\/local\/libexec\/nawara-core-topology\/verify-and-contain\.sh notification-service$/m.test(unit('nawara-core-topology-monitor.service'))
    || !/^SuccessExitStatus=10 20$/m.test(unit('nawara-core-topology-monitor.service')) || /^StateDirectory=/m.test(unit('nawara-core-topology-monitor.service'))) {
    problems.push(`${at('nawara-core-topology-monitor.service')}: must run the pinned entry for notification-service, count only 10 and 20 as success, and never create its state (no StateDirectory=); ${why}`);
  }
  if (!/^ExecStart=\/usr\/local\/libexec\/nawara-core-topology\/topology-watchdog\.sh$/m.test(unit('nawara-core-topology-watchdog.service'))) problems.push(`${at('nawara-core-topology-watchdog.service')}: must run the pinned watchdog; ${why}`);
  if (!/^OnUnitActiveSec=5min$/m.test(unit('nawara-core-topology-monitor.timer')) || !/^OnUnitActiveSec=5min$/m.test(unit('nawara-core-topology-watchdog.timer'))) problems.push(`${TOPOLOGY_MONITOR_DIR}: both timers run every 5 minutes; ${why}`);
  // inert in the repository: no workflow installs, enables or starts it
  for (const [name, text] of Object.entries(workflows)) {
    if (/topology-monitor|nawara-core-topology|verify-and-contain|recover-notification-topology/.test(text)) problems.push(`.github/workflows/${name}: must not install, enable or start the topology monitor (OD-BRK-2b-2 is a separately authorized installation); ${why}`);
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────── V2 A5.4-T1: the Auth → Organization Service dependency boundary

/**
 * V2 A5.4-T1 (ADR-0042 decision 8 with ADR-0040 decision 2; ADR-0063 §5): auth-service reaches Organization Service synchronously
 * from a short, reviewed list of ADMINISTRATIVE operations only. Everything else in Auth (login and logout, session validation and
 * refresh, registration and join, invitation consumption and onboarding resolution, `/auth/me` and `/auth/grants`, the member-access
 * and platform-access reads, ADR-0023's local reference reads, ordinary authentication paths) never does.
 *
 * The rule is an allowlist, so a new path is refused until it is reviewed here:
 *   - one module holds the client (`AUTH_ORGANIZATION_CLIENT`); only the wiring module and the operations below may import it;
 *   - in each holder, only the operation's own method may touch the client (a holder also serves never-call paths: `OnboardingService`
 *     resolves and redeems join codes for registration, and creates them for administrators);
 *   - each operation is called from its approved call sites only, which closes the indirect paths one hop at a time;
 *   - no class or interface extends a holder or an approved controller, directly or through other auth-service classes (an import
 *     alias, a namespace import, a re-export and a mixin expression that names the class are followed), so an operation cannot be
 *     inherited and called as `super.create()` or `this.create()`; the inheritance is refused even when the subclass calls nothing yet;
 *   - no other Auth module opens an outbound HTTP client or reads Auth's Organization Service credential.
 * ADR-0060's E5 lifecycle reads and ADR-0061's reference repair are approved dependencies that do not exist yet: each adds its entry
 * here when it is implemented.
 *
 * What counts as "an instance of a holder or of an approved controller" (the SUPPORTED forms; a call through any of them is held to
 * the approved callers):
 *   - a parameter, a parameter property, a class property or a variable whose DECLARATION names the class: by its type, by
 *     `@Inject(Name)`, by `x.get(Name)` / `x.resolve(Name)`, by `new Name()`, or by a cast in its initializer;
 *   - the name may be the class, a subclass, an import alias (`import { X as Y }`), `namespace.Name`, a type alias of any of these in
 *     the same file or imported (through re-exports and alias chains), `typeof Name` / `InstanceType<typeof Name>`, a generic
 *     constraint (`<T extends Name>`), and it may sit inside a union, an intersection or a type argument (`Pick<Name, 'm'>`);
 *   - a receiver cast on the spot: `(x as Name).create()`, `(x as unknown as Name)`, `(<Name>x)`;
 *   - `this.member` and `super.member` inside a subclass, and `this.handler` inside the approved controller itself.
 *
 * Limits (the check reads syntax; it runs no type checker and no service, and it does not follow where a value flows):
 *   - an instance that reaches the call without such a declaration is not seen: an untyped or `any` variable, the result of a getter,
 *     a method or a function (even one with a declared return type), a property of another object (`deps.service`), a destructured
 *     parameter or receiver, an indexed access type (`Deps['service']`), and a class kept in a variable (`const C = OnboardingService`);
 *   - computed member access (`service[name]`), a method detached from its receiver, a container lookup by string token,
 *     `Name.prototype.method.call(…)` and other reflection are not seen;
 *   - a variable or parameter holding a service is matched by its name within one file, not by its scope;
 *   - inheritance is followed through static `extends` clauses only: a base class chosen by a computed expression that does not name it,
 *     a prototype assigned at run time (`Object.setPrototypeOf`, `Object.create`) and composition that copies methods are not seen;
 *   - an approved handler is recognized by its class and method, not by its route decorator;
 *   - an outbound client is recognized as a direct `fetch` call or an import of a listed module; one opened inside a dependency, or
 *     through an alias of `fetch`, is not;
 *   - test sources (`*.spec.ts`, `apps/auth-service/test/`) are out of scope.
 * The check narrows what a reviewer must look for; it does not prove that no runtime path to Organization Service exists.
 */
const AUTH_SRC = 'apps/auth-service/src/';
export const AUTH_ORGANIZATION_CLIENT = `${AUTH_SRC}hierarchy/hierarchy-reference.ts`;
/** Dependency-injection wiring: it provides the client and calls nothing. */
export const AUTH_ORGANIZATION_WIRING = `${AUTH_SRC}app.module.ts`;
/** `owner: null` is an exported function; otherwise `owner.member` is a class method. `callers`: `file#Class.method` or `file#<module>`. */
export const AUTH_ORGANIZATION_OPERATIONS = [
  { operation: 'join-code creation', holder: `${AUTH_SRC}onboarding/onboarding.service.ts`, owner: 'OnboardingService', member: 'create',
    callers: [`${AUTH_SRC}membership/organization.controller.ts#OrganizationController.createJoinCode`] },
  { operation: 'organization-admin invitation creation', holder: `${AUTH_SRC}onboarding/invitation.service.ts`, owner: 'InvitationService', member: 'create',
    callers: [`${AUTH_SRC}membership/organization.controller.ts#OrganizationController.createInvitation`] },
  { operation: 'operator platform-assignment grant', holder: `${AUTH_SRC}platform/assignment.service.ts`, owner: 'AssignmentService', member: 'grant',
    callers: [`${AUTH_SRC}platform/platform.controller.ts#PlatformController.grant`] },
  { operation: 'owner bootstrap (command line)', holder: `${AUTH_SRC}cli/owner-tools.ts`, owner: null, member: 'bootstrapOwner',
    callers: [`${AUTH_SRC}cli/main.ts#<module>`] },
  // A5.4-A3 (ADR-0061; §9.3 A.1): the Owner's hierarchy reference repair, the one entry this exception adds.
  { operation: 'hierarchy reference repair', holder: `${AUTH_SRC}hierarchy/reference-repair.service.ts`, owner: 'ReferenceRepairService', member: 'repair',
    callers: [`${AUTH_SRC}hierarchy/reference-repair.controller.ts#ReferenceRepairController.repair`] },
];
/** A call site that hands the client itself to an operation (the command line resolves it from the application context). */
export const AUTH_ORGANIZATION_CLIENT_PASSERS = { [`${AUTH_SRC}cli/main.ts`]: ['<module>'] };
/**
 * The never-call paths, named so that no future edit can list one of them as an approved caller. `modules` are never-call as a whole;
 * `contexts` are the never-call methods of a module that also holds an approved operation.
 */
export const AUTH_NEVER_CALL = {
  modules: ['auth/auth.controller.ts', 'auth/auth.service.ts', 'auth/auth.guard.ts', 'auth/session.service.ts', 'auth/grants.service.ts',
    'tokens/refresh-token.service.ts', 'tokens/token.service.ts', 'onboarding/onboarding.controller.ts', 'platform/platform-access.service.ts',
    'owner/owner-auth.service.ts', 'operator/operator-code.service.ts'].map((rel) => AUTH_SRC + rel),
  contexts: [
    ...['guardGuessing', 'lookup', 'resolve', 'redeem'].map((m) => `${AUTH_SRC}onboarding/onboarding.service.ts#OnboardingService.${m}`),
    ...['lookup', 'resolve', 'accept'].map((m) => `${AUTH_SRC}onboarding/invitation.service.ts#InvitationService.${m}`),
    ...['platformAccess', 'organization'].map((m) => `${AUTH_SRC}platform/platform.controller.ts#PlatformController.${m}`),
  ],
};
/** Modules through which Node code opens an outbound HTTP or socket client. */
const OUTBOUND_CLIENT_MODULES = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'undici', 'axios', 'got', 'node-fetch', 'superagent', 'needle']);
const AUTH_ORGANIZATION_CREDENTIAL_READERS = new Set([AUTH_ORGANIZATION_CLIENT, AUTH_ORGANIZATION_WIRING, `${AUTH_SRC}config/app-config.ts`]);
const ORGANIZATION_CREDENTIAL_NAME = /^ORGANIZATION_SERVICE_(?:URL|TOKEN)$/;
const BOUNDARY_RULE = 'ADR-0042 decision 8, ADR-0063 §5';
const DECLARATION = '<declaration>';
const MODULE_SCOPE = '<module>';

const strip = (node) => {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression?.(n) || ts.isSatisfiesExpression?.(n))) n = n.expression;
  return n;
};
/** A relative specifier of a TypeScript source (`./x.js`) as the repository path of that source. */
function resolveSourceSpecifier(fromPath, spec) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return undefined;
  const parts = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join('/');
  return /\.[cm]?js$/.test(joined) ? joined.replace(/\.([cm]?)js$/, '.$1ts') : /\.[cm]?ts$/.test(joined) ? joined : `${joined}.ts`;
}
const className = (node) => (node.name ? node.name.text : '<anonymous class>');
const memberName = (node) => (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) || ts.isPrivateIdentifier(node.name)) ? node.name.text : '<computed>');
/** The outermost named scope a node sits in: `Class.member`, a top-level function or variable, `<module>`, or `<declaration>`. */
function boundaryContext(node) {
  let scope = MODULE_SCOPE;
  for (let n = node.parent, child = node; n; child = n, n = n.parent) {
    if (ts.isParameter(n) && n.parent && ts.isConstructorDeclaration(n.parent)) return DECLARATION; // a constructor parameter declares, it does not call
    if (ts.isPropertyDeclaration(n) && n.type === child) return DECLARATION; // the declared type of a member
    if (ts.isClassLike(n.parent ?? n) && (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isPropertyDeclaration(n))) scope = `${className(n.parent)}.${memberName(n)}`;
    else if (ts.isConstructorDeclaration(n)) scope = `${className(n.parent)}.constructor`;
    else if (ts.isFunctionDeclaration(n) && n.name) scope = n.name.text;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) scope = n.name.text;
  }
  return scope;
}
/** Every context a source file declares: `Class.member` and top-level function names. */
function declaredContexts(sf) {
  const out = new Set([MODULE_SCOPE]);
  const visit = (node) => {
    if (ts.isClassLike(node)) for (const m of node.members) if (!ts.isConstructorDeclaration(m)) out.add(`${className(node)}.${memberName(m)}`);
    if (ts.isFunctionDeclaration(node) && node.name) out.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
/** Local names a file imports from `target` (a repository path), as local name -> imported name (`*` for a namespace import). */
function importedFrom(relPath, sf, target) {
  const names = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || resolveSourceSpecifier(relPath, staticSpecifier(st.moduleSpecifier)) !== target || !st.importClause) continue;
    if (st.importClause.name) names.set(st.importClause.name.text, 'default');
    const bindings = st.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.set(bindings.name.text, '*');
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.set(el.name.text, (el.propertyName ?? el.name).text);
  }
  return names;
}
const isNamePosition = (node) => {
  const p = node.parent;
  return !p || (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isQualifiedName(p) && p.right === node)
    || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isBindingElement(p)) && (p.name === node || p.propertyName === node))
    || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);
};
/** `Name` or `namespace.Name`, as written in a type (`QualifiedName`) or in an expression (`PropertyAccessExpression`). */
const dottedName = (node) => {
  if (!node) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  const left = ts.isQualifiedName(node) ? node.left : ts.isPropertyAccessExpression(node) ? node.expression : undefined;
  const right = ts.isQualifiedName(node) ? node.right : ts.isPropertyAccessExpression(node) ? node.name : undefined;
  const base = left && dottedName(left);
  return base && right && ts.isIdentifier(right) ? `${base}.${right.text}` : undefined;
};
/** A dotted name and its first segment: `ns.Name` also answers for `ns` (a namespace import of the module that declares the class). */
const nameForms = (text) => (text === undefined ? [] : text.includes('.') ? [text, text.slice(0, text.indexOf('.'))] : [text]);
/**
 * The names a type stands for: its type references and `typeof` queries, through unions, intersections and type arguments
 * (`Pick<X, 'm'>`, `InstanceType<typeof X>`, `Promise<X>`). The members of an object type, the parameters of a function type and the
 * elements of an array are not what the value itself is, so they are not read.
 */
const typeNames = (type) => {
  const out = [];
  const visit = (n) => {
    if (ts.isTypeLiteralNode(n) || ts.isFunctionTypeNode(n) || ts.isConstructorTypeNode(n) || ts.isMappedTypeNode(n) || ts.isArrayTypeNode(n) || ts.isTupleTypeNode(n)) return;
    if (ts.isTypeReferenceNode(n)) out.push(...nameForms(dottedName(n.typeName)));
    if (ts.isTypeQueryNode(n)) out.push(...nameForms(dottedName(n.exprName)));
    ts.forEachChild(n, visit);
  };
  if (type) visit(type);
  return out;
};
const namesExpression = (expr, names) => nameForms(dottedName(strip(expr))).some((n) => names.has(n));
/** Is the expression asserted to be one of `names`: `x as Name`, `<Name>x`, `x as unknown as Name`? */
function castsTo(expr, names) {
  for (let n = expr; n; n = n.expression) {
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression?.(n)) && typeNames(n.type).some((t) => names.has(t))) return true;
    if (!(ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression?.(n) || ts.isSatisfiesExpression?.(n))) return false;
  }
  return false;
}
/** Does a declaration (parameter, property, variable) hold one of `names`: by its type, by `@Inject(Name)`, or by `x.get(Name)` / `new Name()`? */
function declaresInstanceOf(decl, names) {
  const declared = typeNames(decl.type);
  if (declared.some((n) => names.has(n))) return true;
  // A type parameter stands for its constraint: `<T extends OnboardingService>(service: T)`.
  for (let scope = decl.parent; scope && declared.length > 0; scope = scope.parent) {
    for (const parameter of scope.typeParameters ?? []) {
      if (declared.includes(parameter.name.text) && typeNames(parameter.constraint).some((n) => names.has(n))) return true;
    }
  }
  for (const d of (ts.canHaveDecorators?.(decl) ? ts.getDecorators(decl) : undefined) ?? []) {
    const call = d.expression;
    if (ts.isCallExpression(call) && call.arguments.some((a) => namesExpression(a, names))) return true;
  }
  return decl.initializer ? yieldsInstanceOf(decl.initializer, names) : false;
}
function yieldsInstanceOf(expr, names) {
  if (castsTo(expr, names)) return true;
  let e = strip(expr);
  if (e && ts.isAwaitExpression(e)) {
    if (castsTo(e.expression, names)) return true;
    e = strip(e.expression);
  }
  if (!e) return false;
  if (ts.isNewExpression(e)) return namesExpression(e.expression, names);
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['get', 'resolve', 'create'].includes(e.expression.name.text)
    && e.arguments.some((a) => namesExpression(a, names));
}
/** Members of the file's classes, and variables and parameters, that hold an instance of one of `names`. */
function instanceHolders(sf, names) {
  const members = new Set();
  const locals = new Set();
  if (names.size === 0) return { members, locals };
  const visit = (node) => {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && declaresInstanceOf(node, names)) {
      const property = ts.isConstructorDeclaration(node.parent) && (ts.getModifiers(node) ?? []).length > 0;
      (property ? members : locals).add(node.name.text);
      if (property) locals.add(node.name.text); // a parameter property is also a local of the constructor
    } else if (ts.isPropertyDeclaration(node) && declaresInstanceOf(node, names)) members.add(memberName(node));
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && declaresInstanceOf(node, names)) locals.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { members, locals };
}
/** Is `expr` an instance of one of `names` in this file: `this.member`, a holding local, `x.get(Name)`, or anything cast to `Name`? */
function isInstanceExpression(expr, names, holders) {
  if (castsTo(expr, names)) return true;
  const e = strip(expr);
  if (!e) return false;
  if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) return holders.members.has(e.name.text);
  if (ts.isIdentifier(e)) return holders.locals.has(e.text);
  return yieldsInstanceOf(e, names);
}
const enclosingClass = (node) => {
  for (let n = node.parent; n; n = n.parent) if (ts.isClassLike(n)) return n;
  return undefined;
};
/** A class's name: its own, or the variable a class expression is assigned to. */
const declaredClassName = (node) => node.name?.text ?? (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined);
/** Every local name a file imports from another source: local name -> { target, imported } (`*` for a namespace import). */
function sourceImports(relPath, sf) {
  const out = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const target = resolveSourceSpecifier(relPath, staticSpecifier(st.moduleSpecifier));
    if (!target) continue;
    if (st.importClause.name) out.set(st.importClause.name.text, { target, imported: 'default' });
    const bindings = st.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) out.set(bindings.name.text, { target, imported: '*' });
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.set(el.name.text, { target, imported: (el.propertyName ?? el.name).text });
  }
  return out;
}
/**
 * The classes of a set of sources (`file#Class`) with what each `extends`, resolved statically: a class of the same file, an imported
 * class (through an alias, a namespace import or a re-export), and every class named inside a mixin expression (`extends Mixin(Base)`).
 */
function classGraph(parsed) {
  const classes = new Map();
  const aliases = new Map(); // `file#Alias` -> the names its type stands for (`type A = OnboardingService`, `InstanceType<typeof X>`)
  const imports = new Map();
  for (const [rel, sf] of parsed) {
    imports.set(rel, sourceImports(rel, sf));
    const visit = (node) => {
      if (ts.isTypeAliasDeclaration(node)) aliases.set(`${rel}#${node.name.text}`, { file: rel, name: node.name.text, refs: typeNames(node.type) });
      // An interface that extends a class inherits its members as a type, so it is part of the same graph.
      const name = ts.isClassLike(node) ? declaredClassName(node) : ts.isInterfaceDeclaration(node) ? node.name.text : undefined;
      if (name) {
        const bases = (node.heritageClauses ?? []).filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword).flatMap((h) => h.types.map((t) => t.expression));
        classes.set(`${rel}#${name}`, { file: rel, name, kind: ts.isInterfaceDeclaration(node) ? 'interface' : 'class', bases });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const declared = (key) => classes.has(key) || aliases.has(key);
  const resolveLocal = (file, local, seen = new Set()) => {
    if (declared(`${file}#${local}`)) return `${file}#${local}`;
    const imp = imports.get(file)?.get(local);
    return imp && imp.imported !== '*' ? resolveExport(imp.target, imp.imported, seen) : undefined;
  };
  /** `Name`, or `namespace.Name` through a namespace import. */
  const resolveName = (file, text) => {
    if (!text.includes('.')) return resolveLocal(file, text);
    const [space, name, ...deeper] = text.split('.');
    const imp = imports.get(file)?.get(space);
    return imp?.imported === '*' && deeper.length === 0 ? resolveExport(imp.target, name) : undefined;
  };
  const resolveExport = (file, name, seen = new Set()) => {
    const sf = parsed.get(file);
    const key = `${file}#${name}`;
    if (!sf || seen.has(key)) return undefined;
    seen.add(key);
    if (name !== 'default' && declared(key)) return key;
    for (const st of sf.statements) {
      if (name === 'default') {
        if (ts.isExportAssignment(st) && ts.isIdentifier(strip(st.expression))) return resolveLocal(file, strip(st.expression).text, seen);
        if (ts.isClassDeclaration(st) && st.name && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) return `${file}#${st.name.text}`;
      }
      if (!ts.isExportDeclaration(st)) continue;
      const target = st.moduleSpecifier ? resolveSourceSpecifier(file, staticSpecifier(st.moduleSpecifier)) : undefined;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        const el = st.exportClause.elements.find((e) => e.name.text === name);
        if (!el) continue;
        const original = (el.propertyName ?? el.name).text;
        const found = st.moduleSpecifier ? target && resolveExport(target, original, seen) : resolveLocal(file, original, seen);
        if (found) return found;
      } else if (!st.exportClause && target) { // export * from './x.js'
        const found = resolveExport(target, name, seen);
        if (found) return found;
      }
    }
    return undefined;
  };
  const resolveBases = (file, expression) => {
    const out = [];
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && imports.get(file)?.get(node.expression.text)?.imported === '*') {
        const found = resolveExport(imports.get(file).get(node.expression.text).target, node.name.text);
        if (found) out.push(found);
        return;
      }
      if (ts.isIdentifier(node) && !isNamePosition(node)) {
        const found = resolveLocal(file, node.text);
        if (found) out.push(found);
      }
      ts.forEachChild(node, visit);
    };
    visit(expression);
    return out;
  };
  return { classes, aliases, imports, resolveLocal, resolveName, resolveExport, resolveBases };
}

/**
 * `sources`: every non-test TypeScript source of auth-service (`apps/auth-service/src/**`), repository path -> text.
 * Syntactic and deterministic; its limits are listed with the policy above.
 */
export function checkAuthOrganizationBoundary(sources) {
  const problems = [];
  const files = Object.keys(sources ?? {}).filter((rel) => rel.startsWith(AUTH_SRC) && /\.ts$/.test(rel) && !/\.spec\.ts$|\.d\.ts$/.test(rel)).sort();
  if (files.length === 0) return ['auth-service sources were not found; the Auth → Organization Service boundary cannot be checked'];
  const parsed = new Map(files.map((rel) => [rel, ts.createSourceFile(rel, sources[rel], ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)]));
  const short = (rel) => rel.slice(AUTH_SRC.length);

  // 0. The policy still describes the code: a renamed file or method must not silently drop out of the rule.
  const holderContexts = new Map(); // holder file -> contexts that may touch the client
  for (const op of AUTH_ORGANIZATION_OPERATIONS) holderContexts.set(op.holder, [...(holderContexts.get(op.holder) ?? []), op.owner ? `${op.owner}.${op.member}` : op.member]);
  for (const [file, contexts] of Object.entries(AUTH_ORGANIZATION_CLIENT_PASSERS)) holderContexts.set(file, [...(holderContexts.get(file) ?? []), ...contexts]);
  const approved = [...[...holderContexts].flatMap(([file, contexts]) => contexts.map((c) => `${file}#${c}`)), ...AUTH_ORGANIZATION_OPERATIONS.flatMap((op) => op.callers)];
  const exists = (key) => {
    const [file, context] = key.split('#');
    return parsed.has(file) && (context === undefined || declaredContexts(parsed.get(file)).has(context));
  };
  for (const file of [AUTH_ORGANIZATION_CLIENT, AUTH_ORGANIZATION_WIRING]) if (!parsed.has(file)) problems.push(`${file}: named by the Auth → Organization Service boundary policy but missing; update AUTH_ORGANIZATION_* in scripts/lib/checks.mjs`);
  for (const key of new Set([...approved, ...AUTH_NEVER_CALL.modules, ...AUTH_NEVER_CALL.contexts])) {
    if (!exists(key)) problems.push(`${key}: named by the Auth → Organization Service boundary policy but not found in the source; update AUTH_ORGANIZATION_* / AUTH_NEVER_CALL in scripts/lib/checks.mjs`);
  }
  for (const key of new Set(approved)) {
    if (AUTH_NEVER_CALL.modules.includes(key.split('#')[0]) || AUTH_NEVER_CALL.contexts.includes(key)) {
      problems.push(`${key}: is a never-call path and cannot be an approved Organization Service caller (${BOUNDARY_RULE})`);
    }
  }

  // 0b. No class inherits from a holder or from an approved controller, directly or through other classes: a subclass would inherit the
  // administrative operation (or the approved route) and call it as `super.create()` or `this.create()` from anywhere.
  const graph = classGraph(parsed);
  const protectedClasses = new Map();
  for (const op of AUTH_ORGANIZATION_OPERATIONS) {
    if (op.owner) protectedClasses.set(`${op.holder}#${op.owner}`, 'an Organization Service holder');
    for (const caller of op.callers) if (caller.includes('.')) protectedClasses.set(caller.slice(0, caller.lastIndexOf('.')), 'an approved administrative controller');
  }
  const chains = new Map(); // `file#Class` -> [itself, …, the protected class it inherits from]
  const chainOf = (key, seen = new Set()) => {
    if (chains.has(key)) return chains.get(key);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const cls = graph.classes.get(key);
    let found;
    for (const base of (cls?.bases ?? []).flatMap((expression) => graph.resolveBases(cls.file, expression))) {
      if (base === key) continue;
      const rest = protectedClasses.has(base) ? [base] : chainOf(base, seen);
      if (rest) {
        found = [key, ...rest];
        break;
      }
    }
    chains.set(key, found);
    return found;
  };
  for (const [key, cls] of graph.classes) {
    const chain = chainOf(key);
    if (!chain) continue;
    const root = chain[chain.length - 1];
    problems.push(`${cls.file}: ${cls.kind} ${chain.map((k) => k.slice(k.indexOf('#') + 1)).join(' extends ')} inherits from ${protectedClasses.get(root)} (${short(root.slice(0, root.indexOf('#')))}); no class may extend one (${BOUNDARY_RULE})`);
  }
  const inheritsFrom = (key, root) => chains.get(key)?.at(-1) === root;
  // A name stands for a protected class when it is that class, inherits from it, or is a type alias of something that does
  // (`type A = OnboardingService`, `type B = InstanceType<typeof A>`), through imports and re-exports.
  const standing = new Map();
  const standsFor = (key, root, seen = new Set()) => {
    const memo = `${key}|${root}`;
    if (standing.has(memo)) return standing.get(memo);
    if (seen.has(key)) return false;
    seen.add(key);
    const alias = graph.aliases.get(key);
    const result = key === root || inheritsFrom(key, root)
      || (alias !== undefined && alias.refs.some((ref) => {
        const resolved = graph.resolveName(alias.file, ref);
        return resolved !== undefined && standsFor(resolved, root, seen);
      }));
    standing.set(memo, result);
    return result;
  };
  const declaredNames = [...new Set([...graph.classes.values(), ...graph.aliases.values()].map((d) => d.name))];
  /** Every name by which `rel` can write the protected class `root`: a local or imported class, subclass or alias, or `namespace.Name`. */
  const namesFor = (rel, root) => {
    const names = new Set();
    const imports = graph.imports.get(rel) ?? new Map();
    const locals = [...[...imports].filter(([, imp]) => imp.imported !== '*').map(([local]) => local),
      ...[...graph.classes.values(), ...graph.aliases.values()].filter((d) => d.file === rel).map((d) => d.name)];
    for (const local of locals) {
      const resolved = graph.resolveLocal(rel, local);
      if (resolved && standsFor(resolved, root)) names.add(local);
    }
    for (const [space, imp] of imports) {
      if (imp.imported !== '*') continue;
      for (const name of declaredNames) {
        const resolved = graph.resolveExport(imp.target, name);
        if (resolved && standsFor(resolved, root)) names.add(`${space}.${name}`);
      }
    }
    return names;
  };
  // An approved handler is a target too: an instance of its controller, however it is declared, is not called from anywhere.
  const targets = [
    ...AUTH_ORGANIZATION_OPERATIONS,
    ...[...new Set(AUTH_ORGANIZATION_OPERATIONS.flatMap((op) => op.callers).filter((c) => c.includes('.')))].map((caller) => {
      const [file, context] = caller.split('#');
      const [owner, member] = context.split('.');
      return { entry: true, operation: `entry point ${context}`, holder: file, owner, member, callers: [] };
    }),
  ];

  for (const rel of files) {
    if (rel === AUTH_ORGANIZATION_CLIENT) continue;
    const sf = parsed.get(rel);
    const clientNames = importedFrom(rel, sf, AUTH_ORGANIZATION_CLIENT);
    const isWiring = rel === AUTH_ORGANIZATION_WIRING;
    const allowedHere = holderContexts.get(rel);

    // 1. Who may import the client at all (every static form: import, import type, export from, require, dynamic import).
    const referencesClient = staticModuleSpecifiers(rel, sources[rel]).some((spec) => resolveSourceSpecifier(rel, spec) === AUTH_ORGANIZATION_CLIENT);
    if (referencesClient && !isWiring && !allowedHere) {
      problems.push(`${rel}: imports the Organization Service client (${short(AUTH_ORGANIZATION_CLIENT)}); only the approved administrative operations may (${BOUNDARY_RULE})`);
    }
    // 1b. Nobody re-exports the client, so no module can obtain it without importing it.
    for (const st of sf.statements) {
      const reexports = ts.isExportDeclaration(st) && (
        (st.moduleSpecifier && resolveSourceSpecifier(rel, staticSpecifier(st.moduleSpecifier)) === AUTH_ORGANIZATION_CLIENT)
        || (!st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause) && st.exportClause.elements.some((el) => clientNames.has((el.propertyName ?? el.name).text))));
      const exportsDefault = ts.isExportAssignment(st) && ts.isIdentifier(strip(st.expression)) && clientNames.has(strip(st.expression).text);
      if (reexports || exportsDefault) problems.push(`${rel}: re-exports the Organization Service client; it is imported from ${short(AUTH_ORGANIZATION_CLIENT)} only (${BOUNDARY_RULE})`);
    }

    // 2. In a holder, only the operation's own method touches the client (the same class also serves never-call paths).
    const clientHolders = instanceHolders(sf, new Set(clientNames.keys()));
    const reported = new Set();
    const touch = (node) => {
      const context = boundaryContext(node);
      if (context === DECLARATION || allowedHere.includes(context) || reported.has(context)) return;
      reported.add(context);
      problems.push(`${rel}: ${context} → Organization Service client (${short(AUTH_ORGANIZATION_CLIENT)}); in this module only ${allowedHere.join(', ')} may reach it (${BOUNDARY_RULE})`);
    };

    // 3. Each administrative operation is called from its approved call sites only.
    const operations = targets.map((op) => {
      // A class target is known by every name that stands for it here: the class, a subclass (already refused by 0b), a type alias,
      // `namespace.Name`. A function target is known by its imported name.
      const root = op.owner ? `${op.holder}#${op.owner}` : undefined;
      let names;
      if (root) names = namesFor(rel, root);
      else {
        names = new Set([...importedFrom(rel, sf, op.holder)].filter(([, original]) => original === op.member).map(([local]) => local));
        if (rel === op.holder) names.add(op.member);
      }
      return { op, root, names, holders: op.owner ? instanceHolders(sf, names) : undefined, self: rel === op.holder ? (op.owner ? `${op.owner}.${op.member}` : op.member) : undefined };
    });
    const seenCalls = new Set();
    const call = (node, { op, self }) => {
      const context = boundaryContext(node);
      const key = `${rel}#${context}`;
      if (context === self || op.callers.includes(key) || seenCalls.has(`${key}|${op.operation}`)) return;
      seenCalls.add(`${key}|${op.operation}`);
      const target = op.owner ? `${op.owner}.${op.member}` : op.member;
      problems.push(op.entry
        ? `${rel}: ${context} → ${target} (an approved Organization Service entry point); only its route may run it (${BOUNDARY_RULE})`
        : `${rel}: ${context} → ${target} → Organization Service (${op.operation}); its only approved callers are ${op.callers.map((c) => c.slice(AUTH_SRC.length)).join(', ')} (${BOUNDARY_RULE})`);
    };
    const entryMethods = AUTH_ORGANIZATION_OPERATIONS.flatMap((op) => op.callers).filter((c) => c.startsWith(`${rel}#`) && c.includes('.')).map((c) => c.slice(rel.length + 1));

    const visit = (node) => {
      if (ts.isImportDeclaration(node)) return;
      if (allowedHere) { // a module that may not import the client at all is already reported by rule 1
        if (ts.isIdentifier(node) && clientNames.has(node.text) && !isNamePosition(node)) touch(node);
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword && clientHolders.members.has(node.name.text)) touch(node);
      }
      for (const entry of operations) {
        const { op, root, names, holders } = entry;
        if (op.owner) {
          if (ts.isPropertyAccessExpression(node) && node.name.text === op.member) {
            const cls = enclosingClass(node);
            // `this.handler` inside the controller itself is rule 4's; for an operation, another method of the holder calling it is a caller.
            const own = !op.entry && node.expression.kind === ts.SyntaxKind.ThisKeyword && rel === op.holder && cls?.name?.text === op.owner;
            const inherited = cls && (node.expression.kind === ts.SyntaxKind.ThisKeyword || node.expression.kind === ts.SyntaxKind.SuperKeyword)
              && inheritsFrom(`${rel}#${declaredClassName(cls)}`, root);
            if (own || inherited || isInstanceExpression(node.expression, names, holders)) call(node, entry);
          }
        } else if (ts.isIdentifier(node) && names.has(node.text) && !isNamePosition(node) && !(ts.isFunctionDeclaration(node.parent) && node.parent.name === node)) call(node, entry);
      }
      // 4. An approved handler is an entry point: nothing else in its class calls it.
      if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const target = `${enclosingClass(node)?.name?.text}.${node.name.text}`;
        const context = boundaryContext(node);
        if (entryMethods.includes(target) && context !== target) problems.push(`${rel}: ${context} → ${target} (an approved Organization Service entry point) is called from inside its class; only the route itself may run it (${BOUNDARY_RULE})`);
      }
      // 5. No second client: no other Auth module opens an outbound client or reads the Organization Service credential.
      if (ts.isCallExpression(node)) {
        const callee = strip(node.expression);
        if ((ts.isIdentifier(callee) && callee.text === 'fetch') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch' && ts.isIdentifier(strip(callee.expression)) && ['globalThis', 'global', 'window', 'self'].includes(strip(callee.expression).text))) {
          problems.push(`${rel}: ${boundaryContext(node)} calls fetch; the only outbound HTTP client in auth-service is ${short(AUTH_ORGANIZATION_CLIENT)} (${BOUNDARY_RULE})`);
        }
      }
      if (!AUTH_ORGANIZATION_CREDENTIAL_READERS.has(rel)) {
        const credential = (ts.isPropertyAccessExpression(node) && node.name.text === 'client' && ts.isPropertyAccessExpression(strip(node.expression)) && strip(node.expression).name.text === 'hierarchy')
          || (ts.isStringLiteralLike(node) && ORGANIZATION_CREDENTIAL_NAME.test(node.text));
        if (credential) problems.push(`${rel}: ${boundaryContext(node)} reads auth-service's Organization Service credential; only the configuration loader, the wiring and ${short(AUTH_ORGANIZATION_CLIENT)} may (${BOUNDARY_RULE})`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const spec of new Set(staticModuleSpecifiers(rel, sources[rel]))) {
      if (OUTBOUND_CLIENT_MODULES.has(spec.replace(/^node:/, '').split('/')[0])) {
        problems.push(`${rel}: imports ${spec}; the only outbound HTTP client in auth-service is ${short(AUTH_ORGANIZATION_CLIENT)} (${BOUNDARY_RULE})`);
      }
    }
  }
  return problems;
}

/**
 * V2 A5.4-A3 O2 (ADR-0061 §6, ADR-0064; A3 design §11.3): the producer scope of the four reference-repair audit actions.
 *
 * The actions are declared consumer-first in `libs/audit-contract` and have NO producer. Until the repair runtime (A5.4-A3) is
 * separately authorized, nothing in an application or a shared library may name them; once it exists, only its one service file may
 * produce them and only its three test files may name them. This check replaces, with equal or wider coverage, the two "producer-less"
 * assertions that lived in `libs/audit-contract/test/reference-repair-catalog.spec.ts` and `reference-repair-batch2.spec.ts`.
 *
 * The allow-listed paths are ENFORCEMENT BOUNDARIES. They authorize nothing: a file listed here that does not exist yet is simply
 * absent, and creating it is part of A5.4-A3, which has its own authorization.
 *
 * What is scanned: every file under `apps/` and `libs/` with a listed source extension, except the contract library itself
 * (`libs/audit-contract/`, which declares the actions). What is matched: the action names without their `hierarchy.` prefix, so a
 * name split from its prefix is still seen. Limit, by construction: the text is read, not executed; a name assembled at run time is
 * not seen (the typed central-audit writer and the repair's own tests cover that).
 */
export const REPAIR_AUDIT_ACTIONS = [
  'hierarchy.reference_repaired',
  'hierarchy.reference_repair_denied',
  'hierarchy.reference_repair_unresolved',
  'hierarchy.reference_anchor_mismatch_detected',
];
/** The ONE file that may produce the actions (the A5.4-A3 repair service). An exact path, never a directory or a pattern. */
export const REPAIR_AUDIT_PRODUCER = 'apps/auth-service/src/hierarchy/reference-repair.service.ts';
/** The THREE test files that may name the actions. Exact paths; test files are never built into an image. */
export const REPAIR_AUDIT_TESTS = [
  'apps/auth-service/test/reference-repair.e2e-spec.ts',
  'apps/auth-service/test/reference-repair-local.e2e-spec.ts',
  'apps/auth-service/test/reference-repair-proof.e2e-spec.ts',
];
export const REPAIR_AUDIT_SCAN = {
  roots: ['apps/', 'libs/'],
  /** The contract library declares the actions (catalog, tests, fixtures): the one existing exception. */
  excluded: 'libs/audit-contract/',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
};
/** What is searched for, per action: its name without the `hierarchy.` prefix (the last one also without `_detected`, as before). */
const REPAIR_AUDIT_FRAGMENTS = [
  ['hierarchy.reference_repaired', 'reference_repaired'],
  ['hierarchy.reference_repair_denied', 'reference_repair_denied'],
  ['hierarchy.reference_repair_unresolved', 'reference_repair_unresolved'],
  ['hierarchy.reference_anchor_mismatch_detected', 'reference_anchor_mismatch'],
];

/** Whether a repository-relative path (forward slashes) is in the scope of the producer-scope check. */
export function repairAuditScanned(relPath) {
  const { roots, excluded, extensions } = REPAIR_AUDIT_SCAN;
  return roots.some((r) => relPath.startsWith(r)) && !relPath.startsWith(excluded) && extensions.some((e) => relPath.endsWith(e));
}

/** `sources`: repository-relative path (forward slashes) → file text. Paths outside the scanned scope are ignored. */
export function checkRepairAuditProducerScope(sources) {
  const problems = [];
  const allowed = new Set([REPAIR_AUDIT_PRODUCER, ...REPAIR_AUDIT_TESTS]);
  for (const relPath of Object.keys(sources).sort()) {
    if (!repairAuditScanned(relPath) || allowed.has(relPath)) continue; // an exact path match only: no prefix, suffix or directory rule
    const text = sources[relPath];
    const named = REPAIR_AUDIT_FRAGMENTS.filter(([, fragment]) => text.includes(fragment)).map(([action]) => action);
    if (named.length > 0) {
      problems.push(`${relPath}: names the reference-repair audit action${named.length > 1 ? 's' : ''} ${named.join(', ')} outside the approved producer scope (A5.4-A3 O2: only ${REPAIR_AUDIT_PRODUCER} may produce them, and only ${REPAIR_AUDIT_TESTS.join(', ')} may name them)`);
    }
  }
  return problems;
}
