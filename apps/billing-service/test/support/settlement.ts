import type { INestApplicationContext } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import type { Caller, TransitionContext } from '../../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../../src/domain/invoice-input.js';
import { recordTransition } from '../../src/domain/transitions.js';
import { InvoiceRepository } from '../../src/invoices/invoice.repository.js';
import { PaymentRequestRepository, type EventApplication } from '../../src/invoices/payment-request.repository.js';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository.js';
import type { SubscriptionRow } from '../../src/subscriptions/subscription.types.js';

/** The Platform of every test subscription product, and the Organizations they are sold to (the issuing caller's scope). */
export const SUBSCRIPTION_PLATFORM = '99999999-9999-4999-8999-999999999999';
const PRODUCER = 'test-producer';
const SELLER = { type: 'company', id: 'nawara-test-seller' };
const PAYER = { type: 'user', id: 'subscription-payer' };

/**
 * A test subscription product: an Organization subscription (S3a target, on SUBSCRIPTION_PLATFORM), sold by the company test seller,
 * with one recurring price. The only kind of product whose settlement can reach an Organization Subscription (S3a / S3b).
 */
export async function subscriptionPrice(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, any>> }> },
  o: { unit?: number; intervalUnit?: string; intervalCount?: number; code?: string } = {},
): Promise<{ productId: string; priceId: string }> {
  const productId = (await db.query(
    `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
     VALUES ($1, $2, $3, $4, 'Plan', 'active', 'organization', $5) RETURNING id`,
    [PRODUCER, SELLER.type, SELLER.id, o.code ?? `plan-${crypto.randomUUID().slice(0, 12)}`, SUBSCRIPTION_PLATFORM],
  )).rows[0]!.id as string;
  const priceId = (await db.query(
    `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount") VALUES ($1, $2, 'TND', $3, 'recurring', $4, $5) RETURNING id`,
    [productId, `p-${crypto.randomUUID().slice(0, 12)}`, o.unit ?? 1000, o.intervalUnit ?? 'month', o.intervalCount ?? 1],
  )).rows[0]!.id as string;
  return { productId, priceId };
}

/**
 * Core V2 S3b: the ONLY way a test reaches a Subscription period — the real settlement path, as production does: an
 * `organization_subscription` invoice (routed at issue, S3a), a payment request, and Payment's verified `payment.succeeded` for it at
 * `at` (the authoritative settlement instant) applied through `PaymentRequestRepository.applyPaymentEvent`, which records the receipt,
 * marks the request and invoice paid and writes the `subscription_settlement` with the period in ONE transaction. There is no direct
 * activation or renewal any more.
 */
export async function settle(app: INestApplicationContext, o: { organizationId: string; priceId: string; at: Date }): Promise<{ application: EventApplication; subscription: SubscriptionRow | null; invoiceId: string }> {
  const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: crypto.randomUUID() }, correlationId: 'settle' };
  const producer: Caller = { kind: 'service', service: PRODUCER };
  const invoices = app.get(InvoiceRepository);
  const requests = app.get(PaymentRequestRepository);
  const input = normaliseCreateInvoiceInput({
    invoiceRequestId: crypto.randomUUID(), seller: SELLER, payer: PAYER, organizationId: o.organizationId, sourceType: 'contract', sourceId: `s-${crypto.randomUUID().slice(0, 8)}`,
    issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: o.priceId, quantity: 1 }],
  });
  const { invoice } = await invoices.createDraft(PRODUCER, input, ['TND'], ctx);
  const open = (await invoices.issue(invoice.id, producer, { template: 'system:1', locale: 'fr' }, ctx,
    { callerPlatforms: new Set([SUBSCRIPTION_PLATFORM]), organizationPlatformId: SUBSCRIPTION_PLATFORM })).invoice;
  const { request } = await requests.createForInvoice(open.id, producer, ctx);
  const paymentId = crypto.randomUUID();
  await app.get(DbService).tx(async (q) => {
    for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
      const { rows } = await q.query<{ revision: number }>(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [request.id]);
      await recordTransition(q, { entityType: 'payment_request', entityId: request.id, from, to, revision: rows[0]!.revision, ctx });
    }
  });
  const eventId = crypto.randomUUID();
  const application = await requests.applyPaymentEvent(eventId, {
    name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: open.id,
    payer: PAYER, seller: SELLER, organizationId: o.organizationId, amount: Number(open.total), currency: open.currency, revision: 1,
  }, { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: eventId }, correlationId: 'settle' }, o.at);
  return { application, subscription: await app.get(SubscriptionRepository).findForOrganization(o.organizationId), invoiceId: open.id };
}
