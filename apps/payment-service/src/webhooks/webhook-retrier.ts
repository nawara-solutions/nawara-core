import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, PollLoop, type DrainOutcome } from '@nawara/service-kit';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { WebhookEventRow } from './webhook-event.types.js';
import { WebhookService } from './webhook.service.js';

const BATCH_SIZE = 100;
const STUCK_THRESHOLD_MS = 10_000; // a delivery left in a non-terminal state this long is worth reprocessing
/**
 * Stage 14.6: retries are BOUNDED. Attempt n (the row's `attempts` counter, which every processing increments) becomes eligible
 * `STUCK_THRESHOLD_MS * 2^n` after receipt: 10 s, 20 s, 40 s ... the 10th and last about 85 min after receipt. A row that has
 * used them all is marked `failed` / `retries_exhausted`: terminal for the retrier (an operator looks at it), and still
 * reprocessed if the PROVIDER itself redelivers the webhook. Deterministic, no jitter, no schema change.
 */
export const WEBHOOK_RETRY_MAX_ATTEMPTS = 10;
const RETRYABLE = `state IN ('received', 'processing', 'failed', 'unmatched')
  AND NOT (state = 'failed' AND outcome IN ('malformed_body', 'retries_exhausted'))`; // malformed: will never parse differently (SDD section 7)
const DUE = `"receivedAt" <= now() - make_interval(secs => $1 * power(2, LEAST(attempts, 30)))`;

/**
 * Retries webhook deliveries stuck in `received`, `processing`, `failed` or `unmatched` (SDD section 12): the
 * webhook can arrive before our record is visible (unmatched), or a crash can land between transactions A and B
 * (received/processing left behind). Same start/stop shape as `AttemptResolver` and the kit's `OutboxRelay`.
 */
@Injectable()
export class WebhookRetriever {
  // Stage 14.6: no overlapping passes, and a graceful stop that waits (bounded) for the pass in flight.
  private readonly loop = new PollLoop(() => this.drainOnce(), (e) => this.logger.error(`webhook_retrier_pass_failure error=${e instanceof Error ? e.name : 'unknown'} — the next pass retries`));
  private running = false;
  private readonly logger = new Logger(WebhookRetriever.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    private readonly webhooks: WebhookService,
  ) {}

  start(intervalMs = 5000): void {
    // A whole-pass failure (for example the scan query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.loop.start(intervalMs);
  }

  /** Stops scheduling passes and waits, bounded, for the one in flight (see `PollLoop`). */
  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  async drainOnce(): Promise<{ retried: number; exhausted: number }> {
    if (this.running) return { retried: 0, exhausted: 0 };
    this.running = true;
    try {
      // Rows that used every attempt become terminal once (and stop occupying the head of the queue).
      const exhausted = await this.db.query<{ id: string }>(
        `UPDATE webhook_event SET state = 'failed', outcome = 'retries_exhausted', "lastError" = 'retry attempts exhausted'
          WHERE ${RETRYABLE} AND attempts >= $1 RETURNING id`,
        [WEBHOOK_RETRY_MAX_ATTEMPTS],
      );
      for (const r of exhausted.rows) this.logger.warn(`webhook_retry_exhausted event=${r.id} attempts=${WEBHOOK_RETRY_MAX_ATTEMPTS} — terminal for the retrier; an operator must look at it`);

      // Only rows whose backoff is due: a failing row waits its turn instead of blocking newer ones (no head-of-line blocking).
      const { rows } = await this.db.query<WebhookEventRow>(
        `SELECT * FROM webhook_event WHERE ${RETRYABLE} AND attempts < $2 AND ${DUE} ORDER BY "receivedAt" LIMIT $3`,
        [STUCK_THRESHOLD_MS / 1000, WEBHOOK_RETRY_MAX_ATTEMPTS, BATCH_SIZE],
      );
      let retried = 0;
      for (const candidate of rows) {
        const provider = this.providers.tryGet(candidate.provider);
        if (!provider) continue; // a provider that was since disabled; nothing to retry against
        try {
          // Claim the row for the whole reprocessing (FOR UPDATE SKIP LOCKED): a worker/instance processing it right now is skipped.
          // The claim also requires the attempt count this pass SAW: every processing increments it, so a row another worker already
          // handled since this pass selected it is skipped too (never reprocessed twice in a row). Its state is written through this
          // same transaction.
          const done = await this.db.tx(async (q) => {
            const { rows: claimed } = await q.query<WebhookEventRow>(
              `SELECT * FROM webhook_event WHERE id = $2 AND attempts = $4 AND ${RETRYABLE} AND attempts < $3 AND ${DUE} FOR UPDATE SKIP LOCKED`,
              [STUCK_THRESHOLD_MS / 1000, candidate.id, WEBHOOK_RETRY_MAX_ATTEMPTS, candidate.attempts],
            );
            if (!claimed[0]) return false;
            await this.webhooks.reprocess(claimed[0], provider, q);
            return true;
          });
          if (done) retried++;
        } catch (e) {
          // One bad event must not stop the rest of the pass (it is retried on a later one, within its attempt budget).
          this.logger.warn(`webhook event ${candidate.id} could not be reprocessed: ${e instanceof Error ? e.name : 'error'}`);
        }
      }
      return { retried, exhausted: exhausted.rows.length };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class WebhookRetrierService implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly retrier: WebhookRetriever) {}
  onApplicationBootstrap(): void {
    this.retrier.start();
  }
  /** Drains BEFORE any onApplicationShutdown closes the database pool or the broker (Nest runs every beforeApplicationShutdown first). */
  async beforeApplicationShutdown(): Promise<void> {
    await this.retrier.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.retrier.stop(); // idempotent: already stopped when Nest drives the shutdown
  }
}
