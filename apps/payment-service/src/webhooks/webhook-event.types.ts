export type WebhookEventState = 'received' | 'processing' | 'processed' | 'ignored' | 'unmatched' | 'conflict' | 'failed';

/** Shape of the `webhook_event` table row (SDD section 4.6). */
export interface WebhookEventRow {
  id: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  rawBody: Buffer;
  receivedAt: Date;
  state: WebhookEventState;
  outcome: string | null;
  attempts: number;
  lastError: string | null;
  matchedAttemptId: string | null;
  processedAt: Date | null;
}
