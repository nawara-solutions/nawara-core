import http from 'node:http';
import { Controller, Get, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthModule, JsonLogger, configureApp, loadBaseConfig } from '../src/index.js';

/**
 * Stage 15.5 (F-A): once shutdown starts, the HTTP side is bounded by Core, not by clients. Before the fix, Nest closed the HTTP server
 * only after every worker drained, `/ready` answered 200 throughout, and a keep-alive connection busy at that instant kept serving further
 * requests for as long as its client used it: `app.close()` never returned.
 */
let release: () => void = () => undefined;
let reached = false;

@Controller('slow')
class SlowController {
  @Get('wait') async wait() {
    reached = true;
    await new Promise<void>((r) => (release = r));
    return { done: true };
  }
  @Get('ok') ok() {
    return { ok: true };
  }
}

const DRAIN_MS = 300;
async function start(): Promise<{ app: NestExpressApplication; base: string }> {
  const config = loadBaseConfig('probe-service', { NODE_ENV: 'test' });
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule.forRoot({ checkTimeoutMs: 200, httpDrainTimeoutMs: DRAIN_MS })],
    controllers: [SlowController as Type<unknown>],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, new JsonLogger(config.serviceName, 'error', () => undefined));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as { port: number };
  reached = false;
  return { app, base: `http://127.0.0.1:${port}` };
}

type Answer = { status: number | string; connection?: string; body?: string };
const get = (url: string, agent: http.Agent | false): Promise<Answer> =>
  new Promise((resolve) => {
    const req = http.get(url, { agent }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, connection: res.headers.connection, body }));
    });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: e.code ?? 'error' }));
  });
const waitFor = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 5));
};
const timed = async (p: Promise<unknown>) => {
  const t = Date.now();
  await p;
  return Date.now() - t;
};

afterEach(() => release());

describe('bounded HTTP drain (Stage 15.5, F-A)', () => {
  it('a request in flight at shutdown completes; the next one on the same keep-alive connection is refused 503 and the connection closed', async () => {
    const { app, base } = await start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const inFlight = get(`${base}/slow/wait`, agent);
    await waitFor(() => reached);
    const closing = app.close();
    await new Promise((r) => setTimeout(r, 30));
    expect((await get(`${base}/ready`, false)).status).toBe('ECONNREFUSED'); // no new connection is accepted
    release();
    expect(await inFlight).toMatchObject({ status: 200 });
    const next = await get(`${base}/ready`, agent); // same socket, admitted before the drain
    expect(next.status).toBe(503);
    expect(next.connection).toBe('close');
    expect(JSON.parse(next.body!)).toMatchObject({ code: 'shutting_down' });
    expect(await timed(closing)).toBeLessThan(DRAIN_MS + 1000);
    agent.destroy();
  });

  it('liveness still answers during the drain (with Connection: close); readiness does not', async () => {
    const { app, base } = await start();
    const a = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const b = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const inFlightA = get(`${base}/slow/wait`, a);
    await waitFor(() => reached);
    reached = false;
    const firstRelease = release;
    const inFlightB = get(`${base}/slow/wait`, b);
    await waitFor(() => reached);
    const closing = app.close();
    await new Promise((r) => setTimeout(r, 30));
    firstRelease();
    release();
    await Promise.all([inFlightA, inFlightB]);
    expect(await get(`${base}/health`, a)).toMatchObject({ status: 200, connection: 'close' });
    expect((await get(`${base}/ready`, b)).status).toBe(503);
    await closing;
    a.destroy();
    b.destroy();
  });

  it('a request that never finishes cannot hold shutdown beyond HTTP_DRAIN_TIMEOUT_MS: its connection is closed at the deadline', async () => {
    const { app, base } = await start();
    const hung = get(`${base}/slow/wait`, false);
    await waitFor(() => reached);
    const ms = await timed(app.close());
    expect(ms).toBeGreaterThanOrEqual(DRAIN_MS - 20);
    expect(ms).toBeLessThan(DRAIN_MS + 1000);
    expect((await hung).status).toBe('ECONNRESET');
  });

  it('a keep-alive client sending continuously cannot extend shutdown', async () => {
    const { app, base } = await start();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    let go = true;
    const answers: Answer['status'][] = [];
    const client = (async () => {
      while (go) {
        answers.push((await get(`${base}/slow/ok`, agent)).status);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    const ms = await timed(app.close());
    expect((await get(`${base}/slow/ok`, agent)).status).not.toBe(200); // after the close, nothing is served any more
    go = false;
    await client;
    expect(ms).toBeLessThan(DRAIN_MS + 1000);
    expect(answers).toContain(200);
    agent.destroy();
  });
});
