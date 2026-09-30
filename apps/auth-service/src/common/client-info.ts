import type { Request } from 'express';
import { clientAddress } from '@nawara/service-kit';

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

/**
 * Client IP and User-Agent are always SERVER-OBSERVED, never taken from the body. The IP is the kit's trusted client address
 * (Stage 22 F3): the TCP peer, or with `TRUST_PROXY_HOPS=n` the `X-Forwarded-For` entry our own n-th proxy appended, read from the
 * right, so a client-written entry can never choose a rate-limit bucket or the audited address. Both are risk SIGNALS, not proof of
 * identity.
 */
export function clientInfo(req: Request, trustProxyHops: number): ClientInfo {
  return {
    ip: clientAddress(req, trustProxyHops),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
  };
}
