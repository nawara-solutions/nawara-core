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
    expect(() => ServicePolicy.parse('   ', REG)).toThrow(/every registered caller needs an explicit policy entry/);
    expect(ServicePolicy.parse(undefined, []).has('x', 'hierarchy.read')).toBe(false); // nothing registered, nothing allowed
  });
  it('an entry for an unregistered caller is refused (no dead grants)', () => {
    expect(() => ServicePolicy.parse(doc({ ...valid(), ghost: { capabilities: ['hierarchy.read'], allowedPlatforms: [] } }), REG)).toThrow(/no registered token/);
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
