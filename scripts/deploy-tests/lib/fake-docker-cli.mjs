// A stateful stand-in for the `docker` CLI, used only by the deployment-script tests (never touches a Docker daemon).
// State lives in the JSON file named by FAKE_DOCKER_STATE; every invocation is appended to `calls` (argv only; stdin is kept separately
// in `stdin`, because psql SQL and broker passwords legitimately travel there).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_DOCKER_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const argv = process.argv.slice(2);
state.calls.push(argv);
const save = () => writeFileSync(file, JSON.stringify(state));
const out = (s) => process.stdout.write(s);
const exit = (code) => { save(); process.exit(code); };
const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

const [cmd, ...rest] = argv;
const image = (id) => state.images?.[id] ?? { env: [], user: '', entrypoint: 'null', cmd: '["node","dist/main.js"]', workdir: '/app' };
const imageFacts = (id) => { const im = image(id); return `${im.user}|${im.entrypoint}|${im.cmd}|${im.workdir}`; };
/** '15s 5s 3 15s' -> raw-JSON nanoseconds '15000000000 5000000000 3 15000000000' (what an `index` template prints). */
const toNs = (times) => times.split(' ').map((t, k) => (k === 2 ? t : String(Number(t.replace(/ns$|s$/, '')) * (t.endsWith('ns') ? 1 : 1e9)))).join(' ');
const sortedLabels = (x) => [...x.labels].sort((a, b) => a.split('=')[0].localeCompare(b.split('=')[0]));
const urlPassword = (env) => env?.find((e) => e.startsWith('DATABASE_URL='))?.match(/^DATABASE_URL=[^:]+:\/\/[^:]+:([^@]*)@/)?.[1];
/** Auth's /auth/health is database-backed: with a simulated database, it is healthy only when its DATABASE_URL password is the role's. */
function healthFor(name, env) {
  if (state.healthOf?.[name]) return state.healthOf[name];
  if (state.unhealthyRuns > 0 && name === 'nawara-core-auth-service') { state.unhealthyRuns -= 1; return 'unhealthy'; }
  if (!state.pg || !env?.some((e) => e.startsWith('DATABASE_URL='))) return 'healthy';
  return urlPassword(env) === state.pg.roles.auth_app?.password ? 'healthy' : 'unhealthy';
}
const c = (name) => state.containers[name];

function inspectContainer(fmt, name) {
  const x = c(name);
  if (!x) exit(1);
  if (fmt === undefined) { out('[{}]\n'); exit(0); }
  const nets = Object.keys(x.networks).sort();
  const known = [
    ['{{.Config.Image}}', () => x.image],
    ['{{len .HostConfig.PortBindings}}', () => String(x.ports.length)],
    ['{{.HostConfig.PublishAllPorts}}', () => String(x.publishAll)],
    ['{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}', () => nets.map((n) => `${n} `).join('')],
    ['{{range .Mounts}}{{.Name}}={{.Destination}} {{end}}', () => x.mounts.map((m) => `${m} `).join('')],
    ['{{.State.Running}}', () => String(x.running)],
    ['{{.State.Health.Status}}', () => x.health],
    ['{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}', () => `${x.running ? 'running' : 'exited'}/${x.health}`],
    ['{{.Id}}', () => x.id],
    // --- rotate-db-credential.sh
    ['{{.Image}}', () => x.imageId],
    ['{{.HostConfig.NetworkMode}}', () => x.networkMode ?? nets[0]],
    ['{{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{"\\n"}}{{end}}', () => nets.map((n) => `${n}\n`).join('')],
    ['{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}{{"\\n"}}{{end}}', () => sortedLabels(x).map((l) => `${l}\n`).join('')],
    ['{{if .Config.Labels}}{{len .Config.Labels}}{{else}}0{{end}}', () => String(x.labelCount ?? x.labels.length)],
    ['{{.HostConfig.RestartPolicy.Name}}:{{.HostConfig.RestartPolicy.MaximumRetryCount}}', () => x.restart ?? 'no:0'],
    // raw-JSON forms (as real Docker evaluates `index` templates): durations in nanoseconds
    ['{{with index .Config "StopTimeout"}}{{.}}{{end}}', () => x.stopTimeout ?? ''],
    ['{{with index .Config "Healthcheck"}}{{index .Test 0}}:{{len .Test}}{{end}}', () => (x.healthcheck ? `${x.healthcheck.test[0]}:${x.healthcheck.test.length}` : '')],
    ['{{index (index .Config "Healthcheck") "Test" 1}}', () => x.healthcheck.test[1]],
    ['{{with index .Config "Healthcheck"}}{{index . "Interval"}} {{index . "Timeout"}} {{index . "Retries"}} {{index . "StartPeriod"}}{{end}}', () => (x.healthcheck ? toNs(x.healthcheck.times) : '')],
    ['{{.HostConfig.LogConfig.Type}}', () => x.logDriver ?? 'json-file'],
    ['{{with index .HostConfig.LogConfig "Config"}}{{range $k, $v := .}}{{$k}}={{$v}}{{"\\n"}}{{end}}{{end}}', () => (x.logOpts ?? []).map((l) => `${l}\n`).join('')],
    ['{{range .Mounts}}{{.Type}}|{{.Name}}|{{.Source}}|{{.Destination}}|{{.RW}}{{"\\n"}}{{end}}', () => (x.mountSpecs ?? []).map((m) => `${m.type}|${m.name ?? ''}|${m.source ?? ''}|${m.dest}|${m.rw}\n`).join('')],
    [`{{index .HostConfig "Privileged"}}|{{if index .HostConfig "CapAdd"}}cap-add{{end}}|{{if index .HostConfig "CapDrop"}}cap-drop{{end}}|{{if index .HostConfig "ExtraHosts"}}extra-hosts{{end}}|{{if index .HostConfig "Dns"}}dns{{end}}|{{if index .HostConfig "SecurityOpt"}}security-opt{{end}}|{{if index .HostConfig "Devices"}}devices{{end}}|{{if index .HostConfig "PortBindings"}}ports{{end}}|{{if index .HostConfig "PublishAllPorts"}}publish-all{{end}}|{{if index .HostConfig "ReadonlyRootfs"}}read-only{{end}}|{{index .HostConfig "Memory"}}|{{index .HostConfig "NanoCpus"}}|{{if index .HostConfig "Tmpfs"}}tmpfs{{end}}||{{index .Config "User"}}|{{json (index .Config "Entrypoint")}}|{{json (index .Config "Cmd")}}|{{index .Config "WorkingDir"}}`,
      () => `${x.extras ?? `false|||||||${x.ports.length ? 'ports' : ''}|||0|0|`}||${imageFacts(x.imageId)}`],
    ['{{range .Config.Env}}{{.}}{{"\\n"}}{{end}}', () => (x.env ?? []).map((e) => `${e}\n`).join('')],
    ['{{range .NetworkSettings.Networks}}{{.IPAddress}}{{"\\n"}}{{end}}', () => nets.map((_, k) => `172.18.0.${k + 2}\n`).join('')],
  ];
  const hit = known.find(([f]) => f === fmt);
  if (!hit) { process.stderr.write(`fake docker: unsupported inspect format ${fmt}\n`); exit(2); }
  out(`${hit[1]()}\n`);
  exit(0);
}

function run(args) {
  const o = { flags: [], labels: [], env: [], rm: false, detach: false };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    if (a === '--rm') o.rm = true;
    else if (a === '-d') o.detach = true;
    else if (a === '-P' || a === '--publish-all') o.publishAll = true;
    else { const v = args[++i]; o.flags.push([a, v]); if (a === '--label') o.labels.push(v); if (a === '-e') o.env.push(v); }
  }
  const image = args[i];
  const get = (f) => o.flags.filter(([k]) => k === f).map(([, v]) => v);
  if (image.startsWith('amazon/aws-cli')) s3(o, get, image, args.slice(i + 1));
  if (o.rm) { // one-off containers (migrations): succeed unless told otherwise
    if (args.slice(i + 1).some((a) => a.includes('migrate.js')) && !state.failRm?.[image]) out(`${state.drill?.migrateOutput ?? 'migrations: 0 applied, 8 already applied'}\n`);
    exit(state.failRm?.[image] ? 1 : 0);
  }
  const name = get('--name')[0];
  const networks = Object.fromEntries(get('--network').map((n) => [n, true]));
  if (get('--pull')[0] === 'never' && state.failRecreateOnce) { state.failRecreateOnce = false; process.stderr.write('simulated failure during recreation\n'); exit(1); }
  if (image.startsWith('sha256:') && !state.images?.[image]) { process.stderr.write(`Unable to find image '${image}' locally\n`); exit(125); }
  const envFile = get('--env-file')[0];
  const env = [...(state.images?.[image]?.env ?? []), ...(envFile ? readFileSync(envFile, 'utf8').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)) : [])];
  const hc = get('--health-cmd')[0];
  state.runs = [...(state.runs ?? []), { name, image, network: get('--network')[0], env }];
  state.containers[name] = {
    id: `id-${name}-${state.calls.length}`, image, imageId: image.startsWith('sha256:') ? image : `sha256:${'0'.repeat(64)}`,
    running: true, health: healthFor(name, env),
    ports: [...get('-p'), ...get('--publish'), ...(state.injectPorts?.[name] ?? [])], publishAll: Boolean(o.publishAll), networks, networkMode: get('--network')[0], labels: o.labels,
    mounts: get('-v').map((v) => { const [src, dst] = v.split(':'); return `${src}=${dst}`; }),
    mountSpecs: get('-v').map((v) => { const [src, dest, mode] = v.split(':'); return src.startsWith('/') ? { type: 'bind', source: src, dest, rw: mode !== 'ro' } : { type: 'volume', name: src, dest, rw: mode !== 'ro' }; }),
    env, restart: get('--restart')[0] ? (get('--restart')[0].includes(':') ? get('--restart')[0] : `${get('--restart')[0]}:0`) : 'no:0',
    stopTimeout: get('--stop-timeout')[0] ?? '', logDriver: get('--log-driver')[0], logOpts: get('--log-opt'), pull: get('--pull')[0],
    healthcheck: hc ? { test: ['CMD-SHELL', hc], times: [get('--health-interval')[0] ?? '0s', get('--health-timeout')[0] ?? '0s', get('--health-retries')[0] ?? '0', get('--health-start-period')[0] ?? '0s'].join(' ') } : undefined,
  };
  out(`${state.containers[name].id}\n`);
  exit(0);
}

function rabbitmqctl(args) {
  const b = state.broker;
  const a = args.filter((x) => x !== '-q');
  const [sub, ...params] = a;
  const vhostArg = () => { const k = params.indexOf('-p'); return k >= 0 ? params[k + 1] : '/'; };
  switch (sub) {
    case 'list_users': out(Object.entries(b.users).map(([u, v]) => `${u}\t[${v.tags.join(',')}]\n`).join('')); break;
    case 'list_vhosts': out(b.vhosts.map((v) => `${v}\n`).join('')); break;
    case 'add_vhost': b.vhosts.push(params[0]); break;
    case 'delete_user': delete b.users[params[0]]; break;
    case 'add_user': { if (params.length > 1) b.passwordOnArgv = true; b.users[params[0]] = { tags: [], password: readStdin().trim() }; break; }
    case 'change_password': { if (params.length > 1) b.passwordOnArgv = true; b.users[params[0]].password = readStdin().trim(); break; }
    case 'set_user_tags': b.users[params[0]].tags = params.slice(1); break;
    case 'set_permissions': { const p = params.filter((x, k) => x !== '-p' && params[k - 1] !== '-p'); b.perms[p[0]] = { vhost: vhostArg(), conf: p[1], write: p[2], read: p[3] }; break; }
    case 'set_topic_permissions': { const p = params.filter((x, k) => x !== '-p' && params[k - 1] !== '-p'); b.topic[p[0]] = { exchange: p[1], write: p[2], read: p[3] }; break; }
    case 'list_bindings': out(b.bindings); break;
    case 'list_queues': out(b.queues); break;
    default: process.stderr.write(`fake rabbitmqctl: unsupported ${sub}\n`); exit(2);
  }
  exit(0);
}

/**
 * A private S3-compatible bucket behind `docker run --rm … amazon/aws-cli … --endpoint-url <e> s3api <op>` (infra/backup). Objects are
 * kept in state.s3.objects["bucket/key"]; /work in the container is the host directory mounted with -v. Failure knobs: failPut
 * (a key substring, or true), badHead (a key substring: HEAD reports the wrong size), failList, failDelete.
 */
function s3(o, get, image, args) {
  const S = (state.s3 ??= { objects: {}, deleted: [], calls: [] });
  const opt = (n) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : undefined; };
  const work = get('-v').map((v) => v.split(':')).find(([, d]) => d === '/work')?.[0];
  const host = (p) => p.replace(/^\/work/, work);
  const [op] = args.slice(args.indexOf('s3api') + 1);
  const bucket = opt('--bucket'); const key = opt('--key');
  const hit = (knob) => knob === true || (typeof knob === 'string' && (key ?? '').includes(knob));
  S.calls.push({ op, key, prefix: opt('--prefix'), endpoint: opt('--endpoint-url'), envFiles: get('--env-file'), env: o.env, image, user: get('--user')[0], network: get('--network')[0] });
  const fail = (m) => { process.stderr.write(`An error occurred (${m})\n`); exit(254); };
  switch (op) {
    case 'put-object': {
      if (hit(S.failPut)) fail('InternalError');
      const data = readFileSync(host(opt('--body')));
      S.objects[`${bucket}/${key}`] = { data: data.toString('base64'), size: data.length, sha: createHash('sha256').update(data).digest('hex') };
      out('{"ETag": "\\"fake\\""}\n'); exit(0); break;
    }
    case 'head-object': { const x = S.objects[`${bucket}/${key}`]; if (!x) fail('404'); out(`${hit(S.badHead) ? x.size - 1 : x.size}\n`); exit(0); break; }
    case 'list-objects-v2': {
      if (S.failList) fail('AccessDenied');
      const keys = Object.keys(S.objects).filter((k) => k.startsWith(`${bucket}/${opt('--prefix')}`)).map((k) => k.slice(bucket.length + 1)).sort();
      out(keys.length ? `${keys.join('\n')}\n` : 'None\n'); exit(0); break;
    }
    case 'delete-object': { if (S.failDelete) fail('AccessDenied'); delete S.objects[`${bucket}/${key}`]; S.deleted.push(key); exit(0); break; }
    case 'get-object': { const x = S.objects[`${bucket}/${key}`]; if (!x) fail('NoSuchKey'); writeFileSync(host(args[args.length - 1]), Buffer.from(x.data, 'base64')); out('{}\n'); exit(0); break; }
    default: process.stderr.write(`fake aws: unsupported ${op}\n`); exit(2);
  }
}

/** The tables a pg_restore --list of a fake archive shows data for (infra/backup requires the cutover-critical ones). */
const TOC_TABLES = ['schema_migrations', 'ownership_state', 'ownership_event', 'hierarchy_id_ledger', 'company', 'platform', 'organization', 'outbox', 'hierarchy_authority', 'user'];
const FACTS = 'table|company|1\ntable|schema_migrations|8\nstructure|constraints|40\nmigrations|8|0123456789abcdef0123456789abcdef\nowner|company|x\nacl|company|x=r/x\nauthority|PREPARED|fresh|false\n';

function execIn(args) {
  let i = 0;
  let user;
  for (; i < args.length; i++) {
    if (args[i] === '-i') continue;
    if (args[i] === '-u') { user = args[++i]; continue; }
    break;
  }
  const name = args[i];
  const [prog, ...progArgs] = args.slice(i + 1);
  if (!c(name) || !c(name).running) { process.stderr.write(`Error response from daemon: No such container: ${name}\n`); exit(1); }
  const B = state.backup ?? {}; const D = state.drill ?? {};
  if (prog === 'pg_dump' && progArgs.includes('--version')) { out('pg_dump (PostgreSQL) 16.15\n'); exit(0); }
  if (prog === 'pg_dump') {
    state.dumps = [...(state.dumps ?? []), { container: name, argv: progArgs }];
    if (B.dumpFail) { process.stderr.write('pg_dump: error: simulated\n'); exit(1); }
    out(B.dumpEmpty ? '' : B.dumpNotCustom ? 'not an archive' : `PGDMP-fake-custom-archive-${name}-${'x'.repeat(256)}`); exit(0);
  }
  if (prog === 'pg_restore' && progArgs.includes('--list')) {
    readStdin();
    if (B.tocFail) { process.stderr.write('pg_restore: error: input file does not appear to be a valid archive\n'); exit(1); }
    out(TOC_TABLES.filter((t) => t !== B.tocMissing).map((t, k) => `${3600 + k}; 0 ${16400 + k} TABLE DATA public ${t} owner\n`).join('')); exit(0);
  }
  if (prog === 'pg_restore') {
    const data = readStdin();
    state.restores = [...(state.restores ?? []), { container: name, argv: progArgs, at: state.calls.length - 1, bytes: data.length }];
    exit(D.restoreFail ? 1 : 0);
  }
  if (prog === 'pg_isready') exit(D.dbNeverReady ? 2 : 0);
  if (prog === 'wget') { out(D.notReady ? '' : '{"status":"ready"}'); exit(D.notReady ? 1 : 0); }
  if (prog === 'node' && progArgs[0] === '-e') { out(`${D.apiName ?? D.knownName ?? 'Drill Synthetic Co'}\n`); exit(0); }
  if (prog === 'psql' && progArgs.includes('-c')) { // a read-only fact over the local socket
    const sql = progArgs[progArgs.indexOf('-c') + 1];
    state.queries = [...(state.queries ?? []), { container: name, at: state.calls.length - 1, sql }];
    // infra/backup/restore-drill.sh: role attributes, schema_migrations owner/privileges, history length, known-id reads
    if (sql.includes('rolcanlogin')) { out(`${D.roleAttrs ?? 't|f|f|f|f|f'}\n`); exit(0); }
    if (sql.includes('relowner') && sql.includes('schema_migrations')) { out(`${D.smOwner ?? (name.includes('organization') ? 'organization_migrator' : 'auth')}\n`); exit(0); }
    if (sql.includes("'public.schema_migrations','SELECT'")) { out(`${D.smPrivileges ?? 't|f|f|f|f'}\n`); exit(0); }
    if (sql.includes('count(*) FROM schema_migrations')) { out(`${D.historyLength ?? 8}\n`); exit(0); }
    if (sql.includes('FROM company WHERE id')) { out(`${D.knownName ?? 'Drill Synthetic Co'}\n`); exit(0); }
    if (sql.includes('FROM "user" WHERE id')) { out(`${sql.match(/'([0-9a-f-]{36})'/)?.[1] ?? ''}\n`); exit(0); }
    // organization-service deploy (Stage 21.x G1): runtime-role attributes, forbidden / missing privileges, ownership phase
    if (sql.includes('rolbypassrls')) { out(`${state.org?.roleAttrs ?? 'f|f|f|f|f'}\n`); exit(0); }
    if (sql.includes('WHERE NOT has_table_privilege')) { out(`${state.org?.missing ?? ''}\n`); exit(0); }
    if (sql.includes('WHERE has_table_privilege')) { out(`${state.org?.forbidden ?? ''}\n`); exit(0); }
    if (sql.includes('FROM ownership_state')) { out(`${state.org?.phase ?? 'PREPARED|undeclared'}\n`); exit(0); }
    const role = sql.match(/rolname = '([^']+)'/)?.[1];
    const r = state.pg?.roles?.[role];
    out(r ? `${r.super ? 't' : 'f'}\n` : '\n');
    exit(0);
  }
  if (prog === 'psql') {
    const text = readStdin();
    state.stdin.push({ container: name, text, at: state.calls.length - 1 });
    if (state.failPsql) exit(3);
    if (text.includes('-- nawara-backup-facts')) { // infra/backup facts: at backup time from state.backup, after a drill restore from state.drill
      if (B.factsFail) exit(3);
      out(name.startsWith('nawara-drill-') ? (D.facts ?? B.facts ?? FACTS) : (B.facts ?? FACTS)); exit(0);
    }
    for (const m of text.matchAll(/ALTER ROLE (\w+) WITH[^;]*PASSWORD '([^']*)'/g)) {
      if (state.pg) { state.pg.roles[m[1]] ??= { super: false }; state.pg.roles[m[1]].password = m[2]; }
    }
    exit(0);
  }
  if (prog === 'sh' && progArgs[0] === '-c') { // the TCP password login: sh -c <script> sh <ip> <user> <db>, password on stdin
    const user = progArgs[4]; // -c <script> sh <ip> <user> <db>
    const password = readStdin().replace(/\n$/, '');
    state.logins = [...(state.logins ?? []), { user, ok: null }];
    const r = state.pg?.roles?.[user];
    const ok = Boolean(state.pg?.trust) || (r && r.password === password) || (state.pg?.alsoAccept ?? []).includes(password);
    state.logins[state.logins.length - 1].ok = Boolean(ok);
    if (!ok) { process.stderr.write(`psql: error: FATAL:  password authentication failed for user "${user}"\n`); exit(2); }
    out(`${user}|${r?.super ? 'true' : 'false'}\n`);
    exit(0);
  }
  if (prog === 'rabbitmq-diagnostics') { if (user !== 'rabbitmq') state.rootCli = true; exit(state.broker.ready ? 0 : 69); }
  if (prog === 'rabbitmqctl') { if (user !== 'rabbitmq') state.rootCli = true; rabbitmqctl(progArgs); }
  exit(0);
}

switch (cmd) {
  case 'inspect': rest[0] === '-f' ? inspectContainer(rest[1], rest[2]) : inspectContainer(undefined, rest[0]); break;
  case 'network': {
    const [sub, ...a] = rest;
    if (sub === 'inspect') {
      const fmt = a[0] === '-f' ? a[1] : undefined; const name = fmt ? a[2] : a[0];
      const n = state.networks[name]; if (!n) exit(1);
      out(fmt === '{{.Internal}}' ? `${n.internal}\n` : '[{}]\n'); exit(0);
    }
    if (sub === 'create') { const name = a[a.length - 1]; state.networks[name] = { internal: a.includes('--internal') }; exit(0); }
    if (sub === 'connect') { if (state.failConnect) exit(1); c(a[1]).networks[a[0]] = true; exit(0); }
    exit(2);
    break;
  }
  case 'run': run(rest); break;
  case 'image': {
    if (rest[0] !== 'inspect' || rest[1] !== '-f') exit(2);
    const [, , fmt, id] = rest;
    if (!state.images?.[id]) exit(1);
    if (fmt === '{{range .Config.Env}}{{.}}{{"\\n"}}{{end}}') { out(image(id).env.map((e) => `${e}\n`).join('')); exit(0); }
    if (fmt === '{{index .Config "User"}}|{{json (index .Config "Entrypoint")}}|{{json (index .Config "Cmd")}}|{{index .Config "WorkingDir"}}') { out(`${imageFacts(id)}\n`); exit(0); }
    process.stderr.write(`fake docker: unsupported image inspect format ${fmt}\n`); exit(2);
    break;
  }
  case 'pull': case 'build': state.forbidden = [...(state.forbidden ?? []), argv.join(' ')]; exit(0); break;
  case 'exec': execIn(rest); break;
  case 'start': if (c(rest[0])) c(rest[0]).running = true; exit(c(rest[0]) ? 0 : 1); break;
  case 'stop': { const n = rest[rest.length - 1]; if (c(n)) c(n).running = false; exit(0); break; }
  case 'rename': state.containers[rest[1]] = c(rest[0]); delete state.containers[rest[0]]; exit(0); break;
  case 'rm': for (const n of rest.filter((a) => !a.startsWith('-'))) delete state.containers[n]; exit(0); break;
  case 'logs': case 'ps': exit(0); break;
  default: process.stderr.write(`fake docker: unsupported command ${cmd}\n`); exit(2);
}
