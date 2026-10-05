import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeFailure } from '../logging/failure.js';
import type { BoundedMetrics } from './metrics.js';

export type MetricsLog = (level: 'warn' | 'error', message: string) => void;

const CLOSE_BOUND_MS = 1_000;

/**
 * V2 A12.2: the metrics listener, separate from the application server. It answers `GET /metrics` and nothing else (404 for another
 * path, 405 for another method), so `/metrics` can never become an application route (and never one under a routed prefix such as
 * `/auth`). It is independent of the application's shutdown admission and HTTP drain, so it keeps answering while the service drains.
 *
 * It never keeps the process alive (`unref`), and a listen failure (an occupied port) is logged by its class and code only and leaves
 * the service running without its metrics endpoint: observability never takes availability away. Prometheus sees the target down.
 */
export class MetricsServer {
  private readonly server: Server;
  private listening = false;

  constructor(
    private readonly metrics: BoundedMetrics,
    private readonly log: MetricsLog,
  ) {
    this.server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/metrics') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }).end('method not allowed\n');
        return;
      }
      this.metrics.render().then(
        ({ contentType, body }) => {
          res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : body);
        },
        (e: unknown) => {
          this.log('warn', `metrics_render_failed ${describeFailure(e)}`);
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('metrics unavailable\n');
        },
      );
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 10_000;
    this.server.unref();
  }

  /** Binds; resolves either way. Returns the bound address, or undefined when the listener could not start (already logged). */
  start(host: string, port: number): Promise<AddressInfo | undefined> {
    return new Promise((resolve) => {
      const onError = (e: unknown) => {
        this.log('error', `metrics_listener_failed ${describeFailure(e)} — the service runs without its metrics endpoint`);
        resolve(undefined);
      };
      this.server.once('error', onError);
      this.server.listen({ host, port }, () => {
        this.server.off('error', onError);
        this.server.on('error', (e) => this.log('warn', `metrics_listener_error ${describeFailure(e)}`));
        this.listening = true;
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  /** Stops accepting, then closes every open connection within a short bound. Idempotent. */
  async close(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    await new Promise<void>((resolve) => {
      const bound = setTimeout(() => {
        this.server.closeAllConnections();
        resolve();
      }, CLOSE_BOUND_MS);
      bound.unref();
      this.server.close(() => {
        clearTimeout(bound);
        resolve();
      });
      this.server.closeIdleConnections();
    });
  }
}
