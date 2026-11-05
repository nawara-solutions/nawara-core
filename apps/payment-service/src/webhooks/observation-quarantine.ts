import { createHash } from 'node:crypto';
import type { Queryable } from '@nawara/service-kit';

/** S0-C12 item 16: why a capture observation's currency can't be a fact. A 1 to 16 character value a fact can hold is never here (item 8, O-1). */
export type CurrencyEvidenceShape = 'missing' | 'null' | 'non_string' | 'empty' | 'overlength' | 'unstorable';
export type AmountEvidenceShape = 'present' | 'missing' | 'invalid';
/** A message's value exactly as the adapter read it, and whether the message had one at all (a missing value and `null` are different defects). */
export interface RawEvidence { present: boolean; value: unknown }

export const QUARANTINE_OUTCOME = 'quarantined_invalid_currency';
/** What PostgreSQL text can't hold: U+0000, or an unpaired surrogate (with the `u` flag this class matches only unpaired ones). */
const UNSTORABLE_TEXT = /\u0000|[\uD800-\uDFFF]/u;

/** Reads one value of a decoded provider message without interpreting it. */
export const rawEvidenceOf = (body: Record<string, unknown>, key: string): RawEvidence => ({ present: Object.prototype.hasOwnProperty.call(body, key), value: body[key] });

/** Null when a fact can hold it. Characters as PostgreSQL counts them (`0013`). */
export function classifyCurrencyEvidence(e: RawEvidence): CurrencyEvidenceShape | null {
  if (!e.present || e.value === undefined) return 'missing';
  if (e.value === null) return 'null';
  if (typeof e.value !== 'string') return 'non_string';
  if (e.value.length === 0) return 'empty';
  if (UNSTORABLE_TEXT.test(e.value)) return 'unstorable';
  return [...e.value].length > 16 ? 'overlength' : null;
}

export function classifyAmountEvidence(e: RawEvidence): AmountEvidenceShape {
  if (!e.present || e.value === undefined) return 'missing';
  return typeof e.value === 'number' && Number.isSafeInteger(e.value) && e.value >= 1 ? 'present' : 'invalid';
}

const fragment = (e: RawEvidence): Buffer | null => (!e.present || e.value === undefined ? null : Buffer.from(JSON.stringify(e.value), 'utf8'));
const textOrNull = (v: unknown): string | null => (typeof v === 'string' && !UNSTORABLE_TEXT.test(v) ? v : null);

export interface QuarantineObservation {
  provider: string;
  source: 'webhook' | 'status_check';
  webhookEventId: string | null;
  providerEventId: string | null;
  attemptId: string | null;
  paymentId: string | null;
  providerTxnId: unknown;
  currency: RawEvidence;
  amount: RawEvidence;
  currencyShape: CurrencyEvidenceShape;
}

/**
 * One durable record, in the caller's transaction, whatever the redeliveries: a notification is keyed by its stored event, a status read by its attempt and
 * exact evidence. It writes no fact and nothing financial. Answers whether this call created it (only that is worth an alert).
 */
export async function recordQuarantine(q: Queryable, o: QuarantineObservation): Promise<boolean> {
  const currency = fragment(o.currency);
  const amount = fragment(o.amount);
  const digest = createHash('sha256').update(JSON.stringify([textOrNull(o.providerTxnId), amount?.toString('base64') ?? null, currency?.toString('base64') ?? null])).digest('hex');
  const { rows } = await q.query(
    `INSERT INTO provider_observation_quarantine (provider, source, "webhookEventId", "providerEventId", "attemptId", "paymentId", "providerTxnId", classification,
       "currencyShape", "currencyEvidence", "amountShape", "amountEvidence", "evidenceDigest")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'invalid_currency', $8, $9, $10, $11, $12) ON CONFLICT DO NOTHING RETURNING id`,
    [o.provider, o.source, o.webhookEventId, o.providerEventId, o.attemptId, o.paymentId, textOrNull(o.providerTxnId), o.currencyShape, currency, classifyAmountEvidence(o.amount), amount, digest]);
  return rows.length > 0;
}
