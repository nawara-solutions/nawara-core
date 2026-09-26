import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { releaseMigrationsDir } from '../src/app.module.js';
import { deterministicEventId } from '../src/audit/release-audit.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

type Row = Record<string, any>;

const OPERATING = randomUUID();
const OTHER_COMPANY = randomUUID();
const OWNER = randomUUID();
const AUTH_TIMEOUT_MS = 800;

/**
 * Stage 20.4 (ADR-0051 decision 8, ADR-0050): the owner of the configured operating Company withdraws releases and changes minimum versions,
 * with their OWN bearer verified live through Auth and a factor step-up per operation, through the REAL application as the least-privilege
 * runtime role on real PostgreSQL 16. Auth is a stub of exactly its contract that records what it receives.
 */
describeWithEnv('release-service owner administration (Stage 20.4) — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const auth = new FakeAuth();
  const ci = generateServiceToken();
  const server = () => t.app.getHttpServer();
  let n = 0;
  const key = (p = 'c') => `${p}-${n++}`;

  // bearers: the operating owner (two sessions), another Company's owner, an operator, a member
  const B = { owner: 'owner-session-1', owner2: 'owner-session-2', otherOwner: 'other-owner', operator: 'operator-1', member: 'member-1' };

  const register = (component: string, version: string, kind = 'web') =>
    request(server()).post(`/release/products/prod/components/${component}/releases`).set('authorization', `Bearer ${ci.token}`).send({ kind, version });
  const publishCi = (component: string, version: string) =>
    request(server()).post(`/release/products/prod/components/${component}/releases/${version}/publish`).set('authorization', `Bearer ${ci.token}`);
  const published = async (component: string, versions: string[], kind = 'web') => {
    for (const v of versions) {
      expect((await register(component, v, kind)).status).toBe(201);
      expect((await publishCi(component, v)).status).toBe(200);
    }
  };
  const withdraw = (component: string, version: string, opts: { bearer?: string | null; proof?: string | null; headers?: Record<string, string> } = {}) => {
    const bearer = opts.bearer === undefined ? B.owner : opts.bearer;
    const proof = opts.proof === undefined ? auth.issue(bearer ?? '', 'release.withdraw') : opts.proof;
    let r = request(server()).post(`/release/admin/products/prod/components/${component}/releases/${version}/withdraw`);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (proof) r = r.set('x-step-up-token', proof);
    return r.set(opts.headers ?? {});
  };
  const policy = (component: string, body: Row, opts: { bearer?: string | null; proof?: string | null; headers?: Record<string, string> } = {}) => {
    const bearer = opts.bearer === undefined ? B.owner : opts.bearer;
    const proof = opts.proof === undefined ? auth.issue(bearer ?? '', 'compatibility_policy.change') : opts.proof;
    let r = request(server()).post(`/release/admin/products/prod/components/${component}/compatibility-policy`);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (proof) r = r.set('x-step-up-token', proof);
    return r.set(opts.headers ?? {}).send(body);
  };
  const status = async (component: string, version: string) =>
    (await sql<Row>(d.adminUrl, `SELECT r.status, r."withdrawnAt" FROM release r JOIN component c ON c.id = r."componentId" WHERE c.key = $1 AND r.version = $2`, [component, version]))[0];
  const policies = (component: string) =>
    sql<Row>(d.adminUrl, `SELECT p."policyVersion", p."minimumVersion" FROM compatibility_policy p JOIN component c ON c.id = p."componentId" WHERE c.key = $1 ORDER BY 1`, [component]);
  const adminAudits = () => sql<Row>(d.adminUrl, `SELECT id, name, payload, "correlationId" FROM outbox WHERE name IN ('audit.release.withdrawn', 'audit.compatibility_policy.changed') ORDER BY "occurredAt", id`);
  const componentId = async (component: string) => (await sql<Row>(d.adminUrl, `SELECT id, "productId" FROM component WHERE key = $1`, [component]))[0]!;
  const releaseId = async (component: string, version: string) =>
    (await sql<Row>(d.adminUrl, `SELECT r.id FROM release r JOIN component c ON c.id = r."componentId" WHERE c.key = $1 AND r.version = $2`, [component, version]))[0]!.id as string;
  const counts = async () => (await sql<Row>(d.adminUrl, `SELECT (SELECT count(*)::int FROM release WHERE status = 'withdrawn') w, (SELECT count(*)::int FROM compatibility_policy) p, (SELECT count(*)::int FROM outbox) o`))[0]!;
  const refuseOutbox = (name: string) =>
    sql(d.adminUrl, `CREATE OR REPLACE FUNCTION s204_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                     CREATE TRIGGER s204_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = '${name}') EXECUTE FUNCTION s204_refuse()`);

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: OWNER, kind: 'owner', companyId: OPERATING.toUpperCase() });
    auth.identities.set(B.owner2, { userId: OWNER, kind: 'owner', companyId: OPERATING });
    auth.identities.set(B.otherOwner, { userId: randomUUID(), kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set(B.operator, { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: randomUUID(), kind: 'member', companyId: null });
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'reladmin');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, releaseMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      env: {
        SERVICE_TOKENS: `prod-ci:${ci.digest}`,
        RELEASE_SERVICE_POLICY: JSON.stringify({ callers: { 'prod-ci': { products: { prod: ['release.register', 'release.publish'] } } } }),
        AUTH_SERVICE_URL: auth.url, RELEASE_OPERATING_COMPANY_ID: OPERATING, AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    await auth.stop();
  });
  afterEach(async () => {
    auth.mode = 'ok';
    await sql(d.adminUrl, 'DROP TRIGGER IF EXISTS s204_refuse ON outbox');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── identity and authority
  describe('identity and authority: the human\'s own bearer, verified live; only the operating Company\'s owner', () => {
    it('no bearer, a malformed one, or a bearer Auth refuses (expired, revoked, blocked): 401 on both operations, nothing changed', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const before = await counts();
      for (const bearer of [null, 'unknown-or-expired-session']) {
        expect((await withdraw(c, '2.0.0', { bearer })).status).toBe(401);
        expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { bearer })).status).toBe(401);
      }
      const malformed = await request(server()).post(`/release/admin/products/prod/components/${c}/compatibility-policy`).set('authorization', 'Basic abc').send({});
      expect(malformed.status).toBe(401);
      expect(await counts()).toEqual(before);
    });

    it('a CI SERVICE token is never a human: 401, and it is never forwarded to Auth', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const sent = auth.received.length;
      expect((await withdraw(c, '2.0.0', { bearer: ci.token, proof: randomUUID() })).status).toBe(401);
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { bearer: ci.token, proof: randomUUID() })).status).toBe(401);
      expect(auth.received.length).toBe(sent);
      expect(JSON.stringify(auth.received)).not.toContain(ci.token);
      expect((await status(c, '2.0.0'))!.status).toBe('published');
    });

    it.each([
      ['a member', 'member'],
      ['an operator (no Release Management authority in Core V1)', 'operator'],
      ['the owner of ANOTHER Company', 'otherOwner'],
    ] as const)('%s: 403 operation_not_allowed (one answer), before any lookup or step-up; nothing changed', async (_n, who) => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const before = await counts();
      const verifies = auth.requests('/auth/step-up/verify');
      const w = await withdraw(c, '2.0.0', { bearer: B[who] });
      const p = await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { bearer: B[who] });
      const ghost = await withdraw('no-such-component', '9.9.9', { bearer: B[who] }); // an unknown target: the same answer (no enumeration)
      const garbage = await policy('BAD KEY', { environment: 'prod' }, { bearer: B[who] }); // not even validated
      for (const r of [w, p, ghost, garbage]) expect([r.status, r.body.code]).toEqual([403, 'operation_not_allowed']);
      expect({ ...w.body, requestId: 0 }).toEqual({ ...ghost.body, requestId: 0 });
      expect(auth.requests('/auth/step-up/verify')).toBe(verifies);
      expect(await counts()).toEqual(before);
    });

    it('identity headers never make an owner: a member naming itself owner, user or Company is still refused', async () => {
      const c = key();
      await published(c, ['1.0.0']);
      const forged = { 'x-user-id': OWNER, 'x-owner': 'true', 'x-role': 'owner', 'x-company': OPERATING, 'x-organization': randomUUID(), 'x-user-kind': 'owner', 'x-acting-user': OWNER };
      const r = await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { bearer: B.member, headers: forged });
      expect([r.status, r.body.code]).toEqual([403, 'operation_not_allowed']);
      // and the owner's own request forwards ONLY the owner's bearer to Auth
      await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { headers: forged });
      const last = auth.received.slice(-2);
      expect(last.map((x) => x.authorization)).toEqual([`Bearer ${B.owner}`, `Bearer ${B.owner}`]);
      expect(JSON.stringify(last)).not.toContain(OPERATING);
    });

    it.each([
      ['Auth down (500)', 'down', 'auth_unavailable'],
      ['Auth resets the connection', 'reset', 'auth_unavailable'],
      ['Auth redirects (never followed; the bearer goes nowhere else)', 'redirect', 'auth_unavailable'],
      ['Auth answers 204', 'no_content', 'auth_unavailable'],
      ['Auth answers an empty object', 'empty', 'auth_unavailable'],
      ['Auth answers an unknown kind', 'bad_kind', 'auth_unavailable'],
      ['Auth answers more than 16 KiB', 'oversized', 'auth_unavailable'],
      ['Auth hangs', 'hang', 'auth_timeout'],
      ['Auth sends headers then stalls', 'slow_body', 'auth_timeout'],
    ] as const)('%s: 503 %s, fail closed, nothing changed, no step-up spent', async (_n, mode, code) => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const before = await counts();
      auth.mode = mode;
      const proof = auth.issue(B.owner, 'release.withdraw');
      const r = await withdraw(c, '2.0.0', { proof });
      expect([r.status, r.body.code]).toEqual([503, code]);
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|ECONN|socket|padding|Internal Server/);
      expect(auth.consumed(proof)).toBe(false);
      expect(await counts()).toEqual(before);
      expect(auth.sinkReceived).toEqual([]);
    });

    it('ONE Auth budget per request: the owner check and a hanging step-up together fail within the budget (auth_timeout), never 2×', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      auth.mode = 'hang_step_up';
      const t0 = Date.now();
      const r = await withdraw(c, '2.0.0');
      expect([r.status, r.body.code]).toEqual([503, 'auth_timeout']);
      expect(Date.now() - t0).toBeLessThan(AUTH_TIMEOUT_MS * 1.6);
      expect((await status(c, '2.0.0'))!.status).toBe('published');
      auth.mode = 'slow_grants_hang_step_up'; // 500 ms spent verifying the owner leaves only the rest of the budget for the step-up
      const t1 = Date.now();
      expect((await withdraw(c, '2.0.0')).body.code).toBe('auth_timeout');
      expect(Date.now() - t1).toBeLessThan(AUTH_TIMEOUT_MS + 350); // shared: ≈ 800 ms; independent timeouts would take ≈ 1300 ms
      auth.mode = 'down_step_up';
      expect([(await withdraw(c, '2.0.0')).body.code]).toEqual(['auth_unavailable']);
    });

    it('without owner-administration configuration the routes do not exist (fail closed)', async () => {
      const bare = await createTestApp({ databaseUrl: d.appUrl });
      try {
        const r = await request(bare.app.getHttpServer()).post('/release/admin/products/prod/components/x/releases/1.0.0/withdraw').set('authorization', `Bearer ${B.owner}`);
        expect(r.status).toBe(404);
      } finally {
        await bare.app.close();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── step-up
  describe('mandatory factor step-up, verified and consumed through Auth', () => {
    it('absent or malformed: 403 step_up_required, Auth is not even asked; nothing changed', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const verifies = auth.requests('/auth/step-up/verify');
      for (const proof of [null, 'mfa=true', 'true', 'x'.repeat(36), `${randomUUID()}x`]) {
        const r = await withdraw(c, '2.0.0', { proof });
        expect([r.status, r.body.code], String(proof)).toEqual([403, 'step_up_required']);
      }
      expect(auth.requests('/auth/step-up/verify')).toBe(verifies);
      expect((await status(c, '2.0.0'))!.status).toBe('published');
    });

    it('unknown, expired, wrong-purpose, wrong-session and replayed proofs are refused; assurance headers are ignored', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const refused = async (proof: string, bearer = B.owner) => {
        const r = await withdraw(c, '2.0.0', { proof, bearer, headers: { 'x-mfa': 'true', 'x-step-up-verified': 'true', 'x-assurance': 'aal2' } });
        expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
      };
      await refused(randomUUID());
      await refused(auth.issue(B.owner, 'release.withdraw', -1)); // expired
      await refused(auth.issue(B.owner, 'compatibility_policy.change')); // the other purpose
      await refused(auth.issue(B.owner, 'account.suspend')); // another, unrelated purpose
      await refused(auth.issue(B.owner2, 'release.withdraw')); // another session of the same owner
      const once = auth.issue(B.owner, 'release.withdraw');
      expect((await withdraw(c, '2.0.0', { proof: once })).status).toBe(200);
      const r = await withdraw(c, '2.0.0', { proof: once }); // replay
      expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
      const rid = await releaseId(c, '2.0.0');
      expect((await adminAudits()).filter((a) => a.payload.resource.id === rid)).toHaveLength(1);
    });

    it('a precondition refusal NEVER spends the proof (checked before Auth consumes it); the same proof then succeeds', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      await register(c, '3.0.0');
      expect((await policy(c, { minimumVersion: '2.0.0', expectedPolicyVersion: 0 })).status).toBe(200);
      const proof = auth.issue(B.owner, 'release.withdraw');
      for (const [version, code] of [['2.0.0', 'would_break_minimum'], ['3.0.0', 'invalid_transition']] as const) {
        const r = await withdraw(c, version, { proof });
        expect([r.status, r.body.code]).toEqual([409, code]);
      }
      expect((await withdraw(c, '9.9.9', { proof })).status).toBe(404);
      expect(auth.consumed(proof)).toBe(false);
      const pProof = auth.issue(B.owner, 'compatibility_policy.change');
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 }, { proof: pProof })).body.code).toBe('policy_conflict');
      expect(auth.consumed(pProof)).toBe(false);
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 1 }, { proof: pProof })).body).toMatchObject({ changed: true, policyVersion: 2 });
      expect((await withdraw(c, '2.0.0', { proof })).body).toMatchObject({ status: 'withdrawn', changed: true });
    });

    it('a mutation that fails AFTER the proof was consumed (the outbox refuses) changes nothing; the proof is spent in Auth (cross-service), a new one succeeds once', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      await refuseOutbox('audit.release.withdrawn');
      const proof = auth.issue(B.owner, 'release.withdraw');
      const r = await withdraw(c, '2.0.0', { proof });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/outbox|refused|trigger|sql/i);
      expect((await status(c, '2.0.0'))!.status).toBe('published');
      expect(auth.consumed(proof)).toBe(true);
      await sql(d.adminUrl, 'DROP TRIGGER s204_refuse ON outbox');
      expect((await withdraw(c, '2.0.0', { proof })).body.code).toBe('step_up_required');
      expect((await withdraw(c, '2.0.0')).body).toMatchObject({ changed: true, status: 'withdrawn' });
      const rid = await releaseId(c, '2.0.0');
      expect((await adminAudits()).filter((a) => a.payload.resource.id === rid)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── withdrawal
  describe('withdrawal', () => {
    it('published → withdrawn: one release.withdrawn with the OWNER as actor; a retry is 200 changed:false (a new proof is still required and spent) and writes nothing', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0'], 'desktop');
      const r = await withdraw(c, '2.0.0', { headers: { 'x-correlation-id': 'owner-withdraw-0001' } });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.body).toMatchObject({ product: 'prod', component: c, kind: 'desktop', version: '2.0.0', status: 'withdrawn', changed: true, withdrawnAt: expect.any(String) });
      const retryProof = auth.issue(B.owner, 'release.withdraw');
      const again = await withdraw(c, '2.0.0', { proof: retryProof });
      expect([again.status, again.body.changed, again.body.withdrawnAt]).toEqual([200, false, r.body.withdrawnAt]);
      expect(auth.consumed(retryProof)).toBe(true); // the Stage 19.2 rule: a sensitive no-op still requires and spends a valid step-up
      const id = await releaseId(c, '2.0.0');
      const rows = (await adminAudits()).filter((a) => a.payload.resource.id === id);
      expect(rows).toHaveLength(1);
      const cid = await componentId(c);
      expect(rows[0]).toMatchObject({ id: deterministicEventId(id, 'audit.release.withdrawn'), name: 'audit.release.withdrawn', correlationId: 'owner-withdraw-0001' });
      expect(rows[0]!.payload).toEqual({
        action: 'release.withdrawn', actor: { type: 'user', id: OWNER, userKind: 'owner' }, organizationId: null, resource: { type: 'release', id }, outcome: 'succeeded',
        changes: { product_id: cid.productId, component_id: cid.id, kind: 'desktop' },
      });
      expect(() => validateAuditPayload(rows[0]!.payload, 'release-service')).not.toThrow();
      const text = JSON.stringify(rows[0]);
      for (const leak of [B.owner, retryProof, '2.0.0', 'authorization', 'Bearer', OPERATING]) expect(text).not.toContain(leak);
    });

    it('a withdrawn release is never latest again, never republished by CI, and keeps its identity', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const before = (await sql<Row>(d.adminUrl, `SELECT id, version, "buildId", "registeredAt", "publishedAt" FROM release WHERE id = $1`, [await releaseId(c, '2.0.0')]))[0];
      await withdraw(c, '2.0.0');
      expect([(await publishCi(c, '2.0.0')).status, (await publishCi(c, '2.0.0')).body.code]).toEqual([409, 'invalid_transition']);
      const after = (await sql<Row>(d.adminUrl, `SELECT id, version, "buildId", "registeredAt", "publishedAt" FROM release WHERE id = $1`, [before!.id]))[0];
      expect(after).toEqual(before);
      const [latest] = await sql<Row>(d.adminUrl, `SELECT version FROM release r JOIN component c ON c.id = r."componentId" WHERE c.key = $1 AND status = 'published' AND prerelease IS NULL ORDER BY major DESC, minor DESC, patch DESC LIMIT 1`, [c]);
      expect(latest!.version).toBe('1.0.0');
    });

    it('registered-only (never published): 409 invalid_transition (ADR-0051 unchanged); a published pre-release can be withdrawn', async () => {
      const c = key();
      await register(c, '1.0.0');
      expect((await withdraw(c, '1.0.0')).body.code).toBe('invalid_transition');
      expect((await status(c, '1.0.0'))!.status).toBe('registered');
      await published(c, ['2.0.0-rc.1']);
      expect((await withdraw(c, '2.0.0-rc.1')).body).toMatchObject({ status: 'withdrawn', changed: true });
    });

    it('404 release_not_found for an unknown component or version; 400 for malformed ones', async () => {
      const c = key();
      await published(c, ['1.0.0']);
      for (const [comp, v] of [[c, '1.0.1'], ['nope', '1.0.0']]) expect((await withdraw(comp!, v!)).body.code).toBe('release_not_found');
      for (const [comp, v] of [[c, 'v1.0.0'], [c, '1.0.0%2B1'], ['Bad', '1.0.0']]) expect([(await withdraw(comp!, v!)).status]).toEqual([400]);
    });

    it('minimum ≤ latest: withdrawing the latest above the minimum is allowed; withdrawing the one release that keeps the minimum valid is refused', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0', '3.0.0']);
      expect((await policy(c, { minimumVersion: '2.0.0', expectedPolicyVersion: 0 })).body.changed).toBe(true);
      expect((await withdraw(c, '3.0.0')).body).toMatchObject({ changed: true }); // new latest 2.0.0 = minimum: allowed
      const r = await withdraw(c, '2.0.0'); // new latest 1.0.0 < minimum 2.0.0
      expect([r.status, r.body.code]).toEqual([409, 'would_break_minimum']);
      expect((await status(c, '2.0.0'))!.status).toBe('published');
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 1 })).body.changed).toBe(true); // lower first…
      expect((await withdraw(c, '2.0.0')).body.changed).toBe(true); // …then it is allowed
    });

    it('concurrency: 6 simultaneous withdrawals of one release (each with its own proof) → one transition, one withdrawnAt, ONE record', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      const rs = await Promise.all(Array.from({ length: 6 }, () => withdraw(c, '2.0.0')));
      expect(rs.map((r) => r.status)).toEqual(Array(6).fill(200));
      expect(rs.filter((r) => r.body.changed)).toHaveLength(1);
      expect(new Set(rs.map((r) => r.body.withdrawnAt)).size).toBe(1);
      const id = await releaseId(c, '2.0.0');
      expect((await adminAudits()).filter((a) => a.payload.resource.id === id)).toHaveLength(1);
    });

    it('CI cannot withdraw: its automation API has no such route, and its token is not a human', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0']);
      expect((await request(server()).post(`/release/products/prod/components/${c}/releases/2.0.0/withdraw`).set('authorization', `Bearer ${ci.token}`)).status).toBe(404);
      expect((await withdraw(c, '2.0.0', { bearer: ci.token })).status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── compatibility policy
  describe('minimum-version policy', () => {
    it('append-only: each change is the next policy version; history is kept; one compatibility_policy.changed per change, naming the releases', async () => {
      const c = key();
      await published(c, ['1.0.0', '1.5.0', '2.0.0'], 'mobile_ios');
      const first = await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ product: 'prod', component: c, kind: 'mobile_ios', policyVersion: 1, minimumVersion: '1.0.0', changed: true });
      const second = await policy(c, { minimumVersion: '1.5.0', expectedPolicyVersion: 1 }, { headers: { 'x-correlation-id': 'owner-policy-0002' } });
      expect(second.body).toMatchObject({ policyVersion: 2, minimumVersion: '1.5.0', changed: true });
      expect(await policies(c)).toEqual([{ policyVersion: 1, minimumVersion: '1.0.0' }, { policyVersion: 2, minimumVersion: '1.5.0' }]);
      const cid = await componentId(c);
      const rows = (await adminAudits()).filter((a) => a.payload.resource.id === cid.id);
      expect(rows.map((r) => r.id)).toEqual([deterministicEventId(cid.id, '1', 'audit.compatibility_policy.changed'), deterministicEventId(cid.id, '2', 'audit.compatibility_policy.changed')]);
      expect(rows[1]!.correlationId).toBe('owner-policy-0002');
      expect(rows[0]!.payload.changes).toEqual({ product_id: cid.productId, kind: 'mobile_ios', policy_version: { from: 0, to: 1 }, minimum_release_id: await releaseId(c, '1.0.0') });
      expect(rows[1]!.payload).toEqual({
        action: 'compatibility_policy.changed', actor: { type: 'user', id: OWNER, userKind: 'owner' }, organizationId: null, resource: { type: 'component', id: cid.id },
        outcome: 'succeeded', changes: { product_id: cid.productId, kind: 'mobile_ios', policy_version: { from: 1, to: 2 }, minimum_release_id: await releaseId(c, '1.5.0'), previous_minimum_release_id: await releaseId(c, '1.0.0') },
      });
      for (const r of rows) {
        expect(() => validateAuditPayload(r.payload, 'release-service')).not.toThrow();
        expect(JSON.stringify(r.payload)).not.toMatch(/1\.5\.0|1\.0\.0|Bearer|owner-session/);
      }
    });

    it('the minimum already in effect: 200 changed:false, no policy version, no evidence (a valid proof is still required and spent)', async () => {
      const c = key();
      await published(c, ['1.0.0']);
      await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 });
      const before = await counts();
      const proof = auth.issue(B.owner, 'compatibility_policy.change');
      for (const expected of [1, 0]) { // even with a stale expectation (a retry after success): the goal state holds
        const r = await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: expected }, expected === 1 ? { proof } : {});
        expect(r.body).toMatchObject({ changed: false, policyVersion: 1, minimumVersion: '1.0.0' });
      }
      expect(auth.consumed(proof)).toBe(true);
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 1 }, { proof: null })).body.code).toBe('step_up_required');
      expect(await counts()).toEqual(before);
    });

    it.each([
      ['an unknown version', { minimumVersion: '1.9.0', expectedPolicyVersion: 0 }, 409, 'invalid_minimum'],
      ['a registered-only release', { minimumVersion: '3.0.0', expectedPolicyVersion: 0 }, 409, 'invalid_minimum'],
      ['a withdrawn release', { minimumVersion: '2.0.0', expectedPolicyVersion: 0 }, 409, 'invalid_minimum'],
      ['a pre-release', { minimumVersion: '1.1.0-rc.1', expectedPolicyVersion: 0 }, 400, 'validation_error'],
      ['a malformed version', { minimumVersion: 'v1.0.0', expectedPolicyVersion: 0 }, 400, undefined],
      ['build metadata', { minimumVersion: '1.0.0+1', expectedPolicyVersion: 0 }, 400, undefined],
      ['a negative expectation', { minimumVersion: '1.0.0', expectedPolicyVersion: -1 }, 400, undefined],
      ['a string expectation', { minimumVersion: '1.0.0', expectedPolicyVersion: '0' }, 400, undefined],
      ['no expectation', { minimumVersion: '1.0.0' }, 400, undefined],
      ['an unexpected field', { minimumVersion: '1.0.0', expectedPolicyVersion: 0, organizationId: randomUUID() }, 400, undefined],
      ['a reason blob', { minimumVersion: '1.0.0', expectedPolicyVersion: 0, reason: 'free text' }, 400, undefined],
      ['a stale expectation', { minimumVersion: '1.0.0', expectedPolicyVersion: 7 }, 409, 'policy_conflict'],
    ] as const)('%s: refused (%s), nothing written, the proof unspent', async (_n, body, statusCode, code) => {
      const c = key();
      await published(c, ['1.0.0', '1.1.0-rc.1', '2.0.0']);
      await register(c, '3.0.0');
      await withdraw(c, '2.0.0');
      const before = await counts();
      const proof = auth.issue(B.owner, 'compatibility_policy.change');
      const r = await policy(c, body as Row, { proof });
      expect(r.status).toBe(statusCode);
      if (code) expect(r.body.code).toBe(code);
      expect(auth.consumed(proof)).toBe(false);
      expect(await counts()).toEqual(before);
    });

    it('a backend has no policy (409 policy_not_applicable); an unknown component is 404; another component\'s release is not a minimum', async () => {
      const b = key();
      await published(b, ['1.0.0'], 'backend');
      expect((await policy(b, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 })).body.code).toBe('policy_not_applicable');
      expect((await policy('no-such', { minimumVersion: '1.0.0', expectedPolicyVersion: 0 })).body.code).toBe('component_not_found');
      const c = key();
      await published(c, ['1.0.0']);
      expect((await policy(c, { minimumVersion: '5.0.0', expectedPolicyVersion: 0 })).body.code).toBe('invalid_minimum'); // 5.0.0 exists nowhere here
    });

    it('concurrency: two owners\' changes from the same expectation → one wins (v2), the other is 409 policy_conflict; no duplicate version, no lost history', async () => {
      const c = key();
      await published(c, ['1.0.0', '2.0.0', '3.0.0']);
      await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 });
      const rs = await Promise.all(['2.0.0', '3.0.0'].map((m) => policy(c, { minimumVersion: m, expectedPolicyVersion: 1 })));
      expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 409)!.body.code).toBe('policy_conflict');
      const ps = await policies(c);
      expect(ps.map((p) => p.policyVersion)).toEqual([1, 2]);
      expect(ps[1]!.minimumVersion).toBe(rs.find((r) => r.status === 200)!.body.minimumVersion);
      const cid = await componentId(c);
      expect((await adminAudits()).filter((a) => a.payload.resource.id === cid.id)).toHaveLength(2);
    });

    it('concurrency (separate sessions, repeated): "minimum = 3.0.0" racing "withdraw 3.0.0" never commits an invalid state', async () => {
      for (let i = 0; i < 6; i++) {
        const c = key('race');
        await published(c, ['1.0.0', '2.0.0', '3.0.0']);
        await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 });
        const [p, w] = await Promise.all([policy(c, { minimumVersion: '3.0.0', expectedPolicyVersion: 1 }), withdraw(c, '3.0.0')]);
        const [final] = await policies(c).then((x) => x.slice(-1));
        const s3 = (await status(c, '3.0.0'))!.status;
        // Exactly one ordering committed; the invariant holds in the final state.
        if (final!.minimumVersion === '3.0.0') {
          expect(s3).toBe('published');
          expect([w.status, w.body.code]).toEqual([409, 'would_break_minimum']);
        } else {
          expect(s3).toBe('withdrawn');
          expect(p.status).toBe(409);
          expect(['invalid_minimum', 'minimum_above_latest']).toContain(p.body.code);
        }
        const [ok] = await sql<Row>(d.adminUrl, `SELECT bool_and(EXISTS (SELECT 1 FROM release r WHERE r."componentId" = p."componentId" AND r.status = 'published' AND r.prerelease IS NULL
          AND (r.major, r.minor, r.patch) >= (p."minimumMajor", p."minimumMinor", p."minimumPatch"))) AS valid
          FROM compatibility_policy p JOIN component c ON c.id = p."componentId" WHERE c.key = $1 AND p."policyVersion" = (SELECT max("policyVersion") FROM compatibility_policy WHERE "componentId" = p."componentId")`, [c]);
        expect(ok!.valid).toBe(true);
      }
    });

    it('atomicity: when the policy evidence cannot be written, no policy version is added', async () => {
      const c = key();
      await published(c, ['1.0.0']);
      await refuseOutbox('audit.compatibility_policy.changed');
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 })).status).toBe(500);
      expect(await policies(c)).toEqual([]);
      await sql(d.adminUrl, 'DROP TRIGGER s204_refuse ON outbox');
      expect((await policy(c, { minimumVersion: '1.0.0', expectedPolicyVersion: 0 })).body).toMatchObject({ changed: true, policyVersion: 1 });
    });
  });

  it('logs are bounded: no bearer, proof or version text; the refusals and outcomes are one line each', () => {
    const all = JSON.stringify(t.logs);
    for (const b of Object.values(B)) expect(all).not.toContain(b);
    expect(all).not.toContain(ci.token);
    const admin = t.logs.map((l) => String(l.msg)).filter((m) => m.startsWith('release_admin'));
    expect(admin.length).toBeGreaterThan(0);
    for (const m of admin) expect(m).toMatch(/^release_admin(_denied)? operation=(withdraw|policy_change) outcome=[a-z_]+( |$)/);
    expect(admin.some((m) => m.includes('outcome=authority_denied reason=not_operating_owner'))).toBe(true);
  });
});
