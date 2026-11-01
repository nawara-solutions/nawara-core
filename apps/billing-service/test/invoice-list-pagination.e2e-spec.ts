import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { encodeCursor, encodePreciseCursor } from '../src/common/pagination.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * F-INV-1 (found during BIL-12, 2026-11-01): `GET /billing/invoices` paged with a millisecond cursor over the microsecond `createdAt`,
 * so invoices of the same millisecond placed after a page's last row were excluded from every later page. The cursor now carries the
 * row's exact instant. Real PostgreSQL, the real routes. Exact creation instants are placed by a superuser fixture (the immutability
 * triggers bypassed for the fixture only), as one transaction's `now()` or as distinct microseconds of one millisecond would write them.
 */
describeWithEnv('invoice list pagination at microsecond precision (F-INV-1) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const producer = generateServiceToken();
  const otherProducer = generateServiceToken();
  const payerA: AuthIdentity = { id: crypto.randomUUID(), adminTier: null, isActive: true, memberships: [] };
  const payerB: AuthIdentity = { id: crypto.randomUUID(), adminTier: null, isActive: true, memberships: [] };
  const identities: Record<string, AuthIdentity> = { 'payer-a': payerA, 'payer-b': payerB };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billinginvoicepages');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 5 });
    t = await createTestApp({
      databaseUrl: db.url, authClient,
      tokens: [{ caller: 'test-producer', digest: producer.digest }, { caller: 'other-producer', digest: otherProducer.digest }],
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  const http = () => t.app.getHttpServer();
  const as = (bearer: string) => (path: string) => request(http()).get(path).set('authorization', `Bearer ${bearer}`);
  const asProducer = as(producer.token);
  let seq = 0;
  const price = async (token: string) => {
    seq += 1;
    const post = (path: string, body: object) => request(http()).post(path).set('authorization', `Bearer ${token}`).send(body);
    const sellerId = crypto.randomUUID();
    const product = await post('/billing/products', { seller: { type: 'organization', id: sellerId }, code: `p-${seq}`, name: `P ${seq}` }).expect(201);
    const p = await post('/billing/prices', { productId: product.body.id, clientReference: `r-${seq}`, currency: 'TND', unitAmount: 1500, interval: 'one_time', effectiveFrom: new Date().toISOString() }).expect(201);
    return { sellerId, priceId: p.body.id as string };
  };
  /** `n` invoices by `token`'s producer to `payerId`, all with one fresh `sourceId` so a filter can isolate this test's rows. */
  const invoices = async (n: number, o: { token?: string; payerId?: string; sourceId?: string; concurrent?: boolean } = {}) => {
    const token = o.token ?? producer.token;
    const { sellerId, priceId } = await price(token);
    const sourceId = o.sourceId ?? `src-${crypto.randomUUID().slice(0, 8)}`;
    const one = () => request(http()).post('/billing/invoices').set('authorization', `Bearer ${token}`).send({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: sellerId }, payer: { type: 'user', id: o.payerId ?? payerA.id },
      sourceType: 'contract', sourceId, issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
    }).expect(201).then((r) => r.body.id as string);
    const ids = o.concurrent ? await Promise.all(Array.from({ length: n }, one)) : await (async () => { const out: string[] = []; for (let i = 0; i < n; i++) out.push(await one()); return out; })();
    return { ids, sourceId };
  };
  /** Places each invoice's creation instant exactly (UTC text, microseconds), as a superuser with the triggers bypassed. */
  const placeAt = async (rows: Array<[string, string]>) => {
    const cl = await admin.connect();
    try {
      await cl.query('SET session_replication_role = replica');
      for (const [id, at] of rows) await cl.query(`UPDATE invoice SET "createdAt" = $2::timestamptz WHERE id = $1`, [id, at]);
    } finally {
      await cl.query('SET session_replication_role = origin');
      cl.release();
    }
  };
  /** The order the contract promises, from the database itself: newest first by the exact createdAt, then id. */
  const expectedOrder = async (ids: string[]) => (await admin.query(
    `SELECT id FROM invoice WHERE id = ANY($1::uuid[]) ORDER BY "createdAt" DESC, id DESC`, [ids])).rows.map((r) => r.id as string);
  /** Follows nextCursor to the end; returns every id in the order served, and the page sizes. */
  const walk = async (get: (path: string) => request.Test, query: string, limit: number) => {
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      const r: request.Response = await get(`/billing/invoices?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      seen.push(...r.body.items.map((i: { id: string }) => i.id));
      sizes.push(r.body.items.length);
      cursor = r.body.nextCursor;
      if (!cursor) return { seen, sizes };
    }
    throw new Error('no last page');
  };

  it('invoices sharing ONE instant (as one transaction\'s now() writes it) are each served exactly once, in id order, across every page size', async () => {
    const { ids, sourceId } = await invoices(5);
    await placeAt(ids.map((id) => [id, '2026-06-01T10:00:00.123456Z']));
    const order = await expectedOrder(ids);
    for (const limit of [1, 2, 3, 4, 5]) {
      const { seen } = await walk(asProducer, `sourceId=${sourceId}`, limit);
      expect(seen, `limit ${limit}`).toEqual(order);
    }
  });

  it('distinct microseconds within one millisecond, and across neighbouring milliseconds, keep their exact order across page boundaries', async () => {
    const { ids, sourceId } = await invoices(7);
    const ats = ['2026-06-01T11:00:00.122999Z', '2026-06-01T11:00:00.123000Z', '2026-06-01T11:00:00.123001Z', '2026-06-01T11:00:00.123456Z',
      '2026-06-01T11:00:00.123456Z', '2026-06-01T11:00:00.123999Z', '2026-06-01T11:00:00.124000Z'];
    await placeAt(ids.map((id, n) => [id, ats[n]!]));
    const order = await expectedOrder(ids);
    expect(order[0]).toBe(ids[6]); // the newest instant first
    for (const limit of [1, 2, 3]) {
      const { seen, sizes } = await walk(asProducer, `sourceId=${sourceId}`, limit);
      expect(seen, `limit ${limit}`).toEqual(order);
      expect(new Set(seen).size).toBe(7);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
    }
  });

  it('a natural burst of concurrent creations is listed completely and in order, whatever the page size', async () => {
    const { ids, sourceId } = await invoices(24, { concurrent: true });
    const order = await expectedOrder(ids);
    for (const limit of [1, 5, 7]) expect((await walk(asProducer, `sourceId=${sourceId}`, limit)).seen, `limit ${limit}`).toEqual(order);
  });

  it('a cursor issued before F-INV-1 (milliseconds) is still accepted and positions as it did; it cannot bring back rows of its own millisecond', async () => {
    const { ids, sourceId } = await invoices(4);
    await placeAt([[ids[0]!, '2026-06-01T12:00:00.123900Z'], [ids[1]!, '2026-06-01T12:00:00.123500Z'], [ids[2]!, '2026-06-01T12:00:00.123100Z'], [ids[3]!, '2026-06-01T12:00:00.122000Z']]);
    const legacy = encodeCursor({ createdAt: new Date('2026-06-01T12:00:00.123Z'), id: ids[0]! });
    const r = await asProducer(`/billing/invoices?sourceId=${sourceId}&cursor=${encodeURIComponent(legacy)}`).expect(200);
    expect(r.body.items.map((i: { id: string }) => i.id)).toEqual([ids[3]]); // strictly older than .123000: the old behaviour, unchanged
    const precise = encodePreciseCursor({ at: '2026-06-01T12:00:00.123900Z', id: ids[0]! });
    expect((await asProducer(`/billing/invoices?sourceId=${sourceId}&cursor=${encodeURIComponent(precise)}`).expect(200)).body.items.map((i: { id: string }) => i.id))
      .toEqual([ids[1], ids[2], ids[3]]); // a new cursor: every older row, the same millisecond included
  });

  it('malformed cursors are the existing 400, with no code and nothing listed', async () => {
    const raw = (t: unknown, i: unknown = crypto.randomUUID()) => Buffer.from(JSON.stringify({ t, i })).toString('base64url');
    for (const c of ['garbage!', raw('2026-06-01T12:00:00.12345Z'), raw('2026-06-01T12:00:00.1234567Z'), raw('2026-06-01T12:00:00.123456'),
      raw('2026-02-30T12:00:00.123456Z'), raw('2026-06-01T12:00:00.123456Z', 'not-a-uuid'), raw("2026-06-01T12:00:00.123456Z' OR '1'='1")]) {
      const r = await asProducer(`/billing/invoices?cursor=${encodeURIComponent(c)}`);
      expect([r.status, r.body.code], c).toEqual([400, undefined]);
      expect(r.body.items).toBeUndefined();
    }
  });

  it('isolation holds through the cursor: another producer and another payer see only their own invoices, whatever cursor they present', async () => {
    const sourceId = `shared-${crypto.randomUUID().slice(0, 8)}`;
    const mine = await invoices(3, { sourceId, payerId: payerA.id });
    const theirs = await invoices(3, { sourceId, payerId: payerB.id, token: otherProducer.token });
    const at = '2026-06-01T13:00:00.500000Z';
    await placeAt([...mine.ids, ...theirs.ids].map((id) => [id, at])); // all six share one instant
    expect([...(await walk(asProducer, `sourceId=${sourceId}`, 1)).seen].sort()).toEqual([...mine.ids].sort());
    expect([...(await walk(as(otherProducer.token), `sourceId=${sourceId}`, 1)).seen].sort()).toEqual([...theirs.ids].sort());
    expect([...(await walk(as('payer-b'), `sourceId=${sourceId}`, 1)).seen].sort()).toEqual([...theirs.ids].sort()); // a payer sees what it pays
    // a cursor positioned on the other producer's newest row only positions within MY rows
    const foreign = encodePreciseCursor({ at, id: (await expectedOrder(theirs.ids))[0]! });
    const r = await asProducer(`/billing/invoices?sourceId=${sourceId}&cursor=${encodeURIComponent(foreign)}&limit=100`).expect(200);
    expect(r.body.items.every((i: { id: string }) => mine.ids.includes(i.id))).toBe(true);
  });

  it('the response shape is unchanged: no cursor position or other internal column leaks into an item', async () => {
    const { sourceId } = await invoices(2);
    const r = await asProducer(`/billing/invoices?sourceId=${sourceId}&limit=1`).expect(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'nextCursor']);
    expect(Object.keys(r.body.items[0])).not.toContain('cursorAt');
    expect(JSON.parse(Buffer.from(r.body.nextCursor, 'base64url').toString()).t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });
});
