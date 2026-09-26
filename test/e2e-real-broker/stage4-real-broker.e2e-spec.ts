import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, paymentPolicy, startReferenceStub } from './support/admission.js';

/** Stage 21.C.2: a stand-in Organization reference read + test-only caller policies (support/admission.ts). */
const refStub = await startReferenceStub();
afterAll(() => refStub.close());

/**
 * Stage 5 hardening (production/integration audit, Candidate A §4.1): proves the Stage 4 loop
 *
 *   PaymentDispatcher -> Payment HTTP API -> Payment outbox -> RabbitMQ -> Billing PaymentEventConsumer
 *   -> payment_event_receipt -> Billing state transition
 *
 * against a REAL RabbitMQ broker and REAL HTTP between two separately spawned, already-built processes — never one
 * service's TypeScript imported into the other's test (that would violate `scripts/lib/checks.mjs`'s cross-service
 * import ban, and would defeat the point: this suite exists specifically to prove the boundary the 25 existing
 * `payment-integration.e2e-spec.ts` tests do NOT exercise, because they use `FakePaymentClient` and
 * `InMemoryEventBus`). Those 25 tests already exhaustively prove the DOMAIN decision logic (duplicates,
 * out-of-order, conflicts, deferrals) against a real database; this suite does not re-derive that, only the
 * transport around it.
 *
 * Scenario chosen deliberately to avoid needing a third (auth-service) process: `POST /payment/payments` and
 * `POST /payment/payments/:id/cancel` are BOTH `ServiceTokenGuard`-only (no user bearer, so Auth is never called).
 * Driving a full user payment (attempt + provider webhook) to `payment.succeeded` would need a real user JWT from a
 * real auth-service, which is unrelated to what this suite is proving. Billing's own producer-initiated CANCEL of an
 * already-`requested` request exercises the exact same transport path (Payment's real outbox -> real RabbitMQ ->
 * Billing's real consumer -> a real `payment_event_receipt` row -> a real state transition) via `payment.cancelled`,
 * which is a genuine, in-scope Stage 4 terminal event.
 *
 * NOT in scope here (documented, not silently skipped):
 * - Out-of-order / conflicting events: already exhaustively proven at the decision-logic level; the transport here
 *   does not change how an out-of-order event is decided, only how it arrives.
 * - Reconciliation: `PaymentReconciler` talks to Payment over plain HTTP, never the broker — a real-broker suite
 *   proves nothing about it that the existing `FakePaymentClient` suite does not already cover.
 * - Real broker OUTAGE mid-flow: killing/restarting the RabbitMQ container mid-test is heavy process orchestration
 *   whose value is disproportionate to what it would add here; left as a documented gap (Stage 5 audit, §4.1).
 *
 * Isolation: `RabbitMqEventBus` does not expose a per-run exchange/queue name (both are fixed), so this suite
 * purges the exact queues it uses (`billing.payment-events`, its `.dead` twin) before AND after, rather than
 * inventing unique names — the audit's own two officially-considered options, and this is the one that needs no
 * production code change.
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service` (both `dist/` present).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13101;
const PAYMENT_PORT = 13102;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;

describeWithEnv(
  'Stage 4 over a real RabbitMQ broker and real HTTP between two live processes',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    const producerToken = generateServiceToken(); // creates invoices/payment-requests in Billing, as itself
    const billingToPaymentToken = generateServiceToken(); // Billing's OWN token when it calls Payment

    async function purgeQueue(name: string): Promise<void> {
      // A fresh channel per queue: a 404 (queue not yet declared, e.g. the very first run) closes its channel
      // server-side, which amqplib surfaces BOTH as a rejected promise AND an 'error' event on the channel — the
      // event must be handled too, or it becomes an unhandled exception that can take down the whole test run.
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.purgeQueue(name);
      } catch {
        // does not exist yet — nothing to purge
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
    async function purgeBillingQueues(): Promise<void> {
      await purgeQueue(BILLING_QUEUE);
      await purgeQueue(BILLING_DEAD_QUEUE);
    }
    async function deadLetterDepth(): Promise<number> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        return (await ch.checkQueue(BILLING_DEAD_QUEUE)).messageCount;
      } catch {
        return 0; // does not exist yet — nothing has ever dead-lettered
      } finally {
        await ch.close().catch(() => undefined);
      }
    }

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebilling');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epayment');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL);
      // A stray message from a previous crashed run must never leak into this run's assertions.
      await purgeBillingQueues();

      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9', // never called: both routes this suite drives are ServiceTokenGuard-only
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`, ...paymentPolicy('billing-service'), ...refStub.env, // the caller name IS the `producer` on every event (EXPECTED_PRODUCER)
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: env.TEST_RABBITMQ_URL,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        // Fast dispatch so the test does not need a long wait for the real background job to notice the new row;
        // reconcile is pushed far out so it never races this suite's own assertions (mirrors the in-process suites).
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
      });

      try {
        await Promise.all([waitForHealth(`${PAYMENT_URL}/health`, 20_000), waitForHealth(`${BILLING_URL}/health`, 20_000)]);
      } catch (e) {
        // A boot failure's cause is almost always in one process's own stdout/stderr; surface it instead of a bare timeout.
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- payment ---\n${payment.tail()}\n--- billing ---\n${billing.tail()}`);
      }
    }, 90_000);

    afterAll(async () => {
      await billing?.stop();
      await payment?.stop();
      if (amqpConn) {
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

    it('a real dispatch + a real broker-delivered payment.cancelled event moves Billing state, stays idempotent under redelivery, and dead-letters a malformed event', async () => {
      // ---- seed a product/price and an issued invoice (billing's real Catalog + Invoices HTTP API) ----
      const sellerId = randomUUID();
      const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: sellerId }, code: 'e2e-product', name: 'E2E product' });
      expect(product.status).toBe(201);
      const price = await asProducer('POST', '/billing/prices', {
        productId: product.json.id,
        clientReference: 'e2e-ref-1',
        currency: 'TND',
        unitAmount: 1000,
        interval: 'one_time',
        effectiveFrom: new Date().toISOString(),
      });
      expect(price.status).toBe(201);
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(),
        seller: { type: 'organization', id: sellerId },
        payer: { type: 'user', id: 'e2e-payer-1' },
        sourceType: 'contract',
        sourceId: `src-${randomBytes(4).toString('hex')}`,
        issuerSnapshot: { schemaVersion: 1 },
        billToSnapshot: { schemaVersion: 1 },
        lines: [{ priceId: price.json.id, quantity: 1 }],
      });
      expect(invoice.status).toBe(201);
      const issued = await asProducer('POST', `/billing/invoices/${invoice.json.id}/issue`);
      expect(issued.status).toBe(200);

      // ---- create the payment request; the REAL dispatcher sends it to the REAL Payment HTTP API ----
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
        `payment request ${requestId} to reach 'requested' with a paymentId via the real dispatcher -> real Payment API`,
      );
      expect(requested.status).toBe('requested');
      expect(typeof requested.paymentId).toBe('string');

      // ---- producer cancels the now-`requested` request: Billing calls Payment's REAL cancel endpoint ----
      const cancelResp = await asProducer('POST', `/billing/payment-requests/${requestId}/cancel`);
      expect(cancelResp.status).toBe(200);

      // ---- the real Payment outbox relay publishes `payment.cancelled` to the REAL broker; Billing's REAL
      //      consumer (subscribed on `billing.payment-events`) must receive it and transition the request ----
      let cancelled: any;
      await waitFor(
        async () => {
          const r = await asProducer('GET', `/billing/payment-requests/${requestId}`);
          cancelled = r.json;
          return r.json.status === 'cancelled';
        },
        20_000,
        `payment request ${requestId} to reach 'cancelled' via a REAL RabbitMQ-delivered payment.cancelled event`,
      );
      expect(cancelled.status).toBe('cancelled');

      // ---- financial-invariant spot check: exactly ONE receipt exists for this payment's cancellation so far ----
      const billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      const { rows } = await billingAdmin.query<{ eventId: string }>(
        `SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.cancelled'`,
        [requestId],
      );
      expect(rows.length).toBe(1);
      const capturedEventId = rows[0]!.eventId;
      const before = await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1`, [capturedEventId]);
      expect(before.rows[0].n).toBe(1);

      // ---- duplicate delivery over the REAL broker must stay idempotent: republish a well-formed event with the
      //      SAME id (broker at-least-once redelivery, e.g. an ack lost after processing). `applyPaymentEvent`'s
      //      "seen" check (SDD 21.4) runs BEFORE `decidePaymentEvent` and short-circuits on a matching `eventId`
      //      alone, so this must be ACKED, not dead-lettered, and must never write a second receipt row. ----
      const dlqBeforeDup = await deadLetterDepth();
      const dupCh = await amqpConn.createChannel();
      dupCh.on('error', () => undefined);
      try {
        dupCh.publish(
          EXCHANGE,
          'payment.cancelled',
          Buffer.from(
            JSON.stringify({
              paymentId: requested.paymentId,
              producer: 'billing-service',
              paymentRequestId: requestId,
              sourceType: 'invoice',
              sourceId: invoice.json.id,
              payer: { type: 'user', id: 'e2e-payer-1' },
              seller: { type: 'organization', id: sellerId },
              organizationId: sellerId,
              currency: 'TND',
              revision: 0,
              amount: 1000,
            }),
          ),
          { messageId: capturedEventId, type: 'payment.cancelled', headers: { occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } },
        );
      } finally {
        await dupCh.close().catch(() => undefined);
      }
      // Give the real consumer time to receive and process it, then assert it changed nothing: no new receipt row,
      // no dead letter, and the request's status is unchanged.
      await new Promise((r) => setTimeout(r, 2000));
      const after = await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1`, [capturedEventId]);
      expect(after.rows[0].n).toBe(1); // still exactly one receipt row for this event id
      expect(await deadLetterDepth()).toBe(dlqBeforeDup); // a well-formed redelivery is never dead-lettered
      const stillCancelled = await asProducer('GET', `/billing/payment-requests/${requestId}`);
      expect(stillCancelled.json.status).toBe('cancelled'); // unchanged
      await billingAdmin.end();

      // ---- a genuinely malformed event (missing every required field) is dead-lettered, never silently dropped ----
      const dlqBeforeBad = await deadLetterDepth();
      const badCh = await amqpConn.createChannel();
      badCh.on('error', () => undefined);
      try {
        badCh.publish(EXCHANGE, 'payment.succeeded', Buffer.from(JSON.stringify({ nonsense: true })), {
          messageId: randomUUID(),
          type: 'payment.succeeded',
          headers: { occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 },
        });
      } finally {
        await badCh.close().catch(() => undefined);
      }
      await waitFor(async () => (await deadLetterDepth()) > dlqBeforeBad, 10_000, 'a malformed payment.succeeded event to be dead-lettered');
    });
  },
);
