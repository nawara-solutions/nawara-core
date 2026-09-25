import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { describeWithEnv } from './support/env.js';
import { startFakeAuthServer, type FakeAuthServer } from './support/fake-auth.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 12.7 — real-broker integration: proves the loop the Stage 4/5 suite (`stage4-real-broker.e2e-spec.ts`)
 * deliberately stopped short of, and that Stage 12.4/12.6 deliberately proved WITHOUT a real broker (see both files'
 * own header comments):
 *
 *   Payment settlement -> real Payment outbox -> real RabbitMQ -> real Billing PaymentEventConsumer
 *   -> payment_event_receipt -> PaymentRequest/Invoice settled -> Subscription activated/renewed -> Effective Access
 *
 * `stage4-real-broker.e2e-spec.ts` only drove `payment.cancelled` (chosen specifically to avoid needing a payer
 * identity, since Payment's `/attempts` endpoint is payer-only — `AuthorizationService.assertCanStartAttempt`,
 * apps/payment-service/src/authorization/authorization.service.ts). Reaching `payment.succeeded` needs a real payer,
 * so this suite adds one real capability: a tiny fake auth-service (`support/fake-auth.ts`) that answers `GET
 * /auth/me` for one fixed bearer, so Payment's real `HttpAuthClient` (libs/service-kit) is exercised unmodified —
 * only the identity behind that bearer is test-controlled, exactly like a real auth-service would answer for it.
 *
 * NOT re-derived here (already proven elsewhere, cited instead of duplicated):
 * - The decision logic itself (conflicts, deferrals, amount/currency mismatches, grace/late renewal anchors,
 *   concurrent duplicate delivery, live-event-vs-reconciliation) — Stage 12.4 (`payment-subscription-integration.e2e-spec.ts`)
 *   and Stage 12.6 (`subscription-hardening.e2e-spec.ts`) already exhaustively prove it against real PostgreSQL by
 *   calling `PaymentRequestRepository.applyPaymentEvent` directly. This suite proves the real broker delivers the
 *   correct event, unchanged, into that exact same code path — it does not re-prove the decision logic itself.
 * - Generic broker transport mechanics (publisher confirms, bounded retry, DLQ, replay, malformed-payload
 *   dead-lettering, consumer reconnect after a severed connection) — already proven with a real broker at
 *   `libs/service-kit/test/rabbitmq*.int-spec.ts` and, for this exact Payment/Billing wire, at
 *   `test/e2e-real-broker/stage4-real-broker-dlq-replay.e2e-spec.ts` and `stage4-real-broker-consumer-recovery.e2e-spec.ts`.
 *   Subscription-linking runs in the SAME transaction as the receipt/PaymentRequest update (no separate risk a
 *   generic retry/DLQ proof would miss — apps/billing-service/src/invoices/payment-request.repository.ts `applyPaymentEvent`).
 *
 * Prerequisite: `npm run build -w @nawara/service-kit -w billing-service -w payment-service` (both `dist/` present).
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BILLING_DIR = `${ROOT}apps/billing-service`;
const PAYMENT_DIR = `${ROOT}apps/payment-service`;
const BILLING_PORT = 13201;
const PAYMENT_PORT = 13202;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const PAYMENT_URL = `http://127.0.0.1:${PAYMENT_PORT}`;
const EXCHANGE = 'nawara.events';
const BILLING_QUEUE = 'billing.payment-events';
const BILLING_DEAD_QUEUE = `${BILLING_QUEUE}.dead`;
const PAYER_TOKEN = 'e2e-payer-jwt';
const PAYER_ID = 'e2e0e2e0-0000-4000-8000-00000000fa01'; // Stage 18.7: a real Auth user id is a UUID (the central audit actor must be one)

describeWithEnv(
  'Stage 12.7: Payment settlement -> real RabbitMQ -> Billing -> Subscription -> Effective Access',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'],
  (env) => {
    let billingDb: TestDatabase;
    let paymentDb: TestDatabase;
    let billing: LiveService;
    let payment: LiveService;
    let amqpConn: ChannelModel;
    let fakeAuth: FakeAuthServer;
    let proxy: BrokerProxy;
    let billingAdmin: pg.Pool;
    let paymentAdmin: pg.Pool;
    const producerToken = generateServiceToken(); // creates products/prices/invoices/payment-requests in Billing, as itself
    const billingToPaymentToken = generateServiceToken(); // Billing's OWN token when it calls Payment (create/cancel)

    async function purgeQueue(name: string): Promise<void> {
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        await ch.purgeQueue(name);
      } catch {
        // does not exist yet
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
        return 0;
      } finally {
        await ch.close().catch(() => undefined);
      }
    }

    beforeAll(async () => {
      billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2ebillingsub');
      paymentDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2epaymentsub');
      await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
      await runMigrations(paymentDb.url, [kitMigrationsDir, `${PAYMENT_DIR}/db/migrations/`]);
      billingAdmin = new pg.Pool({ connectionString: billingDb.url });
      paymentAdmin = new pg.Pool({ connectionString: paymentDb.url });

      amqpConn = await amqp.connect(env.TEST_RABBITMQ_URL); // the suite's own admin connection: NEVER routed through the proxy
      await purgeBillingQueues();

      fakeAuth = await startFakeAuthServer({ [PAYER_TOKEN]: { id: PAYER_ID, isActive: true } });

      // Both services connect through this proxy so test D can simulate a real broker outage/recovery without
      // touching the shared CI RabbitMQ container. Transparent when not severed (see support/fake-auth.ts's sibling,
      // BrokerProxy, in libs/service-kit/src/testing).
      const brokerTarget = new URL(env.TEST_RABBITMQ_URL);
      proxy = new BrokerProxy({ host: brokerTarget.hostname, port: Number(brokerTarget.port || 5672) });
      await proxy.start();

      payment = spawnService('payment', PAYMENT_DIR, {
        NODE_ENV: 'test',
        PORT: String(PAYMENT_PORT),
        DATABASE_URL: paymentDb.url,
        AUTH_SERVICE_URL: fakeAuth.url,
        RABBITMQ_URL: proxy.url,
        PAYMENT_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_TEST_PROVIDER: 'true',
        SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`,
      });
      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: proxy.url,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
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
      await fakeAuth?.stop();
      if (amqpConn) {
        await purgeBillingQueues();
        await amqpConn.close().catch(() => undefined);
      }
      await proxy?.sever();
      await billingAdmin?.end();
      await paymentAdmin?.end();
      await billingDb?.drop();
      await paymentDb?.drop();
    }, 45_000);

    // -------------------------------------------------------------------------------------------------------- helpers
    async function asProducer(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${BILLING_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    }
    async function asPayer(method: 'POST', path: string, body?: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${PAYMENT_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${PAYER_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    }

    let seq = 0;
    async function seedRecurringPrice(organizationId: string): Promise<{ productId: string; priceId: string }> {
      seq += 1;
      const product = await asProducer('POST', '/billing/products', { seller: { type: 'organization', id: organizationId }, code: `e2e-sub-product-${seq}`, name: `E2E subscription product ${seq}` });
      expect(product.status).toBe(201);
      const price = await asProducer('POST', '/billing/prices', {
        productId: product.json.id,
        clientReference: `e2e-sub-ref-${seq}`,
        currency: 'TND',
        unitAmount: 5000,
        interval: 'recurring',
        intervalUnit: 'month',
        intervalCount: 1,
        effectiveFrom: new Date().toISOString(),
      });
      expect(price.status).toBe(201);
      return { productId: product.json.id, priceId: price.json.id };
    }

    /** Seeds a real recurring invoice + payment-request and waits for the real dispatcher to attach a real Payment. */
    async function requestedRecurringPayment(organizationId: string, priceId: string): Promise<{ invoiceId: string; requestId: string; paymentId: string }> {
      const invoice = await asProducer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(),
        seller: { type: 'organization', id: organizationId },
        payer: { type: 'user', id: PAYER_ID },
        sourceType: 'contract',
        sourceId: `src-${randomUUID()}`,
        issuerSnapshot: { schemaVersion: 1 },
        billToSnapshot: { schemaVersion: 1 },
        lines: [{ priceId, quantity: 1 }],
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
      return { invoiceId: invoice.json.id, requestId, paymentId: requested.paymentId };
    }

    /** Drives a real Payment to `succeeded` as the real payer, over real HTTP, using the built-in `test` provider. */
    async function settleAsPayer(paymentId: string): Promise<void> {
      const start = await asPayer('POST', `/payment/payments/${paymentId}/attempts`, { providerOptions: { scenario: 'success' } });
      expect(start.status).toBe(201);
      const synced = await asPayer('POST', `/payment/payments/${paymentId}/attempts/${start.json.id}/sync`);
      expect(synced.status).toBe(200);
      expect(synced.json.status).toBe('succeeded');
    }

    async function waitForRequestPaid(requestId: string, timeoutMs = 30_000): Promise<void> {
      await waitFor(
        async () => (await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.status === 'paid',
        timeoutMs,
        `payment request ${requestId} to reach 'paid' via a REAL RabbitMQ-delivered payment.succeeded event`,
      );
    }

    async function getEntitlement(organizationId: string): Promise<{ valid: boolean; expiresAt: string | null }> {
      const r = await asProducer('GET', `/billing/organizations/${organizationId}/entitlement`);
      expect(r.status).toBe(200);
      return r.json;
    }

    // ---------------------------------------------------------------------------------------------------------- tests
    it('A: a real settlement flows through the real broker into Subscription activation and Effective Access, anchored on the settlement instant, and stays idempotent under real duplicate broker delivery', async () => {
      const organizationId = randomUUID();
      const { priceId } = await seedRecurringPrice(organizationId);
      const { requestId, paymentId } = await requestedRecurringPayment(organizationId, priceId);

      await settleAsPayer(paymentId);
      await waitForRequestPaid(requestId);

      const receipt = await billingAdmin.query<{ eventId: string }>(`SELECT "eventId" FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded'`, [requestId]);
      expect(receipt.rows.length).toBe(1);
      const capturedEventId = receipt.rows[0]!.eventId;

      const paymentRow = await paymentAdmin.query<{ closedAt: Date }>(`SELECT "closedAt" FROM payment WHERE id = $1`, [paymentId]);
      const closedAt = paymentRow.rows[0]!.closedAt;
      expect(closedAt).not.toBeNull();

      const sub = await billingAdmin.query(`SELECT status, "currentPeriodStart", "currentPeriodEnd", revision FROM subscription WHERE "organizationId" = $1`, [organizationId]);
      expect(sub.rows.length).toBe(1);
      expect(sub.rows[0].status).toBe('active');
      expect(sub.rows[0].revision).toBe(1); // create(0) + activate(1)
      // The authoritative anchor came from Payment's `closedAt` through the REAL broker, not Billing's own receive time.
      expect(sub.rows[0].currentPeriodStart).toEqual(closedAt);
      const periodEnd: Date = sub.rows[0].currentPeriodEnd;

      const entitlement = await getEntitlement(organizationId);
      expect(entitlement).toEqual({ valid: true, expiresAt: periodEnd.toISOString() });

      // ---- duplicate delivery over the REAL broker: the same eventId redelivered must have ZERO additional effect ----
      const dlqBefore = await deadLetterDepth();
      const invoice = await asProducer('GET', `/billing/invoices/${(await asProducer('GET', `/billing/payment-requests/${requestId}`)).json.invoiceId}`);
      const dupCh = await amqpConn.createChannel();
      dupCh.on('error', () => undefined);
      try {
        dupCh.publish(
          EXCHANGE,
          'payment.succeeded',
          Buffer.from(
            JSON.stringify({
              paymentId, producer: 'billing-service', paymentRequestId: requestId, sourceType: 'invoice', sourceId: invoice.json.id,
              payer: { type: 'user', id: PAYER_ID }, seller: { type: 'organization', id: organizationId }, organizationId,
              currency: invoice.json.currency, revision: 1, amount: Number(invoice.json.total),
            }),
          ),
          { messageId: capturedEventId, type: 'payment.succeeded', headers: { occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } },
        );
      } finally {
        await dupCh.close().catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 2000)); // let the real consumer receive and process it
      const receiptAfter = await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1`, [capturedEventId]);
      expect(receiptAfter.rows[0].n).toBe(1); // still exactly one receipt row for this event id
      expect(await deadLetterDepth()).toBe(dlqBefore); // a well-formed redelivery is never dead-lettered
      const subAfter = await billingAdmin.query(`SELECT status, "currentPeriodStart", "currentPeriodEnd", revision FROM subscription WHERE "organizationId" = $1`, [organizationId]);
      expect(subAfter.rows[0]).toEqual(sub.rows[0]); // byte-identical: no second period extension, no extra revision
      expect(await getEntitlement(organizationId)).toEqual(entitlement);
    }, 60_000);

    it('B: a spoofed event naming a real PaymentRequest of a DIFFERENT organization is rejected as a conflict over the real broker — that organization\'s Invoice, PaymentRequest and Subscription are never mutated', async () => {
      // Organization VICTIM: a real, still-open recurring payment request (never settled in this test).
      const victimOrg = randomUUID();
      const { priceId: victimPriceId } = await seedRecurringPrice(victimOrg);
      const victim = await requestedRecurringPayment(victimOrg, victimPriceId);
      const victimBefore = await asProducer('GET', `/billing/payment-requests/${victim.requestId}`);
      expect(victimBefore.json.status).toBe('requested');

      // A spoofed `payment.succeeded` naming the VICTIM's real paymentRequestId, but with an unrelated organization's
      // identity in every other field (as if a compromised or misconfigured producer tried to settle someone else's
      // obligation). The event is well-formed (passes `parseFacts`), so it is decided, not dead-lettered — and the
      // snapshot mismatch must make it a `conflict`, never a mutation.
      const attackerOrg = randomUUID();
      const dlqBefore = await deadLetterDepth();
      const ch = await amqpConn.createChannel();
      ch.on('error', () => undefined);
      try {
        ch.publish(
          EXCHANGE,
          'payment.succeeded',
          Buffer.from(
            JSON.stringify({
              paymentId: randomUUID(), producer: 'billing-service', paymentRequestId: victim.requestId, sourceType: 'invoice', sourceId: randomUUID(),
              payer: { type: 'user', id: 'attacker-payer' }, seller: { type: 'organization', id: attackerOrg }, organizationId: attackerOrg,
              currency: 'TND', revision: 1, amount: 1,
            }),
          ),
          { messageId: randomUUID(), type: 'payment.succeeded', headers: { occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } },
        );
      } finally {
        await ch.close().catch(() => undefined);
      }

      // A receipt IS recorded (the delivery was seen and decided), but the outcome must be `conflict`, and the
      // victim's own request/invoice/subscription must be byte-identical to before.
      await waitFor(
        async () => (await billingAdmin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [victim.requestId])).rows[0].n > 0,
        10_000,
        'the spoofed event to be received and decided',
      );
      const receipt = await billingAdmin.query(`SELECT outcome, "detailCode" FROM payment_event_receipt WHERE "paymentRequestId" = $1`, [victim.requestId]);
      expect(receipt.rows[0]).toMatchObject({ outcome: 'conflict' });
      expect(await deadLetterDepth()).toBe(dlqBefore); // a decided conflict is acked, never dead-lettered

      const victimAfter = await asProducer('GET', `/billing/payment-requests/${victim.requestId}`);
      expect(victimAfter.json).toEqual(victimBefore.json); // completely untouched
      await expect(billingAdmin.query(`SELECT 1 FROM subscription WHERE "organizationId" = $1`, [victimOrg])).resolves.toMatchObject({ rowCount: 0 });
      await expect(billingAdmin.query(`SELECT 1 FROM subscription WHERE "organizationId" = $1`, [attackerOrg])).resolves.toMatchObject({ rowCount: 0 });
    }, 30_000);

    it('C: a settlement published while Billing is unavailable is retained durably by the real broker; once Billing restarts, the Subscription anchors on the ORIGINAL settlement instant, not on the delayed processing time', async () => {
      const organizationId = randomUUID();
      const { priceId } = await seedRecurringPrice(organizationId);
      // Everything up to and including the real dispatcher attaching a Payment needs Billing running.
      const { requestId, paymentId } = await requestedRecurringPayment(organizationId, priceId);

      await billing.stop();
      await settleAsPayer(paymentId); // Payment settles and publishes to the real, durable queue with NO consumer attached
      await new Promise((r) => setTimeout(r, 3000)); // a real gap between settlement and eventual processing

      const paymentRow = await paymentAdmin.query<{ closedAt: Date }>(`SELECT "closedAt" FROM payment WHERE id = $1`, [paymentId]);
      const closedAt = paymentRow.rows[0]!.closedAt;
      expect(closedAt).not.toBeNull();
      expect(Date.now() - closedAt.getTime()).toBeGreaterThan(2500); // proves real elapsed time, not just code inspection

      billing = spawnService('billing', BILLING_DIR, {
        NODE_ENV: 'test',
        PORT: String(BILLING_PORT),
        DATABASE_URL: billingDb.url,
        AUTH_SERVICE_URL: 'http://127.0.0.1:9',
        RABBITMQ_URL: proxy.url,
        BILLING_SUPPORTED_CURRENCIES: 'TND',
        SERVICE_TOKENS: `test-producer:${producerToken.digest}`,
        PAYMENT_SERVICE_URL: PAYMENT_URL,
        PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
        BILLING_DISPATCH_INTERVAL_MS: '300',
        BILLING_RECONCILE_INTERVAL_MS: '3600000',
      });
      try {
        await waitForHealth(`${BILLING_URL}/health`, 20_000);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n--- billing ---\n${billing.tail()}`);
      }
      await waitForRequestPaid(requestId);

      const sub = await billingAdmin.query(`SELECT "currentPeriodStart" FROM subscription WHERE "organizationId" = $1`, [organizationId]);
      expect(sub.rows[0].currentPeriodStart).toEqual(closedAt); // anchored on settlement, never on the delayed receive/processing time
    }, 60_000);

    it('D: Payment settling while the real broker is unreachable survives in the outbox; once the broker returns, the relay delivers it and Billing (still connected throughout) processes it into a genuine Subscription effect', async () => {
      const organizationId = randomUUID();
      const { priceId } = await seedRecurringPrice(organizationId);
      const { requestId, paymentId } = await requestedRecurringPayment(organizationId, priceId);

      await proxy.sever(); // "the broker goes away" for both Payment's publisher and Billing's consumer
      await settleAsPayer(paymentId); // Payment's own DB transaction still succeeds — settlement never depends on broker availability
      await new Promise((r) => setTimeout(r, 1500));
      const stillRequested = await asProducer('GET', `/billing/payment-requests/${requestId}`);
      expect(stillRequested.json.status).toBe('requested'); // nothing arrived yet: outbox row is pending, not lost

      const outboxRow = await paymentAdmin.query(`SELECT "publishedAt" FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [paymentId]);
      expect(outboxRow.rows[0].publishedAt).toBeNull();

      await proxy.start(); // "the broker returns" on the same address; the relay's own polling loop retries without intervention
      await waitForRequestPaid(requestId);

      const sub = await billingAdmin.query(`SELECT status, revision FROM subscription WHERE "organizationId" = $1`, [organizationId]);
      expect(sub.rows[0]).toMatchObject({ status: 'active', revision: 1 }); // exactly one genuine effect, delivered late
      const entitlement = await getEntitlement(organizationId);
      expect(entitlement.valid).toBe(true);
    }, 60_000);
  },
);
