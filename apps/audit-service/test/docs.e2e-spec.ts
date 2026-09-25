import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mountDocs } from '../src/docs/mount-docs.js';
import { createTestApp, type TestApp } from './support/app.js';

/** Stage 18.6: OpenAPI for the read routes, mounted only with SWAGGER_PASSWORD and only behind basic auth (the File / Billing pattern). */
describe('OpenAPI documentation', () => {
  const PASSWORD = 'docs-password-0123456789';
  let t: TestApp;
  beforeAll(async () => {
    let mounted = false;
    t = await createTestApp({ probes: false, env: { SWAGGER_PASSWORD: PASSWORD }, beforeInit: (app, config) => void (mounted = mountDocs(app, config)) });
    expect(mounted).toBe(true);
  });
  afterAll(() => t.app.close());

  it('is not mounted without SWAGGER_PASSWORD', async () => {
    const plain = await createTestApp({ probes: false });
    try {
      expect(mountDocs(plain.app, plain.config)).toBe(false);
    } finally {
      await plain.app.close();
    }
  });

  it('requires basic auth, then documents exactly the two read routes (GET only), with the service-token scheme', async () => {
    await request(t.app.getHttpServer()).get('/audit/docs-json').expect(401);
    const r = await request(t.app.getHttpServer()).get('/audit/docs-json').auth('docs', PASSWORD).expect(200);
    const paths = r.body.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).filter((p) => p.startsWith('/audit')).sort()).toEqual(['/audit/organizations/{organizationId}/records', '/audit/platform/records']);
    for (const p of Object.values(paths)) expect(Object.keys(p)).toEqual(['get']);
    expect(Object.keys(r.body.components.securitySchemes)).toEqual(['bearer']);
    expect(Object.keys(paths['/audit/platform/records']!.get as object)).toContain('responses');
  });
});
