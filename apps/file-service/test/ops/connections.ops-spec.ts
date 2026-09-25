import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../../src/app.module.js';
import { describeWithEnv } from '../support/env.js';
import { fmt, MiB, pct, procStats, report, sleep, startService } from './support.js';

/**
 * Stage 17.9 probe: HTTP connection pressure on the built service with Node's defaults (headers 60 s, keep-alive 5 s; the request bound
 * raised for uploads in 17.5): N silent connections, N connections that send half a request line and stop (slowloris), N idle
 * keep-alive connections after a request. What each costs (descriptors, memory), when Node closes them, and whether /health stays
 * responsive meanwhile. Connection caps belong to the load balancer (the record says why); this measures what the process does alone.
 */
const N = Number(process.env.OPS_CONNECTIONS ?? 500);

describeWithEnv('ops probe: connection pressure', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let root: string;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileopscn');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    root = mkdtempSync(join(tmpdir(), 'file-ops-cn-'));
  });
  afterAll(async () => {
    await db?.drop();
    rmSync(root, { recursive: true, force: true });
  });

  it(`${N} silent, ${N} slowloris and ${N} idle keep-alive connections`, async () => {
    const svc = await startService({ DATABASE_URL: db.url, FILE_STORAGE_PROVIDER: 'filesystem', FILE_STORAGE_ROOT: root });
    const open = (kind: 'silent' | 'slowloris' | 'keepalive') => new Promise<Socket>((resolve) => {
      const s = connect(svc.port, '127.0.0.1', () => {
        if (kind === 'slowloris') s.write('GET /health HTTP/1.1\r\nHost: x\r\nX-Slow: ');
        if (kind === 'keepalive') s.write('GET /health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
        resolve(s);
      });
      s.on('error', () => undefined);
      s.on('data', () => undefined);
    });
    try {
      for (const kind of ['keepalive', 'silent', 'slowloris'] as const) {
        const idle = procStats(svc.pid);
        const sockets = await Promise.all(Array.from({ length: N }, () => open(kind)));
        await sleep(1_000);
        const held = procStats(svc.pid);
        const health: number[] = [];
        for (let i = 0; i < 20; i++) {
          const t = performance.now();
          await fetch(`${svc.base}/health`);
          health.push(performance.now() - t);
        }
        const closedAt: number[] = [];
        const t0 = Date.now();
        for (const s of sockets) s.once('close', () => closedAt.push(Date.now() - t0));
        const limit = kind === 'keepalive' ? 15_000 : 75_000;
        while (closedAt.length < N && Date.now() - t0 < limit) await sleep(500);
        const after = procStats(svc.pid);
        report(`connections kind=${kind} n=${N} fds_idle=${idle.fds} fds_held=${held.fds} rss_growth_MiB=${fmt((held.rss - idle.rss) / MiB, 1)} health_p95_ms=${fmt(pct(health, 95), 1)}`
          + ` closed_by_server=${closedAt.length}/${N} first_close_s=${fmt((closedAt.length ? Math.min(...closedAt) : NaN) / 1000, 1)} last_close_s=${fmt((closedAt.length ? Math.max(...closedAt) : NaN) / 1000, 1)} fds_after=${after.fds}`);
        for (const s of sockets) s.destroy();
        await sleep(500);
        expect(pct(health, 95)).toBeLessThan(1_000);
      }
    } finally {
      await svc.stop();
    }
  }, 300_000);
});
