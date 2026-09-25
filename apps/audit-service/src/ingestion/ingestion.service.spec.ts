import { AUDIT_CATALOG } from '@nawara/audit-contract';
import { SAMPLE_IDS, sampleAuditPayload } from '@nawara/audit-contract/testing';
import { PermanentEventFailure, type EventEnvelope } from '@nawara/service-kit';
import type { AuditRecordRepository } from '../persistence/audit-record.repository.js';
import type { AuditRecordRow, InsertOutcome, NewAuditRecord } from '../persistence/audit-record.types.js';
import { AuditPersistenceError } from '../persistence/persistence-error.js';
import { IngestionCounters, INGESTION_REFUSALS } from './ingestion-counters.js';
import { IngestionService } from './ingestion.service.js';

const ID = '7d5c3b1a-9e8f-4a6b-8c7d-2e1f0a9b8c01';

function envelope(over: { name?: string; payload?: Record<string, unknown>; headers?: Record<string, unknown> } = {}): EventEnvelope {
  return {
    id: ID,
    name: over.name ?? 'audit.membership.revoked',
    payload: over.payload ?? JSON.parse(JSON.stringify(sampleAuditPayload('membership.revoked', 'complete'))),
    headers: { eventId: ID, occurredAt: '2026-09-25T10:00:00.000Z', correlationId: 'corr-unit-0001', source: 'auth-service', version: 1, ...over.headers } as EventEnvelope['headers'],
  };
}

/** A repository double that stores in memory with the real semantics: first insert wins, a duplicate returns the stored row. */
class MemoryRepo {
  readonly rows = new Map<string, AuditRecordRow>();
  failNext?: unknown;
  async insertOnce(r: NewAuditRecord): Promise<InsertOutcome> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    const key = `${r.sourceService}|${r.eventId}`;
    const existing = this.rows.get(key);
    if (existing) return { kind: 'duplicate', existing };
    const row: AuditRecordRow = {
      id: String(this.rows.size + 1), eventId: r.eventId, sourceService: r.sourceService, action: r.action, category: r.category,
      schemaVersion: r.schemaVersion, actorType: r.actor.type, actorId: r.actor.id, userKind: r.actor.type === 'user' ? r.actor.userKind : null,
      organizationId: r.organizationId, resourceType: r.resource.type, resourceId: r.resource.id, subjectType: r.subject?.type ?? null,
      subjectId: r.subject?.id ?? null, outcome: r.outcome, changes: r.changes ?? null, correlationId: r.correlationId ?? null,
      causationId: r.causationId ?? null, occurredAt: new Date(r.occurredAt), recordedAt: new Date('2026-09-25T10:00:01.000Z'),
    };
    this.rows.set(key, row);
    return { kind: 'inserted', record: row };
  }
}

const make = () => {
  const repo = new MemoryRepo();
  const counters = new IngestionCounters();
  return { repo, counters, svc: new IngestionService(repo as unknown as AuditRecordRepository, counters) };
};
const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PermanentEventFailure ? `permanent:${e.reason}` : `transient:${(e as Error).message}`;
  }
  return 'ok';
};

describe('IngestionService (the pipeline and its classification)', () => {
  it('stores a valid event once, with the category from the catalog and the evidence as sent', async () => {
    const { repo, svc, counters } = make();
    expect(await svc.ingest(envelope())).toBe('persisted');
    const [row] = [...repo.rows.values()];
    expect(row).toMatchObject({ eventId: ID, sourceService: 'auth-service', action: 'membership.revoked', category: AUDIT_CATALOG.get('membership.revoked')!.category, correlationId: 'corr-unit-0001' });
    expect(counters.drain().counts).toMatchObject({ received: 1, persisted: 1, duplicate: 0, refused: 0 });
  });

  it('an exact duplicate is an idempotent success (no second row); a different evidence is a permanent `event_id_conflict`', async () => {
    const { repo, svc, counters } = make();
    await svc.ingest(envelope());
    expect(await svc.ingest(envelope())).toBe('duplicate');
    expect(repo.rows.size).toBe(1);
    const stored = { ...[...repo.rows.values()][0]! };
    for (const over of [{ headers: { correlationId: 'other-corr-0001' } }, { headers: { occurredAt: '2026-09-25T10:00:00.001Z' } }, { payload: { ...envelope().payload, organizationId: SAMPLE_IDS.uuidA } }]) {
      expect(await reasonOf(svc.ingest(envelope(over)))).toBe('permanent:event_id_conflict');
    }
    expect([...repo.rows.values()][0]).toEqual(stored);
    expect(counters.drain()).toMatchObject({ counts: { persisted: 1, duplicate: 1, refused: 3 }, refused: { event_id_conflict: 3 } });
  });

  it.each([
    ['unknown action', { name: 'audit.membership.promoted', payload: { ...envelope().payload, action: 'membership.promoted' } }, 'unknown_action'],
    ['producer not admitted', { headers: { source: 'billing-service' } }, 'producer_not_admitted'],
    ['unsupported version', { headers: { version: 2 } }, 'unsupported_version'],
    ['event type mismatch', { name: 'audit.membership.approved' }, 'event_type_mismatch'],
    ['category on the wire', { payload: { ...envelope().payload, category: 'commercial' } }, 'unknown_field'],
    ['recordedAt on the wire', { payload: { ...envelope().payload, recordedAt: '2020-01-01T00:00:00.000Z' } }, 'unknown_field'],
    ['sensitive field', { payload: { ...envelope().payload, token: 'x' } }, 'sensitive_field'],
    ['malformed occurredAt', { headers: { occurredAt: 'yesterday' } }, 'invalid_envelope'],
  ])('%s → permanent `%s`, nothing stored', async (_l, over, reason) => {
    const { repo, svc } = make();
    expect(await reasonOf(svc.ingest(envelope(over as never)))).toBe(`permanent:${reason}`);
    expect(repo.rows.size).toBe(0);
  });

  it('a record the schema refuses is permanent `invalid_record`; any other database error is transient and propagated unchanged (retried, never acknowledged)', async () => {
    const { repo, svc, counters } = make();
    repo.failNext = new AuditPersistenceError('invalid_record');
    expect(await reasonOf(svc.ingest(envelope()))).toBe('permanent:invalid_record');
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    repo.failNext = down;
    await expect(svc.ingest(envelope())).rejects.toBe(down);
    expect(repo.rows.size).toBe(0);
    expect(await svc.ingest(envelope())).toBe('persisted'); // the retry succeeds
    expect(counters.drain().counts).toMatchObject({ transient_failure: 1, persisted: 1 });
  });

  it('observes a future occurredAt (clock skew) without changing it; the lag is measured on the database clock', async () => {
    const { repo, svc, counters } = make();
    await svc.ingest(envelope({ headers: { occurredAt: '2026-09-25T11:00:00.000Z' } })); // one hour after the stub's recordedAt
    expect([...repo.rows.values()][0]!.occurredAt.toISOString()).toBe('2026-09-25T11:00:00.000Z');
    const s = counters.drain();
    expect(s.counts.clock_skew_future).toBe(1);
    expect(s.lag.maxMs).toBe(-3_599_000);
  });

  it('counts only closed labels: outcomes and the refusal reasons (never an id, action or source)', () => {
    expect(INGESTION_REFUSALS).toEqual(expect.arrayContaining(['event_id_conflict', 'invalid_record', 'unknown_action', 'producer_not_admitted']));
    for (const r of INGESTION_REFUSALS) expect(r).toMatch(/^[a-z][a-z0-9_]{0,63}$/); // the kit's dead-letter reason grammar
  });

  it('tracks in-flight deliveries (released on every outcome)', async () => {
    const { svc, counters } = make();
    await svc.ingest(envelope());
    await reasonOf(svc.ingest(envelope({ headers: { version: 9 } })));
    expect(counters.inFlight).toBe(0);
  });
});
