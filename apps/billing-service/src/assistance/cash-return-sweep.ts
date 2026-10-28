import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { lockOrganization } from './assistance-restrictions.js';

/** A request past its deadline whose settlement side is definitively unsuccessful (E-6 conditions 1 to 5, at the database's time). */
const DUE = `a.status = 'cash_collected' AND now() > a."settleBy"
  AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."assistanceRequestId" = a.id)
  AND NOT EXISTS (SELECT 1 FROM assistance_settlement_channel c WHERE c."assistanceRequestId" = a.id AND c.status IN ('open', 'uncertain'))
  AND NOT EXISTS (SELECT 1 FROM cash_return_obligation o WHERE o."assistanceRequestId" = a.id)`;

/**
 * Core V2 S5b cash-return sweep (register BIL-17 A; FC-8; the Owner's E-6 and E-8). Opens the ONE cash-return obligation of a request whose
 * deadline passed with no electronic settlement: the database's current time is past `settleBy`, there is no purchase, no channel is open
 * or uncertain (an uncertain Payment never lets it open: E-6), and no obligation exists. The Organization owes the beneficiary the frozen
 * total (base + fee) in the frozen currency.
 *
 * Each request is decided in its own transaction holding the request row lock, the same lock the assisted purchase takes (E-7): a verified
 * success and the sweep can never both win, whatever commits first; the database re-checks every condition at insert. Idempotent: a
 * request already holding an obligation is never selected, and the unique key refuses a second one. There is no release timeout.
 * DEVELOPMENT AND SIMULATION ONLY: the module that runs it is never mounted in production.
 */
@Injectable()
export class CashReturnSweep {
  private readonly logger = new Logger(CashReturnSweep.name);
  private readonly loop = new PollLoop(
    () => this.sweepOnce(),
    (e) => this.logger.error(`cash_return_sweep_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=cash_return_sweep drainTimeoutMs=${ms} — shutdown proceeds; the next start sweeps again`),
  );
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.assistanceSweep.intervalMs): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass. Exposed directly for tests. */
  async sweepOnce(batchSize = 100): Promise<{ opened: number }> {
    if (this.config.isProduction || this.running) return { opened: 0 };
    this.running = true;
    try {
      const due = (await this.db.query<{ id: string }>(`SELECT a.id FROM assistance_request a WHERE ${DUE} ORDER BY a."settleBy", a.id LIMIT $1`, [batchSize])).rows;
      let opened = 0;
      for (const { id } of due) if (await this.openOne(id)) opened += 1;
      return { opened };
    } finally {
      this.running = false;
    }
  }

  private openOne(requestId: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      // Core V2 S5d (S5D-5): the Organization lock first (an obligation is T2), then the request row lock (the assisted purchase's lock),
      // then every condition again under them
      const org = (await q.query<{ organizationId: string }>(`SELECT "organizationId" FROM assistance_request WHERE id = $1`, [requestId])).rows[0];
      if (!org) return false;
      await lockOrganization(q, org.organizationId);
      const r = (await q.query<{ id: string }>(`SELECT a.id FROM assistance_request a WHERE a.id = $1 FOR UPDATE`, [requestId])).rows[0];
      if (!r) return false;
      const still = (await q.query(`SELECT 1 FROM assistance_request a WHERE a.id = $1 AND ${DUE}`, [requestId])).rows.length > 0;
      if (!still) return false;
      const o = (await q.query<{ id: string; organizationId: string; amount: string }>(
        `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
         SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1
         ON CONFLICT ("assistanceRequestId") DO NOTHING RETURNING id, "organizationId", amount`, [requestId])).rows[0];
      if (!o) return false;
      const ctx: TransitionContext = { actor: { type: 'system', id: 'assistance_sweep' }, cause: { type: 'sweep', id: requestId }, correlationId: `assistance-sweep:${requestId}` };
      await this.audit.record(q, 'cash_return_obligation.opened', {
        organizationId: o.organizationId, resource: { type: 'cash_return_obligation', id: o.id }, changes: { assistance_request_id: requestId, amount: Number(o.amount) },
      }, ctx);
      this.logger.warn(`cash_return_obligation_opened assistanceRequestId=${requestId} obligationId=${o.id}`);
      return true;
    });
  }
}

/** Starts the sweep at bootstrap and drains it at shutdown (the dispatcher's lifecycle). */
@Injectable()
export class CashReturnSweepService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly sweep: CashReturnSweep) {}
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
