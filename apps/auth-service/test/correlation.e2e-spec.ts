import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from '@nawara/service-kit';
import { createTestApp, type TestCtx } from './helpers/app.js';

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Stage 13.2: `requestContextMiddleware` (kit) is wired first in the pipeline (main.ts / test harness), so
 * every response — success or error — carries `x-request-id`/`x-correlation-id`, and error bodies carry the
 * matching `requestId`. None of this can change identity/authorization outcomes: it is observability only.
 */
describe('request correlation', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it('generates a fresh request id and correlation id when the caller supplies none', async () => {
    const r = await t.http.get('/health');
    expect(r.headers[REQUEST_ID_HEADER]).toMatch(SAFE_ID);
    expect(r.headers[CORRELATION_ID_HEADER]).toBe(r.headers[REQUEST_ID_HEADER]);
  });

  it('preserves a caller-supplied correlation id, and mints its own request id (both echoed on the response)', async () => {
    const r = await t.http.get('/health').set(CORRELATION_ID_HEADER, 'caller-supplied-correlation-id');
    expect(r.headers[CORRELATION_ID_HEADER]).toBe('caller-supplied-correlation-id');
    expect(r.headers[REQUEST_ID_HEADER]).toMatch(SAFE_ID);
    expect(r.headers[REQUEST_ID_HEADER]).not.toBe('caller-supplied-correlation-id');
  });

  it('rejects an unsafe or too-short client-supplied correlation id and mints a fresh one instead', async () => {
    const r = await t.http.get('/health').set(CORRELATION_ID_HEADER, 'short');
    expect(r.headers[CORRELATION_ID_HEADER]).not.toBe('short');
    expect(r.headers[CORRELATION_ID_HEADER]).toMatch(SAFE_ID);
  });

  it('two concurrent requests never share a request id: context is isolated per request, not global mutable state', async () => {
    const [a, b] = await Promise.all([t.http.get('/health'), t.http.get('/health')]);
    expect(a.headers[REQUEST_ID_HEADER]).not.toBe(b.headers[REQUEST_ID_HEADER]);
  });

  it('is available on the error path too: an error response carries the same request id as the response header', async () => {
    const r = await t.http.get('/auth/does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body.requestId).toBe(r.headers[REQUEST_ID_HEADER]);
    expect(r.body.requestId).toMatch(SAFE_ID);
  });

  it('a client-supplied correlation id never changes an authorization outcome: an unauthenticated request is still 401', async () => {
    const r = await t.http.get('/auth/admin/factors').set(CORRELATION_ID_HEADER, 'attacker-supplied-id-12345');
    expect(r.status).toBe(401);
  });
});
