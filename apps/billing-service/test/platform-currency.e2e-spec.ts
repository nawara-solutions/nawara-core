import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import { PlatformCurrencyRepository } from '../src/currencies/platform-currency.repository.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const producer: Caller = { kind: 'service', service: 'test-producer' };
const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: 'r1' }, correlationId: 'c1' };
const rejects = (p: Promise<unknown>, status: number, code: string) => expect(p).rejects.toMatchObject({ status, response: { code } });

/** Global currency reference / Platform-supported currencies / historical invoice currency: the three layers stay separate. */
describeWithEnv('platform currency configuration (foundation), against a real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let platforms: PlatformCurrencyRepository;
  let invoices: InvoiceRepository;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingplat');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 5 });
    await admin.query(`INSERT INTO currency (code, exponent) VALUES ('EUR', 2)`); // reference rows are seeded by migration; only TND is (B-005)
    t = await createTestApp({ databaseUrl: db.url, env: { BILLING_SUPPORTED_CURRENCIES: 'TND,EUR' } });
    platforms = t.app.get(PlatformCurrencyRepository);
    invoices = t.app.get(InvoiceRepository);
  });
  afterAll(async () => {
    await t.app.close();
    await admin.end();
    await db.drop();
  });

  it('a Platform enables a currency that exists globally; nothing is permitted until it does', async () => {
    expect(await platforms.isPermitted('platform-a', 'TND')).toBe(false); // no configuration means not permitted
    await rejects(platforms.assertPermitted('platform-a', 'TND'), 422, 'unsupported_currency');
    const row = await platforms.enable('platform-a', 'TND');
    expect(row).toMatchObject({ platformId: 'platform-a', currency: 'TND', enabled: true, revision: 0 });
    expect(await platforms.isPermitted('platform-a', 'TND')).toBe(true);
    await expect(platforms.assertPermitted('platform-a', 'TND')).resolves.toBeUndefined();
  });

  it('a Platform cannot enable a currency the global reference does not contain, and nothing is stored', async () => {
    await rejects(platforms.enable('platform-a', 'XXX'), 422, 'unsupported_currency');
    expect((await admin.query(`SELECT count(*)::int AS n FROM platform_currency WHERE currency = 'XXX'`)).rows[0].n).toBe(0);
  });

  it('configuration is per Platform: enabling for one does not enable for another, and a currency the Platform never enabled is refused', async () => {
    await platforms.enable('platform-b', 'EUR');
    expect(await platforms.isPermitted('platform-b', 'EUR')).toBe(true);
    expect(await platforms.isPermitted('platform-b', 'TND')).toBe(false);
    expect(await platforms.isPermitted('platform-a', 'EUR')).toBe(false);
    expect((await platforms.list('platform-a')).map((r) => r.currency)).toEqual(['TND']);
  });

  it('disabling refuses NEW use; the row and its revision stay; re-enabling restores it; repeating either is a no-op', async () => {
    await platforms.enable('platform-c', 'TND');
    const off = await platforms.disable('platform-c', 'TND');
    expect(off).toMatchObject({ enabled: false, revision: 1 });
    expect(await platforms.isPermitted('platform-c', 'TND')).toBe(false);
    await rejects(platforms.assertPermitted('platform-c', 'TND'), 422, 'unsupported_currency');
    expect((await platforms.disable('platform-c', 'TND')).revision).toBe(1); // already disabled: unchanged
    const on = await platforms.enable('platform-c', 'TND');
    expect(on).toMatchObject({ enabled: true, revision: 2 });
    expect((await platforms.enable('platform-c', 'TND')).revision).toBe(2); // already enabled: unchanged
    expect(await platforms.isPermitted('platform-c', 'TND')).toBe(true);
  });

  it('disabling a currency that was never configured is 404, and does not create a row', async () => {
    await rejects(platforms.disable('platform-c', 'EUR'), 404, 'not_found');
    expect((await admin.query(`SELECT count(*)::int AS n FROM platform_currency WHERE "platformId" = 'platform-c' AND currency = 'EUR'`)).rows[0].n).toBe(0);
  });

  it('an invalid Platform id or currency code is refused before the database is touched', async () => {
    for (const bad of ['', '   ', 'p'.repeat(129)]) await expect(platforms.enable(bad, 'TND')).rejects.toThrow('platformId');
    for (const bad of ['tnd', 'TN', 'TNDX', '']) await expect(platforms.enable('platform-a', bad)).rejects.toThrow('currency');
  });

  it('global currency metadata is not reachable through Platform configuration: the exponent is unchanged by anything the repository does', async () => {
    const exponents = async () => (await admin.query(`SELECT code, exponent FROM currency ORDER BY code`)).rows;
    const before = await exponents();
    await platforms.enable('platform-d', 'EUR');
    await platforms.disable('platform-d', 'EUR');
    await platforms.enable('platform-d', 'EUR');
    expect(await exponents()).toEqual(before);
    expect(before).toEqual([{ code: 'EUR', exponent: 2 }, { code: 'TND', exponent: 3 }]);
    await expect(admin.query(`UPDATE currency SET exponent = 4 WHERE code = 'TND'`)).rejects.toMatchObject({ code: '23514' });
  });

  describe('historical invoices are never changed by Platform configuration', () => {
    async function issueTnd() {
      const seller = crypto.randomUUID();
      const product = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name) VALUES ('test-producer', 'organization', $1, 'plan', 'Plan') RETURNING id`, [seller])).rows[0].id;
      const price = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval") VALUES ($1, 'p', 'TND', 2500, 'one_time') RETURNING id`, [product])).rows[0].id;
      const input = normaliseCreateInvoiceInput({
        invoiceRequestId: crypto.randomUUID(), seller: { type: 'organization', id: seller }, payer: { type: 'user', id: 'user-1' }, sourceType: 'contract', sourceId: 's-1',
        issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: price, quantity: 2 }],
      });
      const draft = (await invoices.createDraft('test-producer', input, ['TND', 'EUR'], ctx)).invoice;
      return (await invoices.issue(draft.id, producer, { template: 'system:1', locale: 'fr' }, ctx)).invoice;
    }

    it('Platform supports TND and EUR, invoice A is TND, the Platform later disables TND: invoice A remains exactly what it was', async () => {
      await platforms.enable('platform-e', 'TND');
      await platforms.enable('platform-e', 'EUR');
      const a = await issueTnd();
      const historyBefore = (await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = $1`, [a.id])).rows[0].n;

      await platforms.disable('platform-e', 'TND');
      expect(await platforms.isPermitted('platform-e', 'TND')).toBe(false); // new work is refused ...
      expect(await platforms.isPermitted('platform-e', 'EUR')).toBe(true);

      const after = await invoices.findForCaller(a.id, producer); // ... the historical record is not
      expect(after).toEqual(a);
      expect(after).toMatchObject({ currency: 'TND', total: '5000', status: 'open', number: a.number, revision: 1 });
      expect(after.lines[0]).toMatchObject({ currency: 'TND', unitAmount: '2500', lineTotal: '5000' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM billing_transition WHERE "entityId" = $1`, [a.id])).rows[0].n).toBe(historyBefore);
      // and it still resolves the immutable exponent from the global reference
      expect((await admin.query(`SELECT c.exponent FROM invoice i JOIN currency c ON c.code = i.currency WHERE i.id = $1`, [a.id])).rows[0].exponent).toBe(3);
    });

    it('no financial table references Platform configuration, so it cannot reach a historical record', async () => {
      const { rows } = await admin.query(`SELECT conrelid::regclass::text AS from_table FROM pg_constraint WHERE contype = 'f' AND confrelid = 'platform_currency'::regclass`);
      expect(rows).toEqual([]);
      const { rows: outgoing } = await admin.query(`SELECT confrelid::regclass::text AS to_table FROM pg_constraint WHERE contype = 'f' AND conrelid = 'platform_currency'::regclass`);
      expect(outgoing).toEqual([{ to_table: 'currency' }]);
    });
  });

  describe('no currency exponent or code is hard-coded in invoice logic', () => {
    it('the source never maps a currency to an exponent or decimal count', async () => {
      const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
      const files = walk(new URL('../src/', import.meta.url).pathname).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
      expect(files.length).toBeGreaterThan(10);
      const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
      for (const f of files) {
        const code = strip(readFileSync(f, 'utf8'));
        expect(/\bexponent\b/i.test(code), `${f} refers to a currency exponent`).toBe(false);
        expect(/\b(TND|EUR|USD)\b/.test(code), `${f} hard-codes a currency code`).toBe(false);
        expect(/\b(toFixed|decimalPlaces|minimumFractionDigits|Intl\.NumberFormat)\b/.test(code), `${f} formats an amount with a decimal count`).toBe(false);
      }
    });
  });
});
