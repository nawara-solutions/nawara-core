import { AuditEventWriter, AuditContractError, type AuditOutboxEvent, type AuditQueryable } from '../src/index.js';
import { SAMPLE_IDS, sampleAuditPayload } from '../src/testing.js';

/** Unit view of the producer helper with a recording fake; the real transaction semantics are proven against PostgreSQL (int-spec). */

class FakeTx implements AuditQueryable {
  readonly statements: string[] = [];
  constructor(private readonly inTransaction = true) {}
  async query(sql: string): Promise<unknown> {
    this.statements.push(sql);
    if (sql.startsWith('SAVEPOINT') && !this.inTransaction) throw Object.assign(new Error('SAVEPOINT can only be used in transaction blocks'), { code: '25P01' });
    return {};
  }
}

class FakeOutbox {
  readonly events: AuditOutboxEvent[] = [];
  async enqueue(tx: FakeTx, ev: AuditOutboxEvent): Promise<string> {
    tx.statements.push('INSERT INTO outbox');
    this.events.push(ev);
    return ev.id ?? '11111111-2222-4333-8444-555555555555';
  }
}

const writer = (sourceService = 'file-service', outbox = new FakeOutbox()) => ({ outbox, w: new AuditEventWriter<FakeTx>({ sourceService, outbox }) });

describe('AuditEventWriter', () => {
  it('writes one outbox event on the given transaction: audit.<action>, version 1, the canonical payload only', async () => {
    const { w, outbox } = writer('billing-service');
    const tx = new FakeTx();
    const input = sampleAuditPayload('subscription.renewed', 'complete');
    const r = await w.write(tx, input as never);
    expect(r).toEqual({ eventId: '11111111-2222-4333-8444-555555555555', eventType: 'audit.subscription.renewed' });
    expect(outbox.events).toEqual([{ name: 'audit.subscription.renewed', payload: input, version: 1 }]);
    expect(tx.statements).toEqual(['SAVEPOINT nawara_audit_intent', 'RELEASE SAVEPOINT nawara_audit_intent', 'INSERT INTO outbox']);
  });

  it('never opens, commits or rolls back a transaction itself', async () => {
    const { w } = writer();
    const tx = new FakeTx();
    await w.write(tx, sampleAuditPayload('file.deleted') as never);
    expect(tx.statements.filter((s) => /^(BEGIN|START|COMMIT|ROLLBACK|END)\b/i.test(s))).toEqual([]);
  });

  it('refuses a client outside a transaction block (transaction_required) before writing anything', async () => {
    const { w, outbox } = writer();
    await expect(w.write(new FakeTx(false), sampleAuditPayload('file.deleted') as never)).rejects.toThrow('transaction_required');
    expect(outbox.events).toEqual([]);
  });

  it('validates before touching the database: an invalid event performs no statement at all', async () => {
    const { w, outbox } = writer();
    const tx = new FakeTx();
    await expect(w.write(tx, { ...sampleAuditPayload('file.deleted'), note: 'x' } as never)).rejects.toThrow('unknown_field');
    expect(tx.statements).toEqual([]);
    expect(outbox.events).toEqual([]);
  });

  it('derives the source from its configuration: another service\'s action is refused, a sourceService field is refused', async () => {
    const { w } = writer('file-service');
    await expect(w.write(new FakeTx(), sampleAuditPayload('payment.created') as never)).rejects.toThrow('producer_not_admitted');
    await expect(w.write(new FakeTx(), { ...sampleAuditPayload('file.deleted'), sourceService: 'payment-service' } as never)).rejects.toThrow('unknown_field');
    expect(w.sourceService).toBe('file-service');
    expect(() => {
      (w as { sourceService: string }).sourceService = 'payment-service';
    }).toThrow(TypeError);
  });

  it('cannot be built for a service that owns no action, or with a malformed name', () => {
    for (const s of ['notification-service', 'billing', 'File-Service', '', 'x']) {
      expect(() => new AuditEventWriter({ sourceService: s, outbox: new FakeOutbox() })).toThrow(AuditContractError);
    }
  });

  it('passes a producer-chosen event id and correlation id through, validated', async () => {
    const { w, outbox } = writer();
    await w.write(new FakeTx(), sampleAuditPayload('file.deleted') as never, { eventId: SAMPLE_IDS.uuidA, correlationId: 'req-12345678' });
    expect(outbox.events[0]).toMatchObject({ id: SAMPLE_IDS.uuidA, correlationId: 'req-12345678' });
    await expect(w.write(new FakeTx(), sampleAuditPayload('file.deleted') as never, { eventId: 'nope' })).rejects.toThrow('invalid_envelope');
    await expect(w.write(new FakeTx(), sampleAuditPayload('file.deleted') as never, { correlationId: 'x' })).rejects.toThrow('invalid_correlation');
    await expect(
      w.write(new FakeTx(), { ...sampleAuditPayload('file.deleted'), causationId: SAMPLE_IDS.uuidA } as never, { eventId: SAMPLE_IDS.uuidA }),
    ).rejects.toThrow('invalid_causation');
  });

  it('propagates any other database error unchanged (never swallowed, never reported as a contract refusal)', async () => {
    const { w } = writer();
    const tx: FakeTx = Object.assign(new FakeTx(), {
      query: async () => {
        throw Object.assign(new Error('current transaction is aborted'), { code: '25P02' });
      },
    });
    await expect(w.write(tx, sampleAuditPayload('file.deleted') as never)).rejects.toMatchObject({ code: '25P02' });
  });

  it('is typed from the catalog: an unknown action or a foreign change key does not compile', () => {
    const { w } = writer();
    const tx = new FakeTx();
    // @ts-expect-error — not a cataloged action
    void w.write(tx, { action: 'file.renamed', actor: { type: 'service', id: 'x-service' }, organizationId: null, resource: { type: 'file', id: SAMPLE_IDS.resource }, outcome: 'succeeded' }).catch(() => undefined);
    // @ts-expect-error — file.deleted declares no changes
    void w.write(tx, { action: 'file.deleted', actor: { type: 'service', id: 'x-service' }, organizationId: null, resource: { type: 'file', id: SAMPLE_IDS.resource }, outcome: 'succeeded', changes: { storage_key: 'k' } }).catch(() => undefined);
    // @ts-expect-error — a wrong resource type for the action
    void w.write(tx, { action: 'file.deleted', actor: { type: 'service', id: 'x-service' }, organizationId: null, resource: { type: 'invoice', id: SAMPLE_IDS.resource }, outcome: 'succeeded' }).catch(() => undefined);
    // @ts-expect-error — file.deleted never has outcome denied
    void w.write(tx, { action: 'file.deleted', actor: { type: 'service', id: 'x-service' }, organizationId: null, resource: { type: 'file', id: SAMPLE_IDS.resource }, outcome: 'denied' }).catch(() => undefined);
    const ok = w.write(tx, { action: 'file.deleted', actor: { type: 'service', id: 'x-service' }, organizationId: null, resource: { type: 'file', id: SAMPLE_IDS.resource }, outcome: 'succeeded' });
    return expect(ok).resolves.toMatchObject({ eventType: 'audit.file.deleted' });
  });
});
