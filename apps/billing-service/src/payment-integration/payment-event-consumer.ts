import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { EVENT_BUS, EVENT_NAME, PermanentEventFailure, pgCode, runWithEventContext, SAFE_ID, safeToken, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import type { PaymentEventName } from '../domain/payment-event-decision.js';
import type { PaymentEventFacts } from '../domain/payment-event-decision.js';
import { CONSUMED_EVENTS as CATALOG } from '../events/event-catalog.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';

/** V2 A3M.2: the consumed names and their supported versions come from the event catalog (`events/event-catalog.ts`). */
const CONSUMED_EVENTS: readonly PaymentEventName[] = CATALOG.map((c) => c.name);
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
function parseFacts(event: EventEnvelope): PaymentEventFacts {
  const p = event.payload;
  if (
    !CONSUMED_EVENTS.includes(event.name as PaymentEventName) ||
    typeof p.paymentId !== 'string' ||
    typeof p.producer !== 'string' ||
    typeof p.paymentRequestId !== 'string' ||
    typeof p.sourceType !== 'string' ||
    typeof p.sourceId !== 'string' ||
    !isParty(p.payer) ||
    !isParty(p.seller) ||
    (p.organizationId !== null && typeof p.organizationId !== 'string') ||
    typeof p.currency !== 'string' ||
    typeof p.revision !== 'number'
  ) {
    throw new MalformedPaymentEventError();
  }
  return {
    name: event.name as PaymentEventName,
    source: event.headers.source,
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
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.subscription = await this.bus.subscribe({
      queue: 'billing.payment-events',
      bindings: [...CONSUMED_EVENTS],
      handler: (event) => this.handle(event),
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
  private handle(event: EventEnvelope): Promise<void> {
    return runWithEventContext(event, () => this.process(event));
  }

  private async process(event: EventEnvelope): Promise<void> {
    const correlationId = event.headers.correlationId ?? `event:${event.id}`; // business data (recorded with the receipt), unchanged
    const replay = event.headers.replayCount ?? 0;
    // Broker-supplied values reach the log only as validated fields, never echoed when malformed.
    const who = { eventId: safeToken(event.id, SAFE_ID), eventType: safeToken(event.name, EVENT_NAME) };
    // An operator replay of a dead-lettered message is the same delivery in every respect but this marker, which only names the log lines.
    const tag = (base: string, replayed: string) => (replay > 0 ? `${replayed} replays=${replay}` : base);
    // V2 A3M.2 (ADR-0057 §5): a version Billing does not support is refused before the payload is interpreted, before any receipt and
    // before any business decision; permanent, so it is dead-lettered for an operator, never retried. Version 1, the only version
    // Payment publishes (a message without the header reads as 1), passes unchanged.
    const supported = SUPPORTED_VERSION.get(event.name);
    if (supported !== undefined && event.headers.version !== supported) {
      const version = Number.isSafeInteger(event.headers.version) ? event.headers.version : '-';
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=unsupported_version version=${version}`, who);
      throw new PermanentEventFailure('unsupported_version');
    }
    // V2 A3M.3 (G11, ADR-0057 §7): a message whose `source` header is not the event's producer is refused before any receipt and any
    // decision, permanently (dead-lettered for an operator). The header is asserted by whoever publishes, so this only filters the
    // obvious case; what protects the outcome is that a message that does not apply never claims the event id (migration 0016) and
    // that application requires Billing's own recorded facts (decidePaymentEvent).
    const expectedSource = EXPECTED_SOURCE.get(event.name);
    if (expectedSource !== undefined && event.headers.source !== expectedSource) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=wrong_source`, who);
      throw new PermanentEventFailure('wrong_source');
    }
    let facts: PaymentEventFacts;
    let settledAt: Date;
    try {
      facts = parseFacts(event); // throws on malformed input — the caller (EventBus) dead-letters it
      // Stage 12.4: the authoritative settlement instant for any resulting Subscription activation/renewal — Payment's
      // own header, set once when the fact was recorded in its outbox, unchanged across every retry or operator
      // replay of this SAME delivery (never `new Date()` here, which would let a late/replayed delivery shift the
      // period). A missing or unparseable header is exactly as malformed as a bad payload: never retryable.
      settledAt = new Date(event.headers.occurredAt);
      if (Number.isNaN(settledAt.getTime())) throw new MalformedPaymentEventError();
    } catch (e) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`, who);
      throw e;
    }
    let result;
    try {
      result = await this.requests.applyPaymentEvent(
        event.id,
        facts,
        { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: event.id }, correlationId },
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
  }
}
