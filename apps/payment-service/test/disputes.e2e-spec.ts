import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { DisputeEvidenceFiles, GrantedEvidence } from '../src/disputes/dispute-evidence-files.js';
import { ownerAuthorityUnavailable, type OwnerCompanyAuthority, type VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY2 = '6c1d3e5f-2a4b-4d7c-9e0f-1a2b3c4d5e6f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OWNER2 = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
const MEMBER = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Core V2 S6e-D payment disputes (register PAY-09 to PAY-11, EVT-03; ADR-0044 B10; S0 FC-1, FC-4, FC-5, D3; the Owner's R6E-1 to R6E-9) through
 * the REAL application on real PostgreSQL 16, on the simulation provider: signed provider notifications through the webhook pipeline, the
 * authorized harness, Auth's receipt routes over real HTTP (a contract-faithful stand-in), the live Owner check and File's grant read as test
 * ports. Development and simulation only.
 */
describeWithEnv('payment disputes (Core V2 S6e-D) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: OWNER, adminTier: 'owner', isActive: true, memberships: [] },
    'owner2-jwt': { id: OWNER2, adminTier: 'owner', isActive: true, memberships: [] },
    'member-jwt': { id: MEMBER, adminTier: null, isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const owners: Record<string, VerifiedOwner> = { 'owner-jwt': { userId: OWNER, companyId: COMPANY }, 'owner2-jwt': { userId: OWNER2, companyId: COMPANY2 } };
  const ownerState = { down: false };
  const ownerAuthority: OwnerCompanyAuthority = {
    owner: async (bearer) => {
      if (ownerState.down) throw ownerAuthorityUnavailable(); // the HTTP client's answer when Auth cannot say
      return owners[bearer] ?? null;
    },
  };
  /** File's grant read: grants the test registers (grantId → evidence); `down` makes File unanswerable. */
  const fileState = { down: false, grants: new Map<string, GrantedEvidence>() };
  const evidenceFiles: DisputeEvidenceFiles = {
    granted: async (grantId, fileId) => {
      if (fileState.down) throw new Error('file down');
      const g = fileState.grants.get(grantId);
      return g && g.fileId === fileId ? g : null;
    },
  };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;

  const createPayment = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
    paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
    seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
  }).expect(201)).body;
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const sim = (path: string, send: Row, token = harness.token) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${token}`).send(send);
  const captured = async (over: Row = {}) => {
    const p = await createPayment(over);
    const a = await startAttempt(p.id);
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return { payment: p, attempt: a };
  };
  /** The simulated provider reports a dispute event (delivered now unless held). */
  const report = async (pid: string, send: Row) => (await sim(`payments/${pid}/disputes`, { commandId: cmd(), ...send }).expect(201)).body;
  /** A signed notification built by hand (what a provider could send that the harness never would). */
  const signed = (body: Row) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const disputeOf = async (providerDisputeId: string) => (await admin.query(`SELECT * FROM payment_dispute WHERE "providerDisputeId" = $1`, [providerDisputeId])).rows[0];
  const observations = async (providerDisputeId: string) =>
    (await admin.query(`SELECT kind, disposition, reason FROM payment_dispute_observation WHERE "providerDisputeId" = $1 ORDER BY "observedAt", id`, [providerDisputeId])).rows;
  const events = async (disputeId: string) =>
    (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'payment.dispute.%' AND payload->>'disputeId' = $1 ORDER BY "occurredAt", name`, [disputeId])).rows;
  const audits = async (disputeId: string) =>
    (await admin.query(`SELECT payload->>'action' AS action, payload->'actor' AS actor, payload->'changes' AS changes FROM outbox WHERE name LIKE 'audit.payment_dispute.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [disputeId])).rows;
  const exposure = (pid: string, token = billing.token) => request(server()).get(`/payment/payments/${pid}/dispute-exposure`).set('authorization', `Bearer ${token}`);
  const asOwner = (method: 'get' | 'post', path: string, bearer = 'owner-jwt') => request(server())[method](`/payment/admin/disputes${path}`).set('authorization', `Bearer ${bearer}`);
  const decisionBinding = (d: { id: string; paymentId: string }, decision: string, over: Row = {}) =>
    ({ operation: 'dispute_decision', audience: 'payment-service', companyId: COMPANY, disputeId: d.id, paymentId: d.paymentId, decision, ...over });
  const decide = (disputeId: string, decision: string, secret: string, k = key(), bearer = 'owner-jwt') =>
    asOwner('post', `/${disputeId}/decision`, bearer).set('idempotency-key', k).send({ decision, receiptSecret: secret });
  /** A captured payment with one open dispute (the provider's partial exposure). */
  const openDispute = async (amount = 4000) => {
    const { payment, attempt } = await captured();
    const ref = `d-${randomUUID()}`;
    await report(payment.id, { disputeRef: ref, event: 'opened', amount, reason: 'fraudulent' });
    return { payment, attempt, ref, providerDisputeId: `simd_${ref}`, dispute: await disputeOf(`simd_${ref}`) };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdispute');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 16 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false, ownerAuthority, evidenceFiles,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'other-producer', digest: other.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
          'other-producer': { operations: ['payment.create', 'payment.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(() => {
    ownerState.down = false;
    fileState.down = false;
    auth.unavailable.consume = 0;
    auth.unavailable.lookup = 0;
    auth.loseResponse.consume = 0;
  });

  describe('verified provider observations (R6E-1, R6E-2)', () => {
    it("an opened dispute is recorded once against the verified capture, in the provider's partial exposure; event and audit once; a redelivery changes nothing", async () => {
      const { payment, attempt, ref, providerDisputeId, dispute } = await openDispute(4000);
      expect(dispute).toMatchObject({ paymentId: payment.id, attemptId: attempt.id, provider: 'simulation', amount: '4000', currency: 'TND', status: 'open', reason: 'fraudulent', liveMode: false, chargebackFactId: null });
      expect((await admin.query(`SELECT 1 FROM provider_transaction_fact WHERE id = $1 AND kind = 'capture'`, [dispute.captureFactId])).rows).toHaveLength(1);
      expect(await observations(providerDisputeId)).toEqual([{ kind: 'opened', disposition: 'applied', reason: null }]);
      const ev = await events(dispute.id);
      expect(ev.map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect(ev[0].payload).toMatchObject({ disputeId: dispute.id, paymentId: payment.id, producer: 'billing-service', amount: 4000, currency: 'TND', reason: 'fraudulent', liveMode: false });
      expect(await audits(dispute.id)).toEqual([{ action: 'payment_dispute.opened', actor: { type: 'system', id: 'payment_webhook' }, changes: { payment_id: payment.id } }]);
      // the same notification again (webhook key) and the same statement in a new notification (a duplicate observation): nothing applied twice
      const again = await report(payment.id, { disputeRef: ref, event: 'opened', amount: 4000, reason: 'fraudulent' });
      await sim(`dispute-commands/${again.commandId}/deliver`, {}).expect(200);
      expect(await observations(providerDisputeId)).toEqual([{ kind: 'opened', disposition: 'applied', reason: null }, { kind: 'opened', disposition: 'duplicate', reason: null }]);
      expect((await events(dispute.id)).length).toBe(1);
      // a provisional dispute changes nothing on the payment
      expect((await request(server()).get(`/payment/payments/${payment.id}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body.status).toBe('succeeded');
      expect((await exposure(payment.id).expect(200)).body).toMatchObject({ state: 'exposed', openDisputes: 1, disputeExposure: 4000, chargedBack: 0, conflicts: 0 });
    });

    it('multiple distinct disputes on one payment: FC-5 exposure is the sum of the open ones, net of their chargebacks, never the capture', async () => {
      const { payment } = await captured();
      const [a, b] = [`a-${randomUUID()}`, `b-${randomUUID()}`];
      await report(payment.id, { disputeRef: a, event: 'opened', amount: 3000 });
      await report(payment.id, { disputeRef: b, event: 'opened', amount: 2000 });
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'exposed', openDisputes: 2, disputeExposure: 5000, chargedBack: 0 });
      await report(payment.id, { disputeRef: a, event: 'won', amount: 3000 });
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'exposed', openDisputes: 1, disputeExposure: 2000 });
      await report(payment.id, { disputeRef: b, event: 'lost', amount: 2000 });
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'exposed', openDisputes: 0, disputeExposure: 0, chargedBack: 2000, lostWithoutChargeback: 0 });
      const lost = await disputeOf(`simd_${b}`);
      const fact = (await admin.query(`SELECT kind, amount::int, currency, "disputeId", "attemptId", source FROM provider_transaction_fact WHERE id = $1`, [lost.chargebackFactId])).rows[0];
      expect(fact).toEqual({ kind: 'chargeback', amount: 2000, currency: 'TND', disputeId: lost.id, attemptId: lost.attemptId, source: 'webhook' });
      expect((await events(lost.id)).map((e) => [e.name, e.payload.chargeback])).toEqual([['payment.dispute.opened', undefined], ['payment.dispute.lost', { factId: lost.chargebackFactId, amount: 2000, currency: 'TND' }]]);
      expect((await audits(lost.id)).map((x) => [x.action, x.changes])).toEqual([['payment_dispute.opened', { payment_id: payment.id }], ['payment_dispute.closed', { payment_id: payment.id, outcome: 'lost' }]]);
    });

    it('out of order: a loss before its opening records the dispute lost; the late opening is a duplicate; one event of each kind', async () => {
      const { payment } = await captured();
      const ref = `o-${randomUUID()}`;
      const held = await report(payment.id, { disputeRef: ref, event: 'opened', delivery: 'held' });
      await report(payment.id, { disputeRef: ref, event: 'lost' });
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ status: 'lost', amount: '9000' });
      expect(d.chargebackFactId).not.toBeNull();
      await sim(`dispute-commands/${held.commandId}/deliver`, {}).expect(200);
      expect(await observations(`simd_${ref}`)).toEqual([{ kind: 'lost', disposition: 'applied', reason: null }, { kind: 'opened', disposition: 'duplicate', reason: 'after_terminal' }]);
      expect((await events(d.id)).map((e) => e.name)).toEqual(['payment.dispute.lost', 'payment.dispute.opened'].sort());
    });

    it('a contradictory terminal outcome never replaces the first: it is a preserved conflict, and the exposure becomes unresolved', async () => {
      const { payment, ref, providerDisputeId, dispute } = await openDispute(9000);
      await report(payment.id, { disputeRef: ref, event: 'won', amount: 9000 });
      await report(payment.id, { disputeRef: ref, event: 'lost', amount: 9000 });
      expect(await disputeOf(providerDisputeId)).toMatchObject({ status: 'won', chargebackFactId: null });
      expect((await observations(providerDisputeId)).at(-1)).toEqual({ kind: 'lost', disposition: 'conflict', reason: 'terminal_contradiction' });
      expect((await admin.query(`SELECT state, outcome FROM webhook_event WHERE "providerEventId" LIKE 'simd_%' ORDER BY "receivedAt" DESC LIMIT 1`)).rows[0]).toEqual({ state: 'conflict', outcome: 'dispute_terminal_contradiction' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [payment.id])).rows[0].n).toBe(0);
      expect((await events(dispute.id)).map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'unresolved', conflicts: 1, openDisputes: 0 });
    });

    it('statements Payment cannot bind are preserved as conflicts and never become disputes', async () => {
      const { payment, ref, providerDisputeId } = await openDispute(4000);
      await report(payment.id, { disputeRef: ref, event: 'opened', amount: 5000 }); // the same dispute, another exposure
      expect((await observations(providerDisputeId)).at(-1)).toEqual({ kind: 'opened', disposition: 'conflict', reason: 'exposure_mismatch' });
      expect(await disputeOf(providerDisputeId)).toMatchObject({ amount: '4000', status: 'open' });
      const p2 = (await captured()).payment;
      const big = `x-${randomUUID()}`;
      await report(p2.id, { disputeRef: big, event: 'opened', amount: 9001 }); // above the verified capture
      expect(await disputeOf(`simd_${big}`)).toBeUndefined();
      expect(await observations(`simd_${big}`)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'exposure_mismatch' }]);
      expect((await exposure(p2.id)).body.state).toBe('unresolved');
      // the attempt of a payment that never captured: no verified capture to dispute
      const uncaptured = await createPayment();
      const a = await startAttempt(uncaptured.id);
      const uref = `simd_u-${randomUUID()}`;
      await signed({ eventId: `raw_${randomUUID()}`, type: 'payment.dispute.opened', reference: a.id, amount: 100, currency: 'TND', data: { disputeId: uref } }).expect(200);
      expect(await disputeOf(uref)).toBeUndefined();
      expect(await observations(uref)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'capture_unverified' }]);
    });

    it('a loss without its chargeback is unresolved; the chargeback reported later completes it once; a different one is a conflict', async () => {
      const { payment } = await captured();
      const ref = `c-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'lost', chargeback: 'none' });
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ status: 'lost', chargebackFactId: null });
      expect((await events(d.id)).find((e) => e.name === 'payment.dispute.lost')!.payload.chargeback).toBeNull(); // the event never implies money moved
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'unresolved', lostWithoutChargeback: 1 });
      await report(payment.id, { disputeRef: ref, event: 'lost', chargebackAmount: 9000 });
      expect((await observations(`simd_${ref}`)).at(-1)).toEqual({ kind: 'lost', disposition: 'applied', reason: 'chargeback_evidence' });
      expect((await exposure(payment.id)).body).toMatchObject({ state: 'exposed', lostWithoutChargeback: 0, chargedBack: 9000 });
      expect((await events(d.id)).filter((e) => e.name === 'payment.dispute.lost')).toHaveLength(1); // no second event: the losses read recovers it
      await report(payment.id, { disputeRef: ref, event: 'lost', chargebackAmount: 9000 }); // the same chargeback again
      expect((await observations(`simd_${ref}`)).at(-1)).toEqual({ kind: 'lost', disposition: 'duplicate', reason: null });
      await report(payment.id, { disputeRef: ref, event: 'lost', chargebackAmount: 8000 }); // another statement of it
      expect((await observations(`simd_${ref}`)).at(-1)).toEqual({ kind: 'lost', disposition: 'conflict', reason: 'chargeback_mismatch' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM provider_transaction_fact WHERE "disputeId" = $1`, [d.id])).rows[0].n).toBe(1);
    });

    it('authenticity: a bad signature is refused and nothing is recorded; an unreadable dispute body is kept, never applied; an unknown reference is unmatched', async () => {
      const { payment, attempt } = await captured();
      const pid = `simd_s-${randomUUID()}`;
      const body = { eventId: `raw_${randomUUID()}`, type: 'payment.dispute.opened', reference: attempt.id, amount: 100, currency: 'TND', data: { disputeId: pid } };
      await request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json').set('x-simulation-signature', 'ab'.repeat(32)).send(JSON.stringify(body)).expect(401);
      expect(await disputeOf(pid)).toBeUndefined();
      expect((await admin.query(`SELECT count(*)::int AS n FROM webhook_event WHERE "providerEventId" = $1`, [body.eventId])).rows[0].n).toBe(0);
      const malformed = { ...body, eventId: `raw_${randomUUID()}`, amount: -5 };
      await signed(malformed).expect(200);
      expect((await admin.query(`SELECT state, outcome FROM webhook_event WHERE "providerEventId" = $1`, [malformed.eventId])).rows[0]).toEqual({ state: 'conflict', outcome: 'malformed_dispute' });
      const chargebackOnOpen = { ...body, eventId: `raw_${randomUUID()}`, data: { disputeId: pid, chargeback: { id: 'cb', amount: 1, currency: 'TND' } } };
      await signed(chargebackOnOpen).expect(200);
      expect((await admin.query(`SELECT outcome FROM webhook_event WHERE "providerEventId" = $1`, [chargebackOnOpen.eventId])).rows[0].outcome).toBe('malformed_dispute');
      const unknown = { ...body, eventId: `raw_${randomUUID()}`, reference: randomUUID() };
      await signed(unknown).expect(200);
      expect((await admin.query(`SELECT state FROM webhook_event WHERE "providerEventId" = $1`, [unknown.eventId])).rows[0].state).toBe('unmatched');
      expect(await disputeOf(pid)).toBeUndefined();
      expect((await exposure(payment.id)).body.state).toBe('clear');
    });

    it('concurrency: competing terminal notifications for one dispute apply exactly one outcome; the others are preserved', async () => {
      const { payment, ref, providerDisputeId, dispute } = await openDispute(9000);
      const cmds = await Promise.all(['won', 'lost', 'won', 'lost', 'lost', 'won'].map((event) => report(payment.id, { disputeRef: ref, event, amount: 9000, delivery: 'held' })));
      await Promise.all(cmds.map((c) => sim(`dispute-commands/${c.commandId}/deliver`, {}).expect(200)));
      const final = await disputeOf(providerDisputeId);
      expect(['won', 'lost']).toContain(final.status);
      const obs = (await observations(providerDisputeId)).slice(1);
      expect(obs.filter((o) => o.disposition === 'applied')).toHaveLength(1);
      expect(obs.filter((o) => o.disposition === 'duplicate').every((o) => o.kind === final.status)).toBe(true);
      expect(obs.filter((o) => o.disposition === 'conflict').every((o) => o.kind !== final.status && o.reason === 'terminal_contradiction')).toBe(true);
      expect((await audits(dispute.id)).filter((a) => a.action === 'payment_dispute.closed')).toHaveLength(1);
      expect((await events(dispute.id)).filter((e) => e.name === 'payment.dispute.lost')).toHaveLength(final.status === 'lost' ? 1 : 0);
    });

    it('the harness: only its authorized caller; a payment with no capture has nothing to dispute; a conflicting replay is refused', async () => {
      const { payment } = await captured();
      await sim(`payments/${payment.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened' }, billing.token).expect(403);
      const fresh = await createPayment();
      expect((await sim(`payments/${fresh.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened' }).expect(409)).body.code).toBe('simulation_nothing_to_dispute');
      expect((await sim(`payments/${payment.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened', chargeback: 'none' }).expect(400)).body.code).toBe('invalid_simulation_command');
      const c = cmd();
      await sim(`payments/${payment.id}/disputes`, { commandId: c, disputeRef: `r-${randomUUID()}`, event: 'opened', delivery: 'held' }).expect(201);
      expect((await sim(`payments/${payment.id}/disputes`, { commandId: c, disputeRef: `r-${randomUUID()}`, event: 'opened', delivery: 'held' }).expect(409)).body.code).toBe('simulation_command_conflict');
    });
  });

  describe('authoritative exposure for the producer (R6E-4)', () => {
    it("only the payment's producer; anything else is the collapsed 404, never zero", async () => {
      const { payment } = await openDispute(1000);
      expect((await exposure(payment.id, other.token)).status).toBe(404);
      expect((await exposure(randomUUID())).status).toBe(404);
      expect((await exposure(payment.id, harness.token)).status).toBe(403);
      expect((await request(server()).get(`/payment/payments/${payment.id}/dispute-exposure`).set('authorization', 'Bearer owner-jwt')).status).toBe(401);
    });

    it("the losses read lists the producer's lost disputes WITH their verified chargeback, by id", async () => {
      const { payment } = await captured();
      const ref = `l-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'lost', chargebackAmount: 9000 });
      const unfunded = `n-${randomUUID()}`;
      await report(payment.id, { disputeRef: unfunded, event: 'lost', chargeback: 'none', amount: 10 });
      const d = await disputeOf(`simd_${ref}`);
      const u = await disputeOf(`simd_${unfunded}`);
      expect(u).toMatchObject({ status: 'lost', chargebackFactId: null });
      const all: Row[] = [];
      let after: string | undefined;
      for (;;) {
        const page = (await request(server()).get(`/payment/disputes/losses?limit=2${after ? `&after=${after}` : ''}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body.items as Row[];
        all.push(...page);
        if (page.length < 2) break;
        after = page.at(-1)!.disputeId;
      }
      expect(all.find((x) => x.disputeId === d.id)).toMatchObject({ paymentId: payment.id, amount: 9000, chargeback: { factId: d.chargebackFactId, amount: 9000, currency: 'TND' }, liveMode: false });
      expect(all.some((x) => x.disputeId === u.id)).toBe(false); // a loss without its chargeback is not a loss Billing can act on
      expect(all.every((x) => x.chargeback && x.chargeback.factId)).toBe(true);
      expect((await request(server()).get('/payment/disputes/losses').set('authorization', `Bearer ${other.token}`).expect(200)).body.items).toEqual([]);
    });
  });

  describe('the Owner (R6E-3)', () => {
    it("reads only their Company's disputes, live; a member, a service token and an unanswerable Auth are refused", async () => {
      const { dispute } = await openDispute(1000);
      const list = (await asOwner('get', '?status=open&limit=100').expect(200)).body.items as Row[];
      expect(list.find((x) => x.disputeId === dispute.id)).toMatchObject({ status: 'open', amount: 1000, currency: 'TND', liveMode: false });
      const one = (await asOwner('get', `/${dispute.id}`).expect(200)).body;
      expect(one).toMatchObject({ disputeId: dispute.id, chargeback: null, evidence: [], decisions: [], observations: [{ kind: 'opened', disposition: 'applied' }] });
      expect((await asOwner('get', `/${dispute.id}`, 'owner2-jwt')).status).toBe(404);
      expect((await asOwner('get', '?limit=100', 'owner2-jwt').expect(200)).body.items.some((x: Row) => x.disputeId === dispute.id)).toBe(false);
      expect((await asOwner('get', `/${dispute.id}`, 'member-jwt')).status).toBe(403);
      expect((await request(server()).get(`/payment/admin/disputes/${dispute.id}`).set('authorization', `Bearer ${billing.token}`)).status).toBe(403);
      ownerState.down = true;
      expect((await asOwner('get', `/${dispute.id}`)).status).toBe(503);
    });

    it('evidence: a file granted to Payment as dispute_evidence for exactly this dispute, append-only; anything else is refused and nothing recorded', async () => {
      const { dispute, payment } = await openDispute(1000);
      const grantId = randomUUID();
      const fileId = randomUUID();
      fileState.grants.set(grantId, { grantId, fileId, purpose: 'dispute_evidence', caseRef: dispute.id });
      const r = await asOwner('post', `/${dispute.id}/evidence`).send({ grantId, fileId }).expect(201);
      expect(r.body).toMatchObject({ disputeId: dispute.id, grantId, fileId, addedBy: { userId: OWNER } });
      await asOwner('post', `/${dispute.id}/evidence`).send({ grantId, fileId }).expect(200);
      expect((await audits(dispute.id)).filter((a) => a.action === 'payment_dispute.evidence_added')).toEqual([
        { action: 'payment_dispute.evidence_added', actor: { type: 'user', id: OWNER, userKind: 'owner' }, changes: { payment_id: payment.id, file_id: fileId, grant_id: grantId } },
      ]);
      const otherCase = randomUUID();
      const f2 = randomUUID();
      fileState.grants.set(otherCase, { grantId: otherCase, fileId: f2, purpose: 'dispute_evidence', caseRef: randomUUID() }); // granted for another case
      expect((await asOwner('post', `/${dispute.id}/evidence`).send({ grantId: otherCase, fileId: f2 }).expect(422)).body.code).toBe('dispute_evidence_invalid');
      expect((await asOwner('post', `/${dispute.id}/evidence`).send({ grantId: randomUUID(), fileId: f2 }).expect(422)).body.code).toBe('dispute_evidence_invalid');
      fileState.down = true;
      expect((await asOwner('post', `/${dispute.id}/evidence`).send({ grantId: otherCase, fileId: f2 }).expect(503)).body.code).toBe('dispute_evidence_unavailable');
      fileState.down = false;
      expect((await asOwner('post', `/${dispute.id}/evidence`, 'owner2-jwt').send({ grantId, fileId: randomUUID() })).status).toBe(404);
      expect((await asOwner('post', `/${dispute.id}/evidence`).send({ grantId: 'x', fileId })).status).toBe(400);
      expect((await admin.query(`SELECT count(*)::int AS n FROM payment_dispute_evidence WHERE "disputeId" = $1`, [dispute.id])).rows[0].n).toBe(1);
      await expect(admin.query(`UPDATE payment_dispute_evidence SET "fileId" = $2 WHERE "disputeId" = $1`, [dispute.id, randomUUID()])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM payment_dispute_evidence WHERE "disputeId" = $1`, [dispute.id])).rejects.toThrow(/append-only/);
      // a closed dispute takes no new evidence
      await report(payment.id, { disputeRef: dispute.providerDisputeId.slice('simd_'.length), event: 'won', amount: 1000 });
      const g3 = randomUUID();
      const f3 = randomUUID();
      fileState.grants.set(g3, { grantId: g3, fileId: f3, purpose: 'dispute_evidence', caseRef: dispute.id });
      expect((await asOwner('post', `/${dispute.id}/evidence`).send({ grantId: g3, fileId: f3 }).expect(409)).body.code).toBe('dispute_not_open');
    });

    it('a decision needs a consumed dispute_decision receipt for exactly this dispute, payment, decision and Company; it never changes the dispute', async () => {
      const { dispute, payment } = await openDispute(1000);
      // receipts that authorize something else are refused, and each refusal frees the dispute for a new decision
      const wrong = [
        auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: randomUUID(), paymentId: payment.id, amount: 1000, currency: 'TND', reason: 'customer_request' }, OWNER),
        auth.issue(decisionBinding(dispute, 'accept'), OWNER),
        auth.issue(decisionBinding({ ...dispute, id: randomUUID() }, 'contest'), OWNER),
        auth.issue(decisionBinding(dispute, 'contest', { companyId: COMPANY2 }), OWNER2),
      ];
      for (const w of wrong) expect((await decide(dispute.id, 'contest', w.secret).expect(409)).body.code).toBe('dispute_decision_refused');
      expect(wrong.every((w) => w.status === 'issued')).toBe(true); // none was consumed
      const r = auth.issue(decisionBinding(dispute, 'contest'), OWNER);
      const k = key();
      const res = await decide(dispute.id, 'contest', r.secret, k).expect(201);
      expect(res.body).toMatchObject({ disputeId: dispute.id, decision: 'contest', status: 'recorded', approvedBy: { userId: OWNER }, receiptId: r.id });
      expect(r).toMatchObject({ status: 'consumed', consumeRef: res.body.decisionId });
      expect(JSON.stringify(res.body)).not.toContain(r.secret);
      expect((await decide(dispute.id, 'contest', r.secret, k).expect(200)).body.decisionId).toBe(res.body.decisionId); // replay
      expect((await decide(dispute.id, 'accept', r.secret, k).expect(422)).body.code).toBe('idempotency_key_reused');
      const second = auth.issue(decisionBinding(dispute, 'accept'), OWNER);
      expect((await decide(dispute.id, 'accept', second.secret).expect(409)).body.code).toBe('dispute_decision_exists');
      expect(await disputeOf(dispute.providerDisputeId)).toMatchObject({ status: 'open' }); // the provider decides the outcome
      expect((await audits(dispute.id)).filter((a) => a.action === 'payment_dispute.decided')).toEqual([
        { action: 'payment_dispute.decided', actor: { type: 'user', id: OWNER, userKind: 'owner' }, changes: { payment_id: payment.id, decision: 'contest' } },
      ]);
      // another Company's Owner: the dispute does not exist for them; a member is not an Owner
      expect((await decide(dispute.id, 'contest', r.secret, key(), 'owner2-jwt')).status).toBe(404);
      expect((await decide(dispute.id, 'contest', r.secret, key(), 'member-jwt')).status).toBe(403);
    });

    it("an unconfirmable consumption stays pending (503) and the same request resumes it once; a closed dispute takes no decision", async () => {
      const { dispute, payment, ref } = await openDispute(1000);
      const r = auth.issue(decisionBinding(dispute, 'accept'), OWNER);
      const k = key();
      auth.loseResponse.consume = 1; // Auth consumed it, the answer was lost
      auth.unavailable.lookup = 1;
      expect((await decide(dispute.id, 'accept', r.secret, k).expect(503)).body.code).toBe('dispute_decision_unresolved');
      expect((await admin.query(`SELECT status FROM payment_dispute_decision WHERE "disputeId" = $1`, [dispute.id])).rows).toEqual([{ status: 'authorization_pending' }]);
      const other = auth.issue(decisionBinding(dispute, 'accept'), OWNER);
      expect((await decide(dispute.id, 'accept', other.secret).expect(409)).body.code).toBe('dispute_decision_exists'); // the pending one holds the dispute
      expect((await decide(dispute.id, 'accept', other.secret, k).expect(409)).body.code).toBe('dispute_decision_conflict'); // the key names another receipt
      const resumed = await decide(dispute.id, 'accept', r.secret, k).expect(200); // the existing intent, now recorded
      expect(resumed.body).toMatchObject({ status: 'recorded', receiptId: r.id });
      // concurrency: competing decisions on a fresh dispute record exactly one
      const fresh = await openDispute(1000);
      const outs = await Promise.all([0, 1, 2, 3].map(() => decide(fresh.dispute.id, 'contest', auth.issue(decisionBinding(fresh.dispute, 'contest'), OWNER).secret)));
      expect(outs.filter((o) => o.status === 201)).toHaveLength(1);
      expect(outs.filter((o) => o.status !== 201).every((o) => o.status === 409 && o.body.code === 'dispute_decision_exists')).toBe(true);
      // closed: nothing new
      await report(payment.id, { disputeRef: ref, event: 'won', amount: 1000 });
      const late = auth.issue(decisionBinding(dispute, 'contest'), OWNER);
      expect((await decide(dispute.id, 'contest', late.secret).expect(409)).body.code).toBe('dispute_not_open');
      expect(late.status).toBe('issued');
    });
  });

  describe('database guarantees (every role)', () => {
    it('identity, binding and terminal outcomes are immutable; observations and decisions are never deleted', async () => {
      const { dispute, payment, ref } = await openDispute(1000);
      await expect(admin.query(`UPDATE payment_dispute SET amount = 999 WHERE id = $1`, [dispute.id])).rejects.toMatchObject({ constraint: 'payment_dispute_immutable' });
      await expect(admin.query(`DELETE FROM payment_dispute WHERE id = $1`, [dispute.id])).rejects.toThrow(/append-only/);
      await report(payment.id, { disputeRef: ref, event: 'won', amount: 1000 });
      await expect(admin.query(`UPDATE payment_dispute SET status = 'lost' WHERE id = $1`, [dispute.id])).rejects.toMatchObject({ constraint: 'payment_dispute_terminal' });
      await expect(admin.query(`UPDATE payment_dispute_observation SET disposition = 'applied' WHERE "disputeId" = $1`, [dispute.id])).rejects.toThrow(/append-only/);
      // a chargeback fact belongs to a LOST dispute of the same payment and attempt
      await expect(admin.query(
        `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source, "disputeId")
         VALUES ('simulation', $1, 'chargeback', $2, $3, 1000, 'TND', false, 'status_check', $4)`, [`cb-${randomUUID()}`, payment.id, dispute.attemptId, dispute.id],
      )).rejects.toMatchObject({ constraint: 'provider_transaction_fact_chargeback_dispute' });
      await expect(admin.query(
        `INSERT INTO payment_dispute_decision (id, "disputeId", decision, "companyId", "requestedByUserId", "idempotencyKey", "receiptDigest")
         VALUES ($1, $2, 'contest', $3, $4, 'key-12345678', $5)`, [randomUUID(), dispute.id, COMPANY, OWNER, 'a'.repeat(64)],
      )).rejects.toMatchObject({ constraint: 'payment_dispute_decision_open' });
    });
  });
});
