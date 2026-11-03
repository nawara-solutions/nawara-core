import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPaymentRefundClient } from './payment-refund-client.js';

const PAYMENT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const FACT = '44444444-4444-4444-8444-444444444444';

/**
 * Core V2 S0-C11 item 7c (BIL-32 J): Billing's reading of Payment's PAY-16 settling capture
 * (`GET /payment/payments/:paymentId/settling-capture`). Only a well-formed 200 about THIS payment is a capture; 404 is "none" (Billing never
 * infers one); 409 `settling_capture_ambiguous` is ambiguous; anything else (unavailable, timeout, malformed, another payment) is `unknown`,
 * which the application turns into the fail-closed 503.
 */
describe('HttpPaymentRefundClient.settlingCapture (Core V2 S0-C11 7c, PAY-16)', () => {
  let server: Server;
  let url = '';
  const answers = new Map<string, { status: number; body?: unknown; hangMs?: number }>();
  let seen: { auth?: string; method?: string } = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen = { auth: req.headers.authorization, method: req.method };
      const a = answers.get(req.url ?? '') ?? { status: 500, body: { code: 'unexpected_path' } };
      setTimeout(() => {
        res.writeHead(a.status, { 'content-type': 'application/json' });
        res.end(a.body === undefined ? 'not json' : JSON.stringify(a.body));
      }, a.hangMs ?? 0);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const path = `/payment/payments/${PAYMENT}/settling-capture`;
  const read = (body: unknown, status = 200, hangMs = 0) => {
    answers.set(path, { status, body, hangMs });
    return new HttpPaymentRefundClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 200 }).settlingCapture(PAYMENT);
  };
  const good = { paymentId: PAYMENT, attemptId: ATTEMPT, factId: FACT, amount: 5300, currency: 'TND', conflicted: false };

  it('a well-formed answer about this payment is its capture, read with Billing\'s own service token', async () => {
    expect(await read(good)).toEqual({ kind: 'capture', capture: good });
    expect(seen).toEqual({ auth: 'Bearer billing-token', method: 'GET' });
    expect(await read({ ...good, conflicted: true })).toEqual({ kind: 'capture', capture: { ...good, conflicted: true } });
  });

  it('404 (no settling capture, or the collapsed answer) is none; 409 settling_capture_ambiguous is ambiguous', async () => {
    expect(await read({ code: 'settling_capture_not_found' }, 404)).toMatchObject({ kind: 'none' });
    expect(await read({ code: 'not_found' }, 404)).toMatchObject({ kind: 'none' });
    expect(await read({ code: 'settling_capture_ambiguous' }, 409)).toEqual({ kind: 'ambiguous' });
  });

  it('everything else is unknown, never a capture or none: unavailable, a timeout, unauthorized, a malformed or another payment\'s answer', async () => {
    const cases: Array<[unknown, number, number?]> = [
      [{ code: 'x' }, 503], [{ code: 'unauthorized' }, 401], [{ code: 'other' }, 404], [{ code: 'other_conflict' }, 409], [undefined, 200],
      [{ ...good, paymentId: '22222222-2222-4222-8222-222222222222' }, 200], [{ ...good, factId: 'not-a-uuid' }, 200], [{ ...good, attemptId: undefined }, 200],
      [{ ...good, amount: 0 }, 200], [{ ...good, amount: 53.5 }, 200], [{ ...good, amount: '5300' }, 200], [{ ...good, currency: 'tnd' }, 200],
      [{ ...good, conflicted: 'false' }, 200], [{ ...good, conflicted: undefined }, 200], [good, 200, 400],
    ];
    for (const [body, status, hang] of cases) expect(await read(body, status, hang), JSON.stringify([body, status, hang])).toMatchObject({ kind: 'unknown' });
  });
});
