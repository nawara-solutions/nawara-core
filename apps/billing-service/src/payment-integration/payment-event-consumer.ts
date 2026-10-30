import { Inject, Injectable, Logger, Optional, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, EVENT_BUS, EVENT_NAME, PermanentEventFailure, PgProvenanceStore, pgCode, runWithEventContext, SAFE_ID, safeToken, strictEnforcement, type EventBus, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';
import type { PaymentEventName } from '../domain/payment-event-decision.js';
import type { PaymentEventFacts } from '../domain/payment-event-decision.js';
import { CONSUMED_EVENTS as CATALOG } from '../events/event-catalog.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
import { PaymentEventOriginRepository, trustedEnvelope, type TrustedPaymentEnvelope } from './payment-event-origin.js';
import { RefundCompletionService } from '../refunds/refund-completion.service.js';
import { LateSuccessService } from '../reconciliation/late-success.service.js';
import { DisputeLossService } from '../refunds/dispute-loss.service.js';

/** V2 A3M.2: the consumed names and their supported versions come from the event catalog (`events/event-catalog.ts`). */
const CONSUMED_EVENTS: readonly PaymentEventName[] = CATALOG.filter((c) => c.name.startsWith('payment.') && !c.name.startsWith('payment.dispute.')).map((c) => c.name as PaymentEventName);
/** Core V2 S6c: every name the queue binds (the payment outcomes, Payment's refund completion and, S6e-D, its verified dispute loss). */
const BOUND_EVENTS: readonly string[] = CATALOG.map((c) => c.name);
const SUPPORTED_VERSION: ReadonlyMap<string, number> = new Map(CATALOG.map((c) => [c.name, c.version]));
/** V2 A3M.3 (G11): the only source each consumed event may come from. A sanity filter on an ASSERTED header, never authentication. */
const EXPECTED_SOURCE: ReadonlyMap<string, string> = new Map(CATALOG.map((c) => [c.name, c.source]));

class MalformedPaymentEventError extends PermanentEventFailure {
  constructor() {
    super('malformed_payload');
  }
}

function isParty(v: unknown): v is { type: string; id: string } {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && typeof (v as { id?: unknown }).id === 'string';
}

/** A payment request id as Billing issues it: the only form a log line repeats (a malformed one is `[invalid]`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the wire payload into `PaymentEventFacts`, trusting NOTHING about its shape (SDD 21.4: the consumer never
 * trusts an event blindly). A payload that fails this parse is malformed (never a valid case Payment could produce)
 * and the handler throws, so the broker dead-letters it rather than silently dropping or misapplying it.
 */
function parseFacts(event: EventEnvelope, t: TrustedPaymentEnvelope): PaymentEventFacts {
  const p = event.payload;
  if (
    !CONSUMED_EVENTS.includes(t.name as PaymentEventName) ||
    typeof p.paymentId !== 'string' ||
    typeof p.producer !== 'string' ||
    typeof p.paymentRequestId !== 'string' ||
    typeof p.sourceType !== 'string' ||
    typeof p.sourceId !== 'string' ||
    !isParty(p.payer) ||
    !isParty(p.seller) ||
    (p.organizationId !== null && typeof p.organizationId !== 'string') ||
    typeof p.currency !== 'string' ||
    typeof p.revision !== 'number' ||
    // Core V2 S4a: optional on version 1 (absent before S4a); when present, exactly its type
    (p.purpose !== undefined && typeof p.purpose !== 'string') ||
    (p.beneficiaryUserId !== undefined && typeof p.beneficiaryUserId !== 'string') ||
    (p.liveMode !== undefined && typeof p.liveMode !== 'boolean')
  ) {
    throw new MalformedPaymentEventError();
  }
  return {
    name: t.name as PaymentEventName,
    source: t.source, // the broker-verified producer, never the `source` header
    paymentId: p.paymentId,
    producer: p.producer,
    paymentRequestId: p.paymentRequestId,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    payer: p.payer,
    seller: p.seller,
    organizationId: (p.organizationId as string | null) ?? null,
    amount: p.amount, // decidePaymentEvent itself validates shape (a safe integer) — never trusted before that check
    currency: p.currency,
    revision: p.revision,
    ...(p.purpose !== undefined ? { purpose: p.purpose as string } : {}),
    ...(p.beneficiaryUserId !== undefined ? { beneficiaryUserId: p.beneficiaryUserId as string } : {}),
    ...(p.liveMode !== undefined ? { liveMode: p.liveMode as boolean } : {}),
  };
}

/**
 * Subscribes to Payment's terminal events and wires them to the ALREADY-BUILT, already-tested decision logic (SDD
 * 21.3, 21.4). No business rule lives here — this is transport plumbing only: parse, invoke, done. `payment.created`
 * is deliberately not bound (SDD 21.3). Resolve = processed (acknowledge); reject = failed (dead-lettered, at-least-
 * once, never silently dropped) — the kit's `EventBus` contract, unchanged here.
 */
@Injectable()
export class PaymentEventConsumer implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentEventConsumer.name);
  private subscription?: { close(): Promise<void> };
  private closing?: Promise<void>;

  constructor(
    private readonly requests: PaymentRequestRepository,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    private readonly db: DbService,
    private readonly origins: PaymentEventOriginRepository,
    /** Core V2 S6c: present only where refund cases are mounted (never production); without it a refund completion is never applied. */
    @Optional() @Inject(RefundCompletionService) private readonly refundCompletions?: RefundCompletionService,
    /** Core V2 S6e-D: present only where refund cases are mounted (never production); without it a dispute loss is never applied. */
    @Optional() @Inject(DisputeLossService) private readonly disputeLosses?: DisputeLossService,
    /** Core V2 S6h-B: present only where reconciliation is mounted (never production); without it a late success is never applied. */
    @Optional() @Inject(LateSuccessService) private readonly lateSuccesses?: LateSuccessService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.subscription = await this.bus.subscribe({
      queue: 'billing.payment-events',
      bindings: [...BOUND_EVENTS],
      handler: (event, trust) => this.handle(event, trust),
      // Core V2 S1b: each delivery's provenance is committed in Billing's database before anything else; the owner of each consumed name
      // is the catalog's (payment-service for payment.*).
      provenance: { ownerOf: (name) => EXPECTED_SOURCE.get(name), store: new PgProvenanceStore(this.db) },
      // Core V2 S1e-2 (ADR-0057 §13.5, "S0-C6"): Billing is a FINANCIAL consumer, verified-only, always. Only a verified original (or its
      // verified redelivery) or a replay matching the stored verified original reaches `handle`; every other delivery is refused before
      // it (no receipt, no financial effect), and a provenance failure is held, never processed. There is no other mode: on a bus that
      // cannot enforce this (the in-memory bus), `subscribe` is refused and Billing consumes nothing. Payment events carry no secret, so a
      // refused delivery's dead letter keeps its body for an operator.
      enforcement: strictEnforcement({ refusedBody: 'original_reviewed' }),
    });
  }

  /**
   * Stage 14.6: stop consuming BEFORE any onApplicationShutdown closes the database pool. Closing cancels the consumer (no new
   * deliveries) and lets the deliveries already being handled finish and settle, bounded (see the bus's `drainTimeoutMs`).
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.close();
  }

  /** Stage 15.5 (F-D): closing starts at shutdown start, concurrently with the workers' drains; the later hooks await the same close. */
  onModuleDestroy(): void {
    this.close().catch(() => undefined); // a failure surfaces in beforeApplicationShutdown, which awaits the same promise
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close(); // idempotent: the same close, already finished when Nest drives the shutdown
  }

  private close(): Promise<void> {
    if (!this.closing) {
      const sub = this.subscription;
      this.subscription = undefined;
      this.closing = sub ? sub.close() : Promise.resolve();
    }
    return this.closing;
  }

  /**
   * Failure classes (the bus retries the transient ones a bounded number of times, then dead-letters; a permanent one is dead-lettered at once):
   *  - permanent: a payload that fails the shape parse, or an identifier PostgreSQL refuses as the wrong type (SQLSTATE class 22, "data
   *    exception", e.g. a `paymentRequestId` that is not a uuid). Retrying cannot change either.
   *  - transient: anything else thrown while applying the event (a lost connection, a deadlock, a timeout). The transaction has rolled back, no receipt
   *    was written, and the retry runs this same code again, so `payment_event_receipt` de-duplicates it exactly like any redelivery.
   * A `conflict` or `deferred` outcome is NOT a failure: it is acknowledged and recorded in its receipt (the reconciler completes a deferred one).
   */
  /**
   * V2 A12.4.3: every log line of a delivery carries its context (requestId `event:<id>`, the VALIDATED correlation id); the delivery
   * itself, its acknowledgement and its retries are exactly what `process` does.
   */
  /**
   * Core V2 S1e-2: first the TRUSTED envelope (`trustedEnvelope`: the verified original's own values, recorded before anything financial,
   * or the recorded values for a verified replay); then everything below uses it, never the delivery's headers. The log context is the
   * trusted one too.
   */
  private async handle(event: EventEnvelope, trust: HandlerTrust | undefined): Promise<void> {
    let t: TrustedPaymentEnvelope;
    try {
      t = await trustedEnvelope(trust, this.origins, (name) => SUPPORTED_VERSION.get(name));
    } catch (e) {
      if (e instanceof PermanentEventFailure) {
        this.logger.error(`payment_event_dead_letter classification=permanent reason=${e.reason}`, { eventId: safeToken(event.id, SAFE_ID), eventType: safeToken(event.name, EVENT_NAME) });
      }
      throw e;
    }
    return runWithEventContext({ id: t.eventId, headers: { correlationId: t.correlationId ?? undefined } }, () => this.process(event, t));
  }

  private async process(event: EventEnvelope, t: TrustedPaymentEnvelope): Promise<void> {
    const correlationId = t.correlationId ?? `event:${t.eventId}`; // business data (recorded with the receipt), from the trusted envelope
    const replay = event.headers.replayCount ?? 0; // operator bookkeeping, used to name log lines only
    // Broker-supplied values reach the log only as validated fields, never echoed when malformed.
    const who = { eventId: safeToken(t.eventId, SAFE_ID), eventType: safeToken(t.name, EVENT_NAME) };
    // An operator replay of a dead-lettered message is the same delivery in every respect but this marker, which only names the log lines.
    const tag = (base: string, replayed: string) => (replay > 0 ? `${replayed} replays=${replay}` : base);
    // V2 A3M.2 (ADR-0057 §5): a version Billing does not support is refused before the payload is interpreted, before any receipt and
    // before any business decision; permanent, so it is dead-lettered for an operator, never retried. Version 1, the only version
    // Payment publishes (a message without the header reads as 1), passes unchanged.
    const supported = SUPPORTED_VERSION.get(t.name);
    if (supported !== undefined && t.version !== supported) {
      const version = Number.isSafeInteger(t.version) ? t.version : '-';
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=unsupported_version version=${version}`, who);
      throw new PermanentEventFailure('unsupported_version');
    }
    // V2 A3M.3 (G11, ADR-0057 §7): a message whose `source` header is not the event's producer is refused before any receipt and any
    // decision, permanently (dead-lettered for an operator). The header is asserted by whoever publishes, so this only filters the
    // obvious case; what protects the outcome is that a message that does not apply never claims the event id (migration 0016) and
    // that application requires Billing's own recorded facts (decidePaymentEvent).
    const expectedSource = EXPECTED_SOURCE.get(t.name);
    if (expectedSource !== undefined && t.source !== expectedSource) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=wrong_source`, who);
      throw new PermanentEventFailure('wrong_source');
    }
    if (t.name === 'refund.case_completed') return this.processRefundCompletion(event, t, correlationId, who, tag);
    if (t.name === 'payment.dispute.lost') return this.processDisputeLoss(event, t, who, tag);
    if (t.name === 'payment.late_success.recorded') return this.processLateSuccess(event, t, who, tag);
    let facts: PaymentEventFacts;
    let settledAt: Date;
    try {
      facts = parseFacts(event, t); // throws on malformed input — the caller (EventBus) dead-letters it
      // Stage 12.4: the authoritative settlement instant for any resulting Subscription activation/renewal — Payment's
      // own header, set once when the fact was recorded in its outbox, unchanged across every retry or operator
      // replay of this SAME delivery (never `new Date()` here, which would let a late/replayed delivery shift the
      // period). A missing or unparseable header is exactly as malformed as a bad payload: never retryable.
      settledAt = new Date(t.occurredAt); // the TRUSTED original instant (S1e-2), never a replay's header
      if (Number.isNaN(settledAt.getTime())) throw new MalformedPaymentEventError();
    } catch (e) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`, who);
      throw e;
    }
    let result;
    try {
      result = await this.requests.applyPaymentEvent(
        t.eventId,
        facts,
        { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: t.eventId }, correlationId },
        settledAt,
      );
    } catch (e) {
      const permanent = pgCode(e)?.startsWith('22') === true;
      const errorName = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error';
      this.logger.error(`payment_event_processing_failure classification=${permanent ? 'permanent' : 'transient'} retry=${event.headers.retryCount ?? 0} error=${errorName}${replay > 0 ? ` replays=${replay}` : ''}`, { ...who, paymentRequestId: safeToken(facts.paymentRequestId, UUID) });
      if (permanent) {
        if (replay > 0) this.logger.error(`payment_event_replay_rejected replays=${replay} classification=permanent reason=invalid_identifier`, who);
        throw new PermanentEventFailure('invalid_identifier', { cause: e });
      }
      throw e;
    }
    const at = { ...who, paymentRequestId: safeToken(facts.paymentRequestId, UUID) };
    if (replay > 0 && !result.firstDelivery) {
      // The receipt already existed: this event was processed before, so the replay changed nothing and the recorded outcome is what it was.
      this.logger.log(`payment_event_replay_duplicate replays=${replay} recordedOutcome=${result.outcome}`, at);
      return;
    }
    if (result.outcome === 'applied') this.logger.log(tag('payment_event_applied', 'payment_event_replay_succeeded'), at);
    if (result.outcome === 'ignored') this.logger.log(`${tag('payment_event_ignored', 'payment_event_replay_ignored')} detail=${result.detail}`, at);
    if (result.outcome === 'conflict') this.logger.error(`${tag('payment_event_conflict', 'payment_event_replay_conflict')} detail=${result.detail} — needs manual review`, at);
    if (result.outcome === 'deferred') this.logger.warn(`${tag('payment_event_deferred', 'payment_event_replay_deferred')} detail=${result.detail} — the reconciler will complete it`, at);
    // Stage 12.4: only meaningful once the payment itself was applied — a settled offering that conflicts with the
    // organization's existing Subscription never rolls back the payment (section 24), so it needs its own, separately
    // visible signal rather than being folded into `payment_event_conflict` above.
    if (result.subscription === 'conflict') this.logger.error(`payment_event_subscription_conflict — settlement applied but its offering conflicts with the organization's existing Subscription; needs manual review`, at);
    // Core V2 S3a (B9): a paid invoice without a matching routing record changes no Subscription; it needs review, never a guess.
    if (result.subscription === 'late') this.logger.error(`payment_event_assisted_settlement_late — settlement recorded, no purchase and no obligation change (assistance_late_settlement); held for reconciliation (S6h)`, at);
    // Core V2 S6f (B8): a verified recovery-settlement success, accounted for as a recovery payment (no subscription, no entitlement)
    if (result.subscription === 'recovery' || result.subscription === 'recovered') this.logger.log(`payment_event_recovery_payment outcome=${result.subscription}`, at);
    if (result.subscription === 'unrouted') this.logger.error(`payment_event_subscription_unrouted — settlement applied; the invoice has no organization_subscription routing for that Organization, so no Subscription changed; needs manual review`, at);
  }

  /**
   * Core V2 S6c (register EVT-02; the Owner's R6C-9): Payment's verified financial completion of a refund case. The payload is parsed trusting
   * nothing; `liveMode` must be false (simulation only). `RefundCompletionService` binds it strictly to Billing's own case and relay and
   * completes the case once, with the verified event id as its receipt. A binding mismatch or a conflict is never applied and never retried:
   * it is dead-lettered for review (permanent). Without the refund module (production) nothing is applied.
   */
  private async processRefundCompletion(event: EventEnvelope, t: TrustedPaymentEnvelope, correlationId: string, who: Record<string, string>, tag: (b: string, r: string) => string): Promise<void> {
    const p = event.payload;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    if (typeof p.approvedAmount !== 'number' || p.liveMode !== false || typeof p.refundCaseId !== 'string' || typeof p.completedAt !== 'string') {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`, who);
      throw new MalformedPaymentEventError();
    }
    if (!this.refundCompletions) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=refunds_not_enabled`, who);
      throw new PermanentEventFailure('refunds_not_enabled');
    }
    const outcome = await this.refundCompletions.complete(
      { refundCaseId: str(p.refundCaseId), refundAuthorizationId: str(p.refundAuthorizationId), refundAttemptId: str(p.refundAttemptId), paymentId: str(p.paymentId),
        approvedAmount: p.approvedAmount, currency: str(p.currency), completedAt: str(p.completedAt) },
      { kind: 'event', eventId: t.eventId },
      { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: t.eventId }, correlationId },
    );
    if (outcome === 'binding_mismatch' || outcome === 'conflict') {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=refund_completion_${outcome}`, who);
      throw new PermanentEventFailure(`refund_completion_${outcome}`);
    }
    this.logger.log(`${tag('refund_completion_applied', 'refund_completion_replay')} outcome=${outcome}`, who);
  }

  /**
   * Core V2 S6e-D (register EVT-03; the Owner's R6E-5, R6E-6): Payment's verified final loss of a dispute. The payload is parsed trusting nothing;
   * `liveMode` must be false (simulation only) and the producer Billing. `DisputeLossService` records it once, only with its verified
   * chargeback (a loss without one is acknowledged and recovered later from Payment's losses read). A binding mismatch or a conflict is never
   * applied and never retried: dead-lettered for review (permanent). Without the refund module (production) nothing is applied.
   */
  /**
   * Core V2 S6h-B (register EVT-10; the Owner's R6H-4): Payment's verified success of a payment after it ended. Parsed trusting nothing; recorded
   * once per late success and per provider fact, classified by Billing's own routing (a recovery payment, or a reconciliation case). It is
   * NEVER a `payment.succeeded`: the payment request keeps its terminal state. A different statement of the same late success is permanent.
   */
  private async processLateSuccess(event: EventEnvelope, t: TrustedPaymentEnvelope, who: Record<string, string>, tag: (b: string, r: string) => string): Promise<void> {
    const p = event.payload;
    if (p.liveMode !== false || p.producer !== 'billing-service' || typeof p.lateSuccessId !== 'string' || typeof p.paymentId !== 'string' || typeof p.amount !== 'number'
      || typeof p.currency !== 'string' || typeof p.paymentStatus !== 'string' || typeof p.recordedAt !== 'string' || (p.factId !== null && typeof p.factId !== 'string')) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`, who);
      throw new MalformedPaymentEventError();
    }
    if (!this.lateSuccesses) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=reconciliation_not_enabled`, who);
      throw new PermanentEventFailure('reconciliation_not_enabled');
    }
    const outcome = await this.lateSuccesses.record(
      { lateSuccessId: p.lateSuccessId, paymentId: p.paymentId, factId: (p.factId as string | null) ?? null, amount: p.amount, currency: p.currency,
        paymentStatus: p.paymentStatus, recordedAt: new Date(p.recordedAt).toISOString() },
      { kind: 'event', eventId: t.eventId },
    );
    if (outcome === 'binding_mismatch' || outcome === 'conflict') {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=late_success_${outcome}`, who);
      throw new PermanentEventFailure(`late_success_${outcome}`);
    }
    this.logger.log(`${tag('late_success_received', 'late_success_replay')} outcome=${outcome}`, who);
  }

  private async processDisputeLoss(event: EventEnvelope, t: TrustedPaymentEnvelope, who: Record<string, string>, tag: (b: string, r: string) => string): Promise<void> {
    const p = event.payload;
    const c = p.chargeback as Record<string, unknown> | null | undefined;
    if (p.liveMode !== false || p.producer !== 'billing-service' || typeof p.disputeId !== 'string' || typeof p.paymentId !== 'string' || typeof p.amount !== 'number'
      || typeof p.currency !== 'string' || typeof p.lostAt !== 'string' || (c !== null && (typeof c !== 'object' || c === undefined))) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`, who);
      throw new MalformedPaymentEventError();
    }
    if (!this.disputeLosses) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=disputes_not_enabled`, who);
      throw new PermanentEventFailure('disputes_not_enabled');
    }
    const outcome = await this.disputeLosses.record(
      { disputeId: p.disputeId, paymentId: p.paymentId, amount: p.amount, currency: p.currency, lostAt: p.lostAt,
        chargeback: c ? { factId: c.factId as string, amount: c.amount as number, currency: c.currency as string } : null },
      { kind: 'event', eventId: t.eventId },
    );
    if (outcome === 'binding_mismatch' || outcome === 'conflict') {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=dispute_loss_${outcome}`, who);
      throw new PermanentEventFailure(`dispute_loss_${outcome}`);
    }
    this.logger.log(`${tag('dispute_loss_received', 'dispute_loss_replay')} outcome=${outcome}`, who);
  }
}
