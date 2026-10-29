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
      providerOptionsNotAccepted: 'This provider does not accept providerOptions: a payer cannot choose a simulated outcome.', // Core V2 S4f
      invalidSimulationCommand: 'failureCode and delivery apply only to the outcomes that carry them.',
      simulationCommandConflict: 'This commandId was already used for a different simulation command.',
      simulationNothingToDeliver: 'This simulation command produced no provider notification.',
      paymentUncertain: 'An earlier attempt may still settle this payment; no new attempt is possible until it is resolved.', // Core V2 S4c
      purposeRequired: 'purpose is required for a new payment.', // Core V2 S4a: new messages
      purposeNotAccepted: 'purpose must be organization_subscription, direct_purchase, non_entitlement, assisted_settlement or recovery_settlement.', // Core V2 S4e
      payerIdMustBeUuid: 'payer.id must be a uuid when payer.type is organization.',
      organizationIdMustEqualPayer: 'organizationId must equal payer.id when payer.type is organization.',
      beneficiaryRequired: 'beneficiaryUserId is required for purpose {purpose}.',
      beneficiaryNotAllowed: 'beneficiaryUserId is not allowed for purpose {purpose}.',
      payerPurposeMismatch: 'This payer cannot pay for purpose {purpose}.',
      cannotCancelInStatus: 'Cannot cancel a payment in status {status}.',
      attemptStillOpen: 'An attempt is still open.',
      paymentExpired: 'This payment has expired.',
      attemptAlreadyOpen: 'An attempt is already open for this payment.',
      cannotStartAttemptInStatus: 'Cannot start an attempt on a payment in status {status}.',
      amountCurrencyMismatch: 'Provider-reported amount/currency does not match the payment snapshot.',
      providerSuccessConflicts: 'Provider success conflicts with a payment that is already {status}.',
      lateSuccessConflicts: 'Late success conflicts with a provider-confirmed failure.',
      invalidRefundRequest: 'The refund request is malformed.', // Core V2 S6b: new messages
      paymentNotRefundable: 'This payment cannot be refunded.',
      refundCaptureUnverified: 'This payment has no verified capture to refund.',
      refundAmountNotFull: 'Only a full refund of the captured amount, in its currency, is supported.',
      refundDisputeOpen: 'A dispute on this payment blocks a new refund attempt.',
      refundDisputeUnavailable: 'The dispute status of this payment could not be verified; nothing was changed.',
      refundInProgress: 'Another refund attempt for this payment is unresolved or may still take effect.',
      refundAlreadyRecorded: 'Refund evidence already exists for this payment.',
      refundAttemptConflict: 'This refund attempt already exists with different content or another authorization receipt.',
      refundAuthorizationInvalid: 'The refund authorization receipt is not valid for this refund.',
      refundAuthorizationExpired: 'The refund authorization receipt expired before it was used.',
      refundAuthorizationUnresolved: 'The refund authorization could not be confirmed yet; retry with the same key and receipt.',
      refundCaseCompleted: 'This refund case is completed: it accepts no new refund attempt.', // Core V2 S6c
      cannotFailSucceeded: 'Cannot fail an attempt that already succeeded.',
    };
    expect(Object.keys(PAYMENT_MESSAGES).sort()).toEqual(Object.keys(before).sort());
    for (const [id, en] of Object.entries(before)) expect(PAYMENT_MESSAGES[id as keyof typeof PAYMENT_MESSAGES].en).toBe(en);
  });

  it('translates every message for real and never leaks a catalog key or sentinel; the only placeholders are the machine status and purpose', () => {
    for (const [id, texts] of Object.entries(PAYMENT_MESSAGES)) {
      expect(texts.fr, id).not.toBe(texts.en);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      for (const text of [texts.en, texts.fr, texts.ar]) {
        expect(text, id).not.toMatch(/undefined|PAYMENT_MESSAGES/);
        for (const placeholder of text.match(/\{\w+\}/g) ?? []) expect(['{status}', '{purpose}'], id).toContain(placeholder);
      }
    }
  });

  it('holds no D10 message: the currency and provider echoes stay English outside the catalog', () => {
    const all = Object.values(PAYMENT_MESSAGES).flatMap((t) => [t.en, t.fr, t.ar]).join('\n');
    expect(all).not.toMatch(/Currency|Provider \{|not enabled/);
  });
});
