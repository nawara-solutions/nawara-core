import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';
import { billingPolicy, startReferenceStub } from './support/admission.js';

const refStub = await startReferenceStub();
afterAll(() => refStub.close());

/**
 * Core V2 S0-C14 WP C (S0 §1.5 S0-C14 items 10, 11; register AUTH-01 H, BIL-28 H): REAL Billing (its Owner routes) → its outbox (same transaction
 * as the suspension evidence) → its kit relay → a REAL RabbitMQ → a live audit-service. Proves delivery of `recovery_restriction.suspended` and
 * `recovery_restriction.suspension_revoked` with their reason codes and evidence fields, a retry while audit-service is down, idempotency (a
 * replayed request and a relay re-publish each stay one record) and cross-Company isolation (another Company's Owner records nothing; an
 * Organization read of another Organization sees nothing).
 *
 * Auth is a stand-in of exactly the routes Billing calls (`/auth/grants`, `/auth/platform-access`, AUTH-02 consume, AUTH-03 lookup), with Auth's
 * rules for a receipt: one binding, one consumption per consumeRef, the issuer recorded. LABELLED FIXTURE: the obligation in a refund and
 * chargeback overlap (its verified loss, the completed refund of the same captured movement, the obligation) is written directly with triggers
 * and foreign keys suspended; the real paths that produce it are certified in apps/billing-service/test/recovery.e2e-spec.ts. Everything this
 * suite asserts runs through the real processes.
 */
const BILLING_DIR = `${APPS}billing-service`;
const BILLING_PORT = 3893;
const AUDIT_PORT = 3894;
const BILLING_URL = `http://127.0.0.1:${BILLING_PORT}`;
const COMPANY_A = randomUUID();
const COMPANY_B = randomUUID();
const PLATFORM = randomUUID();
const OWNER_A = randomUUID();
const OWNER_B = randomUUID();
const ORG = randomUUID();
const bearers: Record<string, { userId: string; companyId: string }> = { 'owner-a': { userId: OWNER_A, companyId: COMPANY_A }, 'owner-b': { userId: OWNER_B, companyId: COMPANY_B } };

type Receipt = { id: string; binding: Record<string, unknown>; issuer: string; consumeRef?: string };
const canon = (b: Record<string, unknown>) => JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

describeWithEnv('S0-C14 suspension and revocation: Billing → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let billingDb: TestDatabase;
  let billing: LiveService;
  let audit: LiveAudit;
  let auth: Server;
  const receipts = new Map<string, Receipt>();
  const authCalls: string[] = [];

  const startAuth = async () => {
    auth = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        authCalls.push(`${req.method} ${req.url}`);
        const send = (status: number, body?: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(body === undefined ? undefined : JSON.stringify(body));
        };
        const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
        if (req.method === 'GET' && req.url === '/auth/grants') {
          const who = bearers[bearer];
          return who ? send(200, { userId: who.userId, kind: 'owner', companyId: who.companyId }) : send(401, { message: 'Unauthorized' });
        }
        const access = /^\/auth\/platform-access\/([0-9a-f-]{36})$/.exec(req.url ?? '');
        if (req.method === 'GET' && access) {
          return bearers[bearer]?.companyId === COMPANY_A && access[1] === PLATFORM ? send(200, { platformId: PLATFORM, allowed: true }) : send(404, { code: 'not_found' });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { secret?: string; binding?: Record<string, unknown>; consumeRef?: string };
        const consumption = (r: Receipt) => ({ receiptId: r.id, consumeRef: r.consumeRef, companyId: r.binding.companyId, approvedBy: { userId: r.issuer } });
        if (req.method === 'POST' && req.url === '/auth/service/authorization-receipts/consume') {
          const r = receipts.get(body.secret ?? '');
          if (!r || canon(r.binding) !== canon(body.binding ?? {})) return send(409, { code: 'receipt_invalid' });
          if (r.consumeRef && r.consumeRef !== body.consumeRef) return send(409, { code: 'consume_ref_conflict' });
          r.consumeRef = body.consumeRef;
          return send(200, consumption(r));
        }
        if (req.method === 'POST' && req.url === '/auth/service/authorization-receipts/consumptions/lookup') {
          for (const r of receipts.values()) if (r.consumeRef === body.consumeRef && canon(r.binding) === canon(body.binding ?? {})) return send(200, consumption(r));
          return send(404, { code: 'not_found' });
        }
        return send(404, { code: 'not_found' });
      });
    });
    await new Promise<void>((r) => auth.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(auth.address() as AddressInfo).port}`;
  };

  /** LABELLED FIXTURE: an open obligation of ORG (Company A) whose captured movement has a verified loss and a completed refund (an overlap). */
  const overlapFixture = async () => {
    const o = { obligationId: randomUUID(), disputeId: randomUUID(), refundCaseId: randomUUID(), paymentId: randomUUID(), paymentRequestId: randomUUID() };
    await sql(billingDb.url, `DO $$ BEGIN
      SET LOCAL session_replication_role = replica;
      INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency",
        "lostAt", source, "captureBasis") VALUES ('${o.disputeId}', '${o.paymentId}', '${o.paymentRequestId}', 6100, 'TND', gen_random_uuid(), 6100, 'TND', now(), 'reconciliation', 'settling_capture');
      INSERT INTO refund_case (id, "paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "companyId", "platformId", amount, currency, reason, "openedBy", status, "completedAt")
        VALUES ('${o.refundCaseId}', '${o.paymentId}', '${o.paymentRequestId}', gen_random_uuid(), gen_random_uuid(), 'non_entitlement', '${COMPANY_A}', '${PLATFORM}', 6100, 'TND',
                'customer_request', '${OWNER_A}', 'completed', now());
      INSERT INTO recovery_obligation (id, "disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
        VALUES ('${o.obligationId}', '${o.disputeId}', gen_random_uuid(), gen_random_uuid(), '${ORG}', '${COMPANY_A}', '${PLATFORM}', 6100, 'TND');
    END $$`);
    return o;
  };
  const receipt = (o: { obligationId: string; disputeId: string; refundCaseId: string }, suspensionId: string, kind: 'suspend' | 'revoke', issuer = OWNER_A) => {
    const secret = randomBytes(32).toString('base64url');
    receipts.set(secret, { id: randomUUID(), issuer, binding: { operation: `recovery_restriction_${kind}`, audience: 'billing-service', companyId: COMPANY_A, suspensionId,
      obligationId: o.obligationId, organizationId: ORG, disputeId: o.disputeId, refundCaseId: o.refundCaseId,
      reasonCode: kind === 'suspend' ? 'refund_chargeback_overlap' : 'owner_reinstated_restriction' } });
    return secret;
  };
  const post = async (path: string, bearer: string, body: unknown) => {
    const r = await fetch(`${BILLING_URL}${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'x-correlation-id': 's0c14-e2e-corr' },
      body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const records = (obligationId: string) => audit.records(`"sourceService" = 'billing-service' AND "resourceId" = $1`, [obligationId]);

  beforeAll(async () => {
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    billingDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2es0c14audit');
    await runMigrations(billingDb.url, [kitMigrationsDir, `${BILLING_DIR}/db/migrations/`]);
    await sql(billingDb.url, `INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY_A, OWNER_A]);
    const authUrl = await startAuth();
    billing = spawnService('billing', BILLING_DIR, {
      NODE_ENV: 'test', PORT: String(BILLING_PORT), DATABASE_URL: billingDb.url, AUTH_SERVICE_URL: authUrl, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      BILLING_SUPPORTED_CURRENCIES: 'TND', SERVICE_TOKENS: `test-producer:${generateServiceToken().digest}`, ...billingPolicy('test-producer'), ...refStub.env,
      PAYMENT_SERVICE_URL: 'http://127.0.0.1:9', PAYMENT_SERVICE_TOKEN: generateServiceToken().token,
      // Billing's own service token to Auth's receipt routes (the receipt clients are configured only with these three, simulation only)
      AUTH_SERVICE_TOKEN: randomBytes(32).toString('base64url'), FILE_SERVICE_URL: 'http://127.0.0.1:9', FILE_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
      BILLING_DISPATCH_INTERVAL_MS: '300000', BILLING_RECONCILE_INTERVAL_MS: '3600000',
    });
    try {
      await waitForHealth(`${BILLING_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${billing.tail()}`);
    }
  });
  afterAll(async () => {
    await billing?.stop();
    await audit?.stop();
    await new Promise<void>((r) => (auth ? auth.close(() => r()) : r()));
    await billingDb?.drop();
    await audit?.db.drop();
  });

  it('a suspension reaches audit_record once with the Owner actor, the Organization, the reason code and the evidence; a replay and a relay re-publish stay one record', async () => {
    const o = await overlapFixture();
    const sid = randomUUID();
    const secret = receipt(o, sid, 'suspend');
    const s = await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions`, 'owner-a', { suspensionId: sid, receiptSecret: secret });
    expect(s.status, `${JSON.stringify(s.body)}\n${billing.tail()}`).toBe(201);
    await waitFor(async () => (await records(o.obligationId)).length === 1, 30_000, 'the suspension record');
    expect((await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions`, 'owner-a', { suspensionId: sid, receiptSecret: secret })).status).toBe(200);
    const [r] = await records(o.obligationId);
    expect(r).toMatchObject({ action: 'recovery_restriction.suspended', category: 'commercial', actorType: 'user', actorId: OWNER_A, userKind: 'owner', organizationId: ORG,
      resourceType: 'recovery_obligation', resourceId: o.obligationId, outcome: 'succeeded', correlationId: 's0c14-e2e-corr',
      changes: { suspension_id: sid, dispute_id: o.disputeId, refund_case_id: o.refundCaseId, reason_code: 'refund_chargeback_overlap' } });
    // a relay re-publish of the same audit event is absorbed: still one record
    await sql(billingDb.url, `ALTER TABLE outbox DISABLE TRIGGER outbox_immutable`);
    await sql(billingDb.url, `UPDATE outbox SET "publishedAt" = NULL WHERE name = 'audit.recovery_restriction.suspended' AND payload->'resource'->>'id' = $1`, [o.obligationId]);
    await sql(billingDb.url, `ALTER TABLE outbox ENABLE TRIGGER outbox_immutable`);
    await waitFor(async () => (await sql(billingDb.url, `SELECT "publishedAt" FROM outbox WHERE name = 'audit.recovery_restriction.suspended' AND payload->'resource'->>'id' = $1`,
      [o.obligationId]))[0]!.publishedAt !== null, 30_000, 're-published');
    await new Promise((res) => setTimeout(res, 1500));
    expect(await records(o.obligationId)).toHaveLength(1);
    const payloads = await sql(billingDb.url, `SELECT payload FROM outbox WHERE name LIKE 'audit.recovery_restriction.%'`);
    for (const p of payloads) for (const re of PROHIBITED) expect(JSON.stringify(p.payload)).not.toMatch(re);
    for (const p of payloads) expect(JSON.stringify(p.payload)).not.toContain(secret);
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('retry: a revocation committed while audit-service is down is delivered once it is back, exactly once', async () => {
    const o = await overlapFixture();
    const sid = randomUUID();
    expect((await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions`, 'owner-a', { suspensionId: sid, receiptSecret: receipt(o, sid, 'suspend') })).status).toBe(201);
    await waitFor(async () => (await records(o.obligationId)).length === 1, 30_000, 'the suspension record');
    await audit.stop();
    try {
      const r = await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions/${sid}/revocation`, 'owner-a', { receiptSecret: receipt(o, sid, 'revoke') });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await new Promise((res) => setTimeout(res, 1500));
    } finally {
      await audit.start();
    }
    await waitFor(async () => (await records(o.obligationId)).length === 2, 30_000, 'the revocation record after the restart');
    await new Promise((res) => setTimeout(res, 1500));
    const rows = await records(o.obligationId);
    expect(rows.map((x) => x.action)).toEqual(['recovery_restriction.suspended', 'recovery_restriction.suspension_revoked']);
    expect(rows[1]).toMatchObject({ actorId: OWNER_A, userKind: 'owner', organizationId: ORG, changes: { suspension_id: sid, reason_code: 'owner_reinstated_restriction' } });
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });

  it('cross-Company isolation: another Company\'s Owner gets the collapsed 404 and records nothing; the record is read in its own Organization only', async () => {
    const o = await overlapFixture();
    const sid = randomUUID();
    const refused = await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions`, 'owner-b', { suspensionId: sid, receiptSecret: receipt(o, sid, 'suspend', OWNER_B) });
    expect(refused.status).toBe(404);
    expect((await sql(billingDb.url, `SELECT count(*)::int AS n FROM recovery_restriction_suspension_event WHERE "obligationId" = $1`, [o.obligationId]))[0]!.n).toBe(0);
    expect(await sql(billingDb.url, `SELECT 1 FROM outbox WHERE name LIKE 'audit.recovery_restriction.%' AND payload->'resource'->>'id' = $1`, [o.obligationId])).toEqual([]);
    expect((await post(`/billing/admin/recovery-obligations/${o.obligationId}/restriction-suspensions`, 'owner-a', { suspensionId: sid, receiptSecret: receipt(o, sid, 'suspend') })).status).toBe(201);
    await waitFor(async () => (await records(o.obligationId)).length === 1, 30_000, 'the suspension record');
    expect((await records(o.obligationId)).some((x) => x.actorId === OWNER_B)).toBe(false);
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 3_600_000).toISOString();
    const mine = await audit.get(`/audit/organizations/${ORG}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((i: { resource: { id: string } }) => i.resource.id === o.obligationId)).toBe(true);
    const other = await audit.get(`/audit/organizations/${randomUUID()}/records?from=${from}&to=${to}`, audit.orgReader.token);
    expect(other.body.items).toEqual([]);
    // version 1, no trusted scope (S2-Audit D3): never on any Company's timeline, A's or B's
    expect(await sql(audit.db.url, `SELECT 1 FROM audit_record_scope s JOIN audit_record r ON r.id = s."recordId" WHERE r."resourceId" = $1`, [o.obligationId])).toEqual([]);
  });
});
