import type { Request } from 'express';

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

/**
 * Client IP and User-Agent are always SERVER-OBSERVED, never taken from the body. X-Forwarded-For
 * is honored only when TRUST_PROXY=true (the service sits behind a proxy the operator controls);
 * otherwise a client could set the header to dodge per-IP rate limits. Both are risk SIGNALS, not
 * proof of identity.
 */
export function clientInfo(req: Request, trustProxy: boolean): ClientInfo {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
  return {
    ip: fwd || req.socket?.remoteAddress || 'unknown',
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
  };
}
