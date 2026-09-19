import { Injectable } from '@nestjs/common';
import type { Queryable } from '../db/db.service.js';
import type { EventEnvelope } from './types.js';

export type InboxOutcome = 'processed' | 'duplicate';

/**
 * Makes an event consumer idempotent. The inbox row and the consumer's effect commit in ONE transaction: a redelivered event
 * finds its row and is skipped; if the effect fails, the row rolls back and the redelivery is processed again.
 */
@Injectable()
export class InboxService {
  async handle(db: { tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> }, event: EventEnvelope, effect: (q: Queryable) => Promise<void>): Promise<InboxOutcome> {
    return db.tx(async (q) => {
      const r = await q.query(
        `INSERT INTO inbox("eventId", source, name) VALUES ($1, $2, $3) ON CONFLICT ("eventId") DO NOTHING`,
        [event.id, event.headers.source, event.name],
      );
      if (r.rowCount === 0) return 'duplicate' as const;
      await effect(q);
      return 'processed' as const;
    });
  }
}
