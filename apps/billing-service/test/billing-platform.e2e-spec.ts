import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { HttpAuthClient, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';

type Row = Record<string, any>;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const AUTH_TIMEOUT_MS = 800;
/** The test Platforms, known up front so the producer's policy can name them. */
const POOL = Array.from({ length: 80 }, () => randomUUID());
let next = 0;

/**
 * Core V2 S3d (register BIL-01, AUTH-07; S0 §3.6; the Owner's S3d decisions 1-5): `billing_platform`, the Platform commercial configuration,
 * through the REAL application on real PostgreSQL 16, with the REAL hardened Auth client against a stub of exactly Auth's approved routes
 * (`/auth/grants`, `/auth/platform-access/:platformId`, `/auth/me`) that records what Billing sends.
 */
describeWithEnv('billing_platform (Core V2 S3d) — real PostgreSQL, live Auth', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Client;
  const auth = new FakeAuth();
  const producer = generateServiceToken();
  const server = () => t.app.getHttpServer();

  // bearers: the Owner (two sessions), another Company's Owner, an operator, a member, a deactivated member
  const B = { owner: 'owner-session-1', owner2: 'owner-session-2', otherOwner: 'other-owner', operator: 'operator-1', member: 'member-1', inactive: 'inactive-1' };
  const MEMBER = randomUUID();
  const INACTIVE = randomUUID();

  const platform = (companyId = COMPANY) => {
    const id = POOL[next++]!;
    auth.platforms.set(id, companyId);
    return id;
  };
  const configure = (platformId: string, body: unknown = { currency: 'TND' }, bearer: string | null = B.owner, headers: Record<string, string> = {}) => {
    let r = request(server()).post(`/billing/admin/platforms/${platformId}`);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    return r.set(headers).send(body as object);
  };
  const read = (platformId: string, bearer: string | null = B.owner) => {
    let r = request(server()).get(`/billing/admin/platforms/${platformId}`);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    return r;
  };
  const rows = async (platformId: string) => (await admin.query<Row>('SELECT * FROM billing_platform WHERE "platformId" = $1', [platformId])).rows;
  const count = async () => Number((await admin.query('SELECT count(*) FROM billing_platform')).rows[0].count);
  const svc = {
    post: (path: string, body: unknown) => request(server()).post(path).set('authorization', `Bearer ${producer.token}`).send(body as object),
  };
  let seq = 0;
  const product = (platformId: string, target = 'personal', code = `s3d-${++seq}`) =>
    svc.post('/billing/products', { seller: { type: 'company', id: 'nawara' }, code, name: `Plan ${seq}`, subscriptionTarget: target, platformId });
  const price = (productId: string, currency: string, recurring = true) =>
    svc.post('/billing/prices', recurring
      ? { productId, clientReference: `r-${++seq}`, currency, unitAmount: 900, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: new Date().toISOString() }
      : { productId, clientReference: `r-${++seq}`, currency, unitAmount: 900, interval: 'one_time', effectiveFrom: new Date().toISOString() });

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: OWNER, kind: 'owner', companyId: COMPANY.toUpperCase() });
    auth.identities.set(B.owner2, { userId: OWNER, kind: 'owner', companyId: COMPANY });
    auth.identities.set(B.otherOwner, { userId: OTHER_OWNER, kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set(B.operator, { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: MEMBER, kind: 'member', companyId: null });
    auth.identities.set(B.inactive, { userId: INACTIVE, kind: 'member', companyId: null, isActive: false });
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings3d');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(`INSERT INTO currency (code, exponent) VALUES ('EUR', 2) ON CONFLICT DO NOTHING`); // a second currency, this database only
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      authClient: new HttpAuthClient({ baseUrl: auth.url, timeoutMs: AUTH_TIMEOUT_MS }),
      ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }),
      env: {
        AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS),
        BILLING_SUPPORTED_CURRENCIES: 'TND,EUR',
        // the producer may act in every test Platform (a fixture): the projection, not the admission, is under test
        BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: POOL } } }),
      },
    });
  });
  afterEach(() => auth.reset());
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
    await auth.stop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the Owner's configuration

  it('the Owner configures their Platform: 201 {platformId, companyId, currency, createdAt}; the Company is Auth\'s, never the body\'s', async () => {
    const p = platform();
    const r = await configure(p);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['companyId', 'createdAt', 'currency', 'platformId']);
    expect(r.body).toMatchObject({ platformId: p, companyId: COMPANY, currency: 'TND' });
    expect(r.headers['cache-control']).toBe('no-store');
    const [row] = await rows(p);
    expect(row).toMatchObject({ companyId: COMPANY, currency: 'TND', createdBy: OWNER });
    // the live checks, in order, with the Owner's own bearer only
    expect(auth.received.map((x) => x.path)).toEqual(['/auth/grants', `/auth/platform-access/${p}`]);
    expect(auth.received.every((x) => x.authorization === `Bearer ${B.owner}`)).toBe(true);
  });

  it('a body naming a Company (or anything but currency) is refused before anything is written; a Company header changes nothing', async () => {
    const p = platform();
    for (const body of [{ currency: 'TND', companyId: OTHER_COMPANY }, { currency: 'TND', createdBy: OTHER_OWNER }, { currency: 'tnd' }, {}, []]) {
      const r = await configure(p, body);
      expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, 'invalid_billing_platform_request']);
    }
    expect(await rows(p)).toEqual([]);
    const r = await configure(p, { currency: 'TND' }, B.owner, { 'x-company-id': OTHER_COMPANY, 'x-user-id': OTHER_OWNER });
    expect(r.status).toBe(201);
    expect(r.body.companyId).toBe(COMPANY);
  });

  it('an identical repeat is 200 with the existing row (Idempotent-Replayed), from any session of the Owner; nothing is written', async () => {
    const p = platform();
    const first = await configure(p);
    const again = await configure(p, { currency: 'TND' }, B.owner2);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await rows(p)).toHaveLength(1);
  });

  it('a different currency for the Owner\'s configured Platform is 409 billing_platform_exists; the row is unchanged', async () => {
    const p = platform();
    await configure(p);
    const r = await configure(p, { currency: 'EUR' });
    expect([r.status, r.body.code]).toEqual([409, 'billing_platform_exists']);
    expect((await rows(p))[0].currency).toBe('TND');
  });

  it('an unsupported currency is 422 unsupported_currency; nothing is written', async () => {
    const p = platform();
    const r = await configure(p, { currency: 'USD' });
    expect([r.status, r.body.code]).toEqual([422, 'unsupported_currency']);
    expect(await rows(p)).toEqual([]);
  });

  it('GET returns the Owner\'s configuration; an unconfigured Platform of theirs is 404', async () => {
    const p = platform();
    expect((await read(p)).status).toBe(404);
    const created = await configure(p, { currency: 'EUR' });
    const r = await read(p, B.owner2);
    expect(r.status).toBe(200);
    expect(r.body).toEqual(created.body);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── non-disclosure

  it('another Company\'s Owner learns nothing: an unknown, an unconfigured and a configured foreign Platform are the same 404, and nothing is written', async () => {
    const configured = platform();
    await configure(configured);
    const unconfigured = platform();
    const unknown = randomUUID();
    const answers = [];
    for (const p of [configured, unconfigured, unknown]) {
      answers.push([(await configure(p, { currency: 'TND' }, B.otherOwner)).status, (await configure(p, { currency: 'EUR' }, B.otherOwner)).body.code, (await read(p, B.otherOwner)).status]);
    }
    expect(answers).toEqual([[404, 'not_found', 404], [404, 'not_found', 404], [404, 'not_found', 404]]);
    expect(await rows(unconfigured)).toEqual([]);
    expect((await rows(configured))[0].companyId).toBe(COMPANY);
  });

  it('a Platform whose Company changed in Auth after it was configured is never re-pointed or confirmed: 404 for the new Company\'s Owner', async () => {
    const p = platform();
    await configure(p);
    auth.platforms.set(p, OTHER_COMPANY); // Auth now places it elsewhere
    expect((await read(p, B.otherOwner)).status).toBe(404);
    const r = await configure(p, { currency: 'EUR' }, B.otherOwner);
    expect([r.status, r.body.code]).toEqual([404, 'not_found']);
    expect((await rows(p))[0]).toMatchObject({ companyId: COMPANY, currency: 'TND' });
    expect(t.logs.some((l) => JSON.stringify(l).includes('billing_platform_company_mismatch'))).toBe(true);
  });

  it.each([
    ['an operator', 'operator', 403],
    ['a member', 'member', 403],
  ] as const)('%s is refused (403 operation_not_permitted) before the Platform is asked about', async (_n, who, status) => {
    const p = platform();
    const r = await configure(p, { currency: 'TND' }, B[who]);
    expect([r.status, r.body.code]).toEqual([status, 'operation_not_permitted']);
    expect(auth.received.map((x) => x.path)).toEqual(['/auth/grants']);
    expect(await rows(p)).toEqual([]);
  });

  it('no bearer, a bearer Auth refuses, and a SERVICE token are 401; a service token is never forwarded to Auth', async () => {
    const p = platform();
    expect((await configure(p, { currency: 'TND' }, null)).status).toBe(401);
    expect((await configure(p, { currency: 'TND' }, 'revoked-session')).status).toBe(401);
    auth.received.length = 0;
    expect((await configure(p, { currency: 'TND' }, producer.token)).status).toBe(401);
    expect((await read(p, producer.token)).status).toBe(401);
    expect(auth.received).toEqual([]);
    expect(await rows(p)).toEqual([]);
  });

  it('a platformId that is not a uuid is 400 and is never sent to Auth', async () => {
    const r = await configure('not-a-uuid');
    expect(r.status).toBe(400);
    expect(auth.received.filter((x) => x.path.startsWith('/auth/platform-access'))).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── fail closed (503)

  it.each([
    ['grants', 'down', 'auth_unavailable'],
    ['grants', 'reset', 'auth_unavailable'],
    ['grants', 'redirect', 'auth_unavailable'],
    ['grants', 'no_content', 'auth_unavailable'],
    ['grants', 'empty', 'auth_unavailable'],
    ['grants', 'bad_kind', 'auth_unavailable'],
    ['grants', 'oversized', 'auth_unavailable'],
    ['grants', 'hang', 'auth_timeout'],
    ['grants', 'slow_body', 'auth_timeout'],
    ['access', 'down', 'auth_unavailable'],
    ['access', 'reset', 'auth_unavailable'],
    ['access', 'redirect', 'auth_unavailable'],
    ['access', 'empty', 'auth_unavailable'],
    ['access', 'oversized', 'auth_unavailable'],
    ['access', 'wrong_platform', 'auth_unavailable'],
    ['access', 'hang', 'auth_timeout'],
  ] as const)('Auth %s answers %s: 503 %s, nothing written, nothing inferred locally', async (target, mode, code) => {
    const p = platform();
    const before = await count();
    auth.target = target;
    auth.mode = mode;
    const r = await configure(p);
    expect([r.status, r.body.code]).toEqual([503, code]);
    expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONN|socket|padding|Internal Server/);
    expect(await count()).toBe(before);
    expect(auth.sinkReceived).toEqual([]); // a redirect is never followed: the bearer goes nowhere else
  });

  it('an already configured Platform is still refused (503) when Auth cannot confirm the Owner: no cached authority', async () => {
    const p = platform();
    await configure(p);
    auth.target = 'access';
    auth.mode = 'down';
    expect([(await read(p)).status, (await configure(p)).status]).toEqual([503, 503]);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency

  it('8 concurrent identical first writes: exactly one 201, seven 200 replays, one row', async () => {
    const p = platform();
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => configure(p, { currency: 'TND' }, i % 2 ? B.owner2 : B.owner)));
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await rows(p)).toHaveLength(1);
  });

  it('8 concurrent first writes with different currencies: one wins; every other currency is 409, the same currency a 200 replay', async () => {
    const p = platform();
    const currencies = ['TND', 'EUR', 'TND', 'EUR', 'TND', 'EUR', 'TND', 'EUR'];
    const rs = await Promise.all(currencies.map((c) => configure(p, { currency: c })));
    const [row] = await rows(p);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    rs.forEach((r, i) => {
      if (r.status === 201) expect(currencies[i]).toBe(row!.currency);
      else if (currencies[i] === row!.currency) expect(r.status).toBe(200);
      else expect([r.status, r.body.code]).toEqual([409, 'billing_platform_exists']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── projection enforcement

  it.each(['personal', 'organization'])('a new %s subscription product needs its Platform configured (409 platform_not_configured), then is accepted', async (target) => {
    const p = platform();
    const refused = await product(p, target, `need-${target}-${++seq}`);
    expect([refused.status, refused.body.code]).toEqual([409, 'platform_not_configured']);
    expect((await admin.query('SELECT count(*) FROM product WHERE "platformId" = $1', [p])).rows[0].count).toBe('0');
    await configure(p);
    expect((await product(p, target)).status).toBe(201);
  });

  it('an ordinary product needs no Platform configuration', async () => {
    const r = await svc.post('/billing/products', { seller: { type: 'company', id: 'nawara' }, code: `none-${++seq}`, name: 'Ordinary' });
    expect(r.status).toBe(201);
    const pr = await price(r.body.id, 'EUR', false);
    expect(pr.status).toBe(201);
  });

  it("a subscription product's prices use its Platform's currency (422 unsupported_currency otherwise); a replay still answers 200", async () => {
    const p = platform();
    await configure(p, { currency: 'EUR' });
    const code = `cur-${++seq}`;
    const prod = await product(p, 'personal', code);
    expect(prod.status).toBe(201);
    const wrong = await price(prod.body.id, 'TND');
    expect([wrong.status, wrong.body.code]).toEqual([422, 'unsupported_currency']);
    const right = await price(prod.body.id, 'EUR');
    expect(right.status).toBe(201);
    const replay = await svc.post('/billing/products', { seller: { type: 'company', id: 'nawara' }, code, name: prod.body.name, subscriptionTarget: 'personal', platformId: p });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200); // the natural key answers as before
    expect(replay.body.id).toBe(prod.body.id);
  });

  it('a pre-S3d subscription product on an unconfigured Platform (no backfill) still replays and still takes prices', async () => {
    const p = platform();
    const code = `legacy-${++seq}`;
    // created before S3d: the guard did not exist (simulated by bypassing triggers for this one insert)
    await admin.query('SET session_replication_role = replica');
    await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ('test-producer', 'company', 'nawara', $1, 'Legacy', 'active', 'personal', $2)`, [code, p]);
    await admin.query('SET session_replication_role = DEFAULT');
    const replay = await svc.post('/billing/products', { seller: { type: 'company', id: 'nawara' }, code, name: 'Legacy', subscriptionTarget: 'personal', platformId: p });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect((await price(replay.body.id, 'TND')).status).toBe(201);
    expect(await rows(p)).toEqual([]); // nothing fabricated: no Company is invented for it
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── AUTH-07: live /auth/me (unchanged)

  it('user-token routes still verify the identity live through /auth/me on every request: no cache, an inactive or revoked user is 401, Auth down is 503', async () => {
    const id = randomUUID();
    const get = (bearer: string) => request(server()).get(`/billing/invoices/${id}`).set('authorization', `Bearer ${bearer}`);
    expect((await get(B.member)).status).toBe(404); // passes the guard; no such invoice for this payer
    expect((await get(B.member)).status).toBe(404);
    expect(auth.received.filter((x) => x.path === '/auth/me')).toHaveLength(2); // asked each time
    expect((await get(B.inactive)).status).toBe(401);
    expect((await get('revoked-session')).status).toBe(401);
    auth.identities.set(B.member, { userId: MEMBER, kind: 'member', companyId: null, isActive: false }); // deactivated between requests
    expect((await get(B.member)).status).toBe(401);
    auth.identities.set(B.member, { userId: MEMBER, kind: 'member', companyId: null });
    auth.target = 'me';
    auth.mode = 'down';
    expect((await get(B.member)).status).toBe(503);
  });
});
