import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
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
  // Stage 14.6: no overlapping passes, and a graceful stop that waits (bounded) for the pass in flight.
  // Stage 14.7: the failure's class, code and kind (a statement timeout, an unreachable database...), never its message; a bounded drain that ran out is reported.
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.logger.error(`attempt_resolver_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=attempt_resolver drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private readonly logger = new Logger(AttemptResolver.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    private readonly attempts: AttemptService,
  ) {}

  start(intervalMs = 5000): void {
    // A whole-pass failure (for example the scan query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.loop.start(intervalMs);
  }

  /** Stops scheduling passes and waits, bounded, for the one in flight (see `PollLoop`). */
  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
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
        // An attempt whose provider is not enabled (disabled since the attempt was made, or never known) is left exactly as it is:
        // nothing here may fail it, cancel anything or pick another provider. It must not stop the attempts behind it either, so the
        // lookup is the non-throwing `tryGet` (the same as `WebhookRetriever`), never `get`.
        const provider = this.providers.tryGet(attempt.provider);
        if (!provider) {
          this.logger.warn(`attempt_resolver_provider_unavailable attempt=${attempt.id} provider=${attempt.provider} — left unresolved`);
          continue;
        }
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
          // Stage 14.7: a stable event name and the attempt's identity; the attempt stays as it is and is asked about again next pass.
          this.logger.warn(`attempt_resolver_failure attempt=${attempt.id} provider=${attempt.provider} status=${attempt.status} ${code ? `reason=${code}` : describeFailure(e)} — left as is; retried on the next pass`);
        }
      }
      return { resolved };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class AttemptResolverService implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly resolver: AttemptResolver) {}
  onApplicationBootstrap(): void {
    this.resolver.start();
  }
  /** Drains BEFORE any onApplicationShutdown closes the database pool or the broker (Nest runs every beforeApplicationShutdown first). */
  async beforeApplicationShutdown(): Promise<void> {
    await this.resolver.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.resolver.stop(); // idempotent: already stopped when Nest drives the shutdown
  }
}
