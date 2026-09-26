import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, OutboxService } from '@nawara/service-kit';
import { DOMAIN_EVENTS } from '../src/common/ports.js';
import { CodeEventPurge } from '../src/events/code-event-purge.js';
import { CODE_BEARING_EVENTS, OutboxDomainEvents } from '../src/events/domain-events.js';
import { OperatorCodeService } from '../src/operator/operator-code.service.js';
import { UsersService } from '../src/users/users.service.js';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 21.C.2 (ADR-0052 decisions 4 and 5; C3, Q3, Q4): Auth's domain events through its transactional outbox, on real PostgreSQL, with
 * the service's REAL writer and relay (the relay publishes to an in-memory bus here; the real-broker suites prove the broker legs).
 *
 *   BEGIN  domain change + outbox row  COMMIT  ->  relay  ->  bus        (rolled back: no row, no event)
 */
const outboxRows = (t: TestCtx, name: string) =>
  t.db.query<{ id: string; payload: Record<string, unknown>; publishedAt: Date | null; correlationId: string | null; eventVersion: number }>(
    `SELECT id, payload, "publishedAt", "correlationId", "eventVersion" FROM outbox WHERE name = $1 ORDER BY "occurredAt"`, [name]).then((r) => r.rows);
const uniq = () => randomUUID().slice(0, 8);
const logsOf = (t: TestCtx) => [...t.logger.lines, ...t.jsonLogs.map((l) => JSON.stringify(l))].join('\n');

describe('Auth domain events through the transactional outbox (AUTH_EVENTS on)', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;
  let companyId: string;

  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({}, { realEvents: {}, auditBus: bus });
    companyId = await t.newCompany();
  });
  afterAll(async () => t?.close());

  it('the real writer is wired (not a recording double), and AUTH_EVENTS is on', () => {
    expect(t.app.get(DOMAIN_EVENTS)).toBeInstanceOf(OutboxDomainEvents);
    expect(t.cfg.events).toEqual({ enabled: true });
  });

  it('an operator code: ONE row written with the request\'s transaction, then relayed with the row id as the event id and the payload unchanged', async () => {
    const email = `op${uniq()}@leak-probe.test`;
    const corr = `corr-${uniq()}`;
    await t.operator(companyId, email);
    await t.http.post('/auth/admin/login/operator/request-code').set('x-correlation-id', corr).send({ email }).expect(204);
    const [row] = (await outboxRows(t, 'admin.operator_code_issued')).filter((r) => r.payload.destination === email);
    expect(row).toBeDefined();
    expect(row!.correlationId).toBe(corr);
    expect(row!.eventVersion).toBe(1);
    // Field set unchanged (jsonb stores the object; its KEY ORDER is PostgreSQL's, which JSON consumers never rely on).
    expect(Object.keys(row!.payload).sort()).toEqual(['channel', 'code', 'destination', 'expiresAt', 'timestamp', 'userId']);
    await vi.waitFor(() => expect(bus.published.find((e) => e.id === row!.id)).toBeDefined(), { timeout: 10_000, interval: 50 });
    const env = bus.published.find((e) => e.id === row!.id)!;
    expect(env).toMatchObject({ name: 'admin.operator_code_issued', headers: { eventId: row!.id, source: 'auth-service', version: 1, correlationId: corr } });
    expect(env.payload).toStrictEqual(row!.payload);
    // the code in the event is the code Auth will accept (and it is stored only hashed in its own table)
    const code = String(row!.payload.code);
    const hashed = await t.db.query(`SELECT 1 FROM admin_operator_code WHERE "codeHash" = $1`, [code]);
    expect(hashed.rowCount).toBe(0);
    await t.http.post('/auth/admin/login/operator/verify-code').send({ email, code }).expect(200);
  });

  it('registration through a join code writes user.registered and membership.requested in the SAME transaction', async () => {
    const w = await t.world();
    const jc = await t.joinCode(w.orgDrive, { requiresApproval: true });
    const email = `m${uniq()}@x.test`;
    await t.http.post('/auth/register').send({ email, password: 'member password 1', joinCode: jc.code }).expect(201);
    const userId = (await t.db.query(`SELECT id FROM "user" WHERE email = $1`, [email])).rows[0].id;
    expect((await outboxRows(t, 'user.registered')).filter((r) => r.payload.userId === userId)).toHaveLength(1);
    expect((await outboxRows(t, 'membership.requested')).filter((r) => r.payload.userId === userId)).toHaveLength(1);
  });

  it('a rolled-back transaction leaves NO event: the operator confirmation code can no longer escape before its commit', async () => {
    const op = await t.operator(companyId, `op${uniq()}@x.test`, false);
    const row = (await t.app.get(UsersService).findById(op.id))!;
    const before = (await outboxRows(t, 'admin.operator_confirmation_code_issued')).length;
    await expect(t.dbs.tx(async (q) => {
      await t.app.get(OperatorCodeService).issueConfirmation(q, row);
      throw new Error('the operator creation fails after the code was issued');
    })).rejects.toThrow(/fails after/);
    expect((await outboxRows(t, 'admin.operator_confirmation_code_issued')).length).toBe(before);
    await new Promise((r) => setTimeout(r, 1500)); // a relay pass
    expect(bus.published.some((e) => e.name === 'admin.operator_confirmation_code_issued' && e.payload.userId === op.id)).toBe(false);
  });

  it('a broker outage never fails the Auth request: the row stays pending, is retried, and is delivered once the broker is back (same id)', async () => {
    const email = `op${uniq()}@x.test`;
    await t.operator(companyId, email);
    bus.failNextPublishes(1_000_000);
    const t0 = Date.now();
    await t.http.post('/auth/admin/login/operator/request-code').send({ email }).expect(204);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const [row] = (await outboxRows(t, 'admin.operator_code_issued')).filter((r) => r.payload.destination === email);
    await vi.waitFor(async () => {
      const { rows } = await t.db.query(`SELECT attempts, "publishedAt", "lastError" FROM outbox WHERE id = $1`, [row!.id]);
      expect(rows[0].attempts).toBeGreaterThan(0);
      expect(rows[0].publishedAt).toBeNull();
      expect(rows[0].lastError).not.toContain(String(row!.payload.code));
    }, { timeout: 10_000, interval: 100 });
    expect(logsOf(t)).toContain(`outbox_publish_failure eventId=${row!.id} name=admin.operator_code_issued`);
    bus.failNextPublishes(0);
    await vi.waitFor(() => expect(bus.published.filter((e) => e.id === row!.id)).toHaveLength(1), { timeout: 30_000, interval: 100 });
  }, 60_000);

  it('the purge deletes a code row once PUBLISHED and an unpublished one once EXPIRED; never an unexpired pending one, never another event or audit evidence', async () => {
    const outbox = t.app.get(OutboxService);
    const purge = t.app.get(CodeEventPurge);
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ids = await t.dbs.tx(async (q) => ({
      publishedCode: await outbox.enqueue(q, { name: 'member.contact_verification_requested', payload: { code: '111111', expiresAt: future } }),
      expiredCode: await outbox.enqueue(q, { name: 'admin.operator_code_issued', payload: { code: '222222', expiresAt: past } }),
      pendingCode: await outbox.enqueue(q, { name: 'admin.operator_confirmation_code_issued', payload: { code: '333333', expiresAt: future } }),
      publishedOther: await outbox.enqueue(q, { name: 'membership.approved', payload: { userId: 'u' } }),
      expiredLookingOther: await outbox.enqueue(q, { name: 'admin.owner_recovery_requested', payload: { expiresAt: past } }),
      audit: await outbox.enqueue(q, { name: 'audit.operator.created', payload: { code: 'not-a-secret', expiresAt: past } }),
    }));
    bus.failNextPublishes(1_000_000); // hold the relay so the test decides what is published
    await t.db.query(`UPDATE outbox SET "publishedAt" = now() WHERE id = ANY($1)`, [[ids.publishedCode, ids.publishedOther, ids.audit]]);
    await purge.pass();
    const left = new Set((await t.db.query(`SELECT id FROM outbox WHERE id = ANY($1)`, [Object.values(ids)])).rows.map((r) => r.id));
    expect(left.has(ids.publishedCode)).toBe(false);
    expect(left.has(ids.expiredCode)).toBe(false);
    expect(left.has(ids.pendingCode)).toBe(true);
    expect(left.has(ids.publishedOther)).toBe(true);
    expect(left.has(ids.expiredLookingOther)).toBe(true);
    expect(left.has(ids.audit)).toBe(true);
    bus.failNextPublishes(0);
    expect(logsOf(t)).toMatch(/auth_code_event_purge deleted=\d+ published=\d+ expired=\d+/);
  });

  it('the purge skips a row another transaction holds (the relay claiming it), and is bounded per statement', async () => {
    const outbox = t.app.get(OutboxService);
    const purge = t.app.get(CodeEventPurge);
    const past = new Date(Date.now() - 60_000).toISOString();
    const id = await t.dbs.tx((q) => outbox.enqueue(q, { name: 'admin.operator_code_issued', payload: { code: '444444', expiresAt: past } }));
    const holder = await t.db.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM outbox WHERE id = $1 FOR UPDATE`, [id]);
      await purge.pass(); // must not wait for, nor delete, the held row
      expect((await t.db.query(`SELECT 1 FROM outbox WHERE id = $1`, [id])).rowCount).toBe(1);
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    await purge.pass();
    expect((await t.db.query(`SELECT 1 FROM outbox WHERE id = $1`, [id])).rowCount).toBe(0);
    // a backlog larger than one batch is drained over bounded statements, never in one unbounded delete
    await t.dbs.tx(async (q) => {
      for (let i = 0; i < 450; i++) await outbox.enqueue(q, { name: 'admin.operator_code_issued', payload: { code: '555555', expiresAt: past } });
    });
    const spy = vi.spyOn(purge, 'purgeBatch');
    await purge.pass();
    expect(spy.mock.calls.length).toBe(3); // 200 + 200 + 50
    spy.mockRestore();
  });

  it('the purge uses the 0011 partial index, not a scan of the whole outbox (the proof the migration is needed)', async () => {
    await t.db.query(`INSERT INTO outbox(id, name, payload, "publishedAt") SELECT gen_random_uuid(), 'audit.bulk.row', '{}'::jsonb, now() FROM generate_series(1, 20000)`);
    await t.db.query('ANALYZE outbox');
    const names = CODE_BEARING_EVENTS.map((n) => `'${n}'`).join(', ');
    const plan = JSON.stringify((await t.db.query(`EXPLAIN (FORMAT JSON) SELECT id FROM outbox WHERE name IN (${names}) AND ("publishedAt" IS NOT NULL OR (payload->>'expiresAt')::timestamptz <= now()) ORDER BY "occurredAt" LIMIT 200 FOR UPDATE SKIP LOCKED`)).rows[0]);
    expect(plan).toContain('outbox_code_event_purge_idx');
    expect(plan).not.toContain('Seq Scan');
  });

  it('no one-time code reaches a log line or Audit evidence', async () => {
    const codes = (await outboxRows(t, 'admin.operator_code_issued')).map((r) => String(r.payload.code)).filter((c) => /^\d{6,}$/.test(c));
    const published = bus.published.filter((e) => (CODE_BEARING_EVENTS as readonly string[]).includes(e.name)).map((e) => String(e.payload.code));
    const all = [...new Set([...codes, ...published])].filter((c) => /^\d{6,}$/.test(c) && !['111111', '222222', '333333', '444444', '555555'].includes(c));
    expect(all.length).toBeGreaterThan(0);
    const l = logsOf(t);
    const audit = JSON.stringify((await t.db.query(`SELECT payload FROM outbox WHERE name LIKE 'audit.%'`)).rows) + JSON.stringify((await t.db.query(`SELECT * FROM auth_audit_event`)).rows);
    for (const c of all) {
      expect(l).not.toContain(c);
      expect(audit).not.toContain(c);
    }
  });
});

describe('AUTH_EVENTS=off: no domain-event row is written; committed rows are still relayed (Q4)', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;

  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({ AUTH_EVENTS: 'off' }, { realEvents: {}, auditBus: bus });
  });
  afterAll(async () => t?.close());

  it('an operator code request writes no domain event, while its audit evidence is still written', async () => {
    expect(t.cfg.events.enabled).toBe(false);
    const companyId = await t.newCompany();
    const email = `op${uniq()}@x.test`;
    await t.operator(companyId, email);
    await t.http.post('/auth/admin/login/operator/request-code').send({ email }).expect(204);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).rows[0].n).toBe(0);
    expect(logsOf(t)).toContain('auth_domain_events enabled=false');
  });

  it('a row committed while events were on is relayed anyway (the flag never holds back committed intent), exactly once', async () => {
    const id = await t.dbs.tx((q) => t.app.get(OutboxService).enqueue(q, { name: 'membership.revoked', payload: { userId: 'written-while-on' } }));
    await vi.waitFor(() => expect(bus.published.filter((e) => e.id === id)).toHaveLength(1), { timeout: 10_000, interval: 50 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(bus.published.filter((e) => e.id === id)).toHaveLength(1);
  });
});
