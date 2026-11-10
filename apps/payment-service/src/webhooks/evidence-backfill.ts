import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { ParsedWebhookBody } from '../providers/provider.port.js';
import { indexEvidence, isUnattributable, type IndexedEvidence } from './evidence-index.js';

export interface BackfillBatch {
  /** rows indexed in this batch */
  indexed: number;
  /** pending rows left as they were because their provider's adapter is not enabled here (they keep reading UNKNOWN) */
  skipped: number;
  /** pending `refund.succeeded` rows still not indexed after this batch (any provider) */
  remaining: number;
}

/**
 * Core V2 R3 (0028): the historical index of `refund.succeeded` notifications stored before 0028 (`evidenceIndex = 'pending'`). BOUNDED (at most
 * `limit` rows, one transaction), RESUMABLE (each committed row leaves `pending` once, so a later batch continues where an interrupted one stopped) and
 * IDEMPOTENT (only pending rows are read; the write is conditional on `pending`; the database refuses any second write). It reads the signed body
 * through the provider's own `parseStoredBody` and never changes it. A body it cannot parse, or one that no longer parses as `refund.succeeded`, is
 * `unparseable` (unattributable), never absence. A row whose provider is not enabled here stays `pending`, so that provider's failed attempts keep
 * reading UNKNOWN. NOT scheduled and no CLI: run only by an explicit call (Core V2: isolated test databases only).
 */
export async function backfillEvidenceIndex(db: DbService, parserOf: (provider: string) => ((raw: Buffer) => ParsedWebhookBody | null) | undefined,
  limit: number, log?: (line: string) => void): Promise<BackfillBatch> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('backfill limit must be 1..1000');
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; provider: string; rawBody: Buffer }>(
      `SELECT id, provider, "rawBody" FROM webhook_event WHERE "eventType" = 'refund.succeeded' AND "evidenceIndex" = 'pending'
        ORDER BY "receivedAt", id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    let indexed = 0;
    let skipped = 0;
    for (const r of rows) {
      const parse = parserOf(r.provider);
      if (!parse) { skipped++; continue; }
      let parsed: ParsedWebhookBody | null;
      try {
        parsed = parse(r.rawBody);
      } catch {
        parsed = null;
      }
      // a stored refund.succeeded must still parse as one; anything else cannot be trusted as a reference
      const e: IndexedEvidence = parsed && parsed.type !== 'refund.succeeded' ? { evidenceIndex: 'unparseable', providerTransactionId: null } : indexEvidence(parsed);
      const done = await q.query(`UPDATE webhook_event SET "evidenceIndex" = $2, "providerTransactionId" = $3 WHERE id = $1 AND "evidenceIndex" = 'pending'`,
        [r.id, e.evidenceIndex, e.providerTransactionId]);
      if (done.rowCount === 1) {
        indexed++;
        if (isUnattributable(e, 'refund.succeeded')) log?.(`webhook_unattributable_refund_evidence event=${r.id} provider=${r.provider} index=${e.evidenceIndex} — backfilled; attributed to no payment or Company`);
      }
    }
    const remaining = Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM webhook_event WHERE "eventType" = 'refund.succeeded' AND "evidenceIndex" = 'pending'`)).rows[0]!.n);
    return { indexed, skipped, remaining: remaining };
  });
}

/** The injectable form, over the enabled providers. Never started by the application. */
@Injectable()
export class WebhookEvidenceBackfill {
  private readonly log = new Logger('PaymentWebhookEvidenceBackfill');
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
  ) {}

  batch(limit = 100): Promise<BackfillBatch> {
    return backfillEvidenceIndex(this.db, (p) => {
      const adapter = this.providers.tryGet(p);
      return adapter ? (raw: Buffer) => adapter.parseStoredBody(raw) : undefined;
    }, limit, (line) => this.log.warn(line));
  }
}
