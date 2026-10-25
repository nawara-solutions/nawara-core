import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { InMemoryEventBus, generateServiceToken } from '@nawara/service-kit';
import { AUTH_SERVICE_NAME } from '../src/audit/central-audit.js';
import { bearer, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

const uniq = () => Math.random().toString(36).slice(2);
const PURPOSE = 'refund.authorize';
const ISSUE = '/auth/admin/authorization-receipts';
const CONSUME = '/auth/service/authorization-receipts/consume';
const RECEIPT_ACTIONS = ['audit.authorization_receipt.issued', 'audit.authorization_receipt.consumed', 'audit.authorization_receipt.voided'];

/**
 * Core V2 S2-Audit.2 (ADR-0067 decision 7; Owner decisions D1 to D5): Auth's central audit of the authorization receipt lifecycle, written
 * by the kit outbox writer in the SAME transaction as each receipt change (beside the Auth-local records) and relayed by the kit relay to a
 * bus, over real HTTP and a real PostgreSQL. Every relayed payload is checked against the producer-side contract at its envelope version
 * (Audit's consumer-side validation of these actions is audit-service's own suite: only audit-service uses the consumer API).
 */
describe('authorization receipts: central audit (S2-Audit.2)', () => {
  let t: TestCtx;
  let bus: InMemoryEventBus;
  const payment = generateServiceToken();
  beforeAll(async () => {
    bus = new InMemoryEventBus();
    t = await createTestApp({
      AUTHORIZATION_RECEIPT_PEPPER: randomBytes(32).toString('base64'),
      SERVICE_TOKENS: `payment-service:${payment.digest}`,
      AUTH_SERVICE_POLICY: JSON.stringify({ callers: { 'payment-service': { operations: ['authorization_receipt.consume', 'authorization_receipt.lookup'] } } }),
    }, { auditBus: bus });
  });
  afterAll(() => t.close());

  const ready = async () => {
    const companyId = await t.newCompany();
    const o = await t.readyOwner(companyId, `ca${uniq()}@a.test`);
    return { ...o, companyId };
  };
  type Ready = Awaited<ReturnType<typeof ready>>;
  const binding = (companyId: string) => ({
    operation: 'refund', audience: 'payment-service', companyId, refundCaseId: randomUUID(), paymentId: randomUUID(), amount: 7_300,
    currency: 'TND', reason: 'duplicate_charge',
  });
  const issue = async (o: Ready, k = `rk-${uniq()}${uniq()}`, b = binding(o.companyId)) => {
    const stepUpToken = await t.stepUpToken(o.tokens as Tokens, PURPOSE, o.totpSecret);
    const r = await t.http.post(ISSUE).set(bearer(o.tokens as Tokens)).set('Idempotency-Key', k).send({ stepUpToken, binding: b });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { ...(r.body as { receiptId: string; secret: string }), binding: b, key: k, stepUpToken };
  };
  const consume = (body: object) => t.http.post(CONSUME).set(bearer(payment.token)).send(body);
  /** The central audit intents of one receipt, in the order they were written. */
  const rows = async (receiptId: string) =>
    (await t.db.query(`SELECT id, name, payload, "publishedAt" FROM outbox WHERE name LIKE 'audit.authorization_receipt.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [receiptId])).rows;
  const until = async (cond: () => Promise<boolean> | boolean, what: string) => {
    for (let i = 0; i < 150; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out: ${what}`);
  };
  const relayed = async (id: string) => {
    await until(() => bus.published.some((e) => e.id === id), `relayed ${id}`);
    return bus.published.find((e) => e.id === id)!;
  };

  it('issuance: one .issued intent, version 2, the Owner as actor, the Company from Auth, valid for Audit', async () => {
    const o = await ready();
    const r = await issue(o);
    const [row, ...more] = await rows(r.receiptId);
    expect(more).toEqual([]);
    expect(row.name).toBe('audit.authorization_receipt.issued');
    expect(row.payload).toEqual({
      action: 'authorization_receipt.issued', actor: { type: 'user', id: o.id, userKind: 'owner' }, organizationId: null,
      resource: { type: 'authorization_receipt', id: r.receiptId }, outcome: 'succeeded', companyId: o.companyId,
    });
    const env = await relayed(row.id);
    expect(env.headers).toMatchObject({ source: AUTH_SERVICE_NAME, version: 2 });
    expect(validateAuditPayload(env.payload, AUTH_SERVICE_NAME, env.headers.version as number).companyId).toBe(o.companyId);
    // the Auth-local record is kept, unchanged
    expect((await t.db.query(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type = 'authorization_receipt.issued' AND "targetId" = $1`, [r.receiptId])).rows[0].n).toBe(1);
  });

  it('consumption: .consumed with payment-service as actor and the verified issuing Owner as approvedBy (never a request value)', async () => {
    const o = await ready();
    const r = await issue(o);
    const ref = randomUUID();
    expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: ref })).status).toBe(200);
    expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: ref })).status).toBe(200); // idempotent repeat: no second intent
    const all = await rows(r.receiptId);
    expect(all.map((x) => x.name)).toEqual(['audit.authorization_receipt.issued', 'audit.authorization_receipt.consumed']);
    expect(all[1].payload).toEqual({
      action: 'authorization_receipt.consumed', actor: { type: 'service', id: 'payment-service' }, organizationId: null,
      resource: { type: 'authorization_receipt', id: r.receiptId }, outcome: 'succeeded', companyId: o.companyId,
      approvedBy: { type: 'user', id: o.id, userKind: 'owner' },
    });
    const env = await relayed(all[1].id);
    expect(validateAuditPayload(env.payload, AUTH_SERVICE_NAME, env.headers.version as number).approvedBy).toEqual({ type: 'user', id: o.id, userKind: 'owner' });
    // a body field named approvedBy cannot influence it: the DTO refuses unknown fields outright
    expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: ref, approvedBy: { userId: randomUUID() } })).status).toBe(400);
  });

  it('automatic replay void: .voided with the replay process as actor, never attributed to the Owner', async () => {
    const o = await ready();
    const r = await issue(o);
    const replay = await t.http.post(ISSUE).set(bearer(o.tokens as Tokens)).set('Idempotency-Key', r.key).send({ stepUpToken: r.stepUpToken, binding: r.binding });
    expect([replay.status, replay.body.code]).toEqual([409, 'receipt_issued_response_lost']);
    const all = await rows(r.receiptId);
    expect(all.map((x) => x.name)).toEqual(['audit.authorization_receipt.issued', 'audit.authorization_receipt.voided']);
    expect(all[1].payload).toEqual({
      action: 'authorization_receipt.voided', actor: { type: 'system', id: 'authorization_receipt_replay' }, organizationId: null,
      resource: { type: 'authorization_receipt', id: r.receiptId }, outcome: 'succeeded', companyId: o.companyId,
    });
    expect(JSON.stringify(all[1].payload)).not.toContain(o.id);
    const voidEnv = await relayed(all[1].id);
    expect(voidEnv.headers.version).toBe(2);
    validateAuditPayload(voidEnv.payload, AUTH_SERVICE_NAME, 2);
    // a further replay changes nothing and writes nothing
    await t.http.post(ISSUE).set(bearer(o.tokens as Tokens)).set('Idempotency-Key', r.key).send({ stepUpToken: r.stepUpToken, binding: r.binding });
    expect((await rows(r.receiptId)).length).toBe(2);
  });

  it('a refused consumption is never a central .consumed: wrong binding, wrong reference, revoked authority, voided', async () => {
    const o = await ready();
    const r = await issue(o);
    expect((await consume({ secret: r.secret, binding: { ...r.binding, amount: 1 }, consumeRef: randomUUID() })).status).toBe(409);
    await t.db.query(`UPDATE "user" SET "isActive"=false WHERE id=$1`, [o.id]);
    try {
      expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: randomUUID() })).body.code).toBe('authority_revoked');
    } finally { await t.db.query(`UPDATE "user" SET "isActive"=true WHERE id=$1`, [o.id]); }
    expect((await rows(r.receiptId)).map((x) => x.name)).toEqual(['audit.authorization_receipt.issued']);
    // the refusals stay Auth-local
    expect((await t.db.query(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type = 'authorization_receipt.consumed' AND outcome = 'denied' AND "targetId" = $1`, [r.receiptId])).rows[0].n).toBe(2);
    const ref = randomUUID();
    expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: ref })).status).toBe(200);
    expect((await consume({ secret: r.secret, binding: r.binding, consumeRef: randomUUID() })).body.code).toBe('consume_ref_conflict');
    expect((await rows(r.receiptId)).map((x) => x.name)).toEqual(['audit.authorization_receipt.issued', 'audit.authorization_receipt.consumed']);
  });

  it('a delivery outage never rolls back a committed receipt: the intent waits in the outbox and is relayed exactly once later', async () => {
    const o = await ready();
    bus.failNextPublishes(1_000_000);
    let r: Awaited<ReturnType<typeof issue>>;
    try {
      r = await issue(o);
      const [row] = await rows(r.receiptId);
      expect(row.publishedAt).toBeNull();
      expect((await t.db.query(`SELECT status FROM authorization_receipt WHERE id = $1`, [r.receiptId])).rows[0].status).toBe('issued');
      await until(async () => (await t.db.query(`SELECT attempts FROM outbox WHERE id = $1`, [row.id])).rows[0].attempts > 0, 'a failed attempt');
      expect(bus.published.some((e) => e.id === row.id)).toBe(false);
    } finally {
      bus.failNextPublishes(0);
    }
    const [row] = await rows(r!.receiptId);
    await relayed(row.id);
    await until(async () => (await rows(r!.receiptId))[0].publishedAt !== null, 'marked published');
    expect(bus.published.filter((e) => e.id === row.id)).toHaveLength(1);
  });

  it('no secret, digest, step-up proof, binding value or amount in any central intent or relayed envelope', async () => {
    const o = await ready();
    const r = await issue(o);
    await consume({ secret: r.secret, binding: r.binding, consumeRef: randomUUID() });
    const r2 = await issue(o);
    await t.http.post(ISSUE).set(bearer(o.tokens as Tokens)).set('Idempotency-Key', r2.key).send({ stepUpToken: r2.stepUpToken, binding: r2.binding });
    const digests = (await t.db.query(`SELECT "secretDigest", "bindingDigest", "requestHash" FROM authorization_receipt WHERE id = ANY($1)`, [[r.receiptId, r2.receiptId]])).rows
      .flatMap((x) => [x.secretDigest, x.bindingDigest, x.requestHash]);
    const central = (await t.db.query(`SELECT payload FROM outbox WHERE name = ANY($1)`, [RECEIPT_ACTIONS])).rows;
    await until(() => central.length > 0 && bus.published.filter((e) => RECEIPT_ACTIONS.includes(e.name)).length >= 4, 'relayed');
    const dump = JSON.stringify([central, bus.published.filter((e) => RECEIPT_ACTIONS.includes(e.name))]);
    for (const needle of [r.secret, r2.secret, r.stepUpToken, r2.stepUpToken, r.binding.refundCaseId, r.binding.paymentId, r2.binding.paymentId, '7300', payment.token, ...digests]) {
      expect(dump).not.toContain(needle);
    }
  });
});
