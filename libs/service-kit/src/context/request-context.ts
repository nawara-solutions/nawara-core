import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { resolveLocale, type Locale } from '../i18n/locale.js';
import { INVALID_TOKEN, safeToken } from '../logging/safe-serialize.js';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

export interface RequestContext {
  /** Identifies this one request in this one service. */
  requestId: string;
  /** Follows a business operation across services and into event headers. */
  correlationId: string;
  /**
   * ADR-0054: the language of this request's error messages, negotiated from `Accept-Language` (`en` by default). Set by the HTTP
   * middleware only; a background job's context has none, and its errors (if any reach a filter) are English.
   */
  locale?: Locale;
}

const storage = new AsyncLocalStorage<RequestContext>();

// A client-supplied id is accepted only if it is short and made of safe characters: it ends up in logs and headers.
export const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Express middleware: establishes requestId/correlationId, echoes them on the response, and scopes them to the request, with the
 * negotiated error-message language (ADR-0054 D7; it never changes the ids and never rejects a request).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = headerValue(req.headers[REQUEST_ID_HEADER]);
  const inboundCorrelation = headerValue(req.headers[CORRELATION_ID_HEADER]);
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  const correlationId = inboundCorrelation && SAFE_ID.test(inboundCorrelation) ? inboundCorrelation : requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithRequestContext({ requestId, correlationId, locale: resolveLocale(req.headers['accept-language']) }, next);
}

/**
 * V2 A12.4: runs an event handler inside a log context restored from the event, as the Audit and Notification consumers already do:
 * `requestId` is `event:<id>` and `correlationId` the event's own header when it is a safe id, else the requestId. Untrusted values are
 * validated (`safeToken`), never echoed. A helper for explicit use in a consumer's handler: it changes nothing about delivery.
 */
export function runWithEventContext<T>(event: { id?: unknown; headers?: { correlationId?: unknown } } | undefined, fn: () => T): T {
  let id: unknown;
  let header: unknown;
  try {
    id = event?.id;
    header = event?.headers?.correlationId;
  } catch {
    // an unreadable event keeps the fallbacks below
  }
  const eventId = safeToken(id, SAFE_ID, 120);
  const requestId = eventId === INVALID_TOKEN ? 'event:unknown' : `event:${eventId}`;
  const correlation = safeToken(header, SAFE_ID, 128);
  return runWithRequestContext({ requestId, correlationId: correlation === INVALID_TOKEN ? requestId : correlation }, fn);
}

/** Headers to send on an outgoing call so the correlation id follows the operation. */
export function correlationHeaders(): Record<string, string> {
  const ctx = getRequestContext();
  return ctx ? { [REQUEST_ID_HEADER]: randomUUID(), [CORRELATION_ID_HEADER]: ctx.correlationId } : {};
}
