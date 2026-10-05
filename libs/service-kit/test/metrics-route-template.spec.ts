import { Body, Controller, Get, Param, Post, UseGuards, type CanActivate } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthModule, JsonLogger, configureApp, loadBaseConfig } from '../src/index.js';

/**
 * V2 A12.2 gate: the route-template spike. HTTP metrics label a request with the route TEMPLATE Express matched
 * (`req.baseUrl + req.route.path`), read when the response finishes, and with `__unmatched__` when nothing matched. This proves, on
 * the installed Nest 12 / Express 5 and through the kit's real `configureApp` pipeline, that the template is present for every class of
 * matched request (a normal answer, a guard refusal, a pipe refusal, a thrown error, a tokenized path) and absent for an unknown path.
 * The raw request target is never a candidate: these assertions read only `req.route` and `req.baseUrl`.
 */

class SpikeDto {
  @IsString()
  name!: string;
}

class DenyGuard implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

@Controller('spike')
class SpikeController {
  @Get('items/:id') item(@Param('id') id: string) {
    return { id };
  }
  @UseGuards(DenyGuard)
  @Get('guarded/:id') guarded() {
    return { ok: true };
  }
  @Post('validated/:id') validated(@Body() dto: SpikeDto) {
    return { name: dto.name };
  }
  @Get('boom/:id') boom() {
    throw new Error('a failure whose message must never become a label');
  }
  @Get('t/:token') ticket() {
    return { ok: true };
  }
}

interface Seen {
  template: string | undefined;
  status: number;
}

let app: NestExpressApplication;
const seen: Seen[] = [];

beforeAll(async () => {
  const config = loadBaseConfig('spike-service', { NODE_ENV: 'production' });
  const logger = new JsonLogger(config.serviceName, 'error', () => undefined);
  const moduleRef = await Test.createTestingModule({ imports: [HealthModule.forRoot()], controllers: [SpikeController] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, logger);
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => seen.push({ template: req.route ? `${req.baseUrl}${String(req.route.path)}` : undefined, status: res.statusCode }));
    next();
  });
  await app.listen(0, '127.0.0.1');
});
afterAll(() => app.close());

async function last(run: () => Promise<unknown>): Promise<Seen> {
  const before = seen.length;
  await run();
  for (let i = 0; i < 50 && seen.length === before; i++) await new Promise((r) => setTimeout(r, 5));
  expect(seen.length).toBe(before + 1);
  return seen[seen.length - 1]!;
}

describe('route template at response finish (Nest 12 / Express 5)', () => {
  it('a normal matched request carries its declared template', async () => {
    const s = await last(() => request(app.getHttpServer()).get('/spike/items/0b6f2c1e-4a8e-4f57-9d55-3f0d6e3a1b22').expect(200));
    expect(s).toEqual({ template: '/spike/items/:id', status: 200 });
  });

  it('a guard refusal carries the template of the route it refused', async () => {
    const s = await last(() => request(app.getHttpServer()).get('/spike/guarded/org-7f3a').expect(403));
    expect(s).toEqual({ template: '/spike/guarded/:id', status: 403 });
  });

  it('a pipe (validation) refusal carries the template', async () => {
    const s = await last(() => request(app.getHttpServer()).post('/spike/validated/x1').send({ name: 7 }).expect(400));
    expect(s).toEqual({ template: '/spike/validated/:id', status: 400 });
  });

  it('a thrown error carries the template (status from the kit filter)', async () => {
    const s = await last(() => request(app.getHttpServer()).get('/spike/boom/x1').expect(500));
    expect(s).toEqual({ template: '/spike/boom/:id', status: 500 });
  });

  it('a tokenized path carries the template, never the token', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXRpY2tldA.c2lnbmF0dXJl';
    const s = await last(() => request(app.getHttpServer()).get(`/spike/t/${token}`).expect(200));
    expect(s).toEqual({ template: '/spike/t/:token', status: 200 });
    expect(JSON.stringify(s)).not.toContain(token);
  });

  it('an unknown path has no template (labelled __unmatched__ by the middleware)', async () => {
    const s = await last(() => request(app.getHttpServer()).get('/spike/nope/x').expect(404));
    expect(s).toEqual({ template: undefined, status: 404 });
  });

  it('the Express 5 router exposes the declared templates (the bound for the route label)', () => {
    const stack = (app.getHttpAdapter().getInstance() as { router?: { stack?: Array<{ route?: { path?: unknown } }> } }).router?.stack ?? [];
    const templates = stack.map((l) => l.route?.path).filter((p): p is string => typeof p === 'string');
    expect(templates).toEqual(expect.arrayContaining(['/spike/items/:id', '/spike/guarded/:id', '/spike/validated/:id', '/spike/boom/:id', '/spike/t/:token', '/health', '/ready']));
  });
});
