/**
 * The ingestion topology (ADR-0049 A20, Stage 18.1 §8): the kit's durable topic exchange `nawara.events`, one durable work queue
 * `audit-service.audit` bound ONLY to `audit.#` (every cataloged event type is `audit.<action>`; no domain event reaches it), and the
 * kit's per-queue `audit-service.audit.retry` (delay) and `audit-service.audit.dead` (dead letters). Architecture, not configuration.
 */
export const AUDIT_EXCHANGE = 'nawara.events';
export const AUDIT_QUEUE = 'audit-service.audit';
export const AUDIT_BINDINGS: readonly string[] = Object.freeze(['audit.#']);

/**
 * Unacknowledged deliveries per consumer channel: half the database pool, 1–10 (the Stage 15.8 rule the kit documents and Notification
 * applies): each in-flight delivery holds at most one pool client, so a backlog can never take the whole pool, and memory holds at most
 * this many messages (each ≤ the broker's message size bound) no matter how deep the queue is.
 */
export const consumerPrefetch = (poolMax: number): number => Math.min(10, Math.max(1, Math.floor(poolMax / 2)));

/**
 * A22: an `occurredAt` more than 5 minutes AFTER Audit's own `recordedAt` is a producer clock fault. It is stored exactly as sent
 * (evidence is never discarded or rewritten for a clock fault) and counted. A far-past `occurredAt` is normal (backlog, replay) and only
 * shows in the ingestion-lag statistics.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/** The `audit_ops_snapshot` interval (the File / Notification operational-snapshot pattern). */
export const OPS_SNAPSHOT_INTERVAL_MS = 60_000;
