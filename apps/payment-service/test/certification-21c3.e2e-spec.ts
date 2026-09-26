import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, MemoizedOrganizationReference, generateServiceToken, kitMigrationsDir, runMigrations, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const P1 = 'aaaaaaaa-0000-4000-8000-0000000000f1';
const P2 = 'aaaaaaaa-0000-4000-8000-0000000000f2';
const ORG_P1 = 'bbbbbbbb-0000-4000-8000-000000000101';
const ORG_P2 = 'bbbbbbbb-0000-4000-8000-000000000102';

/**
 * Stage 21.C.3 §13 (focused certification): the positive memo proves anchors only; it is never an authorization. An Organization memoized
 * because ONE caller was allowed it is still refused to a caller whose Platforms do not include it, and nothing is written.
 */
describeWithEnv('21.C.3: the Organization memo never authorizes another caller (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const lookups: string[] = [];
  const a = generateServiceToken();
  const b = generateServiceToken();

  beforeAll(async () => {
    const source: OrganizationReferenceResolver = {
      resolve: async (id) => {
        lookups.push(id);
        if (id === ORG_P1) return { organizationId: id, platformId: P1, companyId: 'cccccccc-0000-4000-8000-000000000001' };
        if (id === ORG_P2) return { organizationId: id, platformId: P2, companyId: 'cccccccc-0000-4000-8000-000000000001' };
        return null;
      },
    };
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentcert21c3');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'caller-p1', digest: a.digest }, { caller: 'caller-p2', digest: b.digest }],
      reference: new MemoizedOrganizationReference(source),
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: {
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'caller-p1': { operations: ['payment.create'], allowedPlatforms: [P1] },
          'caller-p2': { operations: ['payment.create'], allowedPlatforms: [P2] },
        } }),
      },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const create = (token: string, org: string) => request(t.app.getHttpServer()).post('/payment/payments').set('authorization', `Bearer ${token}`).send({
    paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv', payer: { type: 'user', id: 'u1' },
    seller: { type: 'organization', id: org }, organizationId: org, amount: 1000, currency: 'TND',
  });
  const payments = async () => (await t.app.get(DbService).query<{ n: number }>('SELECT count(*)::int AS n FROM payment')).rows[0]!.n;

  it('a memoized Organization of P1 is refused to the P2 caller (and vice versa); the memo answers, the scope decides', async () => {
    await create(a.token, ORG_P1).expect(201);
    await create(b.token, ORG_P2).expect(201);
    expect(lookups).toEqual([ORG_P1, ORG_P2]);
    const before = await payments();
    const r1 = await create(b.token, ORG_P1);
    const r2 = await create(a.token, ORG_P2);
    expect([r1.status, r1.body.code, r2.status, r2.body.code]).toEqual([403, 'organization_not_permitted', 403, 'organization_not_permitted']);
    expect(lookups).toEqual([ORG_P1, ORG_P2]); // both answered from the memo: the memo is not the decision
    expect(await payments()).toBe(before);
  });

  it('a nonexistent Organization never becomes a memo entry, whoever asks', async () => {
    const ghost = 'bbbbbbbb-0000-4000-8000-0000000000ff';
    await create(a.token, ghost).expect(403);
    await create(b.token, ghost).expect(403);
    expect(lookups.filter((l) => l === ghost)).toHaveLength(2);
  });
});
