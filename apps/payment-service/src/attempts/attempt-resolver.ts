import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { jobContext } from '../events/payment-events.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { AttemptService } from './attempt.service.js';
import type { AttemptRow } from './attempt.types.js';

const BATCH_SIZE = 100;
const LONG_SUBMITTED_MS = 5 * 60 * 1000; // an attempt "stuck" in submitted this long is worth asking the provider about

/**
 * Settles attempts stuck in `initiated`, `unknown`, or long-`submitted` (SDD section 12), so a payment cannot stay
 * `pending` forever without something checking. Never retries blindly: it only ASKS the provider (`fetchStatus`) and
 * applies the SAME transition rules `sync` uses (including the "never retry an unknown blindly" rule, section 5.2).
 * Same start/stop shape as the kit's `OutboxRelay`, run the same way (an interval, not a cron dependency).
 */
@Injectable()
export class AttemptResolver {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(AttemptResolver.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    private readonly attempts: AttemptService,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drainOnce(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed directly for tests (no need to wait on a real interval). */
  async drainOnce(): Promise<{ resolved: number }> {
    if (this.running) return { resolved: 0 }; // a previous pass is still running; do not overlap
    this.running = true;
    try {
      const { rows } = await this.db.query<AttemptRow>(
        `SELECT * FROM payment_attempt
         WHERE status = 'unknown'
            OR status = 'initiated'
            OR (status = 'submitted' AND "submittedAt" < now() - make_interval(secs => $1))
         ORDER BY "initiatedAt"
         LIMIT $2`,
        [LONG_SUBMITTED_MS / 1000, BATCH_SIZE],
      );
      let resolved = 0;
      const ctx = jobContext('attempt_resolver'); // one run, one correlation id for every event it causes
      for (const attempt of rows) {
        const provider = this.providers.get(attempt.provider);
        if (attempt.status === 'initiated') {
          const waitMs = provider.capabilities.timeoutMs + provider.capabilities.visibilityLagMs;
          const ageMs = Date.now() - new Date(attempt.initiatedAt).getTime();
          if (ageMs < waitMs) continue; // still within the provider's own normal response window; not stuck yet
        }
        // One attempt that cannot be settled (a conflict, an amount mismatch, a provider error) must not block the others:
        // every attempt behind it in the queue would otherwise wait on it forever.
        try {
          const ref = attempt.providerTransactionId ?? attempt.merchantReference;
          const status = await provider.fetchStatus(ref);
          await this.attempts.applyStatus(attempt.id, status, provider, ctx);
          resolved++;
        } catch (e) {
          const code = (e as { response?: { code?: string } })?.response?.code;
          this.logger.warn(`attempt ${attempt.id} could not be resolved: ${code ?? (e instanceof Error ? e.name : 'error')}`);
        }
      }
      return { resolved };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class AttemptResolverService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly resolver: AttemptResolver) {}
  onApplicationBootstrap(): void {
    this.resolver.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.resolver.stop();
  }
}
