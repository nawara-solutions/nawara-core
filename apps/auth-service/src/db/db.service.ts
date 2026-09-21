import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface Queryable {
  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

/**
 * Thin PostgreSQL access layer. Every statement is parameterized (no string-built SQL with user
 * input). The schema of record is db/migrations/*.sql; this layer never alters it.
 * Deviation note: ADR-0003 names TypeORM; the schema relies on partial indexes, composite FKs and
 * triggers that entities cannot express, and security-critical operations need explicit
 * transactions, so the service talks to the schema directly.
 */
@Injectable()
export class DbService implements Queryable, OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly logger = new Logger(DbService.name);

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 10 });
    // An IDLE client that loses its connection (PostgreSQL restart or failover, an administrator's terminate, a proxy's idle timeout) is reported
    // on the POOL. `pg` discards that client itself and the next query opens a fresh connection, but an 'error' event with no listener is thrown
    // by Node as an uncaught exception and ends the process. Only the error code is logged: a message can carry connection details.
    this.pool.on('error', (e) => this.logger.warn(`db_pool_idle_client_error code=${pgCode(e) ?? 'unknown'} — the pool discards the client and reconnects on demand`));
  }

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.pool.query<R>(sql, params as any[]);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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

  onModuleDestroy() {
    return this.pool.end();
  }
}

/** PostgreSQL error inspection helpers. */
export const pgCode = (e: unknown): string | undefined => (e as { code?: string })?.code;
export const pgConstraint = (e: unknown): string | undefined => (e as { constraint?: string })?.constraint;
export const isUniqueViolation = (e: unknown, constraint?: string) =>
  pgCode(e) === '23505' && (!constraint || pgConstraint(e) === constraint);
