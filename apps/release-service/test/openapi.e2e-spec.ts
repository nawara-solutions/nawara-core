import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 20.3: the OpenAPI document describes exactly the routes that exist (CI registration and publication), with the security, the
 * statuses and the request schema the runtime enforces. Mounted only behind basic auth, only when SWAGGER_PASSWORD is set. Needs no
 * database (the document is built from the module graph).
 */
describeWithEnv('release-service OpenAPI (Stage 20.3)', [], () => {
  let t: TestApp;
  const password = 'docs-password-0123456789';
  const basic = `Basic ${Buffer.from(`docs:${password}`).toString('base64')}`;
  let doc: Record<string, any>;

  beforeAll(async () => {
    t = await createTestApp({ env: { SWAGGER_PASSWORD: password } });
    const r = await request(t.app.getHttpServer()).get('/release/docs-json').set('authorization', basic);
    expect(r.status).toBe(200);
    doc = r.body as Record<string, any>;
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it('is behind basic auth (401 without it, or with a service token), and absent when SWAGGER_PASSWORD is unset', async () => {
    for (const headers of [{}, { authorization: 'Bearer anything' }, { authorization: `Basic ${Buffer.from('docs:wrong').toString('base64')}` }]) {
      expect((await request(t.app.getHttpServer()).get('/release/docs-json').set(headers)).status).toBe(401);
    }
    const bare = await createTestApp();
    try {
      expect((await request(bare.app.getHttpServer()).get('/release/docs-json')).status).toBe(404);
      expect((await request(bare.app.getHttpServer()).get('/release/docs')).status).toBe(404);
    } finally {
      await bare.app.close();
    }
  });

  it('documents exactly the two automation operations besides the kit probes (no list, read, withdrawal, policy, compatibility or deployment route)', () => {
    const ops = Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(([p, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${p}`));
    expect(ops.filter((o) => !['GET /health', 'GET /ready'].includes(o)).sort()).toEqual([
      'POST /release/products/{product}/components/{component}/releases',
      'POST /release/products/{product}/components/{component}/releases/{version}/publish',
    ]);
    expect(Object.keys(doc.paths).join(' ')).not.toMatch(/withdraw|minimum|policy|compatib|deploy|channel|artifact|latest/i);
  });

  it('declares bearer (service token) security and the statuses the runtime returns', () => {
    const reg = doc.paths['/release/products/{product}/components/{component}/releases'].post;
    const pub = doc.paths['/release/products/{product}/components/{component}/releases/{version}/publish'].post;
    for (const op of [reg, pub]) {
      expect(op.security).toEqual([{ bearer: [] }]);
      expect(op.summary).toMatch(/capability release\.(register|publish) for the product/);
    }
    expect(Object.keys(reg.responses).sort()).toEqual(['200', '201', '400', '401', '403', '409']);
    expect(Object.keys(pub.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409']);
    expect(reg.responses['403'].description).toMatch(/operation_not_allowed.*product_not_allowed/);
    expect(reg.responses['409'].description).toMatch(/component_kind_conflict.*release_conflict/);
    expect(pub.responses['404'].description).toMatch(/release_not_found/);
    expect(pub.responses['409'].description).toMatch(/invalid_transition/);
    for (const op of [reg, pub]) {
      expect(op.responses['200'].headers['Idempotent-Replayed']).toBeDefined(); // a RESPONSE header
      expect(op.parameters.filter((p: { in: string }) => p.in !== 'path')).toEqual([]); // no request header or query is part of the contract
    }
    expect(reg.parameters.map((p: { name: string; in: string }) => `${p.in}:${p.name}`).sort()).toEqual(['path:component', 'path:product']);
    expect(pub.parameters.filter((p: { in: string }) => p.in === 'path').map((p: { name: string }) => p.name).sort()).toEqual(['component', 'product', 'version']);
  });

  it('the registration schema is exactly the Stage 20.2 identity plus the kind (what the DTO whitelist accepts)', () => {
    const schema = doc.components.schemas.RegisterReleaseDto;
    expect(Object.keys(schema.properties).sort()).toEqual(['buildId', 'kind', 'notesRef', 'sourceRevision', 'version']);
    expect(schema.required.sort()).toEqual(['kind', 'version']);
    expect(schema.properties.kind.enum).toEqual(['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android']);
    const release = doc.components.schemas.ReleaseDto;
    expect(Object.keys(release.properties).sort()).toEqual(['buildId', 'component', 'id', 'kind', 'notesRef', 'product', 'publishedAt', 'registeredAt', 'sourceRevision', 'status', 'version', 'withdrawnAt']);
    expect(release.properties.status.enum).toEqual(['registered', 'published', 'withdrawn']);
  });
});
