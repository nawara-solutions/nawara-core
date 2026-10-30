import type { Queryable } from '@nawara/service-kit';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * A cash-return obligation as its Organization actor and its beneficiary see it (Core V2 S5b, E-8). `returnedAt` is the Organization's
 * original assertion; `effectiveReturnedAt` is it after the Owner's corrections, if any (Core V2 S5c, H-2: derived, never stored).
 */
export function representCashReturnObligation(o: {
  id: string; assistanceRequestId: string; status: string; amount: string; currency: string; origin?: string; openedAt: Date; returnedAt: Date | null; returnReportedAt: Date | null;
  confirmedAt: Date | null; effectiveReturnedAt: Date | null; supersededAt?: Date | null;
}) {
  return {
    id: o.id,
    assistanceRequestId: o.assistanceRequestId,
    status: o.status,
    amount: Number(o.amount),
    currency: o.currency.trim(),
    origin: o.origin ?? 'deadline', // Core V2 S6d (R6D-2): `deadline` or `refund_completion`
    openedAt: iso(o.openedAt),
    returnedAt: iso(o.returnedAt),
    returnReportedAt: iso(o.returnReportedAt),
    effectiveReturnedAt: iso(o.effectiveReturnedAt), // Core V2 S5c
    confirmedAt: iso(o.confirmedAt), // Core V2 S5c (H-3): the beneficiary's confirmation, the database's time
    supersededAt: iso(o.supersededAt ?? null), // Core V2 S6g (L-4): superseded by a late-settlement application (terminal, history)
  };
}

// Core V2 S6g: the Owner's corrections apply to the request's CURRENT obligation only; a history row shows its own recorded time
export const OBLIGATION_COLUMNS = `id, "assistanceRequestId", status, amount, currency, origin, "openedAt", "returnedAt", "returnReportedAt", "confirmedAt", "supersededAt",
  CASE WHEN id = billing_assistance_current_obligation("assistanceRequestId") THEN billing_assistance_effective_time("assistanceRequestId", 'returnedAt') ELSE "returnedAt" END AS "effectiveReturnedAt"`;

/**
 * Core V2 S5c (H-4, H-5, J-2): a dispute with the Organization's answer and the nonfinancial resolution, if any. `escalationDue` is derived
 * from the database's time (open for more than seven days): an escalation TARGET only, it closes nothing and starts nothing. No actor
 * identifier is exposed.
 */
export function representDispute(d: {
  id: string; assistanceRequestId: string; reasonCode: string; status: string; openedAt: Date; escalationDue: boolean;
  position: string | null; respondedAt: Date | null; outcome: string | null; correctionId: string | null; resolvedAt: Date | null;
}) {
  return {
    id: d.id,
    assistanceRequestId: d.assistanceRequestId,
    reasonCode: d.reasonCode,
    status: d.status,
    openedAt: iso(d.openedAt),
    escalationDue: d.escalationDue,
    response: d.position ? { position: d.position, respondedAt: iso(d.respondedAt) } : null,
    resolution: d.outcome ? { outcome: d.outcome, correctionId: d.correctionId, resolvedAt: iso(d.resolvedAt) } : null,
  };
}

export const DISPUTE_COLUMNS = `d.id, d."assistanceRequestId", d."reasonCode", d.status, d."openedAt",
  (d.status = 'open' AND now() > d."openedAt" + interval '7 days') AS "escalationDue",
  p.position, p."respondedAt", d.outcome, d."correctionId", d."resolvedAt"`;

/** Core V2 S5c (H-2): an appended Owner correction of an Organization-asserted time; the superseded value stays on record. */
export function representCorrection(c: {
  id: string; assistanceRequestId: string; sequence: number; field: string; correctedValue: Date; supersededValue: Date; reasonCode: string; correctedAt: Date;
}) {
  return {
    id: c.id,
    assistanceRequestId: c.assistanceRequestId,
    sequence: c.sequence,
    field: c.field,
    correctedValue: iso(c.correctedValue)!,
    supersededValue: iso(c.supersededValue)!,
    reasonCode: c.reasonCode,
    correctedAt: iso(c.correctedAt),
  };
}

export const CORRECTION_COLUMNS = `id, "assistanceRequestId", sequence, field, "correctedValue", "supersededValue", "reasonCode", "correctedAt"`;

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
  // Core V2 S6g (Option A): the CURRENT obligation (the most recent one not superseded by a late-settlement application), and the full
  // history, oldest first (a superseded deadline obligation stays identifiable next to a later refund-origin one)
  const obligation = (await q.query<Parameters<typeof representCashReturnObligation>[0]>(
    `SELECT ${OBLIGATION_COLUMNS} FROM cash_return_obligation WHERE id = billing_assistance_current_obligation($1)`, [assistanceRequestId])).rows[0];
  const history = (await q.query<Parameters<typeof representCashReturnObligation>[0]>(
    `SELECT ${OBLIGATION_COLUMNS} FROM cash_return_obligation WHERE "assistanceRequestId" = $1 ORDER BY "openedAt", id`, [assistanceRequestId])).rows;
  // Core V2 S5c: the disputes (oldest first) and the Owner's corrections (in the order they apply), and the effective collection time
  const disputes = (await q.query<Parameters<typeof representDispute>[0]>(
    `SELECT ${DISPUTE_COLUMNS} FROM assistance_dispute d LEFT JOIN assistance_dispute_response p ON p."disputeId" = d.id
      WHERE d."assistanceRequestId" = $1 ORDER BY d."openedAt", d.id`, [assistanceRequestId])).rows;
  const corrections = (await q.query<Parameters<typeof representCorrection>[0]>(
    `SELECT ${CORRECTION_COLUMNS} FROM assistance_correction WHERE "assistanceRequestId" = $1 ORDER BY sequence`, [assistanceRequestId])).rows;
  const collected = (await q.query<{ v: Date | null }>(`SELECT billing_assistance_effective_time($1, 'cashCollectedAt') AS v`, [assistanceRequestId])).rows[0]!.v;
  return {
    settlementChannels: channels.map((c) => ({ ...c, createdAt: iso(c.createdAt), closedAt: iso(c.closedAt) })),
    cashReturnObligation: obligation ? representCashReturnObligation(obligation) : null,
    cashReturnObligations: history.map(representCashReturnObligation),
    effectiveCashCollectedAt: iso(collected),
    disputes: disputes.map(representDispute),
    corrections: corrections.map(representCorrection),
  };
}
