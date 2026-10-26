import { describe, expect, it } from 'vitest';
import { idempotencyKey, normaliseEmptyInput, normaliseFeeCapInput, normaliseFeeDelegationInput, normaliseFeeProposalInput } from './fee-input.js';

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
  return 'accepted';
};
const U = '00000000-0000-4000-8000-0000000000aa';

/** Core V2 S3f (A1, A5): fee amounts are integer minor units >= 0 (never a percentage); bodies are exact; every command has an Idempotency-Key. */
describe('fee inputs', () => {
  it('a cap or fee is an integer number of minor units from 0 to 2^53-1', () => {
    expect(normaliseFeeCapInput({ amount: 0 })).toEqual({ amount: 0 });
    expect(normaliseFeeCapInput({ amount: 9007199254740991 })).toEqual({ amount: 9007199254740991 });
    for (const amount of [-1, 0.5, '1', null, 9007199254740992, Number.NaN]) expect(code(() => normaliseFeeCapInput({ amount }))).toBe('invalid_fee_request');
  });

  it('bodies are exact: no currency, percentage, actor, status or Company can be supplied', () => {
    for (const extra of [{ currency: 'TND' }, { percentage: 5 }, { proposedBy: U }, { status: 'approved' }, { companyId: U }]) {
      expect(code(() => normaliseFeeProposalInput({ organizationId: U, productId: U, amount: 1, ...extra }))).toBe('invalid_fee_request');
    }
    expect(code(() => normaliseFeeDelegationInput({ operatorUserId: U, platformId: U }))).toBe('invalid_fee_request');
    expect(code(() => normaliseFeeDelegationInput({ operatorUserId: 'not-a-uuid' }))).toBe('invalid_fee_request');
    expect(normaliseFeeProposalInput({ organizationId: U.toUpperCase(), productId: U, amount: 1 })).toEqual({ organizationId: U, productId: U, amount: 1 });
    expect(code(() => normaliseEmptyInput({ reason: 'x' }))).toBe('invalid_fee_request');
    expect(normaliseEmptyInput(undefined)).toEqual({});
  });

  it('an Idempotency-Key is required: 8 to 128 of [A-Za-z0-9._:-]', () => {
    expect(idempotencyKey('abcd-1234')).toBe('abcd-1234');
    for (const k of [undefined, '', 'short', 'x'.repeat(129), 'has space1', ['a', 'b']]) expect(code(() => idempotencyKey(k))).toBe('idempotency_key_required');
  });
});
