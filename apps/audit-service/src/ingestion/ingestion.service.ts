import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditContractError } from '@nawara/audit-contract';
import { validateAuditEvent } from '@nawara/audit-contract/consumer';
import { PermanentEventFailure, type EventEnvelope } from '@nawara/service-kit';
import { SERVICE_NAME } from '../config/audit-config.js';
import { toNewAuditRecord } from '../persistence/audit-record.mapper.js';
import { AuditRecordRepository, sameEvidence } from '../persistence/audit-record.repository.js';
import { AuditPersistenceError } from '../persistence/persistence-error.js';
import { CLOCK_SKEW_TOLERANCE_MS } from './ingestion.constants.js';
import { IngestionCounters, type IngestionRefusal } from './ingestion-counters.js';

export type IngestOutcome = 'persisted' | 'duplicate';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An id reaches a log line only when it is a canonical UUID (anything else is attacker-shaped input). */
const safeId = (v: unknown): string => (typeof v === 'string' && UUID.test(v) ? v : '-');

/**
 * The ingestion of ONE delivered audit event (Stage 18.5). The only path by which a record is written:
 *
 *   1. `validateAuditEvent` (the SAME `@nawara/audit-contract` validator the producers' writer runs): envelope, event type = `audit.` +
 *      action, supported version, the whole payload, and PRODUCER ADMISSION (the envelope `source` must be the action's catalog producer);
 *      the category comes from the catalog, never from the wire;
 *   2. `toNewAuditRecord` (the one Stage 18.4 mapping);
 *   3. `AuditRecordRepository.insertOnce`: ONE autocommit statement (`INSERT … ON CONFLICT (sourceService, eventId) DO NOTHING`), so the
 *      record is durable when it returns; `recordedAt` is the database clock;
 *   4. a duplicate is compared with `sameEvidence` (every stored evidence field): equal → an idempotent success; different → the stored
 *      record stays as it is and the delivery is refused `event_id_conflict`.
 *
 * Classification (what the kit bus then does): a contract refusal, a conflict or a record the schema refuses throws
 * `PermanentEventFailure(<reason>)` → dead-lettered at once with that reason, never retried; any other error (database unreachable,
 * timeout, a dropped connection) propagates as is → the kit retries it (3 × 5 s by default), then dead-letters it `retries_exhausted`.
 * Returning = the kit ACKs; so a delivery is acknowledged only after its record is committed (or proven already stored).
 *
 * Logs carry the refusal reason, the validated action and source, and the event id only when it is a canonical UUID: never the payload,
 * a change value, an actor / organization / resource id, or a header value that was not validated.
 */
@Injectable()
export class IngestionService {
  private readonly log = new Logger('AuditIngestion');

  constructor(
    @Inject(AuditRecordRepository) private readonly records: AuditRecordRepository,
    @Inject(IngestionCounters) private readonly counters: IngestionCounters,
  ) {}

  async ingest(event: EventEnvelope): Promise<IngestOutcome> {
    const release = this.counters.enter();
    this.counters.bump('received');
    try {
      return await this.run(event);
    } finally {
      release();
    }
  }

  private async run(event: EventEnvelope): Promise<IngestOutcome> {
    let validated;
    try {
      validated = validateAuditEvent(event);
    } catch (e) {
      if (e instanceof AuditContractError) throw this.refuse(e.code, `eventId=${safeId(event?.id)}`);
      throw e;
    }
    // Stage 18.6: audit-service's own action (`platform_query.executed`) is written by audit-service itself, directly, never over the bus.
    // A delivered event claiming audit-service as its source is therefore a spoof (the broker credentials are shared, P-A1): refused.
    if (validated.sourceService === SERVICE_NAME) throw this.refuse('producer_not_admitted', `eventId=${validated.eventId}`);
    const record = toNewAuditRecord(validated);
    const who = `eventId=${validated.eventId} action=${validated.payload.action} source=${validated.sourceService}`;

    let outcome;
    try {
      outcome = await this.records.insertOnce(record);
    } catch (e) {
      // The contract is at least as strict as every CHECK of the table (Stage 18.4 proves it per action), so this is a drift, never a
      // transient fault: dead-lettered, not retried.
      if (e instanceof AuditPersistenceError) throw this.refuse('invalid_record', who);
      this.counters.bump('transient_failure');
      // Stage 18.9: during a long database outage every retry attempt fails here: counted always, logged within the budget.
      if (this.counters.mayLog('transient')) this.log.warn(`audit_ingest_transient_failure ${who} error=${e instanceof Error ? e.name : 'Error'} — not acknowledged; the kit retries it`);
      throw e;
    }

    if (outcome.kind === 'duplicate') {
      if (!sameEvidence(outcome.existing, record)) throw this.refuse('event_id_conflict', who); // the stored record is never touched
      this.counters.bump('duplicate');
      this.log.log(`audit_event_duplicate ${who} — already stored with the same evidence; acknowledged`);
      return 'duplicate';
    }

    const stored = outcome.record;
    this.counters.bump('persisted');
    const lagMs = stored.recordedAt.getTime() - stored.occurredAt.getTime();
    this.counters.observeLag(lagMs);
    if (-lagMs > CLOCK_SKEW_TOLERANCE_MS) {
      // Stored exactly as sent (A22): observed, never corrected.
      this.counters.bump('clock_skew_future');
      this.log.warn(`audit_clock_skew ${who} aheadSeconds=${Math.round(-lagMs / 1000)} — occurredAt is later than Audit's clock; stored as sent`);
    }
    this.log.log(`audit_event_persisted ${who} lagMs=${lagMs}`);
    return 'persisted';
  }

  private refuse(reason: IngestionRefusal, who: string): PermanentEventFailure {
    this.counters.refused(reason);
    // Stage 18.9: counted always; logged within a per-reason budget (a flood of refused messages is not a log storm).
    if (this.counters.mayLog(`refused:${reason}`)) this.log.warn(`audit_event_refused reason=${reason} ${who} — dead-lettered, not retried`);
    return new PermanentEventFailure(reason);
  }
}
