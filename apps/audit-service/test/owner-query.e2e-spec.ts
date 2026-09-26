import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { validateAuditPayload } from '@nawara/audit-contract';
import { auditMigrationsDir } from '../src/app.module.js';
import { AuditRecordRepository } from '../src/persistence/audit-record.repository.js';
import type { NewAuditRecord } from '../src/persistence/audit-record.types.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 19.3 Audit-X (ADR-0050 decision 6): a Company owner reads ONE organization of their Company with their own bearer, through the real
 * module graph, as the runtime role, on real PostgreSQL 16. Auth is a stub that answers exactly Auth's contract (`GET /auth/grants`,
 * `GET /auth/admin/organizations/:id`: 200 for an organization of the owner's Company, the collapsed 404 otherwise); it records every
 * request it receives, so the tests also prove what Audit sends to Auth (only the human's own bearer, never a service token).
 */
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const A1 = 'a1a1a1a1-0000-4000-8000-0000000000a1';
const A2 = 'a2a2a2a2-0000-4000-8000-0000000000a2';
const B1 = 'b1b1b1b1-0000-4000-8000-0000000000b1';
const ORGS: Record<string, string> = { [A1]: COMPANY_A, [A2]: COMPANY_A, [B1]: COMPANY_B };
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const OWNER_C = randomUUID(); // a separate owner for the rate-limit test (no shared counter with the others)
type Identity = { userId: string; kind: 'owner' | 'operator' | 'member'; companyId: string | null };
const TOKENS: Record<string, Identity> = {
  'owner-a-bearer': { userId: OWNER_A, kind: 'owner', companyId: COMPANY_A },
  'owner-b-bearer': { userId: OWNER_B, kind: 'owner', companyId: COMPANY_B },
  'owner-c-bearer': { userId: OWNER_C, kind: 'owner', companyId: COMPANY_A },
  // Fresh owners for the rate-limit test: the limiter state is shared through the database, so they must have no earlier hits.
  'owner-d-bearer': { userId: randomUUID(), kind: 'owner', companyId: COMPANY_A },
  'owner-e-bearer': { userId: randomUUID(), kind: 'owner', companyId: COMPANY_B },
  'member-bearer': { userId: randomUUID(), kind: 'member', companyId: null },
  'operator-bearer': { userId: randomUUID(), kind: 'operator', companyId: null },
};
const WINDOW = { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' };
const BASE = Date.parse('2026-06-02T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

/** A stub of Auth's two live endpoints, with failure switches. */
function stubAuth() {
  const received: Array<{ path: string; authorization: string | undefined; headers: Record<string, unknown> }> = [];
  type Mode = 'ok' | 'down' | 'hang' | 'malformed' | 'wrong_org' | 'redirect_same' | 'redirect_cross' | 'no_content' | 'empty' | 'oversized' | 'oversized_chunked' | 'slow_body' | 'reset';
  const state = { mode: 'ok' as Mode, revoked: new Set<string>(), sinkUrl: '' };
  /** Stage 19.4: where a redirect points; it records whatever reaches it (it must receive nothing). */
  const sinkReceived: Array<{ path: string; authorization: string | undefined }> = [];
  const sink: Server = createServer((req, res) => {
    sinkReceived.push({ path: req.url ?? '', authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ userId: OWNER_A, kind: 'owner', companyId: COMPANY_A, id: A1 }));
  });
  const server: Server = createServer((req, res) => {
    received.push({ path: req.url ?? '', authorization: req.headers.authorization, headers: { ...req.headers } });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url?.startsWith('/redirected')) return send(200, { userId: OWNER_A, kind: 'owner', companyId: COMPANY_A, id: A1 }); // a valid-looking answer, only via a redirect
    if (state.mode === 'hang') return; // never answers: Audit's timeout must fail closed
    if (state.mode === 'down') return send(500, { message: 'Internal Server Error' });
    if (state.mode === 'reset') return req.socket.destroy();
    if (state.mode === 'redirect_same') { res.writeHead(302, { location: `/redirected${req.url}` }); return res.end(); }
    if (state.mode === 'redirect_cross') { res.writeHead(307, { location: `${state.sinkUrl}${req.url}` }); return res.end(); }
    if (state.mode === 'no_content') { res.writeHead(204); return res.end(); }
    if (state.mode === 'empty') return send(200, {});
    if (state.mode === 'slow_body') { res.writeHead(200, { 'content-type': 'application/json' }); return res.write('{"userId":'); } // headers, then nothing
    const valid = { userId: OWNER_A, kind: 'owner', companyId: COMPANY_A, platformAssignments: [], organizationAdminMemberships: [], id: A1, platformId: randomUUID() };
    if (state.mode === 'oversized') return send(200, { ...valid, padding: 'x'.repeat(20_000) });
    if (state.mode === 'oversized_chunked') {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked: no content-length to check up front
      res.write(JSON.stringify(valid).slice(0, -1) + ',"padding":"');
      for (let i = 0; i < 40; i++) res.write('x'.repeat(1024));
      return res.end('"}');
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = state.revoked.has(token) ? undefined : TOKENS[token];
    if (!who) return send(401, { message: 'Unauthorized' });
    if (req.url === '/auth/grants') {
      if (state.mode === 'malformed') return send(200, '{"userId":');
      return send(200, { userId: who.userId, kind: who.kind, companyId: who.companyId, platformAssignments: [], organizationAdminMemberships: [] });
    }
    const m = /^\/auth\/admin\/organizations\/([^/]+)$/.exec(req.url ?? '');
    if (m) {
      const org = decodeURIComponent(m[1]!);
      if (who.kind !== 'owner' || ORGS[org] === undefined || ORGS[org] !== who.companyId) return send(404, { message: 'Not Found' });
      return send(200, { id: state.mode === 'wrong_org' ? B1 : org, platformId: randomUUID() });
    }
    send(404, { message: 'Not Found' });
  });
  return { server, received, state, sink, sinkReceived };
}

describeWithEnv('Audit-X: Company owner reads one organization (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  let auth: ReturnType<typeof stubAuth>;
  let authUrl: string;
  const service = generateServiceToken();
  const platformService = generateServiceToken();
  const seeded: NewAuditRecord[] = [];
  const server = () => t.app.getHttpServer();
  const owner = (org: string, bearer: string | undefined, query: Record<string, string | string[]> = {}, app: TestApp = t) => {
    const r = request(app.app.getHttpServer()).get(`/audit/owner/organizations/${org}/records`).query({ ...WINDOW, ...query });
    return bearer === undefined ? r : r.set('authorization', `Bearer ${bearer}`);
  };
  const adminDb = () => env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${d.name}`);
  const selfRecords = async (actorId?: string) =>
    sql<Record<string, any>>(adminDb(), `SELECT * FROM audit_record WHERE action = 'platform_query.executed' ${actorId ? `AND "actorId" = '${actorId}'` : ''} ORDER BY id`);
  const ids = (res: request.Response) => (res.body.items as Array<{ eventId: string }>).map((i) => i.eventId).sort();
  const seededOf = (pred: (r: NewAuditRecord) => boolean) => seeded.filter(pred).map((r) => r.eventId).sort();

  function rec(organizationId: string | null, minutes: number, over: Partial<NewAuditRecord> = {}): NewAuditRecord {
    return {
      eventId: randomUUID(), sourceService: 'auth-service', action: 'membership.revoked', category: 'business', schemaVersion: 1,
      actor: { type: 'user', id: OWNER_A, userKind: 'owner' }, organizationId, resource: { type: 'membership', id: randomUUID() },
      subject: { type: 'user', id: randomUUID() }, outcome: 'succeeded', changes: { authority: 'owner', was_admin: false },
      correlationId: null, causationId: null, occurredAt: at(minutes), ...over,
    };
  }

  beforeAll(async () => {
    auth = stubAuth();
    await new Promise<void>((r) => auth.server.listen(0, '127.0.0.1', r));
    authUrl = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}`;
    await new Promise<void>((r) => auth.sink.listen(0, '127.0.0.1', r));
    auth.state.sinkUrl = `http://127.0.0.1:${(auth.sink.address() as AddressInfo).port}`;
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aowner');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      tokens: [{ caller: 'org-reader', digest: service.digest }, { caller: 'platform-reader', digest: platformService.digest }],
      policy: JSON.stringify({ callers: { 'org-reader': { operations: ['read_organization'], categories: ['security', 'business', 'commercial', 'administrative'] }, 'platform-reader': { operations: ['read_platform'], categories: ['security', 'business', 'commercial', 'administrative'] } } }),
      env: { AUTH_SERVICE_URL: authUrl, AUDIT_OWNER_QUERY_RATE_PER_OWNER: '1000', AUTH_TIMEOUT_MS: '300' },
    });
    const repo = t.app.get(AuditRecordRepository);
    let m = 0;
    for (const o of [A1, A2, B1]) for (let i = 0; i < 3; i++) seeded.push(rec(o, m++, { category: i === 1 ? 'security' : 'business', action: i === 1 ? 'membership.admin_granted' : 'membership.revoked', changes: i === 1 ? null : { authority: 'owner', was_admin: false } }));
    // Platform-level evidence: never visible to an owner (account.* of Stage 19.2, operator.created).
    seeded.push(
      rec(null, m++, { action: 'account.disabled', category: 'security', resource: { type: 'user', id: randomUUID() }, subject: null, changes: { reason: 'compromised_account' } }),
      rec(null, m++, { action: 'account.enabled', category: 'security', resource: { type: 'user', id: randomUUID() }, subject: null, changes: null }),
      rec(null, m++, { action: 'operator.created', category: 'security', resource: { type: 'user', id: randomUUID() }, subject: null, changes: null }),
    );
    for (const r of seeded) expect((await repo.insertOnce(r)).kind).toBe('inserted');
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
    auth?.server.closeAllConnections();
    auth?.sink.closeAllConnections();
    await new Promise((r) => auth?.sink.close(r));
    await new Promise((r) => auth?.server.close(r));
  });

  describe('authentication: the owner\'s own bearer, verified by Auth; never a service token', () => {
    it('owner → 200; missing / malformed / revoked bearer → 401; member and operator → 403', async () => {
      expect((await owner(A1, 'owner-a-bearer')).status).toBe(200);
      expect((await owner(A1, undefined)).status).toBe(401);
      expect((await owner(A1, undefined).set('authorization', 'Basic abc')).status).toBe(401);
      expect((await owner(A1, 'not-a-known-bearer')).status).toBe(401);
      for (const who of ['member-bearer', 'operator-bearer']) {
        const r = await owner(A1, who);
        expect(r.status, who).toBe(403);
        expect(r.body.code).toBe('operation_not_allowed');
        expect(r.body.items).toBeUndefined();
      }
    });

    it('a service token is refused (401) and is NEVER forwarded to Auth; service tokens keep their own routes', async () => {
      const before = auth.received.length;
      const r = await owner(A1, service.token);
      expect(r.status).toBe(401);
      expect(auth.received.slice(before).some((x) => x.authorization?.includes(service.token))).toBe(false);
      expect(auth.received.length).toBe(before);
      // unchanged: the service readers
      expect((await request(server()).get(`/audit/organizations/${A1}/records`).query(WINDOW).set('authorization', `Bearer ${service.token}`)).status).toBe(200);
      const p = await request(server()).get('/audit/platform/records').query({ from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' }).set('authorization', `Bearer ${platformService.token}`);
      expect(p.status).toBe(200);
      const svc = (await selfRecords()).filter((x) => x.actorType === 'service');
      expect(svc.length).toBeGreaterThan(0);
      expect(svc.every((x) => x.actorId === 'platform-reader' && x.changes.organization_id === undefined)).toBe(true);
      // and the owner bearer cannot use the service routes
      expect((await request(server()).get(`/audit/organizations/${A1}/records`).query(WINDOW).set('authorization', 'Bearer owner-a-bearer')).status).toBe(401);
    });

    it('current authority: once Auth refuses the bearer (blocked owner, revoked session), the next read is 401', async () => {
      expect((await owner(A1, 'owner-c-bearer')).status).toBe(200);
      auth.state.revoked.add('owner-c-bearer');
      try {
        expect((await owner(A1, 'owner-c-bearer')).status).toBe(401);
      } finally {
        auth.state.revoked.delete('owner-c-bearer');
      }
    });
  });

  describe('Company scope: one organization of the owner\'s own Company per request', () => {
    it('Owner A → A1 and A2 (each exactly its own records); Owner A → B1 and Owner B → A1 are 404, indistinguishable from an unknown organization', async () => {
      const a1 = await owner(A1, 'owner-a-bearer');
      expect(ids(a1)).toEqual(seededOf((r) => r.organizationId === A1));
      const a2 = await owner(A2, 'owner-a-bearer');
      expect(ids(a2)).toEqual(seededOf((r) => r.organizationId === A2));
      const cross = await owner(B1, 'owner-a-bearer');
      const reverse = await owner(A1, 'owner-b-bearer');
      const unknown = await owner(randomUUID(), 'owner-a-bearer');
      for (const r of [cross, reverse, unknown]) {
        expect(r.status).toBe(404);
        expect(r.body.items).toBeUndefined();
      }
      const strip = (b: Record<string, unknown>) => ({ ...b, requestId: undefined });
      expect(strip(cross.body)).toEqual(strip(unknown.body));
      expect((await owner(B1, 'owner-b-bearer')).status).toBe(200);
    });

    it('there is no wildcard: a malformed id is 400; organizationId / platform / companyId parameters are refused', async () => {
      for (const bad of ['*', 'all', A1.toUpperCase(), `${A1},${A2}`]) expect((await owner(encodeURIComponent(bad), 'owner-a-bearer')).status, bad).toBe(400);
      for (const q of [{ organizationId: A2 }, { platform: 'true' }, { companyId: COMPANY_A }, { userKind: 'owner' }] as Record<string, string>[]) {
        const r = await owner(A1, 'owner-a-bearer', q);
        expect(r.status, JSON.stringify(q)).toBe(400);
        expect(r.body.code).toBe('invalid_query');
      }
    });

    it('platform-level evidence (organizationId null, including account.disabled / account.enabled) is never returned to an owner', async () => {
      for (const org of [A1, A2]) {
        const r = await owner(org, 'owner-a-bearer', { limit: '100' });
        expect(r.body.items.every((i: { organizationId: string | null }) => i.organizationId === org)).toBe(true);
      }
      const byAction = await owner(A1, 'owner-a-bearer', { action: 'account.disabled' });
      expect(byAction.status).toBe(200);
      expect(byAction.body.items).toEqual([]);
    });
  });

  describe('self-audit: every successful read is platform_query.executed with the real owner as actor', () => {
    it('records the owner, the organization and bounded facts; repeated reads are each recorded; nothing of the result is copied', async () => {
      const before = (await selfRecords(OWNER_B)).length;
      await owner(B1, 'owner-b-bearer', { limit: '2' });
      await owner(B1, 'owner-b-bearer', { category: 'security' });
      const rows = (await selfRecords(OWNER_B)).slice(before);
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).toMatchObject({ sourceService: 'audit-service', actorType: 'user', actorId: OWNER_B, userKind: 'owner', organizationId: null, resourceType: 'platform_query', outcome: 'succeeded' });
        expect(r.changes.target).toBe('organization');
        expect(r.changes.organization_id).toBe(B1);
        expect(r.changes.window_days).toBe(29);
      }
      expect(rows[0].changes).toMatchObject({ result_count: 2, page: 'first', filtered: false });
      expect(rows[1].changes).toMatchObject({ filtered: true });
      // valid under the shared contract, as audit-service's own event
      const r0 = rows[0];
      expect(() => validateAuditPayload({
        action: r0.action, actor: { type: 'user', id: r0.actorId, userKind: 'owner' }, organizationId: null,
        resource: { type: r0.resourceType, id: r0.resourceId }, outcome: r0.outcome, changes: r0.changes,
      }, 'audit-service')).not.toThrow();
      expect(JSON.stringify(rows)).not.toMatch(/membership\.|owner-b-bearer|Bearer/);
    });

    it('FAIL CLOSED: if the read cannot be recorded, no evidence is returned (503) and nothing is written', async () => {
      const before = (await selfRecords()).length;
      await sql(adminDb(), `REVOKE INSERT ON audit_record FROM ${d.app}`);
      try {
        const r = await owner(A1, 'owner-a-bearer', { limit: '100' });
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('accountability_unavailable');
        expect(r.body.items).toBeUndefined();
      } finally {
        await sql(adminDb(), `GRANT INSERT ON audit_record TO ${d.app}`);
      }
      expect((await selfRecords()).length).toBe(before);
      expect((await owner(A1, 'owner-a-bearer')).status).toBe(200);
    });
  });

  describe('actor spoofing: identity comes only from Auth\'s answer about the bearer', () => {
    it('identity headers never change the actor or the scope, and Audit forwards only the bearer to Auth', async () => {
      const spoof = { 'x-owner-id': OWNER_B, 'x-admin-user-id': OWNER_B, 'x-operator-id': OWNER_B, 'x-user-kind': 'operator', 'x-acting-user': OWNER_B, 'x-company-id': COMPANY_B };
      const before = auth.received.length;
      const r = await owner(A1, 'owner-a-bearer').set(spoof);
      expect(r.status).toBe(200);
      const last = (await selfRecords()).at(-1)!;
      expect([last.actorId, last.userKind]).toEqual([OWNER_A, 'owner']);
      for (const x of auth.received.slice(before)) for (const h of Object.keys(spoof)) expect(x.headers[h], h).toBeUndefined();
      // the same headers cannot open another Company's organization
      expect((await owner(B1, 'owner-a-bearer').set(spoof)).status).toBe(404);
      // actorId / actorType are FILTERS of the records, never the reader's identity
      const f = await owner(A1, 'owner-a-bearer', { actorType: 'user', actorId: OWNER_B });
      expect(f.status).toBe(200);
      expect((await selfRecords()).at(-1)!.actorId).toBe(OWNER_A);
      // a body is refused
      expect((await request(server()).get(`/audit/owner/organizations/${A1}/records`).query(WINDOW).set('authorization', 'Bearer owner-a-bearer').set('content-type', 'application/json').send('{"actorId":"x"}')).status).toBe(400);
    });
  });

  describe('cursor: bound to the owner, the organization, the filters and the window', () => {
    it('a cursor never crosses organizations, owners or routes; a malformed cursor is 400', async () => {
      const p1 = await owner(A1, 'owner-a-bearer', { limit: '1' });
      const cursor = p1.body.nextCursor as string;
      expect(cursor).toEqual(expect.any(String));
      const p2 = await owner(A1, 'owner-a-bearer', { limit: '1', cursor });
      expect(p2.status).toBe(200);
      expect(ids(p2)).not.toEqual(ids(p1));
      const other = await owner(A2, 'owner-a-bearer', { limit: '1', cursor });
      expect([other.status, other.body.code]).toEqual([400, 'invalid_cursor']);
      const otherOwner = await owner(A1, 'owner-c-bearer', { limit: '1', cursor });
      expect([otherOwner.status, otherOwner.body.code]).toEqual([400, 'invalid_cursor']);
      const narrowed = await owner(A1, 'owner-a-bearer', { limit: '1', cursor, category: 'business' });
      expect(narrowed.body.code).toBe('invalid_cursor');
      const svc = await request(server()).get(`/audit/organizations/${A1}/records`).query({ ...WINDOW, limit: '1', cursor }).set('authorization', `Bearer ${service.token}`);
      expect(svc.body.code).toBe('invalid_cursor');
      expect((await owner(A1, 'owner-a-bearer', { cursor: 'not!a!cursor' })).body.code).toBe('invalid_cursor');
      const tampered = Buffer.from(JSON.stringify({ v: 1, t: '1', i: '1', q: '0'.repeat(24) })).toString('base64url');
      expect((await owner(A1, 'owner-a-bearer', { cursor: tampered })).body.code).toBe('invalid_cursor');
    });
  });

  describe('bounds (unchanged Stage 18 grammar; the platform-scope window)', () => {
    it('window required, at most 31 days, UTC instants, to after from; limit 1–100; unknown or repeated parameters refused', async () => {
      const bad = async (q: Record<string, string | string[]>, code: string) => {
        const r = await request(server()).get(`/audit/owner/organizations/${A1}/records`).query(q).set('authorization', 'Bearer owner-a-bearer');
        expect([r.status, r.body.code], JSON.stringify(q)).toEqual([400, code]);
      };
      await bad({}, 'invalid_query');
      await bad({ from: WINDOW.from }, 'invalid_query');
      await bad({ from: '2026-05-01T00:00:00Z', to: '2026-06-02T00:00:00Z' }, 'window_too_large');
      await bad({ from: '2026-06-01T00:00:00+01:00', to: WINDOW.to }, 'invalid_query');
      await bad({ from: '2026-02-30T00:00:00Z', to: '2026-03-02T00:00:00Z' }, 'invalid_query');
      await bad({ from: WINDOW.to, to: WINDOW.from }, 'invalid_query');
      await bad({ ...WINDOW, limit: '101' }, 'invalid_query');
      await bad({ ...WINDOW, limit: '0' }, 'invalid_query');
      await bad({ ...WINDOW, where: '1=1' }, 'invalid_query');
      await bad({ ...WINDOW, action: ['membership.revoked', 'membership.approved'] }, 'invalid_query');
      expect((await owner(A1, 'owner-a-bearer', { from: '2026-06-01T00:00:00Z', to: '2026-07-02T00:00:00Z' })).status).toBe(200); // exactly 31 days
    });

    it('rate limit: keyed by the VERIFIED owner (headers and organizations do not reset it; another owner is unaffected)', async () => {
      const limited = await createTestApp({ databaseUrl: d.appUrl, env: { AUTH_SERVICE_URL: authUrl, AUDIT_OWNER_QUERY_RATE_PER_OWNER: '3', AUTH_TIMEOUT_MS: '300' } });
      try {
        const statuses: number[] = [];
        for (const [org, extra] of [[A1, {}], [A2, { 'x-owner-id': randomUUID() }], [A1, { 'x-user-id': randomUUID() }], [A2, {}]] as const) {
          statuses.push((await owner(org, 'owner-d-bearer', {}, limited).set(extra)).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
        expect((await owner(B1, 'owner-e-bearer', {}, limited)).status).toBe(200);
      } finally {
        await limited.app.close();
      }
    });
  });

  describe('Auth unavailable or unexpected: fail closed, no evidence', () => {
    it.each(['down', 'hang', 'malformed', 'wrong_org', 'redirect_same', 'redirect_cross', 'no_content', 'empty', 'oversized', 'oversized_chunked', 'slow_body', 'reset'] as const)('%s → 503, nothing returned, nothing recorded', async (mode) => {
      const before = (await selfRecords()).length;
      auth.state.mode = mode;
      try {
        const r = await owner(A1, 'owner-a-bearer');
        expect(r.status).toBe(503);
        expect(r.body.items).toBeUndefined();
      } finally {
        auth.state.mode = 'ok';
      }
      expect((await selfRecords()).length).toBe(before);
    });
  });

  describe('Stage 19.4: the bearer goes to the configured Auth only', () => {
    it('a redirect (same-origin or cross-origin) is never followed: the sink and the redirected path receive nothing', async () => {
      for (const mode of ['redirect_same', 'redirect_cross'] as const) {
        const before = auth.received.length;
        auth.state.mode = mode;
        try {
          expect((await owner(A1, 'owner-a-bearer')).status, mode).toBe(503);
        } finally {
          auth.state.mode = 'ok';
        }
        expect(auth.received.slice(before).map((x) => x.path), mode).toEqual(['/auth/grants']); // one request, the redirect not followed
      }
      expect(auth.sinkReceived).toEqual([]);
    });

    it('Audit calls exactly the two Auth paths, with the caller\'s own bearer, and a validated organization id only', async () => {
      const before = auth.received.length;
      await owner(A1, 'owner-a-bearer').expect(200);
      expect(auth.received.slice(before).map((x) => [x.path, x.authorization])).toEqual([
        ['/auth/grants', 'Bearer owner-a-bearer'],
        [`/auth/admin/organizations/${A1}`, 'Bearer owner-a-bearer'],
      ]);
      const mid = auth.received.length;
      await owner(encodeURIComponent('../grants'), 'owner-a-bearer').expect(400); // a path-shaped id never reaches Auth's lookup
      expect(auth.received.slice(mid).map((x) => x.path)).toEqual(['/auth/grants']);
    });

    it('cursors: a service cursor on the owner route, an oversized cursor and a repeated parameter are refused', async () => {
      const svc = await request(server()).get(`/audit/organizations/${A1}/records`).query({ ...WINDOW, limit: '1' }).set('authorization', `Bearer ${service.token}`);
      expect(svc.body.nextCursor).toEqual(expect.any(String));
      expect((await owner(A1, 'owner-a-bearer', { limit: '1', cursor: svc.body.nextCursor })).body.code).toBe('invalid_cursor');
      expect((await owner(A1, 'owner-a-bearer', { cursor: 'A'.repeat(600) })).body.code).toBe('invalid_query');
      expect((await owner(A1, 'owner-a-bearer', { limit: ['1', '2'] })).status).toBe(400);
    });
  });

  describe('configuration and privacy', () => {
    it('without AUTH_SERVICE_URL the owner route does not exist (Audit calls no other service)', async () => {
      const plain = await createTestApp({ databaseUrl: d.appUrl });
      try {
        expect((await owner(A1, 'owner-a-bearer', {}, plain)).status).toBe(404);
      } finally {
        await plain.app.close();
      }
    });

    it('no bearer and no result content in the logs; responses are never cached', async () => {
      const before = ALL_LOGS.length;
      const r = await owner(A1, 'owner-a-bearer');
      expect(r.headers['cache-control']).toBe('no-store');
      const logs = JSON.stringify(ALL_LOGS.slice(before));
      expect(logs).not.toContain('owner-a-bearer');
      expect(logs).not.toContain(OWNER_A);
      for (const item of r.body.items) expect(logs).not.toContain(item.eventId);
    });
  });
});
