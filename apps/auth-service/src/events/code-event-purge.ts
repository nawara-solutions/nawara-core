import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { PollLoop, describeFailure } from '@nawara/service-kit';
import { DbService } from '../db/db.service.js';
import { CODE_BEARING_EVENTS } from './domain-events.js';

/** How often the purge runs, and how many rows one statement may delete. A pass repeats full batches up to `MAX_BATCHES_PER_PASS`. */
export const CODE_EVENT_PURGE_INTERVAL_MS = 5_000;
export const CODE_EVENT_PURGE_BATCH = 200;
export const MAX_BATCHES_PER_PASS = 10;

/**
 * The code-bearing names as SQL literals (a closed, constant list): a literal predicate is what lets PostgreSQL use the partial index of
 * migration 0011 (a parameter could not be proved to match the index predicate), so the purge never scans the ever-growing outbox.
 */
const NAMES_SQL = CODE_BEARING_EVENTS.map((n) => `'${n}'`).join(', ');

/**
 * Stage 21.C.2 (ADR-0052 decision 5, Q3): deletes the outbox rows of the three code-bearing events once they are PUBLISHED (the relay
 * stamped them: delivery is Notification's from then on) or once their code has EXPIRED (delivery is no longer useful; Notification never
 * sends an expired code). Only those three names: audit evidence and every other event are never touched.
 *
 * Bounded (a batch per statement, a few batches per pass) and safe beside the relay: a row the relay is publishing is locked by it and
 * skipped here (`SKIP LOCKED`), and an unpublished row is deleted only once its code has expired. Observable by counts only
 * (`auth_code_event_purge deleted=… published=… expired=…`): never an id, a destination, a code or a payload.
 */
@Injectable()
export class CodeEventPurge implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = new Logger('CodeEventPurge');
  private readonly loop: PollLoop;

  constructor(@Inject(DbService) private readonly db: DbService) {
    this.loop = new PollLoop(
      () => this.pass(),
      (e) => this.log.warn(`auth_code_event_purge_failure ${describeFailure(e)} — the next pass retries`),
      (ms) => this.log.warn(`worker_drain_timeout worker=auth_code_event_purge drainTimeoutMs=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start(CODE_EVENT_PURGE_INTERVAL_MS, CODE_EVENT_PURGE_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.loop.stop();
  }

  /** One pass: full batches back to back, at most `MAX_BATCHES_PER_PASS`. Returns the counts it logged. */
  async pass(): Promise<{ published: number; expired: number }> {
    let published = 0;
    let expired = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      const r = await this.purgeBatch();
      published += r.published;
      expired += r.expired;
      if (r.published + r.expired < CODE_EVENT_PURGE_BATCH) break;
    }
    if (published + expired > 0) this.log.log(`auth_code_event_purge deleted=${published + expired} published=${published} expired=${expired}`);
    return { published, expired };
  }

  async purgeBatch(): Promise<{ published: number; expired: number }> {
    const { rows } = await this.db.query<{ published: boolean }>(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox
          WHERE name IN (${NAMES_SQL})
            AND ("publishedAt" IS NOT NULL OR (payload->>'expiresAt')::timestamptz <= now())
          ORDER BY "occurredAt"
          LIMIT $1
          FOR UPDATE SKIP LOCKED)
       RETURNING ("publishedAt" IS NOT NULL) AS published`,
      [CODE_EVENT_PURGE_BATCH],
    );
    const published = rows.filter((r) => r.published).length;
    return { published, expired: rows.length - published };
  }
}
