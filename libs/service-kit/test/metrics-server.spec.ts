import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MetricsHost } from '../src/index.js';
import { RUNTIME_METRICS } from '../src/metrics/runtime.js';
import { BoundedMetrics } from '../src/metrics/metrics.js';
import { createTestApp } from './support/app.js';
import { METRICS_ON, metricsUrl, scrape } from './support/metrics.js';

/** V2 A12.2: the metrics listener's lifecycle, the disabled default, and the runtime metric selection. */
const occupy = () =>
  new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

describe('metrics listener lifecycle (V2 A12.2)', () => {
  it('disabled (the default): nothing installed, no listener, no HTTP metrics', async () => {
    const t = await createTestApp();
    try {
      const host = t.app.get(MetricsHost);
      expect(host.metrics).toBeUndefined();
      expect(await host.address()).toBeUndefined();
      await request(t.app.getHttpServer()).get('/probe/ok').expect(200);
      expect(t.logs.map((l) => l.msg).join('\n')).not.toMatch(/metrics/);
    } finally {
      await t.app.close();
    }
  });

  it('starts with the application and closes with it', async () => {
    const t = await createTestApp({ env: METRICS_ON });
    const base = await metricsUrl(t.app);
    expect(await scrape(t.app)).toContain('nawara_service_info{service="probe-service"} 1');
    await t.app.close();
    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
  });

  it('an occupied port is logged by class and code only, and the application keeps serving', async () => {
    const { server, port } = await occupy();
    try {
      const t = await createTestApp({ env: { ...METRICS_ON, METRICS_PORT: String(port) } });
      try {
        expect(await t.app.get(MetricsHost).address()).toBeUndefined();
        await request(t.app.getHttpServer()).get('/probe/ok').expect(200);
        const line = t.logs.find((l) => String(l.msg).startsWith('metrics_listener_failed'));
        expect(line).toMatchObject({ level: 'error', context: 'Metrics' });
        expect(line!.msg).toMatch(/^metrics_listener_failed error=Error code=EADDRINUSE — the service runs without its metrics endpoint$/);
        expect(JSON.stringify(line)).not.toContain('127.0.0.1');
        expect(JSON.stringify(line)).not.toContain(String(port));
      } finally {
        await t.app.close();
      }
    } finally {
      server.close();
    }
  });

  it('never keeps the process alive (unref)', async () => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'metrics');
    const script = `
      const { BoundedMetrics } = await import(${JSON.stringify(join(dist, 'metrics.js'))});
      const { MetricsServer } = await import(${JSON.stringify(join(dist, 'metrics-server.js'))});
      const s = new MetricsServer(new BoundedMetrics(), () => {});
      const a = await s.start('127.0.0.1', 0);
      process.stdout.write(a ? 'listening' : 'failed');`;
    const started = Date.now();
    const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      child.on('exit', (code) => {
        clearTimeout(kill);
        resolve({ code, stdout });
      });
    });
    expect(out).toEqual({ code: 0, stdout: 'listening' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('runtime metrics', () => {
  it('exposes exactly the selected runtime metrics, and none of the excluded ones', async () => {
    const body = (await new BoundedMetrics({ runtime: true }).render()).body;
    const types = new Set(body.split('\n').filter((l) => l.startsWith('# TYPE ')).map((l) => l.split(' ')[2]));
    for (const n of RUNTIME_METRICS) expect(types.has(n), n).toBe(true); // Linux: the fd metrics included
    for (const n of ['nodejs_heap_space_size_used_bytes', 'nodejs_active_handles', 'nodejs_active_requests', 'nodejs_active_resources', 'process_virtual_memory_bytes', 'process_heap_bytes', 'nodejs_eventloop_lag_seconds']) {
      expect(types.has(n), n).toBe(false);
    }
  });

  it('two registries in one process do not collide', async () => {
    const a = await new BoundedMetrics({ runtime: true }).render();
    const b = await new BoundedMetrics({ runtime: true }).render();
    expect(a.body).toContain('nodejs_version_info');
    expect(b.body).toContain('nodejs_version_info');
  });
});
