/**
 * Stage 18.9: the RabbitMQ management API (real broker semantics for fault injection, never a mock). A queue POLICY with
 * `max-length: 0` + `overflow: reject-publish` makes the BROKER refuse (basic.nack) every publish to that queue — exactly what a full,
 * quota-limited or failing dead-letter queue does — without redeclaring the queue (no argument mismatch, no channel closed).
 */
export function brokerManagement(mgmtUrl: string) {
  const base = new URL(mgmtUrl);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base.origin}/api${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`management API ${method} ${path}: ${r.status}`);
    return r.status === 204 || method !== 'GET' ? undefined : ((await r.json()) as Record<string, any>);
  };
  const escape = (q: string) => `^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  return {
    /** The broker refuses every publish to `queue` until `acceptPublishes`. */
    async rejectPublishes(queue: string, name = 's189-reject') {
      await api('PUT', `/policies/%2F/${name}`, { pattern: escape(queue), definition: { 'max-length': 0, overflow: 'reject-publish' }, 'apply-to': 'queues', priority: 100 });
      // Policies apply asynchronously: wait until the queue reports it.
      for (let i = 0; i < 100; i++) {
        if ((await this.queue(queue))?.policy === name) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('policy not applied');
    },
    async acceptPublishes(name = 's189-reject') {
      await api('DELETE', `/policies/%2F/${name}`);
    },
    /** Ready + unacknowledged counts, as the broker sees them (the management stats refresh every few seconds; `fresh` polls). */
    async queue(queue: string): Promise<{ messages: number; ready: number; unacked: number; policy?: string } | undefined> {
      const q = await api('GET', `/queues/%2F/${encodeURIComponent(queue)}`).catch(() => undefined);
      return q ? { messages: q.messages ?? 0, ready: q.messages_ready ?? 0, unacked: q.messages_unacknowledged ?? 0, policy: q.policy } : undefined;
    },
  };
}
