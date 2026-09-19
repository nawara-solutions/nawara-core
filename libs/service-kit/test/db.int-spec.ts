import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbModule, DbService, HealthModule, ReadinessRegistry, configureApp, kitMigrationsDir, loadBaseConfig, JsonLogger, runMigrations, isUniqueViolation } from '../src/index.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

async function appWith(url: string, migrations?: { dirs: string[] }) {
  const config = loadBaseConfig('probe-service', { NODE_ENV: 'test' });
  const moduleRef = await Test.createTestingModule({ imports: [HealthModule.forRoot({ checkTimeoutMs: 1500 }), DbModule.forRoot({ url, max: 4, migrations })] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, config, new JsonLogger('probe-service', 'error', () => undefined));
  await app.listen(0, '127.0.0.1');
  return { app, db: app.get(DbService), registry: app.get(ReadinessRegistry) };
}

describeWithEnv('database foundation (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'dbfound');
    await runMigrations(db.url, [kitMigrationsDir]);
  });
  afterAll(() => db.drop());

  it('commits a transaction on success and rolls everything back on error', async () => {
    const { app, db: svc } = await appWith(db.url);
    await svc.query('CREATE TABLE IF NOT EXISTS t_tx(id int PRIMARY KEY, v text)');
    await svc.tx(async (q) => void (await q.query(`INSERT INTO t_tx VALUES (1, 'a')`)));
    await expect(svc.tx(async (q) => {
      await q.query(`INSERT INTO t_tx VALUES (2, 'b')`);
      await q.query(`INSERT INTO t_tx VALUES (1, 'dup')`); // unique violation
    })).rejects.toSatisfy((e) => isUniqueViolation(e));
    const { rows } = await svc.query('SELECT id FROM t_tx ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual([1]); // row 2 was rolled back with the failed transaction
    await app.close();
  });

  it('/ready is 200 with a healthy database and 503 (while /health stays 200) when it is unreachable', async () => {
    const ok = await appWith(db.url);
    await request(ok.app.getHttpServer()).get('/ready').expect(200);
    await ok.app.close();

    const down = await appWith('postgres://nobody:nothing@127.0.0.1:1/none');
    await request(down.app.getHttpServer()).get('/health').expect(200);
    const r = await request(down.app.getHttpServer()).get('/ready').expect(503);
    expect(r.body).toEqual({ status: 'unavailable', failed: ['database'] });
    await down.app.close();
  });

  it('/ready fails while migrations are pending and recovers once they are applied', async () => {
    const fresh = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'dbpending');
    try {
      const { app } = await appWith(fresh.url, { dirs: [kitMigrationsDir] });
      const r = await request(app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.failed).toEqual(['migrations']);
      await runMigrations(fresh.url, [kitMigrationsDir]);
      await request(app.getHttpServer()).get('/ready').expect(200);
      await app.close();
    } finally {
      await fresh.drop();
    }
  });

  it('closes its pool on graceful shutdown (no connection is left open)', async () => {
    const { app, db: svc } = await appWith(db.url);
    await svc.ping();
    await app.close();
    await expect(svc.ping()).rejects.toThrow(); // pool ended
  });
});
