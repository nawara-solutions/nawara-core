import type { ParsedWebhookBody } from '../providers/provider.port.js';

/**
 * Core V2 R3 (PAY-08 I; migration 0028): what Payment could read from ONE signature-verified notification about a refund, written once on its
 * `webhook_event` row. The same function indexes a notification at receipt and a historical one in the backfill, so both always agree.
 */
export type EvidenceIndex = 'reference' | 'reference_malformed' | 'no_reference' | 'unparseable' | 'not_applicable';

export interface IndexedEvidence {
  evidenceIndex: EvidenceIndex;
  providerTransactionId: string | null;
}

const MAX_REFERENCE = 256;

/** A notification's refund evidence. `parsed === null`: the signed body could not be parsed (unattributable, never "no evidence"). */
export function indexEvidence(parsed: ParsedWebhookBody | null): IndexedEvidence {
  if (parsed === null) return { evidenceIndex: 'unparseable', providerTransactionId: null };
  if (parsed.type !== 'refund.succeeded') return { evidenceIndex: 'not_applicable', providerTransactionId: null };
  const txn = parsed.providerTransactionId;
  if (typeof txn !== 'string' || txn.length < 1 || txn.length > MAX_REFERENCE) return { evidenceIndex: 'no_reference', providerTransactionId: null };
  const usable = typeof parsed.amount === 'number' && Number.isSafeInteger(parsed.amount) && parsed.amount >= 1
    && typeof parsed.currency === 'string' && parsed.currency.length >= 1 && parsed.currency.length <= 16;
  return { evidenceIndex: usable ? 'reference' : 'reference_malformed', providerTransactionId: txn };
}

/** Unattributable signed evidence: kept as received, attributed to no payment or Company, and logged without any of its content. */
export const isUnattributable = (e: IndexedEvidence, eventType: string): boolean =>
  e.evidenceIndex === 'unparseable' || (e.evidenceIndex === 'no_reference' && eventType === 'refund.succeeded');
