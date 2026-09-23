import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';

/** Default bound on the HTTP drain once shutdown starts (`HTTP_DRAIN_TIMEOUT_MS`, Stage 15.5). The same as the worker drain. */
export const DEFAULT_HTTP_DRAIN_TIMEOUT_MS = 5_000;
export const HTTP_DRAIN_TIMEOUT_BOUNDS = { min: 500, max: 120_000 } as const;
export const HTTP_DRAIN_OPTIONS = Symbol('HTTP_DRAIN_OPTIONS');

/** Set once, when the service starts shutting down. Read by readiness and by the admission middleware. */
@Injectable()
export class ShutdownState {
  draining = false;
}

/**
 * Stage 15.5 (F-A): the HTTP side of a graceful shutdown, owned by Core rather than by the clients.
 *
 * Nest closes the HTTP server only in `dispose()`, after every worker has drained, with `server.close()`: that stops new connections
 * but waits, without any bound, for the connections still open, and a keep-alive connection that is busy at that instant keeps
 * serving further requests (and `/ready` keeps answering 200) for as long as its client uses it. Here, when shutdown STARTS
 * (`onModuleDestroy`, which Nest runs before any `beforeApplicationShutdown`):
 *   1. the service is marked draining: `/ready` answers 503 and new requests are refused (see `shutdownAdmission`);
 *   2. the server stops accepting connections and closes the idle ones; requests already running continue, in parallel with the
 *      worker drains (the database pool and the broker close only later, in `onApplicationShutdown`);
 *   3. after `HTTP_DRAIN_TIMEOUT_MS`, every connection still open is closed (`closeAllConnections`), so no client can extend the drain.
 * Nest's own `dispose()` then finds the server closed and returns as soon as its last connection is gone.
 */
@Injectable()
export class HttpDrain implements OnModuleDestroy {
  private readonly logger = new Logger('Lifecycle');

  constructor(
    private readonly state: ShutdownState,
    private readonly adapterHost: HttpAdapterHost,
    @Inject(HTTP_DRAIN_OPTIONS) private readonly opts: { drainTimeoutMs: number },
  ) {}

  onModuleDestroy(): void {
    this.state.draining = true;
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server?.listening) return;
    server.close();
    server.closeIdleConnections();
    const deadline = setTimeout(() => {
      server.getConnections((_, open) => {
        if (open > 0) this.logger.warn(`http_drain_timeout drainTimeoutMs=${this.opts.drainTimeoutMs} openConnections=${open} — remaining connections closed`);
        server.closeAllConnections();
      });
    }, this.opts.drainTimeoutMs);
    server.once('close', () => clearTimeout(deadline));
  }
}

/**
 * Express middleware, installed first: once the service is draining, a request that arrives (on a connection opened before the
 * drain) is refused with 503 and `Connection: close`, so a keep-alive client moves on instead of feeding work to a closing process.
 * `/health` (liveness) is still answered: the process is alive until it exits.
 */
export function shutdownAdmission(state: ShutdownState) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!state.draining) return next();
    res.setHeader('Connection', 'close');
    if (req.path === '/health') return next();
    res.status(503).json({ statusCode: 503, message: 'The service is shutting down.', error: 'Service Unavailable', code: 'shutting_down' });
  };
}
