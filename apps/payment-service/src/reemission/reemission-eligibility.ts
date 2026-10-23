import {
  inspectReemissionEligibility, listMigrationFiles, migrationOwnership, reemissionPolicy, type DatabaseOwnership, type PublicationEvidence, type Queryable,
  type ReemissionEligibility,
} from '@nawara/service-kit';
import { EVENT_SOURCE } from '../events/event-catalog.js';

/**
 * Core V2 S1c-3 R2a (ADR-0057 §13.7 "S0-C4", Payment-first): Payment's INERT re-emission preparation. It answers one question, read-only:
 * would this outbox row pass the R1 foundation's row checks? It cannot authorize, record or publish anything: there is no authorizer, no
 * attempt writer and no publisher here, and `npm run check:repo` keeps Payment "eligibility-only" (none of the foundation's publishing,
 * authorizing or recording parts may be named in Payment's source). Publication is R2b, separately authorized.
 */

/** S0-C4: exactly these four Payment domain events, version 1. No pattern; Payment's audit events are not eligible. */
export const PAYMENT_REEMISSION_POLICY = reemissionPolicy(EVENT_SOURCE, [
  { name: 'payment.succeeded', version: 1 },
  { name: 'payment.failed', version: 1 },
  { name: 'payment.cancelled', version: 1 },
  { name: 'payment.expired', version: 1 },
]);

/**
 * Ownership evidence: every one of Payment's OWN migrations (the files shipped with this build, never kit migrations) is recorded in the
 * database with exactly its checksum. Never a service name a caller supplies.
 */
export function paymentDatabaseOwnership(migrationsDir: string): DatabaseOwnership {
  return migrationOwnership(listMigrationFiles([migrationsDir]).map((f) => ({ name: f.name, checksum: f.checksum })));
}

/**
 * The R2a publication evidence: NONE. Which build published a historical row is not recorded anywhere trustworthy yet, and the version of
 * the code running now proves nothing about it, so every row is `pipeline_unknown`. Establishing that evidence (its source, authority and
 * recording) is a separately authorized decision (R2b / R4); an operator-supplied commit or version is never accepted as evidence.
 */
export const UNESTABLISHED_PUBLICATION_EVIDENCE: PublicationEvidence = Object.freeze({
  pipelineVersionOf: async () => undefined,
});

/**
 * S0-C4 blocks a re-emission when an authoritative verified observation of the event is known to contradict it. Payment never reads a
 * consumer's database, and no trustworthy attestation of that absence exists yet, so the answer is always "unattested": NOT that a
 * conflict exists, NOT that none exists. Its source, authority, scope and validity are decided with R2b.
 */
export const CONFLICT_EVIDENCE_UNATTESTED = 'conflict_evidence_unattested';

/** Why a dry run is never executable in R2a, whatever the row's own eligibility. */
export const R2A_BLOCKERS = Object.freeze(['owner_authorization_unavailable', CONFLICT_EVIDENCE_UNATTESTED, 'publication_not_available'] as const);

export interface PaymentReemissionDryRun {
  mode: 'dry_run';
  /** The row checks only (`rowEligible: false` with a bounded reason, or the row's identity, version and pipeline). Never a payload. */
  row: ReemissionEligibility;
  conflictEvidence: typeof CONFLICT_EVIDENCE_UNATTESTED;
  /** Always false in R2a. */
  executable: false;
  blockers: readonly string[];
}

/**
 * The read-only inspection of ONE Payment outbox row (`{ eventId, eventName }` exactly). `evidence` is the fail-closed source unless a test
 * gives another; the CLI never does.
 */
export async function inspectPaymentReemission(
  deps: { db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> }; ownership: DatabaseOwnership; evidence?: PublicationEvidence },
  input: unknown,
): Promise<PaymentReemissionDryRun> {
  const row = await inspectReemissionEligibility(
    { policy: PAYMENT_REEMISSION_POLICY, db: deps.db, ownership: deps.ownership, evidence: deps.evidence ?? UNESTABLISHED_PUBLICATION_EVIDENCE },
    input,
  );
  return { mode: 'dry_run', row, conflictEvidence: CONFLICT_EVIDENCE_UNATTESTED, executable: false, blockers: R2A_BLOCKERS };
}
