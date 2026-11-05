import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DbService, OutboxService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { PaymentAudit } from '../src/audit/payment-audit.js';
import { CAPTURE_RECOVERY_MAX_ATTEMPTS, CaptureReconciler, captureInfrastructurePauseMs, captureRecoveryWaitSeconds, classifyCaptureRecoveryFailure } from '../src/payments/capture-reconciler.js';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2a0b7c5d-3e2f-4a6b-9c8d-7e6f5a4b3c22';
type Row = Record<string, any>;

const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});

/**
 * Core V2 S0-C12 (S0 §1.5 S0-C12; register PAY-02 H, PAY-05 J, PAY-12 I, EVT-10 note; audit catalog item 10): wrong-amount captures, through the REAL
 * application on real PostgreSQL 16 with the deterministic test provider (simulation only). Every observation is a signed provider notification.
 * Payments are 9000 TND. Billing's D-1 / D-B safeguards (#468) are merged; this suite proves the producer side only.
 */
describeWithEnv('wrong-amount captures (Core V2 S0-C12) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body(over)).expect(201)).body;
  const start = async (id: string, scenario: string) =>
    (await request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', `k-${crypto.randomUUID()}`)
      .send({ providerOptions: { scenario } }).expect(201)).body;
  const cancel = (id: string) => request(server()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', `c-${crypto.randomUUID()}`).send({});
  const signed = (payload: Row) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return { raw, signature: createHmac('sha256', 'test-provider-webhook-secret').update(raw).digest('hex') };
  };
  const post = (raw: Buffer, signature: string) =>
    request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(raw.toString('utf8'));
  /** The provider's signed capture of this attempt (its own transaction `ptx_<attempt>`), with the amount and currency it states. */
  const capture = (aid: string, amount: number, currency = 'TND', eventId = `evt_${crypto.randomUUID()}`) => {
    const n = signed({ eventId, type: 'payment.succeeded', reference: aid, amount, currency });
    return { eventId, send: () => post(n.raw, n.signature) };
  };
  const one = async (sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows[0];
  const count = async (sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows[0].n as number;
  const status = async (id: string) => (await one(`SELECT status FROM payment WHERE id = $1`, [id])).status as string;
  const facts = async (pid: string) => (await admin.query(`SELECT id, amount::int AS amount, trim(currency) AS currency, source FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt"`, [pid])).rows;
  const lateSuccesses = async (pid: string) => (await admin.query(
    `SELECT id, amount::int AS amount, trim(currency) AS currency, "factId", "paymentStatus" FROM payment_late_success WHERE "paymentId" = $1 ORDER BY "recordedAt"`, [pid])).rows;
  const outboxOf = async (name: string, field: string, value: string) => (await admin.query(`SELECT id, payload FROM outbox WHERE name = $1 AND payload->>'${field}' = $2`, [name, value])).rows;
  const audits = async (name: string, pid: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = $1 AND payload->'changes'->>'payment_id' = $2`, [name, pid])).rows.map((r) => r.payload);
  const succeededEvents = async (pid: string) => (await outboxOf('payment.succeeded', 'paymentId', pid)).length;
  const webhookState = async (eventId: string) => (await one(`SELECT state, outcome FROM webhook_event WHERE "providerEventId" = $1`, [eventId]));
  const items = async (kind: string) => (await request(server()).get(`/payment/reconciliation/items?kind=${kind}&limit=200`).set('authorization', `Bearer ${billing.token}`).expect(200)).body.items as Row[];
  const reconcile = () => t.app.get(CaptureReconciler).reconcileOnce();
  /** A payment whose only attempt the provider failed; the payment is still open (one attempt of two used). */
  const openAfterFailure = async () => {
    const p = await create();
    const a = await start(p.id, 'failure');
    expect(await status(p.id)).toBe('created');
    return { p, a };
  };
  /** A payment cancelled after its failed attempt: workflow-final, never succeeded. */
  const cancelledAfterFailure = async () => {
    const { p, a } = await openAfterFailure();
    await cancel(p.id).expect(200);
    expect(await status(p.id)).toBe('cancelled');
    return { p, a };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentwrongamount');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    auth = await startFakeReceiptServer(); // Payment's own Auth credential: refunds, and so PAY-12, are mounted (development and simulation only)
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient, refundWorker: false,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: {
        PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '2', PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000', AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
        } }),
      },
    });
    await t.app.get(CaptureReconciler).stop(); // driven pass by pass below (deterministic): no background passes
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('S0-C12 item 2 (A1; F-01): after finality', () => {
    it('a higher amount: the fact as observed, one refund-only late success with the fact\'s figures, its EVT-10 and audit once; the payment stays cancelled and nothing settles', async () => {
      const { p, a } = await cancelledAfterFailure();
      const c = capture(a.id, 9100);
      expect((await c.send()).status).toBe(200);
      const [f] = await facts(p.id);
      expect(f).toMatchObject({ amount: 9100, currency: 'TND', source: 'webhook' });
      const ls = await lateSuccesses(p.id);
      expect(ls).toEqual([{ id: expect.any(String), amount: 9100, currency: 'TND', factId: f.id, paymentStatus: 'cancelled' }]);
      const ev = await outboxOf('payment.late_success.recorded', 'paymentId', p.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toMatchObject({ lateSuccessId: ls[0].id, factId: f.id, amount: 9100, currency: 'TND', paymentStatus: 'cancelled', liveMode: false });
      expect(await audits('audit.payment_late_success.recorded', p.id)).toEqual([expect.objectContaining({
        actor: { type: 'system', id: 'payment_webhook' }, resource: { type: 'payment_late_success', id: ls[0].id },
        changes: { payment_id: p.id, attempt_id: a.id, fact_id: f.id, observed_amount: 9100, payment_status: 'cancelled', matches_payment: false } })]);
      expect(await audits('audit.payment_capture_mismatch.recorded', p.id)).toEqual([expect.objectContaining({
        resource: { type: 'provider_transaction_fact', id: f.id }, changes: { payment_id: p.id, attempt_id: a.id, source: 'webhook', observed_amount: 9100, reason: 'amount_mismatch' } })]);
      expect(await status(p.id)).toBe('cancelled');
      expect(await succeededEvents(p.id)).toBe(0);
      expect(await webhookState(c.eventId)).toMatchObject({ state: 'conflict', outcome: 'invalid_state_transition' });
      // replays: the same signed notification again, twice concurrently: no second record, event or audit
      await Promise.all([c.send(), c.send()]);
      expect(await lateSuccesses(p.id)).toHaveLength(1);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).toHaveLength(1);
      expect(await audits('audit.payment_late_success.recorded', p.id)).toHaveLength(1);
      expect(await audits('audit.payment_capture_mismatch.recorded', p.id)).toHaveLength(1);
      expect(await items('capture_mismatch')).not.toContainEqual(expect.objectContaining({ factId: f.id }));
    });

    it('a lower amount and another valid currency are late successes with their exact figures (never converted); a failed payment the same', async () => {
      const lower = await cancelledAfterFailure();
      await capture(lower.a.id, 8900).send();
      expect(await lateSuccesses(lower.p.id)).toEqual([expect.objectContaining({ amount: 8900, currency: 'TND' })]);
      const eur = await cancelledAfterFailure();
      await capture(eur.a.id, 9000, 'EUR').send();
      expect(await lateSuccesses(eur.p.id)).toEqual([expect.objectContaining({ amount: 9000, currency: 'EUR', paymentStatus: 'cancelled' })]);
      expect((await audits('audit.payment_capture_mismatch.recorded', eur.p.id))[0].changes.reason).toBe('currency_mismatch');
      expect((await audits('audit.payment_late_success.recorded', eur.p.id))[0].changes).not.toHaveProperty('currency');
      // failed: both attempts failed at the provider (PAYMENT_MAX_ATTEMPTS 2)
      const p = await create();
      const a1 = await start(p.id, 'failure');
      await start(p.id, 'failure');
      expect(await status(p.id)).toBe('failed');
      await capture(a1.id, 9001).send();
      expect(await lateSuccesses(p.id)).toEqual([expect.objectContaining({ amount: 9001, paymentStatus: 'failed' })]);
      expect(await status(p.id)).toBe('failed');
    });

    it('an unrecognized currency a fact can hold: the fact, a capture_mismatch item (unrecognized_currency) and its audit; no late success, no EVT-10', async () => {
      const { p, a } = await cancelledAfterFailure();
      await capture(a.id, 9000, 'tnd').send();
      const [f] = await facts(p.id);
      expect(f).toMatchObject({ amount: 9000, currency: 'tnd' });
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).toEqual([]);
      expect(await items('capture_mismatch')).toContainEqual(expect.objectContaining({ id: f.id, paymentId: p.id, factId: f.id, amount: 9000, currency: 'tnd',
        detail: expect.objectContaining({ reason: 'unrecognized_currency', attemptId: a.id }) }));
      expect((await audits('audit.payment_capture_mismatch.recorded', p.id))[0].changes.reason).toBe('unrecognized_currency');
      await reconcile();
      expect(await lateSuccesses(p.id)).toEqual([]); // never completed into a late success by the reconciler either
      // before finality, then finality: the cancel's own transaction records no late success for it either; the item stays (any state)
      const open = await openAfterFailure();
      await capture(open.a.id, 9000, 'Tnd').send();
      const [g] = await facts(open.p.id);
      await cancel(open.p.id).expect(200);
      expect(await status(open.p.id)).toBe('cancelled');
      expect(await lateSuccesses(open.p.id)).toEqual([]);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', open.p.id)).toEqual([]);
      expect(await items('capture_mismatch')).toContainEqual(expect.objectContaining({ id: g.id, detail: expect.objectContaining({ reason: 'unrecognized_currency' }) }));
    });

    it('a currency no fact can hold (O-2): only the authenticated notification stays stored; no fact, no late success, the payment unchanged', async () => {
      const { p, a } = await cancelledAfterFailure();
      const c = capture(a.id, 9000, 'X'.repeat(17));
      await c.send();
      expect(await one(`SELECT "providerEventId" FROM webhook_event WHERE "providerEventId" = $1`, [c.eventId])).toBeDefined();
      expect(await facts(p.id)).toEqual([]);
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await status(p.id)).toBe('cancelled');
    });

    it('unchanged: an equal capture on a final payment is a late success matching the payment; a succeeded payment\'s further wrong-amount capture stays refused (no late success)', async () => {
      const { p, a } = await cancelledAfterFailure();
      await capture(a.id, 9000).send();
      expect(await lateSuccesses(p.id)).toEqual([expect.objectContaining({ amount: 9000, currency: 'TND' })]);
      expect((await audits('audit.payment_late_success.recorded', p.id))[0].changes.matches_payment).toBe(true);
      expect(await audits('audit.payment_capture_mismatch.recorded', p.id)).toEqual([]);
      const s = await create();
      const sa = await start(s.id, 'success');
      await request(server()).post(`/payment/payments/${s.id}/attempts/${sa.id}/sync`).set('authorization', 'Bearer buyer-jwt').send({});
      expect(await status(s.id)).toBe('succeeded');
      const extra = signed({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', reference: sa.id, amount: 9100, currency: 'TND' });
      await post(extra.raw, extra.signature);
      expect(await lateSuccesses(s.id)).toEqual([]);
      expect(await status(s.id)).toBe('succeeded');
    });
  });

  describe('S0-C12 items 5 and 6 (N1; F-20): before finality, then finality', () => {
    it('before finality: no late success, the payment unchanged, a capture_mismatch item; cancelling then records the late success in the cancel itself, once', async () => {
      const { p, a } = await openAfterFailure();
      await capture(a.id, 9100).send();
      const [f] = await facts(p.id);
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await status(p.id)).toBe('created');
      expect(await items('capture_mismatch')).toContainEqual(expect.objectContaining({ id: f.id, amount: 9100, currency: 'TND', detail: expect.objectContaining({ reason: 'amount_mismatch' }) }));
      expect(await audits('audit.payment_capture_mismatch.recorded', p.id)).toHaveLength(1);
      // finality by an existing rule: the cancel's own transaction records the late success, its event and audit
      expect((await cancel(p.id)).status).toBe(200);
      const ls = await lateSuccesses(p.id);
      expect(ls).toEqual([{ id: expect.any(String), amount: 9100, currency: 'TND', factId: f.id, paymentStatus: 'cancelled' }]);
      const cancelled = await outboxOf('payment.cancelled', 'paymentId', p.id);
      const late = await outboxOf('payment.late_success.recorded', 'paymentId', p.id);
      expect([cancelled.length, late.length]).toEqual([1, 1]);
      expect(await one(`SELECT (SELECT xmin FROM payment_late_success WHERE id = $1)::text = (SELECT xmin FROM payment WHERE id = $2)::text AS same`, [ls[0].id, p.id]))
        .toEqual({ same: true }); // one transaction wrote the final status and the late success
      expect(await items('capture_mismatch')).not.toContainEqual(expect.objectContaining({ id: f.id }));
      await reconcile();
      expect(await lateSuccesses(p.id)).toHaveLength(1);
    });

    it('a contested wrong-amount fact never becomes a late success at finality; it stays a contradiction (S0-C11)', async () => {
      const { p, a } = await openAfterFailure();
      await capture(a.id, 9100).send();
      await capture(a.id, 9200).send(); // the same provider transaction, another amount: a contradiction of the first fact
      expect(await one(`SELECT count(*)::int AS n FROM provider_transaction_fact_conflict WHERE "paymentId" = $1`, [p.id])).toEqual({ n: 1 });
      await cancel(p.id).expect(200);
      await reconcile();
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await status(p.id)).toBe('cancelled');
    });

    it('the second failed attempt making the payment failed records the late success of the first attempt\'s mismatched capture in that same transition', async () => {
      const { p, a } = await openAfterFailure();
      await capture(a.id, 9050).send();
      expect(await lateSuccesses(p.id)).toEqual([]);
      await start(p.id, 'failure');
      expect(await status(p.id)).toBe('failed');
      expect(await lateSuccesses(p.id)).toEqual([expect.objectContaining({ amount: 9050, paymentStatus: 'failed' })]);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).toHaveLength(1);
    });
  });

  describe('S0-C12 correction (0025): one capture fact, at most one late success, whichever observation', () => {
    /** Every row of the fact, exactly as stored (immutability is checked against it). */
    const factRow = async (id: string) => one(`SELECT * FROM provider_transaction_fact WHERE id = $1`, [id]);
    const effects = async (pid: string) => ({
      lateSuccesses: (await lateSuccesses(pid)).length,
      events: (await outboxOf('payment.late_success.recorded', 'paymentId', pid)).length,
      audits: (await audits('audit.payment_late_success.recorded', pid)).length,
      mismatchAudits: (await audits('audit.payment_capture_mismatch.recorded', pid)).length,
      succeeded: await succeededEvents(pid),
    });

    it('two DISTINCT authenticated notifications of one capture: one fact, one late success (the first observation\'s provenance), one EVT-10, one audit; both notifications stay stored; the same notification replayed adds nothing', async () => {
      const { p, a } = await cancelledAfterFailure();
      const first = capture(a.id, 9100);
      expect((await first.send()).status).toBe(200);
      const [f] = await facts(p.id);
      const stored = await factRow(f.id);
      const firstHook = await one(`SELECT id FROM webhook_event WHERE "providerEventId" = $1`, [first.eventId]);
      const second = capture(a.id, 9100); // the same provider transaction (ptx_<attempt>), a NEW notification id
      expect((await second.send()).status).toBeLessThan(500);
      expect((await first.send()).status).toBe(200); // and the first one replayed
      expect(await facts(p.id)).toEqual([f]);
      expect(await factRow(f.id), 'the fact is immutable').toEqual(stored);
      expect(await one(`SELECT source, "webhookEventId", "factId" FROM payment_late_success WHERE "paymentId" = $1`, [p.id]))
        .toEqual({ source: 'webhook', webhookEventId: firstHook.id, factId: f.id });
      expect(await effects(p.id)).toEqual({ lateSuccesses: 1, events: 1, audits: 1, mismatchAudits: 1, succeeded: 0 });
      expect(await webhookState(second.eventId), 'the second notification is stored as received').toBeDefined();
      expect(await items('late_success')).toEqual(expect.arrayContaining([expect.objectContaining({ paymentId: p.id, factId: f.id })]));
      expect((await items('late_success')).filter((i) => i.factId === f.id)).toHaveLength(1);
      expect(await status(p.id)).toBe('cancelled');
    });

    it('an EQUAL capture observed twice on a failed payment (the unchanged correct-amount late success): one record matching the payment, one event, one audit', async () => {
      const { p, a } = await openAfterFailure();
      const b = await start(p.id, 'failure');
      expect(await status(p.id)).toBe('failed');
      await capture(b.id, 9000).send();
      await capture(b.id, 9000).send();
      expect(await effects(p.id)).toEqual({ lateSuccesses: 1, events: 1, audits: 1, mismatchAudits: 0, succeeded: 0 });
      expect((await audits('audit.payment_late_success.recorded', p.id))[0].changes).toMatchObject({ matches_payment: true, observed_amount: 9000 });
      expect(a.id).not.toBe(b.id);
    });

    it('concurrent distinct notifications of one capture cannot bypass the database: exactly one late success, one event, one audit', async () => {
      const { p, a } = await cancelledAfterFailure();
      const notes = Array.from({ length: 6 }, () => capture(a.id, 9100));
      const res = await Promise.all(notes.map((n) => n.send()));
      expect(res.every((r) => r.status < 500), JSON.stringify(res.map((r) => r.status))).toBe(true);
      expect(await facts(p.id)).toHaveLength(1);
      expect(await effects(p.id)).toEqual({ lateSuccesses: 1, events: 1, audits: 1, mismatchAudits: 1, succeeded: 0 });
      expect(await count(`SELECT count(*)::int AS n FROM webhook_event WHERE "providerEventId" = ANY($1)`, [notes.map((n) => n.eventId)])).toBe(6);
    });

    it('the observation path racing the CaptureReconciler: a lost first processing, then a second notification and reconciler passes at once: one late success', async () => {
      const { p, a } = await cancelledAfterFailure();
      const svc = t.app.get(AttemptService);
      const spy = vi.spyOn(svc as unknown as { recordLateSuccess: () => Promise<void> }, 'recordLateSuccess').mockRejectedValueOnce(new Error('simulated crash after the fact committed'));
      expect((await capture(a.id, 9100).send()).status).toBe(500);
      spy.mockRestore();
      const [f] = await facts(p.id);
      const stored = await factRow(f.id);
      expect(await lateSuccesses(p.id)).toEqual([]);
      const [, ...passes] = await Promise.all([capture(a.id, 9100).send(), reconcile(), reconcile()]);
      await reconcile();
      expect(await effects(p.id)).toEqual({ lateSuccesses: 1, events: 1, audits: 1, mismatchAudits: 1, succeeded: 0 });
      expect(passes.reduce((n, r) => n + r.recorded, 0)).toBeLessThanOrEqual(1);
      expect(await factRow(f.id)).toEqual(stored);
    });

    it('the reconciler and an observation\'s open insert of the fact\'s late success never interleave: the pass skips the locked payment, then finds the late success: nothing recorded, no failure', async () => {
      const { p, a } = await cancelledAfterFailure();
      const svc = t.app.get(AttemptService);
      const spy = vi.spyOn(svc as unknown as { recordLateSuccess: () => Promise<void> }, 'recordLateSuccess').mockRejectedValueOnce(new Error('simulated crash after the fact committed'));
      expect((await capture(a.id, 9100).send()).status).toBe(500);
      spy.mockRestore();
      const [f] = await facts(p.id);
      // LABELLED: the observation path's own insert for a second notification, held open in a test transaction (the row only: what that path writes first)
      const held = await admin.connect();
      let open = false;
      try {
        await held.query('BEGIN');
        open = true;
        const hook = (await held.query(`INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('test', $1, 'payment.succeeded', '\\x7b7d') RETURNING id`,
          [`evt_${crypto.randomUUID()}`])).rows[0].id;
        await held.query(`INSERT INTO payment_late_success ("paymentId", "attemptId", source, "webhookEventId", amount, currency, "paymentStatus", "factId")
          VALUES ($1, $2, 'webhook', $3, 9100, 'TND', 'cancelled', $4)`, [p.id, a.id, hook, f.id]);
        // the open insert holds its payment row (foreign key): the pass skips that payment (SKIP LOCKED), it never writes beside it
        expect(await reconcile()).toEqual({ recorded: 0 });
        await held.query('COMMIT');
        open = false;
      } finally {
        if (open) await held.query('ROLLBACK');
        held.release();
      }
      expect(await reconcile(), 'after the commit the fact has its late success').toEqual({ recorded: 0 });
      expect(await lateSuccesses(p.id)).toHaveLength(1);
      expect((await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).length, 'the reconciler wrote no event').toBe(0);
      expect((await audits('audit.payment_late_success.recorded', p.id)).length, 'the reconciler wrote no audit').toBe(0);
    });

    it('the finality writer racing a second observation: a mismatched capture on an open payment, then the cancel and another notification of it at once: one late success', async () => {
      const { p, a } = await openAfterFailure();
      await capture(a.id, 9100).send();
      expect(await lateSuccesses(p.id)).toEqual([]);
      await Promise.all([cancel(p.id), capture(a.id, 9100).send()]);
      expect(await status(p.id)).toBe('cancelled');
      expect(await effects(p.id)).toEqual({ lateSuccesses: 1, events: 1, audits: 1, mismatchAudits: 1, succeeded: 0 });
    });

    it('the database refuses a second late success of a fact under another observation key (payment_late_success_one_per_fact)', async () => {
      const { p, a } = await cancelledAfterFailure();
      const second = capture(a.id, 9100);
      await capture(a.id, 9100).send();
      await second.send();
      const [f] = await facts(p.id);
      const hook = await one(`SELECT id FROM webhook_event WHERE "providerEventId" = $1`, [second.eventId]);
      await expect(admin.query(`INSERT INTO payment_late_success ("paymentId", "attemptId", source, "webhookEventId", amount, currency, "paymentStatus", "factId")
        VALUES ($1, $2, 'webhook', $3, 9100, 'TND', 'cancelled', $4)`, [p.id, a.id, hook.id, f.id])).rejects.toMatchObject({ code: '23505', constraint: 'payment_late_success_one_per_fact' });
      expect(await lateSuccesses(p.id)).toHaveLength(1);
    });
  });

  describe('S0-C12 item 6: the expired and closing finality writers', () => {
    const sameTransaction = async (lsId: string, pid: string) => (await one(`SELECT (SELECT xmin FROM payment_late_success WHERE id = $1)::text = (SELECT xmin FROM payment WHERE id = $2)::text AS same`, [lsId, pid])).same;

    it('the expiry sweep: an open payment with a mismatched capture expires; one late success in that transaction; a reconciler pass adds nothing', async () => {
      const p = await create({ expiresAt: new Date(Date.now() + 1200).toISOString() });
      const a = await start(p.id, 'failure');
      await capture(a.id, 9100).send();
      expect(await lateSuccesses(p.id)).toEqual([]);
      await new Promise((r) => setTimeout(r, 1500));
      await t.app.get(ExpirySweeper).sweepOnce();
      expect(await status(p.id)).toBe('expired');
      const ls = await lateSuccesses(p.id);
      expect(ls).toEqual([expect.objectContaining({ amount: 9100, paymentStatus: 'expired' })]);
      expect(await sameTransaction(ls[0].id, p.id)).toBe(true);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).toHaveLength(1);
      await reconcile();
      expect(await lateSuccesses(p.id)).toHaveLength(1);
    });

    it('closing: a mismatched capture of its open attempt leaves the payment closing and the attempt unchanged (N1, a visible item); the provider\'s failure ends it expired with one late success in that transaction', async () => {
      const p = await create({ expiresAt: new Date(Date.now() + 1500).toISOString() });
      const a = await start(p.id, 'timeout_after_accept');
      await new Promise((r) => setTimeout(r, 1700));
      await t.app.get(ExpirySweeper).sweepOnce();
      expect(await status(p.id)).toBe('closing');
      const attemptBefore = (await one(`SELECT status FROM payment_attempt WHERE id = $1`, [a.id])).status;
      await capture(a.id, 9100).send();
      expect(await status(p.id)).toBe('closing');
      expect((await one(`SELECT status FROM payment_attempt WHERE id = $1`, [a.id])).status, 'item 1: no attempt state changes').toBe(attemptBefore);
      expect(await lateSuccesses(p.id)).toEqual([]);
      const [f] = await facts(p.id);
      expect(await items('capture_mismatch')).toContainEqual(expect.objectContaining({ id: f.id, detail: expect.objectContaining({ reason: 'amount_mismatch' }) }));
      const failed = signed({ eventId: `evt_fail_${crypto.randomUUID()}`, type: 'payment.failed', reference: a.id, data: { failureCode: 'card_declined' } });
      expect((await post(failed.raw, failed.signature)).status).toBe(200);
      expect(await status(p.id)).toBe('expired');
      const ls = await lateSuccesses(p.id);
      expect(ls).toEqual([expect.objectContaining({ amount: 9100, factId: f.id, paymentStatus: 'expired' })]);
      expect(await sameTransaction(ls[0].id, p.id)).toBe(true);
    });
  });

  describe('S0-C12 item 14: the capture read states how many capture facts an attempt holds', () => {
    const read = async (pid: string, factId: string) => (await request(server()).get(`/payment/payments/${pid}/captures/${factId}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
    const factOf = async (txn: string) => (await one(`SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'capture'`, [txn])).id as string;
    /** A second provider reference on the attempt: this test provider's notifications always name `ptx_<attempt>`, so the sibling comes through a status read. */
    const sibling = (aid: string, txn: string, amount: number) => t.app.get(AttemptService)
      .applyStatus(aid, { kind: 'succeeded', amount, currency: 'TND', providerTransactionId: txn } as never, {} as never).catch((e: unknown) => e);

    it('from committed facts only: 1 for a sole fact, a contradiction adds none; 2 on both once a distinct reference exists, contested or not; existing fields unchanged; another attempt never counts', async () => {
      const { p, a } = await cancelledAfterFailure();
      await capture(a.id, 9100).send();
      const f1 = await factOf(`ptx_${a.id}`);
      expect(await read(p.id, f1)).toMatchObject({ factId: f1, paymentId: p.id, amount: 9100, currency: 'TND', paymentStatus: 'cancelled', basis: 'late_capture', conflicted: false, refund: 'none', refundableOnItsOwn: true, attemptCaptures: 1 });
      await capture(a.id, 9200).send(); // the same reference, another figure: a contradiction, not a fact
      expect(await read(p.id, f1)).toMatchObject({ conflicted: true, attemptCaptures: 1 });
      await sibling(a.id, `ptx_b_${a.id}`, 9000);
      const f2 = await factOf(`ptx_b_${a.id}`);
      expect((await read(p.id, f1)).attemptCaptures).toBe(2);
      expect((await read(p.id, f2)).attemptCaptures).toBe(2);
      const other = await create();
      const x = await start(other.id, 'failure');
      const y = await start(other.id, 'failure');
      await capture(x.id, 9100).send();
      await capture(y.id, 9100).send();
      expect((await read(other.id, await factOf(`ptx_${x.id}`))).attemptCaptures, 'per attempt, not per payment').toBe(1);
      expect((await read(other.id, await factOf(`ptx_${y.id}`))).attemptCaptures).toBe(1);
    });

    it('a notification cannot state the count: Payment derives it from its committed facts only', async () => {
      const { p, a } = await cancelledAfterFailure();
      const n = signed({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', reference: a.id, amount: 9100, currency: 'TND', attemptCaptures: 99 });
      await post(n.raw, n.signature);
      expect((await read(p.id, await factOf(`ptx_${a.id}`))).attemptCaptures).toBe(1);
    });

    it('a caller with no valid service token reads nothing of the count', async () => {
      const { p, a } = await cancelledAfterFailure();
      await capture(a.id, 9100).send();
      const factId = await factOf(`ptx_${a.id}`);
      const r = await request(server()).get(`/payment/payments/${p.id}/captures/${factId}`).set('authorization', `Bearer ${generateServiceToken().token}`);
      expect(r.status).toBeGreaterThanOrEqual(401);
      expect(JSON.stringify(r.body)).not.toContain('attemptCaptures');
    });
  });

  describe('S0-C12 FN-2: a capture seen while the payment is non-final stays a fact; its late success is decided at terminal finality, once', () => {
    const lateEventsOf = async (pid: string) => (await outboxOf('payment.late_success.recorded', 'paymentId', pid)).length;
    const same = async (lsId: string, pid: string) => (await one(`SELECT (SELECT xmin FROM payment_late_success WHERE id = $1)::text = (SELECT xmin FROM payment WHERE id = $2)::text AS same`, [lsId, pid])).same;
    const failedNote = (aid: string) => { const n = signed({ eventId: `evt_fail_${crypto.randomUUID()}`, type: 'payment.failed', reference: aid, data: { failureCode: 'card_declined' } }); return post(n.raw, n.signature); };
    const statusRead = (aid: string, amount = 9000, txn?: string) => t.app.get(AttemptService)
      .applyStatus(aid, { kind: 'succeeded', amount, currency: 'TND', ...(txn ? { providerTransactionId: txn } : {}) } as never, {} as never).catch((e: unknown) => e);
    /** Deferred: the fact, the conflict answer, nothing else, while the Owner can already see it. */
    const deferred = async (pid: string, st: string) => {
      expect(await status(pid)).toBe(st);
      const fs = await facts(pid);
      expect(fs).toHaveLength(1);
      expect(await lateSuccesses(pid), 'no late success while non-final').toEqual([]);
      expect(await lateEventsOf(pid), 'no premature EVT-10').toBe(0);
      expect(await audits('audit.payment_late_success.recorded', pid)).toEqual([]);
      expect(await succeededEvents(pid)).toBe(0);
      expect((await items('capture_refund_unavailable')).filter((i) => i.factId === fs[0].id), 'visible meanwhile').toEqual([expect.objectContaining({ detail: { reason: 'late_capture' } })]);
      return fs[0];
    };
    const decided = async (pid: string, factId: string, st: string) => {
      expect(await status(pid)).toBe(st);
      const ls = await lateSuccesses(pid);
      expect(ls).toEqual([expect.objectContaining({ factId, amount: 9000, currency: 'TND', paymentStatus: st })]);
      expect(await same(ls[0].id, pid), 'in the finality transaction itself').toBe(true);
      expect(await lateEventsOf(pid)).toBe(1);
      expect(await audits('audit.payment_late_success.recorded', pid)).toHaveLength(1);
      expect(await succeededEvents(pid)).toBe(0);
    };

    it('created, then failed by the attempt limit: decided at that finality; replays and a status read add nothing', async () => {
      const { p, a } = await openAfterFailure();
      const note = capture(a.id, 9000);
      expect((await note.send()).status).toBe(200);
      expect(await webhookState(note.eventId), 'the same recorded conflict as before').toMatchObject({ state: 'conflict', outcome: 'invalid_state_transition' });
      const f = await deferred(p.id, 'created');
      await start(p.id, 'failure');
      await decided(p.id, f.id, 'failed');
      expect((await note.send()).status).toBe(200);
      await capture(a.id, 9000).send();
      await statusRead(a.id);
      await reconcile();
      await decided(p.id, f.id, 'failed');
    });

    it('created, then cancelled: decided in the cancel; a status read first, then the notification of the same capture: one fact, first provenance', async () => {
      const { p, a } = await openAfterFailure();
      await statusRead(a.id, 9000, `ptx_${a.id}`);
      const f = await deferred(p.id, 'created');
      expect(f.source).toBe('status_check');
      await capture(a.id, 9000).send();
      expect(await facts(p.id)).toHaveLength(1);
      expect((await cancel(p.id)).status).toBe(200);
      await decided(p.id, f.id, 'cancelled');
    });

    it('pending: another attempt is open; a provider-confirmed failure of it ends the payment failed and decides the earlier capture', async () => {
      const { p, a } = await openAfterFailure();
      const b = await start(p.id, 'timeout_before_accept');
      const during = await status(p.id);
      expect(['pending', 'created']).toContain(during);
      await capture(a.id, 9000).send();
      const f = await deferred(p.id, during);
      expect((await failedNote(b.id)).status).toBe(200);
      await decided(p.id, f.id, 'failed');
    });

    it('expired by the sweep, and closing then expired: decided in each writer', async () => {
      const p = await create({ expiresAt: new Date(Date.now() + 1200).toISOString() });
      const a = await start(p.id, 'failure');
      await capture(a.id, 9000).send();
      const f = await deferred(p.id, 'created');
      await new Promise((r) => setTimeout(r, 1500));
      await t.app.get(ExpirySweeper).sweepOnce();
      await decided(p.id, f.id, 'expired');

      const q = await create({ expiresAt: new Date(Date.now() + 2500).toISOString() });
      const a1 = await start(q.id, 'failure');
      const a2 = await start(q.id, 'timeout_before_accept');
      await new Promise((r) => setTimeout(r, 2700));
      await t.app.get(ExpirySweeper).sweepOnce();
      expect(await status(q.id)).toBe('closing');
      await capture(a1.id, 9000).send();
      const g = await deferred(q.id, 'closing');
      expect((await failedNote(a2.id)).status).toBe(200);
      await decided(q.id, g.id, 'expired');
    });

    it('another attempt settles: no late success, the capture stays other_attempt_capture; nothing is emitted for it', async () => {
      const { p, a } = await openAfterFailure();
      const b = await start(p.id, 'timeout_before_accept');
      await capture(a.id, 9000).send();
      const [f] = await facts(p.id);
      await capture(b.id, 9000).send();
      expect(await status(p.id)).toBe('succeeded');
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await lateEventsOf(p.id)).toBe(0);
      expect(await succeededEvents(p.id)).toBe(1);
      expect((await items('capture_refund_unavailable')).filter((i) => i.factId === f.id)).toEqual([expect.objectContaining({ detail: { reason: 'other_attempt_capture' } })]);
      await reconcile();
      expect(await lateSuccesses(p.id)).toEqual([]);
    });

    it('crash recovery from committed state only: a fact whose processing died before finality is decided by the finality; one committed after finality and lost is recovered by the reconciler; neither is stranded', async () => {
      const { p, a } = await openAfterFailure();
      const svc = t.app.get(AttemptService);
      // LABELLED: the process dies after FC-1: the fact is committed and nothing else happened (no in-memory state survives)
      await admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source) VALUES ('test', $1, 'capture', $2, $3, 9000, 'TND', false, 'status_check')`, [`ptx_${a.id}`, p.id, a.id]);
      const [f] = await facts(p.id);
      await start(p.id, 'failure');
      await decided(p.id, f.id, 'failed');
      const late = await cancelledAfterFailure();
      const spy = vi.spyOn(svc as unknown as { recordLateSuccess: () => Promise<void> }, 'recordLateSuccess').mockRejectedValueOnce(new Error('simulated crash after the fact committed'));
      expect((await capture(late.a.id, 9000).send()).status).toBe(500);
      spy.mockRestore();
      expect(await lateSuccesses(late.p.id)).toEqual([]);
      expect((await reconcile()).recorded).toBe(1);
      expect(await lateSuccesses(late.p.id)).toEqual([expect.objectContaining({ amount: 9000, paymentStatus: 'cancelled' })]);
      expect(await lateEventsOf(late.p.id)).toBe(1);
    });
  });

  describe('S0-C12 item 14: several capture facts on one attempt', () => {
    const lateEventsOf = async (pid: string) => (await outboxOf('payment.late_success.recorded', 'paymentId', pid)).length;
    const sibling = (aid: string, txn: string, amount: number) => t.app.get(AttemptService).applyStatus(aid, { kind: 'succeeded', amount, currency: 'TND', providerTransactionId: txn } as never, {} as never).catch((e: unknown) => e);

    it('before finality: both facts stay; neither has a late success at finality, whatever the amounts; both remain visible', async () => {
      const { p, a } = await openAfterFailure();
      await capture(a.id, 9100).send();
      await sibling(a.id, `ptx_s_${a.id}`, 9000);
      expect((await cancel(p.id)).status).toBe(200);
      expect(await facts(p.id)).toHaveLength(2);
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await lateEventsOf(p.id)).toBe(0);
      expect((await reconcile()).recorded).toBe(0);
      expect(await lateSuccesses(p.id)).toEqual([]);
    });

    it('a second capture after a committed late success: the first stands; the second has none, on either channel, whichever amount; an equal capture after a wrong amount gets nothing', async () => {
      const { p, a } = await cancelledAfterFailure();
      await capture(a.id, 9100).send();
      const [first] = await lateSuccesses(p.id);
      const stored = await one(`SELECT * FROM payment_late_success WHERE id = $1`, [first.id]);
      await sibling(a.id, `ptx_s_${a.id}`, 9000); // the equal amount, after the wrong one
      const n = signed({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.failed', reference: a.id, data: { failureCode: 'x' } });
      await post(n.raw, n.signature);
      expect(await facts(p.id)).toHaveLength(2);
      expect(await lateSuccesses(p.id)).toEqual([first]);
      expect(await one(`SELECT * FROM payment_late_success WHERE id = $1`, [first.id]), 'the committed record is untouched').toEqual(stored);
      expect(await lateEventsOf(p.id)).toBe(1);
      expect(await succeededEvents(p.id)).toBe(0);
      expect((await reconcile()).recorded).toBe(0);
      expect(await lateSuccesses(p.id)).toEqual([first]);
    });

    it('a contested sibling makes the attempt ambiguous too; different attempts of one payment are not ambiguous', async () => {
      const c = await cancelledAfterFailure();
      await capture(c.a.id, 9100).send();
      await capture(c.a.id, 9200).send(); // contradiction: contested, not a second fact
      expect(await facts(c.p.id)).toHaveLength(1);
      const other = await create();
      const x = await start(other.id, 'failure');
      const y = await start(other.id, 'failure');
      await capture(x.id, 9000).send();
      await capture(y.id, 9000).send();
      expect((await lateSuccesses(other.id)).map((l) => l.paymentStatus)).toEqual(['failed', 'failed']);
      const z = await openAfterFailure();
      await capture(z.a.id, 9100).send();
      await capture(z.a.id, 9200).send();
      await sibling(z.a.id, `ptx_t_${z.a.id}`, 9000);
      expect((await cancel(z.p.id)).status).toBe(200);
      expect(await lateSuccesses(z.p.id)).toEqual([]);
    });

    it('the lock: a fact insert waits for a decision holding the payment, and a decision waits for a fact being inserted; neither deadlocks nor aborts', async () => {
      const { p, a } = await openAfterFailure();
      const held = await admin.connect();
      const waiting = async () => (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT 1 FROM payment WHERE id = $1 FOR KEY SHARE%'`)).rowCount;
      let observed = false;
      let open = false;
      try {
        await held.query('BEGIN');
        open = true;
        await held.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p.id]);
        const note = capture(a.id, 9000).send().then((r) => r);
        const deadline = Date.now() + 10_000;
        while (!observed && Date.now() < deadline) { observed = Number(await waiting()) > 0; if (!observed) await new Promise((r) => setTimeout(r, 25)); }
        expect(observed, 'the fact insert waits for the decision').toBe(true);
        expect(await facts(p.id), 'not committed under the decision').toEqual([]);
        await held.query('COMMIT');
        open = false;
        expect((await note).status).toBeLessThan(500);
      } finally {
        if (open) await held.query('ROLLBACK');
        held.release();
      }
      expect(await facts(p.id)).toHaveLength(1);
      expect((await cancel(p.id)).status).toBe(200);
      expect(await lateSuccesses(p.id)).toEqual([expect.objectContaining({ amount: 9000, paymentStatus: 'cancelled' })]);
    });

    it('fact insertion racing every finality, many times: finality is never aborted, at most one late success per attempt, every late success has its event and audit, and no ambiguous attempt gains one', async () => {
      for (let i = 0; i < 12; i++) {
        const { p, a } = await openAfterFailure();
        await capture(a.id, 9000).send();
        const [cancelled, , ] = await Promise.all([cancel(p.id), sibling(a.id, `ptx_r_${a.id}`, 9100), capture(a.id, 9000).send()]);
        expect(cancelled.status, `round ${i}`).toBe(200);
        expect(await status(p.id)).toBe('cancelled');
        const ls = await lateSuccesses(p.id);
        expect(ls.length, `round ${i}`).toBeLessThanOrEqual(1);
        expect(await lateEventsOf(p.id)).toBe(ls.length);
        expect(await audits('audit.payment_late_success.recorded', p.id)).toHaveLength(ls.length);
        expect(await facts(p.id)).toHaveLength(2);
        await reconcile();
        expect(await lateSuccesses(p.id)).toHaveLength(ls.length);
      }
    });
  });

  describe('S0-C12 item 15: bounded, fair recovery with durable state', () => {
    const lost = async () => {
      const x = await cancelledAfterFailure();
      const spy = vi.spyOn(t.app.get(AttemptService) as unknown as { recordLateSuccess: () => Promise<void> }, 'recordLateSuccess').mockRejectedValueOnce(new Error('simulated crash after the fact committed'));
      expect((await capture(x.a.id, 9100).send()).status).toBe(500);
      spy.mockRestore();
      return { ...x, factId: (await facts(x.p.id))[0].id as string };
    };
    const state = async (factId: string) => one(`SELECT attempts, status, "lastFailure", "workAfter" IS NOT NULL AS due, "endedAt" IS NOT NULL AS ended FROM capture_recovery_state WHERE "factId" = $1`, [factId]);
    const makeDue = (factId: string) => admin.query(`UPDATE capture_recovery_state SET "workAfter" = now() WHERE "factId" = $1 AND status = 'active'`, [factId]);
    /** The next `n` fact transactions fail as `e`; the selection and everything else stay real. */
    const failing = (e: unknown, match: (i: number) => boolean = () => true) => {
      const db = t.app.get(DbService);
      const tx = db.tx.bind(db);
      let i = 0;
      return vi.spyOn(db, 'tx').mockImplementation((async (work: never) => { if (match(i++)) throw e; return tx(work); }) as never);
    };

    it('the schedule: 2^n seconds for attempts 1 to 11, about 68 minutes, no cap reached; infrastructure pause 30 s doubling to 15 minutes; classes', () => {
      expect(CAPTURE_RECOVERY_MAX_ATTEMPTS).toBe(12);
      expect(Array.from({ length: 11 }, (_, i) => captureRecoveryWaitSeconds(i + 1))).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]);
      expect(Array.from({ length: 11 }, (_, i) => captureRecoveryWaitSeconds(i + 1)).reduce((a, b) => a + b, 0)).toBe(4094);
      expect([1, 2, 3, 4, 5, 6, 7, 40].map(captureInfrastructurePauseMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
      for (const [code, cls] of [['08006', 'infrastructure'], ['53300', 'infrastructure'], ['57P01', 'infrastructure'], ['ECONNREFUSED', 'infrastructure'], ['40001', 'transient'], ['40P01', 'transient'], ['55P03', 'transient'], ['57014', 'transient'], ['23514', 'permanent'], ['23505', 'permanent'], ['42P01', 'unknown']] as const) {
        expect(classifyCaptureRecoveryFailure(Object.assign(new Error('x'), { code })), code).toBe(cls);
      }
      expect(classifyCaptureRecoveryFailure(new Error('boom'))).toBe('unknown');
    });

    it('a transient failure counts once and waits; at 12 it is durably exhausted, visible to the Owner kind, the fact kept; no more attempts; a provider redelivery still completes it', async () => {
      const { p, a, factId } = await lost();
      const spy = failing(Object.assign(new Error('x'), { code: '40001' }));
      try {
        await reconcile();
        expect(await state(factId)).toMatchObject({ attempts: 1, status: 'active', lastFailure: 'transient_failure', due: true, ended: false });
        await reconcile();
        expect((await state(factId)).attempts, 'not due: not attempted').toBe(1);
        for (let n = 2; n <= 12; n++) {
          await makeDue(factId);
          await reconcile();
          expect((await state(factId)).attempts).toBe(n);
        }
        expect(await state(factId)).toMatchObject({ attempts: 12, status: 'exhausted', due: false, ended: true });
        await makeDue(factId);
        await reconcile();
        expect((await state(factId)).attempts, 'no 13th').toBe(12);
      } finally {
        spy.mockRestore();
      }
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect((await reconcile()).recorded, 'exhausted facts are no longer selected').toBe(0);
      const exhausted = await admin.query(`SELECT s.status FROM capture_recovery_state s WHERE s."factId" = $1`, [factId]);
      expect(exhausted.rows).toEqual([{ status: 'exhausted' }]);
      expect((await facts(p.id))[0].id).toBe(factId);
      expect((await capture(a.id, 9100).send()).status).toBe(200);
      expect(await lateSuccesses(p.id)).toEqual([expect.objectContaining({ amount: 9100 })]);
    });

    it('a guard refusing an eligible fact is permanent: refused at once, visible, not retried; state survives a new worker instance', async () => {
      const { factId } = await lost();
      const spy = failing(Object.assign(new Error('x'), { code: '23514' }));
      try {
        await reconcile();
      } finally {
        spy.mockRestore();
      }
      expect(await state(factId)).toMatchObject({ attempts: 1, status: 'refused', lastFailure: 'permanent_refusal', ended: true });
      const fresh = new CaptureReconciler(t.app.get(DbService), t.app.get(OutboxService), t.app.get(PaymentAudit));
      expect((await fresh.reconcileOnce()).recorded, 'a restarted worker reads the same durable state').toBe(0);
    });

    it('fairness: one fact failing never holds another; 100 older ambiguous facts consume no attempt and hold nothing back', async () => {
      const amb = await cancelledAfterFailure();
      await admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source, "observedAt")
        SELECT 'test', 'ptx_old_' || i || '_' || $3::text, 'capture', $1::uuid, $2::uuid, 9100, 'TND', false, 'status_check', now() - interval '1 day' FROM generate_series(1, 100) i`, [amb.p.id, amb.a.id, amb.a.id]);
      const one1 = await lost();
      const two = await lost();
      const spy = failing(Object.assign(new Error('x'), { code: '40001' }), (i) => i === 0);
      try {
        expect((await reconcile()).recorded, 'the second fact proceeds in the same pass').toBe(1);
      } finally {
        spy.mockRestore();
      }
      expect((await lateSuccesses(one1.p.id)).length + (await lateSuccesses(two.p.id)).length).toBe(1);
      expect(Number((await one(`SELECT count(*) AS n FROM capture_recovery_state s JOIN provider_transaction_fact f ON f.id = s."factId" WHERE f."paymentId" = $1`, [amb.p.id])).n), 'ambiguous facts consume nothing').toBe(0);
      await admin.query(`UPDATE capture_recovery_state SET "workAfter" = now() WHERE status = 'active'`);
      await reconcile();
      expect(await lateSuccesses(one1.p.id)).toHaveLength(1);
      expect(await lateSuccesses(two.p.id)).toHaveLength(1);
    });

    it('competing passes count one attempt and record one late success', async () => {
      const { p, factId } = await lost();
      const mine = t.app.get(CaptureReconciler);
      const other = new CaptureReconciler(t.app.get(DbService), t.app.get(OutboxService), t.app.get(PaymentAudit));
      const passes = await Promise.all([mine.reconcileOnce(), other.reconcileOnce()]);
      expect(passes.reduce((n, r) => n + r.recorded, 0)).toBe(1);
      expect(await lateSuccesses(p.id)).toHaveLength(1);
      expect(await one(`SELECT count(*)::int AS n FROM capture_recovery_state WHERE "factId" = $1`, [factId])).toEqual({ n: 0 });
    });

    it('an infrastructure failure consumes no attempt; the worker pauses, doubling, doing no database work while paused; it recovers by itself', async () => {
      const { p, factId } = await lost();
      const worker = new CaptureReconciler(t.app.get(DbService), t.app.get(OutboxService), t.app.get(PaymentAudit));
      let clock = Date.now();
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const db = t.app.get(DbService);
      const down = Object.assign(new Error('x'), { code: '08006' });
      const query = vi.spyOn(db, 'query').mockRejectedValue(down);
      try {
        expect(await worker.reconcileOnce()).toEqual({ recorded: 0 });
        const calls = query.mock.calls.length;
        expect(await worker.reconcileOnce(), 'paused').toEqual({ recorded: 0, paused: true });
        expect(query.mock.calls.length, 'no database work while paused').toBe(calls);
        clock += 29_000;
        expect((await worker.reconcileOnce()).paused).toBe(true);
        clock += 1_001;
        await worker.reconcileOnce(); // second failure: 60 s
        clock += 59_000;
        expect((await worker.reconcileOnce()).paused).toBe(true);
        clock += 1_001;
        await worker.reconcileOnce();
        for (let i = 0; i < 8; i++) { clock += 900_001; await worker.reconcileOnce(); }
        clock += 899_000;
        expect((await worker.reconcileOnce()).paused, 'capped at 15 minutes').toBe(true);
        query.mockRestore();
        clock += 1_001;
        expect((await worker.reconcileOnce()).recorded, 'recovery resumes by itself').toBe(1);
        expect(await one(`SELECT count(*)::int AS n FROM capture_recovery_state WHERE "factId" = $1`, [factId]), 'no attempt was consumed').toEqual({ n: 0 });
        expect(await lateSuccesses(p.id)).toHaveLength(1);
        expect((await worker.reconcileOnce()).paused, 'the pause is over').toBeUndefined();
      } finally {
        query.mockRestore();
        now.mockRestore();
      }
    });

    it('a mid-pass infrastructure failure stops the pass and charges no fact', async () => {
      const a = await lost();
      const spy = failing(Object.assign(new Error('x'), { code: '53300' }));
      const worker = new CaptureReconciler(t.app.get(DbService), t.app.get(OutboxService), t.app.get(PaymentAudit));
      try {
        expect(await worker.reconcileOnce()).toEqual({ recorded: 0 });
      } finally {
        spy.mockRestore();
      }
      expect(await one(`SELECT count(*)::int AS n FROM capture_recovery_state WHERE "factId" = $1`, [a.factId])).toEqual({ n: 0 });
      await reconcile();
      expect(await lateSuccesses(a.p.id)).toHaveLength(1);
    });
  });

  describe('S0-C12 item 7: the interrupted window', () => {
    it('a crash after the fact committed and before its late success: the reconciler completes it once; the provider\'s retry and repeated or concurrent passes add nothing', async () => {
      const { p, a } = await cancelledAfterFailure();
      const svc = t.app.get(AttemptService);
      const spy = vi.spyOn(svc as unknown as { recordLateSuccess: () => Promise<void> }, 'recordLateSuccess').mockRejectedValueOnce(new Error('simulated crash after the fact committed'));
      const c = capture(a.id, 9100);
      expect((await c.send()).status).toBe(500); // transient: the provider retries
      spy.mockRestore();
      const [f] = await facts(p.id);
      expect(f).toMatchObject({ amount: 9100 });
      expect(await lateSuccesses(p.id)).toEqual([]);
      const passes = await Promise.all([reconcile(), reconcile(), reconcile()]);
      expect(passes.reduce((n, r) => n + r.recorded, 0)).toBe(1);
      await reconcile();
      const ls = await lateSuccesses(p.id);
      expect(ls).toEqual([{ id: expect.any(String), amount: 9100, currency: 'TND', factId: f.id, paymentStatus: 'cancelled' }]);
      expect((await audits('audit.payment_late_success.recorded', p.id))).toEqual([expect.objectContaining({ actor: { type: 'system', id: 'payment_capture_reconciler' } })]);
      // the provider retries the very notification: its processing meets the reconciler's row (the same observation key): nothing new
      expect((await c.send()).status).toBe(200);
      expect(await lateSuccesses(p.id)).toHaveLength(1);
      expect(await outboxOf('payment.late_success.recorded', 'paymentId', p.id)).toHaveLength(1);
      expect(await audits('audit.payment_late_success.recorded', p.id)).toHaveLength(1);
      expect(await status(p.id)).toBe('cancelled');
      expect(await succeededEvents(p.id)).toBe(0);
    });

    it('the reconciler touches nothing it must not: an open payment\'s fact, a contested fact, a succeeded payment', async () => {
      const open = await openAfterFailure();
      await capture(open.a.id, 9100).send();
      const s = await create();
      await start(s.id, 'success');
      await reconcile();
      expect(await lateSuccesses(open.p.id)).toEqual([]);
      expect(await status(open.p.id)).toBe('created');
      expect(await lateSuccesses(s.id)).toEqual([]);
    });
  });
});
