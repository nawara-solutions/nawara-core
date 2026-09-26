import { describe, expect, it } from 'vitest';
import { clientAddress, normalize } from './client-address.js';

const req = (peer: string, xff?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;

describe('the rate-limit client address (Stage 20.6): no client can choose its bucket', () => {
  it('TRUST_PROXY off: the peer only; every forwarding header is ignored', () => {
    expect(clientAddress(req('198.51.100.7', '203.0.113.1'), false)).toBe('198.51.100.7');
  });

  it('TRUST_PROXY on: the RIGHTMOST X-Forwarded-For hop (appended by our proxy), never the client-written leftmost one', () => {
    expect(clientAddress(req('10.0.0.2', '203.0.113.9'), true)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '1.2.3.4, 5.6.7.8, 203.0.113.9'), true)).toBe('203.0.113.9'); // spoofed prefixes change nothing
    expect(clientAddress(req('10.0.0.2', ['1.2.3.4', '203.0.113.9']), true)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '203.0.113.9:4431'), true)).toBe('203.0.113.9');
    expect(clientAddress(req('10.0.0.2', '[2001:db8:1:2::5]:443'), true)).toBe('2001:db8:1:2::/64');
  });

  it('TRUST_PROXY on, but no usable header: the peer (garbage, empty, oversized)', () => {
    for (const bad of [undefined, '', ' , ', 'not-an-ip', 'x'.repeat(3000), '1.2.3.4, not-an-ip']) expect(clientAddress(req('10.0.0.2', bad), true)).toBe('10.0.0.2');
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
