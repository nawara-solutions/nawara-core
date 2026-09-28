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
  organization: join(ROOT, 'apps/organization-service/deploy/provision-and-deploy.sh'),
  registerCaller: join(ROOT, 'apps/organization-service/deploy/register-caller.sh'),
  backup: join(ROOT, 'infra/backup/backup.sh'),
  restoreDrill: join(ROOT, 'infra/backup/restore-drill.sh'),
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

export const ROTATION = join(ROOT, 'apps/auth-service/deploy/rotate-db-credential.sh');
export const AUTH_IMAGE_ID = `sha256:${'a1'.repeat(32)}`;
const hex = (seed) => seed.repeat(64).slice(0, 64);

/**
 * A world shaped like production before RB-2: the Auth container created by the Sept-23 deploy script (deploy_edge only, five
 * Traefik labels, the /auth/health check, unless-stopped, stop timeout 60), its database, db.env / .env, and a simulated PostgreSQL
 * whose auth_app password is the one all three hold. `over` tweaks any part to build a failure case.
 */
export function rotationWorld(over = {}) {
  const old = over.oldPassword ?? hex('0f');
  const w = world({
    networks: { deploy_edge: { internal: false } },
    images: { [AUTH_IMAGE_ID]: { env: ['NODE_ENV=production', 'PATH=/usr/local/bin:/usr/bin:/bin'], user: 'node', entrypoint: '["docker-entrypoint.sh"]', cmd: '["node","dist/main.js"]', workdir: '/app/apps/auth-service' } },
    pg: { roles: { auth_app: { password: over.rolePassword ?? old, super: over.superuser ?? false } }, trust: over.trust ?? false },
    containers: {},
  });
  const dir = join(w.home, 'nawara-core/auth-service');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const url = over.url ?? `postgres://auth_app:${over.urlPassword ?? old}@nawara-core-auth-db:5432/auth`;
  const dbEnv = 'dbEnv' in over ? over.dbEnv : `POSTGRES_USER=auth\nPOSTGRES_DB=auth\nPOSTGRES_PASSWORD=${hex('b2')}\nAUTH_APP_PASSWORD=${over.dbEnvPassword ?? old}\n`;
  const appEnv = 'appEnv' in over ? over.appEnv : `NODE_ENV=production\nDATABASE_URL=${url}\nJWT_SECRET=${hex('c3')}\nTRUST_PROXY=true\nAUTH_EVENTS=off\n`;
  if (dbEnv !== null) writeFileSync(join(dir, 'db.env'), dbEnv, { mode: 0o600 });
  if (appEnv !== null) writeFileSync(join(dir, '.env'), appEnv, { mode: 0o600 });
  const containerEnv = over.containerEnv ?? ['NODE_ENV=production', 'PATH=/usr/local/bin:/usr/bin:/bin',
    ...(appEnv ?? '').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l) && !l.startsWith('NODE_ENV='))];
  w.patch((s) => {
    s.containers['nawara-core-auth-db'] = { id: 'id-db', image: 'postgres:16-alpine', imageId: `sha256:${'d4'.repeat(32)}`, running: over.dbRunning ?? true, health: 'healthy', ports: [], publishAll: false, networks: { deploy_edge: true }, labels: [], mounts: [] };
    if (!over.noApp) s.containers['nawara-core-auth-service'] = {
      id: 'id-auth-original', image: 'ghcr.io/nawara-solutions/nawara-core-auth-service:production', imageId: AUTH_IMAGE_ID,
      running: true, health: over.appHealth ?? 'healthy', ports: [], publishAll: false, networks: { deploy_edge: true, ...(over.extraNetworks ?? {}) }, networkMode: 'deploy_edge',
      labels: over.labels ?? ['traefik.enable=true', 'traefik.http.routers.nawara-core-auth-service.rule=Host(`core-api.example.test`) && PathPrefix(`/auth`)',
        'traefik.http.routers.nawara-core-auth-service.entrypoints=websecure', 'traefik.http.routers.nawara-core-auth-service.tls.certresolver=le',
        'traefik.http.services.nawara-core-auth-service.loadbalancer.server.port=3000'],
      labelCount: over.labelCount, env: containerEnv, restart: 'unless-stopped:0', stopTimeout: '60',
      healthcheck: over.healthcheck === null ? undefined : { test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/auth/health >/dev/null || exit 1'], times: '15s 5s 3 15s' },
      logDriver: 'json-file', logOpts: over.logOpts ?? ['max-file=3', 'max-size=10m'], mountSpecs: over.mountSpecs ?? [], mounts: [], extras: over.extras,
    };
  });
  return { ...w, dir, old, rotate: (env = {}) => w.run(ROTATION, env) };
}
