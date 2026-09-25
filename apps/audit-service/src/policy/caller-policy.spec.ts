import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { AUDIT_OPERATIONS, AuditCallerPolicy } from './caller-policy.js';
import { AUDIT_CATEGORIES } from './categories.js';

const parse = (callers: unknown, registered: string[] = Object.keys(callers as object)) => AuditCallerPolicy.parse(JSON.stringify({ callers }), registered);
const product = { operations: ['read_organization'], categories: ['business', 'commercial'], sourceServices: ['billing-service', 'payment-service'] };
const admin = { operations: ['read_organization', 'read_platform'], categories: ['security', 'business', 'commercial', 'administrative'] };

describe('AUDIT_SERVICE_POLICY', () => {
  it('parses an explicit policy per caller: operations, categories and optional source services', () => {
    const p = parse({ 'core-drive': product, 'core-admin': admin });
    expect(p.of('core-drive')).toEqual({ operations: new Set(['read_organization']), categories: new Set(['business', 'commercial']), sourceServices: new Set(['billing-service', 'payment-service']) });
    expect(p.of('core-admin')).toEqual({ operations: new Set(AUDIT_OPERATIONS), categories: new Set(AUDIT_CATEGORIES), sourceServices: undefined });
  });

  it('deny by default: an unknown caller and an operation not granted are refused; no policy and no caller allows nothing', () => {
    const p = parse({ 'core-drive': product });
    expect(p.allows('core-drive', 'read_organization')).toBe(true);
    expect(p.allows('core-drive', 'read_platform')).toBe(false); // organization scope never implies platform scope
    expect(p.allows('someone-else', 'read_organization')).toBe(false);
    expect(p.allows('core-drive', 'write' as never)).toBe(false); // an operation name the policy does not know
    expect(p.of('someone-else')).toBeUndefined();
    expect(AuditCallerPolicy.parse(undefined, []).allows('anyone', 'read_organization')).toBe(false);
    expect(AuditCallerPolicy.parse('  ', []).allows('anyone', 'read_platform')).toBe(false);
  });

  it('every registered caller needs an entry, and an entry needs a registered caller', () => {
    expect(() => AuditCallerPolicy.parse(undefined, ['core-drive'])).toThrow(/required/);
    expect(() => parse({ 'core-drive': product }, ['core-drive', 'core-billing'])).toThrow(/"core-billing" has no AUDIT_SERVICE_POLICY entry/);
    expect(() => parse({ 'core-drive': product }, [])).toThrow(/no registered service token/);
  });

  it.each([
    ['not JSON', '{callers'],
    ['a wrong top level', JSON.stringify({ policies: {} })],
    ['an extra top-level key', JSON.stringify({ callers: {}, other: 1 })],
    ['callers as a list', JSON.stringify({ callers: [] })],
    ['a non-object entry', JSON.stringify({ callers: { a: [] } })],
    ['an unknown property (an organization list)', JSON.stringify({ callers: { a: { ...product, organizations: ['x'] } } })],
    ['no operations', JSON.stringify({ callers: { a: { operations: [], categories: ['business'] } } })],
    ['an unknown operation', JSON.stringify({ callers: { a: { operations: ['read_organization', 'ingest'], categories: ['business'] } } })],
    ['a write operation', JSON.stringify({ callers: { a: { operations: ['delete'], categories: ['business'] } } })],
    ['a wildcard operation', JSON.stringify({ callers: { a: { operations: ['*'], categories: ['business'] } } })],
    ['a repeated operation', JSON.stringify({ callers: { a: { operations: ['read_platform', 'read_platform'], categories: ['business'] } } })],
    ['no categories', JSON.stringify({ callers: { a: { operations: ['read_organization'] } } })],
    ['empty categories', JSON.stringify({ callers: { a: { operations: ['read_organization'], categories: [] } } })],
    ['an unknown category', JSON.stringify({ callers: { a: { operations: ['read_organization'], categories: ['severity'] } } })],
    ['a wildcard category', JSON.stringify({ callers: { a: { operations: ['read_organization'], categories: ['*'] } } })],
    ['a repeated category', JSON.stringify({ callers: { a: { operations: ['read_organization'], categories: ['business', 'business'] } } })],
    ['empty source services', JSON.stringify({ callers: { a: { ...product, sourceServices: [] } } })],
    ['a wildcard source service', JSON.stringify({ callers: { a: { ...product, sourceServices: ['*'] } } })],
    ['a source service outside the service grammar', JSON.stringify({ callers: { a: { ...product, sourceServices: ['Billing Service'] } } })],
    ['a repeated source service', JSON.stringify({ callers: { a: { ...product, sourceServices: ['billing-service', 'billing-service'] } } })],
  ])('refuses %s at startup', (_label, raw) => {
    expect(() => AuditCallerPolicy.parse(raw, ['a'])).toThrow(ConfigError);
  });

  it('the vocabularies are exactly the ones Stage 18.1 froze (A40 operations, A52 categories)', () => {
    expect([...AUDIT_OPERATIONS]).toEqual(['read_organization', 'read_platform']);
    expect([...AUDIT_CATEGORIES]).toEqual(['security', 'business', 'commercial', 'administrative']);
  });
});
