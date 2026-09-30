import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Stage 22 F3: the one Core rule for the client address a service may use for a security decision (rate limits, abuse controls,
 * audit attribution). No client can choose it.
 *
 * `hops` is `TRUST_PROXY_HOPS`: how many reverse proxies in front of the service each append the address they received the request
 * from to `X-Forwarded-For`. The chain is read from the RIGHT, the side our own proxies write, exactly as Express reads it with a
 * numeric `trust proxy` (which `configureApp` sets from the same value):
 *
 *   - `0`: the TCP peer. Forwarding headers are ignored entirely.
 *   - `n`: the entry `n` positions from the right (the one the outermost trusted proxy appended). Entries further left were written
 *     by the client, or by proxies we do not control, and are never used. A chain shorter than `n` yields its leftmost entry, which
 *     a trusted proxy appended.
 *   - An unusable result (not an IP address, an oversized header) falls back to the peer: the nearest trusted proxy, a shared bucket
 *     rather than a client-chosen one.
 *
 * Over-counting `hops` lets a client-written entry be trusted (spoofable); under-counting resolves to a trusted proxy's address (a
 * shared bucket, never spoofable). Set it from the documented production topology, never by guessing.
 */
export function clientAddress(req: Pick<Request, 'headers' | 'socket'>, hops: number): string {
  const peer = normalizeAddress(req.socket?.remoteAddress ?? 'unknown');
  if (hops <= 0) return peer;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || raw.length > 2048) return peer;
  const chain = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return peer;
  const chosen = stripPort(chain[Math.max(0, chain.length - hops)]!);
  return isIP(chosen) ? normalizeAddress(chosen) : peer;
}

/**
 * The same address as a rate-limit identity: an IPv6 address counts by its /64 prefix (one host normally holds a whole /64, so rotating
 * the host bits must not multiply its budget). IPv4 is unchanged.
 */
export function rateLimitClientAddress(req: Pick<Request, 'headers' | 'socket'>, hops: number): string {
  return rateLimitIdentity(clientAddress(req, hops));
}

/** IPv4-mapped IPv6 (`::ffff:192.0.2.1`) → the IPv4 address; anything else unchanged. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

/** IPv4-mapped IPv6 → IPv4; IPv6 → its /64 prefix; IPv4 unchanged; anything else unchanged (it is only ever hashed). */
export function rateLimitIdentity(address: string): string {
  const v4 = normalizeAddress(address);
  if (isIP(v4) !== 6) return v4;
  return `${expandV6(v4).slice(0, 4).join(':')}::/64`;
}

function stripPort(v: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v); // [2001:db8::1]:443
  if (bracketed) return bracketed[1]!;
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v); // 192.0.2.1:443
  return v4port ? v4port[1]! : v;
}

function expandV6(a: string): string[] {
  const noZone = a.split('%')[0]!.toLowerCase();
  const [head, tail] = noZone.includes('::') ? noZone.split('::') as [string, string] : [noZone, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => (g === '' ? '0' : g).replace(/^0+(?=.)/, ''));
}
