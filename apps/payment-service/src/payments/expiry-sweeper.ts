import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, OutboxService } from '@nawara/service-kit';
import { deterministicEventId } from '../events/deterministic-id.js';
import type { PaymentRow } from './payment.types.js';

/**
 * Expires payments past their `expiresAt` (SDD section 5.1, 12): only when no attempt is open — money in flight, or
 * cash awaiting review, must be resolved first. A payment without `expiresAt` is never swept (O-16, not decided).
 * Same start/stop shape as `AttemptResolver`/`WebhookRetrier`/the kit's `OutboxRelay`.
 */
@Injectable()
export class ExpirySweeper {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweepOnce(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweepOnce(): Promise<{ expired: number }> {
    if (this.running) return { expired: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `SELECT id FROM payment WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() AND status IN ('created', 'pending')`,
      );
      let expired = 0;
      for (const { id } of rows) if (await this.trySweepOne(id)) expired++;
      return { expired };
    } finally {
      this.running = false;
    }
  }

  private async trySweepOne(paymentId: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [paymentId]);
      const payment = rows[0];
      if (!payment || !payment.expiresAt || payment.expiresAt.getTime() > Date.now()) return false;
      if (payment.status !== 'created' && payment.status !== 'pending') return false;
      const { rows: open } = await q.query(`SELECT 1 FROM payment_attempt WHERE "paymentId" = $1 AND status IN ('initiated', 'submitted', 'unknown')`, [paymentId]);
      if (open.length > 0) return false; // money in flight must be resolved first (the resolver settles it)
      await q.query(`UPDATE payment SET status = 'expired', "closedAt" = now() WHERE id = $1`, [paymentId]);
      await this.outbox.enqueue(q, {
        id: deterministicEventId(paymentId, 'payment.expired'),
        name: 'payment.expired',
        payload: { paymentId, expiresAt: payment.expiresAt.toISOString() },
      });
      return true;
    });
  }
}

@Injectable()
export class ExpirySweeperService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly sweeper: ExpirySweeper) {}
  onApplicationBootstrap(): void {
    this.sweeper.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.sweeper.stop();
  }
}
