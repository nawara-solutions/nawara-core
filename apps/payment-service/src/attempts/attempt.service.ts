import { PaymentAudit } from '../audit/payment-audit.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import { paymentEvent, requestContext, type EventContext } from '../events/payment-events.js';
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
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
  ) {}

  async findById(id: string): Promise<AttemptRow | null> {
    const { rows } = await this.db.query<AttemptRow>('SELECT * FROM payment_attempt WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async start(paymentId: string, callerId: string, idempotencyKey: string, dto: StartAttemptDto, userKind?: EventContext['userKind']): Promise<StartAttemptResult> {
    // Only the payer (a verified user) starts an attempt; a fatal provider rejection fails the payment under this context (Stage 18.7 G1).
    const ctx: EventContext = { ...requestContext({ type: 'user', id: callerId }), ...(userKind ? { userKind } : {}) };
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

      const { rows } = await q.query<PaymentRow & { isExpired: boolean }>(
        'SELECT *, ("expiresAt" IS NOT NULL AND "expiresAt" <= now()) AS "isExpired" FROM payment WHERE id = $1 FOR UPDATE',
        [paymentId],
      ); // database time is the only clock (SDD section 12)
      const payment = rows[0];
      if (!payment) throw paymentError(404, 'not_found', 'Not found.');
      if (payment.isExpired) throw paymentError(409, 'payment_expired', 'This payment has expired.');
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

    // T2. Lock order (SDD section 12): the payment row first, then the attempt row. The update is CONDITIONAL on the attempt
    // still being `initiated` or `unknown` ("so a resolver that got there first does not make the provider's real answer
    // fail"): if a webhook, `sync` or the resolver already settled it, that fact wins and T2 returns it untouched.
    const attempt = await this.db.tx(async (q) => {
      await q.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [t1.payment.id]);
      const { rows: currentRows } = await q.query<AttemptRow>('SELECT * FROM payment_attempt WHERE id = $1 FOR UPDATE', [t1.attempt.id]);
      const current = currentRows[0];
      if (current.status !== 'initiated' && current.status !== 'unknown') return current;

      if (initiateResult.kind === 'accepted') {
        const { rows } = await q.query<AttemptRow>(
          `UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = $2, "providerData" = $3, "submittedAt" = now()
           WHERE id = $1 AND status IN ('initiated', 'unknown') RETURNING *`,
          [t1.attempt.id, initiateResult.providerTransactionId, JSON.stringify(initiateResult.nextAction ?? null)],
        );
        return rows[0];
      }
      if (initiateResult.kind === 'ambiguous') {
        // Never retried blindly (SDD section 5.2, 12): the resolver settles it later by lookup or webhook.
        if (current.status === 'unknown') return current;
        const { rows } = await q.query<AttemptRow>(`UPDATE payment_attempt SET status = 'unknown' WHERE id = $1 AND status = 'initiated' RETURNING *`, [t1.attempt.id]);
        return rows[0];
      }
      await this.settlePaymentAfterFailure(q, t1.payment.id, t1.attempt.attemptNumber, initiateResult.failureCode, provider, ctx);
      const { rows } = await q.query<AttemptRow>(
        `UPDATE payment_attempt SET status = 'failed', "failureCode" = $2, "failureClass" = $3, "completedAt" = now()
         WHERE id = $1 AND status IN ('initiated', 'unknown') RETURNING *`,
        [t1.attempt.id, initiateResult.failureCode, initiateResult.failureClass],
      );
      return rows[0];
    });

    return { attempt, replayed: false };
  }

  /** Endpoint 4 (SDD section 9.1): asks the provider for the attempt's status; the client's own claim is never used. */
  async sync(attemptId: string, ctx: EventContext): Promise<AttemptRow> {
    const attempt = await this.findById(attemptId);
    if (!attempt) throw paymentError(404, 'not_found', 'Not found.');
    const provider = this.providers.get(attempt.provider);
    const ref = attempt.providerTransactionId ?? attempt.merchantReference;
    const status = await provider.fetchStatus(ref);
    return this.applyStatus(attemptId, status, provider, ctx);
  }

  /** Shared by `sync`, the resolver and the webhook path: applies a verified provider result if it's a valid
   * transition. Fixed lock order to prevent deadlocks (SDD section 12): find the attempt WITHOUT locking (just to
   * learn its paymentId), lock the payment row first, then re-read and lock the attempt row.
   *
   * A verified success is applied at most once per payment (FI-03/FI-06): success for a payment that is already
   * terminal in ANY way — including succeeded through a different attempt — is a `409 invalid_state_transition`
   * (a recorded conflict on the webhook path), never applied and never silently swallowed (SDD section 5.1 "late success"). */
  async applyStatus(attemptId: string, status: FetchStatusResult, provider: PaymentProvider, ctx: EventContext = { actor: { type: 'system', id: null }, cause: { type: 'attempt_resolver', id: null } }): Promise<AttemptRow> {
    return this.db.tx(async (q) => {
      const { rows: unlocked } = await q.query<AttemptRow>('SELECT "paymentId" FROM payment_attempt WHERE id = $1', [attemptId]);
      if (!unlocked[0]) throw paymentError(404, 'not_found', 'Not found.');
      const { rows: payRows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [unlocked[0].paymentId]);
      const payment = payRows[0];
      const { rows: attRows } = await q.query<AttemptRow>('SELECT * FROM payment_attempt WHERE id = $1 FOR UPDATE', [attemptId]);
      const current = attRows[0];

      if (status.kind === 'pending') return current; // still waiting; nothing changes

      if (status.kind === 'notFound') {
        // "No record" may fail an attempt only when the adapter declares it authoritative (SDD section 5.2), and only for an
        // attempt whose outcome we do not know (`initiated` is first moved to `unknown`, as the resolver does). A `submitted`
        // attempt has a provider transaction id: "no record" contradicts that, so it stays put rather than being failed by guess.
        if (current.status !== 'initiated' && current.status !== 'unknown') return current;
        if (!provider.capabilities.notFoundIsAuthoritative) return current; // stays unknown/initiated; an alert is the resolver's job
        if (current.status === 'initiated') await q.query(`UPDATE payment_attempt SET status = 'unknown' WHERE id = $1`, [attemptId]);
        const { rows } = await q.query<AttemptRow>(
          `UPDATE payment_attempt SET status = 'failed', "failureCode" = 'not_found', "failureClass" = 'terminal', "failureInferred" = true, "completedAt" = now() WHERE id = $1 RETURNING *`,
          [attemptId],
        );
        await this.settlePaymentAfterFailure(q, payment.id, current.attemptNumber, 'not_found', provider, ctx);
        return rows[0];
      }

      if (status.kind === 'succeeded') {
        if (current.status === 'succeeded') return current; // idempotent replay of the same fact
        if (Number(payment.amount) !== status.amount || payment.currency !== status.currency) {
          // FI-13: never applied silently. No new state is introduced for this — it is refused outright.
          throw paymentError(502, 'provider_error', 'Provider-reported amount/currency does not match the payment snapshot.');
        }
        if (payment.status === 'failed' || payment.status === 'cancelled' || payment.status === 'expired' || payment.status === 'succeeded') {
          throw paymentError(409, 'invalid_state_transition', `Provider success conflicts with a payment that is already ${payment.status}.`);
        }
        if (current.status === 'failed' || current.status === 'expired') {
          // Late success: accepted only if THIS failure was inferred (a guess); a provider-confirmed failure is a real conflict.
          if (!current.failureInferred) throw paymentError(409, 'invalid_state_transition', 'Late success conflicts with a provider-confirmed failure.');
        }
        // An attempt still `initiated` (crash before T2, or a webhook that beat T2) is first moved through `unknown`: the
        // provider's success proves it reached the provider, and the state machine has no direct `initiated -> succeeded`.
        if (current.status === 'initiated') await q.query(`UPDATE payment_attempt SET status = 'unknown' WHERE id = $1`, [attemptId]);
        const { rows } = await q.query<AttemptRow>(`UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = $1 RETURNING *`, [attemptId]);
        const { rows: settled } = await q.query<PaymentRow>(
          `UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = $2, "closedAt" = now() WHERE id = $1 RETURNING *`,
          [payment.id, attemptId],
        );
        await this.outbox.enqueue(q, paymentEvent('payment.succeeded', settled[0], ctx, { settledMethod: 'gateway', succeededAt: settled[0].closedAt?.toISOString() }));
        await this.audit.record(q, 'payment.succeeded', settled[0], ctx); // Stage 18.7.1 (G1)
        return rows[0];
      }

      // status.kind === 'failed'
      if (current.status === 'succeeded') throw paymentError(409, 'invalid_state_transition', 'Cannot fail an attempt that already succeeded.');
      if (current.status === 'failed' || current.status === 'expired') return current;
      const { rows } = await q.query<AttemptRow>(
        `UPDATE payment_attempt SET status = 'failed', "failureCode" = $2, "failureClass" = $3, "completedAt" = now() WHERE id = $1 RETURNING *`,
        [attemptId, status.failureCode, status.failureClass],
      );
      await this.settlePaymentAfterFailure(q, payment.id, current.attemptNumber, status.failureCode, provider, ctx);
      return rows[0];
    });
  }

  /** After an attempt fails: the payment fails if the attempt limit is reached or the provider says the payment
   * itself is unrecoverable; otherwise it returns to `created` so the payer can retry (SDD section 5.1). */
  private async settlePaymentAfterFailure(q: Queryable, paymentId: string, attemptNumber: number, failureCode: string | null, provider: PaymentProvider, ctx: EventContext): Promise<void> {
    const { rows } = await q.query<PaymentRow>('SELECT status FROM payment WHERE id = $1 FOR UPDATE', [paymentId]);
    if (rows[0]?.status !== 'pending') return; // already moved on by another path
    const paymentFatal = failureCode !== null && provider.capabilities.paymentFatalCodes.includes(failureCode);
    const limitReached = attemptNumber >= this.config.maxAttempts;
    const nextStatus = paymentFatal || limitReached ? 'failed' : 'created';
    const { rows: updated } = await q.query<PaymentRow>(
      `UPDATE payment SET status = $2, "closedAt" = CASE WHEN $2 = 'failed' THEN now() ELSE "closedAt" END WHERE id = $1 RETURNING *`,
      [paymentId, nextStatus],
    );
    if (nextStatus === 'failed') {
      await this.outbox.enqueue(q, paymentEvent('payment.failed', updated[0], ctx, { failureCode }));
      await this.audit.record(q, 'payment.failed', updated[0], ctx); // Stage 18.7.1 (G1); the provider failure code stays out of central audit
    }
  }
}
