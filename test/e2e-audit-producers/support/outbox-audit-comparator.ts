import pg from 'pg';
import { AUDIT_CATALOG } from '@nawara/audit-contract';
import { HEARTBEAT_MISSING_AFTER_MS, deadLetterVerdicts, type CoverageFact, type DeadLetterVerdict, type TransitionFact } from './dead-letter-verdicts.js';

/**
 * Core V2 G6-D (DO-69; the Owner's G6-D GO, 2026-11-19): a READ-ONLY, development and certification comparator of ONE producer's audit outbox with
 * audit-service's `audit_record`. It is a test tool: never mounted in a service, never pointed at production, and it writes, replays, deletes,
 * requeues and redelivers nothing. It reads identifiers and times only (event id, action name, publication and occurrence times, the source
 * service): never a payload, a change, an actor or an Organization, so its report exposes nothing of any tenant.
 *
 * Identity boundaries: one producer database (its kit `outbox`) and one audit database; `audit_record` rows are matched only within
 * `"sourceService" = source`, so another producer's records are never read as this producer's.
 *
 * Classes (per event id):
 *   present         published, and recorded by Audit
 *   missing         published before the grace window, absent from Audit, and NOT explained by dead-letter evidence or Audit retention:
 *                   a diagnostic failure only when both sides' evidence is available (it is never proof of permanent loss)
 *   dead_lettered   absent from Audit and named by the caller's dead-letter evidence (redacted copies are not replayable evidence)
 *   within_grace    published inside the grace window: not yet decidable
 *   unverifiable    the evidence needed was removed by retention: Audit's own retention of the action's category reached its occurrence
 *                   time, or (an Audit record with no outbox row) the producer's outbox retention horizon reached it
 *   not_eligible    not yet published (the relay has not sent it): no destination expected yet
 *   orphan          recorded by Audit as this source with no outbox row, inside the producer's retention horizon (a diagnostic)
 *   coverage_unknown  Core V2 DO-43c: absent from Audit past grace, and Audit's dead-letter observations cannot say whether it was dead-lettered
 *                   (coverage not established, or a transfer attempt without a recorded outcome): a stated limitation, never `missing`
 *                   and never `dead_lettered`
 *
 * Core V2 DO-43c: with `deadLetterVerdicts` (from audit-service's best-effort observations, `dead-letter-verdicts.ts`), ONLY a `confirmed`
 * verdict explains an absence as `dead_lettered`; `unconfirmed` and `not_observed` leave it `missing` (a copy that was not confirmed was
 * requeued; `not_observed` is not proof of anything); `within_grace`, `unresolved` and `coverage_unknown` make it `coverage_unknown`. Each
 * such row also carries its dead-letter verdict.
 */
export type ComparisonClass = 'present' | 'missing' | 'dead_lettered' | 'within_grace' | 'unverifiable' | 'not_eligible' | 'orphan' | 'coverage_unknown';

export interface OutboxAuditRow { id: string; name: string; occurredAt: Date; publishedAt: Date | null }
export interface AuditRecordRow { eventId: string; action: string; occurredAt: Date }

export interface ComparisonInput {
  outbox: readonly OutboxAuditRow[];
  audit: readonly AuditRecordRow[];
  now: Date;
  /** The development grace window after publication (the Owner's initial value: 5 minutes). A delay is not proof of loss. */
  graceMs: number;
  /** Audit's retention cutoff per category (the latest `audit_retention_run.cutoff`); a record older than it may have been deleted. */
  auditCutoffs: Readonly<Partial<Record<string, Date>>>;
  /** Dead-letter evidence from a NON-DESTRUCTIVE source (event ids). No such source is wired yet: empty means "not inspected". */
  deadLettered: ReadonlySet<string>;
  /** The producer's outbox retention horizon: rows published before it may have been deleted (null: the producer never deletes them). */
  producerRetainedSince: Date | null;
  /** Core V2 DO-43c: dead-letter verdicts per event id (only events absent from Audit need one). Absent: the dead-letter side is not consulted. */
  deadLetterVerdicts?: ReadonlyMap<string, DeadLetterVerdict>;
}

export interface ComparisonResult { eventId: string; action: string; class: ComparisonClass; deadLetter?: DeadLetterVerdict }

export const DEVELOPMENT_GRACE_MS = 5 * 60_000;

const actionOf = (name: string) => (name.startsWith('audit.') ? name.slice('audit.'.length) : null);
const categoryOf = (action: string) => (AUDIT_CATALOG.get(action as never) as { category?: string } | undefined)?.category ?? null;

/** Pure: the classification of every audit outbox row and every unmatched Audit record. */
export function classify(input: ComparisonInput): ComparisonResult[] {
  const recorded = new Map(input.audit.map((a) => [a.eventId, a]));
  const seen = new Set<string>();
  const out: ComparisonResult[] = [];
  for (const o of input.outbox) {
    const action = actionOf(o.name);
    if (action === null) continue; // a domain event, not an audit intent: outside this comparison
    seen.add(o.id);
    const verdict = input.deadLetterVerdicts?.get(o.id);
    const push = (c: ComparisonClass) => out.push({ eventId: o.id, action, class: c, ...(verdict && c !== 'present' && c !== 'not_eligible' ? { deadLetter: verdict } : {}) });
    if (recorded.has(o.id)) { push('present'); continue; }
    if (o.publishedAt === null) { push('not_eligible'); continue; }
    if (input.deadLettered.has(o.id) || verdict === 'confirmed') { push('dead_lettered'); continue; }
    const cutoff = (() => { const c = categoryOf(action); return c ? input.auditCutoffs[c] : undefined; })();
    if (cutoff && o.occurredAt < cutoff) { push('unverifiable'); continue; }
    if (input.now.getTime() - o.publishedAt.getTime() < input.graceMs) { push('within_grace'); continue; }
    if (input.deadLetterVerdicts && (verdict === undefined || verdict === 'within_grace' || verdict === 'unresolved' || verdict === 'coverage_unknown')) { push('coverage_unknown'); continue; }
    push('missing');
  }
  for (const a of input.audit) {
    if (seen.has(a.eventId)) continue;
    const retained = input.producerRetainedSince === null || a.occurredAt >= input.producerRetainedSince;
    out.push({ eventId: a.eventId, action: a.action, class: retained ? 'orphan' : 'unverifiable' });
  }
  return out;
}

/** The report's verdict: a diagnostic failure only for `missing` (and `orphan`, an Audit record this producer never wrote). */
export function failures(results: readonly ComparisonResult[]): ComparisonResult[] {
  return results.filter((r) => r.class === 'missing' || r.class === 'orphan');
}

/**
 * Reads both sides, in a window of occurrence times, through two READ ONLY transactions, then classifies. `source` is the producer's service
 * name as Audit records it (`audit_record."sourceService"`). Nothing is written to either database.
 */
export async function compare(o: {
  producerDbUrl: string; auditDbUrl: string; source: string; from: Date; to: Date; graceMs?: number; now?: Date;
  deadLettered?: ReadonlySet<string>; producerRetainedSince?: Date | null;
  /**
   * Core V2 DO-43c: read audit-service's dead-letter observations for the absent events. `expected` is the consumer instances established
   * OUTSIDE the Audit database (the processes the caller launched); without it every absence past grace is `coverage_unknown`.
   */
  deadLetterObservation?: { expected: ReadonlySet<string> | undefined; consumer?: string };
}): Promise<ComparisonResult[]> {
  const read = async <T>(url: string, sql: string, params: unknown[]): Promise<T[]> => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN TRANSACTION READ ONLY');
      const { rows } = await c.query(sql, params);
      await c.query('COMMIT');
      return rows as T[];
    } finally {
      await c.end();
    }
  };
  const [outbox, audit, cutoffs] = await Promise.all([
    read<OutboxAuditRow>(o.producerDbUrl, `SELECT id::text AS id, name, "occurredAt", "publishedAt" FROM outbox
      WHERE name LIKE 'audit.%' AND "occurredAt" >= $1 AND "occurredAt" < $2`, [o.from, o.to]),
    read<AuditRecordRow>(o.auditDbUrl, `SELECT "eventId"::text AS "eventId", action, "occurredAt" FROM audit_record
      WHERE "sourceService" = $1 AND "occurredAt" >= $2 AND "occurredAt" < $3`, [o.source, o.from, o.to]),
    read<{ category: string; cutoff: Date }>(o.auditDbUrl, `SELECT category, max(cutoff) AS cutoff FROM audit_retention_run GROUP BY category`, []),
  ]);
  const now = o.now ?? new Date();
  let verdicts: Map<string, DeadLetterVerdict> | undefined;
  if (o.deadLetterObservation) {
    const consumer = o.deadLetterObservation.consumer ?? 'audit-service.audit';
    const recorded = new Set(audit.map((a) => a.eventId));
    const absent = outbox.filter((x) => x.publishedAt !== null && !recorded.has(x.id)).map((x) => x.id);
    const [transitions, coverage] = await Promise.all([
      absent.length === 0 ? Promise.resolve([] as TransitionFact[]) : read<TransitionFact>(o.auditDbUrl, `SELECT "attemptId", transition, "instanceId", consumer, "eventId", "observedAt"
        FROM audit_dead_letter_transition WHERE consumer = $1 AND "eventId" = ANY($2::text[])`, [consumer, absent]),
      read<CoverageFact>(o.auditDbUrl, `SELECT "instanceId", kind, seq::int AS seq, consumers, "droppedOverflow"::float8 AS "droppedOverflow", "droppedSink"::float8 AS "droppedSink",
        "rejectedTotal"::float8 AS "rejectedTotal", buffered, "observedAt" FROM audit_dead_letter_coverage`, []),
    ]);
    // the window an absence could have been dead-lettered in, up to the last instant a heartbeat can already vouch for
    verdicts = deadLetterVerdicts({
      consumer, from: o.from, to: new Date(now.getTime() - HEARTBEAT_MISSING_AFTER_MS), now, expected: o.deadLetterObservation.expected, coverage, transitions, eventIds: absent,
    });
  }
  return classify({
    outbox, audit, now, graceMs: o.graceMs ?? DEVELOPMENT_GRACE_MS, ...(verdicts ? { deadLetterVerdicts: verdicts } : {}),
    auditCutoffs: Object.fromEntries(cutoffs.map((c) => [c.category, c.cutoff])), deadLettered: o.deadLettered ?? new Set(),
    producerRetainedSince: o.producerRetainedSince ?? null,
  });
}
