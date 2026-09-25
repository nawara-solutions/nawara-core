import { RabbitMqEventBus } from '@nawara/service-kit';
import { AppModule } from './app.module.js';
import { loadAuditConfig } from './config/audit-config.js';
import { AUDIT_EVENT_BUS } from './ingestion/audit-consumer.js';
import { AUDIT_BINDINGS, AUDIT_EXCHANGE, AUDIT_QUEUE, consumerPrefetch } from './ingestion/ingestion.constants.js';

const config = (over: NodeJS.ProcessEnv = {}) =>
  loadAuditConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://audit_app:pw@db/audit', RABBITMQ_URL: 'amqp://broker:5672', ...over });

/** The production wiring of the ingestion bus (what `main.ts` builds): no test ever overrides these. */
function productionBus(over: NodeJS.ProcessEnv = {}): RabbitMqEventBus {
  const mod = AppModule.register(config(over));
  const providers = (mod.imports ?? []).flatMap((m) => ((m as { providers?: unknown[] }).providers ?? []) as Array<{ provide?: unknown; useValue?: unknown }>);
  return providers.find((p) => p.provide === AUDIT_EVENT_BUS)!.useValue as RabbitMqEventBus;
}
const prefetchOf = (bus: RabbitMqEventBus) => (bus as unknown as { prefetch: number }).prefetch;

describe('ingestion wiring (Stage 18.5)', () => {
  it('the topology is fixed by the architecture: nawara.events, audit-service.audit, audit.# only', () => {
    expect(AUDIT_EXCHANGE).toBe('nawara.events');
    expect(AUDIT_QUEUE).toBe('audit-service.audit');
    expect(AUDIT_BINDINGS).toEqual(['audit.#']);
    expect(Object.isFrozen(AUDIT_BINDINGS)).toBe(true);
  });

  it('the production bus is the kit RabbitMQ bus with a BOUNDED prefetch: half the database pool, 1 to 10', () => {
    expect(productionBus()).toBeInstanceOf(RabbitMqEventBus);
    expect(prefetchOf(productionBus())).toBe(5); // the default pool of 10
    expect(prefetchOf(productionBus({ DB_POOL_MAX: '1' }))).toBe(1);
    expect(prefetchOf(productionBus({ DB_POOL_MAX: '100' }))).toBe(10);
    for (const pool of [1, 2, 7, 10, 20, 100]) expect(consumerPrefetch(pool)).toBe(Math.min(10, Math.max(1, Math.floor(pool / 2))));
  });
});
