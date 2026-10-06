import type { RelayObservation } from '../events/outbox-relay.js';
import type { FailureKind } from '../logging/failure.js';
import { closedSet } from './label-policy.js';
import type { BoundedMetrics } from './metrics.js';

/** The closed failure classification (`logging/failure.ts`) as label values; the compile-time check keeps the two identical. */
export const FAILURE_KINDS = [
  'db_statement_timeout',
  'db_idle_in_transaction_timeout',
  'db_connect_timeout',
  'db_connection_lost',
  'db_unavailable',
  'db_auth_failed',
  'db_serialization_failure',
  'db_deadlock',
  'db_query_timeout',
  'broker_confirm_timeout',
  'broker_connection_lost',
  'network_unreachable',
] as const satisfies readonly FailureKind[];
type Missing = Exclude<FailureKind, (typeof FAILURE_KINDS)[number]>;
const exhaustive: [Missing] extends [never] ? true : never = true;
void exhaustive;

/**
 * V2 A12.3: outbox metrics, fed by the relay observer. The gauges are the aggregate `nawara-check-outbox-lag` reads, refreshed by the
 * relay's own loop at most every 15 s (`nawara_outbox_stats_timestamp_seconds` says when, so a stale reading is visible); a pass failure
 * is counted by its bounded failure kind (`other` when unclassified). No id, event name, payload or error text.
 */
export function outboxMetrics(metrics: BoundedMetrics): (o: RelayObservation) => void {
  const pending = metrics.gauge({ name: 'nawara_outbox_pending_events', help: 'Outbox rows not yet published (the nawara-check-outbox-lag aggregate).' });
  const retrying = metrics.gauge({ name: 'nawara_outbox_retrying_events', help: 'Pending outbox rows that already failed at least one publish.' });
  const oldest = metrics.gauge({ name: 'nawara_outbox_oldest_pending_age_seconds', help: 'Age of the oldest pending outbox row, in whole seconds (0 when none).' });
  const statsAt = metrics.gauge({ name: 'nawara_outbox_stats_timestamp_seconds', help: 'When the outbox aggregate above was last read.' });
  const passFailures = metrics.counter({
    name: 'nawara_outbox_relay_pass_failures_total',
    help: 'Relay passes that failed (the next pass retries), by bounded failure kind.',
    labels: [closedSet('kind', FAILURE_KINDS)],
  });
  return (o) => {
    if (o.type === 'pass_failure') {
      passFailures.inc({ kind: o.kind });
      return;
    }
    pending.set(undefined, o.pending);
    retrying.set(undefined, o.retrying);
    oldest.set(undefined, o.oldestPendingSeconds);
    statsAt.set(undefined, o.at);
  };
}
