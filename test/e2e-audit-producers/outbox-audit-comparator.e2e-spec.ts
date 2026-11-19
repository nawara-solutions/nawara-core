import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { classify, compare, DEVELOPMENT_GRACE_MS, failures, type ComparisonInput } from './support/outbox-audit-comparator.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 G6-D (DO-69): the read-only outbox-to-Audit comparator (support/outbox-audit-comparator.ts). The pure classification needs nothing;
 * the second part runs it on real PostgreSQL 16 against the kit `outbox` schema and audit-service's own migrations. LABELLED FIXTURES: the
 * outbox and audit rows are placed directly (audit rows with triggers off) to stand for what the relay and Audit's ingestion would write.
 */
const T0 = new Date('2026-11-19T12:00:00.000Z');
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);
const base = (over: Partial<ComparisonInput> = {}): ComparisonInput => ({
  outbox: [], audit: [], now: minutes(30), graceMs: DEVELOPMENT_GRACE_MS, auditCutoffs: {}, deadLettered: new Set(), producerRetainedSince: null, ...over,
});

describe('G6-D comparator: classification (pure)', () => {
  const id = () => randomUUID();

  it('present, missing beyond grace, within grace and not eligible; a domain event is outside the comparison', () => {
    const [present, missing, recent, unpublished, domain] = [id(), id(), id(), id(), id()];
    const r = classify(base({
      outbox: [
        { id: present, name: 'audit.invoice.issued', occurredAt: minutes(0), publishedAt: minutes(0) },
        { id: missing, name: 'audit.invoice.issued', occurredAt: minutes(1), publishedAt: minutes(1) },
        { id: recent, name: 'audit.invoice.issued', occurredAt: minutes(27), publishedAt: minutes(27) }, // 3 minutes ago: inside 5
        { id: unpublished, name: 'audit.invoice.issued', occurredAt: minutes(2), publishedAt: null },
        { id: domain, name: 'invoice.created', occurredAt: minutes(2), publishedAt: minutes(2) },
      ],
      audit: [{ eventId: present, action: 'invoice.issued', occurredAt: minutes(0) }],
    }));
    expect(Object.fromEntries(r.map((x) => [x.eventId, x.class]))).toEqual({ [present]: 'present', [missing]: 'missing', [recent]: 'within_grace', [unpublished]: 'not_eligible' });
    expect(failures(r).map((x) => x.eventId)).toEqual([missing]);
  });

  it('dead-letter evidence and Audit retention explain an absence; a missing event inside retention is still a failure', () => {
    const [dead, retained, kept] = [id(), id(), id()];
    const r = classify(base({
      outbox: [
        { id: dead, name: 'audit.invoice.issued', occurredAt: minutes(0), publishedAt: minutes(0) },
        { id: retained, name: 'audit.membership.approved', occurredAt: minutes(0), publishedAt: minutes(0) }, // membership.approved: business
        { id: kept, name: 'audit.invoice.issued', occurredAt: minutes(0), publishedAt: minutes(0) }, // invoice.issued: commercial
      ],
      deadLettered: new Set([dead]),
      auditCutoffs: { business: minutes(5) }, // Audit's business retention reached minute 5; commercial was never applied
    }));
    expect(Object.fromEntries(r.map((x) => [x.eventId, x.class]))).toEqual({ [dead]: 'dead_lettered', [retained]: 'unverifiable', [kept]: 'missing' });
  });

  it('an Audit record of this source with no outbox row: orphan inside the producer\'s horizon, unverifiable outside it', () => {
    const [inside, outside] = [id(), id()];
    const audit = [{ eventId: inside, action: 'invoice.issued', occurredAt: minutes(10) }, { eventId: outside, action: 'invoice.issued', occurredAt: minutes(1) }];
    expect(classify(base({ audit, producerRetainedSince: minutes(5) })).map((x) => x.class)).toEqual(['orphan', 'unverifiable']);
    expect(classify(base({ audit, producerRetainedSince: null })).map((x) => x.class)).toEqual(['orphan', 'orphan']); // a producer that never deletes
  });

  it('a 5-minute delay is not decided: the boundary is "within grace" until the window has passed', () => {
    const e = id();
    const outbox = [{ id: e, name: 'audit.invoice.issued', occurredAt: minutes(0), publishedAt: minutes(25) }];
    expect(classify(base({ outbox, now: new Date(minutes(30).getTime() - 1) }))[0]!.class).toBe('within_grace');
    expect(classify(base({ outbox, now: minutes(30) }))[0]!.class).toBe('missing');
  });
});

describeWithEnv('G6-D comparator on real PostgreSQL (kit outbox + audit-service schema)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let producer: TestDatabase;
  let other: TestDatabase;
  let audit: TestDatabase;
  let auditPool: pg.Pool;
  const auditMigrations = fileURLToPath(new URL('../../apps/audit-service/db/migrations/', import.meta.url));

  beforeAll(async () => {
    producer = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'g6dproducer');
    other = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'g6dother');
    audit = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'g6daudit');
    await runMigrations(producer.url, [kitMigrationsDir]);
    await runMigrations(other.url, [kitMigrationsDir]);
    await runMigrations(audit.url, [kitMigrationsDir, auditMigrations]);
    auditPool = new pg.Pool({ connectionString: audit.url, max: 2 });
  });
  afterAll(async () => {
    await auditPool?.end();
    await producer?.drop();
    await other?.drop();
    await audit?.drop();
  });

  const outboxRow = (url: string, id: string, name: string, occurredAt: Date, publishedAt: Date | null) => {
    const c = new pg.Client({ connectionString: url });
    return c.connect().then(() => c.query(`INSERT INTO outbox (id, name, payload, "occurredAt", "availableAt", "publishedAt") VALUES ($1, $2, '{}'::jsonb, $3, $3, $4)`,
      [id, name, occurredAt, publishedAt])).finally(() => c.end());
  };
  const auditRow = async (eventId: string, source: string, action: string, category: string, occurredAt: Date) => {
    const c = await auditPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt")
        VALUES ($1, $2, $3, $4, 1, 'system', 'reconciliation_worker', 'invoice', $5, 'succeeded', $6)`, [eventId, source, action, category, randomUUID(), occurredAt]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };
  const snapshot = async () => {
    const c = new pg.Client({ connectionString: producer.url });
    await c.connect();
    try {
      return { producer: (await c.query(`SELECT * FROM outbox ORDER BY id`)).rows, audit: (await auditPool.query(`SELECT * FROM audit_record ORDER BY id`)).rows };
    } finally {
      await c.end();
    }
  };

  it('classifies one producer\'s rows against Audit, never reads another source\'s records, and writes nothing to either database', async () => {
    const now = new Date();
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    const [present, missing, recent, unpublished, foreign, orphan] = Array.from({ length: 6 }, () => randomUUID());
    await outboxRow(producer.url, present, 'audit.invoice.issued', ago(20), ago(20));
    await outboxRow(producer.url, missing, 'audit.invoice.issued', ago(20), ago(19));
    await outboxRow(producer.url, recent, 'audit.invoice.issued', ago(2), ago(1));
    await outboxRow(producer.url, unpublished, 'audit.invoice.issued', ago(10), null);
    await outboxRow(other.url, foreign, 'audit.invoice.issued', ago(20), ago(20)); // another producer's database
    await auditRow(present, 'billing-service', 'invoice.issued', 'commercial', ago(20));
    await auditRow(foreign, 'file-service', 'invoice.issued', 'commercial', ago(20)); // the same id under ANOTHER source: never matched
    await auditRow(orphan, 'billing-service', 'invoice.issued', 'commercial', ago(15));
    const before = await snapshot();
    const r = await compare({ producerDbUrl: producer.url, auditDbUrl: audit.url, source: 'billing-service', from: ago(60), to: now, now });
    expect(Object.fromEntries(r.map((x) => [x.eventId, x.class]))).toEqual({
      [present]: 'present', [missing]: 'missing', [recent]: 'within_grace', [unpublished]: 'not_eligible', [orphan]: 'orphan',
    });
    expect(r.some((x) => x.eventId === foreign)).toBe(false);
    expect(failures(r).map((x) => x.class).sort()).toEqual(['missing', 'orphan']);
    expect(JSON.stringify(r)).not.toMatch(/payload|changes|actor|organization/i); // identifiers, actions and classes only
    expect(await snapshot()).toEqual(before); // read only
    // Audit's own retention run explains the absence of a commercial record older than its cutoff
    await auditPool.query(`INSERT INTO audit_retention_run (category, "retainDays", cutoff, deleted) VALUES ('commercial', 1, $1, 1)`, [ago(5)]);
    const after = await compare({ producerDbUrl: producer.url, auditDbUrl: audit.url, source: 'billing-service', from: ago(60), to: now, now });
    expect(after.find((x) => x.eventId === missing)!.class).toBe('unverifiable');
  });
});
