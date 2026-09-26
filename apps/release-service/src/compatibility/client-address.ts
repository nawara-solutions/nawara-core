import { isIP } from 'node:net';
import type { Request } from 'express';

/**
 * Stage 20.6: the address the public rate limit is keyed by. It is chosen so that NO CLIENT CAN PICK ITS OWN BUCKET:
 *
 * - `TRUST_PROXY` off (the default): the TCP peer address. Forwarding headers are ignored entirely.
 * - `TRUST_PROXY` on: the kit sets Express `trust proxy: true`, where `req.ip` is the LEFTMOST `X-Forwarded-For` entry, a value the client
 *   writes itself (a spoofed `X-Forwarded-For: 1.2.3.4` would select any bucket). This function instead takes the RIGHTMOST entry: the
 *   address our nearest proxy appended, which a client cannot forge. Behind one ingress hop that is the real client; behind a longer chain
 *   (a CDN in front of the ingress) it is the next proxy's address, so clients share a stricter bucket — never a looser one. The real
 *   production chain is a 21.x prerequisite, not guessed here.
 *
 * Normalization so a client cannot multiply its budget: an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as the IPv4 address, and
 * an IPv6 address counts by its /64 prefix (one host normally holds a whole /64). Anything unparsable falls back to the peer address.
 */
export function clientAddress(req: Pick<Request, 'headers' | 'socket'>, trustProxy: boolean): string {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  if (!trustProxy) return normalize(peer);
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || raw.length > 2048) return normalize(peer);
  const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const nearest = hops.at(-1);
  return nearest && isIP(stripPort(nearest)) ? normalize(stripPort(nearest)) : normalize(peer);
}

function stripPort(v: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v); // [2001:db8::1]:443
  if (bracketed) return bracketed[1]!;
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v); // 192.0.2.1:443
  return v4port ? v4port[1]! : v;
}

/** IPv4-mapped IPv6 → IPv4; IPv6 → its /64 prefix; IPv4 unchanged; anything else unchanged (it is only ever hashed). */
export function normalize(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  return `${expandV6(address).slice(0, 4).join(':')}::/64`;
}

function expandV6(a: string): string[] {
  const noZone = a.split('%')[0]!.toLowerCase();
  const [head, tail] = noZone.includes('::') ? noZone.split('::') as [string, string] : [noZone, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => (g === '' ? '0' : g).replace(/^0+(?=.)/, ''));
}
