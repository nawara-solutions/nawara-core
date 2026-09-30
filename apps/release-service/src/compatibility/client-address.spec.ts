import { describe, expect, it } from 'vitest';
import { clientAddress, normalize } from './client-address.js';

const req = (peer: string, xff?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;

describe('the rate-limit client address (Stage 20.6): no client can choose its bucket', () => {
  it('TRUST_PROXY_HOPS=0: the peer only; every forwarding header is ignored', () => {
    expect(clientAddress(req('198.51.100.7', '203.0.113.1'), 0)).toBe('198.51.100.7');
  });

  it('TRUST_PROXY_HOPS=1: the RIGHTMOST X-Forwarded-For hop (appended by our proxy), never the client-written leftmost one', () => {
    expect(clientAddress(req('10.0.0.2', '203.0.113.9'), 1)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '1.2.3.4, 5.6.7.8, 203.0.113.9'), 1)).toBe('203.0.113.9'); // spoofed prefixes change nothing
    expect(clientAddress(req('10.0.0.2', ['1.2.3.4', '203.0.113.9']), 1)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '203.0.113.9:4431'), 1)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '[2001:db8:1:2::5]:443'), 1)).toBe('2001:db8:1:2::/64');
  });

  it('TRUST_PROXY_HOPS=1, but no usable header: the peer (garbage, empty, oversized)', () => {
    for (const bad of [undefined, '', ' , ', 'not-an-ip', 'x'.repeat(3000), '1.2.3.4, not-an-ip']) expect(clientAddress(req('10.0.0.2', bad), 1)).toBe('10.0.0.2');
  });

  it('TRUST_PROXY_HOPS=2 (Stage 22 F3): the entry our OUTER proxy appended; client-written entries left of it never count', () => {
    expect(clientAddress(req('10.0.0.2', '1.2.3.4, 203.0.113.9, 198.51.100.1'), 2)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '9.9.9.9, 1.2.3.4, 203.0.113.9, 198.51.100.1'), 2)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '203.0.113.9'), 2)).toBe('203.0.113.9'); // a shorter chain: its leftmost entry, appended by a trusted proxy
  });

  it('normalization: IPv4-mapped IPv6 is the IPv4 address; IPv6 counts by /64 (rotating host bits does not multiply the budget)', () => {
    expect(normalize('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalize('2001:db8:aaaa:bbbb:1::1')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(normalize('2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(normalize('2001:0db8:0000:0001::9')).toBe('2001:db8:0:1::/64');
    expect(normalize('::1')).toBe('0:0:0:0::/64');
    expect(normalize('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(normalize('198.51.100.7')).toBe('198.51.100.7');
  });
});
