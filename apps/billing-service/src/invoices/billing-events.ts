import type { NewEvent } from '@nawara/service-kit';
import type { TransitionContext } from '../domain/actors.js';
import { deterministicEventId } from '../common/deterministic-id.js';
import { fromDbAmount, toJsonAmount } from '../domain/money.js';
import type { InvoiceRecord } from './invoice.types.js';

/**
 * `invoice.created` (SDD 23, R-3): emitted ONLY on `draft -> open`, when the invoice becomes owed (a draft is never announced). Common
 * payload plus the lines. Opaque ids and plain facts: no description text, no snapshot content (personal data, B-032), no secret.
 * Amounts are JSON integers, exact because of the 2^53-1 cap. The id is derived from (invoice, event name), so a retried issue can never
 * enqueue a second event.
 */
export function invoiceCreatedEvent(invoice: InvoiceRecord, ctx: TransitionContext): NewEvent {
  return {
    id: deterministicEventId(invoice.id, 'invoice.created'),
    name: 'invoice.created',
    correlationId: ctx.correlationId ?? undefined,
    payload: {
      aggregateType: 'invoice',
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      sourceType: invoice.sourceType,
      sourceId: invoice.sourceId,
      organizationId: invoice.organizationId,
      payer: { type: invoice.payerType, id: invoice.payerId },
      seller: { type: invoice.sellerType, id: invoice.sellerId },
      currency: invoice.currency,
      subtotal: toJsonAmount(fromDbAmount(invoice.subtotal)),
      taxTotal: toJsonAmount(fromDbAmount(invoice.taxTotal)),
      total: toJsonAmount(fromDbAmount(invoice.total)),
      taxTreatment: invoice.taxTreatment,
      status: invoice.status,
      revision: invoice.revision,
      dueAt: invoice.dueAt ? invoice.dueAt.toISOString() : null,
      issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
      actor: ctx.actor,
      cause: ctx.cause,
      lines: invoice.lines.map((l) => ({
        lineId: l.id,
        lineNumber: l.lineNumber,
        productCode: l.productCode,
        priceId: l.priceId,
        quantity: l.quantity,
        unitAmount: toJsonAmount(fromDbAmount(l.unitAmount)),
        lineTotal: toJsonAmount(fromDbAmount(l.lineTotal)),
        taxAmount: toJsonAmount(fromDbAmount(l.taxAmount)),
        entitlementKind: l.entitlementKind,
      })),
    },
  };
}
