import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryEventBus, OutboxRelayService } from '@nawara/service-kit';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { AuditService } from '../src/audit/audit.service.js';
import { AUTH_SERVICE_NAME, CentralAudit } from '../src/audit/central-audit.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 18.7.5: Auth's outbox foundation on a REAL PostgreSQL (migration 0010) with the REAL kit relay: the central audit intent is
 * written in the caller's transaction, beside the local `auth_audit_event` row, and relayed durably; nothing depends on AUTH_EVENTS
 * (off in every test app). The catalog actions themselves are wired in 18.7.6.
 */
describe('Auth audit outbox foundation (real PostgreSQL, the kit relay)', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;
  let audit: CentralAudit;
  let local: AuditService;
  const input = () => sampleAuditPayload('operator.created') as never;
  const outbox = () => t.db.query(`SELECT id, name, payload, "publishedAt", attempts, "lastError" FROM outbox ORDER BY "occurredAt", id`).then((r) => r.rows);
  const until = async (cond: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 100; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };

  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({}, { auditBus: bus });
    audit = t.app.get(CentralAudit);
    local = t.app.get(AuditService);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('the relay is the kit\'s, on Auth\'s own pool, with AUTH_EVENTS off', () => {
    expect(t.cfg.events.enabled).toBe(false);
    expect(t.app.get(OutboxRelayService)).toBeInstanceOf(OutboxRelayService);
  });

  it('commits with the transaction, next to the local auth_audit_event row, and is relayed with source auth-service', async () => {
    await t.dbs.tx(async (q) => {
      await local.record({ type: 'operator.created', outcome: 'success', ip: '203.0.113.9' }, q);
      await audit.write(q, input(), { correlationId: 'auth-outbox-corr-01' });
    });
    const [row] = await outbox();
    expect(row).toMatchObject({ name: 'audit.operator.created' });
    expect(JSON.stringify(row.payload)).not.toContain('203.0.113.9'); // the local row keeps the IP; the central copy never carries one
    await until(async () => bus.published.some((e) => e.id === row.id), 'relayed');
    const env = bus.published.find((e) => e.id === row.id)!;
    expect(env).toMatchObject({ name: 'audit.operator.created', headers: { source: AUTH_SERVICE_NAME, correlationId: 'auth-outbox-corr-01', version: 1 } });
    await until(async () => (await outbox())[0].publishedAt !== null, 'marked published'); // marked in the relay's transaction, after the confirm
  });

  it('rolls back with the transaction: neither the local row nor the central intent survives a failed change', async () => {
    const before = (await outbox()).length;
    const localBefore = (await t.db.query(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type = 'account.disabled'`)).rows[0].n;
    await expect(t.dbs.tx(async (q) => {
      await local.record({ type: 'account.disabled', outcome: 'success' }, q);
      await audit.write(q, sampleAuditPayload('account.disabled') as never);
      throw new Error('the Auth change failed after its evidence was written');
    })).rejects.toThrow('the Auth change failed');
    expect((await outbox()).length).toBe(before);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type = 'account.disabled'`)).rows[0].n).toBe(localBefore);
  });

  it('refuses outside a transaction, and a contract refusal fails the whole transaction', async () => {
    await expect(audit.write(t.dbs, input())).rejects.toMatchObject({ code: 'transaction_required' });
    const before = (await outbox()).length;
    await expect(t.dbs.tx(async (q) => {
      await local.record({ type: 'operator.created', outcome: 'success' }, q);
      await audit.write(q, { ...sampleAuditPayload('operator.created'), organizationId: 'NOT-A-UUID' } as never);
    })).rejects.toMatchObject({ code: 'invalid_organization' });
    expect((await outbox()).length).toBe(before);
  });

  it('a broker outage never touches the transaction: the row waits, the relay retries with backoff and publishes it once', async () => {
    bus.failNextPublishes(2);
    await t.dbs.tx((q) => audit.write(q, sampleAuditPayload('platform_assignment.granted') as never));
    const id = (await outbox()).find((r) => r.name === 'audit.platform_assignment.granted')!.id;
    await until(async () => bus.published.some((e) => e.id === id), 'published after the outage');
    await until(async () => (await outbox()).find((r) => r.id === id)!.publishedAt !== null, 'marked published');
    const row = (await outbox()).find((r) => r.id === id)!;
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(row.publishedAt).not.toBeNull();
    expect(bus.published.filter((e) => e.id === id)).toHaveLength(1);
  });

  it('an explicit event id is written once (a retried change never duplicates its evidence)', async () => {
    const eventId = '0a0a0a0a-0000-4000-8000-00000000a105';
    for (let i = 0; i < 2; i++) await t.dbs.tx((q) => audit.write(q, input(), { eventId }));
    expect((await outbox()).filter((r) => r.id === eventId)).toHaveLength(1);
  });
});

describe('Auth audit relay at shutdown', () => {
  it('drains before the pool closes: a row written just before close is published or left intact for the next start, never failed by a closed pool', async () => {
    const bus = new InMemoryEventBus();
    const t = await createTestApp({}, { auditBus: bus });
    const probe = new (await import('pg')).default.Pool({ connectionString: t.env.DATABASE_URL, max: 1 });
    await t.dbs.tx((q) => t.app.get(CentralAudit).write(q, sampleAuditPayload('owner.password_changed') as never));
    await t.app.close();
    const { rows } = await probe.query(`SELECT "publishedAt", "lastError" FROM outbox WHERE name = 'audit.owner.password_changed'`);
    await probe.end();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastError).toBeNull(); // never a pool / broker error recorded by a relay racing the shutdown
    expect(t.logger.lines.join('\n')).not.toMatch(/outbox_relay_pass_failure|Cannot use a pool after calling end/);
    await t.close().catch(() => undefined); // drops the database (the app is already closed)
  });
});
