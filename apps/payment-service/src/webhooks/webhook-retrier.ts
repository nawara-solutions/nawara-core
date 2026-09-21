import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { WebhookEventRow } from './webhook-event.types.js';
import { WebhookService } from './webhook.service.js';

const BATCH_SIZE = 100;
const STUCK_THRESHOLD_MS = 10_000; // a delivery left in a non-terminal state this long is worth reprocessing

/**
 * Retries webhook deliveries stuck in `received`, `processing`, `failed` or `unmatched` (SDD section 12): the
 * webhook can arrive before our record is visible (unmatched), or a crash can land between transactions A and B
 * (received/processing left behind). Same start/stop shape as `AttemptResolver` and the kit's `OutboxRelay`.
 */
@Injectable()
export class WebhookRetriever {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(WebhookRetriever.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    private readonly webhooks: WebhookService,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer) return;
    // A whole-pass failure (for example the scan query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.timer = setInterval(() => void this.drainOnce().catch((e) => this.logger.error(`webhook_retrier_pass_failure error=${e instanceof Error ? e.name : 'unknown'} — the next pass retries`)), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async drainOnce(): Promise<{ retried: number }> {
    if (this.running) return { retried: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<WebhookEventRow>(
        `SELECT * FROM webhook_event
         WHERE state IN ('received', 'processing', 'failed', 'unmatched')
           AND NOT (state = 'failed' AND outcome = 'malformed_body') -- non-retryable (SDD section 7): it will never parse differently
           AND "receivedAt" < now() - make_interval(secs => $1)
         ORDER BY "receivedAt"
         LIMIT $2`,
        [STUCK_THRESHOLD_MS / 1000, BATCH_SIZE],
      );
      let retried = 0;
      for (const event of rows) {
        const provider = this.providers.tryGet(event.provider);
        if (!provider) continue; // a provider that was since disabled; nothing to retry against
        try {
          await this.webhooks.reprocess(event, provider);
          retried++;
        } catch (e) {
          // One bad event must not stop the rest of the pass (it is retried on the next one).
          this.logger.warn(`webhook event ${event.id} could not be reprocessed: ${e instanceof Error ? e.name : 'error'}`);
        }
      }
      return { retried };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class WebhookRetrierService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly retrier: WebhookRetriever) {}
  onApplicationBootstrap(): void {
    this.retrier.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.retrier.stop();
  }
}
