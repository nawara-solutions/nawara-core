import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface RequestContext {
  /** Identifies this one request in this one service. */
  requestId: string;
  /** Follows a business operation across services and into event headers. */
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

// A client-supplied id is accepted only if it is short and made of safe characters: it ends up in logs and headers.
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Express middleware: establishes requestId/correlationId, echoes them on the response, and scopes them to the request. */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = headerValue(req.headers[REQUEST_ID_HEADER]);
  const inboundCorrelation = headerValue(req.headers[CORRELATION_ID_HEADER]);
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  const correlationId = inboundCorrelation && SAFE_ID.test(inboundCorrelation) ? inboundCorrelation : requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithRequestContext({ requestId, correlationId }, next);
}

/** Headers to send on an outgoing call so the correlation id follows the operation. */
export function correlationHeaders(): Record<string, string> {
  const ctx = getRequestContext();
  return ctx ? { [REQUEST_ID_HEADER]: randomUUID(), [CORRELATION_ID_HEADER]: ctx.correlationId } : {};
}
