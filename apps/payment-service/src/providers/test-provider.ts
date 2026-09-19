import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PaymentRow } from '../payments/payment.types.js';
import type { FetchStatusResult, InitiateResult, PaymentProvider, ProviderCapabilities, ProviderOptions, VerifyWebhookResult } from './provider.port.js';

interface Record_ {
  status: 'accepted' | 'rejected' | 'unknown';
  providerTransactionId?: string;
  failureClass?: 'retryable' | 'terminal';
  failureCode?: string;
  amount: number;
  currency: string;
}

const WEBHOOK_SECRET = 'test-provider-webhook-secret'; // test-only provider; never enabled in production (config-checked)

/**
 * Deterministic test provider (SDD section 13.2). No network: state lives in process memory, keyed by
 * merchantReference. Only the scenarios reachable without a real webhook delivery are exercised directly here
 * (`success` via sync/fetchStatus, `failure`, `timeout_before_accept`, `timeout_after_accept`, `retry`); the
 * delivery-order scenarios (`duplicate_callback`, `delayed_callback`, `out_of_order`) are properties of how a test
 * drives the webhook endpoint, exercised once that endpoint exists.
 */
@Injectable()
export class TestPaymentProvider implements PaymentProvider {
  readonly id = 'test';
  readonly capabilities: ProviderCapabilities = {
    refunds: false,
    partialRefunds: false,
    notFoundIsAuthoritative: true,
    visibilityLagMs: 50,
    timeoutMs: 200,
    sessionExpiry: true,
    paymentFatalCodes: ['card_closed'],
  };

  private readonly records = new Map<string, Record_>();

  async initiate(payment: PaymentRow, attempt: { merchantReference: string; options?: ProviderOptions }): Promise<InitiateResult> {
    const scenario = (attempt.options?.scenario as string) ?? 'success';
    const amount = Number(payment.amount);
    const currency = payment.currency;
    switch (scenario) {
      case 'success': {
        const providerTransactionId = `ptx_${attempt.merchantReference}`;
        this.records.set(attempt.merchantReference, { status: 'accepted', providerTransactionId, amount, currency });
        return { kind: 'accepted', providerTransactionId, nextAction: { type: 'redirect', url: `https://test-provider.invalid/pay/${providerTransactionId}` } };
      }
      case 'failure': {
        const failureClass = (attempt.options?.failureClass as 'retryable' | 'terminal') ?? 'terminal';
        const failureCode = (attempt.options?.failureCode as string) ?? 'card_declined';
        this.records.set(attempt.merchantReference, { status: 'rejected', failureClass, failureCode, amount, currency });
        return { kind: 'rejected', failureClass, failureCode };
      }
      case 'retry': {
        // The scenario's own name describes a two-attempt sequence: this attempt fails retryably, a later one (a
        // fresh merchantReference) succeeds — the caller drives that by starting a second attempt with `success`.
        const failureCode = 'temporary_failure';
        this.records.set(attempt.merchantReference, { status: 'rejected', failureClass: 'retryable', failureCode, amount, currency });
        return { kind: 'rejected', failureClass: 'retryable', failureCode };
      }
      case 'timeout_before_accept':
        // Ambiguous, and the provider never actually recorded it: fetchStatus later legitimately answers notFound.
        return { kind: 'ambiguous' };
      case 'timeout_after_accept': {
        // Ambiguous from OUR side (the response never arrived), but the provider DID record it.
        const providerTransactionId = `ptx_${attempt.merchantReference}`;
        this.records.set(attempt.merchantReference, { status: 'accepted', providerTransactionId, amount, currency });
        return { kind: 'ambiguous' };
      }
      default:
        throw new Error(`unknown test provider scenario: ${scenario}`);
    }
  }

  async fetchStatus(ref: string): Promise<FetchStatusResult> {
    const key = ref.startsWith('ptx_') ? ref.slice('ptx_'.length) : ref;
    const record = this.records.get(key);
    if (!record) return { kind: 'notFound' };
    if (record.status === 'accepted') return { kind: 'succeeded', amount: record.amount, currency: record.currency };
    if (record.status === 'rejected') return { kind: 'failed', failureClass: record.failureClass ?? 'terminal', failureCode: record.failureCode ?? 'unknown' };
    return { kind: 'pending' };
  }

  /** Test-only helper: builds a signed callback body for a merchantReference already known to this provider instance. */
  signSuccessCallback(merchantReference: string): { body: Buffer; signature: string } {
    const record = this.records.get(merchantReference);
    if (!record?.providerTransactionId) throw new Error(`no accepted attempt recorded for ${merchantReference}`);
    const payload = {
      eventId: `evt_${merchantReference}`,
      type: 'payment.succeeded',
      reference: record.providerTransactionId,
      amount: record.amount,
      currency: record.currency,
    };
    return this.sign(payload);
  }

  signFailureCallback(merchantReference: string): { body: Buffer; signature: string } {
    const record = this.records.get(merchantReference);
    if (!record) throw new Error(`no attempt recorded for ${merchantReference}`);
    const payload = {
      eventId: `evt_${merchantReference}_failed`,
      type: 'payment.failed',
      reference: record.providerTransactionId ?? merchantReference,
      data: { failureCode: record.failureCode ?? 'card_declined' },
    };
    return this.sign(payload);
  }

  private sign(payload: Record<string, unknown>): { body: Buffer; signature: string } {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    return { body, signature };
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifyWebhookResult> {
    const header = headers['x-test-provider-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    if (!signature || !safeEqualHex(signature, expected)) return { signatureValid: false };
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      if (typeof body.eventId !== 'string' || typeof body.type !== 'string' || typeof body.reference !== 'string') {
        return { signatureValid: true, parsed: null };
      }
      return {
        signatureValid: true,
        parsed: {
          providerEventId: body.eventId,
          type: body.type,
          reference: body.reference,
          amount: typeof body.amount === 'number' ? body.amount : undefined,
          currency: typeof body.currency === 'string' ? body.currency : undefined,
          data: body.data,
        },
      };
    } catch {
      return { signatureValid: true, parsed: null };
    }
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
