// Test-only stand-ins for `docker`, `curl` and `date`, used only by auth-readiness-alert.test.mjs (the R3 alert carrier). They never touch
// a Docker daemon or the network. A separate helper (not fake-docker-cli.mjs) keeps the other deploy tests' fake unchanged.
// State lives in the JSON file named by FAKE_ALERT_STATE; every docker and curl invocation is recorded (argv; curl also its payload).
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_ALERT_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const [tool, ...argv] = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state));
const out = (s) => process.stdout.write(s);
const exit = (code) => { save(); process.exit(code); };
/** A value that may be a list consumed one call at a time (its last entry repeating). */
const next = (key, fallback) => {
  const v = state[key] ?? fallback;
  if (!Array.isArray(v)) return v;
  const n = (state[`${key}Calls`] = (state[`${key}Calls`] ?? 0) + 1);
  return v[Math.min(n, v.length) - 1];
};

function docker() {
  (state.dockerCalls ??= []).push(argv);
  const [cmd, ...rest] = argv;
  const c = state.container; // { id, running, image, revision? } or null
  if (cmd === 'container' && rest[0] === 'inspect') {
    if (!c || rest[rest.length - 1] !== state.containerName) { process.stderr.write('Error: No such container\n'); exit(1); }
    out(`${c.id}|${c.running ? 'true' : 'false'}|${c.image}|${c.revision ?? '<no value>'}\n`); exit(0);
  }
  if (cmd === 'image' && rest[0] === 'inspect') { out(`${(state.repoDigests ?? []).map((d) => `${d} `).join('')}\n`); exit(0); }
  if (cmd === 'exec') {
    const p = next('probe', '200 {"status":"ready"}');
    if (p === '__exit1') exit(1);
    if (p === '__exit124') exit(124); // what `timeout` reports when it kills the probe
    out(`${p}\n`); exit(0);
  }
  if (cmd === 'logs') {
    const since = rest[rest.indexOf('--since') + 1];
    (state.logSince ??= []).push(since);
    if (next('logsFail', false)) { process.stderr.write('Error response from daemon\n'); exit(1); }
    out(next('logs', '')); exit(0);
  }
  process.stderr.write(`fake docker: unexpected command ${argv.join(' ')}\n`); exit(2);
}

function curl() {
  const at = argv.indexOf('--config');
  const config = readFileSync(argv[at + 1], 'utf8');
  const which = config.includes('receiver') ? 'receiver' : 'heartbeat';
  const dataArg = argv.find((a) => a.startsWith('@'));
  const payload = dataArg ? readFileSync(dataArg.slice(1), 'utf8') : null;
  (state.curlCalls ??= []).push({ which, argv, payload, env: Object.keys(process.env).filter((k) => /CURL|RECEIVER|HEARTBEAT|TOKEN|SECRET/.test(k)) });
  const fail = which === 'receiver' ? next('receiverFail', false) : next('heartbeatFail', false);
  if (fail) { process.stderr.write('curl: (22) The requested URL returned error: 503\n'); exit(22); }
  if (which === 'receiver') (state.delivered ??= []).push(JSON.parse(payload));
  else state.heartbeats = (state.heartbeats ?? 0) + 1;
  exit(0);
}

function date() {
  const now = state.now;
  const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (argv.join(' ') === '-u +%s') { out(`${now}\n`); exit(0); }
  const d = argv.indexOf('-d');
  if (d >= 0 && argv[d + 1].startsWith('@')) { out(`${iso(Number(argv[d + 1].slice(1)))}\n`); exit(0); }
  process.stderr.write(`fake date: unexpected ${argv.join(' ')}\n`); exit(2);
}

({ docker, curl, date })[tool]();
