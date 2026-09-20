import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 5 hardening — completion pass, item 1(b): proves `PaymentReconciler` repairs a REAL "Payment succeeded (here,
 * cancelled) but Billing never got the event" gap, over the real broker/DB used by the rest of this suite, not just
 * the in-process `FakePaymentClient` suite (`payment-integration.e2e-spec.ts`) that already covers the decision logic.
 *
 * The gap is manufactured, not awaited-for-luck: this suite temporarily UNBINDS Billing's real queue
 * (`billing.payment-events`) from the `payment.cancelled` routing key before the cancel, so the real event Payment's
 * real outbox really publishes to the real exchange is genuinely unroutable and dropped by the broker (RabbitMQ's
 * default behavior for an unroutable, non-mandatory publish — nothing here fakes the miss). Billing is spawned with a
 * short reconcile interval/threshold so `PaymentReconciler.reconcileOnce` (real HTTP call to Payment) has to be the
 * thing that notices and settles it, not the consumer. The binding is restored in `afterAll` so the durable queue is
 * left in its normal, fully-bound state for any other suite reusing the same broker.
 *
 * Item 1(a), a true broker OUTAGE (stopping/restarting the RabbitMQ process itself) mid-flow, is deliberately NOT
 * attempted here: `TEST_RABBITMQ_URL` is a single broker shared by every test file in this run (and, in CI, by the
 * job's other steps), so stopping it would be an unsafe, disproportionate side effect for this harness to own. The
 * underlying recovery mechanism — `RabbitMqEventBus` reconnecting lazily and `OutboxRelay` retrying with backoff after
 * a failed publish — is already proven against a REAL broker, unchanged by this task, in
 * `libs/service-kit/test/rabbitmq.int-spec.ts` ("with the broker unreachable, publishing fails, the relay records it,
 * and delivery succeeds once the broker is back"), using a deliberately-wrong URL and then the real one — a genuine
 * connection failure, not a mock. Both billing-service and payment-service use exactly that class with no override,
 * so the proof transfers; a full two-process E2E of the same mechanism would add process-orchestration cost without
 * proving anything new. Documented here rather than faked, per the Stage 5 audit (§4.1) and the completion-pass review.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service` (both `dist/` present).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13103;
const PAYMENT_PORT = 13104;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const RECONCILE_STALE_MS = 1500;

describeWithEnv(
  'Stage 4 reconciliation over a real RabbitMQ broker: repairs a genuinely missed event',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    const producerToken = generateServiceToken();
    const billingToPaymentToken = generateServiceToken();

    async function withChannel<T>(fn: (ch: Awaited<ReturnType<ChannelModel['createChannel']>>) => Promise<T>): Promise<T> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        return await fn(ch);
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
    async function purgeBillingQueues(): Promise<void> {
      for (const q of [BILLING_QUEUE, BILLING_DEAD_QUEUE]) {
        await withChannel(async (ch) => {
          try {
            await ch.purgeQueue(q);
          } catch {
            // does not exist yet
          }
        }).catch(() => undefined);
      }
    }

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingr');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentr');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      await purgeBillingQueues();

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
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        // Fast enough that the test does not sit idle for long, slow enough it never races the dispatch itself.
        // 1000ms is BILLING_RECONCILE_INTERVAL_MS's own configured floor (billing-config.ts) — the fastest this can go.
        BILLING_RECONCILE_INTERVAL_MS: '1000',
        BILLING_RECONCILE_STALE_REQUESTED_MS: String(RECONCILE_STALE_MS),
      });

      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- payment ---\n${payment.tail()}\n--- billing ---\n${billing.tail()}`);
      }
    }, 90_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      if (amqpConn) {
        // Restore the normal, fully-bound queue for any other suite/run reusing this broker before purging/closing.
        await withChannel(async (ch) => {
          try {
            await ch.bindQueue(BILLING_QUEUE, EXCHANGE, 'payment.cancelled');
          } catch {
            // queue may not exist if this test never got far enough to matter
          }
        }).catch(() => undefined);
        await purgeBillingQueues();
        await amqpConn.close().catch(() => undefined);
      }
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${BILLING_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    }

    it('settles a payment-request via reconciliation, over real HTTP, when the real payment.cancelled event never reaches the real consumer', async () => {
      const sellerId = randomUUID();
      const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: 'e2e-recon-product', name: 'E2E reconciliation product' });
      expect(product.status).toBe(201);
      const price = await asProducer('POST', '/billing/prices', {
        productId: product.json.id,
        clientReference: 'e2e-recon-ref-1',
        currency: 'TND',
        unitAmount: 500,
        interval: 'one_time',
        effectiveFrom: new Date().toISOString(),
      });
      expect(price.status).toBe(201);
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(),
        seller: { type: 'organization', id: sellerId },
        payer: { type: 'user', id: 'e2e-recon-payer-1' },
        sourceType: 'contract',
        sourceId: `src-recon-${randomUUID()}`,
        issuerSnapshot: { schemaVersion: 1 },
        billToSnapshot: { schemaVersion: 1 },
        lines: [{ priceId: price.json.id, quantity: 1 }],
      });
      expect(invoice.status).toBe(201);
      const issued = await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`);
      expect(issued.status).toBe(200);

      const created = await asProducer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
      expect(created.status).toBe(201);
      const requestId: string = created.json.id;

      let requested: any;
      await waitFor(
        async () => {
          const r = await asProducer('GET', `/billing/payment-requests/${requestId}`);
          requested = r.json;
          return r.json.status === 'requested' && r.json.paymentId;
        },
        15_000,
        `payment request ${requestId} to reach 'requested' with a paymentId via the real dispatcher`,
      );

      // ---- manufacture the gap: Billing's real consumer can no longer hear `payment.cancelled` at all ----
      await withChannel((ch) => ch.unbindQueue(BILLING_QUEUE, EXCHANGE, 'payment.cancelled'));

      const cancelResp = await asProducer('POST', `/billing/payment-requests/${requestId}/cancel`);
      expect(cancelResp.status).toBe(200);

      // ---- Payment really did cancel and really did publish; the message is genuinely unroutable now, so the
      //      request must sit `requested` for a while — proving this is not a race, it is a real miss ----
      await new Promise((r) => setTimeout(r, RECONCILE_STALE_MS + 200));
      const stillRequested = await asProducer('GET', `/billing/payment-requests/${requestId}`);
      expect(stillRequested.json.status).toBe('requested');

      // ---- the reconciler's own real HTTP lookup to Payment must be what settles it, once the row is stale enough ----
      let settled: any;
      await waitFor(
        async () => {
          const r = await asProducer('GET', `/billing/payment-requests/${requestId}`);
          settled = r.json;
          return r.json.status === 'cancelled';
        },
        15_000,
        `payment request ${requestId} to reach 'cancelled' via PaymentReconciler, since the real event never arrived`,
      );
      expect(settled.status).toBe('cancelled');

      // ---- proof it was reconciliation, not the consumer: `applyReconciledSnapshot` runs the SAME `applyPaymentEvent`
      //      procedure the consumer does (SDD 21.5), so a receipt row exists either way — the real discriminator is
      //      `billing_transition."causeType"`, which the consumer always records as 'payment_event' (actors.ts
      //      `requestTransitionContext`) and the reconciler as 'reconciliation' (`jobTransitionContext`) ----
      const billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      // pg.Pool emits 'error' for a background/idle client failure (e.g. afterAll's TestDatabase.drop() terminating any
      // straggler backend) — unhandled, that crashes the process; this mirrors the amqp channels' own `ch.on('error', ...)`.
      billingAdmin.on('error', () => undefined);
      const receipt = await billingAdmin.query(
        `SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.cancelled'`,
        [requestId],
      );
      expect(receipt.rows.length).toBe(1); // exactly one receipt, however it was produced
      const transition = await billingAdmin.query(
        `SELECT "causeType" FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'cancelled' ORDER BY "occurredAt" DESC LIMIT 1`,
        [requestId],
      );
      expect(transition.rows[0]?.causeType).toBe('reconciliation'); // NOT 'payment_event' — the consumer never got it
      await billingAdmin.end();
    });
  },
);
