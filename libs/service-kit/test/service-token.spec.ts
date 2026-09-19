import { describe, expect, it } from 'vitest';
import { ConfigError, generateServiceToken, hashServiceToken, parseServiceTokens } from '../src/index.js';

describe('service tokens', () => {
  it('generates a random token whose digest is what the callee stores', () => {
    const a = generateServiceToken();
    const b = generateServiceToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashServiceToken(a.token)).toBe(a.digest);
    expect(a.digest).not.toContain(a.token);
  });

  it('parses caller:digest lists, allowing two tokens per caller for rotation', () => {
    const d1 = generateServiceToken().digest;
    const d2 = generateServiceToken().digest;
    const d3 = generateServiceToken().digest;
    expect(parseServiceTokens(undefined)).toEqual([]);
    expect(parseServiceTokens(`billing-service:${d1}, accounting-service:${d2}`)).toEqual([
      { caller: 'billing-service', digest: d1 },
      { caller: 'accounting-service', digest: d2 },
    ]);
    expect(parseServiceTokens(`billing-service:${d1},billing-service:${d2}`)).toHaveLength(2);
    expect(() => parseServiceTokens(`billing-service:${d1},billing-service:${d2},billing-service:${d3}`)).toThrow('at most 2');
  });

  it('rejects malformed entries and duplicates without echoing the input', () => {
    const d = generateServiceToken().digest;
    for (const bad of ['nocolon', ':abc', 'Billing:' + d, 'billing-service:short', `billing-service:${d.toUpperCase()}`, `billing-service:${d},other-service:${d}`]) {
      expect(() => parseServiceTokens(bad), bad).toThrow(ConfigError);
    }
    try {
      parseServiceTokens('billing-service:not-a-digest-SECRETLOOKING');
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRETLOOKING');
    }
  });
});
