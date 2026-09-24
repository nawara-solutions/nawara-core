// Stage 15.6 cross-service topology (test-only): REAL Billing and Payment processes wired as in production, with every cross-service
// edge individually breakable. Reuses the Stage 15 harness (throwaway databases, launch, env), live-core (start / probe) and the kit's
// BrokerProxy (a TCP relay that can freeze or sever). Nothing here is a production dependency.
//
//   Billing ──HTTP (fault proxy)──► Payment          PAYMENT_SERVICE_URL, service token, PAYMENT_TIMEOUT_MS
//   Payment ──RabbitMQ (proxy)──► Billing queue      payment.* events: Payment outbox → billing.payment-events → receipts
//   Billing/Payment ──HTTP──► Auth (fake)            /auth/me for payer bearers only (AuthClient; fails closed)
//   each service ──TCP (proxy)──► PostgreSQL         its own throwaway database
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { generateServiceToken } from '../../../libs/service-kit/dist/index.js';
import { BrokerProxy } from '../../../libs/service-kit/dist/testing/broker-proxy.js';
import * as h from './harness.mjs';
import { uniq } from './kit-world.mjs';
import { liveCore, probe } from './live-core.mjs';

/** Minimal Auth stand-in for payer bearers: `Bearer u-<id>` is the active user `u-<id>` with no memberships; anything else is 401. */
export async function fakeAuth() {
  let down = false;
  const calls = { me: 0 };
  const server = http.createServer((req, res) => {
    if (down) return req.socket.destroy();
    const m = /^Bearer (u-[A-Za-z0-9-]+)$/.exec(req.headers.authorization ?? '');
    if (req.url === '/auth/me') {
      calls.me++;
      if (!m) return res.writeHead(401).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: m[1], adminTier: null, isActive: true, memberships: [] }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, setDown: (v) => (down = v), close: () => new Promise((r) => server.close(r)) };
}

/**
 * HTTP fault proxy for the Billing → Payment edge. Modes: `pass`; `refuse` (the connection is dropped before anything reaches Payment);
 * `blackhole` (accepted, never answered: a hung Payment); `unavailable` (503, Payment never reached); `drop` (forwarded, Payment answers, the answer is lost); `truncate` (the status
 * and headers reach the caller, the body is cut). `onRequest(req)` may return a mode per request. Counts what each mode did.
 */
export async function httpFaultProxy(targetPort) {
  let mode = 'pass';
  let onRequest = null;
  const seen = [];
  const server = http.createServer((req, res) => {
    const m = onRequest?.(req) ?? mode;
    seen.push({ t: h.now(), method: req.method, url: req.url, mode: m });
    if (m === 'refuse') return req.socket.destroy();
    if (m === 'blackhole') return; // never answered
    if (m === 'unavailable') { // Payment answers 503 without being reached (Stage 15.7: a failing dependency, repeated)
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
      return res.end(JSON.stringify({ statusCode: 503, message: 'Service Unavailable', error: 'Service Unavailable' }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const up = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers, agent: false }, (r) => {
        if (m === 'drop') {
          r.resume();
          r.on('end', () => req.socket.destroy());
          return;
        }
        res.writeHead(r.statusCode, r.headers);
        if (m === 'truncate') {
          r.once('data', (c) => {
            res.write(c.subarray(0, Math.max(1, c.length >> 1)));
            req.socket.destroy();
          });
          return;
        }
        r.pipe(res);
      });
      up.on('error', () => req.socket.destroy());
      up.end(Buffer.concat(chunks));
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, seen,
    setMode: (m) => (mode = m), setOnRequest: (fn) => (onRequest = fn),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** A BrokerProxy that also exposes `down()` / `up()` (connections refused while down: the dependency is gone, not merely silent). */
async function tcpProxy(port) {
  const p = new BrokerProxy({ host: '127.0.0.1', port });
  await p.start();
  const fixed = p.port;
  return Object.assign(p, {
    down: async () => {
      p.thaw();
      await p.sever();
    },
    up: async () => {
      p.port = fixed;
      await p.start();
    },
    via: (url) => h.via(url, fixed),
  });
}

export function coreStacks({ adminUrl, rabbit, pgPort }) {
  const core = liveCore({ adminUrl, rabbit });
  /**
   * Billing + Payment, real processes on fixed ports (restarts keep every URL). `billingEnv` / `paymentEnv` add settings.
   * Returns controls for every edge and helpers that drive the real APIs.
   */
  return async function stack({ billingEnv = {}, paymentEnv = {}, startBilling = true, startPayment = true } = {}) {
    const bdb = await h.throwawayDatabase(adminUrl, 'billing-service');
    const pdb = await h.throwawayDatabase(adminUrl, 'payment-service');
    const dbProxy = { billing: await tcpProxy(pgPort), payment: await tcpProxy(pgPort) };
    const brokerProxy = { billing: await tcpProxy(rabbit.port), payment: await tcpProxy(rabbit.port) };
    const auth = await fakeAuth();
    const ports = { billing: await h.freePort(), payment: await h.freePort() };
    const payHttp = await httpFaultProxy(ports.payment);
    const producer = generateServiceToken();
    const b2p = generateServiceToken();
    const procs = { billing: null, payment: null };
    const env = {
      billing: () => ({
        SERVICE_TOKENS: `test-producer:${producer.digest}`, PAYMENT_SERVICE_URL: payHttp.url, PAYMENT_SERVICE_TOKEN: b2p.token, AUTH_SERVICE_URL: auth.url,
        BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '100000', BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '100000', // seeding only
        ...billingEnv,
      }),
      payment: () => ({ SERVICE_TOKENS: `billing-service:${b2p.digest}`, AUTH_SERVICE_URL: auth.url, ...paymentEnv }),
    };
    const start = async (name, { waitReady = true, extra = {} } = {}) => {
      const svc = await core.start(`${name}-service`, {
        db: name === 'billing' ? bdb : pdb, databaseUrl: dbProxy[name].via((name === 'billing' ? bdb : pdb).url), brokerUrl: `amqp://guest:guest@127.0.0.1:${brokerProxy[name].port}`,
        port: ports[name], waitReady, extra: { ...env[name](), ...extra },
      });
      procs[name] = svc;
      return svc;
    };
    const stop = async (name) => {
      const p = procs[name];
      if (p?.alive()) {
        const t = h.now();
        p.child.kill('SIGTERM');
        await p.exited;
        return h.round(h.now() - t);
      }
      return null;
    };
    const kill = async (name) => {
      const p = procs[name];
      if (p?.alive()) {
        p.child.kill('SIGKILL');
        await p.exited;
      }
    };
    if (startPayment) await start('payment');
    if (startBilling) await start('billing');

    // ---- raw HTTP (fresh connections)
    const call = (base, method, path, { token, body, headers = {} } = {}) => {
      const data = body ? JSON.stringify(body) : undefined;
      return new Promise((resolve) => {
        const t = h.now();
        const req = http.request(`${base}${path}`, {
          method, agent: false, timeout: 20_000,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers },
        }, (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ } resolve({ status: res.statusCode, json, ms: h.round(h.now() - t) }); });
        });
        req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT' })));
        req.on('error', (e) => resolve({ status: e.code ?? 'error', json: null, ms: h.round(h.now() - t) }));
        if (data) req.write(data);
        req.end();
      });
    };
    const base = (name) => `http://127.0.0.1:${ports[name]}`;
    const billingApi = (method, path, body) => call(base('billing'), method, path, { token: producer.token, body });

    // ---- the commercial flow through the real APIs
    const prices = new Map();
    const priceFor = async (org) => {
      if (!prices.has(org)) {
        const product = await billingApi('POST', '/billing/products', { seller: { type: 'organization', id: org }, code: `p-${uniq()}`, name: 'Validation product' });
        const price = await billingApi('POST', '/billing/prices', { productId: product.json.id, clientReference: `r-${uniq()}`, currency: 'TND', unitAmount: 1000, interval: 'one_time', effectiveFrom: new Date(Date.now() - 60_000).toISOString() });
        prices.set(org, price.json.id);
      }
      return prices.get(org);
    };
    /** Issued invoice + open invoice (no request yet): { invoiceId, org, payer }. */
    const invoice = async (org = randomUUID()) => {
      const payer = `u-${randomUUID()}`;
      const inv = await billingApi('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: payer }, sourceType: 'contract', sourceId: `src-${uniq()}`,
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: await priceFor(org), quantity: 1 }],
      });
      const iss = await billingApi('POST', `/billing/invoices/${inv.json?.id}/issue`);
      if (inv.status !== 201 || iss.status !== 200) throw new Error(`invoice ${inv.status} issue ${iss.status}`);
      return { invoiceId: inv.json.id, org, payer };
    };
    const request = async (inv) => {
      const pr = await billingApi('POST', `/billing/invoices/${inv.invoiceId}/payment-requests`);
      if (pr.status !== 201 && pr.status !== 200) throw new Error(`payment request ${pr.status} ${JSON.stringify(pr.json)}`);
      return { ...inv, requestId: pr.json.id };
    };
    const seed = async (n, { orgs = [randomUUID()], wait = true } = {}) => {
      const out = [];
      for (let i = 0; i < n; i++) out.push(await request(await invoice(orgs[i % orgs.length])));
      if (wait && !(await requested(out))) throw new Error('seeded requests did not reach requested');
      return out;
    };
    const bq = (sql, p) => h.adminQuery(bdb.url, sql, p);
    const pq = (sql, p) => h.adminQuery(pdb.url, sql, p);
    const requested = (items, ms = 60_000) =>
      h.waitFor(async () => (await bq(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1) AND status = 'requested'`, [items.map((x) => x.requestId)]))[0].n === items.length, ms, 100);
    const paymentOf = async (item) => (await pq(`SELECT id, status FROM payment WHERE "paymentRequestId"::text = $1`, [item.requestId]));
    const billingCancel = (item) => billingApi('POST', `/billing/payment-requests/${item.requestId}/cancel`);
    /** Payment-side operation that needs no Billing: the producer's own cancel, sent straight to Payment with Billing's credential. */
    const paymentCancelDirect = async (item) => {
      const [p] = await paymentOf(item);
      return call(base('payment'), 'POST', `/payment/payments/${p.id}/cancel`, { token: b2p.token, headers: { 'idempotency-key': `billing-cancel-${item.requestId}` } });
    };
    /** The payer pays: attempt (test provider, `success`) then sync → Payment records `succeeded` and emits `payment.succeeded`. */
    const pay = async (item) => {
      const [p] = await paymentOf(item);
      const a = await call(base('payment'), 'POST', `/payment/payments/${p.id}/attempts`, { token: item.payer, body: { provider: 'test', providerOptions: { scenario: 'success' } }, headers: { 'idempotency-key': `a-${randomUUID()}` } });
      if (a.status !== 201) return { attempt: a.status, code: a.json?.code };
      const s = await call(base('payment'), 'POST', `/payment/payments/${p.id}/attempts/${a.json.id}/sync`, { token: item.payer });
      return { attempt: a.status, sync: s.status, code: s.json?.code };
    };
    const state = async (item) => {
      const [r] = await bq(`SELECT pr.status AS request, i.status AS invoice, pr."paymentId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`, [item.requestId]);
      const [rc] = await bq(`SELECT count(*)::int AS receipts, count(*) FILTER (WHERE outcome = 'applied')::int AS applied FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [item.requestId]);
      const pays = await paymentOf(item);
      const [ev] = pays[0] ? await pq(`SELECT count(*) FILTER (WHERE name IN ('payment.succeeded','payment.failed','payment.cancelled','payment.expired'))::int AS terminal, count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS unpublished FROM outbox WHERE payload->>'paymentId' = $1`, [pays[0].id]) : [{ terminal: 0, unpublished: 0 }];
      return { request: r?.request, invoice: r?.invoice, receipts: rc.receipts, applied: rc.applied, payments: pays.length, payment: pays[0]?.status ?? null, terminalEvents: ev.terminal, unpublished: ev.unpublished, paymentIdMatches: pays.length === 1 && r?.paymentId === pays[0].id };
    };
    const until = async (item, pred, ms = 60_000) => h.waitFor(async () => { const s = await state(item); return pred(s) && s; }, ms, 100);
    /** Accounting over many items: every one must satisfy `final(state)`, with one payment, one applied receipt at most, ≤ 1 terminal event. */
    const account = async (items) => {
      const rows = [];
      for (const it of items) rows.push(await state(it));
      return {
        items: rows.length, requestStates: rows.reduce((m, r) => ((m[r.request] = (m[r.request] ?? 0) + 1), m), {}), invoiceStates: rows.reduce((m, r) => ((m[r.invoice] = (m[r.invoice] ?? 0) + 1), m), {}),
        maxPaymentsPerRequest: Math.max(0, ...rows.map((r) => r.payments)), maxAppliedPerRequest: Math.max(0, ...rows.map((r) => r.applied)), maxTerminalEventsPerPayment: Math.max(0, ...rows.map((r) => r.terminalEvents)),
        paymentIdMismatches: rows.filter((r) => r.payments && r.request !== 'created' && r.request !== 'sending' && !r.paymentIdMatches).length,
        crossTenant: (await bq(`SELECT count(*)::int AS n FROM invoice i JOIN payment_request pr ON pr."invoiceId" = i.id WHERE pr.id = ANY($1) AND i."organizationId"::text <> i."sellerId"`, [items.map((x) => x.requestId)]))[0].n,
      };
    };
    const brokerList = (fn) => { try { return fn(); } catch { return null; } }; // rabbitmqctl cannot answer while the broker app is stopped
    const resources = async () => {
      const q = brokerList(() => rabbit.queues())?.find((x) => x.name === 'billing.payment-events');
      const s = await h.sessions(adminUrl, null);
      const [bo] = await bq(`SELECT count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS n FROM outbox`).catch(() => [{ n: null }]);
      const [po] = await pq(`SELECT count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS n FROM outbox`).catch(() => [{ n: null }]);
      return {
        brokerConnections: brokerList(() => rabbit.connections().length), brokerChannels: brokerList(() => rabbit.channels().length), queueConsumers: Number(q?.consumers ?? 0), queueReady: Number(q?.messages_ready ?? 0),
        queueUnacked: Number(q?.messages_unacknowledged ?? 0), dbSessions: { billing: s.byDatabase[bdb.name] ?? 0, payment: s.byDatabase[pdb.name] ?? 0 }, idleInTx: s.byState['idle in transaction'] ?? 0,
        outboxPending: { billing: bo.n, payment: po.n }, processes: Object.values(procs).filter((p) => p?.alive()).length,
      };
    };
    const readiness = async () => Object.fromEntries(await Promise.all(['billing', 'payment'].map(async (n) => {
      const alive = Boolean(procs[n]?.alive());
      if (!alive) return [n, { alive, health: 'down', ready: 'down' }];
      const [r, l] = await Promise.all([probe(base(n), '/ready', 3000), probe(base(n), '/health', 3000)]);
      return [n, { alive, health: l.status, ready: r.status }];
    })));
    const close = async () => {
      // A campaign that stopped the broker app must never leave it stopped for the next one (harness hygiene).
      try { rabbit.queues(); } catch { await rabbit.appStart().catch(() => undefined); }
      for (const p of Object.values(procs)) if (p?.alive()) p.child.kill('SIGKILL');
      await Promise.all(Object.values(procs).filter(Boolean).map((p) => p.exited));
      for (const p of [...Object.values(dbProxy), ...Object.values(brokerProxy)]) { p.thaw(); await p.sever().catch(() => undefined); }
      await payHttp.close();
      await auth.close();
      await bdb.drop();
      await pdb.drop();
    };
    return {
      bdb, pdb, dbProxy, brokerProxy, auth, payHttp, producer, b2p, procs, ports, start, stop, kill, base, call, billingApi, invoice, request, seed, requested,
      bq, pq, paymentOf, billingCancel, paymentCancelDirect, pay, state, until, account, resources, readiness, close,
    };
  };
}
