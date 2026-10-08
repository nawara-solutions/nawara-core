import type { Queryable } from '../db/db.service.js';

/**
 * V2 A3M.5 (ADR-0057 §10, Proposed; A3M record §14): the manual retention of PUBLISHED outbox rows. Nothing here runs by itself: the
 * `nawara-outbox-retention` CLI calls it, dry-run unless told to apply, with an age the operator must give (no default exists).
 *
 * What may be deleted, all conditions together:
 * - the service is on `OUTBOX_RETENTION_VERIFIED_SERVICES` (deny by default; the CLI also checks that the database is the one
 *   provisioned for that service);
 * - the row is PUBLISHED (`publishedAt` set): the relay reads unpublished rows only and never re-reads a published one. An unpublished
 *   row is the only copy of an undelivered event and is never eligible, whatever its age;
 * - it was published before the cutoff (`now() - olderThan`);
 * - its id is a RANDOM uuid (version 4). A producer that derives its event id (version 5: Payment, Billing, File, Release) relies on
 *   the outbox row to write a repeated operation's event once; deleting that row would let the operation publish the id again. Such
 *   rows are protected, with no option to include them: making a deterministic-id producer eligible is a separate architecture decision.
 *   A random id is NOT in itself evidence of safety: a producer could supply a stable version-4 id and rely on the outbox for it. That is
 *   why eligibility is also a reviewed list of services, and why `check:repo` refuses a listed service that supplies or derives an id.
 *
 * Bounded and safe beside the relay and Auth's code-event purge: each batch is one statement that locks only the rows it deletes and
 * skips rows another session holds (`FOR UPDATE SKIP LOCKED`). No retry: an error ends the run and the next manual run resumes.
 */
export interface OutboxRetentionOptions {
  /** Rows published longer ago than this are eligible. Required; there is no default. */
  olderThanMs: number;
  batchSize: number;
  maxBatches: number;
}

export interface OutboxInspection {
  /** Published before the cutoff, random id: what an apply run would delete (given enough batches). */
  eligible: number;
  /** Published before the cutoff, deterministic id: protected, never deleted. */
  protectedDeterministic: number;
  /** Published after the cutoff: kept for now. */
  retainedRecent: number;
  /** Not published: never eligible. */
  unpublished: number;
  /** Age in whole seconds of the oldest eligible row's publication, or null when none is eligible. */
  oldestEligibleAgeSeconds: number | null;
}

export interface OutboxRetentionResult {
  deleted: number;
  batches: number;
  /** True when the run stopped at `maxBatches` with a full last batch: eligible rows may remain for the next run. */
  more: boolean;
}

/**
 * The services whose published outbox rows may be deleted by the manual retention. Deny by default: a service is added here only after
 * a retention-safety review of how it produces its event ids (A3M record §14), and `check:repo` pins this list and checks that each
 * listed service still lets the outbox generate its ids. Anything else is refused before a connection is opened.
 */
export const OUTBOX_RETENTION_VERIFIED_SERVICES = ['auth-service', 'organization-service'] as const;
export type RetentionService = (typeof OUTBOX_RETENTION_VERIFIED_SERVICES)[number];
export const isRetentionService = (name: string): name is RetentionService => (OUTBOX_RETENTION_VERIFIED_SERVICES as readonly string[]).includes(name);

/**
 * The role that owns a service's database (ADR-0032; `infra/postgres/init/01-service-databases.sh` and the provisioning scripts):
 * `<svc>_migrator`. Ownership is set when the database is provisioned and a runtime role cannot change it, so it ties a database to
 * its service better than any argument can.
 */
export const retentionDatabaseOwner = (service: RetentionService): string => `${service.replace(/-service$/, '').replace(/-/g, '_')}_migrator`;

export const OUTBOX_RETENTION_BOUNDS = { batchSize: { min: 1, max: 5000 }, maxBatches: { min: 1, max: 1000 } } as const;

/** `30d`, `12h` or `45m`: a positive whole number and one unit. Returns milliseconds, or undefined when the text is not an age. */
export function parseRetentionAge(text: string): number | undefined {
  const m = /^([1-9][0-9]{0,5})([dhm])$/.exec(text);
  if (!m) return undefined;
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
}

/** The id is a random (version 4) uuid: the 15th character of its text form is the version. */
const RANDOM_ID = `substring(id::text from 15 for 1) = '4'`;
const BEFORE_CUTOFF = `"publishedAt" IS NOT NULL AND "publishedAt" < now() - ($1::bigint * interval '1 millisecond')`;

function assertOptions(o: OutboxRetentionOptions): void {
  if (!Number.isSafeInteger(o.olderThanMs) || o.olderThanMs < 1) throw new Error('olderThanMs must be a positive integer');
  for (const k of ['batchSize', 'maxBatches'] as const) {
    const { min, max } = OUTBOX_RETENTION_BOUNDS[k];
    if (!Number.isSafeInteger(o[k]) || o[k] < min || o[k] > max) throw new Error(`${k} must be an integer between ${min} and ${max}`);
  }
}

/** Counts only: reads the outbox and changes nothing. */
export async function inspectOutboxRetention(q: Queryable, olderThanMs: number): Promise<OutboxInspection> {
  assertOptions({ olderThanMs, batchSize: 1, maxBatches: 1 });
  const { rows } = await q.query<{ eligible: string; protected_deterministic: string; retained_recent: string; unpublished: string; oldest: number | null }>(
    `SELECT count(*) FILTER (WHERE ${BEFORE_CUTOFF} AND ${RANDOM_ID})::bigint AS eligible,
            count(*) FILTER (WHERE ${BEFORE_CUTOFF} AND NOT (${RANDOM_ID}))::bigint AS protected_deterministic,
            count(*) FILTER (WHERE "publishedAt" IS NOT NULL AND NOT (${BEFORE_CUTOFF}))::bigint AS retained_recent,
            count(*) FILTER (WHERE "publishedAt" IS NULL)::bigint AS unpublished,
            EXTRACT(EPOCH FROM (now() - min("publishedAt") FILTER (WHERE ${BEFORE_CUTOFF} AND ${RANDOM_ID})))::int AS oldest
       FROM outbox`,
    [olderThanMs],
  );
  const r = rows[0];
  return {
    eligible: Number(r?.eligible ?? 0),
    protectedDeterministic: Number(r?.protected_deterministic ?? 0),
    retainedRecent: Number(r?.retained_recent ?? 0),
    unpublished: Number(r?.unpublished ?? 0),
    oldestEligibleAgeSeconds: r?.oldest ?? null,
  };
}

/** Deletes eligible rows, oldest first, in at most `maxBatches` statements of at most `batchSize` rows. */
export async function applyOutboxRetention(q: Queryable, options: OutboxRetentionOptions): Promise<OutboxRetentionResult> {
  assertOptions(options);
  let deleted = 0;
  let batches = 0;
  let last = 0;
  while (batches < options.maxBatches) {
    const r = await q.query(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox
          WHERE ${BEFORE_CUTOFF} AND ${RANDOM_ID}
          ORDER BY "publishedAt"
          LIMIT $2
          FOR UPDATE SKIP LOCKED)`,
      [options.olderThanMs, options.batchSize],
    );
    last = r.rowCount ?? 0;
    batches++;
    deleted += last;
    if (last < options.batchSize) break;
  }
  return { deleted, batches, more: batches === options.maxBatches && last === options.batchSize };
}
