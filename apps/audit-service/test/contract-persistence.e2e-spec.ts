import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { AUDIT_ACTIONS, AUDIT_CATALOG, type AuditAction } from '@nawara/audit-contract';
import { validateAuditEvent } from '@nawara/audit-contract/consumer';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { auditMigrationsDir } from '../src/app.module.js';
import { toNewAuditRecord } from '../src/persistence/audit-record.mapper.js';
import { AuditRecordRepository, sameEvidence } from '../src/persistence/audit-record.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.4 §43–§44: the 18.4 contract against the FROZEN 18.3 table on real PostgreSQL. For every cataloged action (minimal and
 * complete payload): relay-shaped envelope → the shared validator → the one mapping → `insertOnce` as the RUNTIME role → the stored row
 * equals what was sent. Any drift between the contract's grammars and the table's CHECKs fails here, per action.
 */
describeWithEnv('audit contract → audit_record compatibility (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let repo: AuditRecordRepository;

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'acp');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl });
    repo = t.app.get(AuditRecordRepository);
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  const envelope = (action: AuditAction, variant: 'minimal' | 'complete', occurredAt: string) => {
    const id = randomUUID();
    return {
      id,
      name: `audit.${action}`,
      payload: JSON.parse(JSON.stringify(sampleAuditPayload(action, variant))),
      headers: { eventId: id, occurredAt, correlationId: variant === 'complete' ? `corr-${id.slice(0, 8)}` : undefined, source: AUDIT_CATALOG.get(action)!.producer, version: 1 },
    };
  };

  const cases = AUDIT_ACTIONS.flatMap((a) => [[a, 'minimal'], [a, 'complete']] as const);

  it.each(cases)('%s (%s): validate → map → insert succeeds and round-trips unchanged', async (action, variant) => {
    const occurredAt = variant === 'minimal' ? '2026-09-25T10:00:00.123Z' : '2019-01-01T00:00:00.000Z'; // a far-past time is stored as sent
    const v = validateAuditEvent(envelope(action, variant, occurredAt));
    const record = toNewAuditRecord(v);
    const out = await repo.insertOnce(record);
    expect(out.kind).toBe('inserted');
    if (out.kind !== 'inserted') return;
    const row = out.record;
    const p = v.payload;
    expect(row.eventId).toBe(v.eventId);
    expect(row.sourceService).toBe(v.sourceService);
    expect(row.action).toBe(action);
    expect(row.category).toBe(AUDIT_CATALOG.get(action)!.category);
    expect(row.schemaVersion).toBe(1);
    expect(row.actorType).toBe(p.actor.type);
    expect(row.actorId).toBe(p.actor.id);
    expect(row.userKind).toBe(p.actor.type === 'user' ? p.actor.userKind : null);
    expect(row.organizationId).toBe(p.organizationId);
    expect([row.resourceType, row.resourceId]).toEqual([p.resource.type, p.resource.id]);
    expect([row.subjectType, row.subjectId]).toEqual([p.subject?.type ?? null, p.subject?.id ?? null]);
    expect(row.outcome).toBe(p.outcome);
    expect(row.changes).toEqual(p.changes ?? null);
    expect(row.correlationId).toBe(v.correlationId);
    expect(row.causationId).toBe(p.causationId ?? null);
    expect(row.occurredAt.toISOString()).toBe(occurredAt);
    expect(row.recordedAt.getTime()).toBeGreaterThan(row.occurredAt.getTime()); // Audit's own clock, never the producer's
    // A redelivery of the same event is a no-op returning the stored evidence, which equals the candidate exactly.
    const again = await repo.insertOnce(record);
    expect(again.kind).toBe('duplicate');
    if (again.kind === 'duplicate') expect(sameEvidence(again.existing, record)).toBe(true);
  });

  it('stored every case exactly once', async () => {
    const n = await sql<{ n: string }>(d.adminUrl, 'SELECT count(*) AS n FROM audit_record');
    expect(Number(n[0]!.n)).toBe(cases.length);
  });

  it('records the PostgreSQL version', async () => {
    const v = await sql<{ server_version: string }>(d.adminUrl, 'SHOW server_version');
    console.log(`audit contract persistence compatibility: PostgreSQL ${v[0]!.server_version}`);
    expect(v[0]!.server_version.startsWith('16.')).toBe(true);
  });
});
