import type { EventBusObservation } from '../events/rabbitmq-event-bus.js';
import { closedSet, growingSet } from './label-policy.js';
import type { BoundedMetrics } from './metrics.js';

export const PUBLISH_OUTCOMES = ['confirmed', 'failed', 'confirm_timeout'] as const;
export const CONSUME_OUTCOMES = [
  'processed',
  'retry_scheduled',
  'dead_lettered_malformed',
  'dead_lettered_permanent',
  'dead_lettered_retries_exhausted',
  'dead_letter_deferred',
  'dead_letter_unannotated',
] as const;
/** Publisher-confirm round trip (seconds), up to the default 5 s confirm bound and beyond. */
export const PUBLISH_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
/** Handler duration (seconds): the HTTP request scale. */
export const HANDLER_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
/** A consumer queue name, as code declares it (`billing.payment-events`, `audit-service.audit`); at most 16 per process. */
const QUEUE = /^[a-z][a-z0-9_.-]{0,80}$/;
const MAX_QUEUES = 16;

/**
 * V2 A12.3: application-side messaging metrics, fed by the event bus observer. Labels are the consumer's own queue (a name code
 * registered when it subscribed; never the event name, routing key, message id or payload, so a wildcard binding such as `audit.#`
 * cannot create series) and a closed outcome. Every bus of the process shares these metrics.
 */
export function messagingMetrics(metrics: BoundedMetrics): (o: EventBusObservation) => void {
  const queue = growingSet('queue', QUEUE, MAX_QUEUES);
  const series = MAX_QUEUES + 1;
  const published = metrics.counter({
    name: 'nawara_events_published_total',
    help: 'Event publishes, by outcome: confirmed by the broker, failed, or confirm timeout (state unknown; republished).',
    labels: [closedSet('outcome', PUBLISH_OUTCOMES)],
  });
  const publishDuration = metrics.histogram({
    name: 'nawara_event_publish_duration_seconds',
    help: 'Publish duration until the broker confirmed, failed or the confirm timed out.',
    buckets: PUBLISH_DURATION_BUCKETS,
  });
  const consumed = metrics.counter({
    name: 'nawara_events_consumed_total',
    help: 'Deliveries settled by a consumer, by queue and outcome (processed, retry scheduled, dead-lettered, deferred).',
    labels: [queue, closedSet('outcome', CONSUME_OUTCOMES)],
    maxSeries: series * (CONSUME_OUTCOMES.length + 1),
  });
  const handlerDuration = metrics.histogram({
    name: 'nawara_event_handler_duration_seconds',
    help: 'Event handler duration, by consumer queue.',
    labels: [queue],
    buckets: HANDLER_DURATION_BUCKETS,
    maxSeries: series,
  });
  const redeliveries = metrics.counter({
    name: 'nawara_event_redeliveries_total',
    help: 'Deliveries the broker marked as redelivered, by consumer queue.',
    labels: [queue],
    maxSeries: series,
  });
  const up = metrics.gauge({ name: 'nawara_event_consumer_up', help: 'Whether each consumer is attached to its queue: 1 consuming, 0 lost or closed.', labels: [queue], maxSeries: series });
  const losses = metrics.counter({ name: 'nawara_event_consumer_losses_total', help: 'Consumers lost (channel or connection gone, broker cancel), by queue.', labels: [queue], maxSeries: series });
  const recoveries = metrics.counter({ name: 'nawara_event_consumer_recoveries_total', help: 'Consumers re-attached after a loss, by queue.', labels: [queue], maxSeries: series });
  const settleFailures = metrics.counter({
    name: 'nawara_event_settle_failures_total',
    help: 'Acknowledgements that could not be sent (the broker redelivers), by queue.',
    labels: [queue],
    maxSeries: series,
  });

  return (o) => {
    switch (o.type) {
      case 'publish':
        published.inc({ outcome: o.outcome });
        publishDuration.observe(undefined, o.durationMs / 1000);
        return;
      case 'consume':
        consumed.inc({ queue: o.queue, outcome: o.outcome });
        if (o.handlerMs !== undefined) handlerDuration.observe({ queue: o.queue }, o.handlerMs / 1000);
        if (o.redelivered) redeliveries.inc({ queue: o.queue });
        return;
      case 'consumer':
        if (o.state === 'consuming') up.set({ queue: o.queue }, 1);
        else if (o.state === 'recovered') recoveries.inc({ queue: o.queue });
        else {
          up.set({ queue: o.queue }, 0);
          if (o.state === 'lost') losses.inc({ queue: o.queue });
        }
        return;
      case 'settle_failed':
        settleFailures.inc({ queue: o.queue });
    }
  };
}
