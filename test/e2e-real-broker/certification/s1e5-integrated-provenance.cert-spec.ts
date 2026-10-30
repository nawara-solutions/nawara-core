import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import amqp, { type Channel, type ChannelModel, type GetMessage } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleAuditPayload } from '@nawara/audit-contract/testing';
import { RabbitMqEventBus, bodyMac, generateServiceToken, kitMigrationsDir, replayDeadLetter, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { TEST_PLATFORM, billingPolicy, paymentPolicy, startReferenceStub, type ReferenceStub } from '../support/admission.js';
import { describeWithEnv } from '../support/env.js';
import { startFakeAuthServer, type FakeAuthServer } from '../support/fake-auth.js';
import { spawnService, waitFor, type LiveService } from '../support/process.js';

/**
 * Core V2 S1e-5 (ADR-0057 §13, S0-C1 to S0-C6; ADR-0052 decision 5): INTEGRATED certification of the three enforced consumers, the REAL
 * built processes (Billing with a real Payment, Audit in both modes, Notification), on a broker provisioned by the AUTHENTIC
 * `infra/rabbitmq/provision.sh` (every service identity with exactly its generated grants; Auth's domain events active in a TEST-ONLY
 * variant) and a disposable PostgreSQL. Run by `scripts/deploy-tests/real-broker-consumers.mjs` (`npm run test:deploy:real-broker`),
 * never by the ordinary real-broker job. Publishers are the real identities: Payment is the real payment-service process; Auth and the
 * audit producers publish through the kit bus with their own provisioned credentials (the broker stamps their `user_id`). Attacks use
 * only EXISTING capabilities: the consumers' `amq.default` and shared-DLX write grants (register OD-BRK) and the break-glass
 * administrator (no `user_id`: a legacy or misconfigured publisher). Every payload, code and key is SYNTHETIC; no secret is printed.
 *
 * Outcomes are told apart: a BROKER authorization denial (a channel error), a CONSUMER provenance refusal (a permanent dead letter
 * `untrusted_<basis>`, the business handler never run) and a business refusal (the handler's own reason).
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const APP = (s: string) => `${ROOT}apps/${s}`;
const EXCHANGE = 'nawara.events';
const DLX = `${EXCHANGE}.dlx`;
const Q = { billing: 'billing.payment-events', audit: 'audit-service.audit', notification: 'notification.events' } as const;
const CODE = '614273';
const EMAIL = 's1e5-member@example.test';
const PAYER_TOKEN = 's1e5-payer-jwt';
const PAYER_ID = 'e2e0e2e0-0000-4000-8000-0000000051e5';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = () => randomBytes(32).toString('base64');
const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

describeWithEnv('S1e-5 integrated consumer provenance certification (provisioned broker, real processes)', ['S1E5_BROKER_DIR', 'S1E5_BROKER_HOST', 'S1E5_BROKER_CONTAINER', 'TEST_DATABASE_ADMIN_URL'], (env) => {
  const host = env.S1E5_BROKER_HOST;
  /** A provisioned identity's URL (its own secret, from the script's state), reaching the broker at `at` (default: its address). */
  const urlOf = (svc: string, at = `${host}:5672`) => readFileSync(`${env.S1E5_BROKER_DIR}/clients/${svc}.env`, 'utf8').trim().replace('RABBITMQ_URL=', '').replace(`@${env.S1E5_BROKER_CONTAINER}:5672`, `@${at}`);
  const adminUrl = () => {
    const f = readFileSync(`${env.S1E5_BROKER_DIR}/rabbitmq.env`, 'utf8');
    const get = (k: string) => f.match(new RegExp(`^${k}=(.*)$`, 'm'))![1];
    return `amqp://${get('RABBITMQ_DEFAULT_USER')}:${get('RABBITMQ_DEFAULT_PASS')}@${host}:5672/nawara-core`;
  };
  /** rabbitmqctl in THIS run's own broker container only. */
  const ctl = (...args: string[]) => execFileSync('docker', ['exec', '-u', 'rabbitmq', env.S1E5_BROKER_CONTAINER, 'rabbitmqctl', '-q', ...args], { encoding: 'utf8' });

  let admin: ChannelModel;
  let ch: Channel;
  let tapQueue: string;
  const tapped = new Map<string, GetMessage>();
  const closers: Array<() => Promise<unknown>> = [];
  const allText: string[] = [];
  let refStub: ReferenceStub;
  let fakeAuth: FakeAuthServer;
  let proxy: BrokerProxy;
  const dbs: Record<'billing' | 'payment' | 'audit' | 'notification', TestDatabase> = {} as never;
  const pools: Record<string, pg.Pool> = {};
  const ports: Record<string, number> = {};
  const live: Record<string, LiveService | undefined> = {};
  const envs: Record<string, NodeJS.ProcessEnv> = {};
  const P1 = randomBytes(32);
  const P2 = randomBytes(32);
  const producerToken = generateServiceToken();
  const billingToPaymentToken = generateServiceToken();

  const q = <T = Record<string, unknown>>(db: keyof typeof dbs, text: string, params: unknown[] = []) => pools[db]!.query(text, params).then((r) => r.rows as T[]);
  const start = async (name: string) => {
    live[name] = spawnService(name, APP(name === 'billing' ? 'billing-service' : name === 'payment' ? 'payment-service' : name === 'audit' ? 'audit-service' : 'notification-service'), envs[name]!);
    const path = name === 'audit' || name === 'notification' ? '/ready' : '/health';
    try {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${ports[name]}${path}`).catch(() => undefined))?.status === 200, 45_000, `${name} ready`);
    } catch (e) {
      throw new Error(`${String(e)}\n${live[name]!.tail()}`);
    }
  };
  const stop = async (name: string) => {
    allText.push(live[name]?.tail() ?? '');
    await live[name]?.stop();
    live[name] = undefined;
  };
  const logs = (name: string) => live[name]?.tail() ?? '';
  const metrics = async (name: string) => (await fetch(`http://127.0.0.1:${ports[`${name}Metrics`]}/metrics`)).text();
  const trustCount = (text: string, queue: string, outcome: string, kind: string) => {
    const m = text.match(new RegExp(`^nawara_event_trust_total\\{[^}]*queue="${queue.replaceAll('.', '\\.')}"[^}]*outcome="${outcome}"[^}]*kind="${kind}"[^}]*\\} (\\d+)`, 'm'))
      ?? text.match(new RegExp(`^nawara_event_trust_total\\{[^}]*kind="${kind}"[^}]*outcome="${outcome}"[^}]*queue="${queue.replaceAll('.', '\\.')}"[^}]*\\} (\\d+)`, 'm'));
    return m ? Number(m[1]) : 0;
  };

  /** A synthetic Auth operator-code event (code-bearing): every code here is synthetic. */
  const code = (over: Record<string, unknown> = {}, id: string = randomUUID()): EventEnvelope => ({
    id, name: 'admin.operator_code_issued',
    payload: { userId: `user-${randomUUID().slice(0, 8)}`, channel: 'email', destination: EMAIL, code: CODE, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), timestamp: new Date().toISOString(), ...over },
    headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}` },
  });
  /** Publishes through the kit bus as a provisioned identity (the broker stamps and checks its `user_id`). */
  const buses = new Map<string, RabbitMqEventBus>();
  const asIdentity = (svc: string) => {
    if (!buses.has(svc)) buses.set(svc, new RabbitMqEventBus({ url: urlOf(svc), exchange: EXCHANGE }));
    return buses.get(svc)!;
  };
  /** Raw bytes through an AMQP connection: `as` an identity (its `user_id`) or the administrator (none); to the exchange or a queue. */
  const raw = async (m: { as?: string; exchange?: string; routingKey?: string; queue?: string; body: Buffer; id: string; type: string; headers: object; expiration?: string }) => {
    const c = await amqp.connect(m.as ? urlOf(m.as) : adminUrl());
    const errors: unknown[] = [];
    c.on('error', (e) => errors.push(e));
    try {
      const cc = await c.createConfirmChannel();
      cc.on('error', (e) => errors.push(e));
      const props = { persistent: true, contentType: 'application/json', messageId: m.id, type: m.type, headers: m.headers as Record<string, unknown>, ...(m.as ? { userId: m.as } : {}), ...(m.expiration ? { expiration: m.expiration } : {}) };
      if (m.queue) cc.sendToQueue(m.queue, m.body, props);
      else cc.publish(m.exchange ?? EXCHANGE, m.routingKey ?? m.type, m.body, props);
      await cc.waitForConfirms();
      await cc.close().catch(() => undefined);
      return { refused: undefined as string | undefined };
    } catch (e) {
      // the broker's own reason arrives on the channel's error event; the rejected call itself may only say "channel closed"
      const text = [e, ...errors].map((x) => String((x as Error)?.message ?? x)).join(' ');
      return { refused: /403|ACCESS_REFUSED/.test(text) ? 'broker_403' : /406|PRECONDITION/.test(text) ? 'broker_406' : text };
    } finally {
      await c.close().catch(() => undefined);
    }
  };
  /** Takes the dead-letter copy of message `id` from `queue` (removing what it scans past is fine: each test owns its messages). */
  const takeDead = async (queue: string, id: string, ms = 30_000) => {
    let found: GetMessage | undefined;
    await waitFor(async () => {
      for (;;) {
        const m = await ch.get(`${queue}.dead`, { noAck: true });
        if (!m) break;
        if (m.properties.messageId === id) found = m;
        allText.push(m.content.toString('latin1'), JSON.stringify(m.properties.headers ?? {}));
      }
      return found !== undefined;
    }, ms, `the dead letter of ${id} in ${queue}.dead`);
    const h = found!.properties.headers ?? {};
    return { reason: h['x-nawara-failure-reason'] as string | undefined, failure: h['x-nawara-failure'] as string | undefined, redacted: h['x-nawara-body-redacted'] === 'true', headers: h, content: found!.content, msg: found! };
  };
  const depth = async (queue: string) => (await ch.checkQueue(queue)).messageCount;
  const take = async (id: string, ms = 20_000) => {
    await waitFor(() => tapped.has(id), ms, `the broker to route ${id}`);
    return tapped.get(id)!;
  };

  beforeAll(async () => {
    admin = await amqp.connect(adminUrl());
    ch = await admin.createChannel();
    ch.on('error', () => undefined);
    // the administrator's own capture of everything routed (it never consumes from a service queue)
    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    tapQueue = (await ch.assertQueue('', { exclusive: true, autoDelete: true })).queue;
    await ch.bindQueue(tapQueue, EXCHANGE, '#');
    await ch.consume(tapQueue, (m) => void (m && tapped.set(String(m.properties.messageId), m as unknown as GetMessage)), { noAck: true });
    refStub = await startReferenceStub();
    fakeAuth = await startFakeAuthServer({ [PAYER_TOKEN]: { id: PAYER_ID, isActive: true } });
    proxy = new BrokerProxy({ host, port: 5672 });
    await proxy.start();
    for (const k of ['billing', 'payment', 'audit', 'notification'] as const) {
      dbs[k] = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, `s1e5${k}`);
      await runMigrations(dbs[k].url, [kitMigrationsDir, `${APP(`${k}-service`)}/db/migrations/`]);
      pools[k] = new pg.Pool({ connectionString: dbs[k].url, max: 3 });
    }
    // Core V2 S3d: the test Platform's commercial configuration (an Organization subscription product names its Platform, S3a)
    await pools.billing!.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, gen_random_uuid(), 'TND', gen_random_uuid())`, [TEST_PLATFORM]);
    for (const k of ['billing', 'payment', 'audit', 'notification', 'billingMetrics', 'auditMetrics', 'notificationMetrics']) ports[k] = await freePort();
    envs.payment = {
      NODE_ENV: 'test', PORT: String(ports.payment), DATABASE_URL: dbs.payment.url, AUTH_SERVICE_URL: fakeAuth.url,
      RABBITMQ_URL: urlOf('payment-service', `127.0.0.1:${proxy.port}`), // payment-service's own identity, through a proxy this suite can sever
      PAYMENT_SUPPORTED_CURRENCIES: 'TND', PAYMENT_TEST_PROVIDER: 'true',
      SERVICE_TOKENS: `billing-service:${billingToPaymentToken.digest}`, ...paymentPolicy('billing-service'), ...refStub.env,
    };
    envs.billing = {
      NODE_ENV: 'test', PORT: String(ports.billing), DATABASE_URL: dbs.billing.url, AUTH_SERVICE_URL: 'http://127.0.0.1:9', RABBITMQ_URL: urlOf('billing-service'),
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${producerToken.digest}`, ...billingPolicy('test-producer'), ...refStub.env,
      PAYMENT_SERVICE_URL: `http://127.0.0.1:${ports.payment}`, PAYMENT_SERVICE_TOKEN: billingToPaymentToken.token,
      BILLING_DISPATCH_INTERVAL_MS: '300', BILLING_RECONCILE_INTERVAL_MS: '3600000', METRICS_ENABLED: 'true', METRICS_PORT: String(ports.billingMetrics),
    };
    envs.audit = {
      NODE_ENV: 'test', PORT: String(ports.audit), DATABASE_URL: dbs.audit.url, RABBITMQ_URL: urlOf('audit-service'), METRICS_ENABLED: 'true', METRICS_PORT: String(ports.auditMetrics),
    };
    envs.notification = {
      NODE_ENV: 'test', PORT: String(ports.notification), DATABASE_URL: dbs.notification.url, RABBITMQ_URL: urlOf('notification-service'),
      NOTIFICATION_SECRET_KEYS: `k1:${b64()}`, NOTIFICATION_SECRET_ACTIVE_KEY_ID: 'k1', NOTIFICATION_PROVENANCE_KEYS: `p1:${P1.toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p1',
      NOTIFICATION_DEFAULT_LOCALE: 'en', NOTIFICATION_REQUEST_HASH_KEY: b64(), METRICS_ENABLED: 'true', METRICS_PORT: String(ports.notificationMetrics),
    };
    await start('payment');
    await start('billing');
    await start('audit'); // AUDIT_PROVENANCE_ENFORCEMENT unset: the compatibility phase (production's current configuration)
    await start('notification');
  }, 240_000);

  afterAll(async () => {
    for (const n of ['billing', 'payment', 'audit', 'notification']) await stop(n).catch(() => undefined);
    for (const b of buses.values()) await b.close().catch(() => undefined);
    for (const c of closers) await c().catch(() => undefined);
    await proxy?.sever().catch(() => undefined);
    await fakeAuth?.stop().catch(() => undefined);
    await refStub?.close().catch(() => undefined);
    for (const p of Object.values(pools)) await p.end().catch(() => undefined);
    for (const d of Object.values(dbs)) await d?.drop().catch(() => undefined);
    await admin?.close().catch(() => undefined);
  }, 120_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────── the environment itself

  it('every consumer runs its mandatory policy, under its own identity, on the provisioned queues', async () => {
    expect(logs('notification')).toMatch(/event_intake_started queue=notification\.events bindings=9 enforcement=strict/);
    expect(logs('audit')).toMatch(/audit_ingestion_started queue=audit-service\.audit bindings=audit\.# enforcement=compatibility/);
    const consumers = ctl('list_consumers', '-p', 'nawara-core', 'queue_name', 'channel_pid', '--no-table-headers');
    for (const queue of Object.values(Q)) expect(consumers).toContain(queue);
    const conns = ctl('list_connections', '-p', 'nawara-core', 'user', '--no-table-headers').split('\n').map((l) => l.trim()).filter(Boolean);
    // Payment connects when its relay first publishes; its identity is asserted on its first routed event (`user_id` = payment-service)
    for (const u of ['billing-service', 'audit-service', 'notification-service']) expect(conns).toContain(u);
    expect(conns).not.toContain('guest');
  });

  it('broker-driven dead-lettering preconditions (OD-BRK-0 items 1, 2): Notification has NO broker dead-letter exchange and its `.dead` no fanout binding; nothing expires or overflows; no policy', () => {
    const queues = ctl('list_queues', '-p', 'nawara-core', 'name', 'arguments', 'policy', '--no-table-headers');
    for (const queue of Object.values(Q)) {
      const line = queues.split('\n').find((l) => l.split('\t')[0] === queue)!;
      // OD-BRK-2a: the code-bearing queue is isolated; Billing and Audit keep the shared exchange until OD-BRK-3 / OD-BRK-4 (documented residual)
      if (queue === Q.notification) expect(line, queue).not.toMatch(/x-dead-letter-exchange/);
      else expect(line, queue).toMatch(/x-dead-letter-exchange/);
      expect(line, queue).not.toMatch(/x-message-ttl|x-max-length|x-overflow|x-delivery-limit|x-expires/);
    }
    const bindings = ctl('list_bindings', '-p', 'nawara-core', 'source_name', 'destination_name', '--no-table-headers');
    expect(bindings).not.toMatch(new RegExp(`^${DLX.replaceAll('.', '\\.')}\\t${Q.notification.replaceAll('.', '\\.')}\\.dead$`, 'm'));
    expect(ctl('list_policies', '-p', 'nawara-core', '--no-table-headers').trim()).toBe('');
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── Billing (financial, strict)

  describe('Billing: strict financial provenance with a real Payment', () => {
    const producer = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${ports.billing}${path}`, { method, headers: { authorization: `Bearer ${producerToken.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    const payer = async (path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${ports.payment}${path}`, { method: 'POST', headers: { authorization: `Bearer ${PAYER_TOKEN}`, 'content-type': 'application/json', 'idempotency-key': `idem-${randomUUID()}` }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    let seq = 0;
    /** A recurring (subscription) invoice of a fresh organization, its payment request dispatched to the real Payment. */
    const requested = async () => {
      seq += 1;
      const org = randomUUID();
      // Core V2 S3a / S3b: an Organization subscription product declares its target and Platform (the direct activation rule is retired)
      const product = await producer('POST', '/billing/products', { seller: { type: 'organization', id: org }, code: `s1e5-${seq}`, name: `S1e-5 ${seq}`,
        subscriptionTarget: 'organization', platformId: TEST_PLATFORM });
      expect(product.status, JSON.stringify(product.json)).toBe(201);
      const price = await producer('POST', '/billing/prices', { productId: product.json.id, clientReference: `s1e5-ref-${seq}`, currency: 'TND', unitAmount: 5000, interval: 'recurring', intervalUnit: 'month', intervalCount: 1, effectiveFrom: new Date().toISOString() });
      const invoice = await producer('POST', '/billing/invoices', {
        invoiceRequestId: randomUUID(), seller: { type: 'organization', id: org }, payer: { type: 'user', id: PAYER_ID }, sourceType: 'contract', sourceId: `src-${randomUUID()}`,
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.json.id, quantity: 1 }],
      });
      expect(invoice.status, JSON.stringify(invoice.json)).toBe(201);
      expect((await producer('POST', `/billing/invoices/${invoice.json.id}/issue`)).status).toBe(200);
      const created = await producer('POST', `/billing/invoices/${invoice.json.id}/payment-requests`);
      const requestId: string = created.json.id;
      let paymentId = '';
      await waitFor(async () => {
        const r = await producer('GET', `/billing/payment-requests/${requestId}`);
        paymentId = r.json.paymentId;
        return r.json.status === 'requested' && !!paymentId;
      }, 20_000, `request ${requestId} requested`);
      return { org, invoiceId: invoice.json.id as string, requestId, paymentId };
    };
    const settle = async (paymentId: string) => {
      const s = await payer(`/payment/payments/${paymentId}/attempts`, { providerOptions: { scenario: 'success' } });
      expect(s.status, JSON.stringify(s.json)).toBe(201);
      expect((await payer(`/payment/payments/${paymentId}/attempts/${s.json.id}/sync`)).json.status).toBe('succeeded');
    };
    const status = async (requestId: string) => (await q<{ status: string }>('billing', `SELECT status FROM payment_request WHERE id = $1`, [requestId]))[0]!.status;
    const invoiceStatus = async (invoiceId: string) => (await q<{ status: string; paidAt: Date | null }>('billing', `SELECT status, "paidAt" FROM invoice WHERE id = $1`, [invoiceId]))[0]!;
    const receipts = (requestId: string) => q<{ eventId: string; outcome: string; eventName: string }>('billing', `SELECT "eventId", outcome, "eventName" FROM payment_event_receipt WHERE "paymentRequestId" = $1 ORDER BY "receivedAt"`, [requestId]);
    const subscription = async (org: string) => (await q<{ status: string; currentPeriodStart: Date | null }>('billing', `SELECT status, "currentPeriodStart" FROM subscription WHERE "organizationId" = $1`, [org]))[0];
    const outboxEvent = async (paymentId: string, name = 'payment.succeeded') => (await q<{ id: string }>('payment', `SELECT id FROM outbox WHERE name = $1 AND payload->>'paymentId' = $2`, [name, paymentId]))[0]?.id;
    const origin = async (eventId: string) => (await q<{ occurredAt: string; source: string }>('billing', `SELECT "occurredAt", source FROM payment_event_origin WHERE "eventId" = $1`, [eventId]))[0];
    const provenance = (eventId: string) => q<{ producerUserId: string | null; verified: boolean }>('billing', `SELECT "producerUserId", verified FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt", id`, [eventId, Q.billing]);
    const snapshot = async () => JSON.stringify({
      requests: await q('billing', `SELECT id, status, revision FROM payment_request ORDER BY id`),
      invoices: await q('billing', `SELECT id, status, "paidAt" FROM invoice ORDER BY id`),
      receipts: await q('billing', `SELECT id, "eventId", outcome FROM payment_event_receipt ORDER BY id`),
      subscriptions: await q('billing', `SELECT id, status, "currentPeriodStart", "currentPeriodEnd" FROM subscription ORDER BY id`),
      transitions: await q('billing', `SELECT count(*)::int AS n FROM billing_transition`),
    });
    const forgedBody = (r: { requestId: string; paymentId: string; invoiceId: string; org: string }, over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
      paymentId: r.paymentId, producer: 'billing-service', paymentRequestId: r.requestId, sourceType: 'invoice', sourceId: r.invoiceId, payer: { type: 'user', id: PAYER_ID },
      seller: { type: 'organization', id: r.org }, organizationId: r.org, currency: 'TND', revision: 1, amount: 5000, ...over,
    }));
    const paymentHeaders = (id: string, over: Record<string, unknown> = {}) => ({ eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1, ...over });
    let first: Awaited<ReturnType<typeof requested>>;
    let firstEvent: GetMessage;

    it('1, 2, 13: an authenticated Payment original settles once; its verified redelivery and ten concurrent identical copies change nothing', async () => {
      first = await requested();
      await settle(first.paymentId);
      await waitFor(async () => (await status(first.requestId)) === 'paid', 30_000, 'paid');
      const [r] = await receipts(first.requestId);
      expect(r).toMatchObject({ outcome: 'applied', eventName: 'payment.succeeded' });
      firstEvent = await take(r!.eventId);
      expect(firstEvent.properties.userId).toBe('payment-service');
      expect(await provenance(r!.eventId)).toEqual([{ producerUserId: 'payment-service', verified: true }]);
      const o = (await origin(r!.eventId))!;
      expect(o.source).toBe('payment-service');
      expect((await subscription(first.org))!.currentPeriodStart!.getTime()).toBe(new Date(o.occurredAt).getTime()); // anchored on the TRUSTED instant
      const before = await snapshot();
      const copy = { body: firstEvent.content, id: r!.eventId, type: 'payment.succeeded', headers: firstEvent.properties.headers as Record<string, unknown> };
      const results = await Promise.all(Array.from({ length: 10 }, () => raw({ as: 'payment-service', ...copy })));
      expect(results.every((x) => x.refused === undefined)).toBe(true);
      await sleep(4000);
      expect(await snapshot()).toBe(before); // one financial effect: one receipt, one transition set, one subscription period
      expect(await depth(`${Q.billing}.dead`)).toBe(0);
    }, 90_000);

    it('2 (broker redelivery): a delivery in flight when Billing dies is redelivered by the broker and applied exactly once', async () => {
      const r = await requested();
      const lock = new pg.Client({ connectionString: dbs.billing.url });
      await lock.connect();
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE payment_event_receipt IN ACCESS EXCLUSIVE MODE'); // Billing's handler blocks inside the financial step
      let eventId: string | undefined;
      try {
        await settle(r.paymentId);
        await waitFor(async () => !!(eventId = await outboxEvent(r.paymentId)) && !!(await origin(eventId)), 30_000, 'the original to reach the blocked handler');
        await live.billing!.kill(); // unacknowledged: the broker keeps the message
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined);
        await lock.end();
      }
      allText.push(logs('billing'));
      await start('billing');
      await waitFor(async () => (await status(r.requestId)) === 'paid', 30_000, 'paid after redelivery');
      expect((await receipts(r.requestId)).map((x) => x.outcome)).toEqual(['applied']);
      expect(await provenance(eventId!)).toEqual([{ producerUserId: 'payment-service', verified: true }]); // a verified duplicate, no second row
    }, 120_000);

    it('3, 4: a verified REPLAY is settled with the stored trusted metadata: a tampered `occurredAt` header cannot move the settlement instant', async () => {
      const r = await requested();
      // the financial step fails transiently (test-only trigger), so the original is recorded, retried and dead-lettered unapplied
      await q('billing', `CREATE FUNCTION s1e5_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '57P03'; END $$;
        CREATE TRIGGER payment_event_receipt_00_s1e5 BEFORE INSERT ON payment_event_receipt FOR EACH ROW EXECUTE FUNCTION s1e5_receipt_fault()`);
      let dead;
      let eventId = '';
      try {
        await settle(r.paymentId);
        await waitFor(async () => !!(eventId = (await outboxEvent(r.paymentId)) ?? ''), 20_000, 'the outbox row');
        dead = await takeDead(Q.billing, eventId, 90_000);
      } finally {
        await q('billing', `DROP TRIGGER payment_event_receipt_00_s1e5 ON payment_event_receipt; DROP FUNCTION s1e5_receipt_fault()`);
      }
      expect(dead.failure).toBe('retries_exhausted');
      expect(await status(r.requestId)).toBe('requested');
      const o = (await origin(eventId))!;
      const forgedInstant = '2001-01-01T00:00:00.000Z';
      const headers = Object.fromEntries(Object.entries(dead.headers).filter(([k]) => !k.startsWith('x-nawara-') && !k.startsWith('x-death') && !k.startsWith('x-first-death') && !k.startsWith('x-last-death')));
      // an operator replay of that copy, with its settlement header TAMPERED, injected by another identity through the default exchange
      expect((await raw({ as: 'notification-service', queue: Q.billing, body: dead.content, id: eventId, type: 'payment.succeeded', headers: { ...headers, occurredAt: forgedInstant, version: 1 } })).refused).toBeUndefined();
      await waitFor(async () => (await status(r.requestId)) === 'paid', 30_000, 'paid by the verified replay');
      const sub = (await subscription(r.org))!;
      expect(sub.currentPeriodStart!.getTime()).toBe(new Date(o.occurredAt).getTime());
      expect(sub.currentPeriodStart!.toISOString()).not.toBe(forgedInstant);
      expect(new Date(o.occurredAt).getFullYear()).toBeGreaterThan(2020);
    }, 180_000);

    it('5, 6, 7, missing identity: forged Payment events (default exchange, or no `user_id`) are refused before any receipt or state change', async () => {
      const r = await requested();
      const before = await snapshot();
      const fid = randomUUID();
      expect((await raw({ as: 'notification-service', queue: Q.billing, body: forgedBody(r), id: fid, type: 'payment.succeeded', headers: paymentHeaders(fid) })).refused).toBeUndefined();
      expect((await takeDead(Q.billing, fid)).reason).toBe('untrusted_replay_no_provenance');
      const nid = randomUUID();
      await raw({ body: forgedBody(r), id: nid, type: 'payment.succeeded', headers: paymentHeaders(nid) }); // the administrator: no user_id
      expect((await takeDead(Q.billing, nid)).reason).toBe('untrusted_unverified_original');
      // and a BROKER denial, which is not a consumer refusal: Auth may not publish a Payment event at all
      expect((await raw({ as: 'auth-service', body: forgedBody(r), id: randomUUID(), type: 'payment.succeeded', headers: paymentHeaders(randomUUID()) })).refused).toBe('broker_403');
      expect(await snapshot()).toBe(before);
      expect(await status(r.requestId)).toBe('requested');
      expect((await invoiceStatus(r.invoiceId)).status).not.toBe('paid');
      expect(await subscription(r.org)).toBeUndefined();
    }, 90_000);

    it('8: an earlier UNVERIFIED observation of the genuine id does not block the later authentic Payment publication', async () => {
      const r = await requested();
      await proxy.sever(); // Payment commits its event but cannot relay it yet
      let eventId = '';
      try {
        await settle(r.paymentId);
        await waitFor(async () => !!(eventId = (await outboxEvent(r.paymentId)) ?? ''), 20_000, 'the genuine event id in Payment\'s outbox');
        await raw({ body: forgedBody(r, { amount: 1 }), id: eventId, type: 'payment.succeeded', headers: paymentHeaders(eventId) }); // forged first, no user_id
        expect((await takeDead(Q.billing, eventId)).reason).toBe('untrusted_unverified_original');
        expect(await receipts(r.requestId)).toEqual([]); // no first-writer receipt
      } finally {
        await proxy.start();
      }
      await waitFor(async () => (await status(r.requestId)) === 'paid', 60_000, 'the genuine event after the forged-first one');
      expect((await receipts(r.requestId)).map((x) => [x.eventId, x.outcome])).toEqual([[eventId, 'applied']]);
      expect(await provenance(eventId)).toEqual([{ producerUserId: null, verified: false }, { producerUserId: 'payment-service', verified: true }]);
    }, 120_000);

    it('9, 14: contradictory verified evidence is refused; a well-formed but terminal-violating Payment event leaves the paid state intact', async () => {
      const before = await snapshot();
      const id = String(firstEvent.properties.messageId);
      const altered = Buffer.from(JSON.stringify({ ...JSON.parse(firstEvent.content.toString('utf8')), amount: 1 }));
      await raw({ as: 'payment-service', body: altered, id, type: 'payment.succeeded', headers: firstEvent.properties.headers as Record<string, unknown> });
      expect((await takeDead(Q.billing, id)).reason).toBe('untrusted_verified_conflict');
      expect(await snapshot()).toBe(before);
      const failedId = randomUUID();
      await raw({ as: 'payment-service', body: forgedBody(first, { revision: 2 }), id: failedId, type: 'payment.failed', routingKey: 'payment.failed', headers: paymentHeaders(failedId) });
      await waitFor(async () => (await receipts(first.requestId)).length === 2 || (await depth(`${Q.billing}.dead`)) > 0, 20_000, 'the terminal-violating event to be decided');
      expect(await status(first.requestId)).toBe('paid');
      expect((await invoiceStatus(first.invoiceId)).status).toBe('paid');
      expect((await receipts(first.requestId)).filter((x) => x.outcome === 'applied')).toHaveLength(1);
      while (await ch.get(`${Q.billing}.dead`, { noAck: true })); // whichever way Billing refused it, nothing was applied
    }, 60_000);

    it('10: a verified replay whose trusted original metadata is unavailable (a pre-0018 record) is refused, never invented', async () => {
      const id = String(firstEvent.properties.messageId);
      // test-only database preparation: the record an event committed before migration 0018 would not have
      await q('billing', `ALTER TABLE payment_event_origin DISABLE TRIGGER USER; DELETE FROM payment_event_origin WHERE "eventId" = $1; ALTER TABLE payment_event_origin ENABLE TRIGGER USER`.replace('$1', `'${id}'`));
      const before = await snapshot();
      await raw({ as: 'notification-service', queue: Q.billing, body: firstEvent.content, id, type: 'payment.succeeded', headers: firstEvent.properties.headers as Record<string, unknown> });
      expect((await takeDead(Q.billing, id)).reason).toBe('untrusted_origin_unavailable');
      expect(await snapshot()).toBe(before);
    }, 60_000);

    it('11, 12: the provenance store unavailable holds the delivery (never processed, never dead-lettered); recovered, it settles once', async () => {
      const r = await requested();
      const name = new URL(dbs.billing.url).pathname.slice(1);
      const adminDb = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
      await adminDb.connect();
      try {
        await adminDb.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
        await adminDb.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'billing-service'`, [name]);
        await settle(r.paymentId);
        await waitFor(() => /event_trust_held [^\n]*basis=provenance_unavailable/.test(logs('billing')), 30_000, 'Billing to hold the delivery');
        expect(await depth(`${Q.billing}.dead`)).toBe(0);
      } finally {
        await adminDb.query(`ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS true`);
        await adminDb.end();
      }
      await waitFor(async () => (await status(r.requestId)) === 'paid', 60_000, 'settled after recovery');
      expect((await receipts(r.requestId)).map((x) => x.outcome)).toEqual(['applied']);
    }, 120_000);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── Audit (compatibility, then strict)

  describe('Audit: privacy admission first; the compatibility phase, then strict', () => {
    const audit = (variant: 'complete' | 'minimal' = 'complete', over: Partial<EventEnvelope> = {}): EventEnvelope => {
      const id = over.id ?? randomUUID();
      return { id, name: 'audit.payment.succeeded', payload: JSON.parse(JSON.stringify(sampleAuditPayload('payment.succeeded', variant))), headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1, correlationId: `corr-${id.slice(0, 8)}` }, ...over };
    };
    const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));
    const records = (id: string) => q<Record<string, unknown>>('audit', `SELECT * FROM audit_record WHERE "eventId" = $1`, [id]);
    const provenance = (id: string) => q<{ producerUserId: string | null; verified: boolean }>('audit', `SELECT "producerUserId", verified FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt", id`, [id, Q.audit]);
    const digestStored = async (d: string) => (await q('audit', `SELECT 1 FROM event_provenance WHERE "bodySha256" = $1 UNION ALL SELECT 1 FROM event_provenance_conflict WHERE "bodySha256" = $1`, [d])).length > 0;
    const legacy: string[] = [];
    let verifiedId = '';

    it('compatibility: an approved legacy delivery (no user_id) is ingested and recorded UNVERIFIED; a verified one VERIFIED; both counted apart', async () => {
      const l = audit();
      await raw({ body: bytes(l), id: l.id, type: l.name, headers: l.headers });
      await waitFor(async () => (await records(l.id)).length === 1, 20_000, 'the legacy record');
      expect(await provenance(l.id)).toEqual([{ producerUserId: null, verified: false }]);
      legacy.push(l.id);
      const v = audit();
      await asIdentity('payment-service').publish(v);
      await waitFor(async () => (await records(v.id)).length === 1, 20_000, 'the verified record');
      expect(await provenance(v.id)).toEqual([{ producerUserId: 'payment-service', verified: true }]);
      verifiedId = v.id;
      const m = await metrics('audit');
      expect(trustCount(m, Q.audit, 'compatibility', 'unverified_original')).toBeGreaterThanOrEqual(1);
      expect(trustCount(m, Q.audit, 'accept', 'verified_original')).toBeGreaterThanOrEqual(1);
    });

    it('compatibility: contradictory verified evidence is NOT accepted; inadmissible content fails admission before any provenance', async () => {
      const changed = audit('minimal', { id: verifiedId });
      changed.headers = { ...changed.headers, eventId: verifiedId };
      const before = await records(verifiedId);
      await asIdentity('payment-service').publish(changed);
      expect((await takeDead(Q.audit, verifiedId)).reason).toBe('untrusted_verified_conflict');
      expect(await records(verifiedId)).toEqual(before);
      const s = audit();
      s.payload = { ...s.payload, phone: '+21620005173' };
      await asIdentity('payment-service').publish(s); // from the VERIFIED owner: admission still comes first
      const dead = await takeDead(Q.audit, s.id);
      expect(dead).toMatchObject({ reason: 'sensitive_field', redacted: true });
      expect(dead.content.toString('latin1')).not.toContain('+21620005173');
      expect(await provenance(s.id)).toEqual([]);
      expect(await digestStored(sha(bytes(s)))).toBe(false);
      expect(await records(s.id)).toEqual([]);
    });

    it('compatibility RESIDUALS (documented, not hardened): a default-exchange injection with no provenance is ingested, and an unverified first writer keeps the slot', async () => {
      const inj = audit();
      await raw({ as: 'notification-service', queue: Q.audit, body: bytes(inj), id: inj.id, type: inj.name, headers: inj.headers });
      await waitFor(async () => (await records(inj.id)).length === 1, 20_000, 'the injected record (compatibility accepts replay_no_provenance)');
      expect(await provenance(inj.id)).toEqual([]);
      legacy.push(inj.id);
      const genuine = audit();
      const forged: EventEnvelope = { ...genuine, payload: { ...genuine.payload, organizationId: randomUUID() } };
      await raw({ body: bytes(forged), id: genuine.id, type: genuine.name, headers: genuine.headers });
      await waitFor(async () => (await records(genuine.id)).length === 1, 20_000, 'the forged-first record');
      await asIdentity('payment-service').publish(genuine);
      expect((await takeDead(Q.audit, genuine.id)).reason).toBe('event_id_conflict'); // the genuine event loses the slot in compatibility
      expect((await records(genuine.id))[0]!.organizationId).toBe(forged.payload.organizationId);
      legacy.push(genuine.id);
      expect(trustCount(await metrics('audit'), Q.audit, 'compatibility', 'replay_no_provenance')).toBeGreaterThanOrEqual(1);
    });

    describe('strict (explicitly selected, the same database)', () => {
      let historical: string;
      beforeAll(async () => {
        historical = JSON.stringify(await q('audit', `SELECT id, "eventId", "producerUserId", verified, reason, "bodySha256" FROM event_provenance ORDER BY id`));
        await stop('audit');
        envs.audit = { ...envs.audit, AUDIT_PROVENANCE_ENFORCEMENT: 'strict' };
        await start('audit');
      }, 90_000);

      it('starts strict; nothing historical was promoted or rewritten', async () => {
        expect(logs('audit')).toMatch(/enforcement=strict/);
        const now = JSON.parse(JSON.stringify(await q('audit', `SELECT id, "eventId", "producerUserId", verified, reason, "bodySha256" FROM event_provenance ORDER BY id`))) as Array<{ id: string }>;
        const old = JSON.parse(historical) as Array<{ id: string }>;
        expect(now.slice(0, old.length)).toEqual(old);
        for (const id of legacy) for (const p of await provenance(id)) expect(p.verified).toBe(p.producerUserId === 'payment-service');
      });

      it('verified original accepted; its verified duplicate and a matching verified replay are idempotent', async () => {
        const v = audit();
        await asIdentity('payment-service').publish(v);
        await waitFor(async () => (await records(v.id)).length === 1, 20_000, 'record');
        await asIdentity('payment-service').publish(v);
        await raw({ as: 'notification-service', queue: Q.audit, body: bytes(v), id: v.id, type: v.name, headers: v.headers });
        await sleep(3000);
        expect(await records(v.id)).toHaveLength(1);
        expect(await depth(`${Q.audit}.dead`)).toBe(0);
        verifiedId = v.id;
      });

      it('unverified original, default-exchange injection and contradiction are refused before ingestion', async () => {
        const u = audit();
        await raw({ body: bytes(u), id: u.id, type: u.name, headers: u.headers });
        expect((await takeDead(Q.audit, u.id)).reason).toBe('untrusted_unverified_original');
        const i = audit();
        await raw({ as: 'notification-service', queue: Q.audit, body: bytes(i), id: i.id, type: i.name, headers: i.headers });
        expect((await takeDead(Q.audit, i.id)).reason).toBe('untrusted_replay_no_provenance');
        const c = audit('minimal', { id: verifiedId });
        c.headers = { ...c.headers, eventId: verifiedId };
        await asIdentity('payment-service').publish(c);
        expect((await takeDead(Q.audit, verifiedId)).reason).toBe('untrusted_verified_conflict');
        expect(await records(u.id)).toEqual([]);
        expect(await records(i.id)).toEqual([]);
      });

      it('a forged first writer claims nothing; the later genuine event is recorded with its own content', async () => {
        const genuine = audit();
        const forged: EventEnvelope = { ...genuine, payload: { ...genuine.payload, organizationId: randomUUID() } };
        await raw({ body: bytes(forged), id: genuine.id, type: genuine.name, headers: genuine.headers });
        expect((await takeDead(Q.audit, genuine.id)).reason).toBe('untrusted_unverified_original');
        expect(await records(genuine.id)).toEqual([]);
        await asIdentity('payment-service').publish(genuine);
        await waitFor(async () => (await records(genuine.id)).length === 1, 20_000, 'the genuine record');
        expect((await records(genuine.id))[0]!.organizationId).toBe(genuine.payload.organizationId);
        expect(await provenance(genuine.id)).toEqual([{ producerUserId: null, verified: false }, { producerUserId: 'payment-service', verified: true }]);
      });

      it('a provenance lookup that cannot complete is held and requeued, then accepted; nothing is dead-lettered', async () => {
        const v = audit();
        await asIdentity('payment-service').publish(v);
        await waitFor(async () => (await records(v.id)).length === 1, 20_000, 'record');
        const lock = new pg.Client({ connectionString: dbs.audit.url });
        await lock.connect();
        try {
          await lock.query('BEGIN');
          await lock.query('LOCK TABLE event_provenance IN ACCESS EXCLUSIVE MODE');
          await raw({ as: 'notification-service', queue: Q.audit, body: bytes(v), id: v.id, type: v.name, headers: v.headers });
          await waitFor(() => new RegExp(`event_trust_held queue=audit-service\\.audit event=${v.id} basis=provenance_unavailable`).test(logs('audit')), 30_000, 'the hold');
          expect(await depth(`${Q.audit}.dead`)).toBe(0);
        } finally {
          await lock.query('ROLLBACK').catch(() => undefined);
          await lock.end();
        }
        await waitFor(() => logs('audit').includes(`audit_event_duplicate eventId=${v.id}`), 30_000, 'accepted after the hold');
        expect(await records(v.id)).toHaveLength(1);
      }, 90_000);

      it('inadmissible content still fails admission first, redacted, with no provenance and no digest', async () => {
        const s = audit();
        s.payload = { ...s.payload, phone: '+21620005174' };
        await asIdentity('payment-service').publish(s);
        const dead = await takeDead(Q.audit, s.id);
        expect(dead).toMatchObject({ reason: 'sensitive_field', redacted: true });
        expect(await provenance(s.id)).toEqual([]);
        expect(await digestStored(sha(bytes(s)))).toBe(false);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── Notification (strict, keyed)

  describe('Notification: strict keyed provenance and code-bearing dead letters', () => {
    const bytes = (e: EventEnvelope) => Buffer.from(JSON.stringify(e.payload));
    const intents = async (id: string) => (await q<{ n: number }>('notification', `SELECT count(*)::int AS n FROM notification WHERE "sourceEventId" = $1`, [id]))[0]!.n;
    const provenance = (id: string) => q<{ producerUserId: string | null; verified: boolean; bodyMacKeyId: string; bodyMac: string }>('notification', `SELECT "producerUserId", verified, "bodyMacKeyId", "bodyMac" FROM event_provenance WHERE "eventId" = $1 ORDER BY "firstSeenAt", id`, [id]);
    /** A redacted dead letter: the kit document only; no code, destination or recipient in its bytes or headers. */
    const sanitized = (d: Awaited<ReturnType<typeof takeDead>>, original: Buffer) => {
      expect(d.redacted).toBe(true);
      expect(JSON.parse(d.content.toString('utf8'))).toEqual({ redacted: true, failure: d.failure, reason: d.reason, bodyBytes: original.length });
      const text = `${d.content.toString('latin1')} ${JSON.stringify(d.headers)}`;
      for (const s of [CODE, EMAIL]) expect(text).not.toContain(s);
    };
    const restart = async (over: NodeJS.ProcessEnv) => {
      await stop('notification');
      envs.notification = { ...envs.notification, ...over };
      await start('notification');
    };
    let e1: EventEnvelope;

    it('1, 13: an authenticated Auth original is taken once, committed as an HMAC under the active key (never an unkeyed digest)', async () => {
      e1 = code();
      await asIdentity('auth-service').publish(e1);
      await waitFor(async () => (await intents(e1.id)) === 1, 30_000, 'the intent');
      const [p] = await provenance(e1.id);
      expect(p).toMatchObject({ producerUserId: 'auth-service', verified: true, bodyMacKeyId: 'p1' });
      expect(p!.bodyMac).toBe(bodyMac(P1, bytes(e1)));
      expect(p!.bodyMac).not.toBe(sha(bytes(e1)));
      const dump = JSON.stringify(await q('notification', `SELECT * FROM event_provenance`)) + JSON.stringify(await q('notification', `SELECT * FROM event_provenance_conflict`));
      expect(dump).not.toContain(sha(bytes(e1)));
      expect(dump).not.toContain(CODE);
      const [n] = await q<{ expiresAt: Date; sealed: boolean }>('notification', `SELECT "expiresAt", "secretCiphertext" IS NOT NULL AS sealed FROM notification WHERE "sourceEventId" = $1`, [e1.id]);
      expect(n).toEqual({ expiresAt: new Date(String(e1.payload.expiresAt)), sealed: true }); // the code's expiry boundary is kept, the code sealed
      expect(JSON.stringify(await q('notification', `SELECT data FROM notification WHERE "sourceEventId" = $1`, [e1.id]))).not.toContain(CODE);
    });

    it('2, 3: its verified duplicate and a matching verified replay are idempotent', async () => {
      await asIdentity('auth-service').publish(e1);
      await raw({ as: 'audit-service', queue: Q.notification, body: bytes(e1), id: e1.id, type: e1.name, headers: e1.headers });
      await waitFor(() => (logs('notification').match(new RegExp(`notification_duplicate[^\\n]*${e1.id}`, 'g')) ?? []).length >= 2, 30_000, 'two duplicates');
      expect(await intents(e1.id)).toBe(1);
    });

    it('4, 9, 8, 10: injection with no original, a mismatched body and a verified contradiction are refused, each dead letter sanitized', async () => {
      const inj = code();
      await raw({ as: 'audit-service', queue: Q.notification, body: bytes(inj), id: inj.id, type: inj.name, headers: inj.headers });
      const d1 = await takeDead(Q.notification, inj.id);
      expect(d1.reason).toBe('untrusted_replay_no_provenance');
      sanitized(d1, bytes(inj));
      const mismatch = code({ ...e1.payload, code: '000611' }, e1.id);
      await raw({ as: 'audit-service', queue: Q.notification, body: bytes(mismatch), id: e1.id, type: e1.name, headers: e1.headers });
      const d2 = await takeDead(Q.notification, e1.id);
      expect(d2.reason).toBe('untrusted_replay_mismatch');
      sanitized(d2, bytes(mismatch));
      expect(d2.content.toString('latin1')).not.toContain('000611');
      const contradiction = code({ ...e1.payload, code: '000612' }, e1.id);
      await asIdentity('auth-service').publish(contradiction);
      const d3 = await takeDead(Q.notification, e1.id);
      expect(d3.reason).toBe('untrusted_verified_conflict');
      sanitized(d3, bytes(contradiction));
      expect(await intents(inj.id)).toBe(0);
      expect(await intents(e1.id)).toBe(1);
      // each refusal is counted by its closed kind (process counters: asserted before any restart of this process)
      const m = await metrics('notification');
      for (const kind of ['replay_no_provenance', 'replay_mismatch', 'verified_conflict']) expect(trustCount(m, Q.notification, 'refuse', kind), kind).toBeGreaterThanOrEqual(1);
      expect(trustCount(m, Q.notification, 'accept', 'verified_replay')).toBeGreaterThanOrEqual(1);
      for (const secret of [CODE, '000611', '000612', EMAIL]) expect(m).not.toContain(secret);
    });

    it('6, 7: a forged first writer claims no intake identity; the legitimate Auth original afterwards is taken with its own content', async () => {
      const genuine = code();
      const forged = code({ userId: 'attacker', destination: 'attacker@example.test' }, genuine.id);
      await raw({ body: bytes(forged), id: genuine.id, type: genuine.name, headers: genuine.headers });
      const d = await takeDead(Q.notification, genuine.id);
      expect(d.reason).toBe('untrusted_unverified_original');
      sanitized(d, bytes(forged));
      expect(await intents(genuine.id)).toBe(0);
      await asIdentity('auth-service').publish(genuine);
      await waitFor(async () => (await intents(genuine.id)) === 1, 30_000, 'the genuine intent');
      expect((await q<{ recipientId: string }>('notification', `SELECT "recipientId" FROM notification WHERE "sourceEventId" = $1`, [genuine.id]))[0]!.recipientId).toBe(genuine.payload.userId);
      expect((await provenance(genuine.id)).map((p) => [p.producerUserId, p.verified])).toEqual([[null, false], ['auth-service', true]]);
    });

    it('14: a provenance lookup that cannot complete is held (never refused, never processed), then succeeds', async () => {
      const lock = new pg.Client({ connectionString: dbs.notification.url });
      await lock.connect();
      const deadBefore = await depth(`${Q.notification}.dead`);
      try {
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE event_provenance IN ACCESS EXCLUSIVE MODE');
        await raw({ as: 'audit-service', queue: Q.notification, body: bytes(e1), id: e1.id, type: e1.name, headers: e1.headers });
        await waitFor(() => new RegExp(`event_trust_held queue=notification\\.events event=${e1.id} basis=provenance_unavailable`).test(logs('notification')), 30_000, 'the hold');
        expect(await depth(`${Q.notification}.dead`)).toBe(deadBefore);
      } finally {
        await lock.query('ROLLBACK').catch(() => undefined);
        await lock.end();
      }
      await waitFor(() => (logs('notification').match(new RegExp(`notification_duplicate[^\\n]*${e1.id}`, 'g')) ?? []).length >= 3, 30_000, 'accepted after the hold');
      expect(await intents(e1.id)).toBe(1);
      expect(trustCount(await metrics('notification'), Q.notification, 'hold', 'provenance_unavailable')).toBeGreaterThanOrEqual(1);
    }, 90_000);

    it('11, 12: an UNAVAILABLE key is a hold (no dead letter); a RETIRED key a permanent, sanitized refusal; restored, the original is a duplicate', async () => {
      await restart({ NOTIFICATION_PROVENANCE_KEYS: `p2:${P2.toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p2', NOTIFICATION_PROVENANCE_RETIRED_KEY_IDS: '' });
      const deadBefore = await depth(`${Q.notification}.dead`);
      await asIdentity('auth-service').publish(e1);
      await waitFor(() => new RegExp(`event_trust_held queue=notification\\.events event=${e1.id} basis=provenance_unavailable`).test(logs('notification')), 30_000, 'held under an unavailable key');
      expect(await depth(`${Q.notification}.dead`)).toBe(deadBefore);
      await restart({ NOTIFICATION_PROVENANCE_RETIRED_KEY_IDS: 'p1' });
      const d = await takeDead(Q.notification, e1.id, 40_000); // the held delivery itself, now decided under a retired key
      expect(d.reason).toBe('untrusted_verified_unverifiable');
      sanitized(d, bytes(e1));
      await raw({ as: 'audit-service', queue: Q.notification, body: bytes(e1), id: e1.id, type: e1.name, headers: e1.headers });
      const r = await takeDead(Q.notification, e1.id);
      expect(r.reason).toBe('untrusted_replay_unverifiable');
      sanitized(r, bytes(e1));
      await restart({ NOTIFICATION_PROVENANCE_KEYS: `p1:${P1.toString('base64')}`, NOTIFICATION_PROVENANCE_ACTIVE_KEY_ID: 'p1', NOTIFICATION_PROVENANCE_RETIRED_KEY_IDS: '' });
      await asIdentity('auth-service').publish(e1);
      await waitFor(() => logs('notification').includes('notification_duplicate'), 30_000, 'a duplicate under the restored key');
      expect(await intents(e1.id)).toBe(1);
    }, 180_000);

    it('a genuine Auth publication carries no expiry (the broker could not expire it into the dead letters)', async () => {
      const e = code();
      await asIdentity('auth-service').publish(e);
      const m = await take(e.id);
      expect(m.properties.userId).toBe('auth-service');
      expect(m.properties.expiration).toBeUndefined();
      await waitFor(async () => (await intents(e.id)) === 1, 30_000, 'intent');
    });
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── cross-consumer attacks (S1d-3, enforced)

  describe('cross-consumer: the S1d-3 residuals against the enforced consumers', () => {
    it('default exchange: one injector reaches every work queue; no strict consumer processes anything', async () => {
      const pay = { id: randomUUID(), body: Buffer.from(JSON.stringify({ paymentId: randomUUID(), paymentRequestId: randomUUID(), synthetic: true })) };
      const aud = { id: randomUUID() };
      const note = { id: randomUUID() };
      const audPayload = Buffer.from(JSON.stringify(sampleAuditPayload('payment.succeeded', 'complete')));
      const notePayload = Buffer.from(JSON.stringify({ userId: 'u-x', channel: 'email', destination: EMAIL, code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() }));
      for (const [queue, m, type, body] of [[Q.billing, pay, 'payment.succeeded', pay.body], [Q.audit, aud, 'audit.payment.succeeded', audPayload], [Q.notification, note, 'admin.operator_code_issued', notePayload]] as const) {
        expect((await raw({ as: 'notification-service', queue, body, id: m.id, type, headers: { eventId: m.id, occurredAt: new Date().toISOString(), source: type.startsWith('admin.') ? 'auth-service' : 'payment-service', version: 1 } })).refused).toBeUndefined();
      }
      expect((await takeDead(Q.billing, pay.id)).reason).toBe('untrusted_replay_no_provenance');
      expect((await takeDead(Q.audit, aud.id)).reason).toBe('untrusted_replay_no_provenance'); // Audit is strict by now
      const n = await takeDead(Q.notification, note.id);
      expect(n.reason).toBe('untrusted_replay_no_provenance');
      expect(n.content.toString('latin1')).not.toContain(CODE);
      expect(await q('billing', `SELECT 1 FROM payment_event_receipt WHERE "eventId" = $1`, [pay.id])).toEqual([]);
      expect(await q('audit', `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [aud.id])).toEqual([]);
      expect(await q('notification', `SELECT 1 FROM notification WHERE "sourceEventId" = $1`, [note.id])).toEqual([]);
    });

    it('shared DLX (residual until OD-BRK-3/4/5): a forged message reaches Billing\'s and Audit\'s dead letters, NEVER Notification\'s; Notification cannot write the fanout (item 10); replay is refused', async () => {
      const id = randomUUID();
      const body = Buffer.from(JSON.stringify(sampleAuditPayload('payment.succeeded', 'complete')));
      expect((await raw({ as: 'audit-service', exchange: DLX, routingKey: '', body, id, type: 'audit.payment.succeeded', headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } })).refused).toBeUndefined();
      for (const queue of [Q.billing, Q.audit]) await waitFor(async () => (await depth(`${queue}.dead`)) >= 1, 20_000, `${queue}.dead`);
      await sleep(2000);
      expect(await depth(`${Q.notification}.dead`)).toBe(0); // OD-BRK-0 item 2: no fanout binding
      // OD-BRK-0 item 10: the isolated Notification identity has no write on the shared dead-letter exchange
      const nid = randomUUID();
      expect((await raw({ as: 'notification-service', exchange: DLX, routingKey: '', body, id: nid, type: 'audit.payment.succeeded', headers: { eventId: nid } })).refused).toBe('broker_403');
      // only Audit binds this name; an operator replaying the injected copy (the kit tool) sends it through Audit's strict consumer
      expect((await replayDeadLetter(admin, `${Q.audit}.dead`, id, { waitMs: 8_000 })).outcome).toBe('rejected_again');
      expect((await takeDead(Q.audit, id)).reason).toBe('untrusted_replay_no_provenance');
      for (const queue of [Q.billing]) {
        expect((await replayDeadLetter(admin, `${queue}.dead`, id, { waitMs: 8_000 })).outcome).toBe('rejected_again');
        const d = await takeDead(queue, id);
        expect(d.reason).toMatch(/^untrusted_/);
      }
      expect(await q('audit', `SELECT 1 FROM audit_record WHERE "eventId" = $1`, [id])).toEqual([]);
      expect(await q('billing', `SELECT 1 FROM payment_event_receipt WHERE "eventId" = $1`, [id])).toEqual([]);
      expect(await q('notification', `SELECT 1 FROM notification WHERE "sourceEventId" = $1`, [id])).toEqual([]);
    }, 90_000);

    it('OD-BRK-0 items 4, 5: broker-driven dead-lettering of a code-bearing body (expiry, and a rejection without requeue) retains NO plaintext code in any dead-letter queue', async () => {
      /** Every message currently in `queue`, read and then returned to it (non-destructive). */
      const peekAll = async (queue: string) => {
        const pc = await admin.createChannel();
        const seen: GetMessage[] = [];
        try {
          for (let m = await pc.get(queue, { noAck: false }); m; m = await pc.get(queue, { noAck: false })) seen.push(m);
          return seen.map((m) => m.content.toString('latin1'));
        } finally {
          await pc.close().catch(() => undefined); // closing the channel requeues every unacknowledged message
        }
      };
      const deadQueues = Object.values(Q).map((q) => `${q}.dead`);
      await stop('notification'); // nothing consumes notification.events for a moment
      try {
        // (a) EXPIRY: only a message's own publisher can set one (here the administrator, synthetic code)
        const exp = randomUUID();
        await raw({ body: Buffer.from(JSON.stringify({ userId: 'u-exp', channel: 'email', destination: EMAIL, code: '000801', expiresAt: new Date(Date.now() + 600_000).toISOString(), timestamp: new Date().toISOString() })), id: exp, type: 'admin.operator_code_issued', queue: Q.notification, headers: { eventId: exp }, expiration: '500' });
        await sleep(3000);
        // (b) REJECTION without requeue by a reader of the queue: a genuine (authenticated) synthetic code event
        const gen = code({ code: '000802' });
        await asIdentity('auth-service').publish(gen);
        let m: GetMessage | false = false;
        await waitFor(async () => !!(m = await ch.get(Q.notification, { noAck: false })) && (m as GetMessage).properties.messageId === gen.id, 20_000, 'the genuine message in the work queue');
        ch.reject(m as unknown as GetMessage, false);
        await sleep(3000);
        // the stored bytes of every dead-letter queue are inspected for the synthetic codes: none survives anywhere
        for (const queue of deadQueues) {
          const stored = await peekAll(queue);
          expect(stored.some((b) => b.includes('000801')), `${queue}: expired code`).toBe(false);
          expect(stored.some((b) => b.includes('000802')), `${queue}: rejected code`).toBe(false);
        }
        expect(await depth(`${Q.notification}.dead`)).toBe(0);
      } finally {
        await start('notification');
      }
    }, 120_000);
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── observability

  describe('observability: bounded, distinguishable, secret-free', () => {
    it('trust outcomes, refusal reasons, holds and dead letters are counted by closed labels; no code, destination or id in any exposition', async () => {
      const b = await metrics('billing');
      const a = await metrics('audit');
      const n = await metrics('notification');
      expect(trustCount(b, Q.billing, 'accept', 'verified_original')).toBeGreaterThanOrEqual(1);
      expect(trustCount(b, Q.billing, 'refuse', 'replay_no_provenance')).toBeGreaterThanOrEqual(1);
      expect(trustCount(b, Q.billing, 'refuse', 'verified_conflict')).toBeGreaterThanOrEqual(1);
      expect(trustCount(b, Q.billing, 'refuse', 'unverified_original')).toBeGreaterThanOrEqual(1);
      expect(trustCount(a, Q.audit, 'hold', 'provenance_unavailable')).toBeGreaterThanOrEqual(1);
      expect(trustCount(a, Q.audit, 'refuse', 'unverified_original')).toBeGreaterThanOrEqual(1);
      // Notification's counters were asserted where they arose (its process restarts later in the suite); here: bounded and secret-free
      expect(n).toMatch(/^# TYPE nawara_event_trust_total counter/m);
      // dead letters are counted where they occurred since the process last started (Billing; Audit's strict run)
      for (const text of [b, a]) expect(text).toMatch(/^nawara_events_consumed_total\{[^}]*outcome="dead_lettered_permanent"/m);
      for (const text of [b, a, n]) {
        for (const s of [CODE, EMAIL, '000611', '000612', PAYER_ID]) expect(text).not.toContain(s);
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      }
    });

    it('a verified contradiction leaves security evidence: the trust refusal notice and the stored conflict evidence (the observe-only conflict notice is not emitted)', async () => {
      const conflicts = await q<{ n: number }>('billing', `SELECT count(*)::int AS n FROM event_provenance_conflict WHERE verified`);
      expect(conflicts[0]!.n).toBeGreaterThanOrEqual(1);
      const text = allText.join('\n') + logs('billing') + logs('audit') + logs('notification');
      expect(text).toMatch(/event_trust_refused queue=billing\.payment-events event=[0-9a-f-]{36} basis=verified_conflict/);
      expect(text).not.toMatch(/event_provenance_conflict queue=billing\.payment-events/);
    });

    it('no service log, notice or dead-letter diagnostic of the suite carries a synthetic code or a broker secret (outside the two broker-driven demonstrations)', () => {
      const text = [allText.join('\n'), logs('billing'), logs('payment'), logs('audit'), logs('notification')].join('\n');
      for (const s of [CODE, '000611', '000612']) expect(text).not.toContain(s);
      for (const svc of ['auth-service', 'payment-service', 'billing-service', 'audit-service', 'notification-service']) {
        const secret = readFileSync(`${env.S1E5_BROKER_DIR}/clients/${svc}.env`, 'utf8').match(/:([0-9a-f]{64})@/)![1]!;
        expect(text).not.toContain(secret);
      }
    });
  });
});
