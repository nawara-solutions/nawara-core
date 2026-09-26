import { Logger } from '@nestjs/common';
import type { NoticeLevel } from '@nawara/service-kit';
import { LogBudget } from './log-budget.js';

/**
 * Stage 18.9 (18.8 deferred O3): the broker-side half of ingestion's observability. The kit bus reports every retry, dead-lettering,
 * deferral and consumer event as ONE line starting with a stable event name (its `onNotice` contract); audit-service counts them by that
 * name — a CLOSED set, plus the dead-letter class and whether the copy's body was kept or redacted (a redacted copy is the non-replayable
 * kind) — and logs each name within a budget. No event id, source, organization or reason value becomes a label.
 */
export const BROKER_SIGNALS = [
  'retry_scheduled', 'retry_exhausted',
  'dead_lettered', 'dead_lettered_malformed', 'dead_lettered_permanent', 'dead_lettered_retries_exhausted',
  'dead_letter_retained', 'dead_letter_redacted', 'dead_letter_deferred',
  'consumer_lost', 'consumer_recovered', 'consumer_reconnect_failed', 'consumer_drain_timeout',
  'channel_error', 'confirm_timeout', 'settle_failed', 'connection_abandoned',
] as const;
export type BrokerSignal = (typeof BROKER_SIGNALS)[number];

const BY_NAME: Record<string, BrokerSignal> = {
  event_retry_scheduled: 'retry_scheduled',
  event_retry_exhausted: 'retry_exhausted',
  event_dead_lettered: 'dead_lettered',
  event_dead_letter_deferred: 'dead_letter_deferred',
  rabbitmq_consumer_lost: 'consumer_lost',
  rabbitmq_consumer_recovered: 'consumer_recovered',
  rabbitmq_consumer_reconnect_failed: 'consumer_reconnect_failed',
  rabbitmq_consumer_drain_timeout: 'consumer_drain_timeout',
  rabbitmq_channel_error: 'channel_error',
  rabbitmq_confirm_timeout: 'confirm_timeout',
  rabbitmq_settle_failed: 'settle_failed',
  rabbitmq_connection_abandoned: 'connection_abandoned',
};
const CLASS = /\bclassification=(malformed|permanent|retries_exhausted)\b/;

export class BrokerNotices {
  private readonly log = new Logger('RabbitMqEventBus');
  private readonly counts = new Map<BrokerSignal, number>();
  private readonly budget: LogBudget;

  constructor(logsPerInterval = 20) {
    this.budget = new LogBudget(logsPerInterval);
  }

  /** The kit bus's `onNotice`: counted always, logged within the budget (unknown names are logged, never counted as a new label). */
  observe(message: string, level: NoticeLevel): void {
    const name = message.split(' ', 1)[0] ?? '';
    const signal = BY_NAME[name];
    if (signal) {
      this.bump(signal);
      if (signal === 'dead_lettered') {
        const c = CLASS.exec(message)?.[1];
        if (c) this.bump(`dead_lettered_${c}` as BrokerSignal);
        // An annotated copy is `body=redacted` or kept; an unannotated fallback (a consumer without a policy) is neither.
        if (!/\bannotated=false\b/.test(message)) this.bump(/\bbody=redacted\b/.test(message) ? 'dead_letter_redacted' : 'dead_letter_retained');
      }
    }
    if (this.budget.allow(signal ?? 'other')) this.log[level === 'info' ? 'log' : level](message);
  }

  /** The interval's counts (then reset) and the lines the budget suppressed. */
  drain(): { counts: Record<BrokerSignal, number>; suppressed: number } {
    const counts = Object.fromEntries(BROKER_SIGNALS.map((s) => [s, this.counts.get(s) ?? 0])) as Record<BrokerSignal, number>;
    this.counts.clear();
    return { counts, suppressed: this.budget.drain() };
  }

  private bump(s: BrokerSignal): void {
    this.counts.set(s, (this.counts.get(s) ?? 0) + 1);
  }
}
