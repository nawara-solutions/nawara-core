import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { TransitionContext } from '../domain/actors.js';

/**
 * Core V2 G3 (DO-31, DO-33, DO-41, DO-42; the Owner's G3 GO, 2026-11-18): the review kinds. Each is ESCALATION-ONLY evidence: nothing here closes,
 * retries, caps, releases, changes or assigns anything, and no financial path reads it. The thresholds are migration 0056's constants
 * (`billing_stalled_work_threshold`, `billing_stalled_work_send_attempts`), never configuration; the database refuses a row that is not due.
 */
export const STALLED_WORK_KINDS = ['assistance_dispute_open', 'settlement_channel_uncertain', 'payment_request_sending', 'payment_request_auth_fault', 'payment_event_conflict'] as const;
export type StalledWorkKind = (typeof STALLED_WORK_KINDS)[number];
/** The kinds the Platform Owner reads (assistance; S5c's existing authority). */
export const ASSISTANCE_KINDS = ['assistance_dispute_open', 'settlement_channel_uncertain'] as const;
/** The kinds the Company Owner reads (Billing's payment requests and payment-event conflicts with a trusted request). auth_fault is never one. */
export const PAYMENT_KINDS = ['payment_request_sending', 'payment_event_conflict'] as const;

const SWEEP_KINDS = ['assistance_dispute_open', 'settlement_channel_uncertain', 'payment_request_sending', 'payment_event_conflict'] as const;
type SweepKind = (typeof SWEEP_KINDS)[number];

/** Candidates the sweep offers the database (which re-checks every one at insert): due now, with no review for their episode yet. */
const CANDIDATES: Record<SweepKind, string> = {
  assistance_dispute_open: `SELECT d.id FROM assistance_dispute d
     WHERE d.status = 'open' AND d."reasonCode" IN ('cash_not_returned', 'collection_not_made') AND now() >= d."openedAt" + billing_stalled_work_threshold('assistance_dispute_open')
       AND NOT EXISTS (SELECT 1 FROM stalled_work_review r WHERE r.kind = 'assistance_dispute_open' AND r."episodeKey" = d.id)
     ORDER BY d."openedAt", d.id LIMIT $1`,
  settlement_channel_uncertain: `SELECT c.id FROM assistance_settlement_channel c JOIN assistance_request a ON a.id = c."assistanceRequestId"
     WHERE c.status = 'uncertain' AND a."settleBy" IS NOT NULL AND now() >= a."settleBy" + billing_stalled_work_threshold('settlement_channel_uncertain')
       AND NOT EXISTS (SELECT 1 FROM stalled_work_review r WHERE r.kind = 'settlement_channel_uncertain' AND r."episodeKey" = c.id)
     ORDER BY a."settleBy", c.id LIMIT $1`,
  payment_request_sending: `SELECT pr.id FROM payment_request pr
     WHERE pr.status = 'sending'
       AND (pr."sendAttempts" >= billing_stalled_work_send_attempts()
            OR EXISTS (SELECT 1 FROM billing_transition bt WHERE bt."entityType" = 'payment_request' AND bt."entityId" = pr.id AND bt."toStatus" = 'sending'
                         AND now() >= bt."occurredAt" + billing_stalled_work_threshold('payment_request_sending')))
       AND NOT EXISTS (SELECT 1 FROM stalled_work_review r WHERE r.kind = 'payment_request_sending' AND r."episodeKey" = pr.id)
     ORDER BY pr."createdAt", pr.id LIMIT $1`,
  // one receipt per episode (the event id): the first one received; every delivery and reconciler pass leaves its own row
  payment_event_conflict: `SELECT DISTINCT ON (COALESCE(x."eventId", x.id)) x.id FROM payment_event_receipt x
     WHERE x.outcome = 'conflict'
       AND NOT EXISTS (SELECT 1 FROM stalled_work_review r WHERE r.kind = 'payment_event_conflict' AND r."episodeKey" = COALESCE(x."eventId", x.id))
     ORDER BY COALESCE(x."eventId", x.id), x."receivedAt", x.id LIMIT $1`,
};

interface ReviewRow {
  id: string;
  kind: StalledWorkKind;
  subjectId: string;
  episodeKey: string;
  observedState: string;
  anchorAt: Date;
  thresholdSeconds: number;
  reason: string;
  sendAttempts: number | null;
  paymentRequestId: string | null;
  companyId: string | null;
  platformId: string | null;
  organizationId: string | null;
  escalatedAt: Date;
}

const REVIEW_COLUMNS = `r.id, r.kind, r."subjectId", r."episodeKey", r."observedState", r."anchorAt", r."thresholdSeconds", r.reason, r."sendAttempts",
  r."paymentRequestId", r."companyId", r."platformId", r."organizationId", r."escalatedAt"`;

const sweepContext = (subjectId: string): TransitionContext =>
  ({ actor: { type: 'system', id: 'stalled_work_sweep' }, cause: { type: 'sweep', id: subjectId }, correlationId: `stalled-work:${subjectId}` });

/** A constraint the database names on a refusal (the guard's): the candidate stopped being due between the read and the insert. */
function pgConstraint(e: unknown): string | undefined {
  return e && typeof e === 'object' && 'constraint' in e ? String((e as { constraint?: unknown }).constraint) : undefined;
}

@Injectable()
export class StalledWorkService {
  private readonly logger = new Logger(StalledWorkService.name);
  private readonly loop = new PollLoop(
    () => this.sweepOnce(),
    (e) => this.logger.error(`stalled_work_sweep_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=stalled_work_sweep drainTimeoutMs=${ms} — shutdown proceeds; the next start sweeps again`),
  );
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.stalledWorkSweep.intervalMs): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /**
   * One pass: escalations first, then exit observations. Each item is its own transaction (the review row and its audit intent commit together or not
   * at all); a failure of one item is logged and retried on the next pass, never skipped silently. Safe on several instances at once: the unique
   * episode key makes a concurrent second insert a no-op, and the audit intent is written only by the insert that returned a row. Exposed for tests.
   */
  async sweepOnce(batchSize = 100): Promise<{ escalated: number; exited: number }> {
    if (this.config.isProduction || this.running) return { escalated: 0, exited: 0 };
    this.running = true;
    try {
      let escalated = 0;
      for (const kind of SWEEP_KINDS) {
        const ids = (await this.db.query<{ id: string }>(CANDIDATES[kind], [batchSize])).rows;
        for (const { id } of ids) {
          try {
            if (await this.db.tx((q) => this.escalate(q, kind, id))) escalated++;
          } catch (e) {
            if (pgConstraint(e) === 'stalled_work_review_not_due') continue; // it left the state (or was never due) after the read: nothing to escalate
            this.logger.warn(`stalled_work_escalation_failure kind=${kind} subject=${id} ${describeFailure(e)} — nothing written; the next pass retries`);
          }
        }
      }
      let exited = 0;
      const open = (await this.db.query<{ id: string; kind: StalledWorkKind; subjectId: string }>(
        `SELECT r.id, r.kind, r."subjectId" FROM stalled_work_review r
          WHERE r.kind <> 'payment_event_conflict' AND NOT EXISTS (SELECT 1 FROM stalled_work_exit x WHERE x."reviewId" = r.id)
            AND NOT COALESCE((SELECT s."inState" FROM billing_stalled_work_subject(r.kind, r."subjectId") s), false)
          ORDER BY r.id LIMIT $1`, [batchSize])).rows;
      for (const r of open) {
        try {
          if (await this.db.tx((q) => this.observeExit(q, r))) exited++;
        } catch (e) {
          if (pgConstraint(e) === 'stalled_work_exit_not_exited') continue;
          this.logger.warn(`stalled_work_exit_failure review=${r.id} ${describeFailure(e)} — nothing written; the next pass retries`);
        }
      }
      return { escalated, exited };
    } finally {
      this.running = false;
    }
  }

  /** The review row (derived and checked by the database) and, only when it was inserted now, its one audit intent. */
  private async escalate(q: Queryable, kind: SweepKind, subjectId: string): Promise<boolean> {
    const row = (await q.query<ReviewRow>(
      `INSERT INTO stalled_work_review AS r (kind, "subjectId") VALUES ($1, $2) ON CONFLICT ON CONSTRAINT stalled_work_review_once DO NOTHING RETURNING ${REVIEW_COLUMNS}`,
      [kind, subjectId])).rows[0];
    if (!row) return false; // another pass or instance escalated this episode: nothing more
    await this.audit.record(q, 'stalled_work.escalated', {
      organizationId: row.organizationId, resource: { type: 'stalled_work_review', id: row.id },
      changes: {
        kind: kind as never, subject_id: row.subjectId, reason: row.reason as never, threshold_seconds: row.thresholdSeconds,
        ...(row.paymentRequestId ? { payment_request_id: row.paymentRequestId } : {}),
      },
    }, sweepContext(subjectId));
    // The Owner's G3 rule 4: DO-41 (and DO-31, DO-42) write the operational line; DO-33 writes only its review row and audit intent (no second line)
    if (kind !== 'settlement_channel_uncertain') {
      this.logger.warn(`stalled_work_escalated kind=${kind} review=${row.id} subject=${row.subjectId} reason=${row.reason} — review only; nothing changed`);
    }
    return true;
  }

  private async observeExit(q: Queryable, r: { id: string; kind: StalledWorkKind; subjectId: string }): Promise<boolean> {
    const x = (await q.query<{ exitedState: string }>(
      `INSERT INTO stalled_work_exit ("reviewId", "exitedState") VALUES ($1, '') ON CONFLICT ("reviewId") DO NOTHING RETURNING "exitedState"`, [r.id])).rows[0];
    if (!x) return false;
    const review = (await q.query<{ organizationId: string | null; paymentRequestId: string | null }>(
      `SELECT "organizationId", "paymentRequestId" FROM stalled_work_review WHERE id = $1`, [r.id])).rows[0]!;
    if (r.kind === 'payment_request_auth_fault') {
      await this.audit.record(q, 'stalled_work.auth_fault_exited', {
        organizationId: null, resource: { type: 'stalled_work_review', id: r.id },
        changes: { payment_request_id: review.paymentRequestId!, exited_state: x.exitedState as never },
      }, sweepContext(r.subjectId));
    } else {
      await this.audit.record(q, 'stalled_work.state_exited', {
        organizationId: review.organizationId, resource: { type: 'stalled_work_review', id: r.id },
        changes: { kind: r.kind as never, subject_id: r.subjectId, exited_state: x.exitedState as never },
      }, sweepContext(r.subjectId));
    }
    return true;
  }

  /**
   * DO-41 auth_fault (the Owner's G3 rules 3 and 8): Payment refused Billing's OWN service token for a `sending` request. Called by the dispatcher right
   * after the refusal, in its own short transaction: one Billing-internal review row per request (the database forces its scope to NULL) and one
   * SECURITY audit intent. A failure here never affects dispatch: logged, and the next refused attempt tries again. Never in production.
   */
  async recordAuthFault(paymentRequestId: string, correlationId: string): Promise<void> {
    if (this.config.isProduction) return;
    try {
      await this.db.tx(async (q) => {
        const row = (await q.query<ReviewRow>(
          `INSERT INTO stalled_work_review AS r (kind, "subjectId") VALUES ('payment_request_auth_fault', $1) ON CONFLICT ON CONSTRAINT stalled_work_review_once DO NOTHING
           RETURNING ${REVIEW_COLUMNS}`, [paymentRequestId])).rows[0];
        if (!row) return;
        const ctx: TransitionContext = { actor: { type: 'system', id: 'payment_dispatcher' }, cause: { type: 'dispatcher', id: paymentRequestId }, correlationId };
        await this.audit.record(q, 'stalled_work.auth_fault_escalated', {
          organizationId: null, resource: { type: 'stalled_work_review', id: row.id },
          changes: { payment_request_id: paymentRequestId, send_attempts: row.sendAttempts ?? 0 },
        }, ctx);
      });
    } catch (e) {
      if (pgConstraint(e) === 'stalled_work_review_not_due') return; // the request left `sending` meanwhile
      this.logger.warn(`stalled_work_auth_fault_record_failure request=${paymentRequestId} ${describeFailure(e)} — dispatch unaffected; the next refusal tries again`);
    }
  }

  /** The Company Owner's read (PAY kinds only; auth_fault never): their Company's items, keyset by id. Platform visibility is checked by the caller. */
  async listForCompany(companyId: string, after: string | null, limit: number): Promise<ReviewWithExit[]> {
    return this.listWhere(`r."companyId" = $1 AND r.kind = ANY($2::text[])`, [companyId, [...PAYMENT_KINDS]], after, limit);
  }

  /** The Platform Owner's read (assistance kinds only): one Platform's items, keyset by id. Auth's live Platform check is the caller's. */
  async listForPlatform(platformId: string, after: string | null, limit: number): Promise<ReviewWithExit[]> {
    return this.listWhere(`r."platformId" = $1 AND r.kind = ANY($2::text[])`, [platformId, [...ASSISTANCE_KINDS]], after, limit);
  }

  private async listWhere(where: string, params: unknown[], after: string | null, limit: number): Promise<ReviewWithExit[]> {
    const n = params.length;
    return (await this.db.query<ReviewWithExit>(
      `SELECT ${REVIEW_COLUMNS}, x."exitedState", x."observedAt" AS "exitObservedAt"
         FROM stalled_work_review r LEFT JOIN stalled_work_exit x ON x."reviewId" = r.id
        WHERE ${where} AND ($${n + 1}::uuid IS NULL OR r.id > $${n + 1}) ORDER BY r.id LIMIT $${n + 2}`, [...params, after, limit])).rows;
  }
}

export interface ReviewWithExit extends ReviewRow {
  exitedState: string | null;
  exitObservedAt: Date | null;
}

/** The Owner's view of one item: identifiers, codes and times only (never an amount, a provider reference or a credential). */
export function representReview(r: ReviewWithExit) {
  return {
    id: r.id, kind: r.kind, subjectId: r.subjectId, observedState: r.observedState, reason: r.reason, anchorAt: r.anchorAt, thresholdSeconds: r.thresholdSeconds,
    sendAttempts: r.sendAttempts, paymentRequestId: r.paymentRequestId, platformId: r.platformId, organizationId: r.organizationId, escalatedAt: r.escalatedAt,
    exit: r.exitedState === null ? null : { state: r.exitedState, observedAt: r.exitObservedAt },
  };
}

/** Starts the sweep at bootstrap and drains it at shutdown (the other workers' lifecycle). */
@Injectable()
export class StalledWorkSweepService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly sweep: StalledWorkService) {}
  onApplicationBootstrap(): void {
    this.sweep.start();
  }
  onModuleDestroy(): void {
    void this.sweep.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.sweep.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.sweep.stop();
  }
}
