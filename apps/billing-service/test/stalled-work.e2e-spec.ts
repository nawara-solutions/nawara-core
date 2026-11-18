import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations, type DbService } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AUDIT_CATALOG } from '@nawara/audit-contract';
import { billingMigrationsDir } from '../src/app.module.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import { loadBillingConfig } from '../src/config/billing-config.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import { StalledWorkService } from '../src/stalled-work/stalled-work.service.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';

/**
 * Core V2 G3 (DO-31, DO-33, DO-41, DO-42; the Owner's G3 GO, 2026-11-18): escalation-only stalled-work review on real PostgreSQL.
 * LABELLED FIXTURES: the subjects (Platforms, invoices, payment requests and their sending transition, assistance requests, disputes, channels,
 * conflict receipts) are inserted with triggers and foreign keys off (session_replication_role) so their times can stand where a threshold needs
 * them; every row obeys every CHECK. Every review row, exit row and audit intent is written by the code under test through the database guards.
 */
const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const PLATFORM = randomUUID();
const OTHER_PLATFORM = randomUUID();
const ORG = randomUUID();
const DAY = 86_400;
const HOUR = 3600;

/** Answers `auth_fault` for the requests it is told to, otherwise `transient` (the request stays `sending`). */
class ScriptedPayment implements PaymentClient {
  readonly authFault = new Set<string>();
  calls: string[] = [];
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    this.calls.push(body.paymentRequestId);
    return this.authFault.has(body.paymentRequestId) ? { kind: 'auth_fault' } : { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}

describeWithEnv('Core V2 G3 stalled-work review (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let t2: TestApp;
  let admin: pg.Pool;
  let sweep: StalledWorkService;
  let sweep2: StalledWorkService;
  const auth = new FakeAuth();
  const payment = new ScriptedPayment();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingstalled');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    await auth.start();
    auth.identities.set('owner-tok', { userId: randomUUID(), kind: 'owner', companyId: COMPANY });
    auth.identities.set('other-owner-tok', { userId: randomUUID(), kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set('member-tok', { userId: randomUUID(), kind: 'member', companyId: null });
    auth.platforms.set(PLATFORM, COMPANY);
    auth.platforms.set(OTHER_PLATFORM, OTHER_COMPANY);
    const ownerAuthority = new HttpOwnerAuthority({ baseUrl: auth.url });
    t = await createTestApp({ databaseUrl: db.url, ownerAuthority, paymentClient: payment });
    t2 = await createTestApp({ databaseUrl: db.url, ownerAuthority, paymentClient: payment }); // a second instance on the same database
    sweep = t.app.get(StalledWorkService);
    sweep2 = t2.app.get(StalledWorkService);
    await fixture(async (q) => {
      await q.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3), ($4, $5, 'TND', $3)`,
        [PLATFORM, COMPANY, randomUUID(), OTHER_PLATFORM, OTHER_COMPANY]);
    });
  });
  afterAll(async () => {
    await t2?.app.close();
    await t?.app.close();
    await auth.stop();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(() => auth.reset());

  /** A labelled-fixture transaction: triggers and foreign keys off for the subject rows only (never for a review or exit row). */
  async function fixture(fn: (q: pg.PoolClient) => Promise<void>): Promise<void> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  let seq = 0;
  /** An invoice of `seller`, with one line of a product on `platform` (or none), and a payment request in `status`. */
  async function request(o: { seller: 'company' | 'other_company' | 'organization'; platform?: string | null; status?: 'sending' | 'requested'; sendingAgeS?: number;
    sendAttempts?: number; paymentId?: string }): Promise<{ id: string; invoiceId: string; paymentId: string | null }> {
    seq += 1;
    const invoiceId = randomUUID();
    const id = randomUUID();
    const sellerType = o.seller === 'organization' ? 'organization' : 'company';
    const sellerId = o.seller === 'organization' ? ORG : o.seller === 'company' ? COMPANY : OTHER_COMPANY;
    const status = o.status ?? 'sending';
    const paymentId = status === 'requested' ? (o.paymentId ?? randomUUID()) : null;
    await fixture(async (q) => {
      await q.query(`INSERT INTO invoice (id, producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "sourceType", "sourceId", currency,
          subtotal, total, "issuerSnapshot", "billToSnapshot", "organizationId", status, number, "issuedAt", presentation)
        VALUES ($1, 'test-producer', $2, repeat('a', 64), $3, $4, 'user', 'payer-1', 'contract', $5, 'TND', 100, 100, '{"schemaVersion":1}', '{"schemaVersion":1}', $6,
                'open', 'INV-' || $5, now(), '{"schemaVersion":1,"template":"system:1","locale":"fr"}')`,
        [invoiceId, randomUUID(), sellerType, sellerId, `src-${seq}`, ORG]);
      if (o.platform !== null) {
        const productId = randomUUID();
        await q.query(`INSERT INTO product (id, producer, "sellerType", "sellerId", code, name, "platformId") VALUES ($1, 'test-producer', $2, $3, $4, 'Product', $5)`,
          [productId, sellerType, sellerId, `p-${seq}`, o.platform ?? PLATFORM]);
        await q.query(`INSERT INTO invoice_line ("invoiceId", currency, "lineNumber", "priceId", "productId", "productCode", description, quantity, "unitAmount", "lineTotal",
            "entitlementKind", "interval") VALUES ($1, 'TND', 1, $2, $3, $4, 'Line', 1, 100, 100, 'none', 'one_time')`, [invoiceId, randomUUID(), productId, `p-${seq}`]);
      }
      await q.query(`INSERT INTO payment_request (id, "invoiceId", amount, currency, "createdByType", status, "sendingSince", "sendAttempts", "paymentId", revision, "mappingVersion")
        VALUES ($1, $2, 100, 'TND', 'system', $3, CASE WHEN $3 = 'sending' THEN now() END, $4, $5, $6, 1)`,
        [id, invoiceId, status, o.sendAttempts ?? 1, paymentId, status === 'sending' ? 1 : 2]);
      await q.query(`INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType", "occurredAt")
        VALUES ('payment_request', $1, NULL, 'created', 0, 'system', 'dispatcher', now() - make_interval(secs => $2 + 1)),
               ('payment_request', $1, 'created', 'sending', 1, 'system', 'dispatcher', now() - make_interval(secs => $2))`, [id, o.sendingAgeS ?? 60]);
    });
    return { id, invoiceId, paymentId };
  }

  /** A cash-collected assistance request on `platform` (collected `collectedAgeS` ago, so settleBy = collected + 72 h). */
  async function assistanceRequest(platform: string, collectedAgeS: number): Promise<{ id: string; beneficiary: string }> {
    const id = randomUUID();
    const beneficiary = randomUUID();
    await fixture(async (q) => {
      await q.query(`INSERT INTO assistance_request (id, "beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount",
          "totalAmount", consent, "consentAt", status, "cashCollectedAt", "reportedAt", "reportedBy", "settleBy")
        VALUES ($1, $2, $3, $4, $5, $6, 'TND', 100, 0, 100, true, now() - make_interval(secs => $7 + 10), 'cash_collected', now() - make_interval(secs => $7),
                now() - make_interval(secs => $7 - 1), $8, now() - make_interval(secs => $7) + interval '72 hours')`,
        [id, beneficiary, ORG, platform, randomUUID(), randomUUID(), collectedAgeS, randomUUID()]);
    });
    return { id, beneficiary };
  }

  async function dispute(platform: string, reason: string, ageS: number): Promise<string> {
    const a = await assistanceRequest(platform, ageS + DAY);
    const id = randomUUID();
    await fixture(async (q) => {
      await q.query(`INSERT INTO assistance_dispute (id, "assistanceRequestId", "beneficiaryUserId", "organizationId", "reasonCode", "openedAt")
        VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`, [id, a.id, a.beneficiary, ORG, reason, ageS]);
    });
    return id;
  }

  /** An uncertain channel whose request is `sending`, on an assistance request collected `collectedAgeS` ago. */
  async function uncertainChannel(platform: string, collectedAgeS: number): Promise<{ channel: string; request: string }> {
    const a = await assistanceRequest(platform, collectedAgeS);
    const r = await request({ seller: 'company', platform });
    const channel = randomUUID();
    await fixture(async (q) => {
      await q.query(`INSERT INTO assistance_settlement_channel (id, "assistanceRequestId", "invoiceId", "paymentRequestId", status, "startedBy") VALUES ($1, $2, $3, $4, 'uncertain', $5)`,
        [channel, a.id, r.invoiceId, r.id, randomUUID()]);
    });
    return { channel, request: r.id };
  }

  async function conflict(o: { eventId?: string; paymentRequestId: string | null; paymentId: string | null }): Promise<string> {
    return (await admin.query<{ id: string }>(`INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", "paymentId", outcome, "detailCode", "causeType")
      VALUES ($1, 'payment.succeeded', $2, $3, 'conflict', 'amount_mismatch', 'payment_event') RETURNING id`,
      [o.eventId ?? randomUUID(), o.paymentRequestId, o.paymentId])).rows[0]!.id;
  }

  /** A REAL status move of a sending request (lifecycle triggers on), with its history row in the same transaction (BI-19). */
  async function move(id: string, to: 'requested' | 'rejected'): Promise<void> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      const rev = (await c.query(`UPDATE payment_request SET status = $2, "paymentId" = CASE WHEN $2 = 'requested' THEN $3::uuid END WHERE id = $1 RETURNING revision`,
        [id, to, randomUUID()])).rows[0].revision;
      await c.query(`INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") VALUES ('payment_request', $1, 'sending', $2, $3, 'system', 'reconciliation')`,
        [id, to, rev]);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  const reviewsOf = async (subject: string) => (await admin.query(`SELECT * FROM stalled_work_review WHERE "subjectId" = $1 OR "episodeKey" = $1 ORDER BY "escalatedAt"`, [subject])).rows;
  const auditOf = async (reviewId: string) => (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [reviewId])).rows;
  const get = async (path: string, bearer: string) => fetch(`${await t.app.getUrl()}${path}`, { headers: { authorization: `Bearer ${bearer}` } });

  describe('thresholds, authoritative clocks and episodes', () => {
    it('escalates exactly the subjects past their threshold, from the authoritative clock, once per episode', async () => {
      const d31due = await dispute(PLATFORM, 'cash_not_returned', 31 * DAY);
      const d31early = await dispute(PLATFORM, 'collection_not_made', 29 * DAY);
      const d31other = await dispute(PLATFORM, 'collection_time_incorrect', 60 * DAY); // not a J-1 reason: never DO-31
      const c33due = await uncertainChannel(PLATFORM, 3 * DAY + 8 * DAY); // settleBy + 8 days
      const c33early = await uncertainChannel(PLATFORM, 3 * DAY + 6 * DAY); // settleBy + 6 days
      const r41age = await request({ seller: 'company', sendingAgeS: 25 * HOUR }); // sendingSince is fresh: the transition is the clock
      const r41attempts = await request({ seller: 'company', sendingAgeS: 60, sendAttempts: 20 });
      const r41early = await request({ seller: 'company', sendingAgeS: 23 * HOUR, sendAttempts: 19 });

      await sweep.sweepOnce();

      expect(await reviewsOf(d31due)).toMatchObject([{ kind: 'assistance_dispute_open', reason: 'elapsed', thresholdSeconds: 30 * DAY, companyId: COMPANY, platformId: PLATFORM }]);
      for (const s of [d31early, d31other, c33early.channel, r41early.id]) expect(await reviewsOf(s)).toEqual([]);
      const [c] = await reviewsOf(c33due.channel);
      expect(c).toMatchObject({ kind: 'settlement_channel_uncertain', observedState: 'uncertain', paymentRequestId: c33due.request, thresholdSeconds: 7 * DAY, platformId: PLATFORM });
      const settleBy = (await admin.query(`SELECT a."settleBy" FROM assistance_settlement_channel c JOIN assistance_request a ON a.id = c."assistanceRequestId" WHERE c.id = $1`, [c33due.channel])).rows[0].settleBy;
      expect(c.anchorAt).toEqual(settleBy);
      const [a] = (await reviewsOf(r41age.id)).filter((r) => r.kind === 'payment_request_sending');
      const sendingAt = (await admin.query(`SELECT "occurredAt" FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'sending'`, [r41age.id])).rows[0].occurredAt;
      expect(a).toMatchObject({ reason: 'elapsed', thresholdSeconds: 24 * HOUR, companyId: COMPANY, platformId: PLATFORM, organizationId: ORG });
      expect(a.anchorAt).toEqual(sendingAt); // the transition, never the re-stamped sendingSince
      expect((await reviewsOf(r41attempts.id)).filter((r) => r.kind === 'payment_request_sending')).toMatchObject([{ reason: 'send_attempts', sendAttempts: 20 }]);
      // the channel's request is itself a DO-41 subject only once IT is due (24 h): both records are kept for evidence, separately
      expect((await reviewsOf(c33due.request)).filter((r) => r.kind === 'payment_request_sending')).toEqual([]);

      // a second pass, and a pass on a second instance, add nothing
      const before = (await admin.query(`SELECT count(*)::int AS n FROM stalled_work_review`)).rows[0].n;
      await sweep.sweepOnce();
      await sweep2.sweepOnce();
      expect((await admin.query(`SELECT count(*)::int AS n FROM stalled_work_review`)).rows[0].n).toBe(before);
      const audit = await auditOf(a.id);
      expect(audit.map((x) => x.name)).toEqual(['audit.stalled_work.escalated']);
      expect(audit[0].payload).toMatchObject({ actor: { type: 'system', id: 'stalled_work_sweep' },
        changes: { kind: 'payment_request_sending', subject_id: r41age.id, reason: 'elapsed', threshold_seconds: 86400, payment_request_id: r41age.id } });
      expect(AUDIT_CATALOG.get('stalled_work.escalated')!.category).toBe('commercial');
    });

    it('DO-42: one review per conflicting EVENT however many receipts; a trusted request only gives a scope; nothing is inferred otherwise', async () => {
      const trusted = await request({ seller: 'company', status: 'requested' });
      const ev = randomUUID();
      const r1 = await conflict({ eventId: ev, paymentRequestId: trusted.id, paymentId: trusted.paymentId });
      await conflict({ eventId: ev, paymentRequestId: trusted.id, paymentId: trusted.paymentId }); // a redelivery
      await conflict({ eventId: ev, paymentRequestId: trusted.id, paymentId: trusted.paymentId }); // a reconciler pass
      const unknownRequest = await conflict({ paymentRequestId: randomUUID(), paymentId: randomUUID() });
      const mismatched = await conflict({ paymentRequestId: trusted.id, paymentId: randomUUID() }); // names our request, but another payment
      const noPayment = await conflict({ paymentRequestId: trusted.id, paymentId: null });

      await Promise.all([sweep.sweepOnce(), sweep2.sweepOnce()]); // two instances at once

      const forEvent = (await admin.query(`SELECT * FROM stalled_work_review WHERE kind = 'payment_event_conflict' AND "episodeKey" = $1`, [ev])).rows;
      expect(forEvent).toHaveLength(1);
      expect(forEvent[0]).toMatchObject({ subjectId: r1, reason: 'conflict_observed', thresholdSeconds: 0, paymentRequestId: trusted.id, companyId: COMPANY, platformId: PLATFORM, organizationId: ORG });
      expect((await auditOf(forEvent[0].id)).map((x) => x.name)).toEqual(['audit.stalled_work.escalated']);
      for (const s of [unknownRequest, mismatched, noPayment]) {
        expect((await admin.query(`SELECT "paymentRequestId", "companyId", "platformId", "organizationId" FROM stalled_work_review WHERE "subjectId" = $1`, [s])).rows)
          .toEqual([{ paymentRequestId: null, companyId: null, platformId: null, organizationId: null }]); // Billing-internal
      }
    });
  });

  describe('auth_fault (DO-41): immediate, Billing-internal, security', () => {
    it('one internal review per request, scope NULL even for a Company seller; the request keeps retrying; a separate security action', async () => {
      const r = await request({ seller: 'company', sendingAgeS: 120 });
      await admin.query(`UPDATE payment_request SET "sendingSince" = now() - interval '1 hour' WHERE id = $1`, [r.id]); // stale: the dispatcher re-claims it
      payment.authFault.add(r.id);
      const dispatcher = t.app.get(PaymentDispatcher);
      await dispatcher.dispatchOnce(60_000, 100);
      await admin.query(`UPDATE payment_request SET "sendingSince" = now() - interval '1 hour' WHERE id = $1`, [r.id]);
      await dispatcher.dispatchOnce(60_000, 100);
      const rows = (await reviewsOf(r.id)).filter((x) => x.kind === 'payment_request_auth_fault');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ reason: 'auth_fault', thresholdSeconds: 0, companyId: null, platformId: null, organizationId: null, paymentRequestId: r.id });
      expect((await admin.query(`SELECT status, "sendAttempts" FROM payment_request WHERE id = $1`, [r.id])).rows[0]).toEqual({ status: 'sending', sendAttempts: 3 }); // retry unaffected
      const audit = await auditOf(rows[0].id);
      expect(audit.map((x) => x.name)).toEqual(['audit.stalled_work.auth_fault_escalated']);
      expect(audit[0].payload).toMatchObject({ actor: { type: 'system', id: 'payment_dispatcher' }, changes: { payment_request_id: r.id } });
      expect(audit[0].payload.organizationId ?? null).toBeNull();
      expect(AUDIT_CATALOG.get('stalled_work.auth_fault_escalated')!.category).toBe('security');
      // the database refuses a scoped auth_fault row even if the guard were bypassed
      await expect(fixture(async (q) => {
        await q.query(`INSERT INTO stalled_work_review (kind, "subjectId", "episodeKey", "observedState", "anchorAt", "thresholdSeconds", reason, "companyId")
          VALUES ('payment_request_auth_fault', $1, $2, 'sending', now(), 0, 'auth_fault', $3)`, [randomUUID(), randomUUID(), COMPANY]);
      })).rejects.toMatchObject({ constraint: 'stalled_work_review_auth_fault_internal' });
      payment.authFault.delete(r.id);
    });
  });

  describe('exit observations', () => {
    it('one exit row and one audit intent when the subject leaves its state; the subject and the review are untouched by the sweep; no exit for a conflict', async () => {
      const r = await request({ seller: 'company', sendingAgeS: 30 * HOUR });
      const ch = await uncertainChannel(PLATFORM, 3 * DAY + 8 * DAY);
      await sweep.sweepOnce();
      const [review] = (await reviewsOf(r.id)).filter((x) => x.kind === 'payment_request_sending');
      const [chReview] = await reviewsOf(ch.channel);
      expect(review).toBeDefined();
      await sweep.sweepOnce();
      expect((await admin.query(`SELECT count(*)::int AS n FROM stalled_work_exit WHERE "reviewId" = ANY($1::uuid[])`, [[review.id, chReview.id]])).rows[0].n).toBe(0); // still stuck

      // the real transitions (lifecycle triggers on): the request becomes requested; the channel follows it to open
      await move(r.id, 'requested');
      await move(ch.request, 'requested');
      const subjectBefore = (await admin.query(`SELECT * FROM payment_request WHERE id = ANY($1::uuid[]) ORDER BY id`, [[r.id, ch.request]])).rows;
      const reviewBefore = (await admin.query(`SELECT * FROM stalled_work_review WHERE id = ANY($1::uuid[]) ORDER BY id`, [[review.id, chReview.id]])).rows;
      await sweep.sweepOnce();
      await sweep2.sweepOnce();
      expect((await admin.query(`SELECT "reviewId", "exitedState" FROM stalled_work_exit WHERE "reviewId" = ANY($1::uuid[]) ORDER BY "exitedState"`, [[review.id, chReview.id]])).rows)
        .toEqual([{ reviewId: chReview.id, exitedState: 'open' }, { reviewId: review.id, exitedState: 'requested' }].sort((x, y) => x.exitedState.localeCompare(y.exitedState)));
      expect((await auditOf(review.id)).map((x) => x.name)).toEqual(['audit.stalled_work.escalated', 'audit.stalled_work.state_exited']);
      expect((await auditOf(chReview.id)).map((x) => x.name)).toEqual(['audit.stalled_work.escalated', 'audit.stalled_work.state_exited']);
      expect((await admin.query(`SELECT * FROM payment_request WHERE id = ANY($1::uuid[]) ORDER BY id`, [[r.id, ch.request]])).rows).toEqual(subjectBefore);
      expect((await admin.query(`SELECT * FROM stalled_work_review WHERE id = ANY($1::uuid[]) ORDER BY id`, [[review.id, chReview.id]])).rows).toEqual(reviewBefore);

      const conflictReviews = (await admin.query(`SELECT id FROM stalled_work_review WHERE kind = 'payment_event_conflict'`)).rows.map((x) => x.id);
      expect((await admin.query(`SELECT count(*)::int AS n FROM stalled_work_exit WHERE "reviewId" = ANY($1::uuid[])`, [conflictReviews])).rows[0].n).toBe(0);
    });

    it('an auth_fault review exits with its own security action', async () => {
      const r = await request({ seller: 'organization', sendingAgeS: 120 });
      await admin.query(`UPDATE payment_request SET "sendingSince" = now() - interval '1 hour' WHERE id = $1`, [r.id]);
      payment.authFault.add(r.id);
      await t.app.get(PaymentDispatcher).dispatchOnce(60_000, 100);
      payment.authFault.delete(r.id);
      const [review] = (await reviewsOf(r.id)).filter((x) => x.kind === 'payment_request_auth_fault');
      expect(review).toMatchObject({ organizationId: null }); // an Organization seller too: never scoped
      await move(r.id, 'rejected');
      await sweep.sweepOnce();
      expect((await auditOf(review.id)).map((x) => x.name)).toEqual(['audit.stalled_work.auth_fault_escalated', 'audit.stalled_work.auth_fault_exited']);
      expect(AUDIT_CATALOG.get('stalled_work.auth_fault_exited')!.category).toBe('security');
    });
  });

  describe('database guards', () => {
    it('refuses a review that is not due, derives every column itself, and keeps reviews and exits append-only', async () => {
      const early = await request({ seller: 'company', sendingAgeS: HOUR });
      await expect(admin.query(`INSERT INTO stalled_work_review (kind, "subjectId") VALUES ('payment_request_sending', $1)`, [early.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'stalled_work_review_not_due' });
      await expect(admin.query(`INSERT INTO stalled_work_review (kind, "subjectId") VALUES ('assistance_dispute_open', $1)`, [randomUUID()]))
        .rejects.toMatchObject({ constraint: 'stalled_work_review_not_due' }); // no such subject
      const due = await request({ seller: 'company', sendingAgeS: 26 * HOUR });
      // forged columns are overwritten by the derived ones
      const forged = (await admin.query(`INSERT INTO stalled_work_review (kind, "subjectId", "episodeKey", "observedState", "anchorAt", "thresholdSeconds", reason, "companyId", "platformId")
        VALUES ('payment_request_sending', $1, $2, 'paid', now(), 1, 'auth_fault', $3, $4) RETURNING *`, [due.id, randomUUID(), OTHER_COMPANY, OTHER_PLATFORM])).rows[0];
      expect(forged).toMatchObject({ episodeKey: due.id, observedState: 'sending', thresholdSeconds: 24 * HOUR, reason: 'elapsed', companyId: COMPANY, platformId: PLATFORM });
      await expect(admin.query(`UPDATE stalled_work_review SET reason = 'send_attempts' WHERE id = $1`, [forged.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM stalled_work_review WHERE id = $1`, [forged.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`TRUNCATE stalled_work_review CASCADE`)).rejects.toMatchObject({ code: '23514' });
      // an exit is refused while the subject is still sending
      await expect(admin.query(`INSERT INTO stalled_work_exit ("reviewId", "exitedState") VALUES ($1, 'requested')`, [forged.id]))
        .rejects.toMatchObject({ constraint: 'stalled_work_exit_not_exited' });
      await move(due.id, 'requested');
      const x = (await admin.query(`INSERT INTO stalled_work_exit ("reviewId", "exitedState") VALUES ($1, 'forged') RETURNING *`, [forged.id])).rows[0];
      expect(x.exitedState).toBe('requested'); // derived
      await expect(admin.query(`UPDATE stalled_work_exit SET "exitedState" = 'rejected' WHERE "reviewId" = $1`, [forged.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM stalled_work_exit WHERE "reviewId" = $1`, [forged.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('a failed audit intent writes no review (one transaction); the next pass escalates it once', async () => {
      const r = await request({ seller: 'company', sendingAgeS: 27 * HOUR });
      await admin.query(`CREATE FUNCTION pg_temp_fail_stalled() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.stalled_work.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_fail_stalled BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_stalled()`);
      try {
        await sweep.sweepOnce();
        expect((await reviewsOf(r.id)).filter((x) => x.kind === 'payment_request_sending')).toEqual([]);
      } finally {
        await admin.query(`DROP TRIGGER zz_fail_stalled ON outbox`);
        await admin.query(`DROP FUNCTION pg_temp_fail_stalled()`);
      }
      await sweep.sweepOnce();
      const rows = (await reviewsOf(r.id)).filter((x) => x.kind === 'payment_request_sending');
      expect(rows).toHaveLength(1);
      expect((await auditOf(rows[0].id)).map((x) => x.name)).toEqual(['audit.stalled_work.escalated']);
    });

    it('changes no subject: payment requests, assistance rows and receipts are byte-identical across passes', async () => {
      await request({ seller: 'company', sendingAgeS: 40 * HOUR });
      await dispute(PLATFORM, 'cash_not_returned', 45 * DAY);
      const snap = async () => ({
        requests: (await admin.query(`SELECT * FROM payment_request ORDER BY id`)).rows,
        transitions: (await admin.query(`SELECT count(*)::int AS n FROM billing_transition`)).rows,
        disputes: (await admin.query(`SELECT * FROM assistance_dispute ORDER BY id`)).rows,
        channels: (await admin.query(`SELECT * FROM assistance_settlement_channel ORDER BY id`)).rows,
        receipts: (await admin.query(`SELECT * FROM payment_event_receipt ORDER BY id`)).rows,
        obligations: (await admin.query(`SELECT count(*)::int AS n FROM cash_return_obligation`)).rows,
        cases: (await admin.query(`SELECT count(*)::int AS n FROM reconciliation_case`)).rows,
        events: (await admin.query(`SELECT count(*)::int AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).rows,
      });
      const before = await snap();
      await sweep.sweepOnce();
      await sweep2.sweepOnce();
      expect(await snap()).toEqual(before);
    });
  });

  describe('Owner visibility', () => {
    it('the Company Owner reads only their Company\'s payment items with a visible Platform; never auth_fault or an untrusted conflict; another Company sees none', async () => {
      const mine = await request({ seller: 'company', sendingAgeS: 50 * HOUR });
      const hidden = await request({ seller: 'company', platform: OTHER_PLATFORM, sendingAgeS: 50 * HOUR }); // a Platform this Owner may not access
      const theirs = await request({ seller: 'other_company', platform: OTHER_PLATFORM, sendingAgeS: 50 * HOUR });
      await sweep.sweepOnce();
      const res = await get('/billing/admin/stalled-work?limit=200', 'owner-tok');
      expect(res.status).toBe(200);
      const items = (await res.json()).items as Array<{ kind: string; subjectId: string; paymentRequestId: string | null }>;
      expect(items.some((i) => i.subjectId === mine.id)).toBe(true);
      expect(items.some((i) => i.subjectId === hidden.id || i.subjectId === theirs.id)).toBe(false);
      expect(items.every((i) => i.kind === 'payment_request_sending' || i.kind === 'payment_event_conflict')).toBe(true);
      expect(items.every((i) => i.kind !== 'payment_event_conflict' || i.paymentRequestId !== null)).toBe(true); // untrusted conflicts are internal
      const other = (await (await get('/billing/admin/stalled-work?limit=200', 'other-owner-tok')).json()).items as Array<{ subjectId: string }>;
      expect(other.some((i) => i.subjectId === theirs.id)).toBe(true);
      expect(other.some((i) => i.subjectId === mine.id)).toBe(false);
      expect((await get('/billing/admin/stalled-work', 'member-tok')).status).toBe(403);
      expect((await get('/billing/admin/stalled-work', 'unknown-tok')).status).toBe(401);
      expect((await get('/billing/admin/stalled-work?limit=0', 'owner-tok')).status).toBe(400);
    });

    it('the Platform Owner reads one Platform\'s assistance items under Auth\'s live Platform check; any other Platform is 404; no payment kinds', async () => {
      const mine = await dispute(PLATFORM, 'cash_not_returned', 40 * DAY);
      const theirs = await dispute(OTHER_PLATFORM, 'collection_not_made', 40 * DAY);
      await sweep.sweepOnce();
      const res = await get(`/billing/admin/assistance-stalled-work?platformId=${PLATFORM}&limit=200`, 'owner-tok');
      expect(res.status).toBe(200);
      const items = (await res.json()).items as Array<{ kind: string; subjectId: string }>;
      expect(items.some((i) => i.subjectId === mine)).toBe(true);
      expect(items.some((i) => i.subjectId === theirs)).toBe(false);
      expect(items.every((i) => i.kind === 'assistance_dispute_open' || i.kind === 'settlement_channel_uncertain')).toBe(true);
      expect((await get(`/billing/admin/assistance-stalled-work?platformId=${OTHER_PLATFORM}`, 'owner-tok')).status).toBe(404);
      expect((await get(`/billing/admin/assistance-stalled-work?platformId=${PLATFORM}`, 'other-owner-tok')).status).toBe(404);
      expect((await get(`/billing/admin/assistance-stalled-work?platformId=${PLATFORM}`, 'member-tok')).status).toBe(403);
      expect((await get(`/billing/admin/assistance-stalled-work?platformId=not-a-uuid`, 'owner-tok')).status).toBe(400);
      // the Company route never carries an assistance item
      const company = (await (await get('/billing/admin/stalled-work?limit=200', 'owner-tok')).json()).items as Array<{ subjectId: string }>;
      expect(company.some((i) => i.subjectId === mine)).toBe(false);
    });
  });

  describe('production and configuration', () => {
    it('never sweeps or records in production (the module is not mounted; the service refuses too); thresholds are not configuration', async () => {
      const prodConfig = { isProduction: true, stalledWorkSweep: { intervalMs: 300_000 } } as unknown as BillingConfig;
      const refusingDb = { query: () => { throw new Error('no database access in production'); }, tx: () => { throw new Error('no database access in production'); } } as unknown as DbService;
      const s = new StalledWorkService(refusingDb, t.app.get(StalledWorkService)['audit'], prodConfig);
      await expect(s.sweepOnce()).resolves.toEqual({ escalated: 0, exited: 0 });
      await expect(s.recordAuthFault(randomUUID(), 'corr-prod-0001')).resolves.toBeUndefined();
      const cfg = loadBillingConfig({ NODE_ENV: 'test', DATABASE_URL: db.url, AUTH_SERVICE_URL: 'http://auth.invalid', BILLING_SUPPORTED_CURRENCIES: 'TND',
        PAYMENT_SERVICE_URL: 'http://payment.invalid', PAYMENT_SERVICE_TOKEN: 'test-only-payment-service-token-not-a-real-secret-000', BILLING_STALLED_WORK_THRESHOLD_DAYS: '1' });
      expect(Object.keys(cfg.stalledWorkSweep)).toEqual(['intervalMs']);
      expect((await admin.query(`SELECT extract(epoch FROM billing_stalled_work_threshold('assistance_dispute_open'))::int AS d31,
        extract(epoch FROM billing_stalled_work_threshold('settlement_channel_uncertain'))::int AS d33, extract(epoch FROM billing_stalled_work_threshold('payment_request_sending'))::int AS d41,
        billing_stalled_work_send_attempts() AS attempts, extract(epoch FROM billing_stalled_work_threshold('payment_event_conflict'))::int AS d42`)).rows[0])
        .toEqual({ d31: 30 * DAY, d33: 7 * DAY, d41: 24 * HOUR, attempts: 20, d42: 0 });
    });
  });
});
