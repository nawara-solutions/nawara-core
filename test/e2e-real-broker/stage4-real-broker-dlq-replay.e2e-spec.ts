import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Audit finding M-07: a Payment event that Billing's consumer cannot process must be retried a bounded number of times, then held in
 * the durable dead-letter queue, and an operator must be able to inspect it and replay it through the NORMAL consumer path.
 *
 * Two live processes over a real broker and a real database. Transient failure: the receipt table is renamed away while Payment
 * really cancels a payment, so Billing's real consumer fails with a real PostgreSQL error (relation does not exist) on every attempt:
 * default retry policy (3 retries, 5 s apart) then the DLQ. The table comes back; the shipped `nawara-dlq` CLI replays the message;
 * Billing applies it exactly once. Permanent failure: an event whose paymentRequestId is not a uuid goes to the DLQ without any retry
 * and stays recoverable after a replay is rejected again. The reconciler is pushed out of the test window: only the event can move
 * the request.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const DLQ_CLI = `${ROOT}libs/service-kit/dist/cli/dlq.js`;
const BILLING_PORT = 13113;
const PAYMENT_PORT = 13114;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const QUEUE = 'billing.payment-events';
const RETRY_QUEUE = `${QUEUE}.retry`;
const DEAD_QUEUE = `${QUEUE}.dead`;

describeWithEnv('DLQ retry and operator replay of Payment events, over a real broker and two live processes', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let billingDb: TestDatabase;
  let paymentDb: TestDatabase;
  let billing: LiveService;
  let payment: LiveService;
  let amqpConn: ChannelModel;
  let billingAdmin: pg.Pool;
  const producerToken = generateServiceToken();
  const billingToPaymentToken = generateServiceToken();

  async function withChannel<T>(fn: (ch: amqp.Channel) => Promise<T>, fallback: T): Promise<T> {
    const ch = await amqpConn.createChannel();
    ch.on('error', () => undefined); // a 404 on a queue that does not exist yet closes the channel and also emits 'error'
    try {
      return await fn(ch);
    } catch {
      return fallback;
    } finally {
      await ch.close().catch(() => undefined);
    }
  }
  const depth = (queue: string) => withChannel(async (ch) => (await ch.checkQueue(queue)).messageCount, 0);
  const purgeAll = async () => {
    for (const q of [QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await withChannel((ch) => ch.purgeQueue(q), undefined);
  };

  /** Runs the shipped operator CLI exactly as documented (`RABBITMQ_URL` in the environment). */
  const cli = (...args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile('node', [DLQ_CLI, ...args], { env: { ...process.env, RABBITMQ_URL: env.TEST_RABBITMQ_URL }, timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
      });
    });
  const kv = (line: string, key: string) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];

  beforeAll(async () => {
    billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebilldlq');
    paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaydlq');
    await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
    await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
    billingAdmin = new pg.Pool({ connectionString: billingDb.url });
    amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
    await purgeAll();

    payment = spawnService('payment', PAYMENT_DIR, {
      NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      PAYMENT_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`,
    });
    billing = spawnService('billing', BILLING_DIR, {
      NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${producerToken.digest}`, PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
      BILLING_DISPATCH_INTERVAL_MS: '300',
      BILLING_RECONCILE_INTERVAL_MS: '3600000', // the reconciler must not be what moves the request in this suite
    });
    try {
      await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/ready`, 20_000)]);
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- payment ---\n${payment.tail()}\n--- billing ---\n${billing.tail()}`);
    }
  }, 90_000);

  afterAll(async () => {
    await billing?.stop();
    await payment?.stop();
    if (amqpConn) {
      await purgeAll();
      await amqpConn.close().catch(() => undefined);
    }
    await billingAdmin?.end();
    await billingDb?.drop();
    await paymentDb?.drop();
  }, 45_000);

  async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BILLING_URL}${path}`, {
      method, headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async function requestedPaymentRequest(tag: string) {
    const sellerId = randomUUID();
    const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: `dlq-${tag}`, name: `DLQ ${tag}` });
    const price = await asProducer('POST', '/billing/prices', { productId: product.json.id, clientReference: `dlq-ref-${tag}`, currency: 'TND', unitAmount: 1000, interval: 'one_time', effectiveFrom: new Date().toISOString() });
    const invoice = await asProducer('POST', '/billing/invoices', {
      invoiceRequestId: randomUUID(), seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: `payer-${tag}` },
      sourceType: 'contract', sourceId: `src-${randomBytes(4).toString('hex')}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.json.id, quantity: 1 }],
    });
    expect((await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
    const created = await asProducer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
    expect(created.status).toBe(201);
    const requestId: string = created.json.id;
    await waitFor(async () => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status === 'requested', 15_000, `request ${requestId} to reach 'requested'`);
    return { requestId, invoiceId: invoice.json.id as string, sellerId, payerId: `payer-${tag}` };
  }
  const requestRow = async (id: string) => (await asProducer('GET', `/billing/payment-requests/${id}`)).json;
  const receipts = async (eventId: string) => (await billingAdmin.query<{ outcome: string; paymentRequestId: string }>(`SELECT outcome, "paymentRequestId" FROM payment_event_receipt WHERE "eventId" = $1`, [eventId])).rows;

  it('transient failure: retried a bounded number of times, held in the DLQ, replayed by the CLI, applied exactly once; a second replay changes nothing', async () => {
    const first = await requestedPaymentRequest('a');
    const before = await requestRow(first.requestId);

    // The receipt table disappears: every attempt of the real consumer fails with a real PostgreSQL error (42P01), which is not permanent.
    await billingAdmin.query('ALTER TABLE payment_event_receipt RENAME TO payment_event_receipt_offline');
    expect((await asProducer('POST', `/billing/payment-requests/${first.requestId}/cancel`)).status).toBe(200);

    // default policy: 3 retries 5 s apart, then the DLQ
    await waitFor(async () => (await depth(DEAD_QUEUE)) === 1, 60_000, 'the failing payment.cancelled to be dead-lettered after its retries');
    expect(await depth(QUEUE)).toBe(0);
    expect(await depth(RETRY_QUEUE)).toBe(0); // not looping
    expect((await requestRow(first.requestId)).status).toBe('requested'); // nothing was applied

    // inspect it
    const listed = await cli('list', '--queue', DEAD_QUEUE, '--field', 'paymentRequestId');
    expect(listed.code).toBe(0);
    const [head, line] = listed.out.trim().split('\n');
    expect(head).toBe(`dlq_depth queue=${DEAD_QUEUE} depth=1 shown=1`);
    const eventId = kv(line!, 'event')!;
    expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(kv(line!, 'name')).toBe('payment.cancelled');
    expect(kv(line!, 'classification')).toBe('retries_exhausted');
    expect(kv(line!, 'retries')).toBe('3');
    expect(kv(line!, 'paymentRequestId')).toBe(first.requestId);
    expect(kv(line!, 'failedAt')).toMatch(/^\d{4}-\d\d-\d\dT/);
    const correlationId = kv(line!, 'correlationId')!;
    expect(await depth(DEAD_QUEUE)).toBe(1); // listing consumed nothing

    // keep a copy of the dead-lettered message to prove a second replay of "the same" message later
    const copy = await withChannel(async (ch) => {
      const m = await ch.get(DEAD_QUEUE, { noAck: false });
      ch.nackAll(true);
      return m || undefined;
    }, undefined);
    expect(copy && copy.properties.messageId).toBe(eventId);

    // the fault is fixed; an operator replays that event
    await billingAdmin.query('ALTER TABLE payment_event_receipt_offline RENAME TO payment_event_receipt');
    const replay = await cli('replay', '--queue', DEAD_QUEUE, '--event-id', eventId, '--wait-seconds', '30');
    expect(replay.out).toContain(`dlq_replay_started queue=${DEAD_QUEUE} event=${eventId}`);
    expect(replay.out).toContain(`dlq_replay_result outcome=consumed event=${eventId} target=${QUEUE} replays=1`);
    expect(replay.code).toBe(0);
    await waitFor(async () => (await requestRow(first.requestId)).status === 'cancelled', 30_000, 'the replayed payment.cancelled to be applied');
    expect(await depth(DEAD_QUEUE)).toBe(0);

    // exactly one effective receipt and transition, under the original event identity and correlation id
    expect(await receipts(eventId)).toEqual([{ outcome: 'applied', paymentRequestId: first.requestId }]);
    const transitions = await billingAdmin.query<{ correlationId: string; causeId: string }>(`SELECT "correlationId", "causeId" FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'cancelled'`, [first.requestId]);
    expect(transitions.rows).toHaveLength(1);
    expect(transitions.rows[0]!.causeId).toBe(eventId);
    expect(transitions.rows[0]!.correlationId).toBe(correlationId === '-' ? `event:${eventId}` : correlationId);
    const after = await requestRow(first.requestId);
    expect({ amount: after.amount, currency: after.currency, paymentId: after.paymentId }).toEqual({ amount: before.amount, currency: before.currency, paymentId: before.paymentId });

    // replaying again: nothing in the DLQ any more
    const nothing = await cli('replay', '--queue', DEAD_QUEUE, '--event-id', eventId, '--wait-seconds', '1');
    expect(nothing.code).toBe(4);
    expect(nothing.out).toContain('outcome=not_found');

    // the same dead-lettered message shows up again (a second copy) and is replayed: the receipt makes it a no-op
    await withChannel(async (ch) => {
      ch.sendToQueue(DEAD_QUEUE, copy!.content, { persistent: true, messageId: copy!.properties.messageId, type: copy!.properties.type, headers: copy!.properties.headers });
      await ch.checkQueue(DEAD_QUEUE);
    }, undefined);
    await waitFor(async () => (await depth(DEAD_QUEUE)) === 1, 10_000, 'the second copy to be in the DLQ');
    const second = await cli('replay', '--queue', DEAD_QUEUE, '--event-id', eventId, '--wait-seconds', '30');
    expect(second.code).toBe(0);
    expect(await depth(DEAD_QUEUE)).toBe(0);
    expect(await receipts(eventId)).toHaveLength(1); // still one receipt
    const again = await billingAdmin.query(`SELECT 1 FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'cancelled'`, [first.requestId]);
    expect(again.rowCount).toBe(1); // still one transition
    expect((await requestRow(first.requestId)).status).toBe('cancelled');

    // the operational trail is machine-identifiable and carries no secret, URL or payload
    const log = billing.tail();
    for (const marker of ['event_retry_scheduled', 'event_retry_exhausted', 'event_dead_lettered', 'payment_event_processing_failure', 'payment_event_replay_succeeded', 'payment_event_replay_duplicate']) {
      expect(log, marker).toContain(marker);
    }
    expect(log).toContain(`classification=transient`);
    expect(log).not.toMatch(/amqp:\/\/|guest:guest|Bearer /);
  }, 240_000);

  it('permanent failure: dead-lettered at once with no retry, stays recoverable when a replay is rejected again', async () => {
    await purgeAll();
    const eventId = randomUUID();
    const corr = `corr-${randomBytes(4).toString('hex')}`;
    const payload = {
      paymentId: randomUUID(), producer: 'billing-service', paymentRequestId: 'not-a-uuid', sourceType: 'invoice', sourceId: 'inv-x',
      payer: { type: 'user', id: 'payer-x' }, seller: { type: 'organization', id: randomUUID() }, organizationId: null, currency: 'TND', revision: 0, amount: 1000,
    };
    const started = Date.now();
    await withChannel(async (ch) => {
      ch.publish(EXCHANGE, 'payment.cancelled', Buffer.from(JSON.stringify(payload)), {
        messageId: eventId, type: 'payment.cancelled', persistent: true, contentType: 'application/json',
        headers: { eventId, occurredAt: new Date().toISOString(), correlationId: corr, source: 'payment-service', version: 1 },
      });
      await ch.checkQueue(QUEUE);
    }, undefined);
    await waitFor(async () => (await depth(DEAD_QUEUE)) === 1, 20_000, 'the permanently failing event to be dead-lettered');
    expect(Date.now() - started).toBeLessThan(4_500); // no retry delay (a retry would take 5 s or more)
    expect(await depth(RETRY_QUEUE)).toBe(0);

    const listed = await cli('list', '--queue', DEAD_QUEUE, '--field', 'paymentRequestId');
    const line = listed.out.trim().split('\n')[1]!;
    expect(kv(line, 'event')).toBe(eventId);
    expect(kv(line, 'classification')).toBe('permanent');
    expect(kv(line, 'reason')).toBe('invalid_identifier');
    expect(kv(line, 'retries')).toBe('0');
    expect(kv(line, 'correlationId')).toBe(corr);
    expect(await receipts(eventId)).toHaveLength(0);

    const replay = await cli('replay', '--queue', DEAD_QUEUE, '--event-id', eventId, '--wait-seconds', '20');
    expect(replay.code).toBe(2);
    expect(replay.out).toContain(`dlq_replay_result outcome=rejected_again event=${eventId} target=${QUEUE} replays=1`);
    const still = await cli('list', '--queue', DEAD_QUEUE);
    expect(still.out).toContain('depth=1');
    expect(kv(still.out.trim().split('\n')[1]!, 'replays')).toBe('1'); // recoverable, and it remembers it was replayed
    expect(await receipts(eventId)).toHaveLength(0); // never applied, never half-applied

    const log = billing.tail();
    expect(log).toContain('payment_event_replay_rejected');
    expect(log).toContain(`correlationId=${corr}`);
    await purgeAll();
  }, 120_000);
});
