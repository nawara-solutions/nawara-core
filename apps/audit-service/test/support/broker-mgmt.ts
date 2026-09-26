import type { ChannelModel } from 'amqplib';

/**
 * Stage 18.9 / 18.10: fault injection through the RabbitMQ management API (real broker semantics, never a mock). A queue POLICY with
 * `max-length: 0` + `overflow: reject-publish` makes the BROKER refuse (basic.nack) every publish to that queue — exactly what a full,
 * quota-limited or failing dead-letter queue does — without redeclaring the queue (no argument mismatch, no channel closed).
 *
 * Stage 18.10 (the 18.9 O1 flake): whether a policy is IN FORCE is decided from AUTHORITATIVE broker behavior — a probe published to the
 * queue on a confirm channel is nacked (policy active) or confirmed (inactive) — never from the management API's sampled queue
 * statistics, which lag by seconds and made a wait on them time out under load.
 */
export function brokerManagement(mgmtUrl: string, conn: ChannelModel) {
  const base = new URL(mgmtUrl);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}`;
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${base.origin}/api${path}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`management API ${method} ${path}: ${r.status}`);
  };
  const escape = (q: string) => `^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

  /** Publishes one probe to `queue` and reports whether the broker CONFIRMED it (true) or refused it (false). An accepted probe is purged. */
  const probeAccepted = async (queue: string): Promise<boolean> => {
    const ch = await conn.createConfirmChannel();
    ch.on('error', () => undefined);
    try {
      ch.sendToQueue(queue, Buffer.from('{"probe":true}'), { persistent: false });
      await ch.waitForConfirms();
      await ch.purgeQueue(queue);
      return true;
    } catch {
      return false;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  const untilProbe = async (queue: string, accepted: boolean) => {
    for (let i = 0; i < 300; i++) {
      if ((await probeAccepted(queue)) === accepted) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the broker never ${accepted ? 'accepted' : 'refused'} publishes to ${queue}`);
  };

  return {
    /** The broker refuses every publish to `queue` (proven by a refused probe) until `acceptPublishes`. */
    async rejectPublishes(queue: string, name = 's189-reject') {
      await api('PUT', `/policies/%2F/${name}`, { pattern: escape(queue), definition: { 'max-length': 0, overflow: 'reject-publish' }, 'apply-to': 'queues', priority: 100 });
      await untilProbe(queue, false);
    },
    /** Removes the policy; resolves once the broker confirms a probe to `queue` again (when given). */
    async acceptPublishes(queue?: string, name = 's189-reject') {
      await api('DELETE', `/policies/%2F/${name}`);
      if (queue) await untilProbe(queue, true);
    },
  };
}
