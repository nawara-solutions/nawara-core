import { Logger } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';
import type { RefundBinding } from './refund.types.js';

/** DI token of Auth's receipt consumption boundary (Core V2 S6b; AUTH-02, AUTH-03). */
export const RECEIPT_AUTHORITY = Symbol('PAYMENT_RECEIPT_AUTHORITY');

/** Auth's consumption, as Payment keeps it: `approvedBy` and the Company are Auth's own rows (F-16), never a request value. */
export interface ReceiptConsumption {
  receiptId: string;
  consumedAt: Date;
  approvedByUserId: string;
}

/**
 * What Auth's answer PROVES (R6B-9). Only a consumption, or a refusal that Auth's contract makes permanent, is definitive:
 *   - `receipt_invalid` (no receipt for this secret and binding, or a voided one) and `receipt_binding_invalid` never become consumable;
 *   - `receipt_expired` (an `issued` receipt past its time, by Auth's database clock) can never be consumed afterwards.
 * Everything else proves nothing about a consumption under this `consumeRef`: `authority_revoked` (the receipt stays `issued` and unexpired),
 * `consume_ref_conflict` (consumed elsewhere, or this reference consumed another receipt), `receipt_outcome_unknown`, `receipt_unavailable`,
 * a refusal of the caller, a timeout, an unparseable or inconsistent answer.
 */
export type ConsumeOutcome =
  | { kind: 'consumed'; consumption: ReceiptConsumption }
  | { kind: 'refused'; code: 'receipt_invalid' | 'receipt_binding_invalid' }
  | { kind: 'expired' }
  | { kind: 'conflict' }
  | { kind: 'unresolved'; reason: string };

/** AUTH-03: a consumption under this reference for this binding, or `absent` (which proves NOTHING definitive, R6B-9), or unresolved. */
export type LookupOutcome = { kind: 'consumed'; consumption: ReceiptConsumption } | { kind: 'absent' } | { kind: 'unresolved'; reason: string };

export interface ReceiptAuthority {
  consume(input: { secret: string; binding: RefundBinding; consumeRef: string }): Promise<ConsumeOutcome>;
  lookup(input: { binding: RefundBinding; consumeRef: string }): Promise<LookupOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ConsumptionWire {
  receiptId?: unknown; consumeRef?: unknown; consumedAt?: unknown; approvedBy?: { userId?: unknown }; companyId?: unknown; code?: unknown;
}

/**
 * Core V2 S6b (ADR-0067 decisions 3 to 5; ADR-0035 C4; register AUTH-02, AUTH-03): Payment's only service call to Auth, with Payment's OWN
 * service token (never a user's bearer). The secret travels only in the AUTH-02 body; it is never logged, and no error message carries it.
 * A consumption is accepted only when it names exactly this reference and the binding's Company; anything else is unresolved.
 */
export class HttpReceiptAuthority implements ReceiptAuthority {
  private readonly log = new Logger('PaymentReceiptAuthority');

  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  async consume(input: { secret: string; binding: RefundBinding; consumeRef: string }): Promise<ConsumeOutcome> {
    const r = await this.post('/auth/service/authorization-receipts/consume', { secret: input.secret, binding: input.binding, consumeRef: input.consumeRef });
    if (r.status === 200) {
      const c = this.consumption(r.body, input.consumeRef, input.binding);
      return c ? { kind: 'consumed', consumption: c } : { kind: 'unresolved', reason: 'malformed_consumption' };
    }
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    if (r.status === 409 && code === 'receipt_invalid') return { kind: 'refused', code: 'receipt_invalid' };
    if (r.status === 400 && code === 'receipt_binding_invalid') return { kind: 'refused', code: 'receipt_binding_invalid' };
    if (r.status === 409 && code === 'receipt_expired') return { kind: 'expired' };
    if (r.status === 409 && code === 'consume_ref_conflict') return { kind: 'conflict' };
    return { kind: 'unresolved', reason: code ?? `status_${r.status}` };
  }

  async lookup(input: { binding: RefundBinding; consumeRef: string }): Promise<LookupOutcome> {
    const r = await this.post('/auth/service/authorization-receipts/consumptions/lookup', { binding: input.binding, consumeRef: input.consumeRef });
    if (r.status === 200) {
      const c = this.consumption(r.body, input.consumeRef, input.binding);
      return c ? { kind: 'consumed', consumption: c } : { kind: 'unresolved', reason: 'malformed_consumption' };
    }
    if (r.status === 404) return { kind: 'absent' };
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    return { kind: 'unresolved', reason: code ?? `status_${r.status}` };
  }

  private consumption(body: ConsumptionWire | null, consumeRef: string, binding: RefundBinding): ReceiptConsumption | null {
    const consumedAt = typeof body?.consumedAt === 'string' ? new Date(body.consumedAt) : null;
    if (!body || typeof body.receiptId !== 'string' || !UUID.test(body.receiptId) || body.consumeRef !== consumeRef || body.companyId !== binding.companyId
      || typeof body.approvedBy?.userId !== 'string' || !UUID.test(body.approvedBy.userId) || !consumedAt || Number.isNaN(consumedAt.getTime())) {
      this.log.error(`receipt_consumption_inconsistent consumeRef=${consumeRef} — Auth's answer does not name this reference and Company; left unresolved`);
      return null;
    }
    return { receiptId: body.receiptId, consumedAt, approvedByUserId: body.approvedBy.userId };
  }

  private async post(path: string, body: unknown): Promise<{ status: number; body: ConsumptionWire | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, 'content-type': 'application/json', ...correlationHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      return { status: 0, body: null }; // network error or timeout: proves nothing (unresolved)
    }
    try {
      return { status: res.status, body: (await res.json()) as ConsumptionWire };
    } catch {
      return { status: res.status, body: null };
    }
  }
}
