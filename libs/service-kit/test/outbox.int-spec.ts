import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbService, InMemoryEventBus, InboxService, OutboxRelay, OutboxService, kitMigrationsDir, runMigrations, type EventEnvelope,
} from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('outbox and inbox (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let testDb: TestDatabase;
  let db: DbService;
  const outbox = new OutboxService();
  const inbox = new InboxService();

  beforeAll(async () => {
    testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'outbox');
    await runMigrations(testDb.url, [kitMigrationsDir]);
    db = new DbService({ url: testDb.url, max: 10 });
    await db.query('CREATE TABLE business(id int PRIMARY KEY, v text)');
  });
  afterAll(async () => {
    await db.onApplicationShutdown();
    await testDb.drop();
  });

  const clear = () => db.query('DELETE FROM outbox');
  const count = async (sql: string) => Number((await db.query(sql)).rows[0].n);

  describe('enqueue is transactional with the business change', () => {
    it('the event exists if and only if the business change commits', async () => {
      await clear();
      await db.tx(async (q) => {
        await q.query(`INSERT INTO business VALUES (1, 'a')`);
        await outbox.enqueue(q, { name: 'payment.succeeded', payload: { paymentId: 'p1' }, correlationId: 'corr-1' });
      });
      await expect(db.tx(async (q) => {
        await q.query(`INSERT INTO business VALUES (2, 'b')`);
        await outbox.enqueue(q, { name: 'payment.failed', payload: { paymentId: 'p2' } });
        throw new Error('business rule failed after the event was queued');
      })).rejects.toThrow('business rule failed');
      expect(await count(`SELECT count(*) n FROM outbox`)).toBe(1); // no phantom event for the rolled-back change
      expect(await count(`SELECT count(*) n FROM business WHERE id = 2`)).toBe(0);
      const row = (await db.query('SELECT name, payload, "correlationId", "eventVersion" FROM outbox')).rows[0];
      expect(row).toMatchObject({ name: 'payment.succeeded', payload: { paymentId: 'p1' }, correlationId: 'corr-1', eventVersion: 1 });
    });

    it('is idempotent for a retried operation that supplies the same event id', async () => {
      await clear();
      const id = '22222222-2222-4222-8222-222222222222';
      for (let i = 0; i < 3; i++) await db.tx((q) => outbox.enqueue(q, { id, name: 'invoice.created', payload: { invoiceId: 'i1' } }));
      expect(await count(`SELECT count(*) n FROM outbox`)).toBe(1);
    });

    it('rejects a bad name or payload in the service AND in the database', async () => {
      await expect(db.tx((q) => outbox.enqueue(q, { name: 'PaymentSucceeded', payload: {} }))).rejects.toThrow('dotted lowercase');
      await expect(db.tx((q) => outbox.enqueue(q, { name: 'a.b', payload: [] as any }))).rejects.toThrow('must be an object');
      await expect(db.tx((q) => outbox.enqueue(q, { name: 'a.b', payload: { big: 'x'.repeat(70_000) } }))).rejects.toThrow('too large');
      // bypassing the service: the CHECK constraints still hold
      await expect(db.query(`INSERT INTO outbox(id, name, payload) VALUES (gen_random_uuid(), 'NoDots', '{}')`)).rejects.toThrow(/outbox_name_shape/);
      await expect(db.query(`INSERT INTO outbox(id, name, payload) VALUES (gen_random_uuid(), 'a.b', '[]')`)).rejects.toThrow(/outbox_payload_is_object/);
    });

    it('an event is immutable history: content cannot change and a published event cannot be un-published', async () => {
      await clear();
      const id = await db.tx((q) => outbox.enqueue(q, { name: 'invoice.paid', payload: { invoiceId: 'i9' } }));
      await expect(db.query(`UPDATE outbox SET payload = '{"invoiceId":"other"}' WHERE id = $1`, [id])).rejects.toThrow('immutable');
      await expect(db.query(`UPDATE outbox SET name = 'invoice.void' WHERE id = $1`, [id])).rejects.toThrow('immutable');
      await db.query(`UPDATE outbox SET "publishedAt" = now() WHERE id = $1`, [id]);
      await expect(db.query(`UPDATE outbox SET "publishedAt" = NULL WHERE id = $1`, [id])).rejects.toThrow('cannot be republished');
    });
  });

  describe('the relay publishes at least once and never blocks business work', () => {
    const seed = async (n: number) => {
      await clear();
      for (let i = 0; i < n; i++) await db.tx((q) => outbox.enqueue(q, { name: 'payment.succeeded', payload: { n: i } }));
    };

    it('publishes unsent events in order, stamps them, and republishes nothing', async () => {
      await seed(3);
      const bus = new InMemoryEventBus();
      const relay = new OutboxRelay(db, bus, { source: 'payment-service' });
      expect(await relay.drainOnce()).toEqual({ published: 3, failed: 0 });
      expect(bus.published.map((e) => e.payload.n)).toEqual([0, 1, 2]);
      expect(bus.published[0].headers).toMatchObject({ source: 'payment-service', version: 1, eventId: bus.published[0].id });
      expect(await relay.drainOnce()).toEqual({ published: 0, failed: 0 });
      expect(await count(`SELECT count(*) n FROM outbox WHERE "publishedAt" IS NULL`)).toBe(0);
    });

    it('a broker outage only delays delivery: backoff is recorded, later events are untouched, business writes keep working', async () => {
      await seed(3);
      const bus = new InMemoryEventBus();
      bus.failNextPublishes(1);
      const relay = new OutboxRelay(db, bus, { source: 'payment-service', baseBackoffMs: 60_000 });
      expect(await relay.drainOnce()).toEqual({ published: 0, failed: 1 });
      const rows = (await db.query(`SELECT attempts, "lastError", "availableAt" > now() AS backed_off FROM outbox ORDER BY "occurredAt", id`)).rows;
      expect(rows[0]).toMatchObject({ attempts: 1, backed_off: true });
      expect(rows[0].lastError).toContain('broker unavailable');
      expect(rows[1]).toMatchObject({ attempts: 0, backed_off: false }); // the rest of the batch was not burned
      await db.tx(async (q) => void (await q.query(`INSERT INTO business VALUES (900, 'still works during the outage')`))); // business unaffected
      expect(await relay.drainOnce()).toEqual({ published: 2, failed: 0 }); // the backed-off row waits, the others go
    });

    it('recovers after the backoff and eventually delivers everything', async () => {
      await seed(2);
      const bus = new InMemoryEventBus();
      bus.failNextPublishes(1);
      const relay = new OutboxRelay(db, bus, { source: 'payment-service', baseBackoffMs: 1 });
      await relay.drainOnce();
      await new Promise((r) => setTimeout(r, 20));
      expect(await relay.drainOnce()).toEqual({ published: 2, failed: 0 });
    });

    it('a row that fails repeatedly is retried, not skipped, but its own backoff excludes it from the next poll, so a healthy row behind it is never starved indefinitely (Stage 12.7 outbox-starvation review)', async () => {
      // A failing publish stops the WHOLE batch for that tick (by design, see OutboxRelay's doc comment) rather
      // than skipping ahead to later rows — but the failing row's own backoff removes it from the very next SELECT
      // once it elapses, so rows behind it are only ever delayed, bounded by how many times the row ahead of them
      // fails, never blocked indefinitely. n=0..2 simulate the SAME row failing three times in a row; n=3 is a
      // genuinely healthy row that must still be delivered once the row ahead of it stops failing.
      await seed(4);
      const bus = new InMemoryEventBus();
      bus.failNextPublishes(3);
      const relay = new OutboxRelay(db, bus, { source: 'payment-service', baseBackoffMs: 1 });
      for (let i = 0; i < 3; i++) {
        expect(await relay.drainOnce()).toEqual({ published: 0, failed: 1 }); // the earliest row fails again; nothing behind it is even attempted this tick
        await new Promise((r) => setTimeout(r, 20)); // well past baseBackoffMs=1: the failed row is excluded from the next SELECT once backed off
      }
      expect(await relay.drainOnce()).toEqual({ published: 4, failed: 0 }); // bounded: exactly 4 poll cycles total, never an indefinite block
      expect(bus.published.map((e) => e.payload.n)).toEqual([0, 1, 2, 3]);
    });

    it('two relays draining at once never publish the same event concurrently (SKIP LOCKED)', async () => {
      await seed(20);
      const bus = new InMemoryEventBus();
      const relays = [new OutboxRelay(db, bus, { source: 's', batchSize: 5 }), new OutboxRelay(db, bus, { source: 's', batchSize: 5 })];
      await Promise.all([relays[0].drainOnce(), relays[1].drainOnce()]);
      const ids = bus.published.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length); // no duplicates from concurrent claims
      expect(ids.length).toBe(10);
      while ((await relays[0].drainOnce()).published > 0) {
        /* drain the rest */
      }
      expect(new Set(bus.published.map((e) => e.id)).size).toBe(20);
    });

    it('start/stop polls in the background and stop waits for an in-flight batch', async () => {
      await seed(2);
      const bus = new InMemoryEventBus();
      const relay = new OutboxRelay(db, bus, { source: 's' });
      relay.start(10);
      await new Promise((r) => setTimeout(r, 200));
      await relay.stop();
      expect(bus.published).toHaveLength(2);
      const after = bus.published.length;
      await new Promise((r) => setTimeout(r, 50));
      expect(bus.published).toHaveLength(after); // stopped
    });
  });

  describe('the inbox makes consumers idempotent', () => {
    const event = (id: string): EventEnvelope => ({ id, name: 'payment.succeeded', payload: { paymentId: 'p1' }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
    const ID = '33333333-3333-4333-8333-333333333333';

    it('applies an event once; a redelivery is recognised and skipped', async () => {
      await db.query('DELETE FROM inbox');
      await db.query('CREATE TABLE IF NOT EXISTS effects(n int)');
      const apply = (q: any) => q.query('INSERT INTO effects VALUES (1)');
      expect(await inbox.handle(db, event(ID), apply)).toBe('processed');
      expect(await inbox.handle(db, event(ID), apply)).toBe('duplicate');
      expect(await count('SELECT count(*) n FROM effects')).toBe(1);
    });

    it('a failed effect leaves no inbox row, so the redelivery is processed again', async () => {
      const id = '44444444-4444-4444-8444-444444444444';
      await expect(inbox.handle(db, event(id), async () => { throw new Error('effect failed'); })).rejects.toThrow('effect failed');
      expect(await count(`SELECT count(*) n FROM inbox WHERE "eventId" = '${id}'`)).toBe(0);
      expect(await inbox.handle(db, event(id), async () => undefined)).toBe('processed');
    });

    it('eight simultaneous deliveries of the same event run the effect exactly once', async () => {
      const id = '55555555-5555-4555-8555-555555555555';
      await db.query('DELETE FROM effects');
      const results = await Promise.all(Array.from({ length: 8 }, () => inbox.handle(db, event(id), (q) => q.query('INSERT INTO effects VALUES (1)') as Promise<any>)));
      expect(results.filter((r) => r === 'processed')).toHaveLength(1);
      expect(results.filter((r) => r === 'duplicate')).toHaveLength(7);
      expect(await count('SELECT count(*) n FROM effects')).toBe(1);
    });
  });
});
