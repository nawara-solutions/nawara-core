import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type ServiceTokenEntry } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AuditRecordRepository } from '../src/persistence/audit-record.repository.js';
import type { NewAuditRecord } from '../src/persistence/audit-record.types.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.6: audit reads over HTTP, through the real module graph, as the runtime role, on real PostgreSQL 16. Organizations A, B, C
 * and platform-level records are seeded with every filterable dimension; every attack tries to widen a caller's visibility.
 */
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const USER_A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const USER_B = 'b1b1b1b1-0000-4000-8000-00000000000b';
const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);
const WINDOW = { from: '2026-05-01T00:00:00Z', to: '2026-06-30T00:00:00Z' };
const PWINDOW = { from: '2026-05-25T00:00:00Z', to: '2026-06-20T00:00:00Z' };

type Caller = { name: string; token: string; entry: ServiceTokenEntry };
const caller = (name: string): Caller => {
  const { token, digest } = generateServiceToken();
  return { name, token, entry: { caller: name, digest } };
};
const ORG_READER = caller('org-reader');
const SEC_READER = caller('sec-reader'); // read_organization, security only
const SRC_READER = caller('src-reader'); // read_organization, all categories, auth + organization sources only
const PLATFORM_READER = caller('platform-reader'); // read_platform only
const PLATFORM_SEC = caller('platform-sec'); // read_platform, security only
const ALL = ['security', 'business', 'commercial', 'administrative'];
const POLICY = JSON.stringify({
  callers: {
    [ORG_READER.name]: { operations: ['read_organization'], categories: ALL },
    [SEC_READER.name]: { operations: ['read_organization'], categories: ['security'] },
    [SRC_READER.name]: { operations: ['read_organization'], categories: ALL, sourceServices: ['auth-service', 'organization-service'] },
    [PLATFORM_READER.name]: { operations: ['read_platform'], categories: ALL },
    [PLATFORM_SEC.name]: { operations: ['read_platform'], categories: ['security'] },
  },
});
const CALLERS = [ORG_READER, SEC_READER, SRC_READER, PLATFORM_READER, PLATFORM_SEC];

describeWithEnv('audit query and authorization (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const seeded: NewAuditRecord[] = [];
  const server = () => t.app.getHttpServer();
  const get = (path: string, who: Caller | undefined, query: Record<string, string | string[]> = {}) => {
    const r = request(server()).get(path).query(query);
    return who ? r.set('authorization', `Bearer ${who.token}`) : r;
  };
  const org = (id: string, who: Caller | undefined, query: Record<string, string | string[]> = {}) => get(`/audit/organizations/${id}/records`, who, { ...WINDOW, ...query });
  const platform = (who: Caller | undefined, query: Record<string, string | string[]> = {}) => get('/audit/platform/records', who, { ...PWINDOW, ...query });
  const selfRecords = async () => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE action = 'platform_query.executed'`))[0]!.n;

  function rec(over: Partial<NewAuditRecord> & { organizationId: string | null; minutes: number }): NewAuditRecord {
    const { minutes, ...rest } = over;
    return {
      eventId: randomUUID(),
      sourceService: 'auth-service',
      action: 'membership.revoked',
      category: 'business',
      schemaVersion: 1,
      actor: { type: 'user', id: USER_A, userKind: 'owner' },
      resource: { type: 'membership', id: randomUUID() },
      subject: { type: 'user', id: USER_A },
      outcome: 'succeeded',
      changes: { authority: 'owner', was_admin: false },
      correlationId: `corr-${randomUUID().slice(0, 8)}`,
      causationId: null,
      occurredAt: at(minutes),
      ...rest,
    };
  }

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aquery');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({ databaseUrl: d.appUrl, tokens: CALLERS.map((c) => c.entry), policy: POLICY });
    const repo = t.app.get(AuditRecordRepository);
    let m = 0;
    for (const o of [A, B, C]) {
      const other = o === A ? USER_A : USER_B;
      seeded.push(
        rec({ organizationId: o, minutes: m++, actor: { type: 'user', id: other, userKind: 'member' }, subject: { type: 'user', id: other } }),
        rec({ organizationId: o, minutes: m++, action: 'membership.admin_granted', category: 'security', changes: null }),
        rec({ organizationId: o, minutes: m++, action: 'invoice.issued', category: 'commercial', sourceService: 'billing-service', resource: { type: 'invoice', id: randomUUID() }, subject: null, changes: null, actor: { type: 'service', id: 'some-product' } }),
        rec({ organizationId: o, minutes: m++, action: 'organization.updated', category: 'administrative', sourceService: 'organization-service', resource: { type: 'organization', id: o }, subject: null, changes: null, actor: { type: 'service', id: 'some-product' } }),
        rec({ organizationId: o, minutes: m++, action: 'hierarchy.admin_operation_denied', category: 'security', sourceService: 'organization-service', outcome: 'denied', resource: { type: 'organization', id: o }, subject: null, changes: { operation: 'organization.update', reason: 'no_authority' } }),
        rec({ organizationId: o, minutes: m++, action: 'file.deleted', category: 'business', sourceService: 'file-service', resource: { type: 'file', id: randomUUID() }, subject: null, changes: null, actor: { type: 'service', id: 'some-product' } }),
      );
    }
    // Ties: three records of A with the SAME occurredAt (id is the tie-breaker).
    for (let i = 0; i < 3; i++) seeded.push(rec({ organizationId: A, minutes: 100 }));
    // Platform-level records (organizationId null).
    seeded.push(
      rec({ organizationId: null, minutes: 200, action: 'operator.created', category: 'security', resource: { type: 'user', id: randomUUID() }, subject: null, changes: null }),
      rec({ organizationId: null, minutes: 201, action: 'price.created', category: 'administrative', sourceService: 'billing-service', resource: { type: 'price', id: randomUUID() }, subject: null, changes: { product_id: randomUUID() }, actor: { type: 'service', id: 'some-product' } }),
    );
    for (const r of seeded) expect((await repo.insertOnce(r)).kind).toBe('inserted');
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });

  const ids = (res: request.Response) => (res.body.items as Array<{ eventId: string }>).map((i) => i.eventId);
  const seededOf = (pred: (r: NewAuditRecord) => boolean) => seeded.filter(pred).map((r) => r.eventId);

  // ───────────────────────────────────────────────────────────────────────────────────────────────────────────── authorization

  describe('authentication and operation authorization', () => {
    it('organization route: read_organization → 200; read_platform only → 403; unknown / malformed / missing token → 401', async () => {
      expect((await org(A, ORG_READER)).status).toBe(200);
      const denied = await org(A, PLATFORM_READER);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('operation_not_allowed');
      expect((await org(A, caller('org-reader'))).status).toBe(401); // right name, wrong secret
      expect((await org(A, undefined).set('authorization', 'Bearer not-a-token')).status).toBe(401);
      expect((await org(A, undefined).set('authorization', 'Basic abc')).status).toBe(401);
      expect((await org(A, undefined)).status).toBe(401);
    });

    it('platform route: read_platform → 200; read_organization only → 403 (never implied); unknown / malformed / missing token → 401', async () => {
      expect((await platform(PLATFORM_READER)).status).toBe(200);
      for (const who of [ORG_READER, SEC_READER, SRC_READER]) {
        const r = await platform(who);
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('operation_not_allowed');
      }
      expect((await platform(caller('platform-reader'))).status).toBe(401);
      expect((await platform(undefined).set('authorization', 'Bearer x')).status).toBe(401);
      expect((await platform(undefined)).status).toBe(401);
    });

    it('authorization happens BEFORE any data access: a denied or invalid request never runs the records query', async () => {
      const repo = t.app.get(AuditRecordRepository);
      const spy = vi.spyOn(repo, 'findPage');
      try {
        await org(A, PLATFORM_READER).expect(403);
        await platform(ORG_READER).expect(403);
        await org(A, undefined).expect(401);
        await org(A, ORG_READER, { to: WINDOW.from }).expect(400);
        await org('not-a-uuid', ORG_READER).expect(400);
        await org(A, SEC_READER, { category: 'business' }).expect(403);
        expect(spy).not.toHaveBeenCalled();
        await org(A, ORG_READER).expect(200);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── organization confidentiality

  describe('CROSS-TENANT: an organization-scope read returns ONLY that organization, never another one or a platform-level record', () => {
    it('A returns exactly A\'s records, newest first (occurredAt, then id)', async () => {
      const r = await org(A, ORG_READER, { limit: '100' });
      expect(r.status).toBe(200);
      expect(new Set(ids(r))).toEqual(new Set(seededOf((x) => x.organizationId === A)));
      expect(r.body.items.every((i: { organizationId: string }) => i.organizationId === A)).toBe(true);
      const times = r.body.items.map((i: { occurredAt: string }) => i.occurredAt);
      expect([...times].sort((x: string, y: string) => y.localeCompare(x))).toEqual(times);
    });

    const bRecord = () => seeded.find((x) => x.organizationId === B && x.action === 'membership.revoked')!;
    const pRecord = () => seeded.find((x) => x.organizationId === null)!;
    const attacks: Array<[string, () => Record<string, string | string[]>]> = [
      ['resource of a B record', () => ({ resourceType: bRecord().resource.type, resourceId: bRecord().resource.id })],
      ['resource of a platform record', () => ({ resourceType: pRecord().resource.type, resourceId: pRecord().resource.id })],
      ['actor of B', () => ({ actorType: 'user', actorId: USER_B })],
      ['subject of B', () => ({ subjectType: 'user', subjectId: USER_B })],
      ['correlation of a B record', () => ({ correlationId: bRecord().correlationId! })],
      ['action present in B and platform', () => ({ action: 'operator.created' })],
      ['category of the platform records', () => ({ category: 'administrative', sourceService: 'billing-service' })],
      ['organization B\'s own resource (the organization)', () => ({ resourceType: 'organization', resourceId: B })],
      ['every filter at once, pointing at B', () => ({ actorType: 'user', actorId: USER_B, subjectType: 'user', subjectId: USER_B, action: 'membership.revoked', category: 'business', sourceService: 'auth-service', outcome: 'succeeded' })],
      ['a scope override in the query string', () => ({ organizationId: B })],
      ['a platform flag', () => ({ platform: 'true' })],
      ['a repeated filter trying an OR', () => ({ actorId: [USER_A, USER_B], actorType: 'user' })],
    ];
    it.each(attacks)('%s → no record of B, C or the platform', async (_label, q) => {
      const r = await org(A, ORG_READER, q());
      if (r.status === 200) {
        expect(r.body.items.every((i: { organizationId: string }) => i.organizationId === A)).toBe(true);
      } else {
        expect(r.status).toBe(400);
        expect(r.body.items).toBeUndefined();
      }
    });

    it('an organization with no records (or unknown to Audit) is an ordinary empty page, never a 404', async () => {
      const r = await org('dddddddd-0000-4000-8000-000000000004', ORG_READER).expect(200);
      expect(r.body).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('CALLER POLICY: categories and source services are enforced in SQL, whatever the request says', () => {
    it('a security-only caller sees only security records with no filter; asking for another category or an action of one is 403', async () => {
      const r = await org(A, SEC_READER, { limit: '100' }).expect(200);
      expect(new Set(ids(r))).toEqual(new Set(seededOf((x) => x.organizationId === A && x.category === 'security')));
      expect((await org(A, SEC_READER, { category: 'commercial' })).body.code).toBe('category_not_allowed');
      expect((await org(A, SEC_READER, { action: 'invoice.issued' })).body.code).toBe('category_not_allowed');
      // A resource of a commercial record: the filter cannot pull it past the policy.
      const inv = seeded.find((x) => x.organizationId === A && x.category === 'commercial')!;
      expect(ids(await org(A, SEC_READER, { resourceType: 'invoice', resourceId: inv.resource.id }).expect(200))).toEqual([]);
    });

    it('a caller limited to auth + organization sources never sees billing or file records; asking for billing is 403', async () => {
      const r = await org(A, SRC_READER, { limit: '100' }).expect(200);
      expect(r.body.items.every((i: { sourceService: string }) => ['auth-service', 'organization-service'].includes(i.sourceService))).toBe(true);
      expect(new Set(ids(r))).toEqual(new Set(seededOf((x) => x.organizationId === A && ['auth-service', 'organization-service'].includes(x.sourceService))));
      expect((await org(A, SRC_READER, { sourceService: 'billing-service' })).body.code).toBe('source_not_allowed');
      const file = seeded.find((x) => x.organizationId === A && x.sourceService === 'file-service')!;
      expect(ids(await org(A, SRC_READER, { resourceType: 'file', resourceId: file.resource.id }).expect(200))).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────── pagination, cursors

  describe('keyset pagination and cursor binding', () => {
    it('walking A with limit 2 visits every record once, in order, including the three with the same occurredAt', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: Record<string, string> = cursor ? { limit: '2', cursor } : { limit: '2' };
        const r: request.Response = await org(A, ORG_READER, query).expect(200);
        seen.push(...ids(r));
        cursor = r.body.nextCursor;
        pages++;
      } while (cursor && pages < 50);
      expect(seen).toHaveLength(new Set(seen).size);
      expect(new Set(seen)).toEqual(new Set(seededOf((x) => x.organizationId === A)));
      const all = ids(await org(A, ORG_READER, { limit: '100' }));
      expect(seen).toEqual(all);
    });

    it('records inserted DURING a traversal: newer ones never appear in the remaining pages, older ones (beyond the position) do; no duplicate, no scope leak', async () => {
      const repo = t.app.get(AuditRecordRepository);
      const first = await org(A, ORG_READER, { limit: '4' }).expect(200);
      const newer = rec({ organizationId: A, minutes: 500 });
      const older = rec({ organizationId: A, minutes: -10 });
      const foreign = rec({ organizationId: B, minutes: -11 });
      for (const r of [newer, older, foreign]) await repo.insertOnce(r);
      seeded.push(newer, older, foreign);
      const rest: string[] = [];
      let cursor = first.body.nextCursor as string | null;
      while (cursor) {
        const r = await org(A, ORG_READER, { limit: '4', cursor }).expect(200);
        rest.push(...ids(r));
        cursor = r.body.nextCursor;
      }
      expect(rest).not.toContain(newer.eventId);
      expect(rest).toContain(older.eventId);
      expect(rest).not.toContain(foreign.eventId);
      expect(new Set([...ids(first), ...rest]).size).toBe(ids(first).length + rest.length);
    });

    it('CROSS-SCOPE / CROSS-FILTER cursor reuse is refused (400 invalid_cursor), never interpreted', async () => {
      const aCursor = (await org(A, ORG_READER, { limit: '1' })).body.nextCursor as string;
      const pCursor = (await platform(PLATFORM_READER, { limit: '1' })).body.nextCursor as string;
      const actionCursor = (await org(A, ORG_READER, { limit: '1', action: 'membership.revoked' })).body.nextCursor as string;
      const cases: Array<[string, () => request.Test]> = [
        ['A cursor on B', () => org(B, ORG_READER, { cursor: aCursor })],
        ['platform cursor on an organization', () => org(A, ORG_READER, { cursor: pCursor })],
        ['organization cursor on the platform', () => platform(PLATFORM_READER, { cursor: aCursor })],
        ['action X cursor with action Y', () => org(A, ORG_READER, { cursor: actionCursor, action: 'file.deleted' })],
        ['action cursor without the action', () => org(A, ORG_READER, { cursor: actionCursor })],
        ['another window', () => org(A, ORG_READER, { cursor: aCursor, from: '2026-05-02T00:00:00Z' })],
        ['another caller', () => org(A, SEC_READER, { cursor: aCursor })],
        ['platform narrowed differently', () => platform(PLATFORM_READER, { cursor: pCursor, platform: 'true' })],
      ];
      for (const [label, send] of cases) {
        const r = await send();
        expect(r.status, label).toBe(400);
        expect(r.body.code, label).toBe('invalid_cursor');
      }
    });

    it('a tampered position moves only within the same authorized query (no widening)', async () => {
      const c = JSON.parse(Buffer.from((await org(A, ORG_READER, { limit: '1' })).body.nextCursor, 'base64url').toString());
      const forged = Buffer.from(JSON.stringify({ ...c, t: '99999999999999999', i: '999999999' })).toString('base64url');
      const r = await org(A, ORG_READER, { cursor: forged, limit: '100' }).expect(200);
      expect(r.body.items.every((i: { organizationId: string }) => i.organizationId === A)).toBe(true);
    });

    it('page size: default 50, maximum 100, anything else refused', async () => {
      expect((await org(A, ORG_READER, { limit: '100' })).status).toBe(200);
      for (const limit of ['0', '101', '-1', '1e2', 'abc', '100000000000']) expect((await org(A, ORG_READER, { limit })).status, limit).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────── time

  it('TIME: half-open [from, to) on occurredAt: a record exactly at `from` is in, exactly at `to` is out; 92 / 31-day limits', async () => {
    const exact = seeded.find((x) => x.organizationId === A)!;
    const iso = new Date(exact.occurredAt).toISOString();
    expect(ids(await org(A, ORG_READER, { from: iso, to: new Date(Date.parse(iso) + 1).toISOString() }).expect(200))).toContain(exact.eventId);
    expect(ids(await org(A, ORG_READER, { from: new Date(Date.parse(iso) - 60_000).toISOString(), to: iso }).expect(200))).not.toContain(exact.eventId);
    const r92 = await org(A, ORG_READER, { from: '2026-01-01T00:00:00Z', to: '2026-04-03T00:00:00.001Z' });
    expect([r92.status, r92.body.code]).toEqual([400, 'window_too_large']);
    expect((await org(A, ORG_READER, { from: '2026-01-01T00:00:00Z', to: '2026-04-03T00:00:00Z' })).status).toBe(200); // exactly 92 days
    const p = await platform(PLATFORM_READER, { from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00.001Z' });
    expect([p.status, p.body.code]).toEqual([400, 'window_too_large']);
    expect((await platform(PLATFORM_READER, { from: '2026-05-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })).status).toBe(200); // exactly 31 days
    // DST in Europe (2026-03-29) is irrelevant: UTC only; an offset is refused.
    expect((await org(A, ORG_READER, { from: '2026-03-29T01:00:00+01:00', to: '2026-03-30T00:00:00Z' })).status).toBe(400);
    for (const [from, to] of [['infinity', WINDOW.to], [WINDOW.from, 'now'], ['2026-06-01', WINDOW.to], [WINDOW.to, WINDOW.from]]) {
      expect((await org(A, ORG_READER, { from, to })).status, `${from}..${to}`).toBe(400);
    }
    expect((await org(A, ORG_READER, { from: '1970-01-01T00:00:00Z', to: '1970-01-02T00:00:00Z' })).body.items).toEqual([]); // far past
    expect((await org(A, ORG_READER, { from: '2099-01-01T00:00:00Z', to: '2099-02-01T00:00:00Z' })).body.items).toEqual([]); // future
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────────── platform

  describe('PLATFORM scope (A38): every organization and platform-level records; each page recorded as platform_query.executed', () => {
    it('all: A, B, C and the platform-level records; organizationId=B: only B; platform=true: only null', async () => {
      const all = await platform(PLATFORM_READER, { limit: '100' }).expect(200);
      const orgs = new Set(all.body.items.map((i: { organizationId: string | null }) => i.organizationId));
      expect(orgs).toEqual(new Set([A, B, C, null]));
      const onlyB = await platform(PLATFORM_READER, { organizationId: B, limit: '100' }).expect(200);
      expect(onlyB.body.items.every((i: { organizationId: string }) => i.organizationId === B)).toBe(true);
      const onlyNull = await platform(PLATFORM_READER, { platform: 'true', limit: '100' }).expect(200);
      expect(onlyNull.body.items.length).toBeGreaterThan(0);
      expect(onlyNull.body.items.every((i: { organizationId: string | null }) => i.organizationId === null)).toBe(true);
    });

    it('a platform caller\'s category policy holds across organizations', async () => {
      const r = await platform(PLATFORM_SEC, { limit: '100' }).expect(200);
      expect(r.body.items.every((i: { category: string }) => i.category === 'security')).toBe(true);
      expect((await platform(PLATFORM_SEC, { category: 'commercial' })).body.code).toBe('category_not_allowed');
    });

    it('each successful page writes exactly ONE platform_query.executed (service actor, platform-level, security, bounded facts); recording never triggers another', async () => {
      const before = await selfRecords();
      const page1 = await platform(PLATFORM_READER, { limit: '3', action: 'membership.revoked' }).expect(200);
      expect(await selfRecords()).toBe(before + 1);
      await platform(PLATFORM_READER, { limit: '3', action: 'membership.revoked', cursor: page1.body.nextCursor }).expect(200);
      expect(await selfRecords()).toBe(before + 2);
      await new Promise((r) => setTimeout(r, 300));
      expect(await selfRecords()).toBe(before + 2); // nothing further, ever: no recursion
      const [last] = await sql<Record<string, any>>(d.adminUrl, `SELECT * FROM audit_record WHERE action = 'platform_query.executed' ORDER BY id DESC LIMIT 1`);
      expect(last).toMatchObject({
        sourceService: 'audit-service', category: 'security', schemaVersion: 1, actorType: 'service', actorId: 'platform-reader', userKind: null,
        organizationId: null, resourceType: 'platform_query', resourceId: last!.eventId, subjectType: null, outcome: 'succeeded',
        changes: { target: 'all', window_days: 26, result_count: 3, page: 'next', filtered: true },
      });
      // Organization-scope reads are not recorded (A57).
      await org(A, ORG_READER).expect(200);
      expect(await selfRecords()).toBe(before + 2);
      // A denied, invalid or rate-limited platform request records nothing.
      await platform(ORG_READER).expect(403);
      await platform(PLATFORM_READER, { from: 'x' }).expect(400);
      expect(await selfRecords()).toBe(before + 2);
    });

    it('platform-level queries find the self-audit records like any other evidence (platform=true, action filter)', async () => {
      const around = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
      const r = await platform(PLATFORM_READER, { ...around, platform: 'true', action: 'platform_query.executed', limit: '100' }).expect(200);
      expect(r.body.items.length).toBeGreaterThan(0);
      expect(r.body.items.every((i: { actor: { type: string } }) => i.actor.type === 'service')).toBe(true);
    });

    it('FAIL CLOSED: if the read cannot be recorded, NO evidence is returned (503 accountability_unavailable) and nothing is written', async () => {
      const before = await selfRecords();
      await sql(env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${d.name}`), `REVOKE INSERT ON audit_record FROM ${d.app}`);
      try {
        const r = await platform(PLATFORM_READER, { limit: '100' });
        expect(r.status).toBe(503);
        expect(r.body.code).toBe('accountability_unavailable');
        expect(r.body.items).toBeUndefined();
        expect(JSON.stringify(r.body)).not.toMatch(/permission|audit_record|42501/);
      } finally {
        await sql(env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, `/${d.name}`), `GRANT INSERT ON audit_record TO ${d.app}`);
      }
      expect(await selfRecords()).toBe(before);
      expect((await platform(PLATFORM_READER)).status).toBe(200); // recovered
    });
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────── response contract

  it('RESPONSE: identifiers and codes only; no internal id or position; no-store; JSON; a GET with a body is refused', async () => {
    const r = await org(A, ORG_READER, { limit: '1' }).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'nextCursor']);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['action', 'actor', 'causationId', 'category', 'changes', 'correlationId', 'eventId', 'occurredAt',
      'organizationId', 'outcome', 'recordedAt', 'resource', 'sourceService', 'subject'].sort());
    expect(JSON.stringify(r.body)).not.toMatch(/"id":"\d+"|occurredAtUs|"schemaVersion"/);
    const body = await request(server()).get(`/audit/organizations/${A}/records`).query(WINDOW).set('authorization', `Bearer ${ORG_READER.token}`)
      .set('content-type', 'application/json').send('{"organizationId":"x"}');
    expect([body.status, body.body.code]).toEqual([400, 'unexpected_body']);
    const err = await org(A, ORG_READER, { action: "x' OR 1=1 --" });
    expect(err.status).toBe(400);
    expect(JSON.stringify(err.body)).not.toMatch(/SELECT|audit_record|syntax|OR 1=1/);
  });

  it('LOGS: a query line carries the scope, the caller, the outcome and counts; never an organization id, a filter value or a record', async () => {
    await org(A, ORG_READER, { resourceType: 'membership', resourceId: USER_B }).expect(200);
    const lines = ALL_LOGS.filter((l) => String(l.msg).startsWith('audit_query')).map((l) => String(l.msg));
    expect(lines.some((m) => /^audit_query scope=organization caller=org-reader outcome=ok items=\d+ more=(true|false) ms=\d+$/.test(m))).toBe(true);
    const text = lines.join('\n');
    for (const secret of [A, B, USER_A, USER_B, ...CALLERS.map((c) => c.token)]) expect(text).not.toContain(secret);
  });
});

describeWithEnv('audit query rate limits (real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let t: TestApp;
  const X = caller('reader-x');
  const Y = caller('reader-y');
  const P = caller('platform-p');
  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aqrate');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    t = await createTestApp({
      databaseUrl: d.appUrl,
      tokens: [X.entry, Y.entry, P.entry],
      policy: JSON.stringify({ callers: { [X.name]: { operations: ['read_organization'], categories: ALL }, [Y.name]: { operations: ['read_organization'], categories: ALL }, [P.name]: { operations: ['read_platform'], categories: ALL } } }),
      env: { AUDIT_QUERY_RATE_PER_CALLER: '6', AUDIT_QUERY_RATE_PER_ORGANIZATION: '4', AUDIT_PLATFORM_QUERY_RATE_PER_CALLER: '2' },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await d?.drop();
  });
  const q = (who: Caller, orgId: string) => request(t.app.getHttpServer()).get(`/audit/organizations/${orgId}/records`).query(WINDOW).set('authorization', `Bearer ${who.token}`);
  const p = (who: Caller) => request(t.app.getHttpServer()).get('/audit/platform/records').query(PWINDOW).set('authorization', `Bearer ${who.token}`);

  it('per (caller, organization), per caller, per platform caller; a limited request runs no query; one caller cannot spend another\'s; the window recovers', async () => {
    const repo = t.app.get(AuditRecordRepository);
    const spy = vi.spyOn(repo, 'findPage');
    for (let i = 0; i < 4; i++) await q(X, A).expect(200);
    const limited = await q(X, A);
    expect([limited.status, limited.body.code]).toEqual([429, 'rate_limited']);
    expect(spy).toHaveBeenCalledTimes(4); // the refused one never reached the database query
    await q(X, B).expect(200); // another organization: its own budget (the caller budget has 6: 5 used)
    expect((await q(X, C)).status).toBe(429); // the caller budget is now spent (7th)
    await q(Y, A).expect(200); // Y is untouched by X
    await p(P).expect(200);
    await p(P).expect(200);
    expect((await p(P)).status).toBe(429);
    // Recovery: the fixed window ends (moved into the past here instead of waiting 60 s).
    await sql(d.adminUrl, `UPDATE kit_rate_limit SET "windowStart" = now() - interval '61 seconds'`);
    await q(X, A).expect(200);
    await p(P).expect(200);
    spy.mockRestore();
  });
});
