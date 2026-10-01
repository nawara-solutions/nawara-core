import { catalogProblems, renderMessage } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { BILLING_MESSAGES } from './messages.js';

/** ADR-0054 D6 / D13 (Core V1 refactor R6.6): Billing's catalog is complete in en / fr / ar and its English is the pre-R6.6 text. */
describe('BILLING_MESSAGES', () => {
  it('is complete: every message has non-empty en, fr and ar text with identical placeholders', () => {
    expect(catalogProblems(BILLING_MESSAGES)).toEqual([]);
  });

  it('renders, with its parameters, exactly the English Billing returned before R6.6', () => {
    const en = (id: keyof typeof BILLING_MESSAGES, params?: Record<string, string | number>) => renderMessage(BILLING_MESSAGES[id], 'en', params).text;
    const before: [string, string][] = [
      [en('notFound'), 'Not found.'],
      [en('operationNotPermitted'), 'You may not perform this operation.'],
      [en('organizationNotPermitted'), "The organization is not within the calling service's scope."],
      [en('limitRange', { max: 100 }), 'limit must be an integer from 1 to 100'],
      [en('cursorInvalid'), 'cursor is not valid'],
      [en('requestMustBeObject'), 'the request must be an object'],
      [en('unknownField', { name: 'lines[0].foo' }), 'unknown field: lines[0].foo'],
      [en('mustBeObject', { field: 'seller' }), 'seller must be an object'],
      [en('mustBeUuid', { field: 'invoiceRequestId' }), 'invoiceRequestId must be a uuid'],
      [en('partyTypeValues', { field: 'payer.type' }), 'payer.type must be user, organization or company'],
      [en('lengthRange', { field: 'name', max: 140 }), 'name must be 1 to 140 characters'],
      [en('patternMatch', { field: 'code', pattern: '^[a-z][a-z0-9_-]{1,62}$' }), 'code must match ^[a-z][a-z0-9_-]{1,62}$'],
      [en('timestampWithOffset', { field: 'dueAt' }), 'dueAt must be an absolute timestamp with an offset'],
      [en('integerRange', { field: 'lines[2].quantity', max: 1000 }), 'lines[2].quantity must be an integer from 1 to 1000'],
      [en('notValid', { field: 'lines[1].sourceId' }), 'lines[1].sourceId is not valid'],
      [en('sourcePair', { field: 'lines[1]' }), 'lines[1] needs both sourceType and sourceId, or neither'],
      [en('sellerIdUuidWhenOrganization'), 'seller.id must be a uuid when seller.type is organization'],
      [en('entitlementKindValues'), 'entitlementKind must be none, organization_license or user_subscription'],
      [en('payerSellerDiffer'), 'payer and seller must differ'],
      [en('organizationIdEqualsSeller'), 'organizationId must equal seller.id when the seller is an organization'],
      [en('linesCount', { max: 100 }), 'lines must have 1 to 100 entries'],
      [en('localeTag'), 'locale must be a language tag such as fr or ar-TN'],
      [en('invoiceStatusValues'), 'status must be draft, open, paid or void'],
      [en('clientReferencePattern'), 'clientReference must be 1 to 128 characters of [A-Za-z0-9._:-]'],
      [en('currencyIso'), 'currency must be a three-letter ISO 4217 code'],
      [en('unitAmountPositive'), 'unitAmount must be a positive integer number of minor units'],
      [en('unitAmountMax', { max: '9007199254740991' }), 'unitAmount must be at most 9007199254740991'],
      [en('intervalValues'), 'interval must be one_time or recurring'],
      [en('intervalUnitValues'), 'intervalUnit must be day, week, month or year for a recurring price'],
      [en('intervalCountPositive'), 'intervalCount must be a positive integer for a recurring price'],
      [en('oneTimeNoInterval'), 'a one_time price cannot carry intervalUnit or intervalCount'],
      [en('productConflict'), 'This seller and code were used with different content.'],
      [en('priceConflict'), 'This productId and clientReference were used with different content.'],
      [en('currencyNotSupported'), 'The currency is not supported.'],
      [en('currencyNotEnabledForPlatform'), 'The currency is not enabled for this platform.'],
      [en('currencyDoesNotExist'), 'The currency does not exist.'],
      [en('priceNotAvailable'), 'A price is not available.'],
      [en('linesShareCurrency'), 'All lines of an invoice must share one currency.'],
      [en('oneRecurringLine'), 'An invoice may contain at most one recurring line.'],
      [en('invoiceRequestConflict'), 'The invoice request conflicts with another request.'],
      [en('invoiceRequestIdReused'), 'This invoiceRequestId was used with different content.'],
      [en('invoiceCannotBeIssued', { status: 'paid' }), 'An invoice that is paid cannot be issued.'],
      [en('invoiceCannotBeDiscarded', { status: 'void' }), 'An invoice that is void cannot be discarded.'],
      [en('onlyOpenInvoicePayable'), 'Only an open invoice can be paid.'],
      [en('onlyUserPayer'), 'Only a user payer can pay an invoice for now.'],
      [en('requestAlreadySent'), 'This request has already been sent; it cannot be cancelled locally.'],
      [en('requestNotCancellableYet'), 'This request cannot be cancelled yet.'],
      [en('paymentRefusedCancellation'), 'Payment refused the cancellation: a payment attempt or cash submission is in progress.'],
      [en('paymentCouldNotConfirm'), 'Payment could not confirm the cancellation. Retry the same request.'],
      [en('subscriptionRequestConflict'), 'The subscription request conflicts with another request.'],
      [en('subscriptionDifferentProduct'), 'This organization already has a subscription to a different product or price.'],
      [en('periodEndAfterStart'), 'currentPeriodEnd must be after currentPeriodStart.'],
      [en('pendingMustBeActivated'), 'A pending subscription must be activated before it can be renewed.'],
      [en('noGraceWindow'), 'This subscription has no grace window to enter.'],
      [en('subscriptionCannotBeActivated', { status: 'active' }), 'A subscription that is active cannot be activated.'],
      [en('subscriptionCannotEnterGrace', { status: 'grace' }), 'A subscription that is grace cannot enter grace.'],
      [en('subscriptionCannotExpire', { status: 'pending' }), 'A subscription that is pending cannot expire.'],
      [en('subscriptionCannotChangeCancellation', { status: 'expired' }), 'A subscription that is expired cannot change its cancellation.'],
      [en('subscriptionCannotBeTerminated', { status: 'pending' }), 'A subscription that is pending cannot be terminated.'],
    ];
    expect(before).toHaveLength(Object.keys(BILLING_MESSAGES).length); // every entry is pinned
    for (const [rendered, expected] of before) expect(rendered).toBe(expected);
  });

  it('translates every message for real and never leaks a catalog key or sentinel', () => {
    for (const [id, texts] of Object.entries(BILLING_MESSAGES)) {
      expect(texts.fr, id).not.toBe(texts.en);
      expect(texts.ar, id).toMatch(/[؀-ۿ]/);
      for (const text of [texts.en, texts.fr, texts.ar]) expect(text, id).not.toMatch(/undefined|BILLING_MESSAGES/);
    }
  });

  it('holds no D10 message: the snapshot-validation and anchored-period messages stay English outside the catalog', () => {
    const all = Object.values(BILLING_MESSAGES).flatMap((t) => [t.en, t.fr, t.ar]).join('\n');
    expect(all).not.toMatch(/is longer than|not an allowed key|nested too deeply|billing anchor/);
  });
});
