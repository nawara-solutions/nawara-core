// Core V2 OD-BRK-2b-1: a stateful stand-in for `docker exec -u rabbitmq <broker> rabbitmqctl -q ...`, used only by
// scripts/deploy-tests/topology-monitor.test.mjs (never a Docker daemon). It knows exactly the broker commands the topology monitor and
// its recovery guard use. State lives in the JSON file given as the first argument; every call is appended to `calls` with the latch's
// content AT THAT MOMENT (so a test proves the containment intent was persisted before the first broker change).
// Faults: `failList` (listings that exit 1), `silentRevoke` / `silentClose` (exit 0, change nothing), `failAll` (every call exits 1).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [file, ...argv] = process.argv.slice(2);
const s = JSON.parse(readFileSync(file, 'utf8'));
const latch = s.latchPath && existsSync(s.latchPath) ? readFileSync(s.latchPath, 'utf8') : null;
const out = (t) => process.stdout.write(t);
const done = (code) => { writeFileSync(file, JSON.stringify(s)); process.exit(code); };

// docker exec -u rabbitmq <container> rabbitmqctl -q <sub> ...
if (argv[0] !== 'exec' || argv[1] !== '-u' || argv[2] !== 'rabbitmq' || argv[4] !== 'rabbitmqctl' || argv[5] !== '-q') {
  s.calls.push({ argv, latch, unsupported: true });
  done(9);
}
const container = argv[3];
const [sub, ...rest] = argv.slice(6);
s.calls.push({ sub, rest, container, latch });
if (s.failAll || container !== s.container) done(1);
if ((s.failList ?? []).includes(sub)) done(1);
const user = (u) => u;
switch (sub) {
  case 'list_users':
    out(Object.entries(s.users).map(([u, tags]) => `${u}\t${tags}\n`).join(''));
    done(0);
    break;
  case 'list_user_permissions': {
    const u = user(rest[0]);
    if (!(u in s.users)) done(2);
    out(Object.entries(s.perms[u] ?? {}).map(([v, p]) => `${v}\t${p.join('\t')}\n`).join(''));
    done(0);
    break;
  }
  case 'list_user_topic_permissions': {
    const u = user(rest[0]);
    if (!(u in s.users)) done(2);
    out(Object.entries(s.topic[u] ?? {}).map(([v, p]) => `${v}\t${p.join('\t')}\n`).join(''));
    done(0);
    break;
  }
  case 'list_connections':
    out(s.connections.map((u) => `${u}\n`).join(''));
    done(0);
    break;
  case 'clear_permissions':
  case 'clear_topic_permissions': {
    const [, vhost, u] = rest; // -p <vhost> <user>
    if (!(u in s.users)) done(2);
    if (!s.silentRevoke) {
      const map = sub === 'clear_permissions' ? s.perms : s.topic;
      if (map[u]) delete map[u][vhost];
    }
    done(0);
    break;
  }
  case 'close_all_user_connections': {
    if (!s.silentClose) s.connections = s.connections.filter((u) => u !== rest[0]);
    done(0);
    break;
  }
  default:
    done(9);
}
