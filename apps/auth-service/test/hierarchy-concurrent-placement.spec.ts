import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config/app-config.js';
import type { DbService, Queryable } from '../src/db/db.service.js';
import { HierarchyReference, type HierarchyKind, type OrganizationDirectoryClient } from '../src/hierarchy/hierarchy-reference.js';

/**
 * The placement retry, deterministically (the real-PostgreSQL race is in hierarchy-concurrent-placement.e2e-spec.ts). `ON CONFLICT (id)`
 * arbitrates only the primary key, so two first touches of the same row that pass its check together meet on the composite
 * (id, anchor) key: 23505 `platform_id_company_uk` / `organization_id_platform_uk`, raised after the other transaction committed.
 * Only those two keys are retried, at most once per chain row; the retry still runs the anchor check; every other failure is
 * refused as before.
 */
const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '33333333-3333-4333-8333-333333333333';
const ORGANIZATION = '44444444-4444-4444-8444-444444444444';
const authority = {
  company: { id: COMPANY, name: 'Company A' },
  platform: { id: PLATFORM, companyId: COMPANY, name: 'Platform A', key: 'platform-a' },
  organization: { id: ORGANIZATION, platformId: PLATFORM, name: 'Organization A' },
};

const pgError = (code: string, constraint?: string) => Object.assign(new Error(`pg ${code}`), { code, constraint, severity: 'ERROR' });
const raced = (constraint = 'platform_id_company_uk') => pgError('23505', constraint);

/**
 * A fake database: `failures` are thrown by the first transactions, in order (the attempt rolled back); `anchor` answers the anchor
 * check of each attempt (default: the authority's own). The Company is cached, so the chain of an uncached Organization is
 * [platform, organization] and that of an uncached Platform is [platform].
 */
function reference(opts: { failures?: Error[]; anchor?: (attempt: number, column: string) => unknown; repairRecord?: boolean } = {}) {
  const failures = [...(opts.failures ?? [])];
  let attempts = 0;
  const inserted: string[] = [];
  const records: Array<{ placed: boolean }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT 1 FROM company')) return { rows: [{}], rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM')) return { rows: [], rowCount: 0 };
      if (sql.includes('AS company FROM')) return { rows: [], rowCount: 0 }; // repair: the target is not cached
      throw new Error(`unexpected statement outside a transaction: ${sql} ${String(params)}`);
    },
    tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
      const attempt = ++attempts;
      const failure = failures.shift();
      if (failure) throw failure;
      return fn({
        query: async (sql: string) => {
          if (sql.startsWith('SELECT set_config')) return { rows: [], rowCount: 1 };
          if (sql.startsWith('INSERT INTO')) { inserted.push(`${attempt}:${sql.split(' ')[2]}`); return { rows: [], rowCount: 1 }; }
          const m = sql.match(/^SELECT "(\w+)" AS anchor FROM (\w+)/);
          if (m) {
            const own = m[2] === 'platform' ? COMPANY : PLATFORM;
            return { rows: [{ anchor: opts.anchor ? opts.anchor(attempt, m[1]!) : own }], rowCount: 1 };
          }
          throw new Error(`unexpected statement: ${sql}`);
        },
      } as unknown as Queryable);
    },
  };
  const client = { get: async (kind: HierarchyKind, id: string) => ((authority[kind].id === id) ? { ...authority[kind] } : null) };
  const cfg = { hierarchy: { source: 'organization-service' } } as unknown as AppConfig;
  const ref = new HierarchyReference(db as unknown as DbService, cfg, client as unknown as OrganizationDirectoryClient);
  const repair = (kind: 'platform' | 'organization', id: string) => ref.repairReference(kind, id, {
    authorize: () => true,
    record: async (_q, r) => { records.push(r); },
  });
  return { ref, repair, attempts: () => attempts, inserted, records, failuresLeft: () => failures.length };
}

const unavailable = { response: { code: 'hierarchy_unavailable' } };

describe('ensure: a first touch that lost the placement race to a concurrent one', () => {
  it('Platform: 23505 on platform_id_company_uk is retried once; the retry passes the anchor check and succeeds', async () => {
    const r = reference({ failures: [raced('platform_id_company_uk')] });
    await expect(r.ref.ensure('platform', PLATFORM)).resolves.toBe(true);
    expect(r.attempts()).toBe(2);
    expect(r.inserted).toEqual(['2:platform']);
  });

  it('Organization: 23505 on organization_id_platform_uk (or on its Platform) is retried; at most once per chain row', async () => {
    const r = reference({ failures: [raced('platform_id_company_uk'), raced('organization_id_platform_uk')] });
    await expect(r.ref.ensure('organization', ORGANIZATION)).resolves.toBe(true);
    expect(r.attempts()).toBe(3);
    expect(r.inserted).toEqual(['3:platform', '3:organization']);
  });

  it('the bound: a race reported more times than the chain has rows is refused (503), never retried without end', async () => {
    const r = reference({ failures: [raced(), raced(), raced(), raced()] });
    await expect(r.ref.ensure('organization', ORGANIZATION)).rejects.toMatchObject(unavailable);
    expect(r.attempts()).toBe(3); // the first attempt and one retry per chain row (platform, organization)
    expect(r.failuresLeft()).toBe(1);
  });

  it('the retry still runs the anchor check: a row placed concurrently under ANOTHER parent fails closed (503), nothing accepted', async () => {
    const r = reference({ failures: [raced()], anchor: (attempt) => (attempt === 2 ? OTHER_COMPANY : COMPANY) });
    await expect(r.ref.ensure('platform', PLATFORM)).rejects.toMatchObject(unavailable);
    expect(r.attempts()).toBe(2);
  });

  it.each([
    ['a Platform key held by another id (platform_key_uk)', pgError('23505', 'platform_key_uk')],
    ['a duplicate on a primary key (never raised by ON CONFLICT (id))', pgError('23505', 'platform_pkey')],
    ['a duplicate with no constraint name', pgError('23505')],
    ['a check violation (platform_key_format)', pgError('23514', 'platform_key_format')],
    ['the frozen hierarchy (the write guard)', pgError('P0001')],
    ['a serialization failure', pgError('40001')],
    ['a lost connection', new Error('Connection terminated unexpectedly')],
  ])('not a placement race, not retried: %s is refused (503) after ONE attempt', async (_label, failure) => {
    const r = reference({ failures: [failure] });
    await expect(r.ref.ensure('platform', PLATFORM)).rejects.toMatchObject(unavailable);
    expect(r.attempts()).toBe(1);
    expect(r.inserted).toEqual([]);
  });
});

describe('repairReference: the same placement, the same retry', () => {
  it('a raced repair is retried: repaired, and its record is written once, in the committed attempt', async () => {
    const r = reference({ failures: [raced()] });
    await expect(r.repair('platform', PLATFORM)).resolves.toEqual({ outcome: 'repaired', placed: true });
    expect(r.attempts()).toBe(2);
    expect(r.records).toEqual([{ placed: true }]);
  });

  it('a Platform key held by another id is not retried: placement_refused, nothing recorded', async () => {
    const r = reference({ failures: [pgError('23505', 'platform_key_uk')] });
    await expect(r.repair('platform', PLATFORM)).resolves.toEqual({ outcome: 'failed', reason: 'placement_refused' });
    expect(r.attempts()).toBe(1);
    expect(r.records).toEqual([]);
  });

  it('a raced repair whose row is under another parent: anchor_mismatch', async () => {
    const r = reference({ failures: [raced()], anchor: (attempt) => (attempt === 2 ? OTHER_COMPANY : COMPANY) });
    await expect(r.repair('platform', PLATFORM)).resolves.toEqual({ outcome: 'anchor_mismatch', at: { kind: 'platform', id: PLATFORM } });
    expect(r.records).toEqual([]);
  });
});
