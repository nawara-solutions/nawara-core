import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, type EventEnvelope } from '@nawara/service-kit';
import { BrokerProxy } from '@nawara/service-kit/testing';
import { DOMAIN_EVENTS } from '../src/common/ports.js';
import { OutboxDomainEvents } from '../src/events/domain-events.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 16.2, re-certified for Stage 21.C.2 (ADR-0052 decision 4): Auth's REAL event path against a REAL RabbitMQ, consumed by the
 * certified kit consumer:
 *
 *   Auth request -> transaction (change + outbox row) -> COMMIT -> the one kit relay -> nawara.events -> kit consumer (temporary queue)
 *
 * Proves: every Auth event is a canonical envelope (no `malformed_envelope`, nothing dead-lettered); the envelope id is the outbox row's;
 * messages are persistent and confirmed; payloads arrive exactly as the service wrote them; ids are unique. A broker that is down, severed
 * or not confirming never fails or stalls an Auth request, AND (new with the outbox) never loses the event: it stays committed and pending,
 * and is delivered once the broker is back. No payload value reaches a log. A pre-16.2 message (no id, no type) is still dead-lettered.
 *
 * Needs TEST_RABBITMQ_URL (skipped otherwise). Every queue it declares is uniquely named and deleted afterwards.
 */
const RABBIT = process.env.TEST_RABBITMQ_URL;
const EXCHANGE = 'nawara.events';
/** Every event name Auth writes (the source's `events.emit(...)` call sites). */
const AUTH_EVENTS = [
  'user.registered', 'membership.requested', 'membership.admin_provisioned', 'membership.approved', 'membership.rejected', 'membership.revoked',
  'member.contact_verification_requested', 'admin.operator_code_issued', 'admin.operator_confirmation_code_issued',
  'admin.owner_recovery_requested', 'admin.owner_recovery_completed', 'admin.owner_login_from_new_device',
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uniq = () => randomUUID().slice(0, 8);
const sortedKeys = (o: object) => Object.keys(o).sort();

describe.skipIf(!RABBIT)('Auth events on a real RabbitMQ are canonical kit envelopes, relayed from the outbox', () => {
  const run = uniq();
  const queue = `auth-envelope-e2e-${run}`;
  const rawQueue = `auth-envelope-e2e-${run}-raw`;
  let consumerBus: RabbitMqEventBus;
  let consumer: { close(): Promise<void> };
  let conn: ChannelModel;
  let ch: Channel;
  const accepted: EventEnvelope[] = [];
  const raw: ConsumeMessage[] = [];
  /** Every payload the service wrote, in order, captured from the live writer (not re-built by the test). */
  const handed: Array<{ name: string; payload: object }> = [];
  let t: TestCtx;
  const logs = () => [...t.logger.lines, ...t.jsonLogs.map((l) => JSON.stringify(l))].join('\n');
  const sensitive = new Set<string>();

  async function deadCount(): Promise<number> {
    return (await ch.checkQueue(`${queue}.dead`)).messageCount;
  }
  const acceptedOf = (name: string, pred: (p: Record<string, unknown>) => boolean = () => true) => accepted.filter((e) => e.name === name && pred(e.payload));
  async function waitAccepted(name: string, pred?: (p: Record<string, unknown>) => boolean): Promise<EventEnvelope> {
    await vi.waitFor(() => expect(acceptedOf(name, pred).length).toBeGreaterThan(0), { timeout: 15_000, interval: 25 });
    return acceptedOf(name, pred).at(-1)!;
  }

  beforeAll(async () => {
    // The certified kit consumer, as Notification binds (retries off: a rejection dead-letters at once).
    consumerBus = new RabbitMqEventBus({ url: RABBIT!, retry: { maxRetries: 0 } });
    consumer = await consumerBus.subscribe({ queue, bindings: [...AUTH_EVENTS], handler: async (e) => { accepted.push(e); } });
    conn = await amqp.connect(RABBIT!);
    ch = await conn.createChannel();
    await ch.assertQueue(rawQueue, { durable: false, autoDelete: false });
    for (const name of AUTH_EVENTS) await ch.bindQueue(rawQueue, EXCHANGE, name);
    await ch.consume(rawQueue, (m) => { if (m) { raw.push(m); ch.ack(m); } });

    t = await createTestApp({}, { realEvents: { rabbitmqUrl: RABBIT! } });
    const writer = t.app.get<OutboxDomainEvents>(DOMAIN_EVENTS);
    expect(writer).toBeInstanceOf(OutboxDomainEvents); // the real path, not the recording double
    const original = writer.emit.bind(writer);
    vi.spyOn(writer, 'emit').mockImplementation(async (q, name, payload) => {
      handed.push({ name, payload: structuredClone(payload) });
      await original(q, name, payload);
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
    const opEmail = `op${uniq()}@leak-probe.test`;
    await t.operator(w.companyA, opEmail);
    const t0 = Date.now();
    await t.http.post('/auth/admin/login/operator/request-code').set('x-correlation-id', `corr-${run}-1`).send({ email: opEmail }).expect(204);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const code = await waitAccepted('admin.operator_code_issued', (p) => p.destination === opEmail);
    const owner = await t.readyOwner(w.companyA, `own${uniq()}@leak-probe.test`);
    await t.ownerLogin(owner, owner.totpSecret);
    const alert = await waitAccepted('admin.owner_login_from_new_device', (p) => p.destination === owner.email);
    const jc = await t.joinCode(w.orgDrive, { audience: 'driver', requiresApproval: true });
    const memberEmail = `m${uniq()}@leak-probe.test`;
    await t.http.post('/auth/register').send({ email: memberEmail, password: 'member password 1', joinCode: jc.code }).expect(201);
    const mid = (await t.db.query(`SELECT m.id FROM organization_membership m JOIN "user" u ON u.id = m."userId" WHERE u.email = $1`, [memberEmail])).rows[0].id;
    await t.http.post(`/auth/organizations/${w.orgDrive}/memberships/${mid}/approve`).set(bearer(owner.tokens)).expect(200);
    const decision = await waitAccepted('membership.approved', (p) => p.destination === memberEmail);
    const registered = await waitAccepted('user.registered', (p) => p.organizationId === w.orgDrive);
    const requested = await waitAccepted('membership.requested', (p) => p.organizationId === w.orgDrive);

    for (const e of [code, alert, decision, registered, requested]) {
      expect(e.id).toMatch(UUID);
      expect(e.headers.eventId).toBe(e.id);
      expect(e.headers.source).toBe('auth-service');
      expect(e.headers.version).toBe(1);
      expect(Date.parse(e.headers.occurredAt)).not.toBeNaN();
      expect(e.headers.occurredAt.endsWith('Z')).toBe(true);
      const given = handed.filter((h) => h.name === e.name).map((h) => h.payload);
      expect(given.some((g) => JSON.stringify(sortedKeys(g).map((k) => [k, (g as Record<string, unknown>)[k]])) === JSON.stringify(sortedKeys(e.payload).map((k) => [k, e.payload[k]])))).toBe(true);
      await vi.waitFor(() => expect(raw.find((r) => r.properties.messageId === e.id)).toBeDefined(), { timeout: 5_000 });
      const msg = raw.find((r) => r.properties.messageId === e.id)!;
      expect(msg.properties.deliveryMode).toBe(2);
      expect(msg.properties.type).toBe(e.name);
      expect(msg.properties.contentType).toBe('application/json');
      expect(msg.fields.routingKey).toBe(e.name);
      expect(msg.properties.headers).toMatchObject({ eventId: e.id, source: 'auth-service', version: 1, occurredAt: e.headers.occurredAt });
      expect(JSON.parse(msg.content.toString('utf8'))).toStrictEqual(e.payload);
    }
    expect(code.headers.correlationId).toBe(`corr-${run}-1`);
    // The field sets stay the pre-16.2 ones (ADD/SDD), field for field (jsonb decides the key ORDER; JSON consumers never rely on it).
    expect(sortedKeys(code.payload)).toEqual(['channel', 'code', 'destination', 'expiresAt', 'timestamp', 'userId']);
    expect(code.payload.code).toMatch(/^\d{6,}$/);
    expect(sortedKeys(alert.payload)).toEqual(['channel', 'destination', 'ipAddress', 'timestamp', 'userId']);
    expect(sortedKeys(decision.payload)).toEqual(['channel', 'destination', 'organizationId', 'timestamp', 'userId']);
    expect(await deadCount()).toBe(0);

    for (const v of [code.payload.code, code.payload.destination, alert.payload.destination, alert.payload.ipAddress, decision.payload.destination, owner.password]) sensitive.add(String(v));
    const l = logs();
    for (const s of sensitive) expect(l).not.toContain(s);
  });

  it('every Auth event name is accepted by the kit consumer; ids are the outbox row ids, unique; source and version are stable', async () => {
    const writer = t.app.get<OutboxDomainEvents>(DOMAIN_EVENTS);
    const tag = `all-${run}`;
    await t.dbs.tx(async (q) => {
      for (const name of AUTH_EVENTS) await writer.emit(q, name, { userId: tag, marker: name });
    });
    const rowIds = new Set((await t.db.query(`SELECT id FROM outbox WHERE payload->>'userId' = $1`, [tag])).rows.map((r) => r.id));
    await vi.waitFor(() => expect(accepted.filter((e) => e.payload.userId === tag)).toHaveLength(AUTH_EVENTS.length), { timeout: 15_000, interval: 25 });
    const mine = accepted.filter((e) => e.payload.userId === tag);
    expect(new Set(mine.map((e) => e.name))).toEqual(new Set(AUTH_EVENTS));
    expect(mine.every((e) => e.payload.marker === e.name && rowIds.has(e.id))).toBe(true);
    const ids = accepted.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
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

describe.skipIf(!RABBIT)('Stage 21.C.2: a broker failure never fails an Auth request and never loses its event', () => {
  const target = RABBIT ? new URL(RABBIT) : undefined;
  const run = uniq();
  const queue = `auth-durable-e2e-${run}`;
  let proxy: BrokerProxy;
  let t: TestCtx;
  let companyId: string;
  let consumerBus: RabbitMqEventBus;
  let consumer: { close(): Promise<void> };
  let closed = false;
  const accepted: EventEnvelope[] = [];
  const sensitive = new Set<string>();
  const logs = () => [...t.logger.lines, ...t.jsonLogs.map((l) => JSON.stringify(l))].join('\n');

  /** Requests an operator code; returns how long the request took and the committed outbox row. */
  async function requestCode(): Promise<{ ms: number; rowId: string }> {
    const email = `op${uniq()}@leak-probe.test`;
    await t.operator(companyId, email);
    sensitive.add(email);
    const t0 = Date.now();
    await t.http.post('/auth/admin/login/operator/request-code').send({ email }).expect(204);
    const ms = Date.now() - t0;
    const { rows } = await t.db.query(`SELECT id, payload->>'code' AS code FROM outbox WHERE name = 'admin.operator_code_issued' AND payload->>'destination' = $1`, [email]);
    expect(rows).toHaveLength(1); // committed with the request, whatever the broker is doing
    sensitive.add(rows[0].code);
    return { ms, rowId: rows[0].id };
  }
  // Generous windows (Stage 21.C.2): the relay's backoff ceiling is 15 s, and under a full parallel e2e run the proxy leg is slower.
  const deliveredOnce = (id: string) => vi.waitFor(() => expect(accepted.filter((e) => e.id === id)).toHaveLength(1), { timeout: 90_000, interval: 50 });

  beforeAll(async () => {
    consumerBus = new RabbitMqEventBus({ url: RABBIT!, retry: { maxRetries: 0 } });
    consumer = await consumerBus.subscribe({ queue, bindings: ['admin.operator_code_issued'], handler: async (e) => { accepted.push(e); } });
    proxy = new BrokerProxy({ host: target!.hostname, port: Number(target!.port || 5672) });
    await proxy.start();
    const url = new URL(RABBIT!);
    url.host = `127.0.0.1:${proxy.port}`;
    t = await createTestApp({ RABBITMQ_CONFIRM_TIMEOUT_MS: '500' }, { realEvents: { rabbitmqUrl: url.toString() } });
    companyId = await t.newCompany();
    await deliveredOnce((await requestCode()).rowId); // connected and delivered through the proxy
  });

  afterAll(async () => {
    proxy?.thaw();
    if (!closed) await t?.close();
    await proxy?.sever();
    await consumer?.close();
    await consumerBus?.close();
    const c = await amqp.connect(RABBIT!);
    const ch = await c.createChannel();
    for (const q of [queue, `${queue}.retry`, `${queue}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
    await c.close().catch(() => undefined);
  });

  it('confirm not received (a stalled broker): the request returns at once; the row stays pending; once the broker answers it is delivered', async () => {
    proxy.freeze();
    const { ms, rowId } = await requestCode();
    expect(ms).toBeLessThan(2_000);
    await vi.waitFor(async () => {
      const { rows } = await t.db.query(`SELECT attempts, "publishedAt" FROM outbox WHERE id = $1`, [rowId]);
      expect(rows[0].attempts).toBeGreaterThan(0);
      expect(rows[0].publishedAt).toBeNull();
    }, { timeout: 45_000, interval: 100 });
    expect(logs()).toMatch(new RegExp(`outbox_publish_failure eventId=${rowId} name=admin\\.operator_code_issued`));
    proxy.thaw();
    await deliveredOnce(rowId);
  }, 180_000);

  it('connection lost, then broker unreachable: the request still returns at once; the event is delivered when the broker is back (no restart)', async () => {
    await proxy.sever();
    const { ms, rowId } = await requestCode();
    expect(ms).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 2_000));
    expect(accepted.some((e) => e.id === rowId)).toBe(false);
    await proxy.start();
    await deliveredOnce(rowId);
  }, 180_000);

  it('no payload value, broker credential or secret reaches any log line', async () => {
    const url = new URL(RABBIT!);
    const l = logs();
    for (const s of sensitive) expect(l).not.toContain(s);
    if (url.password) expect(l).not.toContain(`:${decodeURIComponent(url.password)}@`);
    for (const secret of ['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER']) expect(l).not.toContain(t.env[secret]);
    expect([...sensitive].some((v) => /^\d{6,}$/.test(v))).toBe(true);
  });

  it('shutdown with a stalled broker is bounded, and the unpublished event stays committed (a later instance relays it)', async () => {
    proxy.freeze();
    const { rowId } = await requestCode();
    const t0 = Date.now();
    const db = t.db;
    const { rows: before } = await db.query(`SELECT "publishedAt" FROM outbox WHERE id = $1`, [rowId]);
    expect(before[0].publishedAt).toBeNull();
    await t.close();
    closed = true;
    expect(Date.now() - t0).toBeLessThan(45_000);
  }, 60_000);
});
