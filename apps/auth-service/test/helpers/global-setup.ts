import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
  }
}

const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on('error', rej);
  });
}

function findPgBin(): string {
  const root = '/usr/lib/postgresql';
  if (existsSync(root)) {
    const v = readdirSync(root).sort((a, b) => Number(b) - Number(a))[0];
    if (v && existsSync(join(root, v, 'bin/initdb'))) return join(root, v, 'bin');
  }
  throw new Error('No PostgreSQL binaries found. Set TEST_DATABASE_ADMIN_URL to an existing server instead.');
}

/**
 * Provides a PostgreSQL server for the whole run: either the one named by TEST_DATABASE_ADMIN_URL
 * (CI service container) or a throw-away local cluster. It applies every migration ONCE to a
 * template database; each test file clones it (CREATE DATABASE ... TEMPLATE) for full isolation.
 */
export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  let proc: ChildProcess | undefined;
  let dir: string | undefined;

  if (!adminUrl) {
    const bin = findPgBin();
    dir = mkdtempSync(join(tmpdir(), 'auth-pg-'));
    const port = await freePort();
    execFileSync(join(bin, 'initdb'), ['-D', dir, '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
    proc = spawn(join(bin, 'postgres'), ['-D', dir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', 'unix_socket_directories=', '-c', 'fsync=off', '-c', 'max_connections=400'], { stdio: 'ignore' });
    adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    for (let i = 0; ; i++) {
      try {
        const c = new pg.Client({ connectionString: adminUrl });
        await c.connect();
        await c.end();
        break;
      } catch {
        if (i > 100) throw new Error('local PostgreSQL did not start');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS auth_template');
  await admin.query('CREATE DATABASE auth_template');
  await admin.end();

  const tpl = new pg.Client({ connectionString: adminUrl.replace(/\/[^/]*$/, '/auth_template') });
  await tpl.connect();
  for (const f of readdirSync(MIGRATIONS).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    await tpl.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  await tpl.end();

  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgTemplate', 'auth_template');

  return async () => {
    proc?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
