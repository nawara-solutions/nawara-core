// Stage 15.5 live-service helpers (test-only): launch Core services from `dist` against throwaway infrastructure, send them signals,
// and reconstruct their shutdown timeline from their own log lines. Reuses the Stage 15 harness (databases, launch, env) and the
// Stage 15.4 fake Payment. Never touches a container or database it did not create.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { generateServiceToken } from '../../../libs/service-kit/dist/index.js';
import * as h from './harness.mjs';
import { uniq } from './kit-world.mjs';

/**
 * One request on a FRESH connection (`agent: false` sends `Connection: close`): the harness's own probes must never hold a
 * keep-alive connection open, because a busy keep-alive connection keeps a closing HTTP server alive (see the keepAlive campaign).
 */
export function probe(base, path, timeoutMs = 1000) {
  const t = h.now();
  return new Promise((resolve) => {
    const req = http.get(`${base}${path}`, { agent: false, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, ms: h.now() - t }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'PROBE_TIMEOUT' })));
    req.on('error', (e) => resolve({ status: e.code === 'PROBE_TIMEOUT' ? 'timeout' : 'unreachable', ms: h.now() - t }));
  });
}

/** Lifecycle lines a shutdown is reconstructed from (every other line is ignored). */
const PHASE = /service_shutdown|worker_drain_timeout|rabbitmq_|_pass_failure|payment_dispatch|db_|outbox_publish_failure|Nest application|ERROR_DURING|shutdown/;

export function liveCore({ adminUrl, rabbit }) {
  /**
   * Starts `service` and waits until its readiness path answers 200 (`/ready`; Auth: `/auth/health`). `databaseUrl` / `brokerUrl`
   * override the throwaway ones (e.g. to go through a TCP proxy).
   */
  async function start(service, { db, databaseUrl, brokerUrl, extra = {}, port, waitReady = true } = {}) {
    const p = port ?? (await h.freePort());
    const svc = h.launch(service, h.serviceEnv(service, { databaseUrl: databaseUrl ?? db.url, brokerUrl: brokerUrl ?? rabbit?.url, port: p, extra: { NODE_ENV: 'test', ...extra } }));
    svc.readyPath = service === 'auth-service' ? '/auth/health' : '/ready';
    if (waitReady && !(await h.waitFor(async () => (await probe(svc.base, svc.readyPath, 2000)).status === 200, 40_000, 50))) {
      const tail = svc.lines.slice(-5).map((l) => String(l.msg).slice(0, 160));
      svc.child.kill('SIGKILL');
      throw new Error(`${service} not ready: ${JSON.stringify(tail)}`);
    }
    return svc;
  }

  /**
   * Sends `signal` and records what happens until the process exits (or `limitMs`): readiness and liveness answers polled every
   * 25 ms on fresh connections, the lifecycle log lines with their offsets, and the exit.
   */
  async function signalAndWatch(svc, { signal = 'SIGTERM', limitMs = 120_000, onSignal } = {}) {
    const probes = [];
    let watching = true;
    const poller = (async () => {
      while (watching) {
        const t = h.now();
        const [ready, health] = await Promise.all([probe(svc.base, svc.readyPath), probe(svc.base, svc.readyPath === '/ready' ? '/health' : '/auth/health')]);
        probes.push({ t, ready: ready.status, health: health.status });
        await h.sleep(25);
      }
    })();
    await h.sleep(60);
    const tS = h.now();
    svc.child.kill(signal);
    onSignal?.(tS);
    const ex = await Promise.race([svc.exited, h.sleep(limitMs).then(() => null)]);
    watching = false;
    await poller;
    const after = probes.filter((p) => p.t >= tS);
    const lastReady200 = after.filter((p) => p.ready === 200).at(-1);
    const firstRefused = after.find((p) => p.ready === 'unreachable' && p.health === 'unreachable');
    const firstNotReady = after.find((p) => p.ready !== 200);
    const phases = svc.since(tS, (l) => PHASE.test(String(l.msg))).map((l) => ({ ms: h.round(l.t - tS), msg: String(l.msg).split(' —')[0].slice(0, 140) }));
    const at = (re) => phases.find((p) => re.test(p.msg))?.ms ?? null;
    return {
      exitedMs: ex ? h.round(ex.t - tS) : null, exit: ex ? ex.code ?? ex.signal : 'still running', shutdownStartedMs: at(/service_shutdown_started/),
      shutdownCompleteMs: at(/service_shutdown_complete/), readyLast200Ms: lastReady200 ? h.round(lastReady200.t - tS) : null,
      readyFirstNot200Ms: firstNotReady ? h.round(firstNotReady.t - tS) : null, firstNot200Status: firstNotReady?.ready ?? null,
      connectionsRefusedMs: firstRefused ? h.round(firstRefused.t - tS) : null, phases, tS,
    };
  }

  /**
   * Billing with a fake Payment: a producer token, per-organization products/prices, and seeding of issued invoices whose payment
   * requests reach `requested` (the real dispatcher calls the fake Payment). `pay` is shared by every Billing instance of the world.
   */
  async function billingWorld({ pay, extra = {} } = {}) {
    const { fakePayment } = await import('./fake-payment.mjs');
    const db = await h.throwawayDatabase(adminUrl, 'billing-service');
    const fake = pay ?? (await fakePayment());
    const producer = generateServiceToken();
    const env = (more = {}) => ({
      SERVICE_TOKENS: `test-producer:${producer.digest}`, PAYMENT_SERVICE_URL: fake.url, BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000',
      BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '100000', BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '100000', // seeding only
      ...extra, ...more,
    });
    const nodes = [];
    const startBilling = async (o = {}) => {
      const svc = await start('billing-service', { db, ...o, extra: env(o.extra) });
      nodes.push(svc);
      return svc;
    };
    /** One API call on a fresh connection (never a pooled keep-alive connection: see `probe`). Rejects when the instance is unreachable. */
    const api = (method, path, body, node) => {
      const n = node ?? nodes.find((x) => x.alive());
      const data = body ? JSON.stringify(body) : undefined;
      return new Promise((resolve, reject) => {
        const req = http.request(`${n.base}${path}`, { method, agent: false, headers: { authorization: `Bearer ${producer.token}`, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      });
    };
    const prices = new Map();
    const priceFor = async (org, recurring) => {
      if (!prices.has(org)) {
        const product = await api('POST', '/billing/products', { seller: { type: 'organization', id: org }, code: `p-${uniq()}`, name: 'Validation product' });
        const mk = (x) => api('POST', '/billing/prices', { productId: product.json.id, clientReference: `r-${uniq()}`, currency: 'TND', unitAmount: 1000, effectiveFrom: new Date(Date.now() - 60_000).toISOString(), ...x });
        prices.set(org, { oneTime: (await mk({ interval: 'one_time' })).json.id, recurring: (await mk({ interval: 'recurring', intervalUnit: 'month', intervalCount: 1 })).json.id });
      }
      return prices.get(org)[recurring ? 'recurring' : 'oneTime'];
    };
    /** Issued invoices with one payment request each: [{ requestId, invoiceId, org }]; `waitRequested` waits for the dispatcher. */
    const seed = async (n, { orgs = [randomUUID()], recurring = false, waitRequested = true } = {}) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const org = orgs[i % orgs.length];
        const inv = await api('POST', '/billing/invoices', {
          invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: `payer-${uniq()}` }, sourceType: 'contract', sourceId: `src-${uniq()}`,
          issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: await priceFor(org, recurring), quantity: 1 }],
        });
        const iss = await api('POST', `/billing/invoices/${inv.json?.id}/issue`);
        const pr = await api('POST', `/billing/invoices/${inv.json?.id}/payment-requests`);
        if (inv.status !== 201 || iss.status !== 200 || pr.status !== 201) throw new Error(`seeding failed: invoice ${inv.status} issue ${iss.status} request ${pr.status}`);
        out.push({ requestId: pr.json.id, invoiceId: inv.json.id, org });
      }
      if (waitRequested && !(await requested(out))) throw new Error('seeded requests did not reach requested');
      return out;
    };
    const q = (sql, params) => h.adminQuery(db.url, sql, params);
    const requested = (items, timeoutMs = 60_000) =>
      h.waitFor(async () => (await q(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'requested'`, [items.map((x) => x.requestId)]))[0].n === items.length, timeoutMs, 100);
    const close = async () => {
      for (const x of nodes) if (x.alive()) x.child.kill('SIGKILL');
      await Promise.all(nodes.map((x) => x.exited));
      if (!pay) await fake.close();
      await db.drop();
    };
    return { db, pay: fake, producer, nodes, startBilling, api, seed, q, requested, close, env };
  }

  return { start, signalAndWatch, billingWorld };
}

/** Summary of the lifecycle timeline across runs: median [min–max] of every numeric field that all runs report. */
export function timeline(runs) {
  const keys = ['exitedMs', 'shutdownStartedMs', 'shutdownCompleteMs', 'readyLast200Ms', 'readyFirstNot200Ms', 'connectionsRefusedMs'];
  const out = {};
  for (const k of keys) {
    const xs = runs.map((r) => r[k]).filter((x) => typeof x === 'number');
    if (xs.length) out[k] = xs.length === runs.length ? h.stats(xs) : { ...h.stats(xs), missingIn: runs.length - xs.length };
  }
  out.exits = [...new Set(runs.map((r) => r.exit))];
  return out;
}
