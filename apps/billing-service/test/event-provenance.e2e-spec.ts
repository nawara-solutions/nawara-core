import { randomBytes } from 'node:crypto';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DbService, PgProvenanceStore, RabbitMqEventBus, generateServiceToken, kitMigrationsDir, runMigrations, type EventBus, type EventBusObservation, type EventEnvelope,
  type EventSubscription, type ProvenanceObservation,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { deterministicEventId } from '../src/common/deterministic-id.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import type { PaymentEventFacts } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import { PaymentEventOriginRepository } from '../src/payment-integration/payment-event-origin.js';
import { PaymentEventConsumer } from '../src/payment-integration/payment-event-consumer.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * Core V2 S1b (ADR-0057 §13.2, §13.3; observe-only) for Billing, over a REAL RabbitMQ and a REAL PostgreSQL (migration 0017): the real
 * `PaymentEventConsumer` (its catalog owner resolver and its `PgProvenanceStore`) behind a kit bus authenticated on a disposable broker.
 * The genuine producer publishes as a disposable broker user named `payment-service` (the catalog owner; refused if such a user already
 * exists on the broker, never overwritten), an intruder as another disposable user. Only the consumer's QUEUE name is replaced (a unique
 * one), so a developer's `billing.payment-events` is never touched. Financial outcomes are asserted to be exactly those of A3M (G11).
 */
const ORG = '00000000-0000-4000-8000-0000000000e5';
const PRODUCER = 'test-producer';
const producer: Caller = { kind: 'service', service: PRODUCER };
const ctx: TransitionContext = { actor: { type: 'service', id: PRODUCER }, cause: { type: 'request', id: 'req-s1b' }, correlationId: 'corr-s1b' };
const hex = (n: number) => randomBytes(n).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error('condition not met in time');
};

class FakePaymentClient implements PaymentClient {
  private readonly creates = new Map<string, CreatePaymentOutcome>();
  whenCreate(requestId: string, outcome: CreatePaymentOutcome): void {
    this.creates.set(requestId, outcome);
  }
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    return this.creates.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}

describeWithEnv('S1b event provenance in Billing (real RabbitMQ, real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  const run = hex(4);
  const OWNER = 'payment-service';
  const INTRUDER = `s1b${run}-intruder`;
  const passwords: Record<string, string> = { [OWNER]: hex(24), [INTRUDER]: hex(24) };
  const exchange = `nawara.events.s1b${run}`;
  const queues: string[] = [];
  const mgmt = new URL(env.TEST_RABBITMQ_MGMT_URL);
  const mgmtAuth = `Basic ${Buffer.from(`${decodeURIComponent(mgmt.username)}:${decodeURIComponent(mgmt.password)}`).toString('base64')}`;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${mgmt.origin}/api${path}`, { method, headers: { authorization: mgmtAuth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const urlFor = (user: string) => {
    const u = new URL(env.TEST_RABBITMQ_URL);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(passwords[user]);
    return u.toString();
  };
  const created: string[] = [];
  const buses: RabbitMqEventBus[] = [];
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let broker: ChannelModel;
  let invoices: InvoiceRepository;
  let requests: PaymentRequestRepository;
  let dispatcher: PaymentDispatcher;
  let owner: RabbitMqEventBus;
  let intruder: RabbitMqEventBus;
  const payment = new FakePaymentClient();

  beforeAll(async () => {
    // the catalog owner's broker user: created for this file only, never an existing one overwritten
    const existing = await api('GET', `/users/${OWNER}`);
    if (existing.status !== 404) throw new Error(`a broker user named ${OWNER} already exists on TEST_RABBITMQ_URL's broker; refusing to overwrite it`);
    const x = `^${exchange.replace(/\./g, '\\.')}$`;
    for (const user of [OWNER, INTRUDER]) {
      const r = await api('PUT', `/users/${encodeURIComponent(user)}`, { password: passwords[user], tags: '' });
      if (!r.ok) throw new Error(`management API: ${r.status}`);
      created.push(user);
      await api('PUT', `/permissions/%2F/${encodeURIComponent(user)}`, { configure: x, write: x, read: '^$' });
    }
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings1b');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: PRODUCER, digest: generateServiceToken().digest }], paymentClient: payment });
    invoices = t.app.get(InvoiceRepository);
    requests = t.app.get(PaymentRequestRepository);
    dispatcher = t.app.get(PaymentDispatcher);
    broker = await amqp.connect(env.TEST_RABBITMQ_URL);
    owner = new RabbitMqEventBus({ url: urlFor(OWNER), exchange });
    intruder = new RabbitMqEventBus({ url: urlFor(INTRUDER), exchange });
    buses.push(owner, intruder);
  });
  afterAll(async () => {
    for (const b of buses) await b.close();
    if (broker) {
      const ch = await broker.createChannel();
      for (const q of queues) for (const name of [q, `${q}.retry`, `${q}.dead`]) await ch.deleteQueue(name).catch(() => undefined);
      for (const name of [exchange, `${exchange}.dlx`]) await ch.deleteExchange(name).catch(() => undefined);
      await broker.close().catch(() => undefined);
    }
    for (const user of created) await api('DELETE', `/users/${encodeURIComponent(user)}`);
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  // ------------------------------------------------------------------------------------------------ business fixtures (as G11)
  let seq = 0;
  async function setup() {
    seq += 1;
    const product = await admin.query(
      `INSERT INTO product (producer, "sellerType", "sellerId", code, name, status) VALUES ($1, 'organization', $2, $3, $4, 'active') RETURNING id`,
      [PRODUCER, ORG, `s1b-${seq}-${hex(3)}`, `S1b product ${seq}`],
    );
    const price = await admin.query(
      `INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom") VALUES ($1, $2, 'TND', 1500, 'one_time', now()) RETURNING id`,
      [product.rows[0].id, `s1b-ref-${seq}`],
    );
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: `s1b-src-${seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price.rows[0].id, quantity: 1 }],
    });
    const { invoice: draft } = await invoices.createDraft(PRODUCER, input, ['TND'], ctx);
    const open = (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
    const { request } = await requests.createForInvoice(open.id, producer, ctx);
    const paymentId = crypto.randomUUID();
    payment.whenCreate(request.id, {
      kind: 'accepted',
      snapshot: { paymentId, paymentRequestId: request.id, status: 'pending', amount: Number(open.total), currency: 'TND', sourceType: 'invoice', sourceId: open.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, closedAt: null },
    });
    await dispatcher.dispatchOnce(60_000, 50);
    const facts = (over: Partial<PaymentEventFacts> = {}): PaymentEventFacts => ({
      name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: request.id, sourceType: 'invoice', sourceId: open.id,
      payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG }, organizationId: ORG, amount: Number(open.total), currency: 'TND', revision: 1,
      purpose: 'non_entitlement', liveMode: false, ...over, // S4a: as Payment echoes them
    });
    return { open, request, paymentId, id: deterministicEventId(paymentId, 'payment.succeeded'), facts };
  }
  const occurredAt = new Date().toISOString();
  const envelope = (f: PaymentEventFacts, id: string): EventEnvelope => {
    const { name, source, ...payload } = f;
    return { id, name, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt, source, version: 1, correlationId: 'corr-s1b' } };
  };
  const status = async (requestId: string) => (await admin.query(`SELECT status FROM payment_request WHERE id = $1`, [requestId])).rows[0].status as string;
  const applied = async (eventId: string) => (await admin.query(`SELECT count(*)::int AS n FROM payment_event_receipt WHERE "eventId" = $1 AND outcome = 'applied'`, [eventId])).rows[0].n as number;
  /** What one consumer (its queue) recorded: provenance is per consumer, and every consumer bound to the exchange records its own. */
  const provenanceOf = async (eventId: string, consumer: string) =>
    (await admin.query(`SELECT id, source, name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason, "firstSeenAt" FROM event_provenance WHERE "eventId" = $1 AND consumer = $2 ORDER BY "firstSeenAt", id`, [eventId, consumer])).rows;
  const conflictsOf = async (eventId: string, consumer: string) =>
    (await admin.query(`SELECT "provenanceId", "bodySha256", "producerUserId", verified, reason FROM event_provenance_conflict WHERE "eventId" = $1 AND consumer = $2 ORDER BY "observedAt", id`, [eventId, consumer])).rows;
  const depth = async (q: string) => {
    const ch = await broker.createChannel();
    try {
      return (await ch.checkQueue(q)).messageCount;
    } finally {
      await ch.close().catch(() => undefined);
    }
  };

  /**
   * The REAL consumer on a real bus; only the queue is renamed. `around` wraps the consumer's own handler (ordering probes, crash
   * injection) and is called with the delivery and the consumer's real handler.
   */
  async function startConsumer(queue: string, around?: (e: EventEnvelope, real: (e: EventEnvelope) => Promise<void>, bus: RabbitMqEventBus) => Promise<void>) {
    const notices: string[] = [];
    const observations: EventBusObservation[] = [];
    const rabbit = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange, retry: { maxRetries: 2, delayMs: 150 }, drainTimeoutMs: 200, onNotice: (m) => notices.push(m) });
    rabbit.setObserver((o) => observations.push(o));
    buses.push(rabbit);
    const bus: EventBus = {
      publish: (e) => rabbit.publish(e),
      close: () => rabbit.close(),
      subscribe: (s: EventSubscription) =>
        // the trust the kit decided travels with the delivery: `around` only wraps it (Core V2 S1e-2)
        rabbit.subscribe({ ...s, queue, handler: (e, trust) => (around ? around(e, (x) => s.handler(x, trust), rabbit) : s.handler(e, trust)) }),
    };
    const consumer = new PaymentEventConsumer(requests, bus, t.app.get(DbService), new PaymentEventOriginRepository(t.app.get(DbService)));
    await consumer.onApplicationBootstrap();
    return { notices, observations, rabbit, outcomes: () => observations.flatMap((o) => (o.type === 'provenance' ? [o.outcome] : [])) };
  }
  const newQueue = () => {
    const q = `billing.payment-events.s1b${run}.${queues.length}`;
    queues.push(q);
    return q;
  };

  describe('ordering, idempotency and authority', () => {
    let c: Awaited<ReturnType<typeof startConsumer>>;
    let q: string;
    const seenAtHandler = new Map<string, unknown[]>();
    const provenance = (eventId: string) => provenanceOf(eventId, q);
    const conflicts = (eventId: string) => conflictsOf(eventId, q);
    beforeAll(async () => {
      q = newQueue();
      c = await startConsumer(q, async (e, real) => {
        // read through ANOTHER connection: only a COMMITTED row is visible here
        if (!seenAtHandler.has(e.id)) seenAtHandler.set(e.id, await provenance(e.id));
        await real(e);
      });
    });
    afterAll(() => c.rabbit.close());

    it('the genuine Payment event is recorded VERIFIED and committed before the handler runs; the financial outcome is unchanged', async () => {
      const s = await setup();
      await owner.publish(envelope(s.facts(), s.id));
      await until(async () => (await status(s.request.id)) === 'paid');
      expect(seenAtHandler.get(s.id)).toEqual([expect.objectContaining({ source: OWNER, producerUserId: OWNER, name: 'payment.succeeded', routingKey: 'payment.succeeded', exchange, verified: true, reason: 'verified' })]);
      expect(await applied(s.id)).toBe(1);
      expect((await invoices.findForCaller(s.open.id, producer)).status).toBe('paid');
    });

    it('the same delivery again (an outbox re-publish or redelivery) is idempotent: one row, no conflict, still one applied receipt', async () => {
      const s = await setup();
      const e = envelope(s.facts(), s.id);
      await owner.publish(e);
      await until(async () => (await status(s.request.id)) === 'paid');
      const before = await provenance(s.id);
      const n = c.outcomes().length;
      await owner.publish(e);
      await until(() => c.outcomes().length === n + 1);
      expect(c.outcomes().at(-1)).toBe('duplicate');
      expect(await provenance(s.id)).toEqual(before);
      expect(await conflicts(s.id)).toEqual([]);
      expect(await applied(s.id)).toBe(1);
    });

    it('an UNVERIFIED first arrival (forged source header) is refused before the handler and cannot establish authority: the genuine event applies', async () => {
      const s = await setup();
      const forged = envelope(s.facts({ amount: 1 }), s.id); // claims payment-service, published by the intruder, forged facts
      await intruder.publish(forged);
      await until(async () => (await provenance(s.id)).length === 1 && c.notices.some((m) => m.startsWith('event_trust_refused') && m.includes(`event=${s.id}`) && m.includes('basis=unverified_original')));
      expect(seenAtHandler.has(s.id)).toBe(false); // S1e-2: the forged delivery never reached Billing's handler
      const [first] = await provenance(s.id);
      expect(first).toMatchObject({ source: OWNER, producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' });
      expect(await applied(s.id)).toBe(0); // the forged facts never applied (A3M G11, unchanged)
      await owner.publish(envelope(s.facts(), s.id));
      await until(async () => (await status(s.request.id)) === 'paid');
      const rows = await provenance(s.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(first); // the earlier evidence is never changed
      expect(rows[1]).toMatchObject({ source: OWNER, producerUserId: OWNER, verified: true, reason: 'verified' });
      // the genuine delivery differs from the stored unverified one: recorded as conflict evidence, with its own verification
      expect(await conflicts(s.id)).toEqual([{ provenanceId: first.id, bodySha256: rows[1].bodySha256, producerUserId: OWNER, verified: true, reason: 'verified' }]);
      expect(await applied(s.id)).toBe(1);
    });

    it('changed content under the same event id never replaces the first evidence: it is appended as a conflict (observe-only: business rules decide)', async () => {
      const s = await setup();
      await owner.publish(envelope(s.facts(), s.id));
      await until(async () => (await status(s.request.id)) === 'paid');
      const [genuine] = await provenance(s.id);
      const n = c.outcomes().length;
      await owner.publish(envelope(s.facts({ revision: 2 }), s.id)); // the owner itself, different body, same id
      await until(() => c.outcomes().length === n + 1);
      expect(c.outcomes().at(-1)).toBe('conflict');
      expect(await provenance(s.id)).toEqual([genuine]);
      const [conflict] = await conflicts(s.id);
      expect(conflict).toMatchObject({ provenanceId: genuine.id, producerUserId: OWNER, verified: true });
      expect(conflict.bodySha256).not.toBe(genuine.bodySha256);
      // S1e-2: a verified delivery contradicting the stored verified one is refused before the handler (never reconciled)
      await until(() => c.notices.some((m) => m.startsWith('event_trust_refused') && m.includes(`event=${s.id}`) && m.includes('basis=verified_conflict')));
      expect(await applied(s.id)).toBe(1);
      expect(await status(s.request.id)).toBe('paid');
    });
  });

  it('a provenance write that fails never runs the handler: the original is held and requeued (no .retry, no .dead), then applied once', async () => {
    const queue = newQueue();
    const handled: string[] = [];
    const c = await startConsumer(queue, async (e, real) => {
      handled.push(e.id);
      await real(e);
    });
    await admin.query(`CREATE FUNCTION pg_temp_s1b_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected provenance outage'; END $$`);
    await admin.query(`CREATE TRIGGER event_provenance_00_injected_outage BEFORE INSERT ON event_provenance FOR EACH ROW EXECUTE FUNCTION pg_temp_s1b_fail()`);
    const s = await setup();
    try {
      await owner.publish(envelope(s.facts(), s.id));
      await until(() => c.notices.filter((m) => m.startsWith('event_trust_held')).length >= 2); // S1e-2: no trust decision → held, requeued, held again
      expect(handled).toEqual([]);
      expect(await applied(s.id)).toBe(0);
      expect(await status(s.request.id)).not.toBe('paid');
      expect(await depth(`${queue}.retry`)).toBe(0);
      expect(await depth(`${queue}.dead`)).toBe(0);
      expect(c.notices.join('\n')).not.toMatch(/injected provenance outage|postgres:\/\//); // the error's class only
    } finally {
      await admin.query(`DROP TRIGGER event_provenance_00_injected_outage ON event_provenance`);
      await admin.query(`DROP FUNCTION pg_temp_s1b_fail()`);
    }
    await until(async () => (await status(s.request.id)) === 'paid');
    expect(handled).toEqual([s.id]);
    expect(await provenanceOf(s.id, queue)).toEqual([expect.objectContaining({ producerUserId: OWNER, verified: true })]);
    expect(await applied(s.id)).toBe(1);
    expect(c.observations.some((o) => o.type === 'consume' && o.outcome === 'provenance_deferred')).toBe(true);
    await c.rabbit.close();
  });

  describe('S1e-2 enforcement: replays, injections and the trusted envelope (real RabbitMQ and PostgreSQL)', () => {
    // every consumer here binds the same names on one exchange: each test's consumer is closed after it, so no other one shares its deliveries
    const open: RabbitMqEventBus[] = [];
    const startOwn: typeof startConsumer = async (q, around) => {
      const c = await startConsumer(q, around);
      open.push(c.rabbit);
      return c;
    };
    afterEach(async () => {
      for (const b of open.splice(0)) await b.close().catch(() => undefined);
    });
    const replaysOf = (c: { observations: EventBusObservation[] }) => c.observations.flatMap((o) => (o.type === 'replay' ? [`${o.outcome}/${o.original}`] : []));
    const refusals = (c: { notices: string[] }, id: string) => c.notices.filter((m) => m.startsWith('event_trust_refused') && m.includes(`event=${id}`)).map((m) => m.match(/basis=(\w+)/)![1]);
    /** A default-exchange injection straight into `queue`: any consumer identity can do this (S1d-3, OD-BRK); only S1e stops it. */
    const inject = async (queue: string, e: EventEnvelope) => {
      const ch = await broker.createConfirmChannel();
      ch.sendToQueue(queue, Buffer.from(JSON.stringify(e.payload)), { persistent: true, messageId: e.id, type: e.name, headers: e.headers });
      await ch.waitForConfirms();
      await ch.close();
    };
    /** Makes Billing's NEXT receipt insert fail once (a transient database failure INSIDE applyPaymentEvent, after the origin was recorded). */
    const failNextReceiptOnce = async () => {
      await admin.query(`CREATE SEQUENCE IF NOT EXISTS s1e2_fail_once`);
      await admin.query(`SELECT setval('s1e2_fail_once', 1, false)`);
      await admin.query(`CREATE OR REPLACE FUNCTION s1e2_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('s1e2_fail_once') = 1 THEN RAISE EXCEPTION 'injected transient failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`DROP TRIGGER IF EXISTS payment_event_receipt_00_s1e2 ON payment_event_receipt`);
      await admin.query(`CREATE TRIGGER payment_event_receipt_00_s1e2 BEFORE INSERT ON payment_event_receipt FOR EACH ROW EXECUTE FUNCTION s1e2_fail_receipt()`);
    };
    const restoreReceipts = () => admin.query(`DROP TRIGGER IF EXISTS payment_event_receipt_00_s1e2 ON payment_event_receipt`);
    const origin = async (id: string) => (await admin.query(`SELECT "eventId", source, "eventName", "eventVersion", "occurredAt", "correlationId" FROM payment_event_origin WHERE "eventId" = $1`, [id])).rows;
    const transitionCorrelation = async (requestId: string) =>
      (await admin.query(`SELECT "correlationId" FROM billing_transition WHERE "entityType" = 'payment_request' AND "entityId" = $1 AND "toStatus" = 'paid'`, [requestId])).rows.map((r) => r.correlationId);

    it('a consumer retry after a transient failure inside the financial transaction matches the verified original and applies ONCE, from the recorded values', async () => {
      const queue = newQueue();
      const s = await setup();
      const c = await startOwn(queue);
      await failNextReceiptOnce();
      try {
        await owner.publish(envelope(s.facts(), s.id));
        await until(async () => (await status(s.request.id)) === 'paid');
      } finally {
        await restoreReceipts();
      }
      expect(replaysOf(c)).toEqual(['replay_matched_verified/verified']);
      expect(await applied(s.id)).toBe(1);
      expect(await origin(s.id)).toEqual([{ eventId: s.id, source: 'payment-service', eventName: 'payment.succeeded', eventVersion: 1, occurredAt, correlationId: 'corr-s1b' }]);
      expect(await provenanceOf(s.id, queue)).toHaveLength(1); // the retry recorded no new observation
    });

    it('a header-TAMPERED replay of the authentic bytes is processed with the RECORDED original values, never its own headers', async () => {
      const queue = newQueue();
      const s = await setup();
      const c = await startOwn(queue);
      await failNextReceiptOnce(); // the original records its values, then fails before applying: a replay will be what applies
      try {
        await owner.publish(envelope(s.facts(), s.id));
        await until(async () => (await origin(s.id)).length === 1);
        const tampered = envelope(s.facts(), s.id);
        await inject(queue, { ...tampered, headers: { ...tampered.headers, occurredAt: '2031-01-01T00:00:00.000Z', correlationId: 'corr-tampered', version: 1 } });
        await until(async () => (await status(s.request.id)) === 'paid');
      } finally {
        await restoreReceipts();
      }
      expect(await applied(s.id)).toBe(1);
      expect(await transitionCorrelation(s.request.id)).toEqual(['corr-s1b']); // the recorded original's, not 'corr-tampered'
      expect(await origin(s.id)).toEqual([expect.objectContaining({ occurredAt, correlationId: 'corr-s1b' })]); // never overwritten
      expect(c.notices.join('\n')).not.toContain('corr-tampered');
    });

    it('a retry whose original never recorded its values is REFUSED (fail closed, nothing invented): no receipt, the request stays for the reconciler', async () => {
      const queue = newQueue();
      const s = await setup();
      let calls = 0;
      const c = await startOwn(queue, async (e, real) => {
        if (++calls === 1) throw new Error('transient before anything ran'); // fails BEFORE Billing recorded the original's values
        return real(e);
      });
      await owner.publish(envelope(s.facts(), s.id));
      await until(async () => (await depth(`${queue}.dead`)) === 1);
      expect(await applied(s.id)).toBe(0);
      expect(await status(s.request.id)).not.toBe('paid');
      expect(await origin(s.id)).toEqual([]);
      expect(c.notices.some((m) => m.startsWith('event_dead_lettered') && m.includes('reason=untrusted_origin_unavailable'))).toBe(true);
    });

    it('a forged injection that changes the facts under the same event id is REFUSED (replay_mismatch): nothing financial changes', async () => {
      const queue = newQueue();
      const s = await setup();
      const c = await startOwn(queue);
      await owner.publish(envelope(s.facts(), s.id));
      await until(async () => (await status(s.request.id)) === 'paid');
      await inject(queue, envelope(s.facts({ revision: 7, amount: 1 }), s.id));
      await until(() => refusals(c, s.id).length === 1);
      expect(refusals(c, s.id)).toEqual(['replay_mismatch']);
      expect(replaysOf(c)).toEqual(['replay_mismatch/verified']);
      expect(await applied(s.id)).toBe(1);
      expect(await status(s.request.id)).toBe('paid');
    });

    it('S1d-3\'s attack: a forged payment.* with GENUINE facts and no original, injected through the default exchange, is REFUSED: no receipt, no state change', async () => {
      const queue = newQueue();
      const c = await startOwn(queue);
      for (const name of ['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired'] as const) {
        const s = await setup();
        const id = deterministicEventId(s.paymentId, name);
        await inject(queue, envelope(s.facts({ name, ...(name === 'payment.failed' ? { failureCode: null } : {}), ...(name === 'payment.expired' ? { expiresAt: new Date().toISOString() } : {}) } as never), id));
        await until(() => refusals(c, id).length === 1);
        expect(refusals(c, id)).toEqual(['replay_no_provenance']);
        expect(await provenanceOf(id, queue)).toEqual([]);
        expect(await applied(id)).toBe(0);
        expect((await admin.query(`SELECT count(*)::int n FROM payment_event_receipt WHERE "eventId" = $1`, [id])).rows[0].n).toBe(0);
        expect(await status(s.request.id)).toBe('requested');
      }
      expect(replaysOf(c)).toEqual(Array(4).fill('replay_no_provenance/none'));
    });

    it('an original WITHOUT user_id (the broker accepts it) is refused before the handler; the evidence stays unverified', async () => {
      const queue = newQueue();
      const s = await setup();
      const c = await startOwn(queue);
      const e = envelope(s.facts(), s.id);
      const conn = await amqp.connect(urlFor(OWNER));
      const ch = await conn.createConfirmChannel();
      ch.publish(exchange, e.name, Buffer.from(JSON.stringify(e.payload)), { persistent: true, messageId: e.id, type: e.name, headers: e.headers }); // no userId
      await ch.waitForConfirms();
      await conn.close();
      await until(() => refusals(c, s.id).length === 1);
      expect(refusals(c, s.id)).toEqual(['unverified_original']);
      expect(await provenanceOf(s.id, queue)).toEqual([expect.objectContaining({ verified: false, reason: 'missing_user_id' })]);
      expect(await applied(s.id)).toBe(0);
      expect(await origin(s.id)).toEqual([]);
    });

    it('a verified re-publication of the same body with DIFFERENT envelope values is refused (origin conflict): the recorded values never change', async () => {
      const queue = newQueue();
      const s = await setup();
      const c = await startOwn(queue);
      const e = envelope(s.facts(), s.id);
      await owner.publish(e);
      await until(async () => (await status(s.request.id)) === 'paid');
      await owner.publish({ ...e, headers: { ...e.headers, occurredAt: '2031-01-01T00:00:00.000Z' } });
      await until(() => c.notices.some((m) => m.startsWith('event_dead_lettered') && m.includes(`event=${s.id}`) && m.includes('reason=untrusted_origin_conflict')));
      expect(await origin(s.id)).toEqual([expect.objectContaining({ occurredAt })]);
      expect(await applied(s.id)).toBe(1);
    });

    it('concurrent verified deliveries of one event: one origin row, one applied receipt', async () => {
      const queue = newQueue();
      const s = await setup();
      await startOwn(queue);
      const e = envelope(s.facts(), s.id);
      await Promise.all([owner.publish(e), owner.publish(e), owner.publish(e), owner.publish(e)]);
      await until(async () => (await status(s.request.id)) === 'paid');
      await sleep(500);
      expect(await origin(s.id)).toHaveLength(1);
      expect(await applied(s.id)).toBe(1);
    });
  });

  describe('crash windows (the consumer dies before acknowledging; the broker redelivers to a new consumer)', () => {
    /** First consumer: runs `before` on the first delivery, then dies (closed with a 200 ms drain while the delivery is still unacknowledged). */
    async function crashThenRecover(callRealBeforeCrash: boolean) {
      const queue = newQueue();
      const s = await setup();
      let first = true;
      const handledByFirst: string[] = [];
      await startConsumer(queue, async (e, real, bus) => {
        if (!first) return real(e);
        first = false;
        if (callRealBeforeCrash) {
          await real(e);
          handledByFirst.push(e.id);
        }
        void bus.close(); // the process dies: the in-flight delivery is never acknowledged
        await sleep(600);
      });
      await owner.publish(envelope(s.facts(), s.id));
      await until(() => !first);
      await sleep(900);
      const second = await startConsumer(queue);
      await until(async () => (await status(s.request.id)) === 'paid' && second.outcomes().length >= 1);
      await second.rabbit.close();
      return { s, queue, second, handledByFirst };
    }

    it('after the provenance commit and before the handler: the redelivery is a provenance duplicate and is applied once', async () => {
      const { s, queue, second, handledByFirst } = await crashThenRecover(false);
      expect(handledByFirst).toEqual([]);
      expect(second.outcomes()).toEqual(['duplicate']);
      expect(await provenanceOf(s.id, queue)).toEqual([expect.objectContaining({ verified: true })]);
      expect(await applied(s.id)).toBe(1);
    });

    it('after the handler and before the acknowledgement: the redelivery is a provenance duplicate and has no second effect', async () => {
      const { s, queue, second, handledByFirst } = await crashThenRecover(true);
      expect(handledByFirst).toEqual([s.id]);
      expect(second.outcomes()).toEqual(['duplicate']);
      expect(await provenanceOf(s.id, queue)).toEqual([expect.objectContaining({ verified: true })]);
      expect(await applied(s.id)).toBe(1);
      expect(await status(s.request.id)).toBe('paid');
    });
  });

  describe('the store and the schema (PostgreSQL)', () => {
    const observation = (eventId: string, over: Partial<ProvenanceObservation> = {}): ProvenanceObservation => ({
      source: OWNER, eventId, name: 'payment.succeeded', routingKey: 'payment.succeeded', exchange, bodySha256: 'a'.repeat(64), producerUserId: OWNER, verified: true, reason: 'verified', ...over,
    });

    it('uniqueness holds under concurrency: 20 identical observations → one row; concurrent differing ones are all kept as evidence', async () => {
      const store = new PgProvenanceStore(t.app.get(DbService));
      const id = crypto.randomUUID();
      const same = await Promise.all(Array.from({ length: 20 }, () => store.record('q.concurrency', observation(id))));
      expect(same.filter((r) => r === 'recorded')).toHaveLength(1);
      expect(same.filter((r) => r === 'duplicate')).toHaveLength(19);
      const id2 = crypto.randomUUID();
      const bodies = Array.from({ length: 10 }, (_, i) => String(i).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'b'));
      await Promise.all([
        store.record('q.concurrency', observation(id2)),
        ...bodies.map((b) => store.record('q.concurrency', observation(id2, { bodySha256: b, producerUserId: INTRUDER, verified: false, reason: 'source_mismatch' }))),
      ]);
      const rows = (await admin.query(`SELECT "bodySha256", verified FROM event_provenance WHERE "eventId" = $1`, [id2])).rows;
      expect(rows.map((r) => r.verified).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]); // one verified, one unverified: never two of either
      const evidence = new Set([...rows.map((r) => r.bodySha256), ...(await conflictsOf(id2, 'q.concurrency')).map((r) => r.bodySha256)]);
      expect(evidence).toEqual(new Set(['a'.repeat(64), ...bodies])); // no observation's digest was lost
    });

    it('S1e-2: payment_event_origin is append-only (UPDATE, DELETE, TRUNCATE refused even for the owner) and refuses an untrusted shape', async () => {
      const id = crypto.randomUUID();
      await admin.query(`INSERT INTO payment_event_origin ("eventId", source, "eventName", "eventVersion", "occurredAt", "correlationId") VALUES ($1, 'payment-service', 'payment.succeeded', 1, '2026-01-01T00:00:00.000Z', 'c')`, [id]);
      await expect(admin.query(`UPDATE payment_event_origin SET "occurredAt" = '2030-01-01T00:00:00.000Z' WHERE "eventId" = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM payment_event_origin WHERE "eventId" = $1`, [id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`TRUNCATE payment_event_origin`)).rejects.toThrow(/append-only/);
      for (const [col, value] of [['source', 'billing-service'], ['eventName', 'payment.created'], ['occurredAt', 'yesterday'], ['eventVersion', 0]] as const) {
        const row = { source: 'payment-service', eventName: 'payment.succeeded', eventVersion: 1, occurredAt: '2026-01-01T00:00:00.000Z', [col]: value };
        await expect(admin.query(`INSERT INTO payment_event_origin ("eventId", source, "eventName", "eventVersion", "occurredAt") VALUES ($1, $2, $3, $4, $5)`, [crypto.randomUUID(), row.source, row.eventName, row.eventVersion, row.occurredAt])).rejects.toThrow(/payment_event_origin_/);
      }
    });

    it('both tables are append-only: UPDATE, DELETE and TRUNCATE are refused, even for the owner', async () => {
      for (const table of ['event_provenance', 'event_provenance_conflict']) {
        await expect(admin.query(`UPDATE ${table} SET verified = verified`)).rejects.toMatchObject({ code: '23514' });
        await expect(admin.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '23514' });
        await expect(admin.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject({ code: '23514' });
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM event_provenance`)).rows[0].n).toBeGreaterThan(0);
    });

    it('the database refuses a VERIFIED row that does not meet §13.2 (an unverified observation can never be stored as authority)', async () => {
      const insert = (o: Partial<ProvenanceObservation>) => {
        const v = observation(crypto.randomUUID(), o);
        return admin.query(
          `INSERT INTO event_provenance (consumer, source, "eventId", name, "routingKey", exchange, "bodySha256", "producerUserId", verified, reason) VALUES ('q.shape', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [v.source, v.eventId, v.name, v.routingKey, v.exchange, v.bodySha256, v.producerUserId, v.verified, v.reason],
        );
      };
      for (const bad of [{ producerUserId: INTRUDER }, { producerUserId: null }, { routingKey: 'payment.failed' }, { eventId: 'evt-1' }, { reason: 'source_mismatch' as const }]) {
        await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
      }
      await expect(insert({ verified: false })).rejects.toMatchObject({ code: '23514' }); // 'verified' reason on an unverified row
      await expect(insert({})).resolves.toBeDefined();
    });
  });
});
