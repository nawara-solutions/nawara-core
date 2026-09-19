import { Inject, Injectable, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { pendingMigrations } from './migrations.js';

/** Anything that can run a parameterized statement: the pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface DbOptions {
  /** Runtime connection string. Should be a least-privilege role (DML only), never a superuser (ADR-0032). */
  url: string;
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  /** When set, `/ready` fails while any of these migration directories has an unapplied file. */
  migrations?: { dirs: string[] };
}

export const DB_OPTIONS = Symbol('DB_OPTIONS');

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * PostgreSQL access for one service's OWN database. Every statement is parameterized. The schema is changed only by the
 * explicit migration step, never by this layer and never at startup.
 */
@Injectable()
export class DbService implements Queryable, OnModuleInit, OnApplicationShutdown {
  private readonly pool: pg.Pool;

  constructor(
    @Inject(DB_OPTIONS) private readonly options: DbOptions,
    @Optional() @Inject(ReadinessRegistry) private readonly readiness?: ReadinessRegistry,
  ) {
    this.pool = new pg.Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      application_name: options.applicationName,
    });
    // An idle client erroring (server restart) must not crash the process; the next query reconnects.
    this.pool.on('error', () => undefined);
  }

  onModuleInit(): void {
    this.readiness?.register('database', () => this.ping());
    const dirs = this.options.migrations?.dirs;
    if (dirs) {
      this.readiness?.register('migrations', async () => {
        if ((await pendingMigrations(this, dirs)).length > 0) throw new Error('pending migrations');
      });
    }
  }

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.pool.query<R>(sql, params as any[]);
  }

  /** Runs `fn` in one transaction: commit on success, rollback on any error. Business change and outbox event go here together. */
  async tx<T>(fn: (q: Queryable) => Promise<T>, isolation: IsolationLevel = 'READ COMMITTED'): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Graceful shutdown: waits for checked-out clients to be released, then closes the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

export const pgCode = (e: unknown): string | undefined => (e as { code?: string })?.code;
export const pgConstraint = (e: unknown): string | undefined => (e as { constraint?: string })?.constraint;
export const isUniqueViolation = (e: unknown, constraint?: string) => pgCode(e) === '23505' && (!constraint || pgConstraint(e) === constraint);
