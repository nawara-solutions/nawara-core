import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import {
  INVOICE_STATUSES, PAYMENT_REQUEST_STATUSES, SUBSCRIPTION_STATUSES, canTransitionInvoice, canTransitionPaymentRequest, canTransitionSubscription,
  type InvoiceStatus, type PaymentRequestStatus, type SubscriptionStatus,
} from '../src/domain/state-machines.js';
import { describeWithEnv } from './support/env.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PRESENTATION = JSON.stringify({ schemaVersion: 1, template: 'system:1', locale: 'fr' });

/**
 * The transition tables exist twice (TypeScript, database trigger). This proves they cannot drift: for EVERY (from, to) pair the trigger
 * refuses exactly what the TypeScript table refuses. A pair the table allows may still be refused for a DIFFERENT, specific reason
 * (issuing needs a presentation, paying needs a paid request); what must never happen is "cannot move" for an allowed pair, or success for a
 * forbidden one. Rows are placed in each `from` state with triggers off (only to construct the situation), then moved with triggers ON.
 */
describeWithEnv('TypeScript and database state machines agree on every pair (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingagree');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    pool = new pg.Pool({ connectionString: db.url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  /** Runs `fn` on one connection with the guard triggers off; used ONLY to construct a starting row. */
  async function unguarded<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      return await fn(c);
    } finally {
      await c.query('RESET session_replication_role');
      c.release();
    }
  }

  const invoiceColumns: Record<InvoiceStatus, string> = {
    draft: '',
    open: `, number = gen_random_uuid()::text, "issuedAt" = now(), presentation = '${PRESENTATION}'::jsonb`,
    paid: `, number = gen_random_uuid()::text, "issuedAt" = now(), presentation = '${PRESENTATION}'::jsonb, "paidAt" = now()`,
    void: `, "voidedAt" = now(), "voidReasonCode" = 'discarded'`,
  };

  async function makeInvoice(status: InvoiceStatus): Promise<string> {
    return unguarded(async (c) => {
      const id = crypto.randomUUID();
      await c.query(
        `INSERT INTO invoice (id, producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
         VALUES ($1, 'test-producer', $2, repeat('a', 64), 'organization', $3::text, 'user', 'user-1', $3::uuid, 'contract', 's', 'TND', 10, 10, '{"schemaVersion":1}', '{"schemaVersion":1}')`,
        [id, crypto.randomUUID(), ORG],
      );
      if (status !== 'draft') await c.query(`UPDATE invoice SET status = '${status}'${invoiceColumns[status]} WHERE id = $1`, [id]);
      return id;
    });
  }

  const requestColumns: Record<PaymentRequestStatus, string> = {
    created: '',
    sending: `, "sendingSince" = now()`,
    requested: `, "paymentId" = gen_random_uuid()`,
    paid: `, "paymentId" = gen_random_uuid(), "closedAt" = now()`,
    failed: `, "paymentId" = gen_random_uuid(), "closedAt" = now()`,
    expired: `, "paymentId" = gen_random_uuid(), "closedAt" = now()`,
    cancelled: `, "closedAt" = now()`,
    rejected: `, "closedAt" = now()`,
  };

  async function makeRequest(status: PaymentRequestStatus): Promise<string> {
    const invoiceId = await makeInvoice('open');
    return unguarded(async (c) => {
      const id = crypto.randomUUID();
      await c.query(`INSERT INTO payment_request (id, "invoiceId", amount, currency, "createdByType") VALUES ($1, $2, 10, 'TND', 'system')`, [id, invoiceId]);
      if (status !== 'created') await c.query(`UPDATE payment_request SET status = '${status}'${requestColumns[status]} WHERE id = $1`, [id]);
      return id;
    });
  }

  /** Attempts the move with triggers ON. Returns null on success or the database's message. The history row is written in the same transaction so BI-19 never masks the answer. */
  async function attempt(table: 'invoice' | 'payment_request' | 'subscription', id: string, from: string, to: string): Promise<string | null> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      const { rows } = await c.query(`UPDATE ${table} SET status = $2 WHERE id = $1 RETURNING revision`, [id, to]);
      await c.query(
        `INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "causeType") VALUES ($1, $2, $3, $4, $5, 'system', 'request')`,
        [table, id, from, to, rows[0].revision],
      );
      await c.query('ROLLBACK'); // never commit: the point is only whether the move is refused as a state transition
      return null;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      return (e as Error).message;
    } finally {
      c.release();
    }
  }

  const subscriptionColumns: Record<SubscriptionStatus, string> = {
    pending: '',
    active: `, "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01'`,
    grace: `, "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01', "graceUntil" = '2026-02-08'`,
    expired: `, "currentPeriodStart" = '2026-01-01', "currentPeriodEnd" = '2026-02-01'`,
  };

  /** A product + its immutable, recurring price, and a subscription against it, placed directly in `status` with triggers off. */
  async function makeSubscription(status: SubscriptionStatus): Promise<string> {
    return unguarded(async (c) => {
      const productId = crypto.randomUUID();
      const priceId = crypto.randomUUID();
      await c.query(
        `INSERT INTO product (id, producer, "sellerType", "sellerId", code, name) VALUES ($1, 'test-producer', 'organization', $2, $3, 'A product')`,
        [productId, ORG, `sub-${crypto.randomUUID().slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO price (id, "productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount")
         VALUES ($1, $2, $3, 'TND', 1000, 'recurring', 'month', 1)`,
        [priceId, productId, crypto.randomUUID()],
      );
      const id = crypto.randomUUID();
      await c.query(`INSERT INTO subscription (id, "organizationId", "productId", "priceId") VALUES ($1, $2, $3, $4)`, [id, crypto.randomUUID(), productId, priceId]);
      if (status !== 'pending') await c.query(`UPDATE subscription SET status = '${status}'${subscriptionColumns[status]} WHERE id = $1`, [id]);
      return id;
    });
  }

  it('invoice: all 16 pairs — the trigger refuses "cannot move" exactly where the TypeScript table forbids it', async () => {
    let checked = 0;
    for (const from of INVOICE_STATUSES) {
      for (const to of INVOICE_STATUSES) {
        const message = await attempt('invoice', await makeInvoice(from), from, to);
        const refusedAsMove = message !== null && /cannot move from/.test(message);
        if (from === to) continue; // not a change: the lifecycle trigger has nothing to decide
        expect(refusedAsMove, `${from} -> ${to}: ${message}`).toBe(!canTransitionInvoice(from, to));
        checked += 1;
      }
    }
    expect(checked).toBe(12);
  });

  it('payment request: all 56 distinct pairs — the trigger refuses "cannot move" exactly where the TypeScript table forbids it', async () => {
    let checked = 0;
    for (const from of PAYMENT_REQUEST_STATUSES) {
      for (const to of PAYMENT_REQUEST_STATUSES) {
        if (from === to) continue;
        const message = await attempt('payment_request', await makeRequest(from), from, to);
        // a closed request is refused with "is closed", also a refusal of the move: both mean the TypeScript table must forbid it
        const refused = message !== null && /cannot move from|is closed/.test(message);
        expect(refused, `${from} -> ${to}: ${message}`).toBe(!canTransitionPaymentRequest(from, to));
        checked += 1;
      }
    }
    expect(checked).toBe(56);
  });

  it('subscription: all 16 pairs, INCLUDING the active->active self-loop — the trigger refuses exactly where the TypeScript table forbids it', async () => {
    let checked = 0;
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const to of SUBSCRIPTION_STATUSES) {
        // Unlike invoice/payment_request, a same-status move IS meaningful here (active->active is the renewal/cancellation-toggle
        // self-loop) and must be attempted, not skipped — the lifecycle trigger refuses every OTHER self-loop explicitly.
        const message = await attempt('subscription', await makeSubscription(from), from, to);
        const refusedAsMove = message !== null && /cannot move from|has no in-place change/.test(message);
        expect(refusedAsMove, `${from} -> ${to}: ${message}`).toBe(!canTransitionSubscription(from, to));
        checked += 1;
      }
    }
    expect(checked).toBe(16);
  });
});
