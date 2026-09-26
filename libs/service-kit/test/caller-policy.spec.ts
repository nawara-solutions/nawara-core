import type { ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import {
  CallerPolicyMap, ConfigError, NO_SERVICE_OPERATION, ServiceOperationGuard, generateServiceToken, operationsPolicy, parseCallerPolicy,
  parseJsonStrict, policyChoice, policyList, registeredCallers, type CallerPolicySpec,
} from '../src/index.js';

/** A service-shaped spec: a closed operation vocabulary plus one optional-empty list, exactly as Payment and Billing use it. */
const OPS = ['thing.create', 'thing.read'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const spec: CallerPolicySpec<{ operations: ReadonlySet<string>; scopes: ReadonlySet<string> }> = {
  variable: 'THING_SERVICE_POLICY',
  keys: ['operations', 'scopes'],
  entry: (at, e) => ({
    operations: policyList(`${at}.operations`, e.operations, { allowed: OPS }),
    scopes: policyList(`${at}.scopes`, e.scopes, { pattern: UUID, allowEmpty: true }),
  }),
};
const P1 = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
const doc = (callers: unknown) => JSON.stringify({ callers });
const parse = (raw: string | undefined, registered: string[] = ['billing-service']) => parseCallerPolicy(raw, registered, spec);
const refused = (fn: () => unknown, rule: RegExp) => {
  expect(fn).toThrow(ConfigError);
  expect(fn).toThrow(rule);
};

describe('parseCallerPolicy: deny by default', () => {
  it('no policy and no registered caller: an empty policy (nothing may call)', () => {
    const p = parse(undefined, []);
    expect(p.size).toBe(0);
    expect(parse('   ', []).size).toBe(0);
  });

  it('no policy while callers are registered: refused, naming the callers', () => {
    refused(() => parse(undefined), /THING_SERVICE_POLICY is required.*"billing-service"/);
    refused(() => parse(''), /is required/);
  });

  it('an empty callers object while a caller is registered: that caller has no entry, refused', () => {
    refused(() => parse(doc({})), /registered caller "billing-service" has no THING_SERVICE_POLICY entry/);
  });

  it('an empty callers object with no registered caller is a valid, empty policy', () => {
    expect(parse(doc({}), []).size).toBe(0);
  });

  it('a policy entry for a caller with no registered token: refused', () => {
    refused(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [] }, 'ghost-service': { operations: ['thing.read'], scopes: [] } })), /names "ghost-service", which has no registered service token/);
  });

  it('malformed JSON, a non-object, or an envelope with anything else: refused', () => {
    refused(() => parse('{"callers": '), /must be valid JSON/);
    refused(() => parse('[]'), /must be \{"callers": \{\.\.\.\}\} and nothing else/);
    refused(() => parse('{"callers": []}'), /and nothing else/);
    refused(() => parse(JSON.stringify({ callers: {}, extra: 1 }), []), /and nothing else/);
    refused(() => parse(JSON.stringify({ policy: {} }), []), /and nothing else/);
  });

  it('a duplicate caller key is refused (JSON.parse would silently keep the last entry)', () => {
    const raw = '{"callers":{"billing-service":{"operations":["thing.read"],"scopes":[]},"billing-service":{"operations":["thing.create","thing.read"],"scopes":[]}}}';
    refused(() => parse(raw), /must not repeat a key/);
  });

  it('a duplicate nested key is refused too', () => {
    refused(() => parse('{"callers":{"billing-service":{"operations":["thing.read"],"operations":["thing.create"],"scopes":[]}}}'), /must not repeat a key/);
  });

  it('an unknown entry property is refused', () => {
    refused(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [], admin: true } })), /unknown property \(allowed: operations, scopes\)/);
  });

  it('an entry that is not an object is refused', () => {
    refused(() => parse(doc({ 'billing-service': ['thing.read'] })), /must be an object/);
    refused(() => parse(doc({ 'billing-service': null })), /must be an object/);
  });

  it('an empty operation list is refused (a credential that authorizes nothing is not expressible)', () => {
    refused(() => parse(doc({ 'billing-service': { operations: [], scopes: [] } })), /operations must be an explicit, non-empty list/);
  });

  it('a missing operation list is refused', () => {
    refused(() => parse(doc({ 'billing-service': { scopes: [] } })), /operations must be an explicit list/);
  });

  it('an unknown operation, a wildcard, or a non-string is refused', () => {
    refused(() => parse(doc({ 'billing-service': { operations: ['thing.delete'], scopes: [] } })), /lists a value other than thing.create \/ thing.read/);
    refused(() => parse(doc({ 'billing-service': { operations: ['*'], scopes: [] } })), /lists a value other than/);
    refused(() => parse(doc({ 'billing-service': { operations: [1], scopes: [] } })), /not a string/);
  });

  it('a duplicate list value is refused', () => {
    refused(() => parse(doc({ 'billing-service': { operations: ['thing.read', 'thing.read'], scopes: [] } })), /lists a value twice/);
  });

  it('values are never normalized: a non-canonical uuid is refused, not rewritten', () => {
    refused(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [P1.toUpperCase()] } })), /wrong form/);
    refused(() => parse(doc({ 'billing-service': { operations: [' thing.read'], scopes: [] } })), /value other than/);
  });

  it('an allowEmpty list may be empty and means "none"', () => {
    const p = parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [] } }));
    expect([...p.of('billing-service')!.scopes]).toEqual([]);
  });

  it('a valid policy: the caller holds exactly its listed operations; an unknown caller holds nothing', () => {
    const p = parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [P1] } }));
    const allow = operationsPolicy(p);
    expect(allow.allows('billing-service', 'thing.read')).toBe(true);
    expect(allow.allows('billing-service', 'thing.create')).toBe(false);
    expect(allow.allows('auth-service', 'thing.read')).toBe(false);
    expect(allow.allows('billing-servic', 'thing.read')).toBe(false); // no prefix match
    expect(p.of('billing-service')!.scopes.has(P1)).toBe(true);
    expect(p.callers()).toEqual(['billing-service']);
  });

  it('registeredCallers collapses the two digests of a rotating caller into one name', () => {
    const a = generateServiceToken();
    const b = generateServiceToken();
    expect(registeredCallers([{ caller: 'billing-service', digest: a.digest }, { caller: 'billing-service', digest: b.digest }])).toEqual(['billing-service']);
  });

  it('policyChoice accepts only its closed choices', () => {
    expect(policyChoice('X', 'none', ['none', 'request'])).toBe('none');
    expect(() => policyChoice('X', 'all', ['none', 'request'])).toThrow(/must be "none" or "request"/);
  });
});

describe('parseCallerPolicy: secret-safe diagnostics', () => {
  const secret = generateServiceToken();
  const leaks = (fn: () => unknown, ...needles: string[]) => {
    let message = '';
    try {
      fn();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toBe('');
    for (const n of needles) expect(message).not.toContain(n);
  };

  it('never echoes a token, a digest, a list value or the raw document, whatever is malformed', () => {
    leaks(() => parse(`{"callers":{"billing-service":{"operations":["${secret.token}"],"scopes":[]}}}`), secret.token);
    leaks(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [secret.digest] } })), secret.digest);
    leaks(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [], [secret.token]: 1 } })), secret.token);
    leaks(() => parse(doc({ [secret.digest]: { operations: ['thing.read'], scopes: [] } })), secret.digest);
    leaks(() => parse(`{"callers": "${secret.token}`), secret.token);
    leaks(() => parse(`{"callers":{"billing-service":{"operations":["thing.read"],"scopes":[]}}, "${secret.token}": 1}`), secret.token);
    leaks(() => parse(`Bearer ${secret.token}`), secret.token, 'Bearer');
  });

  it('a malformed caller name is replaced by a fixed label; an unknown property name is never echoed', () => {
    expect(() => parse(doc({ 'Not A Caller': { operations: ['thing.read'], scopes: [] } }))).toThrow(/<invalid caller name>/);
    expect(() => parse(doc({ 'billing-service': { operations: ['thing.read'], scopes: [], adminOverride: 1 } }))).not.toThrow(/adminOverride/);
  });
});

describe('parseJsonStrict', () => {
  it('reads what JSON.parse reads', () => {
    const v = { a: [1, -2.5e3, true, false, null, 'x\\"yé'], b: { c: {} }, d: [] };
    expect(parseJsonStrict(JSON.stringify(v))).toEqual(v);
    expect(parseJsonStrict(' {"a" : "\\u0041"} ')).toEqual({ a: 'A' });
  });
  it('refuses duplicates at any depth, trailing content, and garbage', () => {
    expect(() => parseJsonStrict('{"a":{"b":1,"b":2}}')).toThrow('duplicate key');
    expect(() => parseJsonStrict('[{"a":1,"a":1}]')).toThrow('duplicate key');
    expect(() => parseJsonStrict('{"a":1} x')).toThrow('invalid JSON');
    expect(() => parseJsonStrict('{a:1}')).toThrow('invalid JSON');
    expect(() => parseJsonStrict('{"a":01}')).toThrow('invalid JSON');
    expect(() => parseJsonStrict('"a\nb"')).toThrow('invalid JSON');
  });
  it('an escaped key equal to another key is still a duplicate', () => {
    expect(() => parseJsonStrict('{"a":1,"\\u0061":2}')).toThrow('duplicate key');
  });
  it('a key named __proto__ is kept as a plain key, never a prototype change', () => {
    const v = parseJsonStrict('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(v)).toEqual(['__proto__']);
  });
});

describe('ServiceOperationGuard', () => {
  const policy = operationsPolicy(new CallerPolicyMap(new Map([['billing-service', { operations: new Set(['thing.read']) }]])));
  const ctx = (req: object, operation: string | undefined): ExecutionContext => {
    const handler = () => undefined;
    if (operation !== undefined) Reflect.defineMetadata('nawara:service-operation', operation, handler);
    return { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as unknown as ExecutionContext;
  };
  const guard = new ServiceOperationGuard(new Reflector(), policy);
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof HttpException ? [e.getStatus(), (e.getResponse() as { code?: string }).code] : ['other'];
    }
    return ['allowed'];
  };

  it('a service caller holding the operation passes (ServiceTokenGuard or ServiceOrUserGuard shape)', () => {
    expect(guard.canActivate(ctx({ serviceCaller: 'billing-service' }, 'thing.read'))).toBe(true);
    expect(guard.canActivate(ctx({ caller: { kind: 'service', service: 'billing-service' } }, 'thing.read'))).toBe(true);
  });

  it('a service caller without the operation, an unknown caller, or a route with no operation: 403 operation_not_permitted', () => {
    expect(status(() => guard.canActivate(ctx({ serviceCaller: 'billing-service' }, 'thing.create')))).toEqual([403, 'operation_not_permitted']);
    expect(status(() => guard.canActivate(ctx({ serviceCaller: 'auth-service' }, 'thing.read')))).toEqual([403, 'operation_not_permitted']);
    expect(status(() => guard.canActivate(ctx({ serviceCaller: 'billing-service' }, undefined)))).toEqual([403, 'operation_not_permitted']);
    expect(status(() => guard.canActivate(ctx({ caller: { kind: 'service', service: 'billing-service' } }, NO_SERVICE_OPERATION)))).toEqual([403, 'operation_not_permitted']);
  });

  it('a user bearer passes through to the route\'s own object rules', () => {
    expect(guard.canActivate(ctx({ caller: { kind: 'user', identity: { id: 'u' } } }, 'thing.create'))).toBe(true);
    expect(guard.canActivate(ctx({ caller: { kind: 'user', identity: { id: 'u' } } }, NO_SERVICE_OPERATION))).toBe(true);
  });

  it('forged identity headers are never read: with no authenticated caller the request is refused', () => {
    const forged = { headers: { 'x-caller': 'billing-service', 'x-service': 'billing-service', 'x-correlation-id': 'billing-service' } };
    expect(status(() => guard.canActivate(ctx(forged, 'thing.read')))).toEqual([403, 'operation_not_permitted']);
  });
});
