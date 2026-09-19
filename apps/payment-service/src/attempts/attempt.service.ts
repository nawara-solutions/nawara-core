import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import { deterministicEventId } from '../events/deterministic-id.js';
import { paymentError } from '../errors.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { PaymentRow } from '../payments/payment.types.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { FetchStatusResult, PaymentProvider } from '../providers/provider.port.js';
import type { AttemptRow } from './attempt.types.js';
import type { StartAttemptDto } from './dto/start-attempt.dto.js';

export interface StartAttemptResult {
  attempt: AttemptRow;
  replayed: boolean;
}

/** Owns `payment_attempt` rows: start (T1/provider-call/T2, SDD section 12.2) and sync (section 9.1 endpoint 4). */
@Injectable()
export class AttemptService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  async findById(id: string): Promise<AttemptRow | null> {
    const { rows } = await this.db.query<AttemptRow>('SELECT * FROM payment_attempt WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async start(paymentId: string, callerId: string, idempotencyKey: string, dto: StartAttemptDto): Promise<StartAttemptResult> {
    const providerId = dto.provider ?? 'test';
    const provider = this.providers.get(providerId); // throws 422 invalid_provider if not enabled
    const attemptId = randomUUID();
    const requestHash = IdempotencyService.requestHash('start_attempt', `/payment/payments/${paymentId}/attempts`, dto);

    const t1 = await this.db.tx(async (q) => {
      const reserved = await this.idempotency.reserve(q, {
        caller: `user:${callerId}`,
        operation: 'start_attempt',
        key: idempotencyKey,
        requestHash,
        responseStatus: 201,
        resourceType: 'payment_attempt',
        resourceId: attemptId,
        ttlHours: this.config.idempotencyTtlHours,
      });
      if (reserved.replay) return { replay: true as const, attemptId: reserved.resourceId };

      const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [paymentId]);
      const payment = rows[0];
      if (!payment) throw paymentError(404, 'not_found', 'Not found.');
      if (payment.expiresAt && payment.expiresAt.getTime() <= Date.now()) throw paymentError(409, 'payment_expired', 'This payment has expired.');
      // "pending" only means an open collection path in this phase (no cash exists yet): report the specific reason,
      // not the generic "not payable" (SDD section 5.1's "one open collection at a time").
      if (payment.status === 'pending') throw paymentError(409, 'payment_has_open_attempt', 'An attempt is already open for this payment.');
      if (payment.status !== 'created') throw paymentError(409, 'payment_not_payable', `Cannot start an attempt on a payment in status ${payment.status}.`);
      const { rows: open } = await q.query(`SELECT 1 FROM payment_attempt WHERE "paymentId" = $1 AND status IN ('initiated','submitted','unknown')`, [paymentId]);
      if (open.length > 0) throw paymentError(409, 'payment_has_open_attempt', 'An attempt is already open for this payment.');
      const { rows: countRows } = await q.query<{ count: number }>('SELECT count(*)::int AS count FROM payment_attempt WHERE "paymentId" = $1', [paymentId]);
      const attemptNumber = countRows[0].count + 1;

      const { rows: inserted } = await q.query<AttemptRow>(
        `INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1,$2,$3,$4) RETURNING *`,
        [attemptId, paymentId, attemptNumber, providerId],
      );
      await q.query(`UPDATE payment SET status = 'pending' WHERE id = $1`, [paymentId]);
      return { replay: false as const, payment, attempt: inserted[0] };
    });

    if (t1.replay) {
      const attempt = await this.findById(t1.attemptId);
      if (!attempt) throw paymentError(404, 'not_found', 'Not found.');
      return { attempt, replayed: true };
    }

    // The provider call happens OUTSIDE any transaction (SDD section 12): never hold a lock across a network call.
    const initiateResult = await provider.initiate(t1.payment, { id: t1.attempt.id, merchantReference: t1.attempt.merchantReference, options: dto.providerOptions });

    const attempt = await this.db.tx(async (q) => {
      if (initiateResult.kind === 'accepted') {
        const { rows } = await q.query<AttemptRow>(
          `UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = $2, "providerData" = $3, "submittedAt" = now() WHERE id = $1 RETURNING *`,
          [t1.attempt.id, initiateResult.providerTransactionId, JSON.stringify(initiateResult.nextAction ?? null)],
        );
        return rows[0];
      }
      if (initiateResult.kind === 'ambiguous') {
        // Never retried blindly (SDD section 5.2, 12): the resolver settles it later by lookup or webhook.
        const { rows } = await q.query<AttemptRow>(`UPDATE payment_attempt SET status = 'unknown' WHERE id = $1 RETURNING *`, [t1.attempt.id]);
        return rows[0];
      }
      const { rows } = await q.query<AttemptRow>(
        `UPDATE payment_attempt SET status = 'failed', "failureCode" = $2, "failureClass" = $3, "completedAt" = now() WHERE id = $1 RETURNING *`,
        [t1.attempt.id, initiateResult.failureCode, initiateResult.failureClass],
      );
      await this.settlePaymentAfterFailure(q, t1.payment.id, t1.attempt.attemptNumber, initiateResult.failureCode, provider);
      return rows[0];
    });

    return { attempt, replayed: false };
  }

  /** Endpoint 4 (SDD section 9.1): asks the provider for the attempt's status; the client's own claim is never used. */
  async sync(attemptId: string): Promise<AttemptRow> {
    const attempt = await this.findById(attemptId);
    if (!attempt) throw paymentError(404, 'not_found', 'Not found.');
    const provider = this.providers.get(attempt.provider);
    const ref = attempt.providerTransactionId ?? attempt.merchantReference;
    const status = await provider.fetchStatus(ref);
    return this.applyStatus(attemptId, status, provider);
  }

  /** Shared by `sync` and (later) the resolver/webhook path: applies a verified provider result if it's a valid transition. */
  async applyStatus(attemptId: string, status: FetchStatusResult, provider: PaymentProvider): Promise<AttemptRow> {
    return this.db.tx(async (q) => {
      const { rows: attRows } = await q.query<AttemptRow>('SELECT * FROM payment_attempt WHERE id = $1 FOR UPDATE', [attemptId]);
      const current = attRows[0];
      if (!current) throw paymentError(404, 'not_found', 'Not found.');
      const { rows: payRows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [current.paymentId]);
      const payment = payRows[0];

      if (status.kind === 'pending') return current; // still waiting; nothing changes

      if (status.kind === 'notFound') {
        if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'expired') return current;
        if (!provider.capabilities.notFoundIsAuthoritative) return current; // stays unknown/initiated; an alert is the resolver's job
        const { rows } = await q.query<AttemptRow>(
          `UPDATE payment_attempt SET status = 'failed', "failureCode" = 'not_found', "failureClass" = 'terminal', "failureInferred" = true, "completedAt" = now() WHERE id = $1 RETURNING *`,
          [attemptId],
        );
        await this.settlePaymentAfterFailure(q, payment.id, current.attemptNumber, 'not_found', provider);
        return rows[0];
      }

      if (status.kind === 'succeeded') {
        if (current.status === 'succeeded') return current; // idempotent replay of the same fact
        if (Number(payment.amount) !== status.amount || payment.currency !== status.currency) {
          // FI-13: never applied silently. No new state is introduced for this — it is refused outright.
          throw paymentError(502, 'provider_error', 'Provider-reported amount/currency does not match the payment snapshot.');
        }
        if (current.status === 'failed' || current.status === 'expired') {
          // Late success: accepted only if THIS failure was inferred (a guess); a provider-confirmed failure is a real conflict.
          if (!current.failureInferred) throw paymentError(409, 'invalid_state_transition', 'Late success conflicts with a provider-confirmed failure.');
        }
        const { rows } = await q.query<AttemptRow>(`UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = $1 RETURNING *`, [attemptId]);
        if (payment.status !== 'succeeded') {
          await q.query(
            `UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = $2, "closedAt" = now() WHERE id = $1`,
            [payment.id, attemptId],
          );
          await this.outbox.enqueue(q, {
            id: deterministicEventId(payment.id, 'payment.succeeded'),
            name: 'payment.succeeded',
            payload: { paymentId: payment.id, settledMethod: 'gateway', amount: Number(payment.amount), currency: payment.currency },
          });
        }
        return rows[0];
      }

      // status.kind === 'failed'
      if (current.status === 'succeeded') throw paymentError(409, 'invalid_state_transition', 'Cannot fail an attempt that already succeeded.');
      if (current.status === 'failed' || current.status === 'expired') return current;
      const { rows } = await q.query<AttemptRow>(
        `UPDATE payment_attempt SET status = 'failed', "failureCode" = $2, "failureClass" = $3, "completedAt" = now() WHERE id = $1 RETURNING *`,
        [attemptId, status.failureCode, status.failureClass],
      );
      await this.settlePaymentAfterFailure(q, payment.id, current.attemptNumber, status.failureCode, provider);
      return rows[0];
    });
  }

  /** After an attempt fails: the payment fails if the attempt limit is reached or the provider says the payment
   * itself is unrecoverable; otherwise it returns to `created` so the payer can retry (SDD section 5.1). */
  private async settlePaymentAfterFailure(q: Queryable, paymentId: string, attemptNumber: number, failureCode: string | null, provider: PaymentProvider): Promise<void> {
    const { rows } = await q.query<PaymentRow>('SELECT status FROM payment WHERE id = $1', [paymentId]);
    if (rows[0]?.status !== 'pending') return; // already moved on by another path
    const paymentFatal = failureCode !== null && provider.capabilities.paymentFatalCodes.includes(failureCode);
    const limitReached = attemptNumber >= this.config.maxAttempts;
    const nextStatus = paymentFatal || limitReached ? 'failed' : 'created';
    await q.query(`UPDATE payment SET status = $2, "closedAt" = CASE WHEN $2 = 'failed' THEN now() ELSE "closedAt" END WHERE id = $1`, [paymentId, nextStatus]);
    if (nextStatus === 'failed') {
      await this.outbox.enqueue(q, {
        id: deterministicEventId(paymentId, 'payment.failed'),
        name: 'payment.failed',
        payload: { paymentId, failureCode },
      });
    }
  }
}
