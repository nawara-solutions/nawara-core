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
    t = await createTestApp({ env: { SWAGGER_PASSWORD: password, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RELEASE_OPERATING_COMPANY_ID: '00000000-0000-4000-8000-000000000001' } });
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

  it('documents exactly the two automation and two owner operations besides the kit probes (no list, read, compatibility or deployment route)', () => {
    const ops = Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(([p, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${p}`));
    expect(ops.filter((o) => !['GET /health', 'GET /ready'].includes(o)).sort()).toEqual([
      'POST /release/admin/products/{product}/components/{component}/compatibility-policy',
      'POST /release/admin/products/{product}/components/{component}/releases/{version}/withdraw',
      'POST /release/products/{product}/components/{component}/releases',
      'POST /release/products/{product}/components/{component}/releases/{version}/publish',
    ].sort());
    const automation = Object.keys(doc.paths).filter((p) => p.startsWith('/release/products'));
    expect(automation.join(' ')).not.toMatch(/withdraw|minimum|policy|compatib|deploy|channel|artifact|latest/i); // CI can do none of that
    expect(Object.keys(doc.paths).join(' ')).not.toMatch(/deploy|channel|artifact|latest|compatibility(?!-policy)/i); // no 20.5 read
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

  it('Stage 20.4: the owner routes declare the human bearer, the required step-up header and the statuses the runtime returns', () => {
    const w = doc.paths['/release/admin/products/{product}/components/{component}/releases/{version}/withdraw'].post;
    const p = doc.paths['/release/admin/products/{product}/components/{component}/compatibility-policy'].post;
    for (const op of [w, p]) {
      expect(op.security).toEqual([{ bearer: [] }]);
      expect(op.parameters.find((x: { in: string; name: string }) => x.in === 'header' && x.name === 'x-step-up-token')).toMatchObject({ required: true });
      expect(op.responses['403'].description).toMatch(/operation_not_allowed.*step_up_required/);
      expect(op.responses['503'].description).toMatch(/auth_timeout \| auth_unavailable/);
      expect(op.responses['401'].description).toMatch(/SERVICE token/);
    }
    expect(w.summary).toMatch(/"release\.withdraw"/);
    expect(p.summary).toMatch(/"compatibility_policy\.change"/);
    expect(Object.keys(w.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '503']);
    expect(Object.keys(p.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409', '503']);
    expect(w.responses['409'].description).toMatch(/invalid_transition.*would_break_minimum/);
    expect(p.responses['409'].description).toMatch(/policy_conflict.*invalid_minimum.*minimum_above_latest.*policy_not_applicable/);
    const dto = doc.components.schemas.ChangePolicyDto;
    expect(Object.keys(dto.properties).sort()).toEqual(['expectedPolicyVersion', 'minimumVersion']);
    expect(dto.required.sort()).toEqual(['expectedPolicyVersion', 'minimumVersion']);
  });
});
