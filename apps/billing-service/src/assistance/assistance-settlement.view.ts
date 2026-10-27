import type { Queryable } from '@nawara/service-kit';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** A cash-return obligation as its Organization actor and its beneficiary see it (Core V2 S5b, E-8). */
export function representCashReturnObligation(o: {
  id: string; assistanceRequestId: string; status: string; amount: string; currency: string; openedAt: Date; returnedAt: Date | null; returnReportedAt: Date | null;
}) {
  return {
    id: o.id,
    assistanceRequestId: o.assistanceRequestId,
    status: o.status,
    amount: Number(o.amount),
    currency: o.currency.trim(),
    openedAt: iso(o.openedAt),
    returnedAt: iso(o.returnedAt),
    returnReportedAt: iso(o.returnReportedAt),
  };
}

export const OBLIGATION_COLUMNS = `id, "assistanceRequestId", status, amount, currency, "openedAt", "returnedAt", "returnReportedAt"`;

/**
 * Core V2 S5b (E-1, E-5, E-8): the settlement side of an assistance request, for its read. Each channel is shown with its payment request's
 * own status and `paymentId` (null until Payment supplied one: the existing payment-request mechanism, never invented); the obligation, if
 * the deadline passed without a settlement.
 */
export async function loadSettlementView(q: Queryable, assistanceRequestId: string) {
  const channels = (await q.query<{ id: string; status: string; invoiceId: string; paymentRequestId: string | null; paymentId: string | null; paymentRequestStatus: string | null; createdAt: Date; closedAt: Date | null }>(
    `SELECT c.id, c.status, c."invoiceId", c."paymentRequestId", pr."paymentId", pr.status AS "paymentRequestStatus", c."createdAt", c."closedAt"
       FROM assistance_settlement_channel c LEFT JOIN payment_request pr ON pr.id = c."paymentRequestId"
      WHERE c."assistanceRequestId" = $1 ORDER BY c."createdAt", c.id`, [assistanceRequestId])).rows;
  const obligation = (await q.query<Parameters<typeof representCashReturnObligation>[0]>(
    `SELECT ${OBLIGATION_COLUMNS} FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [assistanceRequestId])).rows[0];
  return {
    settlementChannels: channels.map((c) => ({ ...c, createdAt: iso(c.createdAt), closedAt: iso(c.closedAt) })),
    cashReturnObligation: obligation ? representCashReturnObligation(obligation) : null,
  };
}
