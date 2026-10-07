import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, assertNoPublishedServiceTokens, generateServiceToken, hashServiceToken, parseServiceTokens } from '../src/index.js';

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

describe('V2 A2.2 (OD-A2.2-1): assertNoPublishedServiceTokens, the callee side of published-token refusal', () => {
  /** The published development token of `.env.example`; read in the test, never printed. */
  const published = (() => {
    const line = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('BILLING_TO_PAYMENT_TOKEN='));
    return line!.slice('BILLING_TO_PAYMENT_TOKEN='.length).trim();
  })();
  const publishedDigest = hashServiceToken(published);

  it('production refuses a registered digest of a published development token, naming the caller only', () => {
    const entries = parseServiceTokens(`billing-service:${publishedDigest},other-service:${hashServiceToken('fresh-token-never-published-0123456789')}`);
    let error: unknown;
    try {
      assertNoPublishedServiceTokens(entries, { isProduction: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('SERVICE_TOKENS registers a published development token for caller "billing-service"; it is refused in production');
    expect((error as Error).message).not.toContain(publishedDigest);
    expect((error as Error).message).not.toContain(published);
  });

  it('development and tests keep the published token; unrelated digests pass everywhere', () => {
    expect(() => assertNoPublishedServiceTokens(parseServiceTokens(`billing-service:${publishedDigest}`), { isProduction: false })).not.toThrow();
    const fresh = parseServiceTokens(`a-caller:${generateServiceToken().digest},b-caller:${generateServiceToken().digest}`);
    expect(() => assertNoPublishedServiceTokens(fresh, { isProduction: true })).not.toThrow();
    expect(() => assertNoPublishedServiceTokens([], { isProduction: true })).not.toThrow();
  });
});
