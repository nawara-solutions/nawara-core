import { describe, expect, it } from 'vitest';
import { relationTo } from './relations.js';

const invoice = { producer: 'test-producer', payerType: 'user', payerId: 'user-1' };

describe('relation to an invoice is derived from the invoice itself (SDD 19.3)', () => {
  it('the creating service is the producer', () => expect(relationTo(invoice, { kind: 'service', service: 'test-producer' })).toBe('producer'));
  it('a user payer who is the caller is the payer', () => expect(relationTo(invoice, { kind: 'user', userId: 'user-1' })).toBe('payer'));
  it('another service, another user, and a user sharing the seller organization id have NO relation', () => {
    expect(relationTo(invoice, { kind: 'service', service: 'other' })).toBeNull();
    expect(relationTo(invoice, { kind: 'user', userId: 'user-2' })).toBeNull();
    expect(relationTo({ ...invoice, payerType: 'organization', payerId: 'user-1' }, { kind: 'user', userId: 'user-1' })).toBeNull(); // an org payer is not a user payer (B-026)
  });
  it('a service is never a payer and a user is never a producer, even with a colliding name', () => {
    expect(relationTo(invoice, { kind: 'service', service: 'user-1' })).toBeNull();
    expect(relationTo(invoice, { kind: 'user', userId: 'test-producer' })).toBeNull();
  });
});
