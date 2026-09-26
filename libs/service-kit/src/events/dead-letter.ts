/**
 * Names and message annotations shared by the RabbitMQ bus (which writes them) and the `nawara-dlq` tool (which reads them).
 * Topology per consumer queue `Q`: `Q` (work), `Q.retry` (delay queue, expires back into `Q`), `Q.dead` (durable dead-letter queue).
 */
export const deadQueueName = (queue: string): string => `${queue}.dead`;
export const retryQueueName = (queue: string): string => `${queue}.retry`;

/** Annotation headers. Names only, ids and counters: never payload data, secrets or error MESSAGES. */
export const HEADER = {
  retryCount: 'x-nawara-retry-count',
  replayCount: 'x-nawara-replay-count',
  replayedAt: 'x-nawara-replayed-at',
  /** Why it was dead-lettered: `malformed` (not an event at all), `permanent` (handler said so), `retries_exhausted`. */
  failure: 'x-nawara-failure',
  failureReason: 'x-nawara-failure-reason',
  failureError: 'x-nawara-failure-error',
  failedAt: 'x-nawara-failed-at',
  consumer: 'x-nawara-consumer',
  /** Stage 18.8: the dead-letter copy's body was replaced (a `deadLetterPolicy` said `redacted`); such a copy is never replayed. */
  bodyRedacted: 'x-nawara-body-redacted',
} as const;

export type FailureClass = 'malformed' | 'permanent' | 'retries_exhausted';

/** Broker bookkeeping that must not be copied onto a republished message (it would corrupt dead-letter cycle detection). */
const BROKER_HISTORY = ['x-death', 'x-first-death-exchange', 'x-first-death-queue', 'x-first-death-reason', 'x-last-death-exchange', 'x-last-death-queue', 'x-last-death-reason'];

export function withoutBrokerHistory(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const copy = { ...headers };
  for (const k of BROKER_HISTORY) delete copy[k];
  return copy;
}

/** Keeps a value that goes into a header or a log line to a short, predictable token. */
export function safeToken(value: unknown, pattern: RegExp, fallback: string): string {
  return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

export const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function counter(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}
