import { createHash } from 'node:crypto';
import { HttpException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { AttemptService } from '../attempts/attempt.service.js';
import { webhookContext } from '../events/payment-events.js';
import type { AttemptRow } from '../attempts/attempt.types.js';
import type { FetchStatusResult, PaymentProvider, RefundStatusResult } from '../providers/provider.port.js';
import { RefundEvidenceService } from '../refunds/refund-evidence.service.js';
import { DisputeIngestionService } from '../disputes/dispute-ingestion.service.js';
import { isDisputeNotificationType, parseDisputeNotice } from '../disputes/dispute.types.js';
import type { WebhookEventRow } from './webhook-event.types.js';
import { CORE_V2_LIVE_MODE } from '../payments/payment.types.js';

export interface WebhookResult {
  /** The HTTP status the controller should answer with. */
  status: number;
}

const CONFLICT_CODES = new Set(['provider_error', 'invalid_state_transition']);

/**
 * Core V2 S6h (R6H-3, FC-1): how long a VERIFIED money notification may stay unmatched before Payment keeps it as an unmatched provider fact.
 * A notification can legitimately beat the commit of its own attempt (SDD section 12): within this window the retrier simply revisits it, so
 * an ordinary race never becomes a reconciliation item. Past it, the movement is preserved as evidence (and the retrier still revisits it).
 */
export const UNMATCHED_FACT_GRACE_MS = 5 * 60_000;

/**
 * The webhook pipeline (SDD section 7): verify -> persist (transaction A, deduplicated) -> process
 * (transaction B, reusing AttemptService.applyStatus — the SAME transition rules `sync` and the resolver use).
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    private readonly attempts: AttemptService,
    /** Core V2 S6b: present only where refunds are configured (never production); without it a refund notification is never applied. */
    @Optional() @Inject(RefundEvidenceService) private readonly refunds?: RefundEvidenceService,
    /** Core V2 S6e-D: present only where disputes are configured (never production); without it a dispute notification is never applied. */
    @Optional() @Inject(DisputeIngestionService) private readonly disputes?: DisputeIngestionService,
  ) {}

  async receive(provider: PaymentProvider, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
    const verified = await provider.verifyWebhook(rawBody, headers);
    if (!verified.signatureValid) {
      // Counted and logged so forged calls are visible to operators (SDD section 7); never the body or the signature.
      this.logger.warn(`webhook signature rejected for provider ${provider.id}`);
      return { status: 401 };
    }

    // Transaction A: deduplicated insert. A conflicting row that already reached a terminal outcome is a pure no-op;
    // one left mid-flight (a crash between A and B) is reprocessed, never swallowed.
    const eventType = verified.parsed?.type ?? 'unknown';
    const providerEventId = verified.parsed?.providerEventId ?? `unparseable:${hashOf(rawBody)}`;
    const inserted = await this.db.tx(async (q) => {
      try {
        const { rows } = await q.query<WebhookEventRow>(
          `INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody") VALUES ($1,$2,$3,$4) RETURNING *`,
          [provider.id, providerEventId, eventType, rawBody],
        );
        return rows[0];
      } catch (e) {
        if (!isUniqueViolation(e, 'webhook_event_provider_id_unique')) throw e;
        return null;
      }
    });

    let event = inserted;
    if (!event) {
      const { rows } = await this.db.query<WebhookEventRow>(`SELECT * FROM webhook_event WHERE provider = $1 AND "providerEventId" = $2`, [provider.id, providerEventId]);
      event = rows[0];
      if (event.state === 'processed' || event.state === 'ignored' || event.state === 'conflict') return { status: 200 };
      // otherwise (received/processing/failed/unmatched): fall through and re-run processing
    }

    if (verified.parsed === null) {
      await this.markState(event.id, 'failed', 'malformed_body');
      return { status: 200 }; // stop the provider from retrying: this will never parse differently
    }

    return this.process(event.id, provider, verified.parsed);
  }

  /** Used by the retrier: the signature was already verified when the row was stored, so this only re-derives the
   * parsed shape from the stored bytes (never re-authenticates — the body cannot have changed since receipt). `claim` is the
   * retrier's transaction holding this row's lock (Stage 14.6): the row's state is written through it, so no other worker can
   * reprocess the same event meanwhile. */
  async reprocess(event: WebhookEventRow, provider: PaymentProvider, claim?: Queryable): Promise<WebhookResult> {
    const parsed = provider.parseStoredBody(event.rawBody);
    if (parsed === null) {
      await this.markState(event.id, 'failed', 'malformed_body', undefined, claim);
      return { status: 200 };
    }
    return this.process(event.id, provider, parsed, claim);
  }

  private async process(
    eventId: string,
    provider: PaymentProvider,
    parsed: { providerEventId: string; type: string; reference: string; amount?: number; currency?: string; data: unknown; providerTransactionId?: string; providerOccurredAt?: Date },
    claim?: Queryable,
  ): Promise<WebhookResult> {
    if (parsed.type.startsWith('refund.')) return this.processRefund(eventId, provider, parsed, claim);
    if (isDisputeNotificationType(parsed.type)) return this.processDispute(eventId, provider, parsed, claim);
    const status = this.toStatus(parsed);
    if (!status) {
      await this.markState(eventId, 'ignored', `unknown_event_type:${parsed.type}`, undefined, claim);
      return { status: 200 };
    }

    const attempt = await this.findAttemptByReference(provider.id, parsed.reference);
    if (!attempt) {
      const factId = status.kind === 'succeeded' ? await this.recordUnmatchedFact(eventId, provider, 'capture', parsed) : null;
      await this.markState(eventId, 'unmatched', factId ? `unmatched_fact:${factId}` : null, undefined, claim);
      return { status: 200 }; // the resolver/retrier revisits this — the record may not be visible yet
    }

    try {
      await this.attempts.applyStatus(attempt.id, status, provider, webhookContext(provider.id, eventId));
      await this.markState(eventId, 'processed', null, attempt.id, claim);
      return { status: 200 };
    } catch (e) {
      const code = e instanceof HttpException ? (e.getResponse() as { code?: string })?.code : undefined;
      if (code && CONFLICT_CODES.has(code)) {
        this.logger.warn(`webhook conflict for attempt ${attempt.id}: ${code}`);
        await this.markState(eventId, 'conflict', code, attempt.id, claim);
        return { status: 200 }; // recorded; a human resolves it (SDD section 5.1 "late success" safety net)
      }
      await this.markState(eventId, 'failed', 'transient_error', attempt.id, claim);
      return { status: 500 }; // transient: let the provider retry
    }
  }

  /**
   * Core V2 S6b (register PAY-05, PAY-07; R6B-5): a verified refund notification, through the same pipeline (signature, permanent event key,
   * then evidence). It names one refund attempt OF THIS PROVIDER (its key or its provider refund reference); the evidence rules are
   * `RefundEvidenceService`'s. Where refunds are not configured nothing is applied (`ignored`).
   */
  private async processRefund(
    eventId: string,
    provider: PaymentProvider,
    parsed: { type: string; reference: string; amount?: number; currency?: string; data: unknown; providerTransactionId?: string; providerOccurredAt?: Date },
    claim?: Queryable,
  ): Promise<WebhookResult> {
    const status = toRefundStatus(parsed);
    if (!this.refunds || !status) {
      await this.markState(eventId, 'ignored', this.refunds ? `unknown_event_type:${parsed.type}` : 'refunds_not_enabled', undefined, claim);
      return { status: 200 };
    }
    const attempt = await this.refunds.findByReference(provider.id, parsed.reference);
    if (!attempt) {
      const factId = status.kind === 'succeeded' ? await this.recordUnmatchedFact(eventId, provider, 'refund', parsed) : null;
      await this.markState(eventId, 'unmatched', factId ? `unmatched_fact:${factId}` : null, undefined, claim);
      return { status: 200 };
    }
    try {
      await this.refunds.apply(attempt.id, status, webhookContext(provider.id, eventId));
      await this.markState(eventId, 'processed', `refund_attempt:${attempt.id}`, undefined, claim);
      return { status: 200 };
    } catch {
      await this.markState(eventId, 'failed', 'transient_error', undefined, claim);
      return { status: 500 };
    }
  }

  /**
   * Core V2 S6e-D (register PAY-09, EVT-03; R6E-2): a verified dispute notification, through the same pipeline (signature, permanent event key),
   * then `DisputeIngestionService`'s rules. It names the disputed attempt OF THIS PROVIDER. A notification Payment cannot read is kept as a
   * `conflict` (never retried, never applied); a preserved dispute conflict is a `conflict` too. Without disputes configured: `ignored`.
   */
  private async processDispute(
    eventId: string,
    provider: PaymentProvider,
    parsed: { type: string; reference: string; amount?: number; currency?: string; data: unknown; providerOccurredAt?: Date },
    claim?: Queryable,
  ): Promise<WebhookResult> {
    if (!this.disputes) {
      await this.markState(eventId, 'ignored', 'disputes_not_enabled', undefined, claim);
      return { status: 200 };
    }
    const notice = parseDisputeNotice(parsed);
    if (!notice) {
      await this.markState(eventId, 'conflict', 'malformed_dispute', undefined, claim);
      return { status: 200 };
    }
    try {
      const r = await this.disputes.ingest(eventId, provider.id, parsed.reference, notice, webhookContext(provider.id, eventId));
      await this.markState(eventId, r.state, r.outcome, r.attemptId, claim);
      return { status: 200 };
    } catch (e) {
      this.logger.warn(`dispute notification ${eventId} failed transiently: ${(e as Error).message}`);
      await this.markState(eventId, 'failed', 'transient_error', undefined, claim);
      return { status: 500 };
    }
  }

  /**
   * Core V2 S6h (register PAY-13; R6H-3, FC-1): a VERIFIED money notification (its signature was checked when it was stored) that still names
   * no attempt of this provider once the grace window has passed is kept as an UNMATCHED provider fact: its provider transaction identity,
   * kind, amount and currency exactly as the provider reported them, and the webhook it came from. No payment, attempt, refund or entitlement
   * changes; the Owner may later associate it (PAY-13). Identical redeliveries are the same fact; a notification without a provider
   * transaction reference, amount or currency cannot be keyed and stays an unmatched notification only. Returns the fact id, or null.
   */
  private async recordUnmatchedFact(eventId: string, provider: PaymentProvider, kind: 'capture' | 'refund',
    parsed: { amount?: number; currency?: string; providerTransactionId?: string; providerOccurredAt?: Date }): Promise<string | null> {
    if (!parsed.providerTransactionId || typeof parsed.amount !== 'number' || !Number.isSafeInteger(parsed.amount) || parsed.amount < 1 || typeof parsed.currency !== 'string') return null;
    const { rows: due } = await this.db.query(`SELECT 1 FROM webhook_event WHERE id = $1 AND "receivedAt" <= now() - make_interval(secs => $2)`, [eventId, UNMATCHED_FACT_GRACE_MS / 1000]);
    if (due.length === 0) return null;
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, amount, currency, "liveMode", source, "webhookEventId", "providerOccurredAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'webhook', $7, $8) ON CONFLICT ON CONSTRAINT provider_transaction_fact_identity DO NOTHING RETURNING id`,
      [provider.id, parsed.providerTransactionId, kind, parsed.amount, parsed.currency, CORE_V2_LIVE_MODE, eventId, parsed.providerOccurredAt ?? null],
    );
    const id = rows[0]?.id ?? (await this.db.query<{ id: string }>(
      `SELECT id FROM provider_transaction_fact WHERE provider = $1 AND "providerTxnId" = $2 AND kind = $3`, [provider.id, parsed.providerTransactionId, kind])).rows[0]?.id ?? null;
    if (rows[0]) this.logger.warn(`provider_fact_unmatched fact=${rows[0].id} provider=${provider.id} kind=${kind} — a verified movement names no attempt; kept for reconciliation (S6h)`);
    return id;
  }

  private toStatus(parsed: { type: string; amount?: number; currency?: string; data: unknown; providerTransactionId?: string; providerOccurredAt?: Date }): FetchStatusResult | null {
    if (parsed.type === 'payment.succeeded') {
      if (typeof parsed.amount !== 'number' || typeof parsed.currency !== 'string') return null;
      return { kind: 'succeeded', amount: parsed.amount, currency: parsed.currency, providerTransactionId: parsed.providerTransactionId, providerOccurredAt: parsed.providerOccurredAt };
    }
    if (parsed.type === 'payment.failed') {
      const data = (parsed.data ?? {}) as { failureCode?: string; failureClass?: string };
      return { kind: 'failed', failureClass: data.failureClass === 'retryable' ? 'retryable' : 'terminal', failureCode: data.failureCode ?? 'unknown' };
    }
    if (parsed.type === 'payment.expired') return { kind: 'expired' }; // Core V2 S4f (F-S4): a provider-confirmed session expiry
    return null;
  }

  /** Scoped to the provider whose signature was verified: a valid signature from one provider must never be able to settle
   * an attempt that belongs to another (FI-09 identifies a provider transaction by `(provider, providerTransactionId)`). */
  private async findAttemptByReference(providerId: string, reference: string): Promise<AttemptRow | null> {
    // merchantReference is a generated column always equal to id (SDD section 4.2), so matching on id covers both.
    const { rows } = await this.db.query<AttemptRow>(`SELECT * FROM payment_attempt WHERE provider = $1 AND ("providerTransactionId" = $2 OR id::text = $2)`, [providerId, reference]);
    return rows[0] ?? null;
  }

  private async markState(id: string, state: WebhookEventRow['state'], outcome: string | null, matchedAttemptId?: string, claim?: Queryable): Promise<void> {
    await (claim ?? this.db).query(
      `UPDATE webhook_event SET state = $2, outcome = $3, attempts = attempts + 1, "processedAt" = CASE WHEN $2 IN ('processed','ignored','conflict') THEN now() ELSE "processedAt" END, "matchedAttemptId" = COALESCE($4, "matchedAttemptId") WHERE id = $1`,
      [id, state, outcome, matchedAttemptId ?? null],
    );
  }
}

/** Core V2 S6b: a refund notification's claim, as the port's status shape; a success without amount, currency or reference is not one. */
function toRefundStatus(parsed: { type: string; amount?: number; currency?: string; data: unknown; providerTransactionId?: string; providerOccurredAt?: Date }): RefundStatusResult | null {
  if (parsed.type === 'refund.succeeded') {
    if (typeof parsed.amount !== 'number' || typeof parsed.currency !== 'string' || !parsed.providerTransactionId) return null;
    return { kind: 'succeeded', amount: parsed.amount, currency: parsed.currency, providerRefundId: parsed.providerTransactionId, providerOccurredAt: parsed.providerOccurredAt };
  }
  if (parsed.type === 'refund.failed') {
    const data = (parsed.data ?? {}) as { failureCode?: unknown };
    return { kind: 'failed', failureCode: typeof data.failureCode === 'string' ? data.failureCode : 'provider_failure', providerRefundId: parsed.providerTransactionId };
  }
  return null;
}

function hashOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
