import type { EventBus, EventEnvelope, EventSubscription } from './types.js';

/** AMQP topic matching: `*` is exactly one word, `#` is zero or more words. */
export function topicMatches(pattern: string, name: string): boolean {
  const p = pattern.split('.');
  const n = name.split('.');
  const walk = (i: number, j: number): boolean => {
    if (i === p.length) return j === n.length;
    if (p[i] === '#') return walk(i + 1, j) || (j < n.length && walk(i, j + 1));
    if (j === n.length) return false;
    return (p[i] === '*' || p[i] === n[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

export interface MemoryBusOptions {
  /** Deliver every event twice, to prove consumers tolerate duplicates. */
  duplicateDelivery?: boolean;
}

/** In-process bus for unit tests and local runs. Same port as RabbitMQ; no persistence. */
export class InMemoryEventBus implements EventBus {
  readonly published: EventEnvelope[] = [];
  readonly deadLettered: EventEnvelope[] = [];
  private readonly subs = new Set<EventSubscription>();
  private failures = 0;

  constructor(private readonly opts: MemoryBusOptions = {}) {}

  /** Makes the next `n` publishes fail, to simulate a broker outage. */
  failNextPublishes(n: number): void {
    this.failures = n;
  }

  async publish(event: EventEnvelope): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('broker unavailable');
    }
    this.published.push(event);
    for (const s of this.subs) {
      if (!s.bindings.some((b) => topicMatches(b, event.name))) continue;
      for (let i = 0; i < (this.opts.duplicateDelivery ? 2 : 1); i++) {
        try {
          await s.handler(event);
        } catch {
          this.deadLettered.push(event);
        }
      }
    }
  }

  async subscribe(sub: EventSubscription) {
    this.subs.add(sub);
    return { close: async () => void this.subs.delete(sub) };
  }

  async close(): Promise<void> {
    this.subs.clear();
  }
}
