import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { CaptureReconciler } from '../src/payments/capture-reconciler.js';
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
        PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '2', AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token,
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
