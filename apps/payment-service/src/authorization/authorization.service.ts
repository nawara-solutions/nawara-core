import { Injectable } from '@nestjs/common';
import type { Caller } from '@nawara/service-kit';
import { notFound, operationNotPermitted } from '../errors.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** Relations a caller may hold to a payment (SDD section 8.3). Only `producer` and `payer` exist in this phase: no
 * membership-based relations (payer-organization member, seller-organization member) since those all depend on
 * unresolved `[B]` decisions (O-18, O-20) about organization/company payer and read authority. */
export type PaymentRelation = 'producer' | 'payer' | null;

/**
 * The ONLY place that establishes a caller's relation to a payment and applies the operation rules of section 8.4.
 * A caller with no relation gets the same 404 as a resource that does not exist (collapsed, no existence leak).
 */
@Injectable()
export class AuthorizationService {
  relationTo(payment: Pick<PaymentRow, 'producer' | 'payerType' | 'payerId'>, caller: Caller): PaymentRelation {
    if (caller.kind === 'service' && caller.service === payment.producer) return 'producer';
    if (caller.kind === 'user' && payment.payerType === 'user' && payment.payerId === caller.identity.id) return 'payer';
    return null;
  }

  /** Read a payment or its refunds: the producer (only its own payments) and the payer (SDD section 8.4). */
  assertCanRead(payment: Pick<PaymentRow, 'producer' | 'payerType' | 'payerId'>, caller: Caller): PaymentRelation {
    const relation = this.relationTo(payment, caller);
    if (!relation) throw notFound();
    return relation;
  }

  /** Cancel: the producer only, in this phase (SDD section 8.4). */
  assertCanCancel(payment: Pick<PaymentRow, 'producer' | 'payerType' | 'payerId'>, caller: Caller): void {
    const relation = this.relationTo(payment, caller);
    if (!relation) throw notFound();
    if (relation !== 'producer') throw operationNotPermitted();
  }

  /** Start an attempt: the payer only, in this phase — organization-payer authority is [B, O-18], not decided. */
  assertCanStartAttempt(payment: Pick<PaymentRow, 'producer' | 'payerType' | 'payerId'>, caller: Caller): void {
    const relation = this.relationTo(payment, caller);
    if (!relation) throw notFound();
    if (relation !== 'payer') throw operationNotPermitted();
  }

  /** Sync an attempt: anyone with a read relation (producer or payer), per SDD section 8.4. */
  assertCanSync(payment: Pick<PaymentRow, 'producer' | 'payerType' | 'payerId'>, caller: Caller): void {
    if (!this.relationTo(payment, caller)) throw notFound();
  }
}
