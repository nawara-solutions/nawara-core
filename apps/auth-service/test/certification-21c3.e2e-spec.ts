import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { retireWrites } from '../src/hierarchy/hierarchy-authority.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, OutboxRelayService, OutboxService } from '@nawara/service-kit';
import { CODE_EVENT_PURGE_BATCH, CodeEventPurge } from '../src/events/code-event-purge.js';
import { CODE_BEARING_EVENTS } from '../src/events/domain-events.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 21.C.3 (focused certification of Stage 21.C.2), on real PostgreSQL with the service's real outbox writer, relay and purge:
 * §17/§21 the code-bearing events through their REAL routes (committed with their change; none when the change is refused), and §24 the
 * purge running CONCURRENTLY with the relay (an unexpired code row is never deleted before it is published; each is published once).
 */
describe('21.C.3 Auth code-bearing events and the purge beside the relay', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;
  const rowsOf = async (name: string, where = 'true', params: unknown[] = []) =>
    (await t.db.query(`SELECT id, payload, "publishedAt" FROM outbox WHERE name = $1 AND ${where}`, [name, ...params])).rows;

  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({}, { realEvents: {}, auditBus: bus });
  });
  afterAll(async () => t?.close());

  it('member.contact_verification_requested: one row, committed with the code\'s hash, whose code is the one Auth accepts', async () => {
    const w = await t.world();
    const m = await t.member(w.orgDrive, `m${randomUUID().slice(0, 8)}@x.test`);
    const login = await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200);
    await t.http.post('/auth/contact/request-code').set(bearer(login.body)).expect(204);
    const rows = (await rowsOf('member.contact_verification_requested')).filter((r) => r.payload.userId === m.id);
    expect(rows).toHaveLength(1);
    const code = String(rows[0].payload.code);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM member_contact_verification WHERE "userId" = $1 AND "codeHash" <> $2`, [m.id, code])).rows[0].n).toBe(1);
    await t.http.post('/auth/contact/verify').set(bearer(login.body)).send({ code }).expect(204);
  });

  it('admin.operator_confirmation_code_issued: a refused operator creation leaves NO event; an accepted one leaves exactly one', async () => {
    const companyId = await t.newCompany();
    const owner = await t.readyOwner(companyId, `own${randomUUID().slice(0, 8)}@x.test`);
    const email = `op${randomUUID().slice(0, 8)}@x.test`;
    const before = (await rowsOf('admin.operator_confirmation_code_issued')).length;
    await t.http.post('/auth/admin/operators').set(bearer(owner.tokens)).set('x-step-up-token', 'not-a-valid-proof').send({ email }).expect((r) => expect([401, 403]).toContain(r.status));
    expect((await rowsOf('admin.operator_confirmation_code_issued')).length).toBe(before);
    expect((await t.db.query(`SELECT 1 FROM "user" WHERE email = $1`, [email])).rowCount).toBe(0);
    const su = await t.stepUpToken(owner.tokens, 'operator.create', owner.totpSecret);
    const created = await t.http.post('/auth/admin/operators').set(bearer(owner.tokens)).set('x-step-up-token', su).send({ email });
    expect(created.status).toBe(201);
    const rows = (await rowsOf('admin.operator_confirmation_code_issued')).filter((r) => r.payload.userId === created.body.id);
    expect(rows).toHaveLength(1);
  });

  it('relay and purge concurrently over a code backlog: every unexpired row is published once, and none is purged before it is published', async () => {
    const outbox = t.app.get(OutboxService);
    const relay = t.app.get(OutboxRelayService).relay;
    const purge = t.app.get(CodeEventPurge);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ids = await t.dbs.tx(async (q) => {
      const out: string[] = [];
      for (let i = 0; i < 300; i++) out.push(await outbox.enqueue(q, { name: CODE_BEARING_EVENTS[i % 3]!, payload: { code: 'race-code', expiresAt: future, n: i } }));
      return new Set(out);
    });
    const published = () => bus.published.filter((e) => ids.has(e.id));
    for (let round = 0; round < 100; round++) {
      await Promise.all([relay.drainPass(), purge.pass(), relay.drainPass(), purge.pass()]);
      const left = (await t.db.query(`SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1)`, [[...ids]])).rows[0].n;
      if (left === 0) break;
    }
    expect((await t.db.query(`SELECT count(*)::int AS n FROM outbox WHERE id = ANY($1)`, [[...ids]])).rows[0].n).toBe(0); // all purged
    const got = published().map((e) => e.id);
    expect(new Set(got)).toEqual(ids); // every row reached the broker before its deletion
    expect(got.length).toBe(ids.size); // each exactly once here (no crash between publish and stamp)
  }, 120_000);

  it('the purge deletes at most one batch per statement', async () => {
    const outbox = t.app.get(OutboxService);
    const purge = t.app.get(CodeEventPurge);
    const past = new Date(Date.now() - 60_000).toISOString();
    await t.dbs.tx(async (q) => {
      for (let i = 0; i < 2 * CODE_EVENT_PURGE_BATCH + 7; i++) await outbox.enqueue(q, { name: 'admin.operator_code_issued', payload: { code: 'x', expiresAt: past } });
    });
    const sizes: number[] = [];
    const orig = purge.purgeBatch.bind(purge);
    const spy = vi.spyOn(purge, 'purgeBatch').mockImplementation(async () => {
      const r = await orig();
      sizes.push(r.published + r.expired);
      return r;
    });
    await purge.pass();
    spy.mockRestore();
    expect(Math.max(...sizes)).toBeLessThanOrEqual(CODE_EVENT_PURGE_BATCH);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2 * CODE_EVENT_PURGE_BATCH + 7);
  });
});

/**
 * Stage 21.C.3 §27/§28 (ADR-0040 decision 2): with Organization Service as the hierarchy source and Organization Service answering 503 to
 * everything, the paths decision 2 names (login, refresh, logout, session validation, `/auth/me`, the member access check, onboarding
 * resolution, registration, join and invitation consume) keep their existing behavior and make ZERO calls to it.
 */
describe('21.C.3 ADR-0040 decision 2: the authentication and onboarding paths never call Organization Service', () => {
  let t: TestCtx;
  let org: Server;
  const calls: string[] = [];
  const TOKEN = 'auth-full-read-credential-000000000000000000';

  beforeAll(async () => {
    org = createServer((req, res) => { calls.push(req.url ?? ''); res.writeHead(503); res.end(); });
    await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${(org.address() as AddressInfo).port}`, ORGANIZATION_SERVICE_TOKEN: TOKEN });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.close(() => r()));
  });

  it('resolve, register, login, /auth/me, member access check, refresh, join, invitation resolve and consume, logout: all succeed, zero calls', async () => {
    const w = await t.world();
    const owner = await t.readyOwner(w.companyA, `own${randomUUID().slice(0, 8)}@x.test`);
    const jc = await t.joinCode(w.orgDrive, { requiresApproval: false });
    const jc2 = await t.joinCode(w.orgSchool1, { requiresApproval: false });
    const inviteSu = await t.stepUpToken(owner.tokens, 'admin_invitation.create', owner.totpSecret);
    const inv = await t.http.post(`/auth/organizations/${w.orgSchool2}/admin-invitations`).set(bearer(owner.tokens)).set('X-Step-Up-Token', inviteSu).send({ invitationType: 'org_admin' }).expect(201);
    // §30: this app booted with source=organization-service while the marker was still local: the disagreement is surfaced, not repaired
    expect(t.logger.lines.some((l) => l.includes('hierarchy_source_mismatch source=organization-service marker=local'))).toBe(true);
    await retireWrites(t.dbs, 'cert', 'test activation evidence', { fresh: true }); // Organization Service is the authority from here
    calls.length = 0;

    await t.http.post('/auth/onboarding/resolve').send({ joinCode: jc.code }).expect(200);
    const email = `m${randomUUID().slice(0, 8)}@x.test`;
    await t.http.post('/auth/register').send({ email, password: 'member password 1', joinCode: jc.code }).expect(201);
    const login = await t.http.post('/auth/login').send({ email, password: 'member password 1' }).expect(200);
    await t.http.get('/auth/me').set(bearer(login.body)).expect(200);
    await t.http.get(`/auth/organizations/${w.orgDrive}/membership`).set(bearer(login.body)).expect(204);
    await t.http.post('/auth/onboarding/join').set(bearer(login.body)).send({ joinCode: jc2.code }).expect(201);
    const refreshed = await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    await t.http.post('/auth/onboarding/invitations/resolve').send({ invitationCode: inv.body.code }).expect(200);
    await t.http.post('/auth/onboarding/invitations/accept').send({ invitationCode: inv.body.code, email: `adm${randomUUID().slice(0, 8)}@x.test`, password: 'admin password 1' }).expect(201);
    await t.http.post('/auth/logout').set(bearer(refreshed.body)).send({ refreshToken: refreshed.body.refreshToken }).expect(204);
    expect(calls).toEqual([]);
  });
});
