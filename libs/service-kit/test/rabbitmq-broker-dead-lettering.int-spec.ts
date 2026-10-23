import { randomBytes, randomUUID } from 'node:crypto';
import amqp, { type ChannelModel, type GetMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PermanentEventFailure, RabbitMqEventBus, noBrokerDeadLettering, type EventEnvelope, type ProvenanceStore,
} from '../src/index.js';
import { describeWithEnv } from './support/env.js';
import { ownedBrokerResources } from './support/broker-resources.js';

/**
 * Core V2 OD-BRK-1 (ADR-0057 §8 "OD-BRK-0", D1 to D3) over a REAL RabbitMQ 3.13 (the management API is used by THIS TEST ONLY, as the
 * ground truth of the broker's effective configuration and to inject policies; the kit never uses it):
 * - a DEFAULT subscription keeps today's topology and behaviour exactly (its work queue dead-letters into the shared fanout);
 * - an OPTED-IN subscription has no broker dead-letter route: a broker reject without requeue or a publisher-set expiry DISCARDS the
 *   message (no raw copy in any queue), while the kit's own retry, hold and redacted dead-letter copy work as before;
 * - an incompatible pre-existing queue fails closed (406) and is never deleted or re-created;
 * - and the LIMITATION the precondition contract exists for: a REGULAR policy can re-open a raw dead-letter route on an opted-in queue,
 *   invisibly to AMQP. Only an external effective-topology verification (OD-BRK-2) can see it; the kit reports `not_verified_by_kit`.
 * Every code is synthetic.
 */
const uniq = () => randomBytes(4).toString('hex');
const CODE = '730619';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error('condition not met in time');
};
const owned = ownedBrokerResources();

describeWithEnv('OD-BRK-1: opt-in subscription with no broker dead-lettering (real broker)', ['TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const exchange = owned.exchange(`nawara.events.odbrk${uniq()}`);
  const dlx = `${exchange}.dlx`;
  const vhostPath = new URL(env.TEST_RABBITMQ_URL).pathname.slice(1);
  const vhost = encodeURIComponent(vhostPath === '' ? '/' : decodeURIComponent(vhostPath));
  const policies: string[] = [];
  const operatorPolicies: string[] = [];
  const buses: RabbitMqEventBus[] = [];
  const notices: string[] = [];
  let conn: ChannelModel;

  const mgmt = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
    const u = new URL(env.TEST_RABBITMQ_MGMT_URL);
    const r = await fetch(`${u.origin}/api${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}`, 'content-type': 'application/json' },
    });
    return { status: r.status, json: method === 'GET' && r.ok ? await r.json() : undefined };
  };
  const queueInfo = async (q: string) => (await mgmt('GET', `/queues/${vhost}/${encodeURIComponent(q)}`)).json as { arguments: Record<string, unknown>; policy?: string | null; operator_policy?: string | null; effective_policy_definition?: Record<string, unknown> };
  const bindingsOf = async (q: string) => ((await mgmt('GET', `/queues/${vhost}/${encodeURIComponent(q)}/bindings`)).json as Array<{ source: string }>).map((b) => b.source).filter((s) => s !== '');
  const bus = () => {
    const b = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 2, delayMs: 200 }, onNotice: (m) => void notices.push(m) });
    buses.push(b);
    return b;
  };
  const envelope = (name: string, payload: Record<string, unknown> = { code: CODE, note: 'synthetic' }): EventEnvelope => {
    const id = randomUUID();
    return { id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'test-service', version: 1 } };
  };
  const publish = async (e: EventEnvelope, extra: Record<string, unknown> = {}, to: { exchange?: string; queue?: string } = {}) => {
    const ch = await conn.createConfirmChannel();
    const props = { persistent: true, contentType: 'application/json', messageId: e.id, type: e.name, headers: e.headers, ...extra };
    if (to.queue) ch.sendToQueue(to.queue, Buffer.from(JSON.stringify(e.payload)), props);
    else ch.publish(to.exchange ?? exchange, e.name, Buffer.from(JSON.stringify(e.payload)), props);
    await ch.waitForConfirms();
    await ch.close();
  };
  /** Every message currently in `q`, removed and returned (only this suite's own queues are ever read). */
  const drain = async (q: string): Promise<GetMessage[]> => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    const out: GetMessage[] = [];
    try {
      for (;;) {
        const m = await ch.get(q, { noAck: true });
        if (!m) break;
        out.push(m);
      }
    } finally {
      await ch.close().catch(() => undefined);
    }
    return out;
  };
  const depth = async (q: string) => {
    const ch = await conn.createChannel();
    ch.on('error', () => undefined);
    try {
      return (await ch.checkQueue(q)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };
  /**
   * The total of messages across EVERY queue of the vhost (other suites' included: counted, never read). The names come from the
   * management API; the counts from a passive declaration (live, read-only), since the management statistics lag.
   */
  const vhostTotal = async () => {
    let n = 0;
    for (const { name } of (await mgmt('GET', `/queues/${vhost}`)).json as Array<{ name: string }>) n += await depth(name).catch(() => 0);
    return n;
  };
  /** Rejects (requeue = false) the next message of `q` as an administrator would, while no consumer holds it. */
  const rejectNext = async (q: string, id: string) => {
    const ch = await conn.createChannel();
    let m: GetMessage | false = false;
    await waitFor(async () => !!(m = await ch.get(q, { noAck: false })));
    expect((m as unknown as GetMessage).properties.messageId).toBe(id);
    ch.reject(m as unknown as GetMessage, false);
    await sleep(300);
    await ch.close();
  };

  // a legacy consumer (default topology) and the queues of the opted-in ones, all on this suite's own exchange
  const legacyQ = owned.queue(`odbrk.legacy.${uniq()}`);
  const isolatedQ = owned.queue(`odbrk.isolated.${uniq()}`);
  const handled = new Map<string, number>();
  const handler = async (e: EventEnvelope) => void handled.set(e.id, (handled.get(e.id) ?? 0) + 1);

  beforeAll(async () => {
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    await bus().subscribe({ queue: legacyQ, bindings: ['legacy.#'], handler });
  });
  afterAll(async () => {
    for (const b of buses) await b.close().catch(() => undefined);
    for (const p of policies) await mgmt('DELETE', `/policies/${vhost}/${p}`);
    for (const p of operatorPolicies) await mgmt('DELETE', `/operator-policies/${vhost}/${p}`);
    for (const q of [legacyQ, isolatedQ]) for (const s of ['', '.retry', '.dead']) await drain(`${q}${s}`).catch(() => undefined);
    await conn?.close().catch(() => undefined);
  });

  describe('the topology', () => {
    it('1, 12: a DEFAULT subscription keeps today\'s topology exactly: work queue -> shared fanout, `.dead` bound to it', async () => {
      expect((await queueInfo(legacyQ)).arguments).toEqual({ 'x-dead-letter-exchange': dlx });
      expect((await queueInfo(`${legacyQ}.retry`)).arguments).toEqual({ 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': legacyQ });
      expect(await bindingsOf(`${legacyQ}.dead`)).toEqual([dlx]);
      const status = buses[0]!.consumerStatus();
      expect(status).toEqual([{ queue: legacyQ, state: 'consuming' }]); // no new field for a default subscription
    });

    it('2, 3: an OPTED-IN subscription has no broker dead-letter argument and no fanout binding; its retry queue and private `.dead` exist', async () => {
      const b = bus();
      await b.subscribe({ queue: isolatedQ, bindings: ['isolated.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
      expect((await queueInfo(isolatedQ)).arguments).toEqual({});
      expect((await queueInfo(`${isolatedQ}.retry`)).arguments).toEqual({ 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': isolatedQ });
      expect((await queueInfo(`${isolatedQ}.dead`)).arguments).toEqual({});
      expect(await bindingsOf(`${isolatedQ}.dead`)).toEqual([]);
      expect(await bindingsOf(isolatedQ)).toEqual([exchange]);
      // the kit says what it did NOT verify
      expect(b.consumerStatus()).toEqual([{ queue: isolatedQ, state: 'consuming', topology: { brokerDeadLettering: 'none', effectivePolicy: 'not_verified_by_kit' } }]);
    });

    it('12: both coexist: each processes its own events, and neither changes the other\'s topology', async () => {
      const a = envelope('legacy.done', { note: 'legacy' });
      const i = envelope('isolated.done', { note: 'isolated' });
      await publish(a);
      await publish(i);
      await waitFor(() => handled.get(a.id) === 1 && handled.get(i.id) === 1);
      expect((await queueInfo(legacyQ)).arguments).toEqual({ 'x-dead-letter-exchange': dlx });
      expect((await queueInfo(isolatedQ)).arguments).toEqual({});
    });
  });

  describe('the kit\'s own paths are unchanged on an opted-in subscription', () => {
    const q = owned.queue(`odbrk.paths.${uniq()}`);
    let failOnce = new Set<string>();
    const outcomes = new Map<string, number>();
    beforeAll(async () => {
      let stored = 0;
      const store: ProvenanceStore = { record: async () => (stored++ === 0 ? Promise.reject(new Error('store down')) : 'recorded') }; // the first commit fails: a hold
      await bus().subscribe({
        queue: q, bindings: ['paths.#'], brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }),
        provenance: { ownerOf: () => 'test-service', store },
        deadLetterPolicy: () => ({ body: 'redacted', headers: {} }),
        handler: async (e) => {
          outcomes.set(e.id, (outcomes.get(e.id) ?? 0) + 1);
          if (e.name === 'paths.permanent') throw new PermanentEventFailure('synthetic_refusal');
          if (failOnce.has(e.id)) {
            failOnce.delete(e.id);
            throw new Error('transient');
          }
        },
      });
    });

    it('7: a recoverable hold (a provenance commit failure) requeues and is then processed; a transient handler failure is retried through `.retry`', async () => {
      const held = envelope('paths.ok', { note: 'hold' });
      await publish(held);
      await waitFor(() => notices.some((n) => n.startsWith('event_provenance_deferred') && n.includes(held.id)));
      await waitFor(() => outcomes.get(held.id) === 1, 15_000);
      const retried = envelope('paths.ok', { note: 'retry' });
      failOnce = new Set([retried.id]);
      await publish(retried);
      await waitFor(() => notices.some((n) => n.startsWith('event_retry_scheduled') && n.includes(retried.id)));
      await waitFor(() => outcomes.get(retried.id) === 2, 15_000); // back from `.retry` into the work queue, then processed
      expect(await depth(`${q}.dead`)).toBe(0);
    });

    it('6: an application refusal still writes ONLY the policy-applied (redacted) copy to the private `.dead` queue', async () => {
      const e = envelope('paths.permanent');
      await publish(e);
      await waitFor(async () => (await depth(`${q}.dead`)) === 1);
      const [copy] = await drain(`${q}.dead`);
      expect(copy!.properties.headers?.['x-nawara-body-redacted']).toBe('true');
      expect(copy!.properties.headers?.['x-nawara-failure-reason']).toBe('synthetic_refusal');
      expect(JSON.parse(copy!.content.toString('utf8'))).toEqual({ redacted: true, failure: 'permanent', reason: 'synthetic_refusal', bodyBytes: JSON.stringify(e.payload).length });
      expect(copy!.content.toString('latin1')).not.toContain(CODE);
      expect(await bindingsOf(`${q}.dead`)).toEqual([]); // still never bound to the fanout, even after the kit re-asserted it
    });
  });

  describe('broker-driven dead-lettering: discarded on an opted-in queue, never copied raw', () => {
    const q = owned.queue(`odbrk.broker.${uniq()}`);
    beforeAll(async () => {
      // declared exactly as an opted-in consumer declares it, then left without a consumer, so the broker alone decides
      const b = bus();
      const sub = await b.subscribe({ queue: q, bindings: ['broker.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
      await sub.close();
    });

    it('4: a reject without requeue leaves no copy in ANY queue (the legacy dead letters, the private one, the vhost total)', async () => {
      await drain(`${legacyQ}.dead`);
      const e = envelope('broker.code');
      await publish(e);
      await waitFor(async () => (await depth(q)) === 1);
      const before = await vhostTotal();
      await rejectNext(q, e.id);
      await sleep(500);
      expect(await vhostTotal()).toBe(before - 1); // discarded: it is nowhere
      expect(await depth(`${q}.dead`)).toBe(0);
      expect((await drain(`${legacyQ}.dead`)).filter((m) => m.content.toString('latin1').includes(CODE))).toEqual([]);
    });

    it('5: a publisher-set expiry leaves no copy in any queue', async () => {
      const e = envelope('broker.code');
      const before = await vhostTotal();
      await publish(e, { expiration: '50' });
      await sleep(800);
      expect(await depth(q)).toBe(0);
      expect(await vhostTotal()).toBe(before);
      expect((await drain(`${legacyQ}.dead`)).filter((m) => m.content.toString('latin1').includes(CODE))).toEqual([]);
    });

    it('the same reject on the DEFAULT queue still dead-letters the raw body into the shared fanout (unchanged behaviour)', async () => {
      const b = bus();
      const other = owned.queue(`odbrk.legacy2.${uniq()}`);
      const sub = await b.subscribe({ queue: other, bindings: ['legacy2.#'], handler });
      await sub.close();
      const e = envelope('legacy2.code');
      await publish(e);
      await waitFor(async () => (await depth(other)) === 1);
      await rejectNext(other, e.id);
      const copies = await drain(`${legacyQ}.dead`);
      expect(copies.some((m) => m.properties.messageId === e.id && m.content.toString('latin1').includes(CODE))).toBe(true);
      await drain(`${other}.dead`);
    });

    it('11: an injection into the shared fanout reaches the legacy dead letters, never the opted-in private one', async () => {
      const e = envelope('anything');
      await publish(e, {}, { exchange: dlx });
      await waitFor(async () => (await depth(`${legacyQ}.dead`)) >= 1);
      expect(await depth(`${q}.dead`)).toBe(0);
      expect(await depth(`${isolatedQ}.dead`)).toBe(0);
      await drain(`${legacyQ}.dead`);
    });
  });

  describe('policies: what the kit cannot see, and what the broker refuses', () => {
    const q = owned.queue(`odbrk.policy.${uniq()}`);
    beforeAll(async () => {
      const b = bus();
      const sub = await b.subscribe({ queue: q, bindings: ['policy.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
      await sub.close();
    });

    it('8 (the LIMITATION): a REGULAR policy re-opens a raw dead-letter route on an opted-in queue, and AMQP shows nothing of it', async () => {
      const name = `odbrk-drift-${uniq()}`;
      policies.push(name);
      expect((await mgmt('PUT', `/policies/${vhost}/${name}`, { pattern: `^${q.replaceAll('.', '\\.')}$`, definition: { 'dead-letter-exchange': dlx }, 'apply-to': 'queues', priority: 0 })).status).toBeLessThan(300);
      await waitFor(async () => (await queueInfo(q)).policy === name);
      // the broker's effective configuration (what an EXTERNAL verification must read): the policy and its dead-letter exchange
      expect((await queueInfo(q)).effective_policy_definition).toMatchObject({ 'dead-letter-exchange': dlx });
      expect((await queueInfo(q)).arguments).toEqual({}); // the queue's own arguments are still clean
      // what the KIT can see: an opted-in subscription attaches as usual (no equivalence error: a policy is not an argument)
      const b = bus();
      const sub = await b.subscribe({ queue: q, bindings: ['policy.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
      expect(b.consumerStatus()[0]).toMatchObject({ state: 'consuming', topology: { effectivePolicy: 'not_verified_by_kit' } });
      await sub.close();
      // and the route is real: a reject copies the RAW code into the fanout's dead letters
      await drain(`${legacyQ}.dead`);
      const e = envelope('policy.code');
      await publish(e);
      await waitFor(async () => (await depth(q)) === 1);
      await rejectNext(q, e.id);
      const copies = await drain(`${legacyQ}.dead`);
      expect(copies.some((m) => m.properties.messageId === e.id && m.content.toString('latin1').includes(CODE))).toBe(true);
      await mgmt('DELETE', `/policies/${vhost}/${name}`);
      await waitFor(async () => !(await queueInfo(q)).policy);
    });

    it('9: an OPERATOR policy cannot add a dead-letter exchange (refused by the broker); its expiry on an opted-in queue discards', async () => {
      const dlxName = `odbrk-op-dlx-${uniq()}`;
      const refused = await mgmt('PUT', `/operator-policies/${vhost}/${dlxName}`, { pattern: `^${q.replaceAll('.', '\\.')}$`, definition: { 'dead-letter-exchange': dlx }, 'apply-to': 'queues', priority: 0 });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const ttlName = `odbrk-op-ttl-${uniq()}`;
      operatorPolicies.push(ttlName);
      expect((await mgmt('PUT', `/operator-policies/${vhost}/${ttlName}`, { pattern: `^${q.replaceAll('.', '\\.')}$`, definition: { 'message-ttl': 100 }, 'apply-to': 'queues', priority: 0 })).status).toBeLessThan(300);
      await waitFor(async () => (await queueInfo(q)).operator_policy === ttlName);
      const before = await vhostTotal();
      await publish(envelope('policy.code'));
      await sleep(800);
      expect(await depth(q)).toBe(0);
      expect(await vhostTotal()).toBe(before);
      await mgmt('DELETE', `/operator-policies/${vhost}/${ttlName}`);
    });
  });

  describe('existing queues: fail closed, never deleted or re-created', () => {
    it('10: an opted-in subscription refuses an existing queue that has a dead-letter argument, which stays intact with its messages', async () => {
      const q = owned.queue(`odbrk.old.${uniq()}`);
      const ch = await conn.createChannel();
      await ch.assertQueue(q, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } }); // an old-topology queue
      ch.sendToQueue(q, Buffer.from('{"kept":true}'));
      await ch.close();
      await waitFor(async () => (await depth(q)) === 1);
      await expect(bus().subscribe({ queue: q, bindings: ['old.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) })).rejects.toThrow(/PRECONDITION_FAILED|inequivalent arg/);
      expect((await queueInfo(q)).arguments).toEqual({ 'x-dead-letter-exchange': dlx });
      expect(await depth(q)).toBe(1);
    });

    it('10 (rollback direction): a default subscription refuses an opted-in queue: never silently re-attached to the fanout', async () => {
      const q = owned.queue(`odbrk.new.${uniq()}`);
      const b = bus();
      const sub = await b.subscribe({ queue: q, bindings: ['new.#'], handler, brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
      await sub.close();
      await expect(bus().subscribe({ queue: q, bindings: ['new.#'], handler })).rejects.toThrow(/PRECONDITION_FAILED|inequivalent arg/);
      expect((await queueInfo(q)).arguments).toEqual({});
    });
  });
});
