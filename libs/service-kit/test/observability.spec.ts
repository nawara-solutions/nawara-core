import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Injectable, Logger, type BeforeApplicationShutdown, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthModule, PollLoop, PublisherConfirmTimeoutError, ReadinessRegistry, describeFailure, failureFacts } from '../src/index.js';

/**
 * Stage 14.7: the stable guarantees of the operational signals — event names and fields, never prose, and never a secret.
 * Real-infrastructure proofs of the same signals are in `observability.int-spec.ts`.
 */
const dbError = (code: string, message = 'server said something') => Object.assign(new pg.DatabaseError(message, 0, 'error'), { code });

describe('describeFailure', () => {
  it('names the layer that failed: class, code and a stable kind', () => {
    expect(describeFailure(dbError('57014'))).toBe('error=DatabaseError code=57014 kind=db_statement_timeout');
    expect(describeFailure(dbError('25P03'))).toBe('error=DatabaseError code=25P03 kind=db_idle_in_transaction_timeout');
    expect(describeFailure(dbError('57P01'))).toBe('error=DatabaseError code=57P01 kind=db_connection_lost');
    expect(describeFailure(dbError('28P01'))).toBe('error=DatabaseError code=28P01 kind=db_auth_failed');
    expect(describeFailure(dbError('23505'))).toBe('error=DatabaseError code=23505'); // a real code, no operational kind
    expect(describeFailure(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }))).toBe('error=Error code=ECONNREFUSED kind=network_unreachable');
    expect(describeFailure(new Error('timeout exceeded when trying to connect'))).toBe('error=Error kind=db_connect_timeout');
    expect(describeFailure(new Error('Client has encountered a connection error and is not queryable'))).toBe('error=Error kind=db_connection_lost');
    expect(describeFailure(new PublisherConfirmTimeoutError(5000))).toBe('error=PublisherConfirmTimeoutError kind=broker_confirm_timeout');
    expect(describeFailure(new TypeError('x'))).toBe('error=TypeError');
    expect(describeFailure('a string')).toBe('error=unknown');
    expect(describeFailure({ code: '57014' })).toBe('error=unknown'); // not an Error: nothing on it is trusted
  });

  it('never carries the error message, and never an untrusted code or class', () => {
    const e = Object.assign(new Error('connect to postgres://app:hunter2@db.internal/app failed, Bearer abc.def'), { code: 'ECONN REFUSED; password=hunter2' });
    const line = describeFailure(e);
    expect(line).toBe('error=Error');
    expect(line).not.toMatch(/hunter2|db\.internal|Bearer/);
    expect(failureFacts(dbError('57014', 'canceling statement: SELECT secret FROM t WHERE token = $1'))).toEqual({ error: 'DatabaseError', code: '57014', kind: 'db_statement_timeout' });
  });

  it('the pg texts it recognises exist verbatim in the INSTALLED pg / pg-pool (a pg upgrade that changes them fails here)', () => {
    const require = createRequire(import.meta.url);
    const pgDir = require.resolve('pg').replace(/lib[\\/]index\.js$/, '');
    const pool = readFileSync(createRequire(require.resolve('pg')).resolve('pg-pool'), 'utf8');
    const client = readFileSync(`${pgDir}lib/client.js`, 'utf8');
    expect(pool).toContain("'timeout exceeded when trying to connect'");
    expect(pool).toContain("'Connection terminated due to connection timeout'");
    expect(client).toContain("'Client has encountered a connection error and is not queryable'");
    expect(client).toContain("'Connection terminated unexpectedly'");
  });
});

describe('PollLoop drain-timeout signal', () => {
  it('reports a drain that ran out (with its bound), and stays silent for an idle or drained stop', async () => {
    const reported: number[] = [];
    let release!: () => void;
    const loop = new PollLoop(() => new Promise<void>((r) => (release = r)), undefined, (ms) => reported.push(ms));
    expect(await loop.stop(10)).toBe('idle');
    loop.start(1, 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(await loop.stop(20)).toBe('timeout');
    expect(reported).toEqual([20]);
    release();

    const quick = new PollLoop(async () => undefined, undefined, (ms) => reported.push(ms));
    quick.start(1, 0);
    await new Promise((r) => setTimeout(r, 10));
    expect(['idle', 'drained']).toContain(await quick.stop(1000));
    expect(reported).toEqual([20]);
  });
});

describe('ReadinessRegistry transition logging', () => {
  it('logs a failing check ONCE with its failure class, then its recovery once; never the error text', async () => {
    const lines: Array<[string, string]> = [];
    const registry = new ReadinessRegistry(50, (level, message) => lines.push([level, message]));
    let down = true;
    registry.register('database', async () => {
      if (down) throw Object.assign(new Error('connect ECONNREFUSED postgres://u:hunter2@h/db'), { code: 'ECONNREFUSED' });
    });
    registry.register('rabbitmq', () => new Promise(() => undefined)); // never answers
    for (let i = 0; i < 5; i++) expect((await registry.run()).failed).toEqual(['database', 'rabbitmq']); // five probes...
    expect(lines).toEqual([ // ...one line per check (the database fails at once, the silent broker check only at its timeout)
      ['warn', 'readiness_check_failed check=database error=Error code=ECONNREFUSED kind=network_unreachable — /ready answers 503 until it recovers'],
      ['warn', 'readiness_check_failed check=rabbitmq error=ReadinessCheckTimeout — /ready answers 503 until it recovers'],
    ]);
    down = false;
    await registry.run();
    await registry.run();
    expect(lines.slice(2)).toEqual([['info', 'readiness_check_recovered check=database']]);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  it('a check that is healthy from the start logs nothing', async () => {
    const lines: string[] = [];
    const registry = new ReadinessRegistry(50, (_l, m) => lines.push(m));
    registry.register('database', async () => undefined);
    await registry.run();
    await registry.run();
    expect(lines).toEqual([]);
  });
});

describe('shutdown notice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('marks the start of a graceful shutdown before workers drain, and its completion after', async () => {
    const order: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void order.push(String(m).split(' ')[0]!));
    @Injectable()
    class Worker implements BeforeApplicationShutdown {
      async beforeApplicationShutdown() {
        order.push('worker_drained');
      }
    }
    @Module({ providers: [Worker] })
    class WorkerModule {}
    const app = (await Test.createTestingModule({ imports: [HealthModule.forRoot(), WorkerModule] }).compile()).createNestApplication({ logger: false });
    await app.init();
    order.length = 0;
    await app.close();
    expect(order).toEqual(['service_shutdown_started', 'worker_drained', 'service_shutdown_complete']);
  });
});
