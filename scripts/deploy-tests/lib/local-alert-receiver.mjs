// Core V2 OD-BRK-2b-A: the LOCAL HTTPS receiver standing for Pushover and Healthchecks.io in the real-broker driver
// (scripts/deploy-tests/real-broker-topology-containment.mjs). POST /1/messages.json answers Pushover's acceptance ({"status":1}), any
// other path answers Healthchecks.io's "OK"; each answer is delayed by the current delay.
//
// It runs in a WORKER THREAD with its own event loop: the driver's main thread blocks in synchronous children (spawnSync of the monitor,
// the recovery, a carrier cycle), and a server on that thread could answer nothing meanwhile, so every delivery would time out and the
// carrier would (correctly) back off. Requests are recorded, in arrival order and before they are answered, to a run-owned JSONL file the
// driver reads synchronously. The worker is unref'd: a receiver left open can never keep the driver's process alive.
import { Worker } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { bounded } from './owned-process.mjs';

const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { createServer } = require('node:https');
const { appendFileSync, readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { key, cert, port, log, delay } = workerData;
const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const pushover = req.url === '/1/messages.json';
    appendFileSync(log, JSON.stringify({ url: req.url, method: req.method, form: pushover ? Object.fromEntries(new URLSearchParams(body)) : null, raw: body }) + '\\n', { mode: 0o600 });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(pushover ? '{"status":1,"request":"' + randomUUID() + '"}' : 'OK');
    }, Atomics.load(delay, 0));
  });
});
server.on('error', (e) => parentPort.postMessage({ error: String(e && e.message) }));
server.listen(port, '127.0.0.1', () => parentPort.postMessage({ listening: true }));
`;

/** The carrier's fixed runbook reference (topology-alert-carrier.sh RUNBOOK): the only metadata line exempt from the sensitive patterns. */
export const APPROVED_RUNBOOK = 'docs/runbooks/rabbitmq-topology-containment.md';
/** Sensitive material by kind; applied to every outgoing field and message line except the validated runbook line. */
const SENSITIVE = [
  ['a URL', /[a-z][a-z0-9+.-]*:\/\//i],
  ['a broker port', /:(?:1?5672|25672|4369)(?![0-9])|\bport\s*[=:]?\s*(?:1?5672|25672|4369)(?![0-9])/i],
  ['broker or Erlang material', /rabbitmq|amqp|erlang|cookie/i],
  ['authentication material', /password|passwd|pass=|secret|bearer|authorization\s*[:=]|api[_-]?key|token|credential|private key|-----BEGIN/i],
  ['a structured payload', /[{}"\\<>]|synthetic/i],
];
/**
 * Every outgoing request the receiver got, checked for anything sensitive: [] when clean, else one entry per finding naming the request,
 * the field (and line) and the rule, never the value. `secrets` are exact values (broker passwords, the Erlang cookie) refused anywhere,
 * even in the provider credential fields. `provider` ({ token, user }) are the disposable provider credentials: those two fields must
 * equal them exactly and are exempt from the patterns only then. In a message, a line naming a runbook must be exactly
 * `runbook=<APPROVED_RUNBOOK>`; only that validated line is exempt from the patterns. Unknown fields are scanned like any other.
 */
export function outgoingPrivacyViolations(requests, { secrets = [], provider = {} } = {}) {
  const found = [];
  const values = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const scan = (where, text) => {
    if (values.some((s) => text.includes(s))) found.push(`${where}: a broker secret value`);
    for (const [rule, re] of SENSITIVE) if (re.test(text)) found.push(`${where}: ${rule}`);
  };
  requests.forEach((q, i) => {
    const at = `request ${i}`;
    scan(`${at} url`, String(q.url ?? ''));
    if (!q.form) { scan(`${at} body`, String(q.raw ?? '')); return; }
    for (const [k, v] of Object.entries(q.form)) {
      const field = `${at} field ${/^[a-z_]{1,20}$/.test(k) ? k : '<unexpected name>'}`;
      if (k === 'token' || k === 'user') {
        if (values.some((s) => v.includes(s))) found.push(`${field}: a broker secret value`);
        if (v !== provider[k]) found.push(`${field}: not the configured provider credential`);
        continue;
      }
      if (k !== 'message') { scan(field, v); continue; }
      v.split('\n').forEach((line, n) => {
        if (line === `runbook=${APPROVED_RUNBOOK}`) {
          if (values.some((s) => line.includes(s))) found.push(`${field} line ${n}: a broker secret value`);
          return;
        }
        if (/runbook/i.test(line)) found.push(`${field} line ${n}: runbook metadata is not the approved reference`);
        scan(`${field} line ${n}`, line);
      });
    }
  });
  return found;
}

/** Starts the receiver on 127.0.0.1:<port>; `log` is a run-owned file. Returns { requests(), setDelay(ms), close() } (close is idempotent). */
export async function startAlertReceiver({ key, cert, port, log }) {
  const delay = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(WORKER, { eval: true, workerData: { key, cert, port, log, delay } });
  worker.unref();
  let closed;
  const close = () => (closed ??= bounded(worker.terminate(), 10_000, 'stop the local alert receiver'));
  try {
    await bounded(new Promise((ok, fail) => {
      worker.once('message', (m) => (m.listening ? ok() : fail(new Error(`receiver: ${m.error}`))));
      worker.once('error', fail);
      worker.once('exit', (c) => fail(new Error(`receiver exited (${c}) before listening`)));
    }), 10_000, 'the local alert receiver listens');
  } catch (e) {
    await close().catch(() => {});
    throw e;
  }
  return {
    requests: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    setDelay: (ms) => { Atomics.store(delay, 0, ms); },
    close,
  };
}
