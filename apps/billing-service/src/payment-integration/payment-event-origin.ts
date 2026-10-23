import { Injectable } from '@nestjs/common';
import { DbService, PermanentEventFailure, type HandlerTrust } from '@nawara/service-kit';

/**
 * Core V2 S1e-2 (ADR-0057 §13.4, "S0-C6" H6): the envelope values Billing relies on, from a TRUSTED source only. The body is authenticated
 * by the provenance body commitment; these envelope values are not, so:
 * - a verified ORIGINAL (or its verified redelivery) supplies them from what the broker-verified producer published, and they are recorded
 *   here (migration 0018) BEFORE its financial processing;
 * - a verified REPLAY (a retry, an operator replay) never supplies them: they are read back from that record, never from its headers.
 * A replay with no record (an event recorded before 0018, or one whose original never got this far) is refused: nothing is invented, and
 * the reconciler, which asks Payment directly, still settles the request.
 */
export interface TrustedPaymentEnvelope {
  eventId: string;
  name: string;
  /** The broker-verified producer. */
  source: string;
  version: number;
  /** Exactly as the original published it: the settlement instant. */
  occurredAt: string;
  correlationId: string | null;
}

/** The ISO-8601 UTC form Payment publishes (`Date.prototype.toISOString`), and the only one 0018 stores. */
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

interface OriginRow {
  eventId: string;
  source: string;
  eventName: string;
  eventVersion: number;
  occurredAt: string;
  correlationId: string | null;
}
const fromRow = (r: OriginRow): TrustedPaymentEnvelope => ({ eventId: r.eventId, name: r.eventName, source: r.source, version: r.eventVersion, occurredAt: r.occurredAt, correlationId: r.correlationId });
const same = (a: TrustedPaymentEnvelope, b: TrustedPaymentEnvelope) =>
  a.eventId === b.eventId && a.name === b.name && a.source === b.source && a.version === b.version && a.occurredAt === b.occurredAt && a.correlationId === b.correlationId;

@Injectable()
export class PaymentEventOriginRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Records a verified original's values once (append-only). `recorded` / `same` (a verified redelivery, or a concurrent one: the loser of
   * the insert waits for the winner and compares); `contradicts` when a different value was already recorded for the event: a security
   * conflict, never an overwrite. Rejects on a database failure (transient: nothing financial has happened yet).
   */
  async recordVerified(t: TrustedPaymentEnvelope): Promise<'recorded' | 'same' | 'contradicts'> {
    const inserted = await this.db.query(
      `INSERT INTO payment_event_origin ("eventId", source, "eventName", "eventVersion", "occurredAt", "correlationId") VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("eventId") DO NOTHING RETURNING "eventId"`,
      [t.eventId, t.source, t.name, t.version, t.occurredAt, t.correlationId],
    );
    if (inserted.rowCount === 1) return 'recorded';
    const stored = await this.find(t.eventId);
    return stored && same(stored, t) ? 'same' : 'contradicts';
  }

  /** The recorded values of one event, or undefined. Rejects on a database failure. */
  async find(eventId: string): Promise<TrustedPaymentEnvelope | undefined> {
    const { rows } = await this.db.query<OriginRow>(
      `SELECT "eventId", source, "eventName", "eventVersion", "occurredAt", "correlationId" FROM payment_event_origin WHERE "eventId" = $1`,
      [eventId],
    );
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
}

/**
 * The trusted envelope of one delivery Billing's strict subscription accepted. Throws a `PermanentEventFailure` (dead-lettered at once,
 * before any receipt or financial effect) when there is no acceptable trust, when a verified original lacks a value Billing needs, when it
 * contradicts the recorded values, or when a replay has no recorded values; any other error is a database failure (transient).
 */
export async function trustedEnvelope(trust: HandlerTrust | undefined, origins: PaymentEventOriginRepository, supportedVersion: (name: string) => number | undefined): Promise<TrustedPaymentEnvelope> {
  // strict enforcement only ever hands Billing an `accept`: anything else (no decision at all, compatibility) is never processed here
  if (trust?.decision !== 'accept') throw new PermanentEventFailure('untrusted_no_decision');
  const o = trust.origin;
  if (o.from === 'verified_delivery') {
    if (!o.occurredAt.available || !OCCURRED_AT.test(o.occurredAt.value) || Number.isNaN(new Date(o.occurredAt.value).getTime())) throw new PermanentEventFailure('malformed_payload');
    if (!o.version.available) throw new PermanentEventFailure('malformed_payload');
    // recorded as published (as the receipt always recorded it), within 0018's bound; anything else falls back to `event:<id>` as before
    const correlationId = o.correlationId.available && o.correlationId.value.length >= 1 && o.correlationId.value.length <= 128 ? o.correlationId.value : null;
    const t: TrustedPaymentEnvelope = { eventId: o.eventId, name: o.name, source: o.source, version: o.version.value, occurredAt: o.occurredAt.value, correlationId };
    if (supportedVersion(t.name) !== t.version) return t; // refused by the caller (unsupported version) before anything is recorded
    if ((await origins.recordVerified(t)) === 'contradicts') throw new PermanentEventFailure('untrusted_origin_conflict');
    return t;
  }
  // a verified replay: the stored original's values, never this delivery's headers
  const stored = await origins.find(o.eventId);
  if (!stored || stored.source !== o.source || stored.name !== o.name) throw new PermanentEventFailure('untrusted_origin_unavailable');
  return stored;
}
