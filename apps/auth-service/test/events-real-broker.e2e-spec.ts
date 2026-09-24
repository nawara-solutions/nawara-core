import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, type EventBus as KitEventBus, type EventEnvelope } from '@nawara/service-kit';
import { BrokerProxy } from '@nawara/service-kit/testing';
import { EVENT_BUS } from '../src/common/ports.js';
import { EventsPublisherService, KIT_EVENT_BUS } from '../src/events/events-publisher.service.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 16.2 (ADR-0046 rule 17, SDD notification-service §14): Auth's REAL event wiring (the kit `RabbitMqEventBus` behind
 * `EventsPublisherService`, driven by real Auth HTTP flows) against a REAL RabbitMQ, consumed by the certified kit consumer:
 *
 *   Auth request -> EventsPublisherService -> kit RabbitMqEventBus.publish -> nawara.events -> kit consumer (temporary queue)
 *
 * Proves: the consumer accepts every Auth event as a canonical envelope (no `malformed_envelope`, nothing dead-lettered); messages are
 * persistent (delivery mode 2 as the broker delivers them) and confirmed; payloads arrive exactly as the service published them; ids
 * are unique; a broker that is down, severed or not confirming never fails or stalls the Auth request, stays bounded, and leaks no
 * payload value into a log. A pre-16.2 message (no id, no type) is still dead-lettered: the consumer check the proof relies on is live.
 *
 * Needs TEST_RABBITMQ_URL (skipped otherwise). Every queue it declares is uniquely named and deleted afterwards.
 */
const RABBIT = process.env.TEST_RABBITMQ_URL;
const EXCHANGE = 'nawara.events';
/** Every event name Auth publishes (the source's `bus.publish(...)` call sites). */
const AUTH_EVENTS = [
  'user.registered', 'membership.requested', 'membership.admin_provisioned', 'membership.approved', 'membership.rejected', 'membership.revoked',
  'member.contact_verification_requested', 'admin.operator_code_issued', 'admin.operator_confirmation_code_issued',
  'admin.owner_recovery_requested', 'admin.owner_recovery_completed', 'admin.owner_login_from_new_device',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uniq = () => randomUUID().slice(0, 8);

describe.skipIf(!RABBIT)('Stage 16.2: Auth events on a real RabbitMQ are canonical kit envelopes', () => {
  const run = uniq();
  const queue = `auth-envelope-e2e-${run}`;
  const rawQueue = `auth-envelope-e2e-${run}-raw`;
  let consumerBus: RabbitMqEventBus;
  let consumer: { close(): Promise<void> };
  let conn: ChannelModel;
  let ch: Channel;
  const accepted: EventEnvelope[] = [];
  const raw: ConsumeMessage[] = [];
  /** Every payload EventsPublisherService was handed, in order, captured from the live service (not re-built by the test). */
  const handed: Array<{ name: string; payload: object }> = [];
  let t: TestCtx;
  const logs = () => [...t.logger.lines, ...t.jsonLogs.map((l) => JSON.stringify(l))].join('\n');
  const sensitive = new Set<string>();

  async function deadCount(): Promise<number> {
    return (await ch.checkQueue(`${queue}.dead`)).messageCount;
  }
  const acceptedOf = (name: string, pred: (p: Record<string, unknown>) => boolean = () => true) => accepted.filter((e) => e.name === name && pred(e.payload));
  async function waitAccepted(name: string, pred?: (p: Record<string, unknown>) => boolean): Promise<EventEnvelope> {
    await vi.waitFor(() => expect(acceptedOf(name, pred).length).toBeGreaterThan(0), { timeout: 10_000, interval: 25 });
    return acceptedOf(name, pred).at(-1)!;
  }

  beforeAll(async () => {
    // The certified kit consumer, as a future Notification would bind (retries off: a rejection dead-letters at once).
    consumerBus = new RabbitMqEventBus({ url: RABBIT!, retry: { maxRetries: 0 } });
    consumer = await consumerBus.subscribe({ queue, bindings: [...AUTH_EVENTS], handler: async (e) => { accepted.push(e); } });
    // A raw observer on the same exchange: the AMQP properties exactly as the broker delivers them (delivery mode, content type, headers).
    conn = await amqp.connect(RABBIT!);
    ch = await conn.createChannel();
    await ch.assertQueue(rawQueue, { durable: false, autoDelete: false });
    for (const name of AUTH_EVENTS) await ch.bindQueue(rawQueue, EXCHANGE, name);
    await ch.consume(rawQueue, (m) => { if (m) { raw.push(m); ch.ack(m); } });

    t = await createTestApp({}, { realEvents: { rabbitmqUrl: RABBIT! } });
    const pub = t.app.get<EventsPublisherService>(EVENT_BUS);
    expect(pub).toBeInstanceOf(EventsPublisherService); // the real wiring, not the recording bus
    const original = pub.publish.bind(pub);
    vi.spyOn(pub, 'publish').mockImplementation((name, payload) => {
      handed.push({ name, payload: structuredClone(payload) });
      original(name, payload);
    });
  });

  afterAll(async () => {
    await t?.close();
    await consumer?.close();
    await consumerBus?.close();
    for (const q of [queue, `${queue}.retry`, `${queue}.dead`, rawQueue]) await ch?.deleteQueue(q).catch(() => undefined);
    await conn?.close().catch(() => undefined);
  });

  it('real Auth flows (one-time code, security alert, membership decision) reach the kit consumer as canonical, persistent envelopes with the payload unchanged', async () => {
    const w = await t.world();
    // one-time code: operator login code
    const opEmail = `op${uniq()}@leak-probe.test`;
    await t.operator(w.companyA, opEmail);
    const t0 = Date.now();
    await t.http.post('/auth/admin/login/operator/request-code').set('x-correlation-id', `corr-${run}-1`).send({ email: opEmail }).expect(204);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const code = await waitAccepted('admin.operator_code_issued', (p) => p.destination === opEmail);
    // security alert: owner login from a new device
    const owner = await t.readyOwner(w.companyA, `own${uniq()}@leak-probe.test`);
    await t.ownerLogin(owner, owner.totpSecret);
    const alert = await waitAccepted('admin.owner_login_from_new_device', (p) => p.destination === owner.email);
    // membership decision: register through a join code that needs approval, then the owner approves
    const jc = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: true });
    const memberEmail = `m${uniq()}@leak-probe.test`;
    await t.http.post('/auth/register').send({ email: memberEmail, password: 'member password 1', joinCode: jc.code }).expect(201);
    const mid = (await t.db.query(`SELECT m.id FROM organization_membership m JOIN "user" u ON u.id = m."userId" WHERE u.email = $1`, [memberEmail])).rows[0].id;
    await t.http.post(`/auth/organizations/${w.orgDrive}/memberships/${mid}/approve`).set(bearer(owner.tokens)).expect(200);
    const decision = await waitAccepted('membership.approved', (p) => p.destination === memberEmail);
    // events that are not Notification's (they share the publisher and must not break)
    const registered = await waitAccepted('user.registered', (p) => p.organizationId === w.orgDrive);
    const requested = await waitAccepted('membership.requested', (p) => p.organizationId === w.orgDrive);

    for (const e of [code, alert, decision, registered, requested]) {
      expect(e.id).toMatch(UUID);
      expect(e.headers.eventId).toBe(e.id);
      expect(e.headers.source).toBe('auth-service');
      expect(e.headers.version).toBe(1);
      expect(Date.parse(e.headers.occurredAt)).not.toBeNaN();
      expect(e.headers.occurredAt.endsWith('Z')).toBe(true);
      // the payload the consumer received is exactly the one the service handed to its publisher
      const given = handed.filter((h) => h.name === e.name).map((h) => JSON.stringify(h.payload));
      expect(given).toContain(JSON.stringify(e.payload));
      // AMQP level, as the broker delivered it
      await vi.waitFor(() => expect(raw.find((r) => r.properties.messageId === e.id)).toBeDefined(), { timeout: 5_000 });
      const msg = raw.find((r) => r.properties.messageId === e.id)!;
      expect(msg.properties.deliveryMode).toBe(2); // persistent
      expect(msg.properties.type).toBe(e.name);
      expect(msg.properties.contentType).toBe('application/json');
      expect(msg.fields.routingKey).toBe(e.name);
      expect(msg.properties.headers).toMatchObject({ eventId: e.id, source: 'auth-service', version: 1, occurredAt: e.headers.occurredAt });
      expect(JSON.parse(msg.content.toString('utf8'))).toStrictEqual(e.payload);
    }
    expect(code.headers.correlationId).toBe(`corr-${run}-1`); // the request's correlation id follows the event
    // Payload shapes stay the pre-16.2 ones (ADD/SDD), field for field.
    expect(Object.keys(code.payload)).toEqual(['userId', 'channel', 'destination', 'code', 'expiresAt', 'timestamp']);
    expect(code.payload.code).toMatch(/^\d{6,}$/);
    expect(Object.keys(alert.payload)).toEqual(['userId', 'channel', 'destination', 'ipAddress', 'timestamp']);
    expect(Object.keys(decision.payload)).toEqual(['userId', 'organizationId', 'channel', 'destination', 'timestamp']);
    expect(await deadCount()).toBe(0); // nothing dead-lettered (no malformed_envelope)

    for (const v of [code.payload.code, code.payload.destination, alert.payload.destination, alert.payload.ipAddress, decision.payload.destination, owner.password]) sensitive.add(String(v));
    const l = logs();
    for (const s of sensitive) expect(l).not.toContain(s);
  });

  it('every Auth event name is accepted by the kit consumer; ids are unique; source and version are stable', async () => {
    const pub = t.app.get(EVENT_BUS) as EventsPublisherService;
    const tag = `all-${run}`;
    for (const name of AUTH_EVENTS) pub.publish(name, { userId: tag, marker: name });
    await vi.waitFor(() => expect(accepted.filter((e) => e.payload.userId === tag)).toHaveLength(AUTH_EVENTS.length), { timeout: 10_000, interval: 25 });
    const mine = accepted.filter((e) => e.payload.userId === tag);
    expect(new Set(mine.map((e) => e.name))).toEqual(new Set(AUTH_EVENTS));
    expect(mine.every((e) => e.payload.marker === e.name)).toBe(true);
    const ids = accepted.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length); // unique across everything published in this file so far
    expect(new Set(accepted.map((e) => `${e.headers.source}|${e.headers.version}`))).toEqual(new Set(['auth-service|1']));
    expect(await deadCount()).toBe(0);
  });

  it('negative control: a pre-16.2 message (payload only: no messageId, no type) is dead-lettered as malformed by the same consumer', async () => {
    const pubCh = await conn.createConfirmChannel();
    pubCh.publish(EXCHANGE, 'membership.approved', Buffer.from(JSON.stringify({ userId: `legacy-${run}` })));
    await pubCh.waitForConfirms();
    await pubCh.close();
    await vi.waitFor(async () => expect(await deadCount()).toBe(1), { timeout: 10_000, interval: 50 });
    const dead = await ch.get(`${queue}.dead`, { noAck: true });
    expect(dead && dead.properties.headers?.['x-nawara-failure']).toBe('malformed');
    expect(accepted.some((e) => e.payload.userId === `legacy-${run}`)).toBe(false);
  });
});

describe.skipIf(!RABBIT)('Stage 16.2: broker failures never fail or stall an Auth request, stay bounded and log no payload', () => {
  const target = RABBIT ? new URL(RABBIT) : undefined;
  let proxy: BrokerProxy;
  let t: TestCtx;
  let companyId: string;
  let closed = false;
  const sensitive = new Set<string>();
  const logs = () => [...t.logger.lines, ...t.jsonLogs.map((l) => JSON.stringify(l))].join('\n');

  /** Requests an operator code (an event carrying a one-time code and a destination); returns how long the request took. */
  async function requestCode(): Promise<number> {
    const email = `op${uniq()}@leak-probe.test`;
    await t.operator(companyId, email);
    sensitive.add(email);
    const t0 = Date.now();
    await t.http.post('/auth/admin/login/operator/request-code').send({ email }).expect(204);
    return Date.now() - t0;
  }
  const lines = (needle: string) => t.logger.lines.filter((l) => l.includes(needle));
  /** Outcome of every kit-bus publish, in order: 'confirmed' or the error name. */
  const outcomes: string[] = [];
  async function requestCodeAndSettle(): Promise<{ ms: number; outcome: string }> {
    const n = outcomes.length;
    const ms = await requestCode();
    await vi.waitFor(() => expect(outcomes.length).toBe(n + 1), { timeout: 15_000, interval: 25 });
    return { ms, outcome: outcomes[n] };
  }

  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target!.hostname, port: Number(target!.port || 5672) });
    await proxy.start();
    const url = new URL(RABBIT!);
    url.host = `127.0.0.1:${proxy.port}`;
    t = await createTestApp({ RABBITMQ_CONFIRM_TIMEOUT_MS: '500' }, { realEvents: { rabbitmqUrl: url.toString() } });
    const pub = t.app.get<EventsPublisherService>(EVENT_BUS);
    const original = pub.publish.bind(pub);
    vi.spyOn(pub, 'publish').mockImplementation((name, payload) => {
      for (const k of ['code', 'destination', 'ipAddress']) if ((payload as Record<string, unknown>)[k]) sensitive.add(String((payload as Record<string, unknown>)[k]));
      original(name, payload);
    });
    const kit = t.app.get<KitEventBus>(KIT_EVENT_BUS);
    const kitPublish = kit.publish.bind(kit);
    vi.spyOn(kit, 'publish').mockImplementation((e) => kitPublish(e).then(
      () => { outcomes.push('confirmed'); },
      (err: unknown) => { outcomes.push(err instanceof Error ? err.name : 'unknown'); throw err; },
    ));
    companyId = await t.newCompany();
    expect((await requestCodeAndSettle()).outcome).toBe('confirmed'); // connected and confirmed through the proxy
  });

  afterAll(async () => {
    proxy?.thaw();
    if (!closed) await t?.close();
    await proxy?.sever();
  });

  it('confirm not received (a stalled broker): the request returns at once; the publish fails after RABBITMQ_CONFIRM_TIMEOUT_MS, logged without payload', async () => {
    expect(lines('event_publish_failure')).toHaveLength(0);
    proxy.freeze();
    const t0 = Date.now();
    const { ms, outcome } = await requestCodeAndSettle();
    expect(ms).toBeLessThan(2_000); // the request did not wait for the broker
    expect(outcome).toBe('PublisherConfirmTimeoutError');
    expect(Date.now() - t0).toBeLessThan(3_000); // bounded by RABBITMQ_CONFIRM_TIMEOUT_MS (500 ms here)
    expect(lines('rabbitmq_confirm_timeout')).toHaveLength(1);
    expect(lines('event_publish_failure')).toHaveLength(1);
    expect(lines('event_publish_failure')[0]).toMatch(/name=admin\.operator_code_issued error=PublisherConfirmTimeoutError/);
    proxy.thaw();
  });

  it('connection lost, then broker unreachable: the request still returns at once; the failure is logged and bounded; publishing resumes when the broker is back', async () => {
    await proxy.sever(); // every socket dies and new connections are refused
    const before = lines('event_publish_failure').length;
    const t0 = Date.now();
    const lost = await requestCodeAndSettle();
    expect(lost.ms).toBeLessThan(2_000);
    expect(lost.outcome).not.toBe('confirmed');
    expect(Date.now() - t0).toBeLessThan(7_000); // bounded (connection refused at once; connect timeout 5 s at worst)
    expect(lines('event_publish_failure')).toHaveLength(before + 1);
    expect(lines('event_publish_failure').at(-1)).toMatch(/name=admin\.operator_code_issued error=\S+/);
    // back: the next event is published and confirmed on a fresh connection (no restart of Auth)
    await proxy.start();
    expect((await requestCodeAndSettle()).outcome).toBe('confirmed');
    expect(lines('event_publish_failure')).toHaveLength(before + 1);
  });

  it('no payload value, broker credential or secret reaches any log line', async () => {
    const url = new URL(RABBIT!);
    const l = logs();
    for (const s of sensitive) expect(l).not.toContain(s);
    if (url.password) expect(l).not.toContain(`:${decodeURIComponent(url.password)}@`);
    for (const secret of ['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER']) expect(l).not.toContain(t.env[secret]);
    expect([...sensitive].some((v) => /^\d{6,}$/.test(v))).toBe(true); // the scan did include one-time codes
  });

  it('shutdown with a stalled broker is bounded: the queued events are dropped and the app closes', async () => {
    proxy.freeze();
    await requestCode(); // its publish is in flight (unconfirmed) when shutdown starts
    const t0 = Date.now();
    await t.close();
    closed = true;
    expect(Date.now() - t0).toBeLessThan(45_000);
  }, 60_000);
});
