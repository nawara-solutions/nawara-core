// Stage 15.4 in-process Payment layer (test-only), shared by the 15.4 and 15.5 campaigns: payment-service's workers built from `dist`,
// one DbService pool per simulated instance (so every lock is decided by PostgreSQL between separate sessions).
import { randomUUID } from 'node:crypto';
import * as h from './harness.mjs';
import { uniq } from './kit-world.mjs';

const P = `${h.root}apps/payment-service/dist`;
export const [{ loadPaymentConfig }, { ProviderRegistry }, { TestPaymentProvider }, { PaymentService }, { AttemptService }, { AttemptResolver, AttemptResolverService }, { WebhookService }, { WebhookRetriever, WebhookRetrierService, WEBHOOK_RETRY_MAX_ATTEMPTS }, { ExpirySweeper }, { IdempotencyService }, kit] =
  await Promise.all(['config/payment-config.js', 'providers/provider-registry.js', 'providers/test-provider.js', 'payments/payment.service.js', 'attempts/attempt.service.js', 'attempts/attempt-resolver.js', 'webhooks/webhook.service.js', 'webhooks/webhook-retrier.js', 'payments/expiry-sweeper.js', 'idempotency/idempotency.service.js', '../../../libs/service-kit/dist/index.js'].map((m) => import(`${P}/${m}`)));

/** `paymentWorlds({ adminUrl, later })()` → one Payment database; `instance(i)` builds the services a separate payment-service process would have (own pool). */
export function paymentWorlds({ adminUrl, later }) {
  let cache;
  return async function paymentWorld() {
    if (cache) return cache;
    const db = await h.throwawayDatabase(adminUrl, 'payment-service');
    const config = loadPaymentConfig({ NODE_ENV: 'test', DATABASE_URL: db.url, PAYMENT_SUPPORTED_CURRENCIES: 'TND', AUTH_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_TEST_PROVIDER: 'true' });
    const testProvider = new TestPaymentProvider();
    const registry = new ProviderRegistry(config, testProvider);
    const instance = (i, providers = registry) => {
      const pool = new kit.DbService({ url: db.url, applicationName: `validation-payment-${i}` });
      later(() => pool.onApplicationShutdown());
      const outbox = new kit.OutboxService();
      const idem = new IdempotencyService(pool);
      const attempts = new AttemptService(pool, outbox, config, providers, idem);
      const webhooks = new WebhookService(pool, attempts);
      return { pool, payments: new PaymentService(pool, outbox, config, idem), attempts, webhooks, resolver: new AttemptResolver(pool, providers, attempts), retrier: new WebhookRetriever(pool, providers, webhooks), sweeper: new ExpirySweeper(pool, outbox) };
    };
    const seedInstance = instance('seed');
    const createPayment = async (o = {}) => {
      const org = o.org ?? randomUUID();
      return seedInstance.payments.create('billing-service', {
        paymentRequestId: o.paymentRequestId ?? randomUUID(), sourceType: 'invoice', sourceId: randomUUID(), payer: { type: 'user', id: `payer-${uniq()}` },
        seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND', reference: `INV-${uniq()}`, ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
      });
    };
    const startAttempt = (paymentId, scenario, key = randomUUID(), svc = seedInstance.attempts) => svc.start(paymentId, 'payer-validation', key, { provider: 'test', providerOptions: { scenario } });
    const q = (sql, params) => h.adminQuery(db.url, sql, params);
    cache = { db, config, testProvider, registry, instance, createPayment, startAttempt, q };
    return cache;
  };
}

/** A fake provider for the resolver: capabilities of the test provider, `fetchStatus` scripted per reference and synchronised by a barrier. */
export function scriptedProvider(caps, script, gate, calls) {
  return {
    id: 'test', capabilities: caps,
    async fetchStatus(ref) {
      calls.push(ref);
      if (gate) await gate(ref);
      return script(ref);
    },
  };
}
