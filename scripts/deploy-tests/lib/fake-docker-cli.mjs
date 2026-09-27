// A stateful stand-in for the `docker` CLI, used only by the deployment-script tests (never touches a Docker daemon).
// State lives in the JSON file named by FAKE_DOCKER_STATE; every invocation is appended to `calls` (argv only; stdin is kept separately
// in `stdin`, because psql SQL and broker passwords legitimately travel there).
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
  if (o.rm) exit(state.failRm?.[image] ? 1 : 0); // one-off containers (migrations): succeed unless told otherwise
  const name = get('--name')[0];
  const networks = Object.fromEntries(get('--network').map((n) => [n, true]));
  state.containers[name] = {
    id: `id-${name}-${state.calls.length}`, image, running: true, health: state.healthOf?.[name] ?? 'healthy',
    ports: [...get('-p'), ...get('--publish')], publishAll: Boolean(o.publishAll), networks, labels: o.labels,
    mounts: get('-v').map((v) => { const [src, dst] = v.split(':'); return `${src}=${dst}`; }),
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
  if (prog === 'psql') { state.stdin.push({ container: name, text: readStdin() }); exit(state.failPsql ? 3 : 0); }
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
  case 'exec': execIn(rest); break;
  case 'start': if (c(rest[0])) c(rest[0]).running = true; exit(c(rest[0]) ? 0 : 1); break;
  case 'stop': { const n = rest[rest.length - 1]; if (c(n)) c(n).running = false; exit(0); break; }
  case 'rename': state.containers[rest[1]] = c(rest[0]); delete state.containers[rest[0]]; exit(0); break;
  case 'rm': delete state.containers[rest[rest.length - 1]]; exit(0); break;
  case 'logs': case 'ps': exit(0); break;
  default: process.stderr.write(`fake docker: unsupported command ${cmd}\n`); exit(2);
}
