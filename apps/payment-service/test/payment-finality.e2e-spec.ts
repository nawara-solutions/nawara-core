import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptResolver } from '../src/attempts/attempt-resolver.js';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21';
type Row = Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A direct purchase from the Platform's Company reference (S4a purpose and beneficiary; S4b Company seller). */
const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});

/**
 * Core V2 S4c (register PAY-02, PAY-04; the Owner's F-1 to F-8): closing, uncertainty and late success through the REAL application on real
 * PostgreSQL 16 with the deterministic test provider (simulation only). Every provider outcome arrives through an approved evidence path: a
 * signed webhook, the payer's sync, or the resolver's status check. Nothing here marks a payment successful by hand.
 */
describeWithEnv('payment closing and finality (Core V2 S4c) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body(over)).expect(201)).body;
  const read = (id: string) => request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${billing.token}`);
  const start = (id: string, scenario: string, key = `k-${crypto.randomUUID()}`) =>
    request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key).send({ providerOptions: { scenario } });
  const sync = (pid: string, aid: string) => request(server()).post(`/payment/payments/${pid}/attempts/${aid}/sync`).set('authorization', 'Bearer buyer-jwt').send({});
  const cancel = (id: string, key = `c-${crypto.randomUUID()}`) =>
    request(server()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key).send({});
  /** A provider notification signed with the test provider's secret, naming the attempt by its merchantReference (= the attempt id). */
  const signed = (type: 'payment.succeeded' | 'payment.failed', attemptId: string, eventId = `evt_${type}_${attemptId}`) => {
    const payload = type === 'payment.succeeded'
      ? { eventId, type, reference: attemptId, amount: 9000, currency: 'TND' }
      : { eventId, type, reference: attemptId, data: { failureCode: 'card_declined' } };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return { raw, signature: createHmac('sha256', 'test-provider-webhook-secret').update(raw).digest('hex') };
  };
  const webhook = ({ raw, signature }: { raw: Buffer; signature: string }) =>
    request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(raw.toString('utf8'));
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const events = async (name: string, pid: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = $1 AND payload->>'paymentId' = $2`, [name, pid])).rows.map((r) => r.payload as Row);
  const audits = async (name: string, pid: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = $1 AND payload->'resource'->>'id' = $2`, [name, pid])).rows.map((r) => r.payload as Row);
  const late = async (aid: string) => (await admin.query(`SELECT source, "webhookEventId" IS NOT NULL AS webhook, amount::int, "paymentStatus" FROM payment_late_success WHERE "attemptId" = $1 ORDER BY "recordedAt"`, [aid])).rows;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentfinality');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '1' },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('closing from a cancel (F-1, F-7)', () => {
    it('cancel while an attempt is open → 202 closing (no event); a repeat answers the same; the confirmed failure then ends it cancelled, once', async () => {
      const p = await create();
      const a = (await start(p.id, 'timeout_before_accept').expect(201)).body; // ambiguous: unknown
      const c = await cancel(p.id).expect(202);
      expect(c.body).toMatchObject({ status: 'closing', finality: 'uncertain', closingReason: 'cancel', purpose: 'direct_purchase', liveMode: false });
      const again = await cancel(p.id).expect(202);
      expect(again.body.closingSince).toBe(c.body.closingSince);
      expect(await events('payment.cancelled', p.id)).toHaveLength(0); // nothing until the evidence arrives (F-7)
      expect((await start(p.id, 'success')).body.code).toBe('payment_uncertain'); // not payable while closing

      await webhook(signed('payment.failed', a.id)).expect(200); // the provider's own failure: definitive (F-3)
      const done = (await read(p.id).expect(200)).body;
      expect(done).toMatchObject({ status: 'cancelled', finality: 'final', closingReason: 'cancel' });
      const [ev] = await events('payment.cancelled', p.id);
      expect(ev).toMatchObject({ status: 'cancelled', purpose: 'direct_purchase', beneficiaryUserId: BUYER, liveMode: false, seller: { type: 'company' } });
      expect((await audits('audit.payment.cancelled', p.id)).map((x) => x.actor)).toEqual([{ type: 'service', id: 'billing-service' }]); // the requester
      await webhook(signed('payment.failed', a.id)).expect(200); // a redelivery changes nothing
      expect(await events('payment.cancelled', p.id)).toHaveLength(1);
      expect((await cancel(p.id)).status).toBe(409); // final now
    });

    it('a verified success that arrives while closing settles the payment (F-4): one payment.succeeded, no payment.cancelled, even redelivered', async () => {
      const p = await create();
      const a = (await start(p.id, 'timeout_after_accept').expect(201)).body; // the provider DID record it
      await cancel(p.id).expect(202);
      const success = signed('payment.succeeded', a.id);
      await Promise.all([webhook(success), webhook(success), webhook(success)]); // concurrent duplicate deliveries
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'succeeded', finality: 'final', closingReason: 'cancel', settledMethod: 'gateway' });
      expect(await events('payment.succeeded', p.id)).toHaveLength(1);
      expect(await events('payment.cancelled', p.id)).toHaveLength(0);
      expect(await late(a.id)).toEqual([]);
    });
  });

  describe('an inferred failure stays uncertain (F-2, F-3, F-6)', () => {
    it('limit reached on a guess: the payment never fails; no second attempt; a cancel waits in closing however often the resolver asks', async () => {
      const p = await create();
      const a = (await start(p.id, 'timeout_before_accept').expect(201)).body; // the provider never recorded it
      const resolver = t.app.get(AttemptResolver);
      await sync(p.id, a.id); // "no record" from an authoritative adapter: an INFERRED failure
      expect(await one(`SELECT status, "failureInferred", "failureConfirmedAt" FROM payment_attempt WHERE id = $1`, [a.id])).toEqual({ status: 'failed', failureInferred: true, failureConfirmedAt: null });
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'created', finality: 'uncertain' }); // PAYMENT_MAX_ATTEMPTS=1, yet not failed
      expect(await events('payment.failed', p.id)).toHaveLength(0);
      const second = await start(p.id, 'success');
      expect([second.status, second.body.code]).toEqual([409, 'payment_uncertain']); // no second collection
      expect(Number((await one(`SELECT count(*) FROM payment_attempt WHERE "paymentId" = $1`, [p.id])).count)).toBe(1);

      await cancel(p.id).expect(202);
      for (let i = 0; i < 3; i++) {
        await admin.query(`UPDATE payment_attempt SET "resolveAfter" = NULL WHERE id = $1`, [a.id]);
        await resolver.drainOnce(); // asks the provider again: still "no record"
      }
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'closing', finality: 'uncertain' }); // never released by time or retries
      expect(await events('payment.cancelled', p.id)).toHaveLength(0);
    });

    it('the provider later CONFIRMS the inferred failure: definitive, and only then the payment fails at its limit (payment.failed once)', async () => {
      const p = await create();
      const a = (await start(p.id, 'timeout_before_accept').expect(201)).body;
      await sync(p.id, a.id); // inferred
      await webhook(signed('payment.failed', a.id)).expect(200); // provider-confirmed
      expect(await one(`SELECT "failureConfirmedAt" IS NOT NULL AS confirmed, "confirmedFailureCode" FROM payment_attempt WHERE id = $1`, [a.id])).toEqual({ confirmed: true, confirmedFailureCode: 'card_declined' });
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'failed', finality: 'final' });
      expect(await events('payment.failed', p.id)).toHaveLength(1);
    });
  });

  describe('closing from an expiry (F-1)', () => {
    it('a due payment with an open attempt starts closing (expiry); the confirmed failure ends it expired with the sweep as its actor', async () => {
      const p = await create({ expiresAt: new Date(Date.now() + 1500).toISOString() });
      const a = (await start(p.id, 'timeout_before_accept').expect(201)).body;
      await sleep(1700);
      const sweeper = t.app.get(ExpirySweeper);
      await Promise.all([sweeper.sweepOnce(), sweeper.sweepOnce()]); // concurrent passes
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'closing', closingReason: 'expiry' });
      expect(await events('payment.expired', p.id)).toHaveLength(0);
      await webhook(signed('payment.failed', a.id)).expect(200);
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'expired', finality: 'final', closingReason: 'expiry' });
      const [ev] = await events('payment.expired', p.id);
      expect(ev).toMatchObject({ status: 'expired', expiresAt: expect.any(String), liveMode: false });
      expect((await audits('audit.payment.expired', p.id)).map((x) => x.actor)).toEqual([{ type: 'system', id: 'payment_expiry_sweep' }]);
    });
  });

  describe('late success after the workflow ended (F-4)', () => {
    it('failed on a confirmed failure, then the provider says success (status check and webhook): recorded durably, never settled or reopened', async () => {
      const p = await create();
      const a = (await start(p.id, 'timeout_after_accept').expect(201)).body; // the provider recorded a success
      await webhook(signed('payment.failed', a.id)).expect(200); // ...but first notifies a confirmed failure (contradictory provider)
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'failed', finality: 'final' }); // definitive, at its limit of 1

      expect((await sync(p.id, a.id)).status).toBe(409); // the status check finds the success
      await webhook(signed('payment.succeeded', a.id)).expect(200); // and so does the provider's notification (recorded conflict)
      await webhook(signed('payment.succeeded', a.id)).expect(200); // redelivered: nothing more
      expect(await late(a.id)).toEqual([
        { source: 'status_check', webhook: false, amount: 9000, paymentStatus: 'failed' },
        { source: 'webhook', webhook: true, amount: 9000, paymentStatus: 'failed' },
      ]);
      expect((await read(p.id).expect(200)).body).toMatchObject({ status: 'failed', finality: 'final' });
      expect(await events('payment.succeeded', p.id)).toHaveLength(0); // no automatic purchase downstream
      expect((await one(`SELECT state FROM webhook_event WHERE "providerEventId" = $1`, [`evt_payment.succeeded_${a.id}`])).state).toBe('conflict');
    });
  });

  describe('concurrency and the database guard (F-6)', () => {
    it('8 concurrent attempt starts on one payment: exactly one attempt; the rest are refused (payment_has_open_attempt / payment_uncertain)', async () => {
      const p = await create();
      const rs = await Promise.all(Array.from({ length: 8 }, () => start(p.id, 'timeout_before_accept')));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of rs.filter((x) => x.status !== 201)) expect(['payment_has_open_attempt', 'payment_uncertain', 'payment_not_payable']).toContain(r.body.code);
      expect(Number((await one(`SELECT count(*) FROM payment_attempt WHERE "paymentId" = $1`, [p.id])).count)).toBe(1);
    });

    it('a cancel racing an attempt start, 10 times: never cancelled with an attempt that may still settle; never two attempts', async () => {
      for (let i = 0; i < 10; i++) {
        const p = await create();
        await Promise.all([cancel(p.id), start(p.id, 'timeout_before_accept')]);
        const row = await one(`SELECT status, payment_is_uncertain(id) AS uncertain, (SELECT count(*)::int FROM payment_attempt WHERE "paymentId" = payment.id) AS attempts FROM payment WHERE id = $1`, [p.id]);
        expect(row.attempts).toBeLessThanOrEqual(1);
        if (row.status === 'cancelled') expect(row.uncertain).toBe(false);
        else expect(['closing', 'pending']).toContain(row.status);
      }
    });

    it('raw SQL cannot cancel an uncertain payment, start a second attempt on it, or bring a closing payment back', async () => {
      const p = await create();
      await start(p.id, 'timeout_before_accept').expect(201);
      const refused = async (sql: string) => expect(admin.query(sql, [p.id])).rejects.toMatchObject({ code: '23514' });
      await refused(`UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = $1`);
      await refused(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), $1, 2, 'test')`);
      await cancel(p.id).expect(202);
      await refused(`UPDATE payment SET status = 'created' WHERE id = $1`);
      await refused(`UPDATE payment SET "closingReason" = 'expiry' WHERE id = $1`);
    });
  });

  describe('historical records (F-8)', () => {
    it('a payment created before S4c with an unconfirmed inferred failure is derived UNCERTAIN (nothing backfilled); a closed one is final', async () => {
      const c = await admin.connect();
      let pid = '';
      try {
        await c.query('SET session_replication_role = replica'); // the pre-S4c shape, written without today's guards
        pid = (await c.query(`INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, "liveMode")
                               VALUES ('billing-service', gen_random_uuid(), 'invoice', 'old', 'user', $1, 'company', 'n', 100, 'TND', NULL) RETURNING id`, [BUYER])).rows[0].id;
        await c.query(`INSERT INTO payment_attempt (id, "paymentId", "attemptNumber", provider, status, "failureInferred", "failureCode", "failureClass", "liveMode") VALUES (gen_random_uuid(), $1, 1, 'test', 'failed', true, 'not_found', 'terminal', NULL)`, [pid]);
      } finally {
        await c.query('SET session_replication_role = origin');
        c.release();
      }
      expect((await read(pid).expect(200)).body).toMatchObject({ status: 'created', finality: 'uncertain', closingReason: null, closingSince: null, purpose: null });
      const closed = await create();
      await cancel(closed.id).expect(200);
      expect((await read(closed.id).expect(200)).body.finality).toBe('final');
    });
  });
});
