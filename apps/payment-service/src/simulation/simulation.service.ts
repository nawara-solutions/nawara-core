import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import type { AttemptRow } from '../attempts/attempt.types.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import { notFound, paymentError } from '../errors.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import type { PaymentRow } from '../payments/payment.types.js';
import {
  SIMULATION_PROVIDER_ID, SIMULATION_SIGNATURE_HEADER, SimulationPaymentProvider, simulationRefundId, simulationTransactionId, type SimulationCommandRow,
  type SimulationDisputeCommandRow, type SimulationRefundCommandRow,
} from '../providers/simulation-provider.js';
import type { RefundAttemptRow } from '../refunds/refund.types.js';
import { WebhookService } from '../webhooks/webhook.service.js';
import type { SimulationDisputeDto, SimulationInitiationDto, SimulationOutcomeDto, SimulationRefundDispatchPlanDto, SimulationRefundOutcomeDto } from './dto/simulation-command.dto.js';

export interface SimulationRefundCommandResult {
  command: SimulationRefundCommandRow;
  replayed: boolean;
  delivered: { status: number } | null;
}

export interface SimulationCommandResult {
  command: SimulationCommandRow;
  replayed: boolean;
  /** The webhook pipeline's answer when this call delivered the command's notification; `null` when nothing was delivered. */
  delivered: { status: number } | null;
}

/** The fields that make two commands under one `commandId` the same command (F-S6); everything else is derived from them. */
const CONTENT = ['kind', 'paymentId', 'attemptId', 'instruction', 'failureCode', 'delivery'] as const;
const REFUND_CONTENT = ['kind', 'paymentId', 'refundAttemptId', 'instruction', 'failureCode', 'delivery'] as const;
const DISPUTE_CONTENT = ['paymentId', 'providerDisputeId', 'instruction', 'amount', 'reason', 'chargebackTxnId', 'chargebackAmount', 'delivery'] as const;

export interface SimulationDisputeCommandResult {
  command: SimulationDisputeCommandRow;
  replayed: boolean;
  delivered: { status: number } | null;
}

/**
 * Core V2 S4f (register PAY-14; the Owner's F-S2 to F-S6): the non-production harness that tells the `simulation` provider what to answer.
 * A command changes ONLY the simulated provider's own records; Payment then learns from that provider through its ordinary authenticated
 * paths (a notification delivered through the webhook pipeline and verified with the operator's secret, or the status read), so a command
 * is never itself a verified settlement fact (F-S4). Money, currency and the provider transaction reference are derived from Payment's
 * own rows, never taken from the caller (F-S3). Refused here too when the provider is not enabled (F-S5: the boundary, not just routing).
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger('PaymentSimulation');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(SimulationPaymentProvider) private readonly provider: SimulationPaymentProvider,
    @Inject(WebhookService) private readonly webhooks: WebhookService,
  ) {}

  async planInitiation(paymentId: string, dto: SimulationInitiationDto): Promise<SimulationCommandResult> {
    this.assertEnabled();
    if ((dto.failureCode !== undefined) !== (dto.mode === 'rejected')) {
      throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    }
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [paymentId]);
    const payment = rows[0];
    if (!payment || payment.liveMode === true) throw notFound(); // a live payment is never simulated (fail closed)
    return this.record({ commandId: dto.commandId, kind: 'initiation', paymentId, attemptId: null, instruction: dto.mode, failureCode: dto.failureCode ?? null,
      amount: null, currency: null, providerTxnId: null, eventBody: null, delivery: null });
  }

  async recordOutcome(paymentId: string, attemptId: string, dto: SimulationOutcomeDto): Promise<SimulationCommandResult> {
    this.assertEnabled();
    const notifies = dto.outcome === 'succeeded' || dto.outcome === 'amount_mismatch' || dto.outcome === 'failed' || dto.outcome === 'expired';
    if ((dto.failureCode !== undefined) !== (dto.outcome === 'failed') || (dto.delivery !== undefined && !notifies)) {
      throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    }
    // One attempt, of the simulation provider, of this payment (F-S3): a cross-payment or cross-provider reference is not found here.
    const { rows } = await this.db.query<AttemptRow & { amount: string; currency: string; paymentLiveMode: boolean | null }>(
      `SELECT a.*, p.amount, p.currency, p."liveMode" AS "paymentLiveMode" FROM payment_attempt a JOIN payment p ON p.id = a."paymentId"
        WHERE a.id = $1 AND a."paymentId" = $2 AND a.provider = $3`,
      [attemptId, paymentId, SIMULATION_PROVIDER_ID],
    );
    const attempt = rows[0];
    if (!attempt || attempt.liveMode === true || attempt.paymentLiveMode === true) throw notFound();
    const snapshot = Number(attempt.amount);
    const amount = dto.outcome === 'succeeded' ? snapshot : dto.outcome === 'amount_mismatch' ? (snapshot > 1 ? snapshot - 1 : snapshot + 1) : null;
    const currency = amount === null ? null : attempt.currency;
    const providerTxnId = simulationTransactionId(attemptId);
    const eventBody = SimulationPaymentProvider.notificationBody({
      commandId: dto.commandId, attemptId, instruction: dto.outcome, failureCode: dto.failureCode ?? null, amount: amount ?? undefined, currency: currency ?? undefined, providerTxnId,
    });
    const result = await this.record({ commandId: dto.commandId, kind: 'outcome', paymentId, attemptId, instruction: dto.outcome, failureCode: dto.failureCode ?? null,
      amount, currency, providerTxnId, eventBody, delivery: eventBody ? (dto.delivery ?? 'immediate') : null });
    if (!result.replayed && result.command.delivery === 'immediate') return { ...result, delivered: await this.deliverBody(result.command) };
    return result;
  }

  /** Delivers (again) the notification a command produced: a held one late, or a repeat. The webhook key makes a repeat a no-op (F-S6). */
  async deliver(commandId: string): Promise<SimulationCommandResult> {
    this.assertEnabled();
    const { rows } = await this.db.query<SimulationCommandRow>('SELECT * FROM simulation_provider_command WHERE "commandId" = $1', [commandId]);
    const command = rows[0];
    if (!command) throw notFound();
    if (!command.eventBody) throw paymentError(409, 'simulation_nothing_to_deliver', PAYMENT_MESSAGES.simulationNothingToDeliver);
    return { command, replayed: false, delivered: await this.deliverBody(command) };
  }

  /** Through the SAME pipeline a provider's HTTP call reaches: signature verification, the permanent event key, then the evidence rules. */
  private async deliverBody(command: SimulationCommandRow): Promise<{ status: number }> {
    const body = command.eventBody!;
    const result = await this.webhooks.receive(this.provider, body, { [SIMULATION_SIGNATURE_HEADER]: this.provider.sign(body) });
    this.logger.log(`simulation_notification_delivered command=${command.commandId} attempt=${command.attemptId} status=${result.status}`);
    return result;
  }

  private async record(row: Omit<SimulationCommandRow, 'createdAt' | 'seq' | 'provider' | 'amount'> & { amount: number | null }): Promise<SimulationCommandResult> {
    const { rows } = await this.db.query<SimulationCommandRow>(
      `INSERT INTO simulation_provider_command ("commandId", kind, "paymentId", "attemptId", instruction, "failureCode", amount, currency, "providerTxnId", "eventBody", delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT ("commandId") DO NOTHING RETURNING *`,
      [row.commandId, row.kind, row.paymentId, row.attemptId, row.instruction, row.failureCode, row.amount, row.currency, row.providerTxnId, row.eventBody, row.delivery],
    );
    if (rows[0]) {
      this.logger.log(`simulation_command_recorded command=${row.commandId} kind=${row.kind} instruction=${row.instruction} payment=${row.paymentId}`);
      return { command: rows[0], replayed: false, delivered: null };
    }
    const { rows: existing } = await this.db.query<SimulationCommandRow>('SELECT * FROM simulation_provider_command WHERE "commandId" = $1', [row.commandId]);
    const stored = existing[0]!;
    if (CONTENT.some((k) => (stored[k] ?? null) !== (row[k] ?? null))) {
      throw paymentError(409, 'simulation_command_conflict', PAYMENT_MESSAGES.simulationCommandConflict);
    }
    return { command: stored, replayed: true, delivered: null };
  }

  /**
   * Core V2 S6b (R6B-6): how the simulated provider answers the refund dispatches of one payment (by default it accepts them). A rejection is
   * the provider's definitive refusal for a key it has not answered yet; it never applies to a refund the provider already took.
   */
  async planRefundDispatch(paymentId: string, dto: SimulationRefundDispatchPlanDto): Promise<SimulationRefundCommandResult> {
    this.assertEnabled();
    if ((dto.failureCode !== undefined) !== (dto.mode === 'rejected')) throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [paymentId]);
    const payment = rows[0];
    if (!payment || payment.liveMode === true) throw notFound();
    return this.recordRefund({ commandId: dto.commandId, kind: 'dispatch_plan', paymentId, refundAttemptId: null, capturedAttemptId: null, instruction: dto.mode,
      failureCode: dto.failureCode ?? null, amount: null, currency: null, providerRefundId: null, eventBody: null, delivery: null });
  }

  /**
   * Core V2 S6b (R6B-6): what the simulated provider says happened to one refund it RECEIVED (a refund it was never sent has no outcome:
   * `not_found`). Amount, currency and the provider refund reference are derived from Payment's attempt, never supplied; a notifying outcome
   * is delivered (now or later) through the signed webhook pipeline, so the harness never writes Payment's evidence itself.
   */
  async recordRefundOutcome(refundAttemptId: string, dto: SimulationRefundOutcomeDto): Promise<SimulationRefundCommandResult> {
    this.assertEnabled();
    const notifies = dto.outcome === 'succeeded' || dto.outcome === 'amount_mismatch' || dto.outcome === 'failed';
    if ((dto.failureCode !== undefined) !== (dto.outcome === 'failed') || (dto.delivery !== undefined && !notifies)) {
      throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    }
    const { rows } = await this.db.query<RefundAttemptRow>(
      `SELECT a.* FROM refund_attempt a JOIN simulation_refund_dispatch d ON d."idempotencyKey" = a.id WHERE a.id = $1 AND a.provider = $2 AND a."liveMode" = false`,
      [refundAttemptId, SIMULATION_PROVIDER_ID],
    );
    const attempt = rows[0];
    if (!attempt) throw notFound();
    const snapshot = Number(attempt.amount);
    const amount = dto.outcome === 'succeeded' ? snapshot : dto.outcome === 'amount_mismatch' ? (snapshot > 1 ? snapshot - 1 : snapshot + 1) : null;
    const currency = amount === null ? null : attempt.currency.trim();
    const providerRefundId = simulationRefundId(refundAttemptId);
    const eventBody = SimulationPaymentProvider.refundNotificationBody({
      commandId: dto.commandId, refundAttemptId, instruction: dto.outcome, failureCode: dto.failureCode ?? null, amount: amount ?? undefined, currency: currency ?? undefined, providerRefundId,
    });
    const result = await this.recordRefund({ commandId: dto.commandId, kind: 'outcome', paymentId: attempt.paymentId, refundAttemptId, capturedAttemptId: attempt.capturedAttemptId,
      instruction: dto.outcome, failureCode: dto.failureCode ?? null, amount, currency, providerRefundId, eventBody, delivery: eventBody ? (dto.delivery ?? 'immediate') : null });
    if (!result.replayed && result.command.delivery === 'immediate') return { ...result, delivered: await this.deliverRefundBody(result.command) };
    return result;
  }

  async deliverRefund(commandId: string): Promise<SimulationRefundCommandResult> {
    this.assertEnabled();
    const { rows } = await this.db.query<SimulationRefundCommandRow>('SELECT * FROM simulation_refund_command WHERE "commandId" = $1', [commandId]);
    const command = rows[0];
    if (!command) throw notFound();
    if (!command.eventBody) throw paymentError(409, 'simulation_nothing_to_deliver', PAYMENT_MESSAGES.simulationNothingToDeliver);
    return { command, replayed: false, delivered: await this.deliverRefundBody(command) };
  }

  private async deliverRefundBody(command: SimulationRefundCommandRow): Promise<{ status: number }> {
    const body = command.eventBody!;
    const result = await this.webhooks.receive(this.provider, body, { [SIMULATION_SIGNATURE_HEADER]: this.provider.sign(body) });
    this.logger.log(`simulation_refund_notification_delivered command=${command.commandId} refundAttempt=${command.refundAttemptId} status=${result.status}`);
    return result;
  }

  private async recordRefund(row: Omit<SimulationRefundCommandRow, 'createdAt' | 'seq' | 'provider' | 'amount'> & { amount: number | null }): Promise<SimulationRefundCommandResult> {
    const { rows } = await this.db.query<SimulationRefundCommandRow>(
      `INSERT INTO simulation_refund_command ("commandId", kind, "paymentId", "refundAttemptId", "capturedAttemptId", instruction, "failureCode", amount, currency, "providerRefundId", "eventBody", delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT ("commandId") DO NOTHING RETURNING *`,
      [row.commandId, row.kind, row.paymentId, row.refundAttemptId, row.capturedAttemptId, row.instruction, row.failureCode, row.amount, row.currency, row.providerRefundId, row.eventBody, row.delivery],
    );
    if (rows[0]) {
      this.logger.log(`simulation_refund_command_recorded command=${row.commandId} kind=${row.kind} instruction=${row.instruction} payment=${row.paymentId}`);
      return { command: rows[0], replayed: false, delivered: null };
    }
    const { rows: existing } = await this.db.query<SimulationRefundCommandRow>('SELECT * FROM simulation_refund_command WHERE "commandId" = $1', [row.commandId]);
    const stored = existing[0]!;
    if (REFUND_CONTENT.some((k) => (stored[k] ?? null) !== (row[k] ?? null))) throw paymentError(409, 'simulation_command_conflict', PAYMENT_MESSAGES.simulationCommandConflict);
    return { command: stored, replayed: true, delivered: null };
  }

  /**
   * Core V2 S6e-D (R6E-2): what the simulated provider reports about a dispute of one captured simulation payment, delivered (now or later)
   * through the signed webhook pipeline: the harness never writes a dispute, an observation or a chargeback fact itself. The disputed attempt,
   * the currency and the provider references are derived from Payment's own rows (F-S3); a payment with no captured simulation attempt has
   * nothing to dispute.
   */
  async recordDispute(paymentId: string, dto: SimulationDisputeDto): Promise<SimulationDisputeCommandResult> {
    this.assertEnabled();
    const lossOnly = dto.chargeback !== undefined || dto.chargebackAmount !== undefined || dto.chargebackRef !== undefined;
    if (lossOnly && dto.event !== 'lost') throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    if (dto.chargeback === 'none' && (dto.chargebackAmount !== undefined || dto.chargebackRef !== undefined)) {
      throw paymentError(400, 'invalid_simulation_command', PAYMENT_MESSAGES.invalidSimulationCommand);
    }
    const { rows } = await this.db.query<PaymentRow & { attemptProvider: string | null }>(
      `SELECT p.*, a.provider AS "attemptProvider" FROM payment p LEFT JOIN payment_attempt a ON a.id = p."succeededAttemptId" WHERE p.id = $1`, [paymentId]);
    const payment = rows[0];
    if (!payment || payment.liveMode === true) throw notFound();
    if (!payment.succeededAttemptId || payment.attemptProvider !== SIMULATION_PROVIDER_ID) {
      throw paymentError(409, 'simulation_nothing_to_dispute', PAYMENT_MESSAGES.simulationNothingToDispute);
    }
    const amount = dto.amount ?? Number(payment.amount);
    const currency = payment.currency.trim();
    const providerDisputeId = `simd_${dto.disputeRef}`;
    const chargeback = dto.event === 'lost' && dto.chargeback !== 'none'
      ? { txnId: `simcb_${dto.chargebackRef ?? dto.disputeRef}`, amount: dto.chargebackAmount ?? amount, currency }
      : null;
    const eventBody = SimulationPaymentProvider.disputeNotificationBody({
      commandId: dto.commandId, attemptId: payment.succeededAttemptId, instruction: dto.event, providerDisputeId, amount, currency, reason: dto.reason ?? null, chargeback,
    });
    const delivery = dto.delivery ?? 'immediate';
    const inserted = await this.db.query<SimulationDisputeCommandRow>(
      `INSERT INTO simulation_dispute_command ("commandId", "paymentId", "attemptId", "providerDisputeId", instruction, amount, currency, reason,
         "chargebackTxnId", "chargebackAmount", "chargebackCurrency", "eventBody", delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT ("commandId") DO NOTHING RETURNING *`,
      [dto.commandId, paymentId, payment.succeededAttemptId, providerDisputeId, dto.event, amount, currency, dto.reason ?? null,
        chargeback?.txnId ?? null, chargeback?.amount ?? null, chargeback ? currency : null, eventBody, delivery],
    );
    if (!inserted.rows[0]) {
      const stored = (await this.db.query<SimulationDisputeCommandRow>('SELECT * FROM simulation_dispute_command WHERE "commandId" = $1', [dto.commandId])).rows[0]!;
      const now: Record<(typeof DISPUTE_CONTENT)[number], unknown> = {
        paymentId, providerDisputeId, instruction: dto.event, amount: String(amount), reason: dto.reason ?? null, chargebackTxnId: chargeback?.txnId ?? null,
        chargebackAmount: chargeback ? String(chargeback.amount) : null, delivery,
      };
      if (DISPUTE_CONTENT.some((k) => (stored[k] === null ? null : String(stored[k])) !== now[k])) {
        throw paymentError(409, 'simulation_command_conflict', PAYMENT_MESSAGES.simulationCommandConflict);
      }
      return { command: stored, replayed: true, delivered: null };
    }
    const command = inserted.rows[0];
    this.logger.log(`simulation_dispute_command_recorded command=${command.commandId} event=${command.instruction} payment=${paymentId}`);
    return { command, replayed: false, delivered: delivery === 'immediate' ? await this.deliverDisputeBody(command) : null };
  }

  /** Delivers (again) a dispute command's notification: a held one late, or a repeat (the webhook key makes a repeat a no-op). */
  async deliverDispute(commandId: string): Promise<SimulationDisputeCommandResult> {
    this.assertEnabled();
    const command = (await this.db.query<SimulationDisputeCommandRow>('SELECT * FROM simulation_dispute_command WHERE "commandId" = $1', [commandId])).rows[0];
    if (!command) throw notFound();
    return { command, replayed: false, delivered: await this.deliverDisputeBody(command) };
  }

  private async deliverDisputeBody(command: SimulationDisputeCommandRow): Promise<{ status: number }> {
    const result = await this.webhooks.receive(this.provider, command.eventBody, { [SIMULATION_SIGNATURE_HEADER]: this.provider.sign(command.eventBody) });
    this.logger.log(`simulation_dispute_notification_delivered command=${command.commandId} status=${result.status}`);
    return result;
  }

  private assertEnabled(): void {
    if (!this.config.simulation || this.config.isProduction) throw notFound();
  }
}
