import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DbService, OutboxService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { PaymentAudit } from '../src/audit/payment-audit.js';
import { deterministicEventId } from '../src/events/deterministic-id.js';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/**
 * Stage 18.7.1: Payment's central audit intent on real PostgreSQL 16. `payment.created`, `payment.cancelled` and `payment.expired` are
 * written by `AuditEventWriter` into the kit outbox ON THE TRANSITION'S TRANSACTION, and so are `payment.succeeded` / `payment.failed` (catalog
 * correction G1: a verified user's sync and the attempt resolver settle payments too).
 */
describeWithEnv('Payment central audit intent (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const body = (over: Record<string, unknown> = {}) => {
    const organizationId = crypto.randomUUID();
    return {
      paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv-SECRET-SOURCE', payer: { type: 'user', id: '7a7a7a7a-0000-4000-8000-000000000077' },
      seller: { type: 'organization', id: organizationId }, organizationId, amount: 4242, currency: 'TND', description: 'DESC-NOT-IN-AUDIT', reference: 'REF-NOT-IN-AUDIT', ...over,
    };
  };
  const create = (b: Record<string, unknown>) => request(t.app.getHttpServer()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(b);
  const cancel = (id: string, key: string) => request(t.app.getHttpServer()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key);
  const q = <T = Record<string, any>>(sql: string, params: unknown[] = []) => t.app.get(DbService).query<T & Record<string, any>>(sql, params).then((r) => r.rows);
  const auditRows = (paymentId: string) => q(`SELECT id, name, payload, "correlationId", "eventVersion" FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY name`, [paymentId]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentaudit');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' }, authClient: { getIdentity: async (bearer: string) => identities[bearer] ?? null, hasPlatformAccess: async () => false },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  it('payment.created: the business row, its domain event and ONE canonical audit event commit together; identifiers only', async () => {
    const b = body();
    const r = await create(b).set('x-correlation-id', 'corr-payment-created-1').expect(201);
    const rows = await auditRows(r.body.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: deterministicEventId(r.body.id, 'audit.payment.created'), name: 'audit.payment.created', eventVersion: 1, correlationId: 'corr-payment-created-1' });
    expect(rows[0]!.payload).toEqual({
      action: 'payment.created', actor: { type: 'service', id: 'billing-service' }, organizationId: b.organizationId,
      resource: { type: 'payment', id: r.body.id }, outcome: 'succeeded',
    });
    expect((await q(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.created' AND payload->>'paymentId' = $1`, [r.body.id]))[0]!.n).toBe(1);
    // Privacy: nothing but identifiers (no amount, currency, parties, source, description, reference, provider data).
    const text = JSON.stringify(rows[0]!.payload);
    for (const s of ['4242', 'TND', '7a7a7a7a-0000-4000-8000-000000000077', 'inv-SECRET-SOURCE', 'DESC-NOT-IN-AUDIT', 'REF-NOT-IN-AUDIT', 'amount', 'currency', 'payer', 'seller', 'description', 'reference']) expect(text).not.toContain(s);
    expect(text.length).toBeLessThan(400);
  });

  it('ORGANIZATION is the payment row\'s: a request naming another organization than its seller is refused, and nothing is written', async () => {
    const b = body({ organizationId: crypto.randomUUID() }); // seller organization A, organizationId B
    await create(b).expect(400);
    expect(await q(`SELECT 1 FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM outbox WHERE name LIKE 'audit.%' AND payload->>'organizationId' = $1`, [b.organizationId])).toHaveLength(0);
  });

  it('ACTOR is the authenticated caller: headers and correlation ids cannot change it; unknown body fields are refused', async () => {
    const r = await create(body()).set('x-actor-id', '2f1b8d6c-4e3a-4b7c-8d9e-8f7a6b5c4d32').set('x-caller-service', 'auth-service').set('x-correlation-id', 'user-owner-impersonation').expect(201);
    expect((await auditRows(r.body.id))[0]!.payload.actor).toEqual({ type: 'service', id: 'billing-service' });
    await create({ ...body(), actor: { type: 'user', id: crypto.randomUUID() } }).expect(400);
  });

  it('payment.cancelled once per effective cancellation (an idempotent replay writes nothing more; a refused cancel writes nothing)', async () => {
    const r = await create(body()).expect(201);
    await cancel(r.body.id, 'cancel-key-audit-1').expect(200);
    await cancel(r.body.id, 'cancel-key-audit-1').expect(200); // replay
    await cancel(r.body.id, 'cancel-key-audit-2').expect(409); // already cancelled: a business refusal, no evidence
    const rows = await auditRows(r.body.id);
    expect(rows.map((x) => x.name)).toEqual(['audit.payment.cancelled', 'audit.payment.created']);
    expect(rows[0]!.payload).toEqual({ action: 'payment.cancelled', actor: { type: 'service', id: 'billing-service' }, organizationId: r.body.organizationId, resource: { type: 'payment', id: r.body.id }, outcome: 'succeeded' });
  });

  it('payment.expired from the expiry sweep: actor system payment_expiry_sweep, the run id as correlation', async () => {
    // expiresAt is immutable (FI-02) and may be in the past at creation: the payment is born due, as the expiry suite does it.
    const r = await create(body({ expiresAt: new Date(Date.now() - 60_000).toISOString() })).expect(201);
    await t.app.get(ExpirySweeper).sweepOnce();
    const [expired] = (await auditRows(r.body.id)).filter((x) => x.name === 'audit.payment.expired');
    expect(expired!.payload).toEqual({ action: 'payment.expired', actor: { type: 'system', id: 'payment_expiry_sweep' }, organizationId: r.body.organizationId, resource: { type: 'payment', id: r.body.id }, outcome: 'succeeded' });
    expect(expired!.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const domain = await q(`SELECT "correlationId" FROM outbox WHERE name = 'payment.expired' AND payload->>'paymentId' = $1`, [r.body.id]);
    expect(domain[0]!.correlationId).toBe(expired!.correlationId); // one run, one correlation id for everything it caused
  });

  it('ATOMICITY: an audit-writer failure rolls the WHOLE transition back (no payment, no domain event, no audit event)', async () => {
    const audit = t.app.get(PaymentAudit);
    const spy = vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('simulated audit intent failure'));
    const b = body();
    await create(b).expect(500);
    spy.mockRestore();
    expect(await q(`SELECT 1 FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM outbox WHERE payload->>'organizationId' = $1`, [b.organizationId])).toHaveLength(0);
  });

  it('ATOMICITY: evidence the contract refuses (a malformed organization) is never written and takes the business change with it', async () => {
    const audit = t.app.get(PaymentAudit);
    const original = audit.record.bind(audit);
    const spy = vi.spyOn(audit, 'record').mockImplementationOnce((qq, action, payment, ctx) => original(qq, action, { ...payment, organizationId: 'NOT-A-UUID' }, ctx));
    const b = body();
    await create(b).expect(500);
    spy.mockRestore();
    expect(await q(`SELECT 1 FROM payment WHERE "paymentRequestId" = $1`, [b.paymentRequestId])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM outbox WHERE payload->>'organizationId' = $1`, [b.organizationId])).toHaveLength(0);
  });

  it('ATOMICITY: an outbox INSERT failure for the audit event rolls the cancellation back', async () => {
    const r = await create(body()).expect(201);
    const outbox = t.app.get(OutboxService);
    const original = outbox.enqueue.bind(outbox);
    const spy = vi.spyOn(outbox, 'enqueue').mockImplementation(async (qq, ev) => {
      if (ev.name.startsWith('audit.')) await qq.query(`INSERT INTO outbox(id, name, payload) VALUES ('not-a-uuid', 'audit.x.y', '{}'::jsonb)`); // a real SQL error
      return original(qq, ev);
    });
    await cancel(r.body.id, 'cancel-key-audit-fail').expect(500);
    spy.mockRestore();
    expect((await q(`SELECT status FROM payment WHERE id = $1`, [r.body.id]))[0]!.status).toBe('created');
    expect((await auditRows(r.body.id)).map((x) => x.name)).toEqual(['audit.payment.created']);
    expect(await q(`SELECT 1 FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = $1`, [r.body.id])).toHaveLength(0);
  });

  const identities: Record<string, AuthIdentity> = {
    'member-jwt': { id: '7a7a7a7a-0000-4000-8000-000000000077', adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: '7a7a7a7a-0000-4000-8000-000000000077', adminTier: 'owner', isActive: true, memberships: [] },
  };
  const startAttempt = (paymentId: string, key: string, scenario: Record<string, unknown>, jwt = 'member-jwt') =>
    request(t.app.getHttpServer()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', `Bearer ${jwt}`).set('idempotency-key', key).send({ providerOptions: scenario });
  const syncAs = (jwt: string, paymentId: string, attemptId: string) =>
    request(t.app.getHttpServer()).post(`/payment/payments/${paymentId}/attempts/${attemptId}/sync`).set('authorization', `Bearer ${jwt}`).send({ actor: { type: 'service', id: 'forged' } });

  it('G1 payment.succeeded by a verified user\'s sync: actor user with the kind Auth verified (member, owner), settled_method; never the body', async () => {
    for (const [jwt, kind] of [['member-jwt', 'member'], ['owner-jwt', 'owner']] as const) {
      const p = (await create(body()).expect(201)).body;
      const a = (await startAttempt(p.id, `sync-success-${kind}-key`, { scenario: 'success' }).expect(201)).body;
      await syncAs(jwt, p.id, a.id).expect(200);
      const [ev] = (await auditRows(p.id)).filter((x) => x.name === 'audit.payment.succeeded');
      expect(ev!.payload).toEqual({
        action: 'payment.succeeded', actor: { type: 'user', id: '7a7a7a7a-0000-4000-8000-000000000077', userKind: kind }, organizationId: p.organizationId,
        resource: { type: 'payment', id: p.id }, outcome: 'succeeded', changes: { settled_method: 'gateway' },
      });
    }
  });

  it('G1 payment.failed by a user\'s sync: the provider failure code stays out of central audit', async () => {
    const p = (await create(body()).expect(201)).body;
    const a = (await startAttempt(p.id, 'sync-failure-key-1', { scenario: 'failure', failureCode: 'card_closed' }).expect(201)).body;
    await syncAs('member-jwt', p.id, a.id).expect(200);
    const [ev] = (await auditRows(p.id)).filter((x) => x.name === 'audit.payment.failed');
    expect(ev?.payload).toEqual({ action: 'payment.failed', actor: { type: 'user', id: '7a7a7a7a-0000-4000-8000-000000000077', userKind: 'member' }, organizationId: p.organizationId, resource: { type: 'payment', id: p.id }, outcome: 'succeeded' });
    expect(JSON.stringify(ev!.payload)).not.toContain('card_closed');
  });

  it('G1 payment.failed settled AT ATTEMPT START (the provider rejects at once): the starting user with the kind Auth verified, never a header', async () => {
    const p = (await create(body()).expect(201)).body;
    await request(t.app.getHttpServer()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer owner-jwt').set('x-user-kind', 'member')
      .set('idempotency-key', 'start-failure-owner-key').send({ providerOptions: { scenario: 'failure', failureCode: 'card_closed' } }).expect(201);
    const [ev] = (await auditRows(p.id)).filter((x) => x.name === 'audit.payment.failed');
    expect(ev?.payload.actor).toEqual({ type: 'user', id: '7a7a7a7a-0000-4000-8000-000000000077', userKind: 'owner' });
  });

  it('G1 payment.succeeded settled by the attempt resolver: actor system payment_attempt_resolver', async () => {
    const p = (await create(body()).expect(201)).body;
    await startAttempt(p.id, 'resolver-audit-key-1', { scenario: 'timeout_after_accept' }).expect(201);
    await t.app.get(AttemptResolver).drainOnce();
    const [ev] = (await auditRows(p.id)).filter((x) => x.name === 'audit.payment.succeeded');
    expect(ev!.payload.actor).toEqual({ type: 'system', id: 'payment_attempt_resolver' });
  });
});
