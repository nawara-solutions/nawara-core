import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPaymentRefundClient } from './payment-refund-client.js';

const PAYMENT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '33333333-3333-4333-8333-333333333333';
const FACT = '44444444-4444-4444-8444-444444444444';

/**
 * Core V2 S0-C11 item 7c (BIL-32 J, L): Billing's reading of Payment's PAY-16 settling capture
 * (`GET /payment/payments/:paymentId/settling-capture`). Only a well-formed 200 about THIS payment is a capture; `404 settling_capture_not_found`
 * is "none" (Billing never infers one); 409 `settling_capture_ambiguous` is ambiguous; anything else (the collapsed `404 not_found` (C-2),
 * unavailable, unauthorized, timeout, malformed, another payment) is `unknown`, which the application turns into the fail-closed 503.
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

  it('404 settling_capture_not_found is none; 409 settling_capture_ambiguous is ambiguous', async () => {
    expect(await read({ code: 'settling_capture_not_found', message: 'This payment has no verified settling capture.' }, 404))
      .toEqual({ kind: 'none', reason: 'settling_capture_not_found' });
    expect(await read({ code: 'settling_capture_ambiguous' }, 409)).toEqual({ kind: 'ambiguous' });
  });

  it('BIL-32 L (C-2): the collapsed 404 not_found (no payment.read, a payment not held as Billing\'s, a malformed id) is unknown, never none', async () => {
    const collapsed = await read({ code: 'not_found', message: 'Not found.' }, 404);
    expect(collapsed).toMatchObject({ kind: 'unknown' });
    expect(collapsed.kind, 'an authorization-shaped answer never reads as absent evidence').not.toBe('none');
  });

  it('everything else is unknown, never a capture or none: unavailable, a timeout, unauthorized, a malformed or another payment\'s answer', async () => {
    const cases: Array<[unknown, number, number?]> = [
      [{ code: 'x' }, 503], [{ code: 'unauthorized' }, 401], [{ code: 'not_found' }, 404], [{ code: 'operation_not_permitted' }, 403], [{ code: 'other' }, 404], [{ code: 'other_conflict' }, 409], [undefined, 200],
      [{ ...good, paymentId: '22222222-2222-4222-8222-222222222222' }, 200], [{ ...good, factId: 'not-a-uuid' }, 200], [{ ...good, attemptId: undefined }, 200],
      [{ ...good, amount: 0 }, 200], [{ ...good, amount: 53.5 }, 200], [{ ...good, amount: '5300' }, 200], [{ ...good, currency: 'tnd' }, 200],
      [{ ...good, conflicted: 'false' }, 200], [{ ...good, conflicted: undefined }, 200], [good, 200, 400],
    ];
    for (const [body, status, hang] of cases) expect(await read(body, status, hang), JSON.stringify([body, status, hang])).toMatchObject({ kind: 'unknown' });
  });
});

/**
 * Core V2 S0-C11 BIL-32 M: the production client's R6H-5 capture read (`GET /payment/payments/:paymentId/captures/:factId`) states WHICH 404
 * Payment answered, with Payment's exact bodies. Only L-4 input (b) acts on the reason; every other consumer reads `kind` alone, unchanged.
 */
describe('HttpPaymentRefundClient.capture (Core V2 S0-C11 BIL-32 M, R6H-5)', () => {
  let server: Server;
  let url = '';
  let answer: { status: number; body?: unknown } = { status: 500 };
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body === undefined ? 'not json' : JSON.stringify(answer.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const read = (status: number, body?: unknown) => {
    answer = { status, body };
    return new HttpPaymentRefundClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 200 }).capture(PAYMENT, FACT);
  };
  const capture = { factId: FACT, paymentId: PAYMENT, provider: 'simulation', amount: 5300, currency: 'TND', paymentStatus: 'failed', basis: 'late_capture',
    conflicted: false, refund: 'none', refundableOnItsOwn: true, attemptCaptures: 1, observedAt: '2026-11-03T10:00:00.000Z' };

  it('404 capture_not_found and the collapsed 404 not_found are both not_found, each with its own reason; any other 404 is unrecognized', async () => {
    expect(await read(404, { message: 'No verified capture of this payment has this identifier.', code: 'capture_not_found' }))
      .toEqual({ kind: 'not_found', reason: 'capture_not_found' });
    expect(await read(404, { message: 'Not found.', code: 'not_found' })).toEqual({ kind: 'not_found', reason: 'collapsed' });
    expect(await read(404, { statusCode: 404, message: 'Cannot GET /x', error: 'Not Found' })).toEqual({ kind: 'not_found', reason: 'unrecognized' });
    expect(await read(404)).toEqual({ kind: 'not_found', reason: 'unrecognized' });
  });

  it('a well-formed capture is a capture; 403, 401, 400, 5xx, a malformed or another fact\'s answer prove nothing (unknown), unchanged', async () => {
    expect(await read(200, capture)).toMatchObject({ kind: 'capture', capture: { factId: FACT, paymentId: PAYMENT, amount: 5300, conflicted: false } });
    for (const [status, body] of [[403, { message: 'You may not perform this operation.', code: 'operation_not_permitted' }], [401, { code: 'unauthorized' }],
      [400, { code: 'bad_request' }], [503, { code: 'x' }], [200, { ...capture, factId: ATTEMPT }], [200, { ...capture, amount: '5300' }], [200, undefined]] as const) {
      expect(await read(status, body), JSON.stringify([status, body])).toMatchObject({ kind: 'unknown' });
    }
  });

  it('S0-C12 item 14: attemptCaptures reaches the consumer; a missing, malformed or inconsistent count proves nothing (fails closed)', async () => {
    expect(await read(200, { ...capture, attemptCaptures: 2 })).toMatchObject({ kind: 'capture', capture: { attemptCaptures: 2 } });
    expect(await read(200, { ...capture, basis: 'settling_capture', attemptCaptures: 1 })).toMatchObject({ kind: 'capture' });
    expect(await read(200, { ...capture, basis: 'duplicate_capture', attemptCaptures: 2 })).toMatchObject({ kind: 'capture' });
    expect(await read(200, { ...capture, basis: 'associated_capture', attemptCaptures: 0 })).toMatchObject({ kind: 'capture' });
    const { attemptCaptures: _omitted, ...withoutCount } = capture;
    for (const body of [withoutCount, { ...capture, attemptCaptures: '1' }, { ...capture, attemptCaptures: 1.5 }, { ...capture, attemptCaptures: -1 }, { ...capture, attemptCaptures: null },
      { ...capture, attemptCaptures: 0 }, { ...capture, basis: 'settling_capture', attemptCaptures: 2 }, { ...capture, basis: 'duplicate_capture', attemptCaptures: 1 },
      { ...capture, basis: 'associated_capture', attemptCaptures: 1 }]) {
      expect(await read(200, body), JSON.stringify(body)).toEqual({ kind: 'unknown', reason: 'inconsistent_capture_count' });
    }
  });

  it('S0-C12 item 17: a well-formed read of this fact in a 1 to 16 character non-ISO currency is known ineligible, carrying no value; other shapes and another fact prove nothing', async () => {
    for (const currency of ['XY1', 'A', 'ABCDEFGHIJKLMNOP', 'tnd', 'ÉÉÉÉ']) expect(await read(200, { ...capture, currency }), currency).toEqual({ kind: 'ineligible_currency' });
    for (const currency of ['', 'ABCDEFGHIJKLMNOPQ']) expect(await read(200, { ...capture, currency }), currency).toEqual({ kind: 'unknown', reason: 'malformed_capture' });
    expect(await read(200, { ...capture, currency: 5300 })).toEqual({ kind: 'unknown', reason: 'malformed_capture' });
    expect(await read(200, { ...capture, currency: 'XY1', factId: ATTEMPT })).toMatchObject({ kind: 'unknown' });
    expect(await read(200, { ...capture, currency: 'XY1', attemptCaptures: 0 })).toEqual({ kind: 'unknown', reason: 'inconsistent_capture_count' });
    expect(await read(503, { ...capture, currency: 'XY1' })).toMatchObject({ kind: 'unknown' });
  });
});

/**
 * Core V2 S0-C14 item 6: PAY-08's refund evidence reaches Billing. Each authorization's verified allocations and the producer's unallocated refund
 * facts are parsed; a malformed allocation or fact refuses the whole answer (it proves nothing); an answer without `unallocatedFacts` is `null`,
 * which the evidence judgement treats as unproven (fail closed).
 */
describe('HttpPaymentRefundClient.refunds: refund evidence (Core V2 S0-C14 item 6, PAY-08)', () => {
  let server: Server;
  let url = '';
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const read = (body: unknown, status = 200) => {
    answer = { status, body };
    return new HttpPaymentRefundClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 500 }).refunds(PAYMENT);
  };
  const AUTH = '55555555-5555-4555-8555-555555555555';
  const CASE = '66666666-6666-4666-8666-666666666666';
  const authorization = (over: Record<string, unknown> = {}) => ({ refundAuthorizationId: AUTH, refundAttemptId: ATTEMPT, refundCaseId: CASE, approvedAmount: 5300, currency: 'TND',
    completedAt: null, ...over });

  it('parses allocations and unallocated facts; the producer view without the field is null (unproven), an older Payment\'s authorization without allocations has none', async () => {
    const r = await read({ attempts: [], refusals: [], authorizations: [authorization({ allocations: [{ factId: FACT, amount: 5300, currency: 'TND', intended: 5300, excess: 0 }] })],
      unallocatedFacts: [{ factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'TND', state: 'blocked', blockedReason: 'x' },
        { factId: FACT, refundAttemptId: null, amount: 100, currency: 'TND', state: 'pending', blockedReason: null }] });
    expect(r!.authorizations[0]!.allocations).toEqual([{ factId: FACT, amount: 5300, currency: 'TND' }]);
    // Core V2 DO-73: the block reason is kept as Payment states it (a bounded code), or null while pending
    expect(r!.unallocatedFacts).toEqual([{ factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'TND', state: 'blocked', blockedReason: 'x' },
      { factId: FACT, refundAttemptId: null, amount: 100, currency: 'TND', state: 'pending', blockedReason: null }]);
    // an answer without the reason, or with one that is not a bounded code, carries none (DO-73 then opens nothing)
    const unreasoned = await read({ attempts: [], refusals: [], authorizations: [], unallocatedFacts: [{ factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'EUR', state: 'blocked' },
      { factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'EUR', state: 'blocked', blockedReason: 'Not A Code!' }] });
    expect(unreasoned!.unallocatedFacts).toEqual([{ factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'EUR', state: 'blocked' },
      { factId: FACT, refundAttemptId: ATTEMPT, amount: 100, currency: 'EUR', state: 'blocked' }]);
    const older = await read({ attempts: [], refusals: [], authorizations: [authorization()] });
    expect(older!.unallocatedFacts).toBeNull();
    expect(older!.authorizations[0]!.allocations).toEqual([]);
  });

  it('a malformed allocation or unallocated fact refuses the whole answer; 404 is null; anything else throws', async () => {
    await expect(read({ attempts: [], refusals: [], authorizations: [authorization({ allocations: [{ factId: 'x', amount: 1, currency: 'TND' }] })], unallocatedFacts: [] })).rejects.toThrow(/malformed allocation/);
    await expect(read({ attempts: [], refusals: [], authorizations: [authorization({ allocations: 'none' })], unallocatedFacts: [] })).rejects.toThrow(/malformed allocations/);
    await expect(read({ attempts: [], refusals: [], authorizations: [], unallocatedFacts: [{ factId: FACT, refundAttemptId: ATTEMPT, amount: 1, currency: 'TND', state: 'done' }] })).rejects.toThrow(/malformed unallocated fact/);
    await expect(read({ attempts: [], refusals: [], authorizations: [], unallocatedFacts: {} })).rejects.toThrow(/malformed unallocated facts/);
    expect(await read({ code: 'not_found' }, 404)).toBeNull();
    await expect(read({}, 503)).rejects.toThrow();
  });
});
