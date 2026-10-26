import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, paymentPolicy, startReferenceStub } from './support/admission.js';
import { PAYMENT_USER, createPaymentIdentity, tapPaymentEvents, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
afterAll(() => refStub.close());

/**
 * V2 A3M.6 (A3M record §15): Billing's refusals and the G11 fix over a REAL RabbitMQ broker, with Billing and Payment as two built,
 * separately spawned processes (the Stage 4 harness). Until now these were proven on the in-memory bus only.
 * - A, B: a `payment.succeeded` at an unsupported version, or from a source that is not payment-service, is refused PERMANENTLY before any
 *   receipt: one annotated copy in `billing.payment-events.dead`, never the retry queue, no receipt, no state change.
 * - C (G11): a forged `payment.cancelled` carrying the id Payment's real event WILL have (its deterministic id) and the right source header
 *   but a wrong amount is decided as a conflict and RECORDED, acknowledged, not dead-lettered (the accepted contract for a well-formed
 *   message that does not apply); it claims nothing, so the genuine event Payment then publishes under that same id still applies.
 * - D: the genuine event delivered again (the EXACT message Payment published, as at-least-once delivery does) changes nothing.
 * Core V2 S1e-2 (ADR-0057 §13.5, "S0-C6"): Billing is verified-only, so Payment runs, and every GENUINE Payment message is published, as the
 * authenticated broker user `payment-service` (support/payment-identity.ts). Anything else is refused BEFORE any receipt: a `source` that is
 * not the publishing identity (B: refused by the trust decision, `untrusted_unverified_original`, before Billing's own `wrong_source`
 * check could run), a G11 forger publishing as another identity (C), a message without `user_id`, a `user_id` the broker refuses (406),
 * and a key outside Payment's generated topic grant (403).
 * Determinism: every wait polls real state (the dead-letter queue, the receipt table, Billing's own log lines); no sleep decides a
 * result. Isolation: the queue names are the production ones (fixed by ADR-0053), so, exactly like Stage 4, the two Billing queues are
 * purged before and after on the disposable test broker; this package's files run one at a time (`fileParallelism: false`); own ports.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13121;
const PAYMENT_PORT = 13122;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_RETRY_QUEUE = `${BILLING_QUEUE}.retry`;
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;

/**
 * Payment's event id for (payment, event name), computed the way Payment computes it. The namespace is READ from Payment's source text,
 * never imported (no cross-service import), so a change there cannot silently desynchronize this test; case C then proves the two agree:
 * the genuine event's receipt lands under this id.
 */
function paymentEventId(paymentId: string, name: string): string {
  const source = readFileSync(`${PAYMENT_DIR}/src/events/deterministic-id.ts`, 'utf8');
  const ns = /NAMESPACE_HEX = '([0-9a-f]{32})'/.exec(source)?.[1];
  if (!ns) throw new Error('payment-service deterministic-id namespace not found');
  const hash = createHash('sha1').update(Buffer.concat([Buffer.from(ns, 'hex'), Buffer.from([paymentId, name].join(':'), 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describeWithEnv('V2 A3M.6: Billing consumer refusals and G11 over a real RabbitMQ broker', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  let paymentIdentity: PaymentIdentity;
  let tap: Awaited<ReturnType<typeof tapPaymentEvents>>;
  let billingDb: TestDatabase;
  let paymentDb: TestDatabase;
  let billing: LiveService;
  let payment: LiveService;
  let amqpConn: ChannelModel;
  let billingAdmin: pg.Pool;
  const producerToken = generateServiceToken();
  const billingToPaymentToken = generateServiceToken();

  async function withChannel<T>(fn: (ch: amqp.Channel) => Promise<T>, fallback: T): Promise<T> {
    // a fresh channel each time: a 404 on a not-yet-declared queue closes the channel server-side (Stage 4's note)
    const ch = await amqpConn.createChannel();
    ch.on('error', () => undefined);
    try {
      return await fn(ch);
    } catch {
      return fallback;
    } finally {
      await ch.close().catch(() => undefined);
    }
  }
  const depth = (q: string) => withChannel(async (ch) => (await ch.checkQueue(q)).messageCount, 0);
  const purgeBillingQueues = async () => {
    for (const q of [BILLING_QUEUE, BILLING_RETRY_QUEUE, BILLING_DEAD_QUEUE]) await withChannel(async (ch) => ch.purgeQueue(q), undefined);
  };
  /** Takes the dead-lettered copy of `messageId` off the dead-letter queue and returns its properties (fails if another message is found). */
  const takeDead = (messageId: string) =>
    withChannel(async (ch) => {
      const m = await ch.get(BILLING_DEAD_QUEUE, { noAck: true });
      if (m === false) throw new Error('dead-letter queue empty');
      expect(m.properties.messageId).toBe(messageId);
      return { headers: (m.properties.headers ?? {}) as Record<string, unknown>, body: m.content.toString('utf8') };
    }, undefined as never);
  /** `as: 'payment'`: authenticated as `payment-service` (a genuine or a compromised Payment); `as: 'guest'`: the test's own identity (a forger). */
  const publish = (name: string, payload: Record<string, unknown>, id: string, headers: Record<string, unknown>, as: 'payment' | 'guest' = 'payment') => {
    const content = Buffer.from(JSON.stringify(payload));
    const properties = { messageId: id, type: name, persistent: true, contentType: 'application/json', headers: { eventId: id, occurredAt: new Date().toISOString(), ...headers } };
    if (as === 'payment') return paymentIdentity.publish(name, content, properties);
    return withChannel(async (ch) => {
      ch.publish(EXCHANGE, name, content, properties);
    }, undefined);
  };
  const receipts = async (eventId: string) =>
    (await billingAdmin.query<{ outcome: string; detailCode: string | null }>(`SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "eventId" = $1 ORDER BY "receivedAt"`, [eventId])).rows;
  const billingLogLines = (marker: string, eventId: string) => billing.tail().split('\n').filter((l) => l.includes(marker) && l.includes(eventId)).length;

  async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BILLING_URL}${path}`, { method, headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  /** An issued invoice and a payment request the REAL dispatcher has sent to the REAL Payment API (`requested`, with Payment's paymentId). */
  async function requestedPayment() {
    const sellerId = randomUUID();
    const tag = randomBytes(4).toString('hex');
    const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: `a3m6-${tag}`, name: 'A3M.6 product' });
    expect(product.status).toBe(201);
    const price = await asProducer('POST', '/billing/prices', { productId: product.json.id, clientReference: `a3m6-${tag}`, currency: 'TND', unitAmount: 1000, interval: 'one_time', effectiveFrom: new Date().toISOString() });
    expect(price.status).toBe(201);
    const invoice = await asProducer('POST', '/billing/invoices', {
      invoiceRequestId: randomUUID(), seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: 'a3m6-payer' }, sourceType: 'contract',
      sourceId: `src-${tag}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.json.id, quantity: 1 }],
    });
    expect(invoice.status).toBe(201);
    expect((await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
    const created = await asProducer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
    expect(created.status).toBe(201);
    const requestId: string = created.json.id;
    let requested: any;
    await waitFor(async () => {
      requested = (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json;
      return requested.status === 'requested' && typeof requested.paymentId === 'string';
    }, 20_000, `payment request ${requestId} to reach 'requested' through the real dispatcher and the real Payment API`);
    const facts = (over: Record<string, unknown> = {}) => ({
      paymentId: requested.paymentId, producer: 'billing-service', paymentRequestId: requestId, sourceType: 'invoice', sourceId: invoice.json.id,
      payer: { type: 'user', id: 'a3m6-payer' }, seller: { type: 'organization', id: sellerId }, organizationId: invoice.json.organizationId ?? null, currency: 'TND', revision: 0, amount: 1000,
      purpose: 'non_entitlement', liveMode: false, ...over, // Core V2 S4a: as the genuine Payment event carries them
    });
    return { requestId, paymentId: requested.paymentId as string, facts };
  }
  const requestStatus = async (requestId: string) => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status as string;
  const transitionsTo = async (requestId: string, status: string) =>
    (await billingAdmin.query<{ n: number }>(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = $2`, [requestId, status])).rows[0]!.n;

  beforeAll(async () => {
    billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'a3m6billing');
    paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'a3m6payment');
    await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
    await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
    billingAdmin = new pg.Pool({ connectionString: billingDb.url, max: 2 });
    amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
    await purgeBillingQueues(); // a stray message from an earlier file or a crashed run must not reach these assertions
    paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
    tap = await tapPaymentEvents(amqpConn);
    payment = spawnService('payment', PAYMENT_DIR, {
      NODE_ENV: 'test', PORT: String(PAYMENT_PORT), DATABASE_URL: paymentDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: paymentIdentity.url(env.TEST_RABBITMQ_URL),
      PAYMENT_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`, ...paymentPolicy('billing-service'), ...refStub.env,
    });
    billing = spawnService('billing', BILLING_DIR, {
      NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
      PAYMENT_SERVICE_URL: PAYMENT_URL, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
      BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000', // the reconciler never races these assertions
    });
    try {
      await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      await waitFor(async () => (await withChannel(async (ch) => (await ch.checkQueue(BILLING_QUEUE)).consumerCount, 0)) === 1, 20_000, 'billing to consume billing.payment-events');
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- payment ---\n${payment.tail()}\n--- billing ---\n${billing.tail()}`);
    }
  }, 90_000);

  afterAll(async () => {
    await billing?.stop();
    await payment?.stop();
    await tap?.close();
    await paymentIdentity?.remove();
    if (amqpConn) {
      await purgeBillingQueues();
      await amqpConn.close().catch(() => undefined);
    }
    await billingAdmin?.end();
    await billingDb?.drop();
    await paymentDb?.drop();
  }, 45_000);

  describe('A, B: permanent refusals before any receipt', () => {
    it.each([
      ['A: version 2', { source: 'payment-service', version: 2 }, 'unsupported_version'],
      // published as payment-service under another `source`: the trust decision refuses it (user_id ≠ source) before Billing's own
      // wrong_source check, which stays as defence in depth
      ['B: source evil-service', { source: 'evil-service', version: 1 }, 'untrusted_unverified_original'],
    ] as const)('%s → one dead letter (%s), never retried, no receipt, no state change', async (_label, headers, reason) => {
      const { requestId, facts } = await requestedPayment();
      const id = randomUUID();
      const deadBefore = await depth(BILLING_DEAD_QUEUE);
      await publish('payment.succeeded', facts(), id, headers);
      await waitFor(async () => (await depth(BILLING_DEAD_QUEUE)) === deadBefore + 1, 20_000, `the ${reason} event to be dead-lettered`);
      const dead = await takeDead(id);
      expect(dead.headers['x-nawara-failure']).toBe('permanent');
      expect(dead.headers['x-nawara-failure-reason']).toBe(reason);
      expect(dead.headers['x-nawara-consumer']).toBe(BILLING_QUEUE);
      expect(Number(dead.headers['x-nawara-retry-count'] ?? 0)).toBe(0); // straight to the dead-letter queue: no retry cycle
      expect(await depth(BILLING_RETRY_QUEUE)).toBe(0);
      expect(await depth(BILLING_DEAD_QUEUE)).toBe(deadBefore); // exactly one copy was there, and it was this one
      expect(await receipts(id)).toEqual([]); // refused before any receipt
      expect(await requestStatus(requestId)).toBe('requested'); // no business decision
      expect(await transitionsTo(requestId, 'paid')).toBe(0);
    });
  });

  describe('C, D: G11 over the real broker, then a redelivery', () => {
    it('C: a forged-first message with the genuine id, from another identity, is refused before any receipt; the genuine Payment event still applies, once', async () => {
      const { requestId, paymentId, facts } = await requestedPayment();
      const id = paymentEventId(paymentId, 'payment.cancelled'); // the id Payment's own payment.cancelled will carry
      const deadBefore = await depth(BILLING_DEAD_QUEUE);

      // The forged message: right name, right source header, the genuine deterministic id, a wrong amount, published by an identity that
      // is not payment-service. Core V2 S1e-2: it never reaches Billing's decision, so it records and claims nothing at all.
      await publish('payment.cancelled', facts({ amount: 999_999 }), id, { source: 'payment-service', version: 1 }, 'guest');
      await waitFor(async () => (await depth(BILLING_DEAD_QUEUE)) === deadBefore + 1, 20_000, 'the forged event to be refused');
      expect((await takeDead(id)).headers['x-nawara-failure-reason']).toBe('untrusted_unverified_original');
      expect(await receipts(id)).toEqual([]); // nothing recorded
      expect(await requestStatus(requestId)).toBe('requested'); // it cannot settle the request

      // The genuine event: Billing cancels through Payment's REAL API, and Payment's REAL relay publishes payment.cancelled under that id.
      expect((await asProducer('POST', `/billing/payment-requests/${requestId}/cancel`)).status).toBe(200);
      await waitFor(async () => (await requestStatus(requestId)) === 'cancelled', 30_000, 'the genuine payment.cancelled to apply despite the forged-first message');
      expect(await receipts(id)).toEqual([{ outcome: 'applied', detailCode: null }]);
      expect(await transitionsTo(requestId, 'cancelled')).toBe(1); // settled exactly once
      // the applied receipt keeps migration 0016's uniqueness: a second applied row for this id is refused at the database
      await expect(billingAdmin.query(`INSERT INTO payment_event_receipt ("eventId", "eventName", outcome, "causeType") VALUES ($1, 'payment.cancelled', 'applied', 'payment_event')`, [id]))
        .rejects.toMatchObject({ code: '23505' });
      expect(await depth(BILLING_DEAD_QUEUE)).toBe(deadBefore);

      // D: the genuine event delivered again (an ack lost after processing): the EXACT message Payment published, as Payment
      const genuine = await tap.take(id);
      expect(genuine.userId).toBe(PAYMENT_USER); // Payment's relay published it under its own broker identity
      const appliedLinesBefore = billingLogLines('payment_event_applied', id);
      await paymentIdentity.redeliver(genuine);
      await waitFor(async () => billingLogLines('payment_event_applied', id) === appliedLinesBefore + 1, 20_000, 'the redelivered genuine event to be handled');
      expect(await receipts(id)).toEqual([{ outcome: 'applied', detailCode: null }]); // no new receipt
      expect(await transitionsTo(requestId, 'cancelled')).toBe(1); // no second effect
      expect(await requestStatus(requestId)).toBe('cancelled');
      expect(await depth(BILLING_DEAD_QUEUE)).toBe(deadBefore); // acknowledged, not dead-lettered
      expect(await depth(BILLING_QUEUE)).toBe(0);
    });
  });

  describe('Core V2 S1e-2: publisher authentication over the real broker', () => {
    /** Raw publish on a connection authenticated as `who`, with exactly the `userId` given (or none); resolves with the channel error, if any. */
    const rawAs = async (connUrl: string, name: string, payload: Record<string, unknown>, id: string, userId: string | undefined) => {
      const conn = await amqp.connect(connUrl);
      conn.on('error', () => undefined);
      let refusal: { code?: number } | undefined;
      try {
        const ch = await conn.createConfirmChannel();
        ch.on('error', (e: { code?: number }) => { refusal ??= e; });
        ch.publish(EXCHANGE, name, Buffer.from(JSON.stringify(payload)), {
          messageId: id, type: name, persistent: true, contentType: 'application/json', ...(userId ? { userId } : {}),
          headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 },
        });
        await ch.waitForConfirms().catch((e: { code?: number }) => { refusal ??= e; });
        await ch.close().catch(() => undefined);
      } finally {
        await conn.close().catch(() => undefined);
      }
      return refusal;
    };
    const refusedBeforeAnyReceipt = async (requestId: string, id: string, deadBefore: number) => {
      await waitFor(async () => (await depth(BILLING_DEAD_QUEUE)) === deadBefore + 1, 20_000, `${id} to be refused`);
      expect((await takeDead(id)).headers['x-nawara-failure-reason']).toBe('untrusted_unverified_original');
      expect(await receipts(id)).toEqual([]);
      expect(await requestStatus(requestId)).toBe('requested');
    };

    it('a genuine-looking Payment event published as guest is refused before any receipt', async () => {
      const { requestId, facts } = await requestedPayment();
      const id = randomUUID();
      const deadBefore = await depth(BILLING_DEAD_QUEUE);
      expect(await rawAs(env.TEST_RABBITMQ_URL, 'payment.succeeded', facts(), id, undefined)).toBeUndefined(); // the broker accepts it
      await refusedBeforeAnyReceipt(requestId, id, deadBefore);
    });

    it('a Payment event WITHOUT user_id, even on Payment\'s own connection, is refused before any receipt', async () => {
      const { requestId, facts } = await requestedPayment();
      const id = randomUUID();
      const deadBefore = await depth(BILLING_DEAD_QUEUE);
      expect(await rawAs(paymentIdentity.url(env.TEST_RABBITMQ_URL), 'payment.succeeded', facts(), id, undefined)).toBeUndefined();
      await refusedBeforeAnyReceipt(requestId, id, deadBefore);
    });

    it('a forged user_id cannot impersonate payment-service: the broker refuses it (406) and nothing reaches Billing', async () => {
      const { requestId, facts } = await requestedPayment();
      const id = randomUUID();
      const deadBefore = await depth(BILLING_DEAD_QUEUE);
      const refusal = await rawAs(env.TEST_RABBITMQ_URL, 'payment.succeeded', facts(), id, PAYMENT_USER);
      expect(refusal?.code).toBe(406);
      await new Promise((r) => setTimeout(r, 500));
      expect(await depth(BILLING_DEAD_QUEUE)).toBe(deadBefore);
      expect(await receipts(id)).toEqual([]);
      expect(await requestStatus(requestId)).toBe('requested');
    });

    it('payment-service cannot publish outside its generated topic grant (403); a correctly authenticated Payment publication is accepted and applied', async () => {
      const { requestId, facts } = await requestedPayment();
      const outside = await rawAs(paymentIdentity.url(env.TEST_RABBITMQ_URL), 'invoice.created', { invoiceId: randomUUID() }, randomUUID(), PAYMENT_USER);
      expect(outside?.code).toBe(403);
      const id = randomUUID();
      await publish('payment.succeeded', facts(), id, { source: 'payment-service', version: 1 });
      await waitFor(async () => (await requestStatus(requestId)) === 'paid', 20_000, 'the authenticated payment.succeeded to apply');
      expect(await receipts(id)).toEqual([{ outcome: 'applied', detailCode: null }]);
      expect(await transitionsTo(requestId, 'paid')).toBe(1);
    });
  });
});
