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

/**
 * Stage 14.6: retries are BOUNDED (see `WebhookRetriever`). Defined here so the pipeline itself knows a notification's last permitted
 * processing (Core V2 S0-C9, CB-5) without importing the retrier.
 */
export const WEBHOOK_RETRY_MAX_ATTEMPTS = 10;
