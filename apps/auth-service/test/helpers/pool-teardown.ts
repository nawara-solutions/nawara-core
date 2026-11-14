import type pg from 'pg';

/**
 * Test-harness teardown of a pool the harness owns, before its database is dropped `WITH (FORCE)`.
 *
 * `pool.end()` resolves as soon as the pool has forgotten its clients (pg-pool `_remove` drops each one from its list, then calls
 * `client.end()`), which is BEFORE each client's connection has ended. A forced drop issued in that window terminates a backend whose
 * client is still connected: PostgreSQL sends it `57P01`, the pool's idle listener re-emits it on the pool, and a pool without an `'error'`
 * listener turns it into an uncaught exception that fails an otherwise green run.
 *
 * pg-pool emits `'remove'` only from the `client.end()` callback, that is once the client's connection has ended. Waiting for one `'remove'`
 * per connected client therefore orders the drop after every connection the pool opened has closed: no sleep, no polling, and no error
 * listener (an unexpected error stays uncaught and fails the run). The wait is bounded; a timeout rejects and names the open clients.
 */
export interface TrackedPool {
  /** Clients the pool connected whose connection has not ended yet. */
  readonly open: () => number;
  /** `pool.end()`, then wait until every connected client's connection has ended; rejects after `timeoutMs`. */
  readonly end: (timeoutMs?: number) => Promise<void>;
}

export function trackPoolClients(pool: pg.Pool): TrackedPool {
  const open = new Set<unknown>();
  let settle: (() => void) | undefined;
  pool.on('connect', (client) => void open.add(client));
  pool.on('remove', (client) => {
    open.delete(client);
    if (open.size === 0) settle?.();
  });
  return {
    open: () => open.size,
    async end(timeoutMs = 10_000) {
      await pool.end();
      if (open.size === 0) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => (settle = resolve)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`test pool teardown: ${open.size} client connection(s) still open after ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        settle = undefined;
      }
    },
  };
}
