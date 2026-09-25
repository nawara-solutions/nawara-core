import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { describeFailure, PollLoop } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { UsageLimiter } from '../limits/usage-limiter.js';
import { FileRepository, type DeletionClaim } from '../persistence/file.repository.js';
import { TicketRepository } from '../persistence/ticket.repository.js';
import { isStorageError } from '../storage/storage-error.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.port.js';
import { deleteRetryDelaySeconds } from './cleanup-config.js';

export interface CleanupPassResult {
  expired: number;
  deleted: number;
  retried: number;
  abandoned: number;
  ticketsPurged: number;
  limitsPurged: number;
}

/**
 * Stage 17.7: the bounded cleanup workers of SDD §12, one `PollLoop` per process (every replica may run it: every claim is exclusive or
 * idempotent). Each pass, in order:
 *
 * 1. orphan expiry: AVAILABLE files unattached past their deadline → DELETING (tickets revoked), the normal deletion path;
 * 2. delete worker: claim due DELETING rows (lease + fence, short transaction), delete each object OUTSIDE any transaction, then
 *    DELETED (success or already absent) or rescheduled with backoff (the row stays DELETING: access is never restored);
 * 3. upload-lease sweep: UPLOADING rows past their lease (no live request can still write them): delete the key (idempotent), then
 *    FAILED `upload_abandoned`; a storage failure leaves the row for the next pass;
 * 4. ticket retention: expired ticket rows past the retention window, in a bounded batch;
 * 5. Stage 17.8: limiter retention: this service's expired rate-limit windows, in a bounded batch.
 *
 * No database transaction is ever open during a storage call. Stops before the pool closes (`beforeApplicationShutdown`): no new claim,
 * the running pass is waited for (bounded); a claim cut by shutdown is recovered when its lease expires.
 */
@Injectable()
export class CleanupWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('FileCleanup');
  private readonly loop: PollLoop;
  private stopping = new AbortController();

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly files: FileRepository,
    private readonly tickets: TicketRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly usage: UsageLimiter,
  ) {
    this.loop = new PollLoop(
      () => this.runOnce(),
      (e) => this.logger.warn(`file_cleanup_pass_failed ${describeFailure(e)}`),
      (ms) => this.logger.warn(`file_cleanup_drain_timeout drain_ms=${ms}`),
    );
  }

  onApplicationBootstrap(): void {
    // After the HTTP server is up; the first pass waits one interval: boot never waits on storage or a backlog.
    if (this.config.cleanup.enabled) this.loop.start(this.config.cleanup.intervalMs);
  }

  async beforeApplicationShutdown(): Promise<void> {
    const drain = this.loop.stop(this.config.httpDrainTimeoutMs);
    this.stopping.abort(new Error('shutdown'));
    await drain;
  }

  /** One pass of every task (also the tests' entry point). Each task is bounded by the batch size. */
  async runOnce(): Promise<CleanupPassResult> {
    if (this.stopping.signal.aborted) this.stopping = new AbortController(); // a stopped worker run again by hand (tests)
    const expired = await this.expireUnattached();
    const { deleted, retried } = await this.deleteDue();
    const abandoned = await this.sweepAbandonedUploads();
    const ticketsPurged = await this.tickets.purgeExpired(this.config.cleanup.ticketRetentionSeconds, this.config.cleanup.batchSize);
    const limitsPurged = await this.usage.purgeExpiredWindows(this.config.cleanup.batchSize);
    const result = { expired, deleted, retried, abandoned, ticketsPurged, limitsPurged };
    if (expired + deleted + retried + abandoned + ticketsPurged + limitsPurged > 0) {
      this.logger.log(`file_cleanup_pass expired=${expired} deleted=${deleted} retried=${retried} abandoned=${abandoned} tickets_purged=${ticketsPurged} limits_purged=${limitsPurged}`);
    }
    return result;
  }

  private async expireUnattached(): Promise<number> {
    const ids = await this.files.expireUnattached(this.config.cleanup.batchSize);
    for (const id of ids) this.logger.log(`file_temporary_expired file=${id}`);
    return ids.length;
  }

  private async deleteDue(): Promise<{ deleted: number; retried: number }> {
    const claims = await this.files.claimDeletions(this.config.cleanup.batchSize, this.config.cleanup.deleteLeaseSeconds);
    let deleted = 0;
    let retried = 0;
    const queue = [...claims];
    const runOne = async (): Promise<void> => {
      for (let claim = queue.shift(); claim; claim = queue.shift()) {
        if (await this.deleteOne(claim)) deleted += 1;
        else retried += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.config.cleanup.deleteConcurrency, claims.length) }, runOne));
    return { deleted, retried };
  }

  /** One claimed deletion: the storage call runs outside any transaction; the row is finalized (or rescheduled) afterwards. */
  private async deleteOne(claim: DeletionClaim): Promise<boolean> {
    try {
      await this.storage.delete(claim.storageKey, { signal: this.stopping.signal }); // idempotent: an absent object is success
    } catch (e) {
      if (this.stopping.signal.aborted) {
        // Shutdown cut the call: release the claim at once (fenced) so another replica takes it over; no backoff for our own stop.
        await this.files.retryDeletion(claim.id, claim.attempt, 0, 'interrupted').catch(() => undefined);
        this.logger.log(`file_deletion_interrupted file=${claim.id} attempt=${claim.attempt}`);
        return false;
      }
      const code = isStorageError(e) ? e.code : 'storage_error';
      const delay = deleteRetryDelaySeconds(claim.attempt, this.config.cleanup.deleteRetryBaseSeconds, this.config.cleanup.deleteRetryMaxSeconds);
      const rescheduled = await this.files.retryDeletion(claim.id, claim.attempt, delay, code);
      // Never back to AVAILABLE: the file stays inaccessible while its bytes wait. Persistent failures stay visible (attempt, code).
      this.logger.warn(`file_deletion_retry file=${claim.id} attempt=${claim.attempt} reason=${code} next_in_s=${delay}${rescheduled ? '' : ' fenced=true'}`);
      return false;
    }
    if (await this.files.completeDeletion(claim.id)) this.logger.log(`file_deletion_completed file=${claim.id} attempt=${claim.attempt}`);
    return true;
  }

  private async sweepAbandonedUploads(): Promise<number> {
    let failed = 0;
    for (const upload of await this.files.findAbandonedUploads(this.config.cleanup.batchSize)) {
      try {
        // The object may exist (published, then the process died before finalizing): never promoted to AVAILABLE (its verified content
        // was never recorded): removed first, then the row is failed. A crash between the two repeats the idempotent delete.
        await this.storage.delete(upload.storageKey, { signal: this.stopping.signal });
      } catch (e) {
        this.logger.warn(`file_upload_abandoned_cleanup_failed file=${upload.id} reason=${isStorageError(e) ? e.code : 'storage_error'}`);
        continue; // the row stays UPLOADING (past its lease): the next pass tries again
      }
      if (await this.files.failAbandonedUpload(upload.id)) {
        failed += 1;
        this.logger.log(`file_upload_abandoned file=${upload.id}`);
      }
    }
    return failed;
  }
}
