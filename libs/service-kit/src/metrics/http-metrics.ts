import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { UNMATCHED, closedSet, lazyClosedSet } from './label-policy.js';
import type { BoundedMetrics } from './metrics.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export const HTTP_STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'aborted'] as const;
/** Request duration buckets (seconds): API calls up to whole file transfers. */
export const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
/** Probe routes, matched by TEMPLATE: polled every few seconds, they would dominate rates and latency. Readiness has its own metrics. */
export const PROBE_ROUTES: ReadonlySet<string> = new Set(['/health', '/ready', '/auth/health']);

const statusClass = (code: number): string => (code >= 100 && code < 600 ? `${Math.floor(code / 100)}xx` : 'aborted');

/**
 * V2 A12.2: HTTP server metrics. The `route` label is the template Express matched (`req.baseUrl + req.route.path`, read when the
 * response finishes; proven for normal answers, guard and pipe refusals, thrown errors and tokenized paths by the route-template spike),
 * bounded by the templates the router declares; a request no route matched is `__unmatched__`. The request target (`req.url`,
 * `req.path`, the query) is never read, so no identifier, token or address can become a label.
 *
 * `routeTemplates` lists the router's declared templates; it is read once, at the first finished request (after initialisation).
 * The in-flight gauge counts every request on the application port, probes included (their route is known only once matched).
 */
export function httpMetricsMiddleware(metrics: BoundedMetrics, routeTemplates: () => readonly string[]): RequestHandler {
  const labels = [
    closedSet('method', HTTP_METHODS),
    lazyClosedSet('route', routeTemplates, UNMATCHED),
    closedSet('status_class', HTTP_STATUS_CLASSES),
  ];
  const requests = metrics.counter({ name: 'nawara_http_server_requests_total', help: 'HTTP requests answered, by method, route template and status class.', labels, maxSeries: 2000 });
  const duration = metrics.histogram({
    name: 'nawara_http_server_request_duration_seconds',
    help: 'HTTP request duration, from the first middleware to the response finishing or the connection closing.',
    labels,
    buckets: HTTP_DURATION_BUCKETS,
    maxSeries: 2000,
  });
  const inFlight = metrics.gauge({ name: 'nawara_http_server_requests_in_flight', help: 'HTTP requests currently being handled.' });

  // Named, so the middleware's position in the Express stack is assertable (A12.2a).
  return function httpMetrics(req: Request, res: Response, next: NextFunction) {
    const started = performance.now();
    let done = false;
    inFlight.inc();
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      inFlight.dec();
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : UNMATCHED;
      if (PROBE_ROUTES.has(route)) return;
      const l = { method: req.method, route, status_class: aborted ? 'aborted' : statusClass(res.statusCode) };
      requests.inc(l);
      duration.observe(l, (performance.now() - started) / 1000);
    };
    res.once('finish', () => finish(false));
    res.once('close', () => finish(!res.writableFinished));
    next();
  };
}

/** The route templates an Express 5 application declares (its router's route layers). */
export function expressRouteTemplates(expressApp: unknown): readonly string[] {
  const stack = (expressApp as { router?: { stack?: Array<{ route?: { path?: unknown } }> } } | undefined)?.router?.stack ?? [];
  return stack.map((layer) => layer.route?.path).filter((p): p is string => typeof p === 'string');
}
