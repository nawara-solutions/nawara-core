import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
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
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a'; // the subscribing Organization (Platform P1, Company C1)
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b'; // another Organization of the same Platform and Company
const ORG_X = '0e0e0e0e-0000-4000-8000-00000000000e'; // an Organization of another Company (Platform P2)
const ORG_DOWN = '0d0d0d0d-0000-4000-8000-00000000000d'; // the reference read cannot answer for it
type Row = Record<string, any>;

const membership = (organization: string, o: Partial<AuthMembership> = {}): AuthMembership =>
  ({ id: crypto.randomUUID(), organization: { id: organization }, platform: { id: organization === ORG_X ? P2 : P1 }, status: 'active', isOrganizationAdmin: true, ...o });

/**
 * Core V2 DO-28 (B-026; the Owner's decision of 2026-11-14) through the REAL application on real PostgreSQL 16 and the simulation provider
 * (simulation only): the named user payer of an `organization_subscription` starts a NEW attempt only while Auth's live `/auth/me` answer
 * (a test double here, exactly the shape Auth returns) shows them as an active administrator of the payment's exact Organization, on its
 * authoritative Platform. An attempt already started keeps its whole lifecycle; nothing is checked at payment creation.
 */
describeWithEnv('Organization subscription payer authority (Core V2 DO-28) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const producer = generateServiceToken(); // an ordinary producer: payment.create, read, cancel only (no Organization-payer grant)
  const harness = generateServiceToken();
  let authDown = false;
  let referenceDown = false;
  /** bearer -> the identity Auth answers LIVE for it; tests change it between requests (a revocation, a removed flag) */
  const identities: Record<string, AuthIdentity> = {};
  /** called after Auth answered: models a change committed in Auth after this request's read */
  let afterAnswer: ((bearer: string) => void) | undefined;
  const as = (bearer: string, memberships: unknown[], o: Partial<AuthIdentity> = {}): string => {
    identities[bearer] = { id: identities[bearer]?.id ?? crypto.randomUUID(), adminTier: null, isActive: true, memberships: memberships as AuthMembership[], ...o };
    return identities[bearer].id;
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      if (authDown) throw new ServiceUnavailableException();
      const answer = identities[bearer] ? structuredClone(identities[bearer]) : null;
      afterAnswer?.(bearer);
      return answer;
    },
    hasPlatformAccess: async () => false,
  };
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => {
      if (referenceDown || organizationId === ORG_DOWN) throw new HierarchyUnavailableError();
      const anchors: Record<string, [string, string]> = { [ORG_A]: [P1, 'c1'], [ORG_B]: [P1, 'c1'], [ORG_X]: [P2, 'c2'] };
      return anchors[organizationId] ? { organizationId, platformId: anchors[organizationId][0], companyId: anchors[organizationId][1] } : null;
    },
  };
  const server = () => t.app.getHttpServer();
  const create = async (payerId: string, over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${producer.token}`).send({
    paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
    payer: { type: 'user', id: payerId }, seller: { type: 'company', id: 'nawara-company-reference' }, organizationId: ORG_A,
    amount: 4200, currency: 'TND', purpose: 'organization_subscription', ...over,
  }).expect(201)).body;
  const startAs = (id: string, bearer: string, key = `k-${crypto.randomUUID()}`) =>
    request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', `Bearer ${bearer}`).set('idempotency-key', key).send({});
  const read = (id: string, bearer: string) => request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${bearer}`);
  const syncAs = (pid: string, aid: string, bearer: string) => request(server()).post(`/payment/payments/${pid}/attempts/${aid}/sync`).set('authorization', `Bearer ${bearer}`).send({});
  const outcome = async (pid: string, aid: string, send: Row) =>
    (await request(server()).post(`/payment/simulation/payments/${pid}/attempts/${aid}/outcomes`).set('authorization', `Bearer ${harness.token}`).send({ commandId: `cmd-${crypto.randomUUID()}`, ...send }).expect(201)).body;
  const attempts = async (pid: string) => (await admin.query(`SELECT id, status FROM payment_attempt WHERE "paymentId" = $1 ORDER BY "attemptNumber"`, [pid])).rows;
  const paymentStatus = async (pid: string) => (await admin.query('SELECT status FROM payment WHERE id = $1', [pid])).rows[0].status;
  const outbox = async (pid: string) => Number((await admin.query(`SELECT count(*) FROM outbox WHERE payload->>'paymentId' = $1 OR payload->'resource'->>'id' = $1`, [pid])).rows[0].count);
  const reservations = async (key: string) => Number((await admin.query(`SELECT count(*) FROM idempotency_key WHERE key = $1`, [key])).rows[0].count);
  /** A refusal leaves no attempt, no status change, no event and no idempotency reservation (so nothing reached the provider). */
  const refusedCleanly = async (pid: string, bearer: string, expected: [number, string]) => {
    const key = `k-${crypto.randomUUID()}`;
    const events = await outbox(pid);
    const r = await startAs(pid, bearer, key);
    expect([r.status, r.body.code], bearer).toEqual(expected);
    expect(await attempts(pid)).toEqual([]);
    expect(await paymentStatus(pid)).toBe('created');
    expect(await outbox(pid)).toBe(events);
    expect(await reservations(key)).toBe(0);
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdo28');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, authClient, reference, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      tokens: [{ caller: 'billing-service', digest: producer.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: randomBytes(32).toString('hex'), PAYMENT_MAX_ATTEMPTS: '3',
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel'], allowedPlatforms: [P1] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  beforeEach(() => {
    for (const k of Object.keys(identities)) delete identities[k];
    authDown = false;
    referenceDown = false;
    afterAnswer = undefined;
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  it('A: the named payer who is an active administrator of the exact Organization starts an attempt; the payment completes', async () => {
    const p = await create(as('admin', [membership(ORG_A)]));
    const a = (await startAs(p.id, 'admin').expect(201)).body;
    expect(a).toMatchObject({ provider: 'simulation', status: 'submitted' });
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    expect((await read(p.id, 'admin').expect(200)).body.status).toBe('succeeded');
  });

  it('B, C, D: an ordinary, pending, rejected or revoked member, a former administrator, or no membership at all is refused with nothing written', async () => {
    const cases: [string, unknown[]][] = [
      ['ordinary', [membership(ORG_A, { isOrganizationAdmin: false })]],
      ['pending', [membership(ORG_A, { status: 'pending', isOrganizationAdmin: false })]],
      ['rejected', [membership(ORG_A, { status: 'rejected', isOrganizationAdmin: false })]],
      ['revoked', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]],
      ['revoked-flag-left', [membership(ORG_A, { status: 'revoked' })]],
      ['none', []],
    ];
    for (const [bearer, ms] of cases) {
      const p = await create(as(bearer, ms));
      await refusedCleanly(p.id, bearer, [403, 'operation_not_permitted']);
      expect((await read(p.id, bearer).expect(200)).body.status).toBe('created'); // still the payer: reading is unchanged
    }
    // D: the administrator flag removed between two payments of the same user
    const id = as('demoted', [membership(ORG_A)]);
    const first = await create(id);
    await startAs(first.id, 'demoted').expect(201);
    as('demoted', [membership(ORG_A, { isOrganizationAdmin: false })]);
    await refusedCleanly((await create(id)).id, 'demoted', [403, 'operation_not_permitted']);
  });

  it('E, F, G: administrators of another Organization (same Company or another Company) are refused; a non-payer administrator has no relation', async () => {
    await refusedCleanly((await create(as('admin-b', [membership(ORG_B)]))).id, 'admin-b', [403, 'operation_not_permitted']);
    await refusedCleanly((await create(as('admin-x', [membership(ORG_X)]))).id, 'admin-x', [403, 'operation_not_permitted']);
    // a claimed ORG_A membership on another Company's Platform does not match ORG_A's authoritative Platform
    await refusedCleanly((await create(as('wrong-platform', [membership(ORG_A, { platform: { id: P2 } })]))).id, 'wrong-platform', [403, 'operation_not_permitted']);
    // an ORG_A administrator who is not the named payer: the same 404 as a payment that does not exist
    const p = await create(as('payer-b', [membership(ORG_B)]));
    as('admin-a', [membership(ORG_A)]);
    await refusedCleanly(p.id, 'admin-a', [404, 'not_found']);
  });

  it('H: Auth or the Organization reference unable to answer fails closed (503) with nothing written', async () => {
    const p = await create(as('admin', [membership(ORG_A)]));
    authDown = true;
    const down = await startAs(p.id, 'admin');
    expect(down.status).toBe(503);
    expect(await attempts(p.id)).toEqual([]);
    authDown = false;
    referenceDown = true;
    const r = await startAs(p.id, 'admin');
    expect(r.status).toBe(503);
    expect(await attempts(p.id)).toEqual([]);
    referenceDown = false;
    await startAs(p.id, 'admin').expect(201); // recovers on the next live answer
  });

  it('I: malformed, duplicated or missing membership evidence, or a payment without an Organization, is refused', async () => {
    const bad: unknown[][] = [
      [{ ...membership(ORG_A), isOrganizationAdmin: 'true' }],
      [{ ...membership(ORG_A), status: 'Active' }],
      [{ ...membership(ORG_A), platform: null }],
      [{ organization: { id: ORG_A } }],
      [membership(ORG_A), membership(ORG_A)],
    ];
    for (const [i, ms] of bad.entries()) await refusedCleanly((await create(as(`bad-${i}`, ms))).id, `bad-${i}`, [403, 'operation_not_permitted']);
    const noOrg = await create(as('admin-no-org', [membership(ORG_A)]), { organizationId: undefined });
    expect(noOrg.organizationId).toBeNull();
    await refusedCleanly(noOrg.id, 'admin-no-org', [403, 'operation_not_permitted']);
    const down = await create(as('admin-down', [membership(ORG_DOWN, { platform: { id: P1 } })]), { organizationId: ORG_A });
    await refusedCleanly(down.id, 'admin-down', [403, 'operation_not_permitted']); // a membership for another Organization, never read
  });

  it('J, K: revocation refuses the next NEW attempt; the attempt already started keeps its lifecycle (sync, the provider notification, the payer\'s reads)', async () => {
    const id = as('admin', [membership(ORG_A)]);
    const j = await create(id);
    as('admin', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]); // J: revoked before any attempt
    await refusedCleanly(j.id, 'admin', [403, 'operation_not_permitted']);

    as('admin', [membership(ORG_A)]);
    const k = await create(id);
    const held = (await startAs(k.id, 'admin').expect(201)).body;
    as('admin', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]); // K: revoked after the attempt was authorized
    await outcome(k.id, held.id, { outcome: 'succeeded', delivery: 'held' });
    expect((await syncAs(k.id, held.id, 'admin').expect(200)).body.status).toBe('succeeded');
    expect((await read(k.id, 'admin').expect(200)).body.status).toBe('succeeded');

    // K: an in-flight attempt completes from the provider's own notification with no user at all
    as('admin', [membership(ORG_A)]);
    const n = await create(id);
    const flying = (await startAs(n.id, 'admin').expect(201)).body;
    const saved = identities.admin;
    delete identities.admin; // Auth no longer knows the bearer at all
    await outcome(n.id, flying.id, { outcome: 'succeeded' });
    expect(await paymentStatus(n.id)).toBe('succeeded');
    identities.admin = saved;

    // after a failed attempt, a retry is a NEW attempt: refused once the authority is gone
    as('admin', [membership(ORG_A)]);
    const f = await create(id);
    const failed = (await startAs(f.id, 'admin').expect(201)).body;
    await outcome(f.id, failed.id, { outcome: 'failed', failureCode: 'card_declined' });
    expect(await paymentStatus(f.id)).toBe('created');
    as('admin', [membership(ORG_A, { isOrganizationAdmin: false })]);
    const r = await startAs(f.id, 'admin');
    expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);
    expect((await attempts(f.id)).map((x: Row) => x.status)).toEqual(['failed']);
  });

  it('L: replaying the key of an authorized attempt after revocation is refused, creates nothing and calls no provider; restored, it replays the SAME attempt', async () => {
    const p = await create(as('admin', [membership(ORG_A)]));
    const key = `k-${crypto.randomUUID()}`;
    const a = (await startAs(p.id, 'admin', key).expect(201)).body;
    const events = await outbox(p.id);
    as('admin', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]);
    const r = await startAs(p.id, 'admin', key);
    expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);
    expect(await attempts(p.id)).toEqual([{ id: a.id, status: 'submitted' }]);
    expect(await outbox(p.id)).toBe(events);
    as('admin', [membership(ORG_A)]);
    const again = (await startAs(p.id, 'admin', key).expect(201)).body;
    expect(again.id).toBe(a.id); // the stored response: no second attempt, no second provider initiation
    expect(await attempts(p.id)).toEqual([{ id: a.id, status: 'submitted' }]);
  });

  it('M: the consistency boundary is this request\'s live Auth read — a revocation committed after it does not undo that attempt; every later read refuses', async () => {
    const p = await create(as('admin', [membership(ORG_A)]));
    afterAnswer = (bearer) => { if (bearer === 'admin') as('admin', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]); };
    const a = (await startAs(p.id, 'admin').expect(201)).body; // authorized on the answer read before the revocation committed
    await outcome(p.id, a.id, { outcome: 'failed', failureCode: 'card_declined' });
    const r = await startAs(p.id, 'admin');
    expect([r.status, r.body.code]).toEqual([403, 'operation_not_permitted']);

    // concurrent starts racing one revocation: the first Auth answer is the only qualifying one, so at most one attempt exists
    const q = await create(as('racer', [membership(ORG_A)]));
    let answered = 0;
    afterAnswer = (bearer) => { if (bearer === 'racer' && ++answered === 1) as('racer', [membership(ORG_A, { status: 'revoked', isOrganizationAdmin: false })]); };
    const results = await Promise.all(Array.from({ length: 8 }, () => startAs(q.id, 'racer')));
    const codes = results.map((x) => (x.status === 201 ? 201 : `${x.status}:${x.body.code}`));
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c !== 201).every((c) => c === '403:operation_not_permitted')).toBe(true);
    expect(await attempts(q.id)).toHaveLength(1);

    // concurrent starts by a qualifying administrator keep the existing one-open-attempt rule
    afterAnswer = undefined;
    const c = await create(as('admin-c', [membership(ORG_A)]));
    const many = await Promise.all(Array.from({ length: 8 }, () => startAs(c.id, 'admin-c')));
    expect(many.filter((x) => x.status === 201)).toHaveLength(1);
    expect(many.filter((x) => x.status !== 201).every((x) => x.status === 409)).toBe(true);
    expect(await attempts(c.id)).toHaveLength(1);
  });

  it('N: other purposes are unchanged: a user payer with no membership starts a direct purchase or a non-entitlement attempt', async () => {
    const buyer = as('buyer', []);
    const purchase = await create(buyer, { purpose: 'direct_purchase', beneficiaryUserId: buyer, organizationId: undefined });
    await startAs(purchase.id, 'buyer').expect(201);
    const other = await create(buyer, { purpose: 'non_entitlement' });
    await startAs(other.id, 'buyer').expect(201);
  });

  it('nothing is checked at creation: a subscription payment names a payer who is not (yet) an administrator', async () => {
    const p = await create(as('future-admin', []));
    expect(p).toMatchObject({ purpose: 'organization_subscription', organizationId: ORG_A, payer: { type: 'user' }, status: 'created' });
    as('future-admin', [membership(ORG_A)]);
    await startAs(p.id, 'future-admin').expect(201);
  });
});
