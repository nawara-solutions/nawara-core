import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { ReadinessRegistry, listMigrationFiles, pendingOf } from '@nawara/service-kit';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AUTH_MIGRATIONS_DIR, AUTH_MIGRATION_OPTIONS } from './migrations.js';

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
export class DbService implements Queryable, OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool;
  private readonly logger = new Logger(DbService.name);

  constructor(
    @Inject(APP_CONFIG) cfg: AppConfig,
    @Optional() @Inject(ReadinessRegistry) private readonly readiness?: ReadinessRegistry,
  ) {
    this.pool = new pg.Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.db.poolMax,
      // Stage 14.4 (same semantics as the service-kit's DbService): one bound on getting a pooled client or opening a connection;
      // PostgreSQL itself cancels a statement past statement_timeout (57014) and ends a session idle inside a transaction past
      // idle_in_transaction_session_timeout (25P03), releasing its locks.
      connectionTimeoutMillis: cfg.db.connectionTimeoutMs,
      statement_timeout: cfg.db.statementTimeoutMs,
      idle_in_transaction_session_timeout: cfg.db.idleInTransactionTimeoutMs,
    });
    // An IDLE client that loses its connection (PostgreSQL restart or failover, an administrator's terminate, a proxy's idle timeout) is reported
    // on the POOL. `pg` discards that client itself and the next query opens a fresh connection, but an 'error' event with no listener is thrown
    // by Node as an uncaught exception and ends the process. Only the error code is logged: a message can carry connection details.
    this.pool.on('error', (e) => this.logger.warn(`db_pool_idle_client_error code=${pgCode(e) ?? 'unknown'} — the pool discards the client and reconnects on demand`));
  }

  /** Stage 13.2: the one dependency GET /ready actually needs. Cheap (a single SELECT), never on the request hot path. */
  onModuleInit(): void {
    this.readiness?.register('database', async () => {
      await this.pool.query('SELECT 1');
    });
    // Stage 14.5: not ready while a migration this release ships is unapplied. The file list is read ONCE here (no per-request
    // filesystem work); each /ready only reads the bookkeeping table. Readiness observes migration state, it never migrates.
    let expected: string[] | undefined;
    try {
      expected = listMigrationFiles([AUTH_MIGRATIONS_DIR], AUTH_MIGRATION_OPTIONS).map((f) => f.name);
    } catch (e) {
      this.logger.error(`db_migrations_unreadable error=${e instanceof Error ? e.name : 'unknown'} — /ready reports migrations until fixed`);
    }
    this.readiness?.register('migrations', async () => {
      if (!expected) throw new Error('migration files unreadable');
      if ((await pendingOf(this, expected)).length > 0) throw new Error('pending migrations');
    });
  }

  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]) {
    return this.pool.query<R>(sql, params as any[]);
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // While a client is checked out `pg-pool` removes its own error listener. If PostgreSQL terminates the session meanwhile
    // (idle-in-transaction timeout, administrator, failover), the client emits 'error' and, with no listener, Node would crash the
    // process. Record it instead: the transaction's next statement fails, it rolls back, and the broken client is destroyed.
    let broken: Error | undefined;
    const onError = (e: Error) => {
      broken = e;
    };
    client.on('error', onError);
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.removeListener('error', onError);
      client.release(broken); // an error destroys the client instead of returning it to the pool
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
