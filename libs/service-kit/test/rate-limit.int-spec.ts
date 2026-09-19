import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, RateLimitService, kitMigrationsDir, runMigrations } from '../src/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('rate limiter (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let svc: DbService;
  let limiter: RateLimitService;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'ratelimit');
    await runMigrations(db.url, [kitMigrationsDir]);
    svc = new DbService({ url: db.url });
    limiter = new RateLimitService(svc);
  });
  afterAll(async () => {
    await (svc as unknown as { onApplicationShutdown(): Promise<void> }).onApplicationShutdown();
    await db.drop();
  });

  it('allows hits under the limit and blocks once the limit is exceeded, within one window', async () => {
    const rule = { limit: 3, windowSec: 60 };
    for (let i = 1; i <= 3; i++) {
      const r = await limiter.hit('signup', 'user-a', rule);
      expect(r).toEqual({ allowed: true, count: i, limit: 3 });
    }
    const over = await limiter.hit('signup', 'user-a', rule);
    expect(over).toEqual({ allowed: false, count: 4, limit: 3 });
  });

  it('keeps independent counters per bucket and per identifier', async () => {
    const rule = { limit: 1, windowSec: 60 };
    expect((await limiter.hit('login', 'user-b', rule)).allowed).toBe(true);
    expect((await limiter.hit('login', 'user-b', rule)).allowed).toBe(false);
    expect((await limiter.hit('login', 'user-c', rule)).allowed).toBe(true); // different identifier, same bucket
    expect((await limiter.hit('signup', 'user-b', rule)).allowed).toBe(true); // same identifier, different bucket
  });

  it('resets the window once it has elapsed', async () => {
    const rule = { limit: 1, windowSec: 0 }; // window elapses immediately
    expect((await limiter.hit('resettest', 'user-d', rule)).allowed).toBe(true);
    expect((await limiter.hit('resettest', 'user-d', rule)).count).toBe(1); // window already elapsed, counter restarts
  });

  it('assert() throws a 429 with the additive rate_limited code once over the limit, and does not throw while under it', async () => {
    const rule = { limit: 1, windowSec: 60 };
    await expect(limiter.assert('assertbucket', 'user-e', rule)).resolves.toBeUndefined();
    await expect(limiter.assert('assertbucket', 'user-e', rule)).rejects.toMatchObject({
      status: 429,
      response: { message: 'Too many requests.', code: 'rate_limited' },
    });
  });

  it('reset() clears the counter so the next hit starts a fresh window', async () => {
    const rule = { limit: 1, windowSec: 60 };
    expect((await limiter.hit('resetcall', 'user-f', rule)).allowed).toBe(true);
    expect((await limiter.hit('resetcall', 'user-f', rule)).allowed).toBe(false);
    await limiter.reset('resetcall', 'user-f');
    expect((await limiter.hit('resetcall', 'user-f', rule)).allowed).toBe(true);
  });

  it('never stores the raw identifier', async () => {
    await limiter.hit('rawcheck', 'super-secret-identifier', { limit: 5, windowSec: 60 });
    const { rows } = await svc.query('SELECT key FROM kit_rate_limit WHERE bucket = $1', ['rawcheck']);
    expect(JSON.stringify(rows)).not.toContain('super-secret-identifier');
  });

  it('rejects a malformed bucket name rather than silently accepting it', async () => {
    await expect(limiter.hit('Not Valid!', 'x', { limit: 1, windowSec: 60 })).rejects.toThrow(/invalid rate-limit bucket name/);
  });
});
