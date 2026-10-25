import { ConfigError } from '@nawara/service-kit';
import { AUTH_SERVICE_OPERATIONS, parseAuthServicePolicy } from './service-policy.js';

/** Core V2 S2-Auth.2 (D-A2 §11.2, F-7): `AUTH_SERVICE_POLICY` is deny by default and admits only payment-service. */
const doc = (callers: Record<string, unknown>) => JSON.stringify({ callers });
const both = [...AUTH_SERVICE_OPERATIONS];

describe('AUTH_SERVICE_POLICY', () => {
  it('no document and no registered caller: nothing may call', () => {
    expect(parseAuthServicePolicy(undefined, []).size).toBe(0);
  });

  it('admits payment-service with exactly the listed operations', () => {
    const p = parseAuthServicePolicy(doc({ 'payment-service': { operations: ['authorization_receipt.consume'] } }), ['payment-service']);
    expect([...p.of('payment-service')!.operations]).toEqual(['authorization_receipt.consume']);
    expect(p.of('billing-service')).toBeUndefined();
  });

  it('refuses to boot on every widening or ambiguity', () => {
    const refused: Array<[string, string | undefined, string[]]> = [
      ['a registered caller with no document', undefined, ['payment-service']],
      ['another caller', doc({ 'billing-service': { operations: both } }), ['billing-service']],
      ['a wildcard caller', doc({ '*': { operations: both } }), ['payment-service']],
      ['an unknown operation', doc({ 'payment-service': { operations: ['authorization_receipt.issue'] } }), ['payment-service']],
      ['a wildcard operation', doc({ 'payment-service': { operations: ['*'] } }), ['payment-service']],
      ['an empty list', doc({ 'payment-service': { operations: [] } }), ['payment-service']],
      ['a repeated operation', doc({ 'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.consume'] } }), ['payment-service']],
      ['an unknown property', doc({ 'payment-service': { operations: both, companies: ['x'] } }), ['payment-service']],
      ['an entry without a token', doc({ 'payment-service': { operations: both } }), []],
      ['a duplicate key', '{"callers":{"payment-service":{"operations":["authorization_receipt.consume"]},"payment-service":{"operations":["authorization_receipt.lookup"]}}}', ['payment-service']],
    ];
    for (const [what, raw, registered] of refused) expect(() => parseAuthServicePolicy(raw, registered), what).toThrow(ConfigError);
  });
});
