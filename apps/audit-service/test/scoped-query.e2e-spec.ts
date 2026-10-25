import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AuditRecordRepository } from '../src/persistence/audit-record.repository.js';
import type { NewAuditRecord } from '../src/persistence/audit-record.types.js';
import { queryFingerprint } from '../src/query/query-params.js';
import { encodeSignedCursor } from '../src/query/signed-cursor.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 S2-Audit.3 (ADR-0069 decisions 4 and 5; register AUD-03, AUD-04; OD-14): the Owner Company timeline and the operator Platform
 * view, through the real module graph, as the runtime role, on real PostgreSQL 16. Auth is a stub of `GET /auth/grants` (Auth's live,
 * server-derived facts) whose answers the tests change between pages (revocation).
 */
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const P1 = randomUUID();
const P2 = randomUUID();
const OWNER_A = randomUUID();
const APPROVER = randomUUID();
type Grants = { userId: string; kind: 'owner' | 'operator' | 'member'; companyId: string | null; platformAssignments: string[]; organizationAdminMemberships: string[] };
const g = (kind: Grants['kind'], over: Partial<Grants> = {}): Grants => ({ userId: randomUUID(), kind, companyId: null, platformAssignments: [], organizationAdminMemberships: [], ...over });
const IDENTITIES: Record<string, Grants> = {
  'owner-a': g('owner', { userId: OWNER_A, companyId: COMPANY_A }),
  'owner-a2': g('owner', { companyId: COMPANY_A }), // another identity of the same Company (cursor reuse)
  'owner-b': g('owner', { companyId: COMPANY_B }),
  'op-1': g('operator', { platformAssignments: [P1] }),
  'op-2': g('operator', { platformAssignments: [P2] }),
  'op-12': g('operator', { platformAssignments: [P1, P2] }),
  'op-none': g('operator'),
  member: g('member', { organizationAdminMemberships: [randomUUID()] }),
};
const WINDOW = { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' };
const BASE = Date.parse('2026-10-02T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const CURSOR_KEY = randomBytes(32);

function stubAuth() {
  const received: Array<{ path: string; authorization: string | undefined }> = [];
  const state = { down: false, revoked: new Set<string>(), override: new Map<string, Grants>() };
  const server: Server = createServer((req, res) => {
    received.push({ path: req.url ?? '', authorization: req.headers.authorization });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (state.down) return send(500, { message: 'Internal Server Error' });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = state.revoked.has(token) ? undefined : state.override.get(token) ?? IDENTITIES[token];
    if (!who) return send(401, { message: 'Unauthorized', code: 'unauthenticated' });
    if (req.url === '/auth/grants') return send(200, who);
    return send(404, { message: 'Not Found', code: 'not_found' });
  });
  return { server, state, received };
}

describeWithEnv('S2-Audit.3 scoped human reads: Owner Company timeline and operator Platform view (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let auth: ReturnType<typeof stubAuth>;
  const service = generateServiceToken();
  const trusted: Record<string, string[]> = { A: [], B: [], P1: [], P2: [] };
  const adminDb = () => env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${d.name}`);

  const company = (bearer: string | undefined, query: Record<string, string> = {}, app: TestApp = t) => {
    const r = request(app.app.getHttpServer()).get('/audit/owner/company/records').query({ ...WINDOW, ...query });
    return bearer === undefined ? r : r.set('authorization', `Bearer ${bearer}`);
  };
  const platform = (p: string, bearer: string | undefined, query: Record<string, string> = {}) => {
    const r = request(t.app.getHttpServer()).get(`/audit/operator/platforms/${p}/records`).query({ ...WINDOW, ...query });
    return bearer === undefined ? r : r.set('authorization', `Bearer ${bearer}`);
  };
  const ids = (res: request.Response) => (res.body.records as Array<{ eventId: string }>).map((x) => x.eventId);
  /** Every page of a read, following nextCursor. */
  const allPages = async (call: (q: Record<string, string>) => request.Test, limit = '2') => {
    const out: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await call({ limit, ...(cursor ? { cursor } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      out.push(...ids(r));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) return out;
    }
    throw new Error('too many pages');
  };

  function rec(minutes: number, over: Partial<NewAuditRecord> = {}): NewAuditRecord {
    return {
      eventId: randomUUID(), sourceService: 'auth-service', action: 'authorization_receipt.issued', category: 'security', schemaVersion: 2,
      actor: { type: 'user', id: OWNER_A, userKind: 'owner' }, organizationId: null, resource: { type: 'authorization_receipt', id: randomUUID() },
      outcome: 'succeeded', correlationId: 'corr-scoped-0001', occurredAt: at(minutes), ...over,
    };
  }
  const verified = { producerIdentityVerified: true, replayed: false };

  beforeAll(async () => {
    auth = stubAuth();
    await new Promise<void>((r) => auth.server.listen(0, '127.0.0.1', r));
    const authUrl = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}`;
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'ascoped');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      tokens: [{ caller: 'platform-reader', digest: service.digest }],
      policy: JSON.stringify({ callers: { 'platform-reader': { operations: ['read_platform'], categories: ['security', 'business', 'commercial', 'administrative'] } } }),
      env: {
        AUTH_SERVICE_URL: authUrl, AUDIT_OWNER_QUERY_RATE_PER_OWNER: '100000', AUDIT_OPERATOR_QUERY_RATE_PER_OPERATOR: '100000',
        AUDIT_CURSOR_KEYS: `k1:${CURSOR_KEY.toString('base64')}`, AUDIT_CURSOR_ACTIVE_KEY_ID: 'k1',
      },
    });
    const repo = t.app.get(AuditRecordRepository);
    const put = async (r: NewAuditRecord, bucket?: keyof typeof trusted, bucket2?: keyof typeof trusted) => {
      expect((await repo.insertOnce(r)).kind).toBe('inserted');
      if (bucket) trusted[bucket]!.unshift(r.eventId);
      if (bucket2) trusted[bucket2]!.unshift(r.eventId);
    };
    let m = 0;
    // Company A: seven trusted records, two of them at the SAME instant (the id breaks the tie), one with a verified approver
    for (let i = 0; i < 5; i++) await put(rec(m++, { companyId: COMPANY_A, delivery: verified }), 'A');
    await put(rec(m, { companyId: COMPANY_A, delivery: verified }), 'A');
    await put(rec(m++, { companyId: COMPANY_A, delivery: verified, action: 'authorization_receipt.consumed', actor: { type: 'service', id: 'payment-service' }, approvedBy: { id: APPROVER, userKind: 'owner' } }), 'A');
    // Company A asserted, but never trusted: an unverified delivery, an unassessed one (history / compatibility)
    await put(rec(m++, { companyId: COMPANY_A, delivery: { producerIdentityVerified: false, replayed: false } }));
    await put(rec(m++, { companyId: COMPANY_A, delivery: null }));
    // version 1, no scope at all; Company B, trusted
    await put(rec(m++, { schemaVersion: 1, action: 'account.disabled', resource: { type: 'user', id: randomUUID() }, changes: { reason: 'compromised_account' } }));
    for (let i = 0; i < 2; i++) await put(rec(m++, { companyId: COMPANY_B, delivery: verified }), 'B');
    // Platforms: P1 trusted (one also Company A), P2 trusted, P1 unverified
    for (let i = 0; i < 3; i++) await put(rec(m++, { platformId: P1, delivery: verified }), 'P1');
    await put(rec(m++, { companyId: COMPANY_A, platformId: P1, delivery: verified }), 'P1', 'A');
    await put(rec(m++, { platformId: P2, delivery: verified }), 'P2');
    await put(rec(m++, { platformId: P1, delivery: { producerIdentityVerified: false, replayed: false } }));
    // newest first: `unshift` built each list in that order already, except the same-instant pair (ordered by id DESC)
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    auth?.server.closeAllConnections();
    await new Promise((r) => auth?.server.close(r));
  });

  describe('AUD-03 Owner Company timeline', () => {
    it('returns exactly the trusted records of the Owner\'s Company, newest first, with the verified approver', async () => {
      const r = await company('owner-a', { limit: '100' });
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(new Set(ids(r))).toEqual(new Set(trusted.A));
      expect(ids(r)).toHaveLength(trusted.A!.length);
      const times = (r.body.records as Array<{ occurredAt: string }>).map((x) => Date.parse(x.occurredAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      const consumed = (r.body.records as Array<Record<string, any>>).find((x) => x.action === 'authorization_receipt.consumed')!;
      expect(consumed.approvedBy).toEqual({ type: 'user', id: APPROVER, userKind: 'owner' });
      expect(Object.keys(r.body).sort()).toEqual(['nextCursor', 'records']);
    });

    it('another Company\'s owner sees only theirs; unverified, unassessed and unscoped records are never returned', async () => {
      expect(new Set(ids(await company('owner-b', { limit: '100' })))).toEqual(new Set(trusted.B));
      const all = ids(await company('owner-a', { limit: '100' }));
      for (const other of trusted.B!) expect(all).not.toContain(other);
    });

    it('the client cannot choose the Company (or any other scope or sort): such parameters are refused', async () => {
      const params: Array<Record<string, string>> = [{ companyId: COMPANY_B }, { platformId: P1 }, { organizationId: randomUUID() }, { sort: 'asc' }, { category: 'security' }, { sourceService: 'auth-service' }];
      for (const q of params) {
        const r = await company('owner-a', q);
        expect([r.status, r.body.code], JSON.stringify(q)).toEqual([400, 'invalid_query']);
      }
    });

    it('identities: no bearer, unknown or revoked bearer → 401; operator and member → 403; a service token is refused and never sent to Auth', async () => {
      expect((await company(undefined)).status).toBe(401);
      expect((await company('nobody')).status).toBe(401);
      for (const who of ['op-1', 'member']) expect([(await company(who)).status, (await company(who)).body.code], who).toEqual([403, 'operation_not_allowed']);
      const before = auth.received.length;
      expect((await company(service.token)).status).toBe(401);
      expect(auth.received.slice(before).some((x) => x.authorization?.includes(service.token))).toBe(false);
    });

    it('paginates without duplicates or gaps (ties broken by id), and every page is recorded', async () => {
      const before = Number((await sql<{ n: string }>(adminDb(), `SELECT count(*) AS n FROM audit_record WHERE action = 'platform_query.executed' AND "actorId" = $1`, [OWNER_A]))[0]!.n);
      const pages = await allPages((q) => company('owner-a', q));
      expect(pages).toHaveLength(trusted.A!.length);
      expect(new Set(pages).size).toBe(pages.length);
      expect(new Set(pages)).toEqual(new Set(trusted.A));
      const recorded = await sql<Record<string, any>>(adminDb(), `SELECT "userKind", changes FROM audit_record WHERE action = 'platform_query.executed' AND "actorId" = $1 ORDER BY id`, [OWNER_A]);
      expect(recorded.length - before).toBe(Math.ceil(trusted.A!.length / 2));
      expect(recorded.at(-1)).toMatchObject({ userKind: 'owner', changes: { target: 'company', company_id: COMPANY_A, page: 'next' } });
    });

    it('an Owner deactivated between pages reads nothing more (authority is re-asked on every page)', async () => {
      auth.state.override.set('owner-a-temp', { ...IDENTITIES['owner-a']!, userId: randomUUID() });
      const first = await company('owner-a-temp', { limit: '2' });
      expect(first.status).toBe(200);
      auth.state.revoked.add('owner-a-temp');
      expect((await company('owner-a-temp', { limit: '2', cursor: first.body.nextCursor })).status).toBe(401);
    });
  });

  describe('AUD-04 operator Platform view', () => {
    it('an operator reads exactly the trusted records of an assigned Platform', async () => {
      expect(new Set(ids(await platform(P1, 'op-1', { limit: '100' })))).toEqual(new Set(trusted.P1));
      expect(new Set(ids(await platform(P2, 'op-2', { limit: '100' })))).toEqual(new Set(trusted.P2));
      expect(new Set(await allPages((q) => platform(P1, 'op-12', q)))).toEqual(new Set(trusted.P1));
    });

    it('a Platform not assigned (another, unknown, none) is an indistinguishable 404; an owner or member is 403; no global view', async () => {
      for (const [p, who] of [[P2, 'op-1'], [P1, 'op-2'], [randomUUID(), 'op-12'], [P1, 'op-none']] as const) {
        const r = await platform(p, who);
        expect([r.status, r.body.code, r.body.records], `${who}`).toEqual([404, 'not_found', undefined]);
      }
      for (const who of ['owner-a', 'member']) expect((await platform(P1, who)).status, who).toBe(403);
      expect((await platform('not-a-uuid', 'op-1')).status).toBe(400);
      expect((await request(t.app.getHttpServer()).get('/audit/operator/platforms/records').query(WINDOW).set('authorization', 'Bearer op-12')).status).toBe(404);
    });

    it('an assignment revoked between pages: the next page is refused (404), even with a valid cursor', async () => {
      auth.state.override.set('op-temp', g('operator', { platformAssignments: [P1] }));
      const first = await platform(P1, 'op-temp', { limit: '1' });
      expect([first.status, typeof first.body.nextCursor]).toEqual([200, 'string']);
      auth.state.override.set('op-temp', { ...auth.state.override.get('op-temp')!, platformAssignments: [] });
      const next = await platform(P1, 'op-temp', { limit: '1', cursor: first.body.nextCursor });
      expect([next.status, next.body.records]).toEqual([404, undefined]);
    });

    it('records the operator\'s read with its Platform', async () => {
      const opId = IDENTITIES['op-2']!.userId;
      await platform(P2, 'op-2');
      const rows = await sql<Record<string, any>>(adminDb(), `SELECT "userKind", changes FROM audit_record WHERE action = 'platform_query.executed' AND "actorId" = $1`, [opId]);
      expect(rows.at(-1)).toMatchObject({ userKind: 'operator', changes: { target: 'operator_platform', platform_id: P2 } });
    });
  });

  describe('cursor (OD-14)', () => {
    const fp = (caller: string, scope: object, filters: object = {}, window = WINDOW) =>
      queryFingerprint(caller, scope as never, filters, { from: new Date(window.from), to: new Date(window.to) });
    const keys = { keys: new Map([['k1', CURSOR_KEY]]), activeKeyId: 'k1', ttlSec: 900 };

    it('altered, foreign, cross-scope, cross-filter, cross-window and expired cursors are all 400 invalid_cursor', async () => {
      const first = await company('owner-a', { limit: '2' });
      const c = first.body.nextCursor as string;
      const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
      const op = await platform(P1, 'op-12', { limit: '1' });
      const opCursor = op.body.nextCursor as string;
      const expired = encodeSignedCursor(keys, { occurredAtUs: '1759363200000000', id: '1' }, fp(`owner:${OWNER_A}`, { kind: 'company', companyId: COMPANY_A }), Date.now() - 3_600_000);
      const otherKey = encodeSignedCursor({ ...keys, keys: new Map([['k1', randomBytes(32)]]) }, { occurredAtUs: '1759363200000000', id: '1' }, fp(`owner:${OWNER_A}`, { kind: 'company', companyId: COMPANY_A }), Date.now());
      const cases: Array<[string, () => request.Test]> = [
        ['altered', () => company('owner-a', { limit: '2', cursor: flip(c) })],
        ['another owner of the same Company', () => company('owner-a2', { limit: '2', cursor: c })],
        ['another Company', () => company('owner-b', { limit: '2', cursor: c })],
        ['another filter', () => company('owner-a', { limit: '2', cursor: c, action: 'authorization_receipt.issued' })],
        ['another window', () => company('owner-a', { limit: '2', cursor: c, from: '2026-10-02T00:00:00Z' })],
        ['an operator cursor on another Platform', () => platform(P2, 'op-12', { limit: '1', cursor: opCursor })],
        ['an owner cursor on the operator route', () => platform(P1, 'op-12', { limit: '1', cursor: c })],
        ['expired', () => company('owner-a', { limit: '2', cursor: expired })],
        ['signed with another key', () => company('owner-a', { limit: '2', cursor: otherKey })],
        ['the unsigned cursor of the older reads', () => company('owner-a', { limit: '2', cursor: Buffer.from(JSON.stringify({ v: 1, t: '1', i: '1', q: 'a'.repeat(24) })).toString('base64url') })],
      ];
      for (const [what, call] of cases) {
        const r = await call();
        expect([r.status, r.body.code, r.body.records], what).toEqual([400, 'invalid_cursor', undefined]);
      }
      // the same limit is not part of the binding: a different page size continues the same query
      expect((await company('owner-a', { limit: '3', cursor: c })).status).toBe(200);
    });

    it('carries no evidence, identifier or secret', async () => {
      const c = (await company('owner-a', { limit: '2' })).body.nextCursor as string;
      const payload = Buffer.from(c.split('.')[1]!, 'base64url').toString('utf8');
      for (const needle of [OWNER_A, COMPANY_A, 'owner-a', ...trusted.A!]) expect(payload).not.toContain(needle);
    });
  });

  describe('bounds, failure and leakage', () => {
    it('invalid filters, a too large page or window, and a request body are refused', async () => {
      const cases: Array<[Record<string, string>, string]> = [
        [{ limit: '101' }, 'invalid_query'], [{ limit: '0' }, 'invalid_query'], [{ action: 'not.cataloged' }, 'invalid_query'],
        [{ correlationId: 'x' }, 'invalid_query'], [{ from: '2026-09-01T00:00:00Z' }, 'window_too_large'], [{ to: '2026-09-01T00:00:00Z' }, 'invalid_query'],
      ];
      for (const [q, codeExpected] of cases) {
        const r = await company('owner-a', q);
        expect([r.status, r.body.code], JSON.stringify(q)).toEqual([400, codeExpected]);
      }
      const withBody = await request(t.app.getHttpServer()).get('/audit/owner/company/records').query(WINDOW).set('authorization', 'Bearer owner-a').send({ companyId: COMPANY_B });
      expect([withBody.status, withBody.body.code]).toEqual([400, 'unexpected_body']);
    });

    it('filters only narrow, inside the trusted scope', async () => {
      const r = await company('owner-a', { action: 'authorization_receipt.consumed', limit: '100' });
      expect(ids(r)).toHaveLength(1);
      const other = await company('owner-b', { correlationId: 'corr-scoped-0001', limit: '100' });
      expect(new Set(ids(other))).toEqual(new Set(trusted.B));
    });

    it('when Auth cannot answer, nothing is returned (503) and nothing is recorded', async () => {
      const n = async () => Number((await sql<{ n: string }>(adminDb(), `SELECT count(*) AS n FROM audit_record WHERE action = 'platform_query.executed'`))[0]!.n);
      const before = await n();
      auth.state.down = true;
      try {
        const r = await company('owner-a');
        expect([r.status, r.body.records]).toEqual([503, undefined]);
        expect((await platform(P1, 'op-1')).status).toBe(503);
      } finally { auth.state.down = false; }
      expect(await n()).toBe(before);
    });

    it('no bearer, Company or Platform id of another scope reaches a response or a log line', async () => {
      await company('owner-a');
      await platform(P1, 'op-1');
      const logs = JSON.stringify(ALL_LOGS);
      for (const secret of ['owner-a', 'op-1', service.token, CURSOR_KEY.toString('base64')]) expect(logs).not.toContain(`Bearer ${secret}`);
      expect(logs).not.toContain(CURSOR_KEY.toString('base64'));
      expect(JSON.stringify((await company('owner-a', { limit: '100' })).body)).not.toContain(COMPANY_B);
    });

    it('without the cursor key ring the scoped routes do not exist; the existing reads are unchanged', async () => {
      const plain = await createTestApp({ databaseUrl: d.appUrl, env: { AUTH_SERVICE_URL: 'http://127.0.0.1:9' } });
      try {
        expect((await company('owner-a', {}, plain)).status).toBe(404);
        expect((await request(plain.app.getHttpServer()).get(`/audit/operator/platforms/${P1}/records`).query(WINDOW).set('authorization', 'Bearer op-1')).status).toBe(404);
      } finally { await plain.app.close(); }
      const svc = await request(t.app.getHttpServer()).get('/audit/platform/records').query(WINDOW).set('authorization', `Bearer ${service.token}`);
      expect(svc.status).toBe(200);
      expect(Object.keys(svc.body).sort()).toEqual(['items', 'nextCursor']); // the older reads keep their shape
    });
  });
});
