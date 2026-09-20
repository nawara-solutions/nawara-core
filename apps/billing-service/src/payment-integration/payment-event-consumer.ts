import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EVENT_BUS, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import type { PaymentEventName } from '../domain/payment-event-decision.js';
import type { PaymentEventFacts } from '../domain/payment-event-decision.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';

const CONSUMED_EVENTS: readonly PaymentEventName[] = ['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired'];

class MalformedPaymentEventError extends Error {}

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
    throw new MalformedPaymentEventError(`malformed ${event.name} payload`);
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

  private async handle(event: EventEnvelope): Promise<void> {
    const correlationId = event.headers.correlationId ?? `event:${event.id}`;
    let facts: PaymentEventFacts;
    try {
      facts = parseFacts(event); // throws on malformed input — the caller (EventBus) dead-letters it
    } catch (e) {
      this.logger.error(`payment_event_dead_letter event=${event.id} name=${event.name} correlationId=${correlationId}: ${e instanceof Error ? e.message : 'malformed payload'}`);
      throw e;
    }
    const result = await this.requests.applyPaymentEvent(event.id, facts, {
      actor: { type: 'system', id: null },
      cause: { type: 'payment_event', id: event.id },
      correlationId,
    });
    if (result.outcome === 'applied') this.logger.log(`payment_event_applied event=${event.id} name=${event.name} correlationId=${correlationId}`);
    if (result.outcome === 'ignored') this.logger.log(`payment_event_ignored event=${event.id} name=${event.name} correlationId=${correlationId} detail=${result.detail}`);
    if (result.outcome === 'conflict') this.logger.error(`payment_event_conflict event=${event.id} name=${event.name} correlationId=${correlationId} detail=${result.detail} — needs manual review`);
    if (result.outcome === 'deferred') this.logger.warn(`payment_event_deferred event=${event.id} name=${event.name} correlationId=${correlationId} detail=${result.detail} — the reconciler will complete it`);
  }
}
