import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { DbService, ReadinessRegistry, describeFailure } from '@nawara/service-kit';
import { PAYMENT_DISPUTE_CLIENT, type PaymentDisputeClient } from './payment-dispute-client.js';
import { PAYMENT_REFUND_CLIENT, type AttemptStatus, type PaymentRefundClient, type PaymentRefunds } from './payment-refund-client.js';

/**
 * Core V2 S0-C14 item 14 (register BIL-26 H, S0 §6 `G-FIN-RESTORE`): the Billing FINANCIAL RECONCILIATION SAFETY CHECK.
 *
 * It is a consistency safety check run before Billing's four financial workers (`dispute_loss_worker`, `refund_effect_worker`,
 * `recovery_worker`, `reconciliation_worker`) start any pass, on every process start. IT IS NOT PROOF THAT NO INDEPENDENT RESTORE OCCURRED: a pass
 * means only that no inconsistency was found in what it covers. Item 6 (a fresh Payment read before every waiting effect) still applies.
 *
 * Coverage limits (it cannot detect): a Billing rewind on payments with no loss yet (Payment has no list of all attempts; item 6 covers them
 * when a loss arrives); both databases rewound together; provider activity Core never received; a rewind after the scan; a loss with no
 * chargeback fact (Payment's losses read omits it).
 *
 * The scan is complete or it does not pass: Payment's losses paged by keyset (200 a page) until a short page; Billing's losses, relays and
 * completions paged by keyset the same way; PAY-08 read for every payment involved. A failed, partial or timed-out scan is UNAVAILABLE (retried
 * with backoff, workers stay stopped, readiness unaffected); no sampling. Comparison is in ONE direction: Payment ahead of Billing's mirror is
 * normal (an event in transit), only Billing ahead of Payment is a MISMATCH (sticky for the process's life, workers stopped, readiness not ready,
 * never overridden by the service itself). Nothing is lost while the workers are stopped: rows wait in the database.
 */

const PAGE = 200;
const SCAN_BUDGET_MS = 120_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 300_000;

/** The relay mirror's allowed moves (migration 0034): Payment may be at the same status or one reachable from Billing's, never behind it. */
const MOVES: Record<string, readonly string[]> = {
  authorization_pending: ['authorized', 'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'unknown', 'succeeded', 'failed', 'discrepancy'],
  authorized: ['dispatching', 'submitted', 'unknown', 'succeeded', 'failed', 'discrepancy'],
  dispatching: ['submitted', 'unknown', 'succeeded', 'failed', 'discrepancy'],
  unknown: ['submitted', 'succeeded', 'failed', 'discrepancy'],
  submitted: ['succeeded', 'failed', 'discrepancy'],
  failed: ['discrepancy'],
};
export function paymentNotBehind(billing: string, payment: string): boolean {
  if (billing === payment) return true;
  const seen = new Set<string>([billing]);
  const queue = [billing];
  while (queue.length > 0) {
    for (const next of MOVES[queue.shift()!] ?? []) {
      if (next === payment) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export type SafetyCheckOutcome = { kind: 'passed' } | { kind: 'unavailable'; reason: string } | { kind: 'mismatch'; findings: string[] };

class Unavailable extends Error {}

/** The workers' gate: closed until the check passes; a mismatch keeps it closed for the process's life. */
@Injectable()
export class FinancialWorkerGate {
  private state: 'pending' | 'passed' | 'mismatch' = 'pending';
  private release!: () => void;
  private readonly passed = new Promise<void>((resolve) => { this.release = resolve; });

  get status(): 'pending' | 'passed' | 'mismatch' {
    return this.state;
  }

  /** Resolves when the check passed; never resolves after a mismatch (no automatic override). */
  whenPassed(): Promise<void> {
    return this.passed;
  }

  open(): void {
    if (this.state !== 'pending') return;
    this.state = 'passed';
    this.release();
  }

  mismatch(): void {
    if (this.state === 'pending') this.state = 'mismatch';
  }
}

@Injectable()
export class FinancialSafetyCheck {
  constructor(
    private readonly db: DbService,
    @Inject(PAYMENT_DISPUTE_CLIENT) private readonly disputes: PaymentDisputeClient,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly refunds: PaymentRefundClient,
  ) {}

  /** One complete scan. Exposed for tests. */
  async scan(budgetMs = SCAN_BUDGET_MS): Promise<SafetyCheckOutcome> {
    const deadline = Date.now() + budgetMs;
    const inBudget = () => {
      if (Date.now() > deadline) throw new Unavailable('scan_budget_exceeded');
    };
    try {
      const findings: string[] = [];
      // 1. Payment's verified losses, every page (a loss Payment has and Billing has not yet is in transit: normal)
      const paymentLosses = new Set<string>();
      for (let after: string | undefined; ;) {
        inBudget();
        let page;
        try {
          page = await this.disputes.losses(after, PAGE);
        } catch (e) {
          throw new Unavailable(`payment_losses_unavailable ${describeFailure(e)}`);
        }
        for (const l of page) paymentLosses.add(l.disputeId);
        if (page.length < PAGE) break;
        after = page[page.length - 1]!.disputeId;
      }
      // 2. Billing's losses, keyset by dispute: each must be one Payment lists (Billing ahead of Payment is a mismatch)
      const payments = new Set<string>();
      await this.keyset<{ disputeId: string; paymentId: string }>(`SELECT "disputeId" AS key, "disputeId", "paymentId" FROM payment_dispute_loss`, inBudget, (l) => {
        payments.add(l.paymentId);
        if (!paymentLosses.has(l.disputeId)) findings.push(`billing_loss_unknown_to_payment dispute=${l.disputeId}`);
      });
      // 3. Billing's relays and completed cases, keyset; the payments they name
      const relays = new Map<string, { id: string; refundCaseId: string; attemptStatus: AttemptStatus | 'rejected' | null }[]>();
      await this.keyset<{ id: string; paymentId: string; refundCaseId: string; attemptStatus: AttemptStatus | 'rejected' | null }>(
        `SELECT id AS key, id, "paymentId", "refundCaseId", "attemptStatus" FROM refund_authorization_relay`, inBudget, (r) => {
          payments.add(r.paymentId);
          relays.set(r.paymentId, [...(relays.get(r.paymentId) ?? []), r]);
        });
      const completed = new Map<string, string[]>();
      await this.keyset<{ id: string; paymentId: string }>(`SELECT id AS key, id, "paymentId" FROM refund_case WHERE status = 'completed'`, inBudget, (c) => {
        payments.add(c.paymentId);
        completed.set(c.paymentId, [...(completed.get(c.paymentId) ?? []), c.id]);
      });
      // 4. PAY-08 for every payment involved
      for (const paymentId of [...payments].sort()) {
        inBudget();
        let read: PaymentRefunds | null;
        try {
          read = await this.refunds.refunds(paymentId);
        } catch (e) {
          throw new Unavailable(`payment_refunds_unavailable payment=${paymentId} ${describeFailure(e)}`);
        }
        findings.push(...compareRefunds(paymentId, read, relays.get(paymentId) ?? [], completed.get(paymentId) ?? []));
      }
      return findings.length > 0 ? { kind: 'mismatch', findings } : { kind: 'passed' };
    } catch (e) {
      if (e instanceof Unavailable) return { kind: 'unavailable', reason: e.message };
      return { kind: 'unavailable', reason: describeFailure(e) };
    }
  }

  private async keyset<T>(select: string, inBudget: () => void, each: (row: T) => void): Promise<void> {
    for (let after: string | null = null; ;) {
      inBudget();
      const { rows }: { rows: (T & { key: string })[] } = await this.db.query<T & { key: string }>(
        `SELECT * FROM (${select}) s WHERE $1::uuid IS NULL OR s.key > $1::uuid ORDER BY s.key LIMIT ${PAGE}`, [after]);
      for (const r of rows) each(r);
      if (rows.length < PAGE) return;
      after = rows[rows.length - 1]!.key;
    }
  }
}

/** One payment, compared in one direction: Billing's committed records must not be ahead of Payment's. Exported for tests. */
export function compareRefunds(paymentId: string, read: PaymentRefunds | null,
  relays: { id: string; refundCaseId: string; attemptStatus: AttemptStatus | 'rejected' | null }[], completedCases: string[]): string[] {
  const out: string[] = [];
  if (read === null) {
    // Payment does not know a payment Billing holds relays, a loss or a completion for
    return [`payment_unknown payment=${paymentId}`];
  }
  const attempts = new Map(read.attempts.map((a) => [a.refundAttemptId, a.status]));
  const refused = new Set(read.refusals.map((r) => r.refundAttemptId));
  const known = new Set(relays.map((r) => r.id));
  // an attempt at Payment with no relay at Billing: Billing commits the relay before it calls Payment (A1), so Billing lost it
  for (const a of read.attempts) if (!known.has(a.refundAttemptId)) out.push(`attempt_without_relay payment=${paymentId} attempt=${a.refundAttemptId}`);
  for (const r of relays) {
    if (r.attemptStatus === null) continue; // unconfirmed: Payment may or may not hold it
    if (r.attemptStatus === 'rejected') {
      if (!refused.has(r.id) && !attempts.has(r.id)) out.push(`rejected_relay_unknown_to_payment payment=${paymentId} relay=${r.id}`);
      continue;
    }
    const at = attempts.get(r.id);
    if (at === undefined) out.push(`relay_unknown_to_payment payment=${paymentId} relay=${r.id}`);
    else if (!paymentNotBehind(r.attemptStatus, at)) out.push(`relay_ahead_of_payment payment=${paymentId} relay=${r.id} billing=${r.attemptStatus} payment=${at}`);
  }
  // a completion Billing recorded must be Payment's completed authorization of that case
  for (const c of completedCases) {
    if (!read.authorizations.some((z) => z.refundCaseId === c && z.completedAt !== null)) out.push(`completion_unknown_to_payment payment=${paymentId} case=${c}`);
  }
  return out;
}

/**
 * Runs the check in the background on every process start (never blocking bootstrap; HTTP and event consumers run meanwhile) and opens the
 * gate on a pass. Unavailable: retried with backoff. Mismatch: sticky, logged, readiness not ready; no automatic override.
 */
@Injectable()
export class FinancialSafetyCheckService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('BillingFinancialSafety');
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private findings: string[] = [];

  constructor(
    private readonly check: FinancialSafetyCheck,
    private readonly gate: FinancialWorkerGate,
    @Optional() @Inject(ReadinessRegistry) private readonly readiness?: ReadinessRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.readiness?.register('financial-reconciliation', async () => {
      if (this.gate.status === 'mismatch') throw new Error(`financial reconciliation mismatch (${this.findings.length} findings): the financial workers stay stopped`);
    });
    this.schedule(0, RETRY_MIN_MS);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number, nextDelayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.run(nextDelayMs), delayMs);
    this.timer.unref();
  }

  private async run(nextDelayMs: number): Promise<void> {
    if (this.stopped) return;
    const outcome = await this.check.scan();
    if (this.stopped) return;
    if (outcome.kind === 'passed') {
      this.gate.open();
      this.log.log('financial_reconciliation_check_passed — no inconsistency found in what it covers (not proof of no restore); the financial workers start');
      return;
    }
    if (outcome.kind === 'mismatch') {
      this.findings = outcome.findings;
      this.gate.mismatch();
      this.log.error(`financial_reconciliation_check_mismatch findings=${outcome.findings.length} first=${outcome.findings.slice(0, 5).join('; ')} — `
        + 'the financial workers stay stopped and readiness is not ready for this process; no automatic override (G-FIN-RESTORE)');
      return;
    }
    this.log.warn(`financial_reconciliation_check_unavailable ${outcome.reason} — the financial workers stay stopped; retry in ${nextDelayMs} ms`);
    this.schedule(nextDelayMs, Math.min(RETRY_MAX_MS, nextDelayMs * 2));
  }
}
