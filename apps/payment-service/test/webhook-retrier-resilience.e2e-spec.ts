import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { WEBHOOK_RETRY_MAX_ATTEMPTS, WebhookRetriever } from '../src/webhooks/webhook-retrier.js';
import { WebhookService } from '../src/webhooks/webhook.service.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/**
 * Stage 14.6 (F7): the webhook retrier is bounded (attempt budget, deterministic backoff from receipt, a terminal
 * `retries_exhausted`), claims each row with FOR UPDATE SKIP LOCKED so two workers never reprocess the same event, and lets newer
 * eligible events through past older ones that are waiting or exhausted. Real PostgreSQL; the app's own background retrier is
 * stopped so every pass here is driven explicitly.
 */
describeWithEnv('webhook retrier: bounded, backed off, claimed (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let dbs: DbService;
  const billing = generateServiceToken();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'whretry');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient: { getIdentity: async () => null, hasPlatformAccess: async () => false },
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
    await t.app.get(WebhookRetriever).stop();
    dbs = t.app.get(DbService);
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  /** A stored webhook that matches no attempt: reprocessing it leaves it `unmatched` and counts one more attempt. */
  const stored = async (o: { secondsAgo: number; attempts?: number; state?: string; outcome?: string | null }) => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const body = Buffer.from(JSON.stringify({ eventId, type: 'payment.succeeded', reference: `ghost-${crypto.randomUUID()}`, amount: 1000, currency: 'TND' }));
    const { rows } = await dbs.query<{ id: string }>(
      `INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt", state, outcome, attempts)
       VALUES ('test', $1, 'payment.succeeded', $2, now() - make_interval(secs => $3), $4, $5, $6) RETURNING id`,
      [eventId, body, o.secondsAgo, o.state ?? 'unmatched', o.outcome ?? null, o.attempts ?? 0],
    );
    return rows[0]!.id;
  };
  const row = async (id: string) =>
    (await dbs.query<{ state: string; outcome: string | null; attempts: number }>('SELECT state, outcome, attempts FROM webhook_event WHERE id = $1', [id])).rows[0]!;
  const retrier = () => new WebhookRetriever(dbs, t.app.get(ProviderRegistry), t.app.get(WebhookService));

  it('backoff is deterministic from receipt: attempt n is due 10 s x 2^n after receipt, not before', async () => {
    const notDue = await stored({ secondsAgo: 15, attempts: 1 }); // attempt 1 is due at 20 s
    const due = await stored({ secondsAgo: 25, attempts: 1 });
    const fresh = await stored({ secondsAgo: 5, attempts: 0 }); // attempt 0 is due at 10 s (the previous fixed threshold)
    await retrier().drainOnce();
    expect((await row(notDue)).attempts).toBe(1);
    expect((await row(due)).attempts).toBe(2);
    expect((await row(fresh)).attempts).toBe(0);
  });

  it(`retries are bounded: after ${WEBHOOK_RETRY_MAX_ATTEMPTS} attempts the event is terminal (failed / retries_exhausted) and never reprocessed`, async () => {
    const spent = await stored({ secondsAgo: 86_400, attempts: WEBHOOK_RETRY_MAX_ATTEMPTS });
    const last = await stored({ secondsAgo: 86_400, attempts: WEBHOOK_RETRY_MAX_ATTEMPTS - 1 });
    const r1 = await retrier().drainOnce();
    expect(r1.exhausted).toBeGreaterThanOrEqual(1);
    expect(await row(spent)).toEqual({ state: 'failed', outcome: 'retries_exhausted', attempts: WEBHOOK_RETRY_MAX_ATTEMPTS });
    expect(await row(last)).toMatchObject({ state: 'unmatched', attempts: WEBHOOK_RETRY_MAX_ATTEMPTS }); // its final attempt ran
    await retrier().drainOnce();
    expect(await row(last)).toEqual({ state: 'failed', outcome: 'retries_exhausted', attempts: WEBHOOK_RETRY_MAX_ATTEMPTS }); // terminal once
    await retrier().drainOnce();
    expect((await row(last)).attempts).toBe(WEBHOOK_RETRY_MAX_ATTEMPTS); // and never touched again
  });

  it('no head-of-line blocking: 150 older events waiting on their backoff do not starve a newer eligible one (batch size is 100)', async () => {
    for (let i = 0; i < 150; i++) await stored({ secondsAgo: 600, attempts: 9 }); // attempt 9 is due only ~85 min after receipt
    const eligible = await stored({ secondsAgo: 30, attempts: 0 });
    await retrier().drainOnce();
    expect((await row(eligible)).attempts).toBe(1);
  });

  it('two workers never reprocess the same event, and every due event is processed exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => stored({ secondsAgo: 60, attempts: 0 })));
    const webhooks = t.app.get(WebhookService);
    const seen: string[] = [];
    const original = webhooks.reprocess.bind(webhooks);
    webhooks.reprocess = async (event, provider, claim) => {
      seen.push(event.id);
      await new Promise((r) => setTimeout(r, 25)); // widen the window in which the other worker could collide
      return original(event, provider, claim);
    };
    try {
      await Promise.all([retrier().drainOnce(), retrier().drainOnce()]);
    } finally {
      webhooks.reprocess = original;
    }
    const mine = seen.filter((id) => ids.includes(id));
    expect(new Set(mine).size).toBe(mine.length); // no event reprocessed twice
    expect(new Set(mine)).toEqual(new Set(ids)); // every due event reprocessed
    for (const id of ids) expect((await row(id)).attempts).toBe(1); // attempt counted exactly once
  });

  it('shutdown drains an in-flight pass: stop() waits for the running reprocess, then no new pass starts', async () => {
    const id = await stored({ secondsAgo: 60, attempts: 0 });
    const webhooks = t.app.get(WebhookService);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let calls = 0;
    const original = webhooks.reprocess.bind(webhooks);
    webhooks.reprocess = async (event, provider, claim) => {
      if (event.id !== id) return original(event, provider, claim);
      calls++;
      entered();
      await gate;
      return original(event, provider, claim);
    };
    const r = retrier();
    try {
      r.start(20);
      await started;
      let stopped = false;
      const stopping = r.stop(10_000).then((o) => ((stopped = true), o));
      await new Promise((res) => setTimeout(res, 100));
      expect(stopped).toBe(false); // still draining the in-flight pass
      release();
      expect(await stopping).toBe('drained');
      expect((await row(id)).attempts).toBe(1); // the drained pass completed its database work
      await new Promise((res) => setTimeout(res, 100));
      expect(calls).toBe(1); // no pass after stop
    } finally {
      webhooks.reprocess = original;
      release();
    }
  });

  it('Stage 14.7: an unresolved retry is a warn naming the event and its attempt; exhaustion is an ERROR naming the state it was stuck in', async () => {
    const lines: Array<[string, string]> = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void lines.push([level, String(m)]));
    try {
      const id = await stored({ secondsAgo: 86_400, attempts: WEBHOOK_RETRY_MAX_ATTEMPTS - 1 });
      await retrier().drainOnce(); // its last attempt: still unmatched
      await retrier().drainOnce(); // budget spent: terminal
      const mine = lines.filter(([, m]) => m.includes(`event=${id}`));
      expect(mine).toEqual([
        ['warn', `webhook_retry_unresolved event=${id} provider=test attempt=${WEBHOOK_RETRY_MAX_ATTEMPTS}/${WEBHOOK_RETRY_MAX_ATTEMPTS} state=unmatched outcome=- — retried again after its backoff`],
        ['error', `webhook_retry_exhausted event=${id} provider=test attempts=${WEBHOOK_RETRY_MAX_ATTEMPTS} lastState=unmatched lastOutcome=- — terminal for the retrier (failed/retries_exhausted); an operator must look at it`],
      ]);
      expect(await row(id)).toEqual({ state: 'failed', outcome: 'retries_exhausted', attempts: WEBHOOK_RETRY_MAX_ATTEMPTS }); // behaviour unchanged
      expect(lines.map(([, m]) => m).join('\n')).not.toMatch(/ghost-|rawBody/); // never the stored provider body
    } finally {
      vi.restoreAllMocks();
    }
  });
});
