import { InMemoryEventBus, PermanentEventFailure, topicMatches, type EventEnvelope, type EventSubscription, type HandlerTrust } from '@nawara/service-kit';

/**
 * TEST ONLY (Core V2 S1e-4). Notification's intake subscription is strict (ADR-0057 "S0-C6"), and the kit's in-memory bus rightly refuses
 * an enforced subscription: it has no broker identity to decide trust from. Suites that exercise the intake, the delivery engine or the
 * HTTP surface without a broker use this bus: it records the strict subscription and hands its handler an EXPLICIT trust decision, as the
 * RabbitMQ bus would after its own checks. The real decision path (broker `user_id`, keyed provenance, replays, injections, holds) is
 * proven against a real RabbitMQ and PostgreSQL in `event-enforcement.e2e-spec.ts`. Production never constructs this class.
 */
export type TestDelivery = 'verified_original' | 'verified_duplicate' | 'verified_replay' | { refuse: string };

/** The trust the kit builds for `event` once it decided `as` (an accepted basis): what the strict handler is given. */
export function testTrust(event: EventEnvelope, as: Exclude<TestDelivery, { refuse: string }> = 'verified_original'): HandlerTrust {
  const h = event.headers;
  const field = <T>(v: T | undefined) => (v === undefined ? ({ available: false, reason: 'absent' } as const) : ({ available: true, value: v, from: 'verified_delivery' } as const));
  const notStored = { available: false, reason: 'not_stored' } as const;
  const replay = as === 'verified_replay';
  return {
    decision: 'accept',
    basis: as,
    origin: {
      from: replay ? 'stored_verified_observation' : 'verified_delivery',
      source: h.source, eventId: event.id, name: event.name, routingKey: event.name, producerUserId: h.source,
      occurredAt: replay ? notStored : field(h.occurredAt),
      version: replay ? notStored : field(h.version),
      correlationId: replay ? notStored : field(h.correlationId),
    },
  };
}

export class TrustedDeliveryBus extends InMemoryEventBus {
  private enforced?: EventSubscription;

  override async subscribe(sub: EventSubscription) {
    if (sub.enforcement === undefined) return super.subscribe(sub);
    if (sub.enforcement.mode !== 'strict') throw new Error('test bus: Notification must subscribe strictly');
    this.enforced = sub;
    return {
      close: async () => {
        this.enforced = undefined;
        return undefined; // the base subscription's close resolves to `undefined`
      },
    };
  }

  /** The strict subscription as registered, for assertions. */
  get strictSubscription(): EventSubscription | undefined {
    return this.enforced;
  }

  /**
   * Delivers `event` as the RabbitMQ bus would after deciding `as`: an accepted delivery reaches the handler with the trust the kit builds
   * (a verified original/duplicate: the delivery's own values; a verified replay: the stored identity, its envelope metadata `not_stored`);
   * a refusal never reaches it. A handler failure or a refusal is recorded in `deadLettered`.
   */
  async deliver(event: EventEnvelope, as: TestDelivery = 'verified_original'): Promise<void> {
    const sub = this.enforced;
    if (!sub) throw new Error('test bus: no strict subscription');
    if (!sub.bindings.some((b) => topicMatches(b, event.name))) return;
    if (typeof as === 'object') {
      this.deadLettered.push(event);
      return;
    }
    try {
      await sub.handler(event, testTrust(event, as));
    } catch (e) {
      if (!(e instanceof PermanentEventFailure) && !(e instanceof Error)) throw e;
      this.deadLettered.push(event);
    }
  }
}
