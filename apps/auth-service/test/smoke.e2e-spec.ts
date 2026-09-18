import { afterAll, beforeAll, describe, it } from 'vitest';
import { createTestApp, type TestCtx } from './helpers/app.js';

describe('smoke', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(() => t.close());

  it('boots against the migrated database and serves the liveness route', async () => {
    await t.http.get('/').expect(200);
  });
  it('refuses protected routes without a token', async () => {
    await t.http.get('/auth/me').expect(401);
  });
});
