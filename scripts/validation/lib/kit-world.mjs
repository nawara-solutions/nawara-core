// Stage 15 kit world (test-only): a producer database with the kit outbox, a consumer with the kit inbox and an `effect` table, one
// exchange and queue, and per-event-id accounting (business row, outbox row, publish attempts, physical deliveries, inbox accepts,
// effects). Shared by the broker (15.3) and worker/concurrency (15.4) campaigns.
import { randomBytes, randomUUID } from 'node:crypto';
import { DbService, InboxService, OutboxRelay, OutboxService, RabbitMqEventBus, kitMigrationsDir, runMigrations } from '../../../libs/service-kit/dist/index.js';
import * as h from './harness.mjs';

export const uniq = () => randomBytes(4).toString('hex');
export const envelopeHeaders = (id, name) => ({ eventId: id, occurredAt: new Date().toISOString(), source: 'validation', version: 1, correlationId: `corr-${id.slice(0, 8)}` });

/** Binds the world to one throwaway broker and PostgreSQL. */
export function kitWorlds({ rabbit, adminUrl: ADMIN }) {
  /** A producer database with the kit outbox, a consumer database with the kit inbox and an `effect` table, one exchange and queue. */
  return async function kitWorld({ publisherUrl = rabbit.url, confirmTimeoutMs, consumers = 1, retry, subscribe = true, onNotice } = {}) {
    const db = await h.throwawayDatabase(ADMIN, null);
    await runMigrations(db.url, [kitMigrationsDir]);
    await h.adminQuery(db.url, 'CREATE TABLE business (id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
    await h.adminQuery(db.url, 'CREATE TABLE effect (id bigserial PRIMARY KEY, event_id text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const dbs = new DbService({ url: db.url, applicationName: 'validation-producer' });
    const cdb = new DbService({ url: db.url, applicationName: 'validation-consumer' });
    const exchange = `validation.x.${uniq()}`;
    const queue = `validation.q.${uniq()}`;
    const notices = [];
    const pub = new RabbitMqEventBus({ url: publisherUrl, exchange, confirmTimeoutMs, onNotice: (m, l) => (notices.push([l, m, Date.now()]), onNotice?.(m, l)) });
    const relayErrors = [];
    const relay = new OutboxRelay(dbs, pub, { source: 'validation' }, (m) => relayErrors.push(m));
    const outbox = new OutboxService();
    const inbox = new InboxService();
    const deliveries = new Map(); // eventId -> physical deliveries
    const received = [];
    const subs = [];
    const buses = [];
    const handlerHooks = { before: undefined };
    const makeConsumer = async () => {
      const bus = new RabbitMqEventBus({ url: rabbit.url, exchange, retry, consumerReconnect: { baseDelayMs: 200, maxDelayMs: 2000 }, onNotice: (m, l) => notices.push([l, m, Date.now()]) });
      buses.push(bus);
      subs.push(await bus.subscribe({
        queue,
        bindings: ['validation.#'],
        handler: async (event) => {
          deliveries.set(event.id, (deliveries.get(event.id) ?? 0) + 1);
          received.push({ id: event.id, at: Date.now(), occurredAt: Date.parse(event.headers.occurredAt), retry: event.headers.retryCount ?? 0 });
          if (handlerHooks.before) await handlerHooks.before(event);
          await inbox.handle(cdb, event, async (q) => {
            await q.query('INSERT INTO effect (event_id) VALUES ($1)', [event.id]);
          });
        },
      }));
    };
    if (subscribe) for (let i = 0; i < consumers; i++) await makeConsumer();
    const ids = [];
    const enqueue = async (n) => {
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        await dbs.tx(async (q) => {
          await q.query('INSERT INTO business (id) VALUES ($1)', [id]);
          await outbox.enqueue(q, { id, name: 'validation.happened', payload: { id }, correlationId: `corr-${id.slice(0, 8)}` });
        });
        ids.push(id);
      }
    };
    const account = async () => {
      const [o] = await h.adminQuery(db.url, `SELECT count(*)::int AS rows, count(*) FILTER (WHERE "publishedAt" IS NOT NULL)::int AS published,
        count(*) FILTER (WHERE "publishedAt" IS NULL)::int AS pending, coalesce(sum(attempts), 0)::int AS attempts FROM outbox`);
      const [b] = await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM business');
      const eff = await h.adminQuery(db.url, 'SELECT event_id, count(*)::int AS n FROM effect GROUP BY 1');
      const [inb] = await h.adminQuery(db.url, 'SELECT count(*)::int AS n FROM inbox');
      const effected = new Set(eff.map((r) => r.event_id));
      return {
        logicalEvents: ids.length, businessRows: b.n, outboxRows: o.rows, published: o.published, pending: o.pending, publishAttempts: o.attempts,
        physicalDeliveries: [...deliveries.values()].reduce((a, n) => a + n, 0), eventsDeliveredMoreThanOnce: [...deliveries.values()].filter((n) => n > 1).length,
        inboxAccepts: inb.n, businessEffects: eff.reduce((a, r) => a + r.n, 0), duplicateEffects: eff.filter((r) => r.n > 1).length,
        lost: ids.filter((id) => !effected.has(id)).length,
      };
    };
    const drainAll = async (timeoutMs = 60_000) =>
      h.waitFor(async () => {
        await relay.drainOnce().catch(() => undefined);
        const a = await account();
        return a.pending === 0 && a.lost === 0 && a;
      }, timeoutMs, 100);
    const close = async () => {
      relay.stop();
      for (const s of subs) await s.close().catch(() => undefined);
      await pub.close().catch(() => undefined);
      for (const b of buses) await b.close().catch(() => undefined);
      await dbs.onApplicationShutdown().catch(() => undefined);
      await cdb.onApplicationShutdown().catch(() => undefined);
      await db.drop();
    };
    return { db, dbs, cdb, exchange, queue, pub, relay, relayErrors, outbox, inbox, deliveries, received, subs, buses, handlerHooks, makeConsumer, ids, enqueue, account, drainAll, close, notices };
  };
}
