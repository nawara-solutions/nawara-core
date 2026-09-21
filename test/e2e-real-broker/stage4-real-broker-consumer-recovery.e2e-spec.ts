import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Audit finding H-01: Billing's RabbitMQ consumer must come back on its own after the broker connection is lost, and
 * readiness must not claim otherwise meanwhile.
 *
 * Billing's broker connection goes through a TCP relay (`BrokerProxy`); Payment's goes straight to the broker. Severing the
 * relay is what a broker restart looks like to Billing's real AMQP client (every socket dies, reconnects are refused) without
 * needing control of the broker process. While it is severed a REAL `payment.cancelled` is published by Payment's real
 * outbox relay to the real broker; after the relay returns, Billing's consumer must re-attach, drain that backlog and keep
 * consuming. The reconciler is pushed out of the test window (an hour), so the ONLY way the request can move is the event.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13111;
const PAYMENT_PORT = 13112;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;

describeWithEnv(
  'Billing consumer recovery after a lost broker connection, over a real broker and two live processes',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    let proxy: BrokerProxy;
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
    const purgeBillingQueues = async () => {
      await withChannel((ch) => ch.purgeQueue(BILLING_QUEUE), undefined);
      await withChannel((ch) => ch.purgeQueue(BILLING_DEAD_QUEUE), undefined);
    };
    const deadLetterDepth = () => withChannel(async (ch) => (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount, 0);

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillrec');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayrec');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      await purgeBillingQueues();

      const target = new URL(env.TEST_RABBITMQ_URL);
      proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
      await proxy.start();

      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: `amqp://guest:guest@127.0.0.1:${proxy.port}`, // through the relay
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
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
      await proxy?.sever();
      if (amqpConn) {
        await purgeBillingQueues();
        await amqpConn.close().catch(() => undefined);
      }
      await billingAdmin?.end();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${BILLING_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    const ready = async () => (await fetch(`${BILLING_URL}/ready`)).json() as Promise<{ status: string; failed?: string[] }>;

    /** An issued invoice with a payment request that the real dispatcher has sent to the real Payment API (`requested`, with a paymentId). */
    async function requestedPaymentRequest(tag: string) {
      const sellerId = randomUUID();
      const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: `rec-${tag}`, name: `Recovery ${tag}` });
      expect(product.status).toBe(201);
      const price = await asProducer('POST', '/billing/prices', { productId: product.json.id, clientReference: `rec-ref-${tag}`, currency: 'TND', unitAmount: 1000, interval: 'one_time', effectiveFrom: new Date().toISOString() });
      expect(price.status).toBe(201);
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: `payer-${tag}` },
        sourceType: 'contract', sourceId: `src-${randomBytes(4).toString('hex')}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 },
        lines: [{ priceId: price.json.id, quantity: 1 }],
      });
      expect(invoice.status).toBe(201);
      expect((await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
      const created = await asProducer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
      expect(created.status).toBe(201);
      const requestId: string = created.json.id;
      await waitFor(async () => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status === 'requested', 15_000, `request ${requestId} to reach 'requested'`);
      return { requestId, invoiceId: invoice.json.id as string, sellerId, payerId: `payer-${tag}` };
    }
    const status = async (requestId: string) => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status as string;
    const receipts = async (requestId: string) =>
      (await billingAdmin.query<{ eventId: string }>(`SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.cancelled'`, [requestId])).rows;

    it('consumer lost -> readiness says so -> broker returns -> consumer re-attaches, drains the backlog, consumes new events, and a redelivery stays idempotent', async () => {
      // startup: attached and ready
      expect((await ready()).status).toBe('ready');
      const first = await requestedPaymentRequest('a');

      // the broker goes away (for Billing only)
      await proxy.sever();
      await waitFor(async () => (await ready()).status === 'unavailable', 15_000, 'Billing readiness to report the lost consumer');
      expect((await ready()).failed).toContain('rabbitmq-consumer'); // not merely "the broker is unreachable"

      // while Billing cannot consume, Payment (direct to the broker) really cancels: the event waits in the durable queue
      expect((await asProducer('POST', `/billing/payment-requests/${first.requestId}/cancel`)).status).toBe(200);
      await waitFor(async () => (await withChannel(async (ch) => (await ch.checkQueue(BILLING_QUEUE)).messageCount, 0)) >= 1, 15_000, 'payment.cancelled to be queued for Billing');
      expect(await status(first.requestId)).toBe('requested'); // nothing consumed it: the reconciler is off, the consumer is down

      // the broker returns: Billing re-attaches by itself and drains the backlog
      await proxy.start();
      await waitFor(async () => (await status(first.requestId)) === 'cancelled', 60_000, 'the recovered consumer to apply the queued payment.cancelled');
      await waitFor(async () => (await ready()).status === 'ready', 30_000, 'Billing readiness to recover');
      const rows = await receipts(first.requestId);
      expect(rows).toHaveLength(1);

      // a NEW event after recovery flows normally
      const second = await requestedPaymentRequest('b');
      expect((await asProducer('POST', `/billing/payment-requests/${second.requestId}/cancel`)).status).toBe(200);
      await waitFor(async () => (await status(second.requestId)) === 'cancelled', 30_000, 'a post-recovery payment.cancelled to be consumed');

      // redelivery after recovery (same event id) changes nothing and is not dead-lettered
      const dlqBefore = await deadLetterDepth();
      const paymentId = (await asProducer('GET', `/billing/payment-requests/${first.requestId}`)).json.paymentId as string;
      await withChannel(async (ch) => {
        ch.publish(EXCHANGE, 'payment.cancelled', Buffer.from(JSON.stringify({
          paymentId, producer: 'billing-service', paymentRequestId: first.requestId, sourceType: 'invoice', sourceId: first.invoiceId,
          payer: { type: 'user', id: first.payerId }, seller: { type: 'organization', id: first.sellerId }, organizationId: first.sellerId, currency: 'TND', revision: 0, amount: 1000,
        })), { messageId: rows[0]!.eventId, type: 'payment.cancelled', headers: { occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
        await ch.checkQueue(BILLING_QUEUE); // round-trip so the publish has been flushed before the channel closes
      }, undefined);
      await new Promise((r) => setTimeout(r, 2000));
      expect(await receipts(first.requestId)).toHaveLength(1);
      expect(await status(first.requestId)).toBe('cancelled');
      expect(await deadLetterDepth()).toBe(dlqBefore);
    }, 180_000);
  },
);
