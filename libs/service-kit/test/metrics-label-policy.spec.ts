import { describe, expect, it } from 'vitest';
import { LABEL_NAMES, OTHER, UNMATCHED, closedSet, isForbiddenLabelName, type LabelName } from '../src/index.js';
import { growingSet, lazyClosedSet } from '../src/metrics/label-policy.js';

describe('label names (V2 A12.2)', () => {
  it('the catalog holds only safe names', () => {
    for (const n of LABEL_NAMES) expect(isForbiddenLabelName(n)).toBe(false);
  });

  it('refuses names that could carry an identity, a secret or free text', () => {
    for (const n of ['userId', 'user_id', 'organizationId', 'org_id', 'membershipId', 'invoice_id', 'resourceId', 'requestId', 'correlation_id', 'email', 'phone',
      'ip', 'client_ip', 'user_agent', 'url', 'raw_path', 'path', 'query', 'token', 'ticket', 'header', 'message', 'error_message', 'sql', 'name', 'tenant', 'sessionId', 'traceId']) {
      expect(isForbiddenLabelName(n), n).toBe(true);
    }
  });

  it('a set cannot be built for a name outside the catalog', () => {
    expect(() => closedSet('userId' as LabelName, ['a'])).toThrow(/not a catalogued label name/);
    expect(() => growingSet('email' as LabelName, /^.+$/, 5)).toThrow(/not a catalogued label name/);
  });
});

describe('label values', () => {
  it('a closed set folds every value outside it into "other"', () => {
    const s = closedSet('outcome', ['ok', 'failed']);
    expect(s.resolve('ok')).toBe('ok');
    for (const hostile of ['0b6f2c1e-4a8e-4f57-9d55-3f0d6e3a1b22', 'a@b.example', 'Bearer x', 'x"} injected{a="b', '', undefined, 42, null, {}]) {
      expect(s.resolve(hostile)).toBe(OTHER);
    }
  });

  it('the reserved sentinels and malformed values cannot be declared', () => {
    expect(() => closedSet('outcome', ['other'])).toThrow(/reserved/);
    expect(() => closedSet('route', ['__unmatched__'])).toThrow(/reserved/);
    expect(() => closedSet('outcome', ['has space'])).toThrow(/malformed/);
    expect(() => closedSet('outcome', ['quote"'])).toThrow(/malformed/);
  });

  it('a lazy set is computed once, from code, and folds everything else (the route bound)', () => {
    let calls = 0;
    const s = lazyClosedSet('route', () => (calls++, ['/a/:id', 'bad value', '__unmatched__']), UNMATCHED);
    expect(calls).toBe(0);
    expect(s.resolve('/a/:id')).toBe('/a/:id');
    expect(s.resolve('/a/0b6f2c1e')).toBe(UNMATCHED);
    expect(s.resolve('bad value')).toBe(UNMATCHED);
    expect(calls).toBe(1);
  });

  it('a growing set admits only pattern-matching values, at most max of them', () => {
    const s = growingSet('check', /^[a-z][a-z0-9_-]{0,40}$/, 2);
    expect(s.resolve('database')).toBe('database');
    expect(s.resolve('Not-A-Check')).toBe(OTHER);
    expect(s.resolve('migrations')).toBe('migrations');
    expect(s.resolve('rabbitmq')).toBe(OTHER); // over the bound
    expect(s.resolve('database')).toBe('database'); // already admitted
    expect(() => growingSet('check', /./, 0)).toThrow(/bound/);
  });
});
