import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentRow } from '../payments/payment.types.js';
import type { FetchStatusResult, InitiateResult, ParsedWebhookBody, PaymentProvider, ProviderCapabilities, VerifyWebhookResult } from './provider.port.js';

export const SIMULATION_PROVIDER_ID = 'simulation';
export const SIMULATION_SIGNATURE_HEADER = 'x-simulation-signature';

/** This provider's transaction reference for an attempt: derived, never supplied by a caller. */
export function simulationTransactionId(attemptId: string): string {
  return `sim_${attemptId}`;
}

/** One row of `simulation_provider_command` (migration 0015). */
export interface SimulationCommandRow {
  commandId: string;
  kind: 'initiation' | 'outcome';
  paymentId: string;
  attemptId: string | null;
  provider: string;
  instruction: string;
  failureCode: string | null;
  amount: string | null;
  currency: string | null;
  providerTxnId: string | null;
  eventBody: Buffer | null;
  delivery: 'immediate' | 'held' | null;
  createdAt: Date;
  seq: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Core V2 S4f (register PAY-14; S0 §1.1, FC-10; the Owner's F-S1 to F-S7): the `simulation` provider, beside `test`, for non-production
 * certification. Its "provider records" are the authorized harness's commands (`simulation_provider_command`), so every instance and
 * restart sees the same simulated provider. Payment learns from it ONLY through the ordinary port: `initiate`, the status read and a
 * signed notification verified with the operator's own secret. Nothing a payer sends chooses an outcome (F-S7): attempt options are
 * refused before this adapter is reached, and `initiate` ignores them.
 */
@Injectable()
export class SimulationPaymentProvider implements PaymentProvider {
  readonly id = SIMULATION_PROVIDER_ID;
  readonly capabilities: ProviderCapabilities = {
    refunds: false,
    partialRefunds: false,
    notFoundIsAuthoritative: true,
    visibilityLagMs: 50,
    timeoutMs: 200,
    sessionExpiry: true,
    paymentFatalCodes: [],
  };

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  /** The latest initiation plan the harness set for this payment answers every new attempt; none means the provider accepts it. */
  async initiate(payment: PaymentRow, attempt: { id: string; merchantReference: string }): Promise<InitiateResult> {
    const { rows } = await this.db.query<SimulationCommandRow>(
      `SELECT * FROM simulation_provider_command WHERE "paymentId" = $1 AND kind = 'initiation' ORDER BY seq DESC LIMIT 1`, [payment.id]);
    const plan = rows[0];
    if (plan?.instruction === 'rejected') return { kind: 'rejected', failureClass: 'terminal', failureCode: plan.failureCode ?? 'declined' };
    // `ambiguous`: the provider recorded the attempt but its answer never reached Payment; the resolver, a status read or a
    // notification settles it later
    if (plan?.instruction === 'ambiguous') return { kind: 'ambiguous' };
    return { kind: 'accepted', providerTransactionId: simulationTransactionId(attempt.merchantReference) };
  }

  /** The provider's current answer for an attempt: its latest outcome command, or still pending when the harness gave none. */
  async fetchStatus(ref: string): Promise<FetchStatusResult> {
    const attemptId = ref.startsWith('sim_') ? ref.slice('sim_'.length) : ref;
    if (!UUID.test(attemptId)) return { kind: 'notFound' };
    const { rows } = await this.db.query<SimulationCommandRow>(
      `SELECT * FROM simulation_provider_command WHERE "attemptId" = $1 AND kind = 'outcome' ORDER BY seq DESC LIMIT 1`, [attemptId]);
    const outcome = rows[0];
    switch (outcome?.instruction) {
      case 'succeeded':
      case 'amount_mismatch':
        return { kind: 'succeeded', amount: Number(outcome.amount), currency: outcome.currency!, providerTransactionId: outcome.providerTxnId! };
      case 'failed':
        return { kind: 'failed', failureClass: 'terminal', failureCode: outcome.failureCode! };
      case 'expired':
        return { kind: 'expired' };
      case 'no_record':
        return { kind: 'notFound' };
      default:
        return { kind: 'pending' };
    }
  }

  /** The signed notification an outcome command produces: `sim_<commandId>` is its event id, so a redelivery is the same event. */
  static notificationBody(command: { commandId: string; attemptId: string; instruction: string; failureCode?: string | null; amount?: number; currency?: string; providerTxnId: string }): Buffer | null {
    const base = { eventId: `sim_${command.commandId}`, reference: command.attemptId, providerTransactionId: command.providerTxnId };
    switch (command.instruction) {
      case 'succeeded':
      case 'amount_mismatch':
        return Buffer.from(JSON.stringify({ ...base, type: 'payment.succeeded', amount: command.amount, currency: command.currency }), 'utf8');
      case 'failed':
        return Buffer.from(JSON.stringify({ ...base, type: 'payment.failed', data: { failureCode: command.failureCode, failureClass: 'terminal' } }), 'utf8');
      case 'expired':
        return Buffer.from(JSON.stringify({ ...base, type: 'payment.expired' }), 'utf8');
      default:
        return null;
    }
  }

  /** The signature this provider puts on a notification, with the operator's secret (F-S5). */
  sign(body: Buffer): string {
    return createHmac('sha256', this.secret()).update(body).digest('hex');
  }

  async verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifyWebhookResult> {
    const header = headers[SIMULATION_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature || !safeEqualHex(signature, this.sign(rawBody))) return { signatureValid: false };
    return { signatureValid: true, parsed: this.parseStoredBody(rawBody) };
  }

  parseStoredBody(rawBody: Buffer): ParsedWebhookBody | null {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
      if (typeof body.eventId !== 'string' || typeof body.type !== 'string' || typeof body.reference !== 'string') return null;
      return {
        providerEventId: body.eventId,
        type: body.type,
        reference: body.reference,
        providerTransactionId: typeof body.providerTransactionId === 'string' ? body.providerTransactionId : undefined,
        amount: typeof body.amount === 'number' ? body.amount : undefined,
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        data: body.data,
      };
    } catch {
      return null;
    }
  }

  /** Fails closed: without the operator's signing material this provider can neither sign nor accept anything (F-S5). */
  private secret(): string {
    const secret = this.config.simulation?.webhookSecret;
    if (!secret || this.config.isProduction) throw new Error('simulation provider is not enabled');
    return secret;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
