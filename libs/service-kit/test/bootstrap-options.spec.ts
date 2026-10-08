import { Controller, Get, HttpException, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthModule, JsonLogger, KitExceptionFilter, ServiceAuthModule, configureApp, loadBaseConfig, type ConfigureAppOptions } from '../src/index.js';
import { ProbeController } from './support/app.js';

/**
 * V2 A4.4 (A4 record §8): the optional `configureApp` settings Auth needs (its own exception filter, CORS before the body parser,
 * URL-encoded bodies) and, above all, that a service passing none of them keeps exactly today's behaviour.
 */
@Controller('extra')
class ExtraFieldController {
  @Get('reason') reason() {
    throw new HttpException({ message: 'session ended', code: 'session_ceiling_reached', reason: 'session_ceiling_reached' }, 401);
  }
}
@Module({ controllers: [ExtraFieldController] })
class ExtraFieldModule {}

/** A subclass that passes one extra field through, as Auth's `AuthExceptionFilter` does. */
class ReasonFilter extends KitExceptionFilter {
  protected override extraResponseFields(raw: unknown): Record<string, unknown> {
    const r = raw as { reason?: unknown };
    return typeof r === 'object' && r !== null && typeof r.reason === 'string' ? { reason: r.reason } : {};
  }
}

const ALLOWED = 'https://admin.example.test';
const apps: NestExpressApplication[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
});
/** The kit's probe application (test/support/app.ts's controller and limits: BODY_LIMIT_KB=1), configured with the given options. */
async function app(configure: (logger: JsonLogger) => ConfigureAppOptions = () => ({}), env: NodeJS.ProcessEnv = {}) {
  const config = loadBaseConfig('probe-service', { NODE_ENV: 'production', BODY_LIMIT_KB: '1', CORS_ORIGINS: ALLOWED, ...env });
  const logger = new JsonLogger(config.serviceName, 'error', () => undefined);
  const moduleRef = await Test.createTestingModule({ imports: [HealthModule.forRoot({ checkTimeoutMs: 200 }), ServiceAuthModule.forRoot([]), ExtraFieldModule], controllers: [ProbeController] }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(nest, config, logger, configure(logger));
  await nest.listen(0, '127.0.0.1');
  apps.push(nest);
  return request(nest.getHttpServer());
}

describe('configureApp defaults (no option): unchanged for every existing service', () => {
  it('the default KitExceptionFilter: no extra response field passes through', async () => {
    const http = await app();
    const r = await http.get('/extra/reason').expect(401);
    expect(r.body).toEqual({ statusCode: 401, message: 'session ended', error: 'Unauthorized', code: 'session_ceiling_reached', requestId: r.headers['x-request-id'] });
  });

  it('JSON only: a URL-encoded body is not parsed (the DTO sees no field)', async () => {
    const http = await app();
    await http.post('/probe/echo').send({ name: 'json' }).expect(201, { name: 'json' });
    const form = await http.post('/probe/echo').type('form').send('name=form').expect(400);
    expect(form.body.code).toBe('validation_error');
  });

  it('CORS after the body parser: an allowed origin is echoed on a parsed request, not on a body refused while parsing', async () => {
    const http = await app();
    const ok = await http.get('/probe/ok').set('origin', ALLOWED).expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const malformed = await http.post('/probe/echo').set('origin', ALLOWED).set('content-type', 'application/json').send('{"name":').expect(400);
    expect(malformed.headers['access-control-allow-origin']).toBeUndefined();
    const oversized = await http.post('/probe/echo').set('origin', ALLOWED).send({ name: 'x'.repeat(2048) }).expect(413); // BODY_LIMIT_KB=1
    expect(oversized.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('no configured origin: no CORS header at all', async () => {
    const http = await app(() => ({}), { CORS_ORIGINS: '' });
    const r = await http.get('/probe/ok').set('origin', 'https://elsewhere.example.test').expect(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('configureApp options (V2 A4.4)', () => {
  it('exceptionFilter: the given KitExceptionFilter subclass is the global filter (its extra field passes through)', async () => {
    const http = await app((logger) => ({ exceptionFilter: new ReasonFilter(logger, { localize: true }) }));
    const r = await http.get('/extra/reason').expect(401);
    expect(r.body).toEqual({ statusCode: 401, message: 'session ended', error: 'Unauthorized', code: 'session_ceiling_reached', reason: 'session_ceiling_reached', requestId: r.headers['x-request-id'] });
    const v = await http.post('/probe/echo').set('accept-language', 'fr').send({}).expect(400); // still the localized kit filter
    expect(v.headers['content-language']).toBe('fr');
    expect(v.body.code).toBe('validation_error');
  });

  it('exceptionFilter is refused with errorLocalizationExcludedPaths (it configures the default filter only) or when it is not a kit filter', async () => {
    const config = loadBaseConfig('probe-service', { NODE_ENV: 'test' });
    const logger = new JsonLogger(config.serviceName, 'error', () => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule.forRoot({ checkTimeoutMs: 200 })] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    try {
      expect(() => configureApp(nest, config, logger, { exceptionFilter: new ReasonFilter(logger, { localize: true }), errorLocalizationExcludedPaths: ['/webhooks'] }))
        .toThrow(/^configureApp: errorLocalizationExcludedPaths configures the default exception filter; it cannot be combined with exceptionFilter$/);
      expect(() => configureApp(nest, config, logger, { exceptionFilter: { catch: () => undefined } as unknown as KitExceptionFilter }))
        .toThrow(/^configureApp: exceptionFilter must be a KitExceptionFilter or a subclass of it$/);
    } finally {
      await nest.close();
    }
  });

  it('corsBeforeBodyParser: a body refused while parsing (400, 413) still carries the allowed origin; a foreign origin still gets nothing', async () => {
    const http = await app(() => ({ corsBeforeBodyParser: true }));
    const malformed = await http.post('/probe/echo').set('origin', ALLOWED).set('content-type', 'application/json').send('{"name":').expect(400);
    expect(malformed.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(malformed.headers['access-control-allow-credentials']).toBeUndefined();
    const oversized = await http.post('/probe/echo').set('origin', ALLOWED).send({ name: 'x'.repeat(2048) }).expect(413);
    expect(oversized.headers['access-control-allow-origin']).toBe(ALLOWED);
    const foreign = await http.get('/probe/ok').set('origin', 'https://elsewhere.example.test').expect(200);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const none = await (await app(() => ({ corsBeforeBodyParser: true }), { CORS_ORIGINS: '' })).get('/probe/ok').set('origin', ALLOWED).expect(200);
    expect(none.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('urlencodedBodies: extended URL-encoded bodies are parsed under the same bodyLimitKb', async () => {
    const http = await app(() => ({ urlencodedBodies: true }));
    await http.post('/probe/echo').type('form').send('name=form').expect(201, { name: 'form' });
    const nested = await http.post('/probe/echo').type('form').send('name=n&extra[a]=1').expect(400); // extended: an object, refused by the DTO
    expect(nested.body.message).toEqual(['property extra should not exist']);
    await http.post('/probe/echo').type('form').send(`name=${'x'.repeat(2048)}`).expect(413);
  });
});
