import { describe, expect, it } from 'vitest';
import { ConfigError } from '@nawara/service-kit';
import { ServicePolicy, inScope } from './service-policy.js';

const P1 = 'a0000000-0000-4000-8000-000000000001';
const P2 = 'a0000000-0000-4000-8000-000000000002';
const doc = (callers: object) => JSON.stringify({ callers });
const REG = ['payment-service', 'auth-service', 'provisioning'];
const valid = () => ({
  'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [P1, P2] },
  'auth-service': { capabilities: ['hierarchy.read'], allowedPlatforms: [P1] },
  provisioning: { capabilities: ['hierarchy.provision'] },
});

describe('ServicePolicy.parse: deny by default, fail closed at startup', () => {
  it('accepts an explicit policy and answers per caller, per capability', () => {
    const p = ServicePolicy.parse(doc(valid()), REG);
    expect(p.has('payment-service', 'hierarchy.reference.read')).toBe(true);
    expect(p.has('payment-service', 'hierarchy.read')).toBe(false);
    expect(p.has('provisioning', 'hierarchy.provision')).toBe(true);
    expect(p.has('nobody', 'hierarchy.read')).toBe(false);
    expect([...p.platforms('payment-service')!]).toEqual([P1, P2]);
    expect(p.platforms('provisioning')).toBeNull();
  });
  it('a registered caller with no policy entry refuses to start, and so does a missing policy', () => {
    const v = valid() as Record<string, unknown>;
    delete v['auth-service'];
    expect(() => ServicePolicy.parse(doc(v), REG)).toThrow(/has no SERVICE_POLICY entry/);
    expect(() => ServicePolicy.parse(undefined, REG)).toThrow(ConfigError);
    expect(() => ServicePolicy.parse('   ', REG)).toThrow(/every registered caller needs an explicit entry/);
    expect(ServicePolicy.parse(undefined, []).has('x', 'hierarchy.read')).toBe(false); // nothing registered, nothing allowed
  });
  it('an entry for an unregistered caller is refused (no dead grants)', () => {
    expect(() => ServicePolicy.parse(doc({ ...valid(), ghost: { capabilities: ['hierarchy.read'], allowedPlatforms: [] } }), REG)).toThrow(/no registered service token/);
  });
  it('has NO wildcard and NO implicit all-Platform access: allowedPlatforms is required and must list platform ids', () => {
    const noScope = valid() as Record<string, any>;
    delete noScope['payment-service'].allowedPlatforms;
    expect(() => ServicePolicy.parse(doc(noScope), REG)).toThrow(/allowedPlatforms is required/);
    for (const bad of ['*', 'all', '', 'not-a-uuid', 7, null]) {
      const v = valid() as Record<string, any>;
      v['payment-service'].allowedPlatforms = [bad];
      expect(() => ServicePolicy.parse(doc(v), REG), String(bad)).toThrow(/no wildcard/);
    }
    const v = valid() as Record<string, any>;
    v['payment-service'].allowedPlatforms = '*';
    expect(() => ServicePolicy.parse(doc(v), REG)).toThrow(/allowedPlatforms is required/);
  });
  it('an empty explicit set is legal and means NO platform', () => {
    const v = valid() as Record<string, any>;
    v['payment-service'].allowedPlatforms = [];
    const p = ServicePolicy.parse(doc(v), REG);
    expect(inScope(p.platforms('payment-service'), P1)).toBe(false);
  });
  it('the service write capability cannot be assigned (no accepted decision names a holder), and unknown capabilities are refused', () => {
    const w = valid() as Record<string, any>;
    w['payment-service'].capabilities = ['hierarchy.write'];
    expect(() => ServicePolicy.parse(doc(w), REG)).toThrow(/cannot be assigned/);
    const c = valid() as Record<string, any>;
    c['payment-service'].capabilities = ['hierarchy.company.update'];
    expect(() => ServicePolicy.parse(doc(c), REG)).toThrow(/unknown capability/);
    const u = valid() as Record<string, any>;
    u['payment-service'].capabilities = ['admin'];
    expect(() => ServicePolicy.parse(doc(u), REG)).toThrow(/unknown capability/);
  });
  it('provisioning is a dedicated identity alone and is outside Platform scope', () => {
    const mixed = valid() as Record<string, any>;
    mixed.provisioning.capabilities = ['hierarchy.provision', 'hierarchy.read'];
    expect(() => ServicePolicy.parse(doc(mixed), REG)).toThrow(/dedicated identity alone/);
    const scoped = valid() as Record<string, any>;
    scoped.provisioning.allowedPlatforms = [P1];
    expect(() => ServicePolicy.parse(doc(scoped), REG)).toThrow(/outside Platform scope/);
  });
  it('malformed documents are refused', () => {
    for (const bad of ['{', '[]', '{"callers": []}', '{"callers": 1}', '{"x":1}']) expect(() => ServicePolicy.parse(bad, REG), bad).toThrow(ConfigError);
    expect(() => ServicePolicy.parse(doc({ 'payment-service': { capabilities: [] } }), REG)).toThrow(/at least one capability/);
  });
  it('the unrestricted test fixture is refused in production', () => {
    expect(() => ServicePolicy.testFixture(['a'], true)).toThrow(/refused in production/);
    expect(ServicePolicy.testFixture(['a'], false).has('a', 'hierarchy.write')).toBe(true);
  });
  it('inScope fails closed for anything unknown', () => {
    expect(inScope(new Set([P1]), P1)).toBe(true);
    expect(inScope(new Set([P1]), P2)).toBe(false);
    expect(inScope(new Set([P1]), undefined)).toBe(false);
    expect(inScope(new Set([P1]), null)).toBe(false);
    expect(inScope(new Set(), P1)).toBe(false);
  });
});

describe('V2 A1.3 (OD-A1-3a = A): SERVICE_POLICY on the kit parser, strict by decision (ADR-0056 §11)', () => {
  const refuses = (raw: string, message: RegExp, registered: string[] = REG) => {
    let error: unknown;
    try {
      ServicePolicy.parse(raw, registered);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).not.toContain(P1); // the refusal never echoes policy content
  };
  const answers = (p: ServicePolicy) =>
    REG.map((c) => ({
      c,
      caps: ['hierarchy.reference.read', 'hierarchy.read', 'hierarchy.write', 'hierarchy.provision', 'hierarchy.company.update'].filter((k) => p.has(c, k as never)),
      platforms: p.platforms(c) === null ? null : [...p.platforms(c)!].sort(),
      inP1: inScope(p.platforms(c), P1),
      inP2: inScope(p.platforms(c), P2),
    }));

  it('NEW: an extra top-level key is refused (it was ignored before)', () => {
    refuses(JSON.stringify({ callers: valid(), admin: true }), /must be \{"callers": \{\.\.\.\}\} and nothing else/);
  });

  it('NEW: an unknown entry property is refused (it was ignored before), on scoped and provisioning entries alike', () => {
    refuses(doc({ ...valid(), 'payment-service': { capabilities: ['hierarchy.reference.read'], allowedPlatforms: [P1], allPlatforms: true } }), /unknown property \(allowed: capabilities, allowedPlatforms\)/);
    refuses(doc({ ...valid(), provisioning: { capabilities: ['hierarchy.provision'], note: 'x' } }), /unknown property/);
  });

  // Raw JSON on purpose: JSON.stringify can never produce a repeated key, and JSON.parse would silently keep the last one.
  it('NEW: a repeated caller key is refused (the second entry would silently replace a narrower first one)', () => {
    refuses(`{"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]},"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":["${P1}"]}}}`, /must not repeat a key/, ['auth-service']);
  });

  it('NEW: a repeated entry property is refused', () => {
    refuses(`{"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":[],"allowedPlatforms":["${P1}"]}}}`, /must not repeat a key/, ['auth-service']);
    refuses(`{"callers":{"auth-service":{"capabilities":["hierarchy.reference.read"],"capabilities":["hierarchy.read"],"allowedPlatforms":[]}}}`, /must not repeat a key/, ['auth-service']);
  });

  it('NEW: a repeated top-level key is refused', () => {
    refuses(`{"callers":{},"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":["${P1}"]}}}`, /must not repeat a key/, ['auth-service']);
  });

  it('an empty or whitespace-only policy with registered callers stays fail-closed; with none it grants nothing', () => {
    for (const raw of [undefined, '', ' \n\t ']) {
      expect(() => ServicePolicy.parse(raw, REG)).toThrow(ConfigError);
      const p = ServicePolicy.parse(raw, []);
      expect(p.has('auth-service', 'hierarchy.read')).toBe(false);
      expect([...p.platforms('auth-service')!]).toEqual([]);
    }
  });

  it('a valid policy answers has / platforms / inScope exactly as before', () => {
    expect(answers(ServicePolicy.parse(doc(valid()), REG))).toEqual([
      { c: 'payment-service', caps: ['hierarchy.reference.read'], platforms: [P1, P2], inP1: true, inP2: true },
      { c: 'auth-service', caps: ['hierarchy.read'], platforms: [P1], inP1: true, inP2: false },
      { c: 'provisioning', caps: ['hierarchy.provision'], platforms: null, inP1: true, inP2: true },
    ]);
  });

  it('repeated capabilities or platforms inside a list stay tolerated, exactly as before (a Set)', () => {
    const p = ServicePolicy.parse(doc({ ...valid(), 'payment-service': { capabilities: ['hierarchy.reference.read', 'hierarchy.reference.read'], allowedPlatforms: [P1, P1] } }), REG);
    expect(p.has('payment-service', 'hierarchy.reference.read')).toBe(true);
    expect([...p.platforms('payment-service')!]).toEqual([P1]);
  });

  it('the shapes deploy/register-caller.sh generates still parse (alone and together, in its deterministic order)', () => {
    const both = ServicePolicy.parse('{"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]},"provisioning":{"capabilities":["hierarchy.provision"]}}}', ['auth-service', 'provisioning']);
    expect(both.has('auth-service', 'hierarchy.read')).toBe(true);
    expect([...both.platforms('auth-service')!]).toEqual([]);
    expect(both.has('provisioning', 'hierarchy.provision')).toBe(true);
    expect(both.platforms('provisioning')).toBeNull();
    expect(ServicePolicy.parse('{"callers":{"provisioning":{"capabilities":["hierarchy.provision"]}}}', ['provisioning']).has('provisioning', 'hierarchy.provision')).toBe(true);
    expect(ServicePolicy.parse('{"callers":{"auth-service":{"capabilities":["hierarchy.read"],"allowedPlatforms":[]}}}', ['auth-service']).has('auth-service', 'hierarchy.read')).toBe(true);
  });

  it('the .env.example shape still parses (its placeholder replaced by a platform id)', () => {
    const p = ServicePolicy.parse(`{"callers":{"payment-service":{"capabilities":["hierarchy.reference.read"],"allowedPlatforms":["${P1}"]},"provisioning":{"capabilities":["hierarchy.provision"]}}}`, ['payment-service', 'provisioning']);
    expect(p.has('payment-service', 'hierarchy.reference.read')).toBe(true);
    expect(inScope(p.platforms('payment-service'), P1)).toBe(true);
    expect(inScope(p.platforms('payment-service'), P2)).toBe(false);
  });
});
