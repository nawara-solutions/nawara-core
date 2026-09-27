// Runs a REAL deployment script against the fake `docker` (fake-docker-cli.mjs) in a throwaway HOME, and exposes what it did.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const SCRIPTS = {
  broker: join(ROOT, 'infra/rabbitmq/provision.sh'),
  audit: join(ROOT, 'apps/audit-service/deploy/provision-and-deploy.sh'),
  auth: join(ROOT, 'apps/auth-service/deploy/provision-and-deploy.sh'),
};
const CLI = join(import.meta.dirname, 'fake-docker-cli.mjs');
const T = '\t';

/** The broker-side topology audit-service declares when its consumer attaches (as `rabbitmqctl list_queues / list_bindings` print it). */
export const AUDIT_TOPOLOGY = {
  queues: [
    `audit-service.audit${T}true${T}[{"x-dead-letter-exchange","nawara.events.dlx"}]${T}1`,
    `audit-service.audit.retry${T}true${T}[{"x-dead-letter-exchange",""},{"x-dead-letter-routing-key","audit-service.audit"}]${T}0`,
    `audit-service.audit.dead${T}true${T}[]${T}0`,
  ].join('\n') + '\n',
  bindings: [
    `${T}audit-service.audit${T}audit-service.audit`,
    `nawara.events${T}audit-service.audit${T}audit.#`,
    `nawara.events.dlx${T}audit-service.audit.dead${T}`,
  ].join('\n') + '\n',
};

export function world(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin); mkdirSync(home);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash\nexec node ${JSON.stringify(CLI)} "$@"\n`);
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n'); // the scripts' wait loops, instantly
  chmodSync(join(bin, 'docker'), 0o755); chmodSync(join(bin, 'sleep'), 0o755);
  const stateFile = join(dir, 'state.json');
  const base = {
    calls: [], stdin: [], containers: {}, networks: { deploy_edge: { internal: false } },
    broker: { ready: true, users: {}, vhosts: [], perms: {}, topic: {}, bindings: '', queues: '' },
  };
  writeFileSync(stateFile, JSON.stringify({ ...base, ...initial, broker: { ...base.broker, ...(initial.broker ?? {}) } }));

  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const patch = (fn) => { const s = state(); fn(s); writeFileSync(stateFile, JSON.stringify(s)); };
  const run = (script, env = {}) => {
    const r = spawnSync('bash', [script], {
      input: '', encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_DOCKER_STATE: stateFile, ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  /** Every docker invocation whose argv starts with the given words. */
  const calls = (...prefix) => state().calls.filter((a) => prefix.every((p, i) => a[i] === p));
  /** Every value written to a state file under HOME (the generated secrets and URLs), for leak checks. */
  const secrets = () => {
    const found = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else for (const line of readFileSync(p, 'utf8').split('\n')) {
          const v = line.slice(line.indexOf('=') + 1);
          for (const s of [v, ...(v.match(/:([0-9a-f]{32,})@/)?.slice(1) ?? [])]) if (/[0-9a-f]{32,}/.test(s)) found.push(s);
        }
      }
    };
    if (existsSync(home)) walk(home);
    return found;
  };
  const mode = (p) => (statSync(p).mode & 0o777).toString(8);
  return { dir, home, state, patch, run, calls, secrets, mode };
}

/** A world in which the broker has been provisioned (infra/rabbitmq/provision.sh) with the given identities. */
export function provisionedWorld(services = ['audit-service', 'auth-service'], broker = {}) {
  const w = world({
    networks: { deploy_edge: { internal: false }, 'nawara-core-internal': { internal: true } },
    containers: {
      'nawara-core-rabbitmq': {
        id: 'id-broker', image: 'rabbitmq:3.13.7-alpine', running: true, health: 'healthy', ports: [], publishAll: false,
        networks: { 'nawara-core-internal': true }, labels: [], mounts: ['nawara-core-rabbitmq-data=/var/lib/rabbitmq'],
      },
    },
    broker,
  });
  const clients = join(w.home, 'nawara-core/rabbitmq/clients');
  mkdirSync(clients, { recursive: true });
  for (const s of services) {
    const secret = `${s.replace(/[^a-f0-9]/g, '').padEnd(8, 'a')}${'0123456789abcdef'.repeat(4)}`;
    writeFileSync(join(clients, `${s}.env`), `RABBITMQ_URL=amqp://${s}:${secret}@nawara-core-rabbitmq:5672/nawara-core\n`, { mode: 0o600 });
  }
  return w;
}

/** The flags of the (single) `docker run -d --name <name>` call, as [flag, value] pairs, plus its image. */
export function runOf(w, name) {
  const all = w.calls('run').filter((a) => a[a.indexOf('--name') + 1] === name && a.includes('-d'));
  if (all.length === 0) return undefined;
  const a = all[all.length - 1];
  const flags = [];
  let i = 1;
  for (; i < a.length; i++) {
    if (!a[i].startsWith('-')) break;
    if (a[i] === '-d' || a[i] === '--rm') { flags.push([a[i], true]); continue; }
    flags.push([a[i], a[++i]]);
  }
  return { flags, image: a[i], all: (f) => flags.filter(([k]) => k === f).map(([, v]) => v), argv: a };
}

/** No mutation happened: nothing created, started, stopped, renamed, removed, migrated or written to a database. */
export function assertNothingChanged(assert, w) {
  const mutating = w.state().calls.filter((a) => ['run', 'stop', 'rename', 'rm', 'start'].includes(a[0])
    || (a[0] === 'network' && ['create', 'connect'].includes(a[1])) || (a[0] === 'exec' && a.includes('psql')));
  assert.deepEqual(mutating, [], 'a refused preflight must not change anything');
}
