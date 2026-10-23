import { InMemoryEventBus, PermanentEventFailure, topicMatches, type EventEnvelope, type EventSubscription, type HandlerTrust } from '@nawara/service-kit';

/**
 * TEST ONLY (Core V2 S1e-2). Billing's payment-event subscription is strict (ADR-0057 "S0-C6"), and the kit's in-memory bus rightly refuses
 * an enforced subscription: it has no broker identity to decide trust from. Billing's financial logic is tested here by handing its
 * subscribed handler an EXPLICIT trust decision, as the RabbitMQ bus would after its own checks; the real decision path (broker `user_id`,
 * stored provenance, replays, injections) is proven against a real RabbitMQ and PostgreSQL in `payment-event-enforcement.e2e-spec.ts`.
 * Everything else (the outbox relay's publishes) is the ordinary in-memory bus.
 */
export type TestDelivery = 'verified_original' | 'verified_duplicate' | 'verified_replay' | { refuse: string };

export class TrustedDeliveryBus extends InMemoryEventBus {
  private enforced?: EventSubscription;

  override async subscribe(sub: EventSubscription) {
    if (sub.enforcement === undefined) return super.subscribe(sub);
    if (sub.enforcement.mode !== 'strict') throw new Error('test bus: Billing must subscribe strictly');
    this.enforced = sub;
    return {
      close: async () => {
        this.enforced = undefined;
      },
    };
  }

  /** The strict subscription as registered (its queue, bindings, provenance and policy), for assertions. */
  get strictSubscription(): EventSubscription | undefined {
    return this.enforced;
  }

  /**
   * Delivers `event` as the RabbitMQ bus would after deciding `as`: an accepted delivery reaches the handler with the trust the kit builds
   * (a verified original/duplicate: the delivery's own published values; a verified replay: the stored row's identity, its envelope
   * metadata `not_stored`); a refusal never reaches it. A handler failure or a refusal is recorded in `deadLettered`, as the in-memory bus does.
   */
  async deliver(event: EventEnvelope, as: TestDelivery = 'verified_original'): Promise<void> {
    const sub = this.enforced;
    if (!sub) throw new Error('test bus: no strict subscription');
    if (!sub.bindings.some((b) => topicMatches(b, event.name))) return; // not bound: no delivery at all, as on any bus
    if (typeof as === 'object') {
      this.deadLettered.push(event);
      return;
    }
    const h = event.headers;
    const field = <T>(v: T | undefined) => (v === undefined ? ({ available: false, reason: 'absent' } as const) : ({ available: true, value: v, from: 'verified_delivery' } as const));
    const notStored = { available: false, reason: 'not_stored' } as const;
    const replay = as === 'verified_replay';
    const trust: HandlerTrust = {
      decision: 'accept',
      basis: as,
      origin: {
        from: replay ? 'stored_verified_observation' : 'verified_delivery',
        // the delivery's own `source` as if the kit had verified it (in reality the kit refuses any other: Billing's own `wrong_source`
        // check, defence in depth, stays exercised by the G11 tests)
        source: h.source, eventId: event.id, name: event.name, routingKey: event.name, producerUserId: h.source,
        occurredAt: replay ? notStored : field(h.occurredAt),
        version: replay ? notStored : field(h.version),
        correlationId: replay ? notStored : field(h.correlationId),
      },
    };
    try {
      await sub.handler(event, trust);
    } catch (e) {
      if (!(e instanceof PermanentEventFailure) && !(e instanceof Error)) throw e;
      this.deadLettered.push(event);
    }
  }
}
