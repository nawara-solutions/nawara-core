import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { InMemoryEventBus, OutboxRelay, OutboxService, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { validateAuditEvent } from '../src/consumer.js';
import { AUDIT_ACTIONS, AuditEventWriter } from '../src/index.js';
import { jsonbTextLength } from '../src/validate.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 18.4 §45–§47 against REAL PostgreSQL and the REAL kit outbox / relay (no RabbitMQ, no producer service): the helper's audit
 * intent commits and rolls back with the business write, lands as the canonical kit envelope, and survives the relay into exactly
 * what audit-service's validator accepts.
 */
describeWithEnv('audit producer helper on the kit outbox (PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const dbName = `audit_contract_it_${randomBytes(4).toString('hex')}`;
  let url: string;
  let pool: pg.Pool;
  const outbox = new OutboxService();
  const writer = new AuditEventWriter({ sourceService: 'file-service', outbox });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(env.TEST_DATABASE_ADMIN_URL!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    await runMigrations(url, [kitMigrationsDir]);
    pool = new pg.Pool({ connectionString: url, max: 4 });
    // A stand-in for a producer's business table (no real producer is modified in 18.4).
    await pool.query(`CREATE TABLE business_thing (id uuid PRIMARY KEY, state text NOT NULL)`);
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE outbox, business_thing');
  });

  const counts = async () => {
    const { rows } = await pool.query(`SELECT (SELECT count(*) FROM business_thing)::int AS business, (SELECT count(*) FROM outbox)::int AS audit`);
    return rows[0] as { business: number; audit: number };
  };

  async function inTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>, end: 'COMMIT' | 'ROLLBACK'): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query(end);
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const deletion = () => ({ ...sampleAuditPayload('file.deleted', 'complete'), resource: { type: 'file', id: SAMPLE_IDS.resource } }) as never;

  it('BEGIN · business write · audit helper · ROLLBACK → neither survives', async () => {
    await inTransaction(async (c) => {
      await c.query(`INSERT INTO business_thing VALUES ($1, 'deleting')`, [SAMPLE_IDS.resource]);
      await writer.write(c, deletion());
    }, 'ROLLBACK');
    expect(await counts()).toEqual({ business: 0, audit: 0 });
  });

  it('BEGIN · business write · audit helper · COMMIT → both survive', async () => {
    await inTransaction(async (c) => {
      await c.query(`INSERT INTO business_thing VALUES ($1, 'deleting')`, [SAMPLE_IDS.resource]);
      await writer.write(c, deletion());
    }, 'COMMIT');
    expect(await counts()).toEqual({ business: 1, audit: 1 });
  });

  it('a business failure AFTER the audit write rolls the audit intent back too', async () => {
    await expect(
      inTransaction(async (c) => {
        await writer.write(c, deletion());
        await c.query(`INSERT INTO business_thing VALUES ($1, NULL)`, [SAMPLE_IDS.resource]); // NOT NULL violation
      }, 'COMMIT'),
    ).rejects.toMatchObject({ code: '23502' });
    expect(await counts()).toEqual({ business: 0, audit: 0 });
  });

  it('an invalid audit event aborts nothing by itself but writes nothing, and the caller decides the transaction', async () => {
    await expect(
      inTransaction(async (c) => {
        await c.query(`INSERT INTO business_thing VALUES ($1, 'x')`, [SAMPLE_IDS.resource]);
        await writer.write(c, { ...sampleAuditPayload('file.deleted'), storage_key: 'k' } as never);
      }, 'COMMIT'),
    ).rejects.toThrow('sensitive_field');
    expect(await counts()).toEqual({ business: 0, audit: 0 });
  });

  it('a pool or an autocommit client is refused (transaction_required): the helper never runs outside the business transaction', async () => {
    await expect(writer.write(pool as never, deletion())).rejects.toThrow('transaction_required');
    const c = await pool.connect();
    try {
      await expect(writer.write(c, deletion())).rejects.toThrow('transaction_required');
    } finally {
      c.release();
    }
    expect(await counts()).toEqual({ business: 0, audit: 0 });
  });

  it('the outbox row is the canonical kit event: audit.<action>, version 1, canonical payload, the transaction time, the correlation', async () => {
    const { eventId, txNow } = await inTransaction(async (c) => {
      const { rows } = await c.query<{ now: Date }>('SELECT now()');
      const r = await writer.write(c, deletion(), { correlationId: 'req-corr-0042' });
      return { eventId: r.eventId, txNow: rows[0]!.now };
    }, 'COMMIT');
    const { rows } = await pool.query(`SELECT id, name, payload, "correlationId", "eventVersion", "occurredAt" FROM outbox`);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(eventId);
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(row.name).toBe('audit.file.deleted');
    expect(row.eventVersion).toBe(1);
    expect(row.correlationId).toBe('req-corr-0042');
    // occurredAt is the business transaction's own database time (now() is fixed for the whole transaction).
    expect(row.occurredAt.getTime()).toBe(txNow.getTime());
    expect(row.payload).toEqual(sampleAuditPayload('file.deleted', 'complete'));
    expect(Object.keys(row.payload).sort()).toEqual(['action', 'actor', 'causationId', 'organizationId', 'outcome', 'resource']);
    expect(JSON.stringify(row.payload)).not.toMatch(/sourceService|category|eventType|occurredAt|storage|ticket/);
  });

  it('a producer-chosen event id makes a retried business operation write the event once', async () => {
    for (let i = 0; i < 2; i++) {
      await inTransaction((c) => writer.write(c, deletion(), { eventId: SAMPLE_IDS.uuidA }), 'COMMIT');
    }
    const { rows } = await pool.query(`SELECT id FROM outbox`);
    expect(rows).toEqual([{ id: SAMPLE_IDS.uuidA }]);
  });

  it('the kit relay turns the row into an envelope that audit-service\'s validator accepts unchanged (no RabbitMQ involved)', async () => {
    const eventId = await inTransaction(async (c) => (await writer.write(c, deletion(), { correlationId: 'req-corr-0043' })).eventId, 'COMMIT');
    const bus = new InMemoryEventBus();
    const received: EventEnvelope[] = [];
    await bus.subscribe({ queue: 'audit-contract.it', bindings: ['audit.#'], handler: async (e) => void received.push(e) });
    const db = {
      tx: async <T>(fn: (q: pg.PoolClient) => Promise<T>) => inTransaction(fn, 'COMMIT'),
    };
    // The relay's source is the SAME configured service name the writer was built with (never a payload field).
    const relay = new OutboxRelay(db, bus, { source: 'file-service' });
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 0 });
    expect(received).toHaveLength(1);
    const v = validateAuditEvent(received[0]!);
    expect(v).toMatchObject({
      eventId,
      eventType: 'audit.file.deleted',
      sourceService: 'file-service',
      category: 'business',
      schemaVersion: 1,
      correlationId: 'req-corr-0043',
      payload: sampleAuditPayload('file.deleted', 'complete'),
    });
    // A relay configured as another service cannot carry this action past the validator.
    const forged = { ...received[0]!, headers: { ...received[0]!.headers, source: 'payment-service' } };
    expect(() => validateAuditEvent(forged)).toThrow('producer_not_admitted');
  });

  it('the contract\'s jsonb size model equals PostgreSQL\'s jsonb text length (the 1 024-byte bound of audit_changes_valid)', async () => {
    const samples: unknown[] = [
      { a: 1 },
      { flag: true, n: -9007199254740991 },
      { role: { from: 'member', to: 'org_admin' }, when: '2026-09-25T10:00:00.000Z' },
      Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`key_${i}_${'k'.repeat(24)}`, { from: 'x'.repeat(64), to: 'y'.repeat(64) }])),
      ...AUDIT_ACTIONS.map((a) => sampleAuditPayload(a, 'complete').changes).filter(Boolean),
    ];
    for (const s of samples) {
      const { rows } = await pool.query<{ n: number }>('SELECT octet_length(($1::jsonb)::text) AS n', [JSON.stringify(s)]);
      expect(jsonbTextLength(s)).toBe(rows[0]!.n);
    }
  });

  it('records the PostgreSQL server version used', async () => {
    const { rows } = await pool.query<{ server_version: string }>('SHOW server_version');
    console.log(`audit-contract integration: PostgreSQL ${rows[0]!.server_version}`);
    expect(Number(rows[0]!.server_version.split('.')[0])).toBeGreaterThanOrEqual(16);
  });
});
