import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPaymentClient } from './payment-client.js';

/** Core V2 S4c (F-7): Payment's cancel answers, as Billing classifies them. A stub of exactly Payment's cancel route, no network beyond loopback. */
describe('HttpPaymentClient.cancelPayment', () => {
  let server: Server;
  let url = '';
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });
  const cancel = () => new HttpPaymentClient({ baseUrl: url, serviceToken: 't' }).cancelPayment('11111111-1111-4111-8111-111111111111', 'k-12345678');

  it.each([
    [200, { status: 'cancelled' }, 'cancelled'],
    [202, { status: 'closing' }, 'in_flight'], // Core V2 S4c: Payment is closing it; the final event closes the request later
    [409, { code: 'payment_has_open_attempt' }, 'in_flight'],
    [409, { code: 'invalid_state_transition' }, 'already_terminal'],
    [404, { code: 'not_found' }, 'not_found'],
    [503, {}, 'transient'],
  ] as const)('HTTP %i %j → %s', async (status, body, kind) => {
    answer = { status, body };
    expect(await cancel()).toEqual({ kind });
  });
});
