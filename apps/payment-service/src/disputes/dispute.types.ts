import type { Queryable } from '@nawara/service-kit';

/** A `payment_dispute` row (migration 0019). */
export interface DisputeRow {
  id: string;
  provider: string;
  providerDisputeId: string;
  paymentId: string;
  attemptId: string;
  captureFactId: string;
  amount: string;
  currency: string;
  reason: string | null;
  status: 'open' | 'won' | 'lost';
  liveMode: boolean;
  providerOpenedAt: Date | null;
  providerClosedAt: Date | null;
  recordedAt: Date;
  closedAt: Date | null;
  chargebackFactId: string | null;
}

/** What a verified provider notification says about a dispute (R6E-2), after parsing; nothing here is trusted beyond its signature. */
export interface DisputeNotice {
  kind: 'opened' | 'won' | 'lost';
  providerDisputeId: string;
  /** the exposure the provider states, minor units */
  amount: number;
  currency: string;
  reason: string | null;
  /** the chargeback movement the provider reports with a loss: the only thing that moves money (FC-1) */
  chargeback: { txnId: string; amount: number; currency: string } | null;
  providerOccurredAt: Date | null;
}

const REF = /^.{1,256}$/s;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const KINDS: Record<string, DisputeNotice['kind']> = { 'payment.dispute.opened': 'opened', 'payment.dispute.won': 'won', 'payment.dispute.lost': 'lost' };
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isCurrency = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 16;

export const isDisputeNotificationType = (type: string): boolean => type.startsWith('payment.dispute.');

/**
 * Core V2 S6e-D (R6E-2): a dispute notification's claim. `null` when it is not one Payment understands (unknown kind, a missing or malformed
 * field, a chargeback on anything but a loss): such a notification is preserved as received, never applied.
 */
export function parseDisputeNotice(parsed: { type: string; amount?: number; currency?: string; data: unknown; providerOccurredAt?: Date }): DisputeNotice | null {
  const kind = KINDS[parsed.type];
  if (!kind) return null;
  const data = parsed.data as { disputeId?: unknown; reason?: unknown; chargeback?: unknown; occurredAt?: unknown } | null | undefined;
  if (!data || typeof data !== 'object' || typeof data.disputeId !== 'string' || !REF.test(data.disputeId)) return null;
  if (!isAmount(parsed.amount) || !isCurrency(parsed.currency)) return null;
  if (data.reason !== undefined && data.reason !== null && (typeof data.reason !== 'string' || !REASON.test(data.reason))) return null;
  let chargeback: DisputeNotice['chargeback'] = null;
  if (data.chargeback !== undefined && data.chargeback !== null) {
    const c = data.chargeback as { id?: unknown; amount?: unknown; currency?: unknown };
    if (kind !== 'lost' || typeof c !== 'object' || typeof c.id !== 'string' || !REF.test(c.id) || !isAmount(c.amount) || !isCurrency(c.currency)) return null;
    chargeback = { txnId: c.id, amount: c.amount, currency: c.currency };
  }
  const occurred = typeof data.occurredAt === 'string' ? new Date(data.occurredAt) : parsed.providerOccurredAt ?? null;
  return {
    kind, providerDisputeId: data.disputeId, amount: parsed.amount, currency: parsed.currency, reason: (data.reason as string | undefined) ?? null, chargeback,
    providerOccurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
  };
}

/**
 * Core V2 S6e-D (R6E-1, R6E-4; S0 FC-5, D3): a payment's dispute exposure as Payment's own rows establish it.
 *   - `unresolved`: a preserved conflicting observation, or a lost dispute without its verified chargeback fact: the exposure cannot be
 *     established, so a NEW refund is never admitted (fail closed); work already in flight is not affected;
 *   - `exposed`: an open dispute (its provider-stated amount, net of chargeback facts already linked to it) or a chargeback already taken;
 *   - `clear`: neither.
 */
export interface DisputeExposure {
  state: 'clear' | 'exposed' | 'unresolved';
  openDisputes: number;
  /** FC-5 `disputeExposure`: the open disputes' stated amounts net of their linked chargeback facts, never rounded up to the capture */
  disputeExposure: number;
  /** verified chargeback facts of the payment (they reduce `netRetained`) */
  chargedBack: number;
  conflicts: number;
  lostWithoutChargeback: number;
}

export async function disputeExposure(q: Queryable, paymentId: string): Promise<DisputeExposure> {
  const { rows } = await q.query<{ open: string; exposure: string; charged: string; conflicts: string; unfunded: string }>(
    `SELECT
       (SELECT count(*) FROM payment_dispute WHERE "paymentId" = $1 AND status = 'open') AS open,
       (SELECT COALESCE(sum(GREATEST(0, d.amount - COALESCE((SELECT sum(f.amount) FROM provider_transaction_fact f WHERE f."disputeId" = d.id AND f.kind = 'chargeback'), 0))), 0)
          FROM payment_dispute d WHERE d."paymentId" = $1 AND d.status = 'open') AS exposure,
       (SELECT COALESCE(sum(amount), 0) FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback') AS charged,
       (SELECT count(*) FROM payment_dispute_observation WHERE "paymentId" = $1 AND disposition = 'conflict') AS conflicts,
       (SELECT count(*) FROM payment_dispute WHERE "paymentId" = $1 AND status = 'lost' AND "chargebackFactId" IS NULL) AS unfunded`,
    [paymentId],
  );
  const r = rows[0]!;
  const e = { openDisputes: Number(r.open), disputeExposure: Number(r.exposure), chargedBack: Number(r.charged), conflicts: Number(r.conflicts), lostWithoutChargeback: Number(r.unfunded) };
  const state = e.conflicts > 0 || e.lostWithoutChargeback > 0 ? 'unresolved' : e.openDisputes > 0 || e.disputeExposure > 0 || e.chargedBack > 0 ? 'exposed' : 'clear';
  return { state, ...e };
}
