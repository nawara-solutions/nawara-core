import type { Queryable } from '@nawara/service-kit';

/**
 * Core V2 G6 financial-loss provenance (the Owner's GO, D-FL-1 Option D and D-FL-2): the TRUSTED Company of a `financial_loss.recorded`
 * event, or `undefined` (the event is then emitted unscoped, version 2 with no Company). Read on the loss's own transaction, after its
 * insert, from Billing's immutable rows only; never from a request value and never from an invoice seller alone, because a service
 * caller chooses the seller of its own products and invoices (`product-input.ts`, B-029 / B-031).
 *
 * A Company is returned only when EVERY link of the checkout ownership chain holds and agrees:
 *   1. the loss is an `over_return` or a `direct_chargeback_write_off` (D-FL-3: never a `recovery_write_off`; adjustments are never scoped);
 *   2. its payment's request (`payment_request."paymentId"` is unique, 0006 `payment_request_payment_id_unique`, and set once) belongs to an
 *      invoice produced by the RESERVED `billing-checkout` producer (no service token may hold that name, `billing-config.ts`), with no
 *      Organization on the invoice or on the loss (D-FL-4: assistance and recovery invoices are other producers and stay unscoped);
 *   3. that invoice has exactly one line, of a Company-sold product of a Platform configured in the append-only `billing_platform`;
 *   4. the `billing_platform` Company equals the invoice seller, the product seller AND the loss's Company (migration 0026 enforces the
 *      first two at commit; this re-proves them instead of trusting them);
 *   5. for a chargeback write-off, the verified dispute loss names this very payment request.
 * Anything absent, ambiguous (not exactly one row) or contradictory yields no Company. Nothing here changes a financial effect.
 */
export async function trustedLossCompany(q: Queryable, lossId: string): Promise<string | undefined> {
  const { rows } = await q.query<{ companyId: string }>(
    `SELECT b."companyId"::text AS "companyId"
       FROM financial_loss f
       JOIN payment_request r ON r."paymentId" = f."paymentId"
       JOIN invoice i ON i.id = r."invoiceId"
       JOIN invoice_line il ON il."invoiceId" = i.id
       JOIN product p ON p.id = il."productId"
       JOIN billing_platform b ON b."platformId" = p."platformId"
      WHERE f.id = $1
        AND f.kind IN ('over_return', 'direct_chargeback_write_off')
        AND f."organizationId" IS NULL AND i."organizationId" IS NULL
        AND i.producer = 'billing-checkout'
        AND i."sellerType" = 'company' AND p."sellerType" = 'company'
        AND i."sellerId" = b."companyId"::text AND p."sellerId" = b."companyId"::text AND f."companyId" = b."companyId"
        AND (SELECT count(*) FROM invoice_line x WHERE x."invoiceId" = i.id) = 1
        AND (f.kind = 'over_return'
             OR EXISTS (SELECT 1 FROM payment_dispute_loss l WHERE l."disputeId" = f."disputeId" AND l."paymentRequestId" = r.id AND l."paymentId" = f."paymentId"))`,
    [lossId],
  );
  return rows.length === 1 ? rows[0]!.companyId : undefined;
}
