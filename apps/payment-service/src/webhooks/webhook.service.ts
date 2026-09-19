import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation } from '@nawara/service-kit';
import { AttemptService } from '../attempts/attempt.service.js';
import type { AttemptRow } from '../attempts/attempt.types.js';
import type { FetchStatusResult, PaymentProvider } from '../providers/provider.port.js';
import type { WebhookEventRow } from './webhook-event.types.js';

export interface WebhookResult {
  /** The HTTP status the controller should answer with. */
  status: number;
}

const CONFLICT_CODES = new Set(['provider_error', 'invalid_state_transition']);

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
  ) {}

  async receive(provider: PaymentProvider, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookResult> {
    const verified = await provider.verifyWebhook(rawBody, headers);
    if (!verified.signatureValid) return { status: 401 };

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
   * parsed shape from the stored bytes (never re-authenticates — the body cannot have changed since receipt). */
  async reprocess(event: WebhookEventRow, provider: PaymentProvider): Promise<WebhookResult> {
    const parsed = provider.parseStoredBody(event.rawBody);
    if (parsed === null) {
      await this.markState(event.id, 'failed', 'malformed_body');
      return { status: 200 };
    }
    return this.process(event.id, provider, parsed);
  }

  private async process(
    eventId: string,
    provider: PaymentProvider,
    parsed: { providerEventId: string; type: string; reference: string; amount?: number; currency?: string; data: unknown },
  ): Promise<WebhookResult> {
    const status = this.toStatus(parsed);
    if (!status) {
      await this.markState(eventId, 'ignored', `unknown_event_type:${parsed.type}`);
      return { status: 200 };
    }

    const attempt = await this.findAttemptByReference(parsed.reference);
    if (!attempt) {
      await this.markState(eventId, 'unmatched', null);
      return { status: 200 }; // the resolver/retrier revisits this — the record may not be visible yet
    }

    try {
      await this.attempts.applyStatus(attempt.id, status, provider);
      await this.markState(eventId, 'processed', null, attempt.id);
      return { status: 200 };
    } catch (e) {
      const code = e instanceof HttpException ? (e.getResponse() as { code?: string })?.code : undefined;
      if (code && CONFLICT_CODES.has(code)) {
        this.logger.warn(`webhook conflict for attempt ${attempt.id}: ${code}`);
        await this.markState(eventId, 'conflict', code, attempt.id);
        return { status: 200 }; // recorded; a human resolves it (SDD section 5.1 "late success" safety net)
      }
      await this.markState(eventId, 'failed', 'transient_error', attempt.id);
      return { status: 500 }; // transient: let the provider retry
    }
  }

  private toStatus(parsed: { type: string; amount?: number; currency?: string; data: unknown }): FetchStatusResult | null {
    if (parsed.type === 'payment.succeeded') {
      if (typeof parsed.amount !== 'number' || typeof parsed.currency !== 'string') return null;
      return { kind: 'succeeded', amount: parsed.amount, currency: parsed.currency };
    }
    if (parsed.type === 'payment.failed') {
      const data = (parsed.data ?? {}) as { failureCode?: string; failureClass?: string };
      return { kind: 'failed', failureClass: data.failureClass === 'retryable' ? 'retryable' : 'terminal', failureCode: data.failureCode ?? 'unknown' };
    }
    return null;
  }

  private async findAttemptByReference(reference: string): Promise<AttemptRow | null> {
    // merchantReference is a generated column always equal to id (SDD section 4.2), so matching on id covers both.
    const { rows } = await this.db.query<AttemptRow>(`SELECT * FROM payment_attempt WHERE "providerTransactionId" = $1 OR id::text = $1`, [reference]);
    return rows[0] ?? null;
  }

  private async markState(id: string, state: WebhookEventRow['state'], outcome: string | null, matchedAttemptId?: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_event SET state = $2, outcome = $3, attempts = attempts + 1, "processedAt" = CASE WHEN $2 IN ('processed','ignored','conflict') THEN now() ELSE "processedAt" END, "matchedAttemptId" = COALESCE($4, "matchedAttemptId") WHERE id = $1`,
      [id, state, outcome, matchedAttemptId ?? null],
    );
  }
}

function hashOf(buf: Buffer): string {
  let h = 0;
  for (const b of buf) h = (h * 31 + b) >>> 0;
  return h.toString(16);
}
