import { describe, expect, it } from 'vitest';
import { REEMISSION_APPROVALS, ReemissionRefused, reemissionPolicy } from '@nawara/service-kit';
import { parseDryRunArgs } from '../cli/reemission-dry-run.js';
import { EVENT_SOURCE, PRODUCED_EVENTS } from '../events/event-catalog.js';
import { CONFLICT_EVIDENCE_UNATTESTED, PAYMENT_REEMISSION_POLICY, UNESTABLISHED_PUBLICATION_EVIDENCE, inspectPaymentReemission } from './reemission-eligibility.js';

/** Core V2 S1c-3 R2a: Payment's inert re-emission preparation (the real-PostgreSQL half is test/reemission-dry-run.e2e-spec.ts). */
const EVENT_ID = '7d1c4f0a-2b3e-4c5d-8e6f-0a1b2c3d4e5f';
const db = (row?: Record<string, unknown>) => {
  const log: string[] = [];
  return {
    log,
    db: { tx: async <T>(fn: (q: never) => Promise<T>) => fn({ query: async (sql: string) => (log.push(sql.split(/\s+/)[0]!), { rows: sql.includes('FROM outbox') && row ? [row] : [], rowCount: 0 }) } as never) },
  };
};
const owned = { confirm: async () => true };
const published = (extra: Record<string, unknown> = {}) => ({
  id: EVENT_ID, name: 'payment.succeeded', payload: { paymentId: 'p' }, correlationId: null, eventVersion: 1,
  occurredAt: new Date('2026-10-23T08:00:00Z'), publishedAt: new Date('2026-10-23T08:00:01Z'), ...extra,
});

describe('Payment re-emission policy', () => {
  it('is exactly the four S0-C4 events at version 1, each a non-code-bearing version-1 event of the Payment catalog', () => {
    expect(PAYMENT_REEMISSION_POLICY).toStrictEqual({
      producer: 'payment-service',
      events: [{ name: 'payment.succeeded', version: 1 }, { name: 'payment.failed', version: 1 }, { name: 'payment.cancelled', version: 1 }, { name: 'payment.expired', version: 1 }],
    });
    expect(PAYMENT_REEMISSION_POLICY.producer).toBe(EVENT_SOURCE);
    expect(PAYMENT_REEMISSION_POLICY.events).toStrictEqual(REEMISSION_APPROVALS['payment-service']);
    const catalog: Record<string, { version: number; codeBearing?: true }> = PRODUCED_EVENTS;
    for (const e of PAYMENT_REEMISSION_POLICY.events) {
      expect(catalog[e.name]).toMatchObject({ version: 1 });
      expect(catalog[e.name]!.codeBearing).toBeUndefined();
    }
    expect(PAYMENT_REEMISSION_POLICY.events.map((e) => e.name)).not.toContain('payment.created'); // in the catalog, not approved
  });

  it('cannot be widened: another event, version or a pattern is refused by the foundation', () => {
    for (const extra of [{ name: 'payment.created', version: 1 }, { name: 'payment.succeeded', version: 2 }, { name: 'payment.*', version: 1 }, { name: 'audit.payment.created', version: 1 }]) {
      expect(() => reemissionPolicy('payment-service', [...PAYMENT_REEMISSION_POLICY.events, extra])).toThrow(ReemissionRefused);
    }
  });
});

describe('Payment dry-run inspection', () => {
  it('a published, allowed row is still never executable: no publication evidence, no conflict attestation', async () => {
    const d = db(published());
    const r = await inspectPaymentReemission({ db: d.db, ownership: owned }, { eventId: EVENT_ID, eventName: 'payment.succeeded' });
    expect(r).toStrictEqual({
      mode: 'dry_run', row: { rowEligible: false, reason: 'pipeline_unknown' }, conflictEvidence: CONFLICT_EVIDENCE_UNATTESTED, executable: false,
      blockers: ['owner_authorization_unavailable', 'conflict_evidence_unattested', 'publication_not_available'],
    });
    expect(await UNESTABLISHED_PUBLICATION_EVIDENCE.pipelineVersionOf({} as never, {} as never)).toBeUndefined();
    expect(d.log).toStrictEqual(['SET', 'SELECT']); // the read-only transaction and the row read: nothing else
  });

  it('even with row evidence a test supplies, the answer stays not executable', async () => {
    const r = await inspectPaymentReemission({ db: db(published()).db, ownership: owned, evidence: { pipelineVersionOf: async () => 1 } }, { eventId: EVENT_ID, eventName: 'payment.succeeded' });
    expect(r.row).toMatchObject({ rowEligible: true, eventId: EVENT_ID, pipelineVersion: 1 });
    expect(r.executable).toBe(false);
    expect(JSON.stringify(r)).not.toContain('paymentId');
  });

  it.each([
    ['an unknown event', { eventName: 'payment.created' }, 'event_not_allowed'],
    ['a pattern', { eventName: 'payment.*' }, 'request_invalid'],
    ['a code-bearing Auth event', { eventName: 'member.contact_verification_requested' }, 'code_bearing_event'],
    ['a payload', { payload: { paymentId: 'p' } }, 'request_invalid'],
    ['a source', { source: 'payment-service' }, 'request_invalid'],
  ])('refuses %s before reading anything', async (_t, extra, reason) => {
    const d = db(published());
    const r = await inspectPaymentReemission({ db: d.db, ownership: owned }, { eventId: EVENT_ID, eventName: 'payment.succeeded', ...extra });
    expect(r.row).toStrictEqual({ rowEligible: false, reason });
    expect(d.log).toStrictEqual([]);
  });

  it('a row of another version is refused', async () => {
    const r = await inspectPaymentReemission({ db: db(published({ eventVersion: 2 })).db, ownership: owned }, { eventId: EVENT_ID, eventName: 'payment.succeeded' });
    expect(r.row).toStrictEqual({ rowEligible: false, reason: 'version_not_allowed' });
  });
});

describe('dry-run arguments: an event id and an expected name, nothing else', () => {
  it('accepts exactly --event-id and --event-name', () => {
    expect(parseDryRunArgs(['--event-id', EVENT_ID, '--event-name', 'payment.failed'])).toStrictEqual({ eventId: EVENT_ID, eventName: 'payment.failed' });
  });
  it('refuses --apply explicitly, in every spelling', () => {
    for (const args of [['--apply'], ['--event-id', EVENT_ID, '--event-name', 'payment.failed', '--apply'], ['--apply=true', 'x']]) {
      expect(() => parseDryRunArgs(args)).toThrow('there is no --apply: this command only inspects (re-emission is not available)');
    }
  });
  it.each([['--payload'], ['--body'], ['--source'], ['--service'], ['--exchange'], ['--routing-key'], ['--user-id'], ['--approval-ref'], ['--execute'], ['--publish'], ['--url']])(
    'refuses %s without echoing its value', (flag) => {
      expect(() => parseDryRunArgs(['--event-id', EVENT_ID, '--event-name', 'payment.failed', flag, 'secret-value'])).toThrow(/^only --event-id <uuid> and --event-name <name> are accepted/);
      try {
        parseDryRunArgs([flag, 'secret-value']);
      } catch (e) {
        expect((e as Error).message).not.toContain('secret-value');
      }
    });
  it('refuses a missing, repeated or valueless flag', () => {
    for (const args of [[], ['--event-id', EVENT_ID], ['--event-id', EVENT_ID, '--event-id', EVENT_ID], ['--event-id', EVENT_ID, '--event-name']]) {
      expect(() => parseDryRunArgs(args)).toThrow('--event-id and --event-name are each required exactly once');
    }
  });
});
