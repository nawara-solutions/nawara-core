import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HierarchyUnavailableError, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership,
  type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a'; // an Organization of P1
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b'; // another Organization of P1
const ORG_OUT = '0c0c0c0c-0000-4000-8000-00000000000c'; // an Organization of P2, outside the producers' Platforms
const ORG_DOWN = '0d0d0d0d-0000-4000-8000-00000000000d'; // the reference read cannot answer for it
const ADMIN_A = '1a1a1a1a-0000-4000-8000-0000000000a1';
const STUDENT = '5e5e5e5e-0000-4000-8000-0000000000e5'; // the beneficiary of an assisted settlement
type Row = Record<string, any>;

const membership = (organization: string, o: Partial<AuthMembership> = {}): AuthMembership =>
  ({ id: crypto.randomUUID(), organization: { id: organization }, platform: { id: P1 }, status: 'active', isOrganizationAdmin: true, ...o });
const member = (id: string, memberships: AuthMembership[], o: Partial<AuthIdentity> = {}): AuthIdentity => ({ id, adminTier: null, isActive: true, memberships, ...o });

/**
 * Core V2 S4e (register PAY-03; ADR-0044 B7; S0 DB-15, §3.6; the Owner's A-1 to A-7): Organization-payer payments and attempts through the
 * REAL application on real PostgreSQL 16, on the simulation provider (simulation only). The Organization actor is established from Auth's
 * live `/auth/me` answer for the actor's own bearer (a test double here, exactly the shape Auth returns) and the Organization reference
 * read; creation needs the default-denied `payment.create.organization_payer`, which no ordinary configuration holds.
 */
describeWithEnv('Organization-payer payments and attempts (Core V2 S4e) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const granted = generateServiceToken(); // an isolated test fixture holding the inactive creation grant (A-5)
  const plain = generateServiceToken(); // an ordinary producer: payment.create, read, cancel only
  const broad = generateServiceToken(); // Core V2 S5b (E-2), S6f (R6F-2): holds only the broad Organization-payer grant, never the narrow ones
  const harness = generateServiceToken();
  let authDown = false;
  const identities: Record<string, AuthIdentity> = {};
  const resetIdentities = () => {
    for (const k of Object.keys(identities)) delete identities[k];
    Object.assign(identities, {
      'admin-a': member(ADMIN_A, [membership(ORG_A)]),
      'admin-b': member(crypto.randomUUID(), [membership(ORG_B)]),
      'member-a': member(crypto.randomUUID(), [membership(ORG_A, { isOrganizationAdmin: false })]),
      'pending-a': member(crypto.randomUUID(), [membership(ORG_A, { status: 'pending', isOrganizationAdmin: false })]),
      'revoked-a': member(crypto.randomUUID(), [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]),
      'inactive-a': member(crypto.randomUUID(), [membership(ORG_A)], { isActive: false }),
      'wrong-platform-a': member(crypto.randomUUID(), [membership(ORG_A, { platform: { id: P2 } })]),
      'owner-a': member(crypto.randomUUID(), [membership(ORG_A)], { adminTier: 'owner' }),
      'operator-a': member(crypto.randomUUID(), [membership(ORG_A)], { adminTier: 'operator' }),
      student: member(STUDENT, []),
      'admin-down': member(crypto.randomUUID(), [membership(ORG_DOWN)]),
    });
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      if (authDown) throw new ServiceUnavailableException();
      return identities[bearer] ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  let referenceDown = false;
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => {
      if (referenceDown || organizationId === ORG_DOWN) throw new HierarchyUnavailableError();
      const platformId = { [ORG_A]: P1, [ORG_B]: P1, [ORG_OUT]: P2 }[organizationId];
      return platformId ? { organizationId, platformId, companyId: 'aaaaaaaa-0000-4000-8000-00000000c0de' } : null;
    },
  };
  const server = () => t.app.getHttpServer();
  const body = (over: Row = {}) => ({
    paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
    payer: { type: 'organization', id: ORG_A }, seller: { type: 'company', id: 'nawara-company-reference' },
    amount: 4200, currency: 'TND', purpose: 'assisted_settlement', beneficiaryUserId: STUDENT, ...over,
  });
  const createAs = (token: string, b: Row) => request(server()).post('/payment/payments').set('authorization', `Bearer ${token}`).send(b);
  const create = async (over: Row = {}) => (await createAs(granted.token, body(over)).expect(201)).body;
  const read = (id: string, bearer: string) => request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${bearer}`);
  const startAs = (id: string, bearer: string, key = `k-${crypto.randomUUID()}`, send: Row = {}) =>
    request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', `Bearer ${bearer}`).set('idempotency-key', key).send(send);
  const syncAs = (pid: string, aid: string, bearer: string) => request(server()).post(`/payment/payments/${pid}/attempts/${aid}/sync`).set('authorization', `Bearer ${bearer}`).send({});
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation${path}`).set('authorization', `Bearer ${harness.token}`).send(send);
  const outcome = async (pid: string, aid: string, send: Row) => (await sim(`/payments/${pid}/attempts/${aid}/outcomes`, { commandId: `cmd-${crypto.randomUUID()}`, ...send }).expect(201)).body;
  const payments = async () => Number((await admin.query('SELECT count(*) FROM payment')).rows[0].count);
  const attempts = async (pid: string) => (await admin.query(`SELECT id, status FROM payment_attempt WHERE "paymentId" = $1 ORDER BY "attemptNumber"`, [pid])).rows;
  const outboxRows = async (pid: string, name: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = $2 AND (payload->>'paymentId' = $1 OR payload->'resource'->>'id' = $1)`, [pid, name])).rows;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentorgpayer');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, authClient, reference, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      tokens: [{ caller: 'billing-service', digest: granted.digest }, { caller: 'plain-producer', digest: plain.digest }, { caller: 'simulation-harness', digest: harness.digest }, { caller: 'broad-producer', digest: broad.digest }],
      env: {
        PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'), PAYMENT_MAX_ATTEMPTS: '1',
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          // Core V2 S5b (E-2): assisted settlements need the narrow grant; this isolated fixture also keeps the broad one for recovery cases
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.organization_payer', 'payment.create.assisted_settlement', 'payment.create.recovery_settlement'], allowedPlatforms: [P1] },
          'broad-producer': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.create.organization_payer'], allowedPlatforms: [P1] },
          'plain-producer': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [P1] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  beforeEach(() => {
    resetIdentities();
    authDown = false;
    referenceDown = false;
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('creation behind the default-denied grant (A-5) and the Organization scope (A-4)', () => {
    it('an assisted settlement and a recovery settlement: the payer Organization is the payment\'s Organization, events say so', async () => {
      const assisted = await create();
      expect(assisted).toMatchObject({ payer: { type: 'organization', id: ORG_A }, organizationId: ORG_A, purpose: 'assisted_settlement', beneficiaryUserId: STUDENT, liveMode: false });
      const recovery = await create({ purpose: 'recovery_settlement', beneficiaryUserId: undefined, organizationId: ORG_A.toUpperCase(), payer: { type: 'organization', id: ORG_A.toUpperCase() } });
      expect(recovery).toMatchObject({ payer: { type: 'organization', id: ORG_A }, organizationId: ORG_A, purpose: 'recovery_settlement' });
      expect((await outboxRows(assisted.id, 'payment.created'))[0].payload).toMatchObject({ organizationId: ORG_A, purpose: 'assisted_settlement', beneficiaryUserId: STUDENT, liveMode: false });
    });

    it('Core V2 S5b (E-2) and S6f (R6F-2): the broad grant admits neither an assisted nor a recovery settlement (403, nothing written)', async () => {
      const before = await payments();
      const r = await createAs(broad.token, body());
      expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);
      const recovery = await createAs(broad.token, body({ purpose: 'recovery_settlement', beneficiaryUserId: undefined }));
      expect([recovery.status, recovery.body.code]).toEqual([403, 'operation_not_permitted']);
      expect(await payments()).toBe(before);
    });

    it('an ordinary producer (payment.create without the grant) is 403 and writes nothing, whatever it sends', async () => {
      const before = await payments();
      for (const over of [{}, { purpose: 'recovery_settlement', beneficiaryUserId: undefined }, { purpose: 'non_entitlement', beneficiaryUserId: undefined }]) {
        const r = await createAs(plain.token, body(over));
        expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);
      }
      expect(await payments()).toBe(before);
    });

    it('the Organization must be inside the producer\'s Platforms (403, one answer for unknown), and an unavailable reference fails closed (503)', async () => {
      const before = await payments();
      expect((await createAs(granted.token, body({ payer: { type: 'organization', id: ORG_OUT } }))).body.code).toBe('organization_not_permitted');
      expect((await createAs(granted.token, body({ payer: { type: 'organization', id: crypto.randomUUID() } }))).body.code).toBe('organization_not_permitted');
      expect((await createAs(granted.token, body({ payer: { type: 'organization', id: ORG_DOWN } }))).status).toBe(503);
      expect(await payments()).toBe(before);
    });

    it('payer and purpose pairing, and the scope binding, are refused before anything is written', async () => {
      const before = await payments();
      const cases: Array<[Row, number, string]> = [
        [{ payer: { type: 'organization', id: 'not-a-uuid' } }, 400, 'invalid_payment_request'],
        [{ organizationId: ORG_B }, 400, 'invalid_payment_request'],
        [{ seller: { type: 'organization', id: ORG_B } }, 400, 'invalid_payment_request'],
        [{ beneficiaryUserId: undefined }, 400, 'invalid_payment_request'],
        [{ purpose: 'recovery_settlement' }, 400, 'invalid_payment_request'], // a recovery settlement names no beneficiary
        [{ purpose: 'non_entitlement', beneficiaryUserId: undefined }, 422, 'payer_purpose_mismatch'],
        [{ purpose: 'direct_purchase', beneficiaryUserId: ORG_A }, 422, 'payer_purpose_mismatch'],
        [{ payer: { type: 'user', id: STUDENT } }, 422, 'payer_purpose_mismatch'], // a user never pays an assisted settlement
        [{ payer: { type: 'company', id: 'acme' }, purpose: 'recovery_settlement', beneficiaryUserId: undefined }, 422, 'payer_purpose_mismatch'],
      ];
      for (const [over, status, code] of cases) {
        const r = await createAs(granted.token, body(over));
        expect([r.status, r.body.code], JSON.stringify(over)).toEqual([status, code]);
      }
      expect(await payments()).toBe(before);
    });

    it('an identical replay returns the same payment; the database keeps the payer scope immutable and refuses a mismatched insert', async () => {
      const b = body();
      const first = (await createAs(granted.token, b).expect(201)).body;
      expect((await createAs(granted.token, b).expect(200)).body.id).toBe(first.id);
      for (const set of [`"organizationId" = '${ORG_B}'`, `"payerId" = '${ORG_B}'`, `"payerType" = 'user'`]) {
        await expect(admin.query(`UPDATE payment SET ${set} WHERE id = $1`, [first.id])).rejects.toMatchObject({ code: '23514' });
      }
      await expect(admin.query(
        `INSERT INTO payment (producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, purpose, "liveMode")
         VALUES ('billing-service', gen_random_uuid(), 'invoice', 'i', 'organization', $1, 'company', 'n', $2, 100, 'TND', 'recovery_settlement', false)`, [ORG_A, ORG_B],
      )).rejects.toMatchObject({ code: '23514', constraint: 'payment_organization_payer_scope' });
    });
  });

  describe('the Organization actor (A-2, A-3): Auth\'s live facts for the actor\'s own bearer, bound to the payer Organization and its Platform', () => {
    it('an active Organization administrator of the payer Organization starts, reads and syncs; the payment settles once on verified evidence', async () => {
      const p = await create();
      const a = (await startAs(p.id, 'admin-a').expect(201)).body;
      expect(a).toMatchObject({ provider: 'simulation', status: 'submitted' });
      expect((await read(p.id, 'admin-a').expect(200)).body).toMatchObject({ id: p.id, status: 'pending' });
      await outcome(p.id, a.id, { outcome: 'succeeded', delivery: 'held' }); // the provider's answer, not yet heard by Payment
      expect((await read(p.id, 'admin-a')).body.status).toBe('pending');
      expect((await syncAs(p.id, a.id, 'admin-a').expect(200)).body.status).toBe('succeeded');
      expect((await read(p.id, 'admin-a')).body.status).toBe('succeeded');
      const facts = (await admin.query(`SELECT provider, amount::int, "liveMode" FROM provider_transaction_fact WHERE "attemptId" = $1`, [a.id])).rows;
      expect(facts).toEqual([{ provider: 'simulation', amount: 4200, liveMode: false }]);
      expect(await outboxRows(p.id, 'payment.succeeded')).toHaveLength(1);
      // audit: the actor is the Organization administrator (a member) and the organization the payer Organization
      expect((await outboxRows(p.id, 'audit.payment.succeeded'))[0].payload).toMatchObject({ actor: { type: 'user', id: ADMIN_A, userKind: 'member' }, organizationId: ORG_A });
    });

    it.each([
      ['an ordinary member (no administrator flag)', 'member-a'],
      ['a pending membership', 'pending-a'],
      ['a revoked membership', 'revoked-a'],
      ['an administrator of another Organization', 'admin-b'],
      ['an administrator whose membership names another Platform', 'wrong-platform-a'],
      ['an Owner, even with an administrator membership', 'owner-a'],
      ['a Platform operator, even with an administrator membership', 'operator-a'],
      ['the beneficiary', 'student'],
      ['an unknown bearer', 'nobody'],
    ])('%s: collapsed 404 (or 401) on start, read and sync; nothing written', async (_n, bearer) => {
      const p = await create();
      const holder = (await startAs(p.id, 'admin-a').expect(201)).body;
      const before = await attempts(p.id);
      const statuses = [(await startAs(p.id, bearer)).status, (await read(p.id, bearer)).status, (await syncAs(p.id, holder.id, bearer)).status];
      expect(statuses).toEqual(bearer === 'nobody' ? [401, 401, 401] : [404, 404, 404]);
      expect(await attempts(p.id)).toEqual(before);
    });

    it('an inactive user is refused by the live check (401)', async () => {
      const p = await create();
      expect((await startAs(p.id, 'inactive-a')).status).toBe(401);
      expect((await read(p.id, 'inactive-a')).status).toBe(401);
    });

    it('authority is live: an administrator flag removed after the attempt started stops that actor at once; the evidence still settles', async () => {
      const p = await create();
      const a = (await startAs(p.id, 'admin-a').expect(201)).body;
      identities['admin-a'] = member(ADMIN_A, [membership(ORG_A, { isOrganizationAdmin: false })]);
      await read(p.id, 'admin-a').expect(404);
      await syncAs(p.id, a.id, 'admin-a').expect(404);
      await outcome(p.id, a.id, { outcome: 'succeeded' }); // the provider's verified notification needs no user
      expect((await read(p.id, 'student').expect(404)).status).toBe(404);
      expect((await admin.query('SELECT status FROM payment WHERE id = $1', [p.id])).rows[0].status).toBe('succeeded');
    });

    it('Auth unavailable, or the Organization reference unavailable, fails closed (503) with nothing written', async () => {
      const p = await create();
      authDown = true;
      expect((await startAs(p.id, 'admin-a')).status).toBe(503);
      authDown = false;
      referenceDown = true;
      expect((await startAs(p.id, 'admin-a')).status).toBe(503);
      expect((await read(p.id, 'admin-a')).status).toBe(503);
      referenceDown = false;
      expect(await attempts(p.id)).toEqual([]);
    });

    it('no service starts or syncs an Organization-payer attempt (AD-2); the producer keeps only its read', async () => {
      const p = await create();
      expect((await startAs(p.id, granted.token)).status).toBe(403);
      expect((await startAs(p.id, harness.token)).status).toBe(403);
      await read(p.id, granted.token).expect(200);
      expect((await read(p.id, plain.token)).status).toBe(404); // another producer: no relation
      expect(await attempts(p.id)).toEqual([]);
    });

    it('a payer cannot choose a simulated outcome (S4f F-S7)', async () => {
      const p = await create();
      expect((await startAs(p.id, 'admin-a', undefined, { providerOptions: { scenario: 'success' } }).expect(422)).body.code).toBe('provider_options_not_accepted');
    });
  });

  describe('finality, uncertainty and money-command idempotency are unchanged for an Organization payer', () => {
    it('concurrent starts by the actor (distinct keys) open one attempt; an identical key replays it', async () => {
      const p = await create();
      const results = await Promise.all(Array.from({ length: 6 }, () => startAs(p.id, 'admin-a')));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
      const q = await create();
      const key = `k-${crypto.randomUUID()}`;
      const [x, y] = await Promise.all([startAs(q.id, 'admin-a', key), startAs(q.id, 'admin-a', key)]);
      expect([x.status, y.status]).toEqual([201, 201]);
      expect(x.body.id).toBe(y.body.id);
      expect(await attempts(q.id)).toHaveLength(1);
    });

    it('an uncertain attempt blocks a second one; a cancel while uncertain is closing (202), and the verified success still settles it once', async () => {
      const p = await create();
      await sim(`/payments/${p.id}/initiation`, { commandId: `cmd-${crypto.randomUUID()}`, mode: 'ambiguous' }).expect(201);
      const a = (await startAs(p.id, 'admin-a').expect(201)).body;
      expect(a.status).toBe('unknown');
      expect((await startAs(p.id, 'admin-a')).body.code).toBe('payment_has_open_attempt');
      const cancelled = await request(server()).post(`/payment/payments/${p.id}/cancel`).set('authorization', `Bearer ${granted.token}`).set('idempotency-key', `c-${crypto.randomUUID()}`).send({});
      expect([cancelled.status, cancelled.body.status]).toEqual([202, 'closing']);
      await outcome(p.id, a.id, { outcome: 'succeeded' });
      expect((await read(p.id, 'admin-a')).body.status).toBe('succeeded');
      expect(await outboxRows(p.id, 'payment.succeeded')).toHaveLength(1);
    });

    it('a provider-confirmed failure started by the actor fails the payment (limit 1), audited as that actor and Organization', async () => {
      const p = await create();
      const a = (await startAs(p.id, 'admin-a').expect(201)).body;
      await outcome(p.id, a.id, { outcome: 'failed', failureCode: 'card_declined', delivery: 'held' });
      await syncAs(p.id, a.id, 'admin-a').expect(200);
      expect((await read(p.id, 'admin-a')).body.status).toBe('failed');
      expect((await outboxRows(p.id, 'audit.payment.failed'))[0].payload).toMatchObject({ actor: { type: 'user', id: ADMIN_A, userKind: 'member' }, organizationId: ORG_A });
    });
  });
});
