/**
 * Core V2 DO-43 (the Owner's D43-1 to D43-8; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY): the shapes of audit-service's dead-letter
 * observations (migration 0009). Header-only: identifiers, codes, counters and times. Never a payload, a body, a digest, a change, an actor or
 * a tenant identifier.
 */
export const DEAD_LETTER_TRANSITIONS = ['attempted', 'transfer_confirmed', 'transfer_unconfirmed'] as const;
export type DeadLetterTransition = (typeof DEAD_LETTER_TRANSITIONS)[number];
export const DEAD_LETTER_FAILURES = ['malformed', 'permanent', 'retries_exhausted'] as const;
export type DeadLetterFailureClass = (typeof DEAD_LETTER_FAILURES)[number];
export const COVERAGE_KINDS = ['started', 'heartbeat', 'stopped'] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

/** One transition of one physical transfer attempt, as the bus observed it. */
export interface NewDeadLetterTransition {
  attemptId: string;
  transition: DeadLetterTransition;
  instanceId: string;
  consumer: string;
  eventId: string;
  eventName: string;
  /** The delivery's source label as received: NOT verified identity. */
  source: string;
  failure: DeadLetterFailureClass;
  reason: string | null;
  errorClass: string;
  retryCount: number;
  replayCount: number;
  redelivered: boolean;
  observedAt: Date;
}

/** One coverage fact of one process instance (cumulative counters). */
export interface NewCoverageFact {
  instanceId: string;
  kind: CoverageKind;
  seq: number;
  consumers: readonly string[];
  observedTotal: number;
  persistedTotal: number;
  droppedOverflow: number;
  droppedSink: number;
  rejectedTotal: number;
  buffered: number;
  observedAt: Date;
}

export interface StoredDeadLetterTransition extends NewDeadLetterTransition { id: string; recordedAt: Date; recordedAtUs: string }
export interface StoredCoverageFact extends NewCoverageFact { id: string; recordedAt: Date; recordedAtUs: string }

/** What one flush stored: `stored` new rows, `duplicate` rows already present (idempotent), `rejected` rows the schema refused. */
export interface TransitionWriteOutcome { stored: number; duplicate: number; rejected: number }

/** A keyset position: the row's recorded time (microseconds since the epoch, exact) and id. */
export interface DiagnosticPosition { recordedAtUs: string; id: string }
