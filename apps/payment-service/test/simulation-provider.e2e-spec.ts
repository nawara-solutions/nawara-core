import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const SECRET = randomBytes(32).toString('hex'); // the operator's own signing material, never a repository value (F-S5)
type Row = Record<string, any>;

const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});
const cmd = () => `cmd-${crypto.randomUUID()}`;

/**
 * Core V2 S4f (register PAY-14; S0 §1.1, FC-10; the Owner's OD-06 decisions F-S1 to F-S7): the `simulation` provider and its harness through
 * the REAL application on real PostgreSQL 16. Every outcome reaches Payment only through the provider's ordinary authenticated paths (a
 * notification verified with the operator's secret, or the status read): a harness command is never itself a settlement fact (F-S4).
 */
describeWithEnv('simulation provider and harness (Core V2 S4f) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body(over)).expect(201)).body;
  const read = async (id: string) => (await request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
  const startRaw = (id: string, send: Row = {}) =>
    request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', `k-${crypto.randomUUID()}`).send(send);
  const start = async (id: string) => (await startRaw(id).expect(201)).body;
  const sync = (pid: string, aid: string) => request(server()).post(`/payment/payments/${pid}/attempts/${aid}/sync`).set('authorization', 'Bearer buyer-jwt').send({});
  const as = (token: string) => ({
    initiation: (pid: string, send: Row) => request(server()).post(`/payment/simulation/payments/${pid}/initiation`).set('authorization', `Bearer ${token}`).send(send),
    outcome: (pid: string, aid: string, send: Row) => request(server()).post(`/payment/simulation/payments/${pid}/attempts/${aid}/outcomes`).set('authorization', `Bearer ${token}`).send(send),
    deliver: (commandId: string) => request(server()).post(`/payment/simulation/commands/${commandId}/deliver`).set('authorization', `Bearer ${token}`).send({}),
  });
  const sim = () => as(harness.token);
  const outcome = async (pid: string, aid: string, send: Row) => (await sim().outcome(pid, aid, { commandId: cmd(), ...send }).expect(201)).body;
  const attempt = async (aid: string) => (await admin.query(`SELECT status, "failureCode", "failureInferred", "failureConfirmedAt" IS NOT NULL AS confirmed FROM payment_attempt WHERE id = $1`, [aid])).rows[0];
  const facts = async (aid: string) => (await admin.query(`SELECT provider, "providerTxnId", amount::int, currency, "liveMode", source FROM provider_transaction_fact WHERE "attemptId" = $1`, [aid])).rows;
  const factConflicts = async (aid: string) => (await admin.query(`SELECT amount::int, source FROM provider_transaction_fact_conflict WHERE "attemptId" = $1`, [aid])).rows;
  const lateSuccesses = async (aid: string) => (await admin.query(`SELECT "paymentStatus", source FROM payment_late_success WHERE "attemptId" = $1`, [aid])).rows;
  const events = async (pid: string, name: string) => Number((await admin.query(`SELECT count(*) FROM outbox WHERE name = $2 AND payload->>'paymentId' = $1`, [pid, name])).rows[0].count);
  const webhookStates = async (aid: string) => (await admin.query(`SELECT "providerEventId", state, outcome FROM webhook_event WHERE "matchedAttemptId" = $1 ORDER BY "receivedAt"`, [aid])).rows;
  const signed = (payload: Row, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  };
  const postWebhook = (raw: Buffer, signature: string, header = 'x-simulation-signature') =>
    request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json').set(header, signature).send(raw.toString('utf8'));

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentsim');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET, PAYMENT_MAX_ATTEMPTS: '2',
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('server-side provider selection (F-S7)', () => {
    it('a payer attempt uses the simulation provider by default; payer-chosen outcomes and the test provider are refused', async () => {
      const p = await create();
      expect((await startRaw(p.id, { providerOptions: { scenario: 'success' } }).expect(422)).body.code).toBe('provider_options_not_accepted');
      expect((await startRaw(p.id, { provider: 'test' }).expect(422)).body.code).toBe('invalid_provider');
      const a = await start(p.id);
      expect(a).toMatchObject({ provider: 'simulation', status: 'submitted' });
      expect((await read(p.id)).status).toBe('pending'); // accepted by the provider, nothing settled
    });
  });

  describe('evidence classes (F-S4): every outcome passes through the authenticated provider pipeline', () => {
    it('verified success: the delivered notification is one simulation fact, the payment succeeds once, one payment.succeeded', async () => {
      const p = await create();
      const a = await start(p.id);
      const r = await outcome(p.id, a.id, { outcome: 'succeeded' });
      expect(r).toMatchObject({ amount: 9000, currency: 'TND', providerTransactionId: `sim_${a.id}`, delivery: 'immediate', delivered: { status: 200 } });
      expect(await facts(a.id)).toEqual([{ provider: 'simulation', providerTxnId: `sim_${a.id}`, amount: 9000, currency: 'TND', liveMode: false, source: 'webhook' }]);
      expect((await read(p.id)).status).toBe('succeeded');
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });

    it('a harness instruction alone is not a fact: a held success changes nothing until the provider is heard from', async () => {
      const p = await create();
      const a = await start(p.id);
      const r = await outcome(p.id, a.id, { outcome: 'succeeded', delivery: 'held' });
      expect(r.delivered).toBeNull();
      expect(await facts(a.id)).toEqual([]);
      expect((await read(p.id)).status).toBe('pending');
      // delayed delivery: the status read sees it first, the late notification is the same fact and changes nothing more
      await sync(p.id, a.id).expect(200);
      expect((await sim().deliver(r.commandId).expect(200)).body.delivered).toEqual({ status: 200 });
      expect(await facts(a.id)).toEqual([expect.objectContaining({ source: 'status_check' })]);
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });

    it('provider-confirmed failure: definitive; the payment returns to created (attempts remain) and is not uncertain', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'failed', failureCode: 'card_declined' });
      expect(await attempt(a.id)).toMatchObject({ status: 'failed', failureCode: 'card_declined', failureInferred: false });
      expect((await read(p.id)).status).toBe('created');
      const second = await start(p.id); // a definitive failure leaves nothing uncertain
      await outcome(p.id, second.id, { outcome: 'failed', failureCode: 'card_declined' });
      expect((await read(p.id)).status).toBe('failed'); // the attempt limit (2) is reached
      expect(await events(p.id, 'payment.failed')).toBe(1);
      expect(await facts(a.id)).toEqual([]);
    });

    it('provider expiry: the attempt expires, definitively; a new attempt may start', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'expired' });
      expect(await attempt(a.id)).toMatchObject({ status: 'expired', failureCode: 'expired', failureInferred: false });
      expect((await read(p.id)).status).toBe('created');
      await start(p.id);
    });

    it('a late verified success after a provider expiry is recorded for reconciliation, never applied', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'expired' });
      const late = await outcome(p.id, a.id, { outcome: 'succeeded' });
      expect(late.delivered).toEqual({ status: 200 });
      expect(await lateSuccesses(a.id)).toEqual([{ paymentStatus: 'created', source: 'webhook' }]);
      expect(await facts(a.id)).toHaveLength(1); // the money movement is still a fact
      expect((await read(p.id)).status).toBe('created');
      expect(await events(p.id, 'payment.succeeded')).toBe(0);
      expect((await webhookStates(a.id)).at(-1)).toMatchObject({ state: 'conflict', outcome: 'invalid_state_transition' });
    });

    it('no record (inferred failure) keeps the payment uncertain; a late verified success then settles it once', async () => {
      const p = await create();
      await sim().initiation(p.id, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
      const a = await start(p.id);
      expect(a.status).toBe('unknown');
      await outcome(p.id, a.id, { outcome: 'no_record' }); // status read only: no notification
      expect(await facts(a.id)).toEqual([]);
      await sync(p.id, a.id).expect(200);
      expect(await attempt(a.id)).toMatchObject({ status: 'failed', failureCode: 'not_found', failureInferred: true, confirmed: false });
      expect((await startRaw(p.id).expect(409)).body.code).toBe('payment_uncertain');
      await outcome(p.id, a.id, { outcome: 'succeeded' }); // late verified success
      expect((await read(p.id)).status).toBe('succeeded');
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });

    it('a provider-confirmed failure confirms an inferred one: the payment is no longer uncertain', async () => {
      const p = await create();
      await sim().initiation(p.id, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'no_record' });
      await sync(p.id, a.id).expect(200);
      await outcome(p.id, a.id, { outcome: 'failed', failureCode: 'card_declined' });
      expect(await attempt(a.id)).toMatchObject({ status: 'failed', failureInferred: true, confirmed: true });
      await start(p.id);
    });

    it('pending: the status read changes nothing', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'pending' });
      await sync(p.id, a.id).expect(200);
      expect(await attempt(a.id)).toMatchObject({ status: 'submitted' });
      expect((await read(p.id)).status).toBe('pending');
    });

    it('rejected at initiation: the provider declines the attempt definitively', async () => {
      const p = await create();
      await sim().initiation(p.id, { commandId: cmd(), mode: 'rejected', failureCode: 'do_not_honor' }).expect(201);
      const a = await start(p.id);
      expect(a).toMatchObject({ status: 'failed', failureCode: 'do_not_honor' });
      expect((await read(p.id)).status).toBe('created');
    });

    it('duplicate delivery: redelivering and replaying is one event, one fact, one payment.succeeded', async () => {
      const p = await create();
      const a = await start(p.id);
      const commandId = cmd();
      await sim().outcome(p.id, a.id, { commandId, outcome: 'succeeded' }).expect(201);
      await Promise.all([sim().deliver(commandId), sim().deliver(commandId), sim().outcome(p.id, a.id, { commandId, outcome: 'succeeded' })]);
      expect(await webhookStates(a.id)).toEqual([{ providerEventId: `sim_${commandId}`, state: 'processed', outcome: null }]);
      expect(await facts(a.id)).toHaveLength(1);
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });

    it('out-of-order delivery: a failure delivered after the success is a recorded conflict; the success stands', async () => {
      const p = await create();
      const a = await start(p.id);
      const failure = await outcome(p.id, a.id, { outcome: 'failed', failureCode: 'card_declined', delivery: 'held' });
      await outcome(p.id, a.id, { outcome: 'succeeded' });
      await sim().deliver(failure.commandId).expect(200);
      expect((await webhookStates(a.id)).map((w) => w.state)).toEqual(['processed', 'conflict']);
      expect(await attempt(a.id)).toMatchObject({ status: 'succeeded' });
      expect((await read(p.id)).status).toBe('succeeded');
    });

    it('amount mismatch (FI-13): recorded as the provider reported it, never applied', async () => {
      const p = await create();
      const a = await start(p.id);
      const r = await outcome(p.id, a.id, { outcome: 'amount_mismatch' });
      expect(r.amount).toBe(8999); // derived by Payment from the snapshot, never supplied by the caller
      expect(await facts(a.id)).toEqual([expect.objectContaining({ amount: 8999 })]);
      expect((await webhookStates(a.id))[0]).toMatchObject({ state: 'conflict', outcome: 'provider_error' });
      expect((await read(p.id)).status).toBe('pending');
    });

    it('contradictory observation: another amount for the same provider transaction is a kept conflict; the fact is unchanged', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'succeeded' });
      await outcome(p.id, a.id, { outcome: 'amount_mismatch' });
      expect(await facts(a.id)).toEqual([expect.objectContaining({ amount: 9000 })]);
      expect(await factConflicts(a.id)).toEqual([{ amount: 8999, source: 'webhook' }]);
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });
  });

  describe('command identity (F-S6)', () => {
    it('an identical replay is answered from the record (200, Idempotent-Replayed) and changes nothing', async () => {
      const p = await create();
      const a = await start(p.id);
      const commandId = cmd();
      const first = await sim().outcome(p.id, a.id, { commandId, outcome: 'pending' }).expect(201);
      const again = await sim().outcome(p.id, a.id, { commandId, outcome: 'pending' }).expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual({ ...first.body });
      expect(Number((await admin.query(`SELECT count(*) FROM simulation_provider_command WHERE "commandId" = $1`, [commandId])).rows[0].count)).toBe(1);
    });

    it('the same commandId with other content, another attempt or another payment is refused (409)', async () => {
      const p = await create();
      const a = await start(p.id);
      const q = await create();
      const b = await start(q.id);
      const commandId = cmd();
      await sim().outcome(p.id, a.id, { commandId, outcome: 'pending' }).expect(201);
      for (const res of [
        await sim().outcome(p.id, a.id, { commandId, outcome: 'failed', failureCode: 'x' }),
        await sim().outcome(p.id, a.id, { commandId, outcome: 'pending', delivery: 'held' }),
        await sim().outcome(q.id, b.id, { commandId, outcome: 'pending' }),
        await sim().initiation(p.id, { commandId, mode: 'accepted' }),
      ]) expect([res.status, res.body.code]).toEqual(res.body.code === 'invalid_simulation_command' ? [400, 'invalid_simulation_command'] : [409, 'simulation_command_conflict']);
      expect(await attempt(b.id)).toMatchObject({ status: 'submitted' });
    });

    it('concurrent identical commands record once and deliver once', async () => {
      const p = await create();
      const a = await start(p.id);
      const commandId = cmd();
      const results = await Promise.all(Array.from({ length: 6 }, () => sim().outcome(p.id, a.id, { commandId, outcome: 'succeeded' })));
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 200, 200, 200, 200, 201]);
      expect(await facts(a.id)).toHaveLength(1);
      expect(await events(p.id, 'payment.succeeded')).toBe(1);
    });

    it('distinct sequential observations of one attempt are permitted', async () => {
      const p = await create();
      const a = await start(p.id);
      await outcome(p.id, a.id, { outcome: 'pending' });
      await outcome(p.id, a.id, { outcome: 'succeeded', delivery: 'held' });
      await sync(p.id, a.id).expect(200);
      expect((await read(p.id)).status).toBe('succeeded');
    });
  });

  describe('authority and binding (F-S2, F-S3)', () => {
    it('payer credentials, a producer without the operation, and the harness on other routes are all refused', async () => {
      const p = await create();
      const a = await start(p.id);
      expect((await as('buyer-jwt').outcome(p.id, a.id, { commandId: cmd(), outcome: 'succeeded' })).status).toBe(401);
      expect((await as(billing.token).outcome(p.id, a.id, { commandId: cmd(), outcome: 'succeeded' }).expect(403)).body.code).toBe('operation_not_permitted');
      expect((await as(billing.token).initiation(p.id, { commandId: cmd(), mode: 'accepted' })).status).toBe(403);
      expect((await request(server()).post('/payment/payments').set('authorization', `Bearer ${harness.token}`).send(body())).status).toBe(403);
      expect((await request(server()).get(`/payment/payments/${p.id}`).set('authorization', `Bearer ${harness.token}`)).status).toBe(403);
      expect((await request(server()).post(`/payment/simulation/payments/${p.id}/attempts/${a.id}/outcomes`).send({ commandId: cmd(), outcome: 'succeeded' })).status).toBe(401);
      expect(await attempt(a.id)).toMatchObject({ status: 'submitted' });
    });

    it('cross-payment and unknown references are not found; caller-supplied money, payer or settlement fields are refused', async () => {
      const p = await create();
      const a = await start(p.id);
      const q = await create();
      expect((await sim().outcome(q.id, a.id, { commandId: cmd(), outcome: 'succeeded' })).status).toBe(404);
      expect((await sim().outcome(p.id, crypto.randomUUID(), { commandId: cmd(), outcome: 'succeeded' })).status).toBe(404);
      expect((await sim().initiation(crypto.randomUUID(), { commandId: cmd(), mode: 'accepted' })).status).toBe(404);
      for (const extra of [{ amount: 1 }, { currency: 'EUR' }, { payerId: BUYER }, { providerTransactionId: 'sim_x' }, { settled: true }]) {
        expect((await sim().outcome(p.id, a.id, { commandId: cmd(), outcome: 'succeeded', ...extra })).status).toBe(400);
      }
      expect((await sim().outcome(p.id, a.id, { commandId: cmd(), outcome: 'succeeded', failureCode: 'x' }).expect(400)).body.code).toBe('invalid_simulation_command');
      expect((await sim().outcome(p.id, a.id, { commandId: cmd(), outcome: 'pending', delivery: 'held' }).expect(400)).body.code).toBe('invalid_simulation_command');
      expect((await sim().outcome(p.id, a.id, { commandId: 'short', outcome: 'pending' })).status).toBe(400);
      expect((await sim().deliver(cmd())).status).toBe(404);
      expect(await attempt(a.id)).toMatchObject({ status: 'submitted' });
    });

    it('a cross-provider attempt is not found (and the database binding refuses one outright)', async () => {
      const p = await create();
      const { rows } = await admin.query(`INSERT INTO payment_attempt ("paymentId", "attemptNumber", provider, "liveMode") VALUES ($1, 1, 'test', false) RETURNING id`, [p.id]);
      expect((await sim().outcome(p.id, rows[0].id, { commandId: cmd(), outcome: 'succeeded' })).status).toBe(404);
      await expect(admin.query(`INSERT INTO simulation_provider_command ("commandId", kind, "paymentId", "attemptId", instruction, "providerTxnId") VALUES ($1, 'outcome', $2, $3, 'pending', 'sim_x')`,
        [cmd(), p.id, rows[0].id])).rejects.toMatchObject({ code: '23503' });
    });

    it('a pending command has nothing to deliver (409)', async () => {
      const p = await create();
      const a = await start(p.id);
      const r = await outcome(p.id, a.id, { outcome: 'pending' });
      expect((await sim().deliver(r.commandId).expect(409)).body.code).toBe('simulation_nothing_to_deliver');
    });
  });

  describe('the simulation webhook (F-S5): only the operator secret authenticates a notification', () => {
    it('a forged, unsigned or test-provider-signed notification is 401 and stores nothing', async () => {
      const p = await create();
      const a = await start(p.id);
      const forged = { eventId: `sim_forged_${a.id}`, type: 'payment.succeeded', reference: a.id, providerTransactionId: `sim_${a.id}`, amount: 9000, currency: 'TND' };
      const other = signed(forged, randomBytes(32).toString('hex'));
      await postWebhook(other.raw, other.signature).expect(401);
      const testSigned = signed(forged, 'test-provider-webhook-secret');
      await postWebhook(testSigned.raw, testSigned.signature, 'x-test-provider-signature').expect(401);
      await postWebhook(Buffer.from(JSON.stringify(forged)), '').expect(401);
      expect(await facts(a.id)).toEqual([]);
      expect(Number((await admin.query(`SELECT count(*) FROM webhook_event WHERE "providerEventId" = $1`, [forged.eventId])).rows[0].count)).toBe(0);
      expect((await read(p.id)).status).toBe('pending');
    });

    it('a correctly signed notification over HTTP goes through the same pipeline (test-provider route is absent)', async () => {
      const p = await create();
      const a = await start(p.id);
      const ok = signed({ eventId: `sim_http_${a.id}`, type: 'payment.succeeded', reference: a.id, providerTransactionId: `sim_${a.id}`, amount: 9000, currency: 'TND' });
      await postWebhook(ok.raw, ok.signature).expect(200);
      expect((await read(p.id)).status).toBe('succeeded');
      await request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').send('{}').expect(404);
    });
  });
});

/** Where the provider is not enabled, the harness does not exist: no route, and the boundary refuses it if reached (F-S5). */
describeWithEnv('simulation harness absent unless enabled (Core V2 S4f)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const harness = generateServiceToken();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentsimoff');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], tokens: [{ caller: 'billing-service', digest: harness.digest }], env: { PAYMENT_TEST_PROVIDER: 'true' } });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  it('every harness route and the simulation webhook are 404', async () => {
    const id = crypto.randomUUID();
    const s = t.app.getHttpServer();
    await request(s).post(`/payment/simulation/payments/${id}/initiation`).set('authorization', `Bearer ${harness.token}`).send({ commandId: cmd(), mode: 'accepted' }).expect(404);
    await request(s).post(`/payment/simulation/payments/${id}/attempts/${id}/outcomes`).set('authorization', `Bearer ${harness.token}`).send({ commandId: cmd(), outcome: 'pending' }).expect(404);
    await request(s).post(`/payment/simulation/commands/${cmd()}/deliver`).set('authorization', `Bearer ${harness.token}`).send({}).expect(404);
    await request(s).post('/payment/webhooks/simulation').set('content-type', 'application/json').send('{}').expect(404);
  });
});
