import { describe, expect, it } from 'vitest';
import type { PaymentRow } from '../payments/payment.types.js';
import { TestPaymentProvider } from './test-provider.js';

const payment = (over: Partial<PaymentRow> = {}): PaymentRow =>
  ({ id: 'p1', amount: '1000', currency: 'TND', ...over }) as PaymentRow;

describe('TestPaymentProvider', () => {
  it('success: accepts, then fetchStatus (by providerTransactionId or merchantReference) reports succeeded', async () => {
    const p = new TestPaymentProvider();
    const result = await p.initiate(payment(), { merchantReference: 'att-1' });
    expect(result).toMatchObject({ kind: 'accepted', providerTransactionId: 'ptx_att-1' });
    await expect(p.fetchStatus('ptx_att-1')).resolves.toEqual({ kind: 'succeeded', amount: 1000, currency: 'TND' });
    await expect(p.fetchStatus('att-1')).resolves.toEqual({ kind: 'succeeded', amount: 1000, currency: 'TND' });
  });

  it('failure: rejects with the given (or default) failure class/code, and fetchStatus reports failed', async () => {
    const p = new TestPaymentProvider();
    const result = await p.initiate(payment(), { merchantReference: 'att-2', options: { scenario: 'failure', failureClass: 'retryable', failureCode: 'insufficient_funds' } });
    expect(result).toEqual({ kind: 'rejected', failureClass: 'retryable', failureCode: 'insufficient_funds' });
    await expect(p.fetchStatus('att-2')).resolves.toEqual({ kind: 'failed', failureClass: 'retryable', failureCode: 'insufficient_funds' });
  });

  it('failure defaults to a terminal card_declined when no options are given', async () => {
    const p = new TestPaymentProvider();
    await p.initiate(payment(), { merchantReference: 'att-3', options: { scenario: 'failure' } });
    await expect(p.fetchStatus('att-3')).resolves.toEqual({ kind: 'failed', failureClass: 'terminal', failureCode: 'card_declined' });
  });

  it('retry: rejects retryably (the caller starts a fresh attempt for the actual retry)', async () => {
    const p = new TestPaymentProvider();
    const result = await p.initiate(payment(), { merchantReference: 'att-4', options: { scenario: 'retry' } });
    expect(result).toEqual({ kind: 'rejected', failureClass: 'retryable', failureCode: 'temporary_failure' });
  });

  it('timeout_before_accept: ambiguous, and the provider never recorded it (fetchStatus -> notFound)', async () => {
    const p = new TestPaymentProvider();
    const result = await p.initiate(payment(), { merchantReference: 'att-5', options: { scenario: 'timeout_before_accept' } });
    expect(result).toEqual({ kind: 'ambiguous' });
    await expect(p.fetchStatus('att-5')).resolves.toEqual({ kind: 'notFound' });
  });

  it('timeout_after_accept: ambiguous from our side, but the provider DID record it (fetchStatus -> succeeded)', async () => {
    const p = new TestPaymentProvider();
    const result = await p.initiate(payment(), { merchantReference: 'att-6', options: { scenario: 'timeout_after_accept' } });
    expect(result).toEqual({ kind: 'ambiguous' });
    await expect(p.fetchStatus('att-6')).resolves.toEqual({ kind: 'succeeded', amount: 1000, currency: 'TND' });
  });

  it('fetchStatus is notFound for a reference the provider has never seen', async () => {
    const p = new TestPaymentProvider();
    await expect(p.fetchStatus('never-seen')).resolves.toEqual({ kind: 'notFound' });
  });

  it('rejects an unknown scenario name rather than silently defaulting', async () => {
    const p = new TestPaymentProvider();
    await expect(p.initiate(payment(), { merchantReference: 'att-7', options: { scenario: 'not-a-real-scenario' } })).rejects.toThrow(/unknown test provider scenario/);
  });

  describe('webhook signature verification', () => {
    it('verifies a genuine success callback signature and parses its payload', async () => {
      const p = new TestPaymentProvider();
      await p.initiate(payment(), { merchantReference: 'att-8' });
      const { body, signature } = p.signSuccessCallback('att-8');
      const result = await p.verifyWebhook(body, { 'x-test-provider-signature': signature });
      expect(result).toEqual({
        signatureValid: true,
        parsed: { providerEventId: 'evt_att-8', type: 'payment.succeeded', reference: 'ptx_att-8', amount: 1000, currency: 'TND', data: undefined },
      });
    });

    it('rejects a tampered body (signature no longer matches)', async () => {
      const p = new TestPaymentProvider();
      await p.initiate(payment(), { merchantReference: 'att-9' });
      const { body, signature } = p.signSuccessCallback('att-9');
      const tampered = Buffer.from(body.toString('utf8').replace('1000', '9999'));
      await expect(p.verifyWebhook(tampered, { 'x-test-provider-signature': signature })).resolves.toEqual({ signatureValid: false });
    });

    it('rejects a missing signature header', async () => {
      const p = new TestPaymentProvider();
      await p.initiate(payment(), { merchantReference: 'att-10' });
      const { body } = p.signSuccessCallback('att-10');
      await expect(p.verifyWebhook(body, {})).resolves.toEqual({ signatureValid: false });
    });

    it('treats a valid signature over a malformed body as verified-but-unparseable, never signatureValid: false', async () => {
      const p = new TestPaymentProvider();
      const body = Buffer.from('{"not": "json"', 'utf8'); // truncated JSON, still hashable/signable
      const { createHmac } = await import('node:crypto');
      const sig = createHmac('sha256', 'test-provider-webhook-secret').update(body).digest('hex');
      await expect(p.verifyWebhook(body, { 'x-test-provider-signature': sig })).resolves.toEqual({ signatureValid: true, parsed: null });
    });
  });
});
