import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { DB_QUERY_TIMEOUT_MARGIN_MS } from '../config/base-config.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { describeFailure } from '../logging/failure.js';
import { pendingMigrations } from './migrations.js';

/** Anything that can run a parameterized statement: the pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface DbOptions {
  /** Runtime connection string. Should be a least-privilege role (DML only), never a superuser (ADR-0032). */
  url: string;
  /** Pool size (default 10). */
  max?: number;
  /** Server-enforced `statement_timeout` for every session (default 30 s): PostgreSQL cancels a longer statement (SQLSTATE 57014). */
  statementTimeoutMs?: number;
  /**
   * `pg-pool`'s `connectionTimeoutMillis` (default 5 s). ONE bound for two waits: getting a client from an exhausted pool, and
   * establishing a new connection. Past it the caller gets an error instead of waiting forever.
   */
  connectionTimeoutMs?: number;
  /**
   * Server-enforced `idle_in_transaction_session_timeout` (default 60 s): a session left idle inside an open transaction is
   * terminated by PostgreSQL (SQLSTATE 25P03), which releases its locks. `tx()` absorbs that termination (see there).
   */
  idleInTransactionTimeoutMs?: number;
  /**
   * Client-side deadline for one query's answer, `pg`'s `query_timeout` (default: the statement timeout + 5 s). It ends the wait when
   * the server or the network goes silent after accepting a query (Stage 15.2, I9), which the server-side `statement_timeout` cannot.
   * It does NOT cancel anything on the server: the connection is destroyed instead (see `tx()`), which ends the session there.
   */
  queryTimeoutMs?: number;
  applicationName?: string;
  /** When set, `/ready` fails while any of these migration directories has an unapplied file. */
  migrations?: { dirs: string[] };
}

export const DB_OPTIONS = Symbol('DB_OPTIONS');

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/** `pg`'s client-side `query_timeout` error (no code; the text is pinned by a test against the installed `pg`). */
export const isQueryTimeout = (e: unknown): boolean => e instanceof Error && e.message === 'Query read timeout';

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
    const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;
    this.pool = new pg.Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      statement_timeout: statementTimeoutMs,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
      // Direct construction is bounded too: the same derived default as the configuration.
      query_timeout: options.queryTimeoutMs ?? statementTimeoutMs + DB_QUERY_TIMEOUT_MARGIN_MS,
      application_name: options.applicationName,
    });
    // An idle client erroring (server restart, failover, terminated session) must not crash the process; the next query reconnects.
    // Stage 14.7: reported (class and code only: a message can carry connection details), as auth-service already did.
    const logger = new Logger('DbService');
    this.pool.on('error', (e) => logger.warn(`db_pool_idle_client_error ${describeFailure(e)} — the pool discards the client and reconnects on demand`));
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
    // While a client is checked out `pg-pool` removes its own error listener. If PostgreSQL terminates the session meanwhile
    // (idle-in-transaction timeout, administrator, failover), the client emits 'error' and, with no listener, Node would crash the
    // process. Record it instead: the transaction's next statement fails, it rolls back, and the broken client is destroyed.
    let broken: Error | undefined;
    const onError = (e: Error) => {
      broken = e;
    };
    client.on('error', onError);
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      // A client-side query timeout leaves the connection mid-protocol: the silent statement is still in flight and a ROLLBACK would only
      // queue behind it (and be dropped when it times out too). Such a client must NEVER return to the pool: the next borrower would run
      // inside this still-open transaction and its COMMIT would commit this one's writes (reproduced in Stage 15.2). It is destroyed;
      // closing the connection ends the session, and PostgreSQL rolls back the uncommitted transaction.
      if (isQueryTimeout(e)) broken ??= e as Error;
      else {
        await client.query('ROLLBACK').catch((r: unknown) => {
          if (isQueryTimeout(r)) broken ??= r as Error;
        });
      }
      throw e;
    } finally {
      client.removeListener('error', onError);
      client.release(broken); // an error destroys the client instead of returning it to the pool
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
