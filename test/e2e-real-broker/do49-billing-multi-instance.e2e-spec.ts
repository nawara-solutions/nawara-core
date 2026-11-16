import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { startFakeAuthServer, type FakeAuthServer, type FakeMembership } from './support/fake-auth.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, paymentPolicy, startReferenceStub, TEST_PLATFORM } from './support/admission.js';
import { createPaymentIdentity, type PaymentIdentity } from './support/payment-identity.js';

const refStub = await startReferenceStub();
let paymentIdentity: PaymentIdentity | undefined;
afterAll(() => refStub.close());

/**
 * Core V2 DO-49, Billing side (the Owner's Evidence Integrity and Reliability GO, 2026-11-16): TWO separately spawned, BUILT billing-service processes on
 * ONE database, ONE real Payment and ONE real RabbitMQ (test provider; development and simulation only). The Payment side was certified by
 * `do49-payment-multi-instance` (#508); Billing's dispatcher claims, claim renewal and stale re-claim were proven in-process only
 * (`apps/billing-service/test/dispatcher-stale-retry.e2e-spec.ts`), and its reconciler was never raced across processes.
 *
 * What is real: both Billing processes and every worker they run (dispatcher, reconciler, event consumer, outbox relay), Payment, the database and the
 * broker. LABELLED TEST AIDS: one HTTP gate per Billing process between it and Payment, which counts every create call per payment request and can
 * delay it, or hold it (then deliver it to Payment with its answer lost); a broker proxy for Billing only, so Billing can be cut off while Payment
 * publishes; and a purge of Billing's queue, so a settlement event is MISSED and only the reconcilers can settle it.
 *
 * Each case requires exactly one effect per payment request, whichever instance does the work: one Payment payment per request (Payment's natural key),
 * one `created -> sending` and one `sending -> requested` transition, and, for a settlement, one `requested -> paid` and one Subscription activation.
 * Prerequisite: `npm run build -w @nawara/service-kit -w @nawara/audit-contract -w billing-service -w payment-service`.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORTS = [13961, 13962] as const;
const BILLING_URLS = BILLING_PORTS.map((p) => `http://127.0.0.1:${p}`);
const PAYMENT_PORT = 13963;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const BILLING_QUEUE = 'billing.payment-events';
const PAYER_TOKEN = `do49b-payer-${randomUUID()}`;
const PAYER_ID = randomUUID();
const STALE_SENDING_MS = 5000; // at least twice PAYMENT_TIMEOUT_MS (Billing's own configuration rule)

/** LABELLED TEST AID: an HTTP gate between ONE Billing process and Payment. */
interface Gate {
  url: string;
  /** create calls (POST /payment/payments) seen, per paymentRequestId */
  creates: Map<string, number>;
  delayMs: number;
  hold: boolean;
  held: Array<(deliver: boolean) => Promise<void>>;
  close(): Promise<void>;
}
async function startGate(target: string): Promise<Gate> {
  const g: Gate = { url: '', creates: new Map(), delayMs: 0, hold: false, held: [], close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
      const forward = async () => {
        const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
        return { status: r.status, type: r.headers.get('content-type') ?? 'application/json', buf: Buffer.from(await r.arrayBuffer()) };
      };
      const isCreate = req.method === 'POST' && req.url === '/payment/payments';
      if (isCreate) {
        const id = String((JSON.parse(body.toString('utf8') || '{}') as { paymentRequestId?: unknown }).paymentRequestId);
        g.creates.set(id, (g.creates.get(id) ?? 0) + 1);
        if (g.hold) {
          g.held.push(async (deliver) => {
            if (deliver) await forward().catch(() => undefined); // Payment does the work; the answer never reaches Billing
            res.destroy();
          });
          return;
        }
        if (g.delayMs > 0) await new Promise((r) => setTimeout(r, g.delayMs));
      }
      try {
        const r = await forward();
        res.writeHead(r.status, { 'content-type': r.type });
        res.end(r.buf);
      } catch {
        res.writeHead(502);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  g.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  g.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return g;
}

describeWithEnv(
  'Core V2 DO-49 (Billing): two Billing instances on one database, one Payment and one broker (real processes, real RabbitMQ; test provider)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    let amqpConn: ChannelModel;
    let fakeAuth: FakeAuthServer;
    let payment: LiveService;
    let brokerProxy: BrokerProxy;
    const billings: Array<LiveService | undefined> = [undefined, undefined];
    const gates: Gate[] = [];
    const payerIdentity: { id: string; isActive: boolean; memberships: FakeMembership[] } = { id: PAYER_ID, isActive: true, memberships: [] };
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();
    const tails = () => `${billings.map((s, i) => `--- billing ${i + 1} ---\n${s?.tail() ?? '(stopped)'}`).join('\n')}\n--- payment ---\n${payment?.tail()}`;

    const startBilling = async (i: 0 | 1) => {
      billings[i] = spawnService(`billing-${BILLING_PORTS[i]}`, BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORTS[i]),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: brokerProxy.url,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: gates[i]!.url,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        PAYMENT_TIMEOUT_MS: '2000',
        BILLING_DISPATCH_INTERVAL_MS: '200',
        BILLING_DISPATCH_STALE_SENDING_MS: String(STALE_SENDING_MS),
        BILLING_RECONCILE_INTERVAL_MS: '1000',
        BILLING_RECONCILE_STALE_REQUESTED_MS: '1000',
      });
      try {
        await waitForHealth(`${BILLING_URLS[i]}/health`, 30_000);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
    };

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingdo49');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentdo49b');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });
      await billingAdmin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, gen_random_uuid(), 'TND', gen_random_uuid())`, [TEST_PLATFORM]);
      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      paymentIdentity = await createPaymentIdentity(env as { TEST_RABBITMQ_URL: string; TEST_RABBITMQ_MGMT_URL: string });
      await purgeBillingQueue();
      fakeAuth = await startFakeAuthServer({ [PAYER_TOKEN]: payerIdentity });
      const target = new URL(env.TEST_RABBITMQ_URL);
      brokerProxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) }); // Billing's broker path only
      await brokerProxy.start();
      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: fakeAuth.url,
        RABBITMQ_URL: paymentIdentity!.url(env.TEST_RABBITMQ_URL), // Payment publishes directly: it keeps publishing while Billing is cut off
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_TEST_PROVIDER: 'true',
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`, ...paymentPolicy('billing-service'), ...refStub.env,
      });
      gates.push(await startGate(PAYMENT_URL), await startGate(PAYMENT_URL));
      try {
        await waitForHealth(`${PAYMENT_URL}/health`, 30_000);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n${tails()}`);
      }
      await startBilling(0);
      await startBilling(1);
    }, 180_000);

    afterAll(async () => {
      for (const s of billings) await s?.stop();
      await payment?.stop();
      for (const g of gates) {
        for (const h of g.held.splice(0)) await h(false);
        await g.close();
      }
      await paymentIdentity?.remove();
      await fakeAuth?.stop();
      if (amqpConn) {
        await purgeBillingQueue();
        await amqpConn.close().catch(() => undefined);
      }
      await brokerProxy?.sever();
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 60_000);

    async function purgeBillingQueue(): Promise<void> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.purgeQueue(BILLING_QUEUE);
      } catch {
        // not declared yet
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
    async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown, base: string = BILLING_URLS[0]!): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    async function asPayer(path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${PAYMENT_URL}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${PAYER_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    }
    let seq = 0;
    /** An issued Organization-subscription invoice (the payer is an active administrator: Core V2 DO-28), ready for a payment request. */
    async function issuedInvoice(base: string = BILLING_URLS[0]!): Promise<{ invoiceId: string; organizationId: string }> {
      seq += 1;
      const organizationId = randomUUID();
      payerIdentity.memberships.push({ id: randomUUID(), organization: { id: organizationId }, platform: { id: TEST_PLATFORM }, status: 'active', isOrganizationAdmin: true });
      const product = await asProducer('POST', '/billing/products', {
        seller: { type: 'organization', id: organizationId }, code: `do49b-${seq}`, name: `DO-49 product ${seq}`, subscriptionTarget: 'organization', platformId: TEST_PLATFORM,
      }, base);
      expect(product.status).toBe(201);
      const price = await asProducer('POST', '/billing/prices', {
        productId: product.json.id, clientReference: `do49b-ref-${seq}`, currency: 'TND', unitAmount: 5000, interval: 'recurring', intervalUnit: 'month', intervalCount: 1,
        effectiveFrom: new Date().toISOString(),
      }, base);
      expect(price.status).toBe(201);
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: organizationId }, payer: { type: 'user', id: PAYER_ID }, sourceType: 'contract',
        sourceId: `src-${randomUUID()}`, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.json.id, quantity: 1 }],
      }, base);
      expect(invoice.status).toBe(201);
      expect((await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`, undefined, base)).status).toBe(200);
      return { invoiceId: invoice.json.id, organizationId };
    }
    const requestOf = async (requestId: string) => (await billingAdmin.query(`SELECT status, "paymentId", "sendAttempts" FROM payment_request WHERE id = $1`, [requestId])).rows[0];
    const transitions = async (requestId: string) => (await billingAdmin.query(
      `SELECT COALESCE("fromStatus", '') || '->' || "toStatus" AS t FROM billing_transition WHERE "entityType" = 'payment_request' AND "entityId" = $1 ORDER BY revision`, [requestId])).rows.map((r) => r.t as string);
    const paymentsFor = async (requestId: string) => (await paymentAdmin.query(`SELECT id FROM payment WHERE "paymentRequestId" = $1`, [requestId])).rows.map((r) => r.id as string);
    const createsFor = (requestId: string) => gates.reduce((n, g) => n + (g.creates.get(requestId) ?? 0), 0);
    const allRequested = (ids: string[]) => waitFor(async () => {
      const rows = (await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1::uuid[]) AND status = 'requested'`, [ids])).rows[0];
      return rows.n === ids.length;
    }, 90_000, `every request to reach 'requested'\n${tails()}`);
    /** One effect per request, whichever instance did the work. */
    const expectOneEffectEach = async (ids: string[]) => {
      for (const id of ids) {
        const r = await requestOf(id);
        const payments = await paymentsFor(id);
        expect(payments, `one Payment payment for ${id}`).toHaveLength(1);
        expect(r, id).toMatchObject({ status: 'requested', paymentId: payments[0] });
        expect(await transitions(id), id).toEqual(['->created', 'created->sending', 'sending->requested']);
      }
    };

    it('B1: both dispatchers race the same 16 new payment requests: each is claimed by one instance (FOR UPDATE SKIP LOCKED), sent once and requested once with its one Payment payment', async () => {
      const invoices = await Promise.all(Array.from({ length: 16 }, (_, i) => issuedInvoice(BILLING_URLS[i % 2])));
      const created = await Promise.all(invoices.map((inv, i) => asProducer('POST', `/billing/invoices/${inv.invoiceId}/payment-requests`, undefined, BILLING_URLS[i % 2])));
      for (const c of created) expect(c.status).toBe(201);
      const ids = created.map((c) => c.json.id as string);
      await allRequested(ids);
      await expectOneEffectEach(ids);
      expect(ids.map(createsFor), 'no request was sent twice: no claim was stale and none was claimed by both').toEqual(ids.map(() => 1));
      for (const id of ids) expect((await requestOf(id)).sendAttempts).toBe(1);
    }, 300_000);

    it('B2 (claim renewal across processes): every send is slow (1.5 s each, 8 requests, longer in total than the 5 s stale window): the holder renews its unsent claims, so the other instance never re-sends one', async () => {
      for (const g of gates) g.delayMs = 1500;
      try {
        const invoices = await Promise.all(Array.from({ length: 8 }, () => issuedInvoice()));
        const created = await Promise.all(invoices.map((inv) => asProducer('POST', `/billing/invoices/${inv.invoiceId}/payment-requests`)));
        const ids = created.map((c) => c.json.id as string);
        await allRequested(ids);
        await expectOneEffectEach(ids);
        expect(ids.map(createsFor), 'every request sent exactly once').toEqual(ids.map(() => 1));
      } finally {
        for (const g of gates) g.delayMs = 0;
      }
    }, 300_000);

    it('B3 (crash while holding claims; LABELLED: the gate holds the send, then delivers it to Payment with the answer lost): instance 1 is SIGKILLed; instance 2 re-claims the stale claims and re-sends; Payment\'s natural key answers the delivered one with the SAME payment; one effect each', async () => {
      await billings[1]!.stop(); // only instance 1 dispatches while the requests are created
      billings[1] = undefined;
      gates[0]!.hold = true;
      const invoices = await Promise.all(Array.from({ length: 3 }, () => issuedInvoice()));
      const created = await Promise.all(invoices.map((inv) => asProducer('POST', `/billing/invoices/${inv.invoiceId}/payment-requests`)));
      const ids = created.map((c) => c.json.id as string);
      await waitFor(() => gates[0]!.held.length >= 1, 30_000, `instance 1 to send while holding its claims\n${tails()}`);
      await billings[0]!.kill(); // a crash: no drain, no shutdown hook; its claims stay `sending`
      billings[0] = undefined;
      const claimedByOne = (await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_request WHERE id = ANY($1::uuid[]) AND status = 'sending'`, [ids])).rows[0].n;
      expect(claimedByOne).toBeGreaterThanOrEqual(1);
      gates[0]!.hold = false;
      const delivered = gates[0]!.held.splice(0);
      for (const h of delivered) await h(true); // the in-flight send reaches Payment; its answer is lost with the crashed process
      const deliveredIds = ids.filter((id) => (gates[0]!.creates.get(id) ?? 0) > 0);
      const createdAtPayment = new Map<string, string[]>();
      for (const id of deliveredIds) createdAtPayment.set(id, await paymentsFor(id));
      await startBilling(1); // instance 2 comes back alone and finds the stale claims after the stale window
      await allRequested(ids);
      await expectOneEffectEach(ids);
      for (const id of deliveredIds) {
        const before = createdAtPayment.get(id)!;
        if (before.length === 1) expect((await requestOf(id)).paymentId, 'the re-send got the SAME payment (natural key)').toBe(before[0]);
      }
      for (const id of ids) {
        if ((gates[0]!.creates.get(id) ?? 0) > 0) expect((await requestOf(id)).sendAttempts, 'claimed by instance 1, re-claimed by instance 2').toBeGreaterThanOrEqual(2);
      }
      await startBilling(0); // both instances again for the next case
    }, 300_000);

    it('B4 (reconcilers race; LABELLED: Billing is cut off from the broker and the settlement event is purged, so it is MISSED): both reconcilers ask Payment and settle the request ONCE: one `requested -> paid`, one reconciliation receipt, one Subscription activation', async () => {
      const inv = await issuedInvoice();
      const created = await asProducer('POST', `/billing/invoices/${inv.invoiceId}/payment-requests`);
      const id = created.json.id as string;
      await allRequested([id]);
      const paymentId = (await requestOf(id)).paymentId as string;
      await brokerProxy.sever(); // both Billing processes lose the broker; Payment keeps publishing directly
      const start = await asPayer(`/payment/payments/${paymentId}/attempts`, { providerOptions: { scenario: 'success' } });
      expect(start.status).toBe(201);
      const synced = await asPayer(`/payment/payments/${paymentId}/attempts/${start.json.id}/sync`);
      expect(synced.json.status).toBe('succeeded');
      await waitFor(async () => (await paymentAdmin.query(`SELECT 1 FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1 AND "publishedAt" IS NOT NULL`, [paymentId])).rows.length === 1,
        30_000, `Payment to publish its settlement\n${tails()}`);
      await purgeBillingQueue(); // the event is gone: Billing never receives it
      await brokerProxy.start();
      await waitFor(async () => (await requestOf(id)).status === 'paid', 90_000, `the reconcilers to settle the request\n${tails()}`);
      await new Promise((r) => setTimeout(r, 4000)); // several more reconciler passes on both instances
      expect((await transitions(id)).filter((t) => t === 'requested->paid')).toHaveLength(1);
      const receipts = (await billingAdmin.query(`SELECT "eventName" FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [id])).rows;
      expect(receipts, 'one reconciliation receipt; the missed live event never arrived').toHaveLength(1);
      const sub = (await billingAdmin.query(`SELECT status, revision FROM subscription WHERE "organizationId" = $1`, [inv.organizationId])).rows;
      expect(sub).toEqual([{ status: 'active', revision: 1 }]);
      expect((await billingAdmin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityType" = 'invoice' AND "entityId" = $1 AND "toStatus" = 'paid'`, [inv.invoiceId])).rows[0].n).toBe(1);
    }, 300_000);
  },
);
