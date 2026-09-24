import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AttemptResolver, RESOLVE_LEASE_MS } from '../src/attempts/attempt-resolver.js';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const paymentBody = () => {
  const organizationId = crypto.randomUUID();
  return {
    paymentRequestId: crypto.randomUUID(),
    sourceType: 'invoice',
    sourceId: 'inv-1',
    payer: { type: 'user', id: 'user-1' },
    seller: { type: 'organization', id: organizationId },
    organizationId,
    amount: 1000,
    currency: 'TND',
  };
};

describeWithEnv('attempt resolver (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async (bearer) => (bearer === 'user-1-jwt' ? userIdentity : null), hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'resolverapi');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000' }, // the lease test starts 60 attempts for one payer
    });
    // Stage 15.8: the passes here are driven explicitly; the app's own timer would claim attempts (lease) under a test's feet.
    await t.app.get(AttemptResolver).stop();
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const server = () => t.app.getHttpServer();
  const createPayment = async () => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(paymentBody())).body;
  const startAttempt = (paymentId: string, key: string, providerOptions: Record<string, unknown>) =>
    request(server()).post(`/payment/payments/${paymentId}/attempts`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', key).send({ providerOptions });
  const getPayment = (paymentId: string) => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', 'Bearer user-1-jwt');

  it('settles a stuck "unknown" attempt on its own, without any client calling sync', async () => {
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'resolver-key-1', { scenario: 'timeout_after_accept' }).expect(201);
    expect(start.body.status).toBe('unknown');

    const resolver = t.app.get(AttemptResolver);
    const { resolved } = await resolver.drainOnce();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.status).toBe('succeeded');
    expect(after.body.attempts[0].status).toBe('succeeded');
  });

  it('leaves a genuinely still-pending attempt alone (no false resolution)', async () => {
    // "success" scenario is immediately submitted (not stuck) — draining must not touch it.
    const payment = await createPayment();
    const start = await startAttempt(payment.id, 'resolver-key-2', { scenario: 'success' }).expect(201);
    expect(start.body.status).toBe('submitted');

    const resolver = t.app.get(AttemptResolver);
    await resolver.drainOnce(); // "submitted" attempts younger than the long-submitted threshold are left alone

    const after = await getPayment(payment.id).expect(200);
    expect(after.body.attempts[0].status).toBe('submitted'); // untouched — still needs a real sync/webhook
  });

  afterEach(() => vi.restoreAllMocks());

  it('M-02: an attempt whose provider is not enabled is skipped and left as it is; the stuck attempts before and after it are still settled in the same pass', async () => {
    // A provider is "not enabled" exactly when the registry does not hold it (disabled since the attempt was made, or never known): 'acme' is such a provider.
    const sql = <R extends Record<string, any> = any>(text: string, params?: unknown[]) => t.app.get(DbService).query<R>(text, params);
    const pause = () => new Promise((r) => setTimeout(r, 15)); // the resolver orders by initiatedAt: A, then B, then C

    const a = await createPayment();
    await startAttempt(a.id, 'm02-key-a', { scenario: 'timeout_after_accept' }).expect(201);
    await pause();
    const b = await createPayment();
    const bAttemptId = crypto.randomUUID();
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, status) VALUES ($1, $2, 1, 'acme', 'unknown')`, [bAttemptId, b.id]);
    await sql(`UPDATE payment SET status = 'pending' WHERE id = $1`, [b.id]);
    await pause();
    const c = await createPayment();
    await startAttempt(c.id, 'm02-key-c', { scenario: 'timeout_after_accept' }).expect(201);

    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warnings.push(String(m)));

    await expect(t.app.get(AttemptResolver).drainOnce()).resolves.toBeDefined(); // used to reject on B's provider lookup

    expect((await getPayment(a.id).expect(200)).body.status).toBe('succeeded'); // before it
    expect((await getPayment(c.id).expect(200)).body.status).toBe('succeeded'); // after it: this one was starved before the fix

    // B is untouched: attempt still unknown, payment still pending and not closed, no second attempt, no failure recorded
    const attempt = (await sql(`SELECT status, "failureCode", "completedAt" FROM payment_attempt WHERE id = $1`, [bAttemptId])).rows[0];
    expect(attempt).toMatchObject({ status: 'unknown', failureCode: null, completedAt: null });
    const payment = (await sql(`SELECT status, "closedAt" FROM payment WHERE id = $1`, [b.id])).rows[0];
    expect(payment).toMatchObject({ status: 'pending', closedAt: null });
    expect((await sql(`SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1`, [b.id])).rows[0].n).toBe(1);
    expect((await sql(`SELECT count(*)::int AS n FROM outbox WHERE payload->>'paymentId' = $1 AND name IN ('payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired')`, [b.id])).rows[0].n).toBe(0); // no terminal event for B

    expect(warnings).toContain(`attempt_resolver_provider_unavailable attempt=${bAttemptId} provider=acme — left unresolved`);
  });

  it('is safe to run twice in a row (idempotent — no double effect)', async () => {
    const payment = await createPayment();
    await startAttempt(payment.id, 'resolver-key-3', { scenario: 'timeout_before_accept' }).expect(201);

    const resolver = t.app.get(AttemptResolver);
    await resolver.drainOnce();
    const after1 = await getPayment(payment.id).expect(200);
    await resolver.drainOnce();
    const after2 = await getPayment(payment.id).expect(200);
    expect(after2.body.status).toBe(after1.body.status);
    expect(after2.body.attempts[0].status).toBe(after1.body.attempts[0].status);
  });

  it('Stage 15.8: four resolver instances ask the provider about each open attempt ONCE per lease, not once per instance (20 iterations)', async () => {
    // Real database and real AttemptService; the provider's status call is counted and answers `pending`, so every attempt stays open.
    const real = t.app.get(ProviderRegistry).get('test');
    const calls = new Map<string, number>();
    const counting = { ...real, capabilities: real.capabilities, fetchStatus: async (ref: string) => (calls.set(ref, (calls.get(ref) ?? 0) + 1), { kind: 'pending' as const }) };
    const registry = { tryGet: (id: string) => (id === 'test' ? counting : undefined), get: () => counting };
    const instances = Array.from({ length: 4 }, () => new AttemptResolver(t.app.get(DbService), registry as never, t.app.get(AttemptService)));
    const refOf = async (paymentId: string) =>
      (await t.app.get(DbService).query<{ ref: string }>(`SELECT coalesce("providerTransactionId", "merchantReference"::text) AS ref FROM payment_attempt WHERE "paymentId" = $1`, [paymentId])).rows[0]!.ref;
    for (let i = 0; i < 20; i++) {
      const refs: string[] = [];
      for (let k = 0; k < 3; k++) {
        const payment = await createPayment();
        await startAttempt(payment.id, `lease-${i}-${k}-${crypto.randomUUID()}`, { scenario: 'timeout_after_accept' }).expect(201);
        refs.push(await refOf(payment.id));
      }
      calls.clear();
      await Promise.all(instances.map((r) => r.drainOnce())); // four instances, one pass each, concurrently
      for (const ref of refs) expect(calls.get(ref)).toBe(1); // before Stage 15.8: 4 (one call per instance)
      for (const n of calls.values()) expect(n).toBe(1); // older attempts whose lease ran out: still one call, never one per instance
      calls.clear();
      await Promise.all(instances.map((r) => r.drainOnce())); // inside the lease: nobody asks again
      for (const ref of refs) expect(calls.get(ref)).toBeUndefined();
    }
    // A lease runs out on its own (a worker that died holding one blocks nothing): after it, exactly one instance asks again.
    await new Promise((r) => setTimeout(r, RESOLVE_LEASE_MS + 200));
    calls.clear();
    await Promise.all(instances.map((r) => r.drainOnce()));
    expect(calls.size).toBeGreaterThan(0);
    for (const n of calls.values()) expect(n).toBe(1);
  }, 120_000);
});
