import { catalogProblems } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { PAYMENT_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.5): Payment's catalog is complete in en / fr / ar and its English is the pre-R6.5 text. */
describe('PAYMENT_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(PAYMENT_MESSAGES)).toEqual([]);
  });

  it('keeps every English text exactly as Payment returned it before R6.5', () => {
    const before: Record<keyof typeof PAYMENT_MESSAGES, string> = {
      notFound: 'Not found.',
      operationNotPermitted: 'You may not perform this operation.',
      organizationNotPermitted: "The organization is not within the calling service's scope.",
      idempotencyKeyRequired: 'A valid Idempotency-Key header is required.',
      idempotencyKeyReused: 'This Idempotency-Key was already used with a different request.',
      payerSellerMustDiffer: 'payer and seller must differ.',
      sellerIdMustBeUuid: 'seller.id must be a uuid when seller.type is organization.',
      organizationIdMustEqualSeller: 'organizationId must equal seller.id when seller.type is organization.',
      expiresAtInvalid: 'expiresAt is not a valid timestamp.',
      paymentRequestConflict: 'A payment already exists for this paymentRequestId with a different snapshot.',
      cannotCancelInStatus: 'Cannot cancel a payment in status {status}.',
      attemptStillOpen: 'An attempt is still open.',
      paymentExpired: 'This payment has expired.',
      attemptAlreadyOpen: 'An attempt is already open for this payment.',
      cannotStartAttemptInStatus: 'Cannot start an attempt on a payment in status {status}.',
      amountCurrencyMismatch: 'Provider-reported amount/currency does not match the payment snapshot.',
      providerSuccessConflicts: 'Provider success conflicts with a payment that is already {status}.',
      lateSuccessConflicts: 'Late success conflicts with a provider-confirmed failure.',
      cannotFailSucceeded: 'Cannot fail an attempt that already succeeded.',
    };
    expect(Object.keys(PAYMENT_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(PAYMENT_MESSAGES[id as keyof typeof PAYMENT_MESSAGES].en).toBe(en);
  });

  it('translates every message for real and never leaks a catalog key or sentinel; the only placeholder is the machine status', () => {
    for (const [id, texts] of Object.entries(PAYMENT_MESSAGES)) {
      expect(texts.fr, id).not.toBe(texts.en);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      for (const text of [texts.en, texts.fr, texts.ar]) {
        expect(text, id).not.toMatch(/undefined|PAYMENT_MESSAGES/);
        for (const placeholder of text.match(/\{\w+\}/g) ?? []) expect(placeholder, id).toBe('{status}');
      }
    }
  });

  it('holds no D10 message: the currency and provider echoes stay English outside the catalog', () => {
    const all = Object.values(PAYMENT_MESSAGES).flatMap((t) => [t.en, t.fr, t.ar]).join('\n');
    expect(all).not.toMatch(/Currency|Provider \{|not enabled/);
  });
});
