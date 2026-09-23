// Stage 15.4 fake Payment service (test-only). Speaks the part of payment-service's HTTP contract Billing uses (create, get, cancel)
// with Payment's REAL creation semantics: the natural key (producer, paymentRequestId) — a second create for the same request returns
// the same payment (200) instead of a new one. Adds what a real service cannot: per-request fault hooks (delay, hold until released,
// process then drop the response), counters of physical calls and of concurrent in-flight calls per key, and settable payment status.
// Never a real provider: loopback only.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { RabbitMqEventBus } from '../../../libs/service-kit/dist/index.js';

export async function fakePayment() {
  const payments = new Map(); // paymentId -> snapshot
  const byRequest = new Map(); // paymentRequestId -> paymentId
  const creates = new Map(); // paymentRequestId -> physical create calls
  const inFlight = new Map(); // paymentRequestId -> concurrent create calls right now
  const maxInFlight = new Map();
  const gets = new Map(); // paymentId -> physical get calls
  let hook = async () => 'normal'; // (paymentRequestId) => 'normal' | 'abort' (never processed, no answer) | 'drop' (created, no answer)
  // (paymentId) => 'normal' | 'unavailable' (503, nothing done: Payment restarting or overloaded) | 'drop' (cancelled, the response lost)
  // | 'open_attempt' (409 payment_has_open_attempt: money may be in flight, nothing done). May be async (to hold the call).
  let cancelHook = async () => 'normal';
  const cancels = new Map(); // paymentId -> physical cancel calls
  const logicalCancels = new Map(); // paymentId -> times the payment actually moved to `cancelled` (must never exceed 1)
  const sockets = new Set();

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (!/^Bearer .+/.test(req.headers.authorization ?? '')) return send(res, 401, { code: 'unauthorized' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/payment/payments') {
      const b = JSON.parse(raw);
      const key = b.paymentRequestId;
      creates.set(key, (creates.get(key) ?? 0) + 1);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      maxInFlight.set(key, Math.max(maxInFlight.get(key) ?? 0, inFlight.get(key)));
      try {
        const mode = await hook(key, b);
        if (mode === 'abort') {
          req.socket.destroy(); // received, never processed: no payment exists, the caller gets no answer
          return;
        }
        let status = 200;
        let id = byRequest.get(key);
        if (!id) {
          id = randomUUID();
          byRequest.set(key, id);
          payments.set(id, { id, paymentRequestId: key, status: 'pending', amount: b.amount, currency: b.currency, sourceType: b.sourceType, sourceId: b.sourceId, payer: b.payer, seller: b.seller, organizationId: b.organizationId ?? null, closedAt: null });
          status = 201;
        }
        if (mode === 'drop') {
          req.socket.destroy(); // the payment exists; the caller never learns it (a lost response)
          return;
        }
        return send(res, status, payments.get(id));
      } finally {
        inFlight.set(key, inFlight.get(key) - 1);
      }
    }
    const m = /^\/payment\/payments\/([^/]+)(\/cancel)?$/.exec(url.pathname);
    if (m && payments.has(m[1])) {
      const p = payments.get(m[1]);
      if (req.method === 'GET') {
        gets.set(p.id, (gets.get(p.id) ?? 0) + 1);
        return send(res, 200, p);
      }
      if (req.method === 'POST' && m[2]) {
        cancels.set(p.id, (cancels.get(p.id) ?? 0) + 1);
        const mode = await cancelHook(p.id);
        if (mode === 'unavailable') return send(res, 503, { code: 'service_unavailable' });
        if (mode === 'open_attempt') return send(res, 409, { code: 'payment_has_open_attempt' });
        // Payment's real semantics (Billing always sends the same Idempotency-Key): a replay of a cancellation answers the cancelled
        // payment again; any other terminal state is refused with invalid_state_transition.
        if (p.status === 'pending' || p.status === 'created') {
          Object.assign(p, { status: 'cancelled', closedAt: new Date().toISOString() });
          logicalCancels.set(p.id, (logicalCancels.get(p.id) ?? 0) + 1);
        } else if (p.status !== 'cancelled') return send(res, 409, { code: 'invalid_state_transition' });
        if (mode === 'drop') {
          req.socket.destroy();
          return;
        }
        return send(res, 200, p);
      }
    }
    return send(res, 404, { code: 'not_found' });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    setHook: (fn) => (hook = fn),
    setCancelHook: (fn) => (cancelHook = fn),
    payments, byRequest, creates, maxInFlight, gets, cancels, logicalCancels,
    /** Marks a payment terminal (what Payment's own state machine would record), for the reconciler and for events. */
    settle: (paymentId, status, closedAt = new Date()) => Object.assign(payments.get(paymentId), { status, closedAt: closedAt.toISOString() }),
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Publishes Payment's events for fake payments, with the payload shape and headers Billing's consumer accepts. */
export function paymentEventPublisher(brokerUrl) {
  const bus = new RabbitMqEventBus({ url: brokerUrl }); // `nawara.events`, as payment-service publishes
  return {
    publish: (name, p, { eventId = randomUUID(), occurredAt = new Date() } = {}) =>
      bus.publish({
        id: eventId,
        name,
        payload: {
          paymentId: p.id, producer: 'billing-service', paymentRequestId: p.paymentRequestId, sourceType: p.sourceType, sourceId: p.sourceId, payer: p.payer,
          seller: p.seller, organizationId: p.organizationId, currency: p.currency, amount: p.amount, revision: 1,
        },
        headers: { eventId, occurredAt: occurredAt.toISOString(), source: 'payment-service', version: 1, correlationId: `validation-${eventId.slice(0, 8)}` },
      }),
    close: () => bus.close(),
  };
}
