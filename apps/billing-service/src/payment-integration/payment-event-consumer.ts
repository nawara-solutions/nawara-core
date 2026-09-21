import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EVENT_BUS, PermanentEventFailure, pgCode, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import type { PaymentEventName } from '../domain/payment-event-decision.js';
import type { PaymentEventFacts } from '../domain/payment-event-decision.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';

const CONSUMED_EVENTS: readonly PaymentEventName[] = ['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired'];

class MalformedPaymentEventError extends PermanentEventFailure {
  constructor() {
    super('malformed_payload');
  }
}

function isParty(v: unknown): v is { type: string; id: string } {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && typeof (v as { id?: unknown }).id === 'string';
}

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
export class PaymentEventConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentEventConsumer.name);
  private subscription?: { close(): Promise<void> };

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

  async onApplicationShutdown(): Promise<void> {
    await this.subscription?.close();
  }

  /**
   * Failure classes (the bus retries the transient ones a bounded number of times, then dead-letters; a permanent one is dead-lettered at once):
   *  - permanent: a payload that fails the shape parse, or an identifier PostgreSQL refuses as the wrong type (SQLSTATE class 22, "data
   *    exception", e.g. a `paymentRequestId` that is not a uuid). Retrying cannot change either.
   *  - transient: anything else thrown while applying the event (a lost connection, a deadlock, a timeout). The transaction has rolled back, no receipt
   *    was written, and the retry runs this same code again, so `payment_event_receipt` de-duplicates it exactly like any redelivery.
   * A `conflict` or `deferred` outcome is NOT a failure: it is acknowledged and recorded in its receipt (the reconciler completes a deferred one).
   */
  private async handle(event: EventEnvelope): Promise<void> {
    const correlationId = event.headers.correlationId ?? `event:${event.id}`;
    const replay = event.headers.replayCount ?? 0;
    const who = `event=${event.id} name=${event.name} correlationId=${correlationId}`;
    // An operator replay of a dead-lettered message is the same delivery in every respect but this marker, which only names the log lines.
    const tag = (base: string, replayed: string) => (replay > 0 ? `${replayed} ${who} replays=${replay}` : `${base} ${who}`);
    let facts: PaymentEventFacts;
    try {
      facts = parseFacts(event); // throws on malformed input — the caller (EventBus) dead-letters it
    } catch (e) {
      this.logger.error(`${tag('payment_event_dead_letter', 'payment_event_replay_rejected')} classification=permanent reason=malformed_payload`);
      throw e;
    }
    let result;
    try {
      result = await this.requests.applyPaymentEvent(event.id, facts, {
        actor: { type: 'system', id: null },
        cause: { type: 'payment_event', id: event.id },
        correlationId,
      });
    } catch (e) {
      const permanent = pgCode(e)?.startsWith('22') === true;
      const errorName = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error';
      this.logger.error(`payment_event_processing_failure ${who} paymentRequestId=${facts.paymentRequestId} classification=${permanent ? 'permanent' : 'transient'} retry=${event.headers.retryCount ?? 0} error=${errorName}${replay > 0 ? ` replays=${replay}` : ''}`);
      if (permanent) {
        if (replay > 0) this.logger.error(`payment_event_replay_rejected ${who} replays=${replay} classification=permanent reason=invalid_identifier`);
        throw new PermanentEventFailure('invalid_identifier', { cause: e });
      }
      throw e;
    }
    const at = `paymentRequestId=${facts.paymentRequestId}`;
    if (replay > 0 && !result.firstDelivery) {
      // The receipt already existed: this event was processed before, so the replay changed nothing and the recorded outcome is what it was.
      this.logger.log(`payment_event_replay_duplicate ${who} replays=${replay} ${at} recordedOutcome=${result.outcome}`);
      return;
    }
    if (result.outcome === 'applied') this.logger.log(`${tag('payment_event_applied', 'payment_event_replay_succeeded')} ${at}`);
    if (result.outcome === 'ignored') this.logger.log(`${tag('payment_event_ignored', 'payment_event_replay_ignored')} ${at} detail=${result.detail}`);
    if (result.outcome === 'conflict') this.logger.error(`${tag('payment_event_conflict', 'payment_event_replay_conflict')} ${at} detail=${result.detail} — needs manual review`);
    if (result.outcome === 'deferred') this.logger.warn(`${tag('payment_event_deferred', 'payment_event_replay_deferred')} ${at} detail=${result.detail} — the reconciler will complete it`);
  }
}
