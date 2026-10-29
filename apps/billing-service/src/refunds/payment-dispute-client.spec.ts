import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPaymentDisputeClient } from './payment-dispute-client.js';

const PAYMENT = '11111111-1111-4111-8111-111111111111';

/**
 * Core V2 S6e-D (the Owner's R6E-4): Billing's reading of Payment's authoritative exposure. Only `clear` is "no dispute"; `exposed` blocks; an
 * `unresolved` exposure, a 404, a timeout, a malformed or foreign answer are never zero: each throws the fail-closed 503.
 */
describe('HttpPaymentDisputeClient (Core V2 S6e-D)', () => {
  let server: Server;
  let url = '';
  const answers = new Map<string, { status: number; body?: unknown; hangMs?: number }>();
  let seen: { auth?: string } = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen = { auth: req.headers.authorization };
      const a = answers.get(req.url ?? '') ?? { status: 404, body: { code: 'not_found' } };
      setTimeout(() => {
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(a.body === undefined ? 'not json' : JSON.stringify(a.body));
      }, a.hangMs ?? 0);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const client = () => new HttpPaymentDisputeClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 200 });
  const path = `/payment/payments/${PAYMENT}/dispute-exposure`;
  const status = (body: unknown, code = 200, hangMs = 0) => {
    answers.set(path, { status: code, body, hangMs });
    return client().status(PAYMENT, AbortSignal.timeout(100));
  };
  const code503 = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'resolved';
    } catch (e) {
      const x = e as { getStatus?: () => number; getResponse?: () => { code?: string } };
      return `${x.getStatus?.()} ${x.getResponse?.().code}`;
    }
  };

  it('clear is none and exposed is open, with Billing\'s own service token', async () => {
    expect(await status({ paymentId: PAYMENT, state: 'clear' })).toBe('none');
    expect(seen.auth).toBe('Bearer billing-token');
    expect(await status({ paymentId: PAYMENT, state: 'exposed' })).toBe('open');
  });

  it('unresolved, not found, unavailable, a timeout, a malformed or another payment\'s answer all fail closed (503), never none', async () => {
    for (const [body, code] of [[{ paymentId: PAYMENT, state: 'unresolved' }, 200], [{ code: 'not_found' }, 404], [{ code: 'x' }, 503], [undefined, 200],
      [{ paymentId: '22222222-2222-4222-8222-222222222222', state: 'clear' }, 200], [{ paymentId: PAYMENT, state: 'zero' }, 200]] as const) {
      expect(await code503(status(body, code)), JSON.stringify(body)).toBe('503 refund_dispute_unavailable');
    }
    expect(await code503(status({ paymentId: PAYMENT, state: 'clear' }, 200, 400))).toBe('503 refund_dispute_unavailable');
  });

  it('the losses read accepts only well-formed losses with their verified chargeback', async () => {
    const loss = { disputeId: '33333333-3333-4333-8333-333333333333', paymentId: PAYMENT, paymentRequestId: '44444444-4444-4444-8444-444444444444', amount: 4900, currency: 'TND',
      lostAt: '2026-10-29T10:00:00.000Z', chargeback: { factId: '55555555-5555-4555-8555-555555555555', amount: 4900, currency: 'TND' }, liveMode: false };
    answers.set('/payment/disputes/losses?limit=200', { status: 200, body: { items: [loss] } });
    expect(await client().losses(undefined, 200)).toEqual([{ ...(({ liveMode: _l, ...x }) => x)(loss) }]);
    answers.set('/payment/disputes/losses?limit=200', { status: 200, body: { items: [{ ...loss, chargeback: null }] } });
    await expect(client().losses(undefined, 200)).rejects.toThrow(/malformed/);
    answers.set('/payment/disputes/losses?limit=200', { status: 503, body: {} });
    await expect(client().losses(undefined, 200)).rejects.toThrow(/status 503/);
  });
});
