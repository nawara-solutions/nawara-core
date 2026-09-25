import type { Queryable } from '@nawara/service-kit';
import type { AuthorizedAuditQuery } from '../query/query-model.js';
import { AuditRecordRepository } from './audit-record.repository.js';

/**
 * Stage 18.6: `findPage` is PARAMETERIZED, always. Whatever the scope, policy, filters, window and cursor, no value from them appears in
 * the SQL text: each is a bound parameter. (The grammars make injection impossible anyway; this pins the property itself, so a future
 * interpolation is caught even when the current grammars would make it harmless.)
 */
const whereOf = (sql: string) => sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER BY'));

function capture(query: AuthorizedAuditQuery): { sql: string; params: unknown[] } {
  let sql = '';
  let params: unknown[] = [];
  const q: Queryable = {
    query: (async (text: string, values?: unknown[]) => {
      sql = text;
      params = values ?? [];
      return { rows: [] };
    }) as unknown as Queryable['query'],
  };
  void new AuditRecordRepository(undefined as never).findPage(query, q);
  return { sql, params };
}

const ORG = '3c1d9b0e-2a4f-4b8e-8f6a-5d7e9c0b1a22';
const full: AuthorizedAuditQuery = {
  scope: { kind: 'organization', organizationId: ORG },
  policy: { categories: ['security', 'business'], sourceServices: ['auth-service', 'file-service'] },
  filters: {
    action: 'membership.revoked', category: 'business', sourceService: 'auth-service', outcome: 'succeeded', correlationId: 'corr-value-0001',
    actor: { type: 'user', id: '0b7f7a52-6f55-4c1e-9d59-2f0d7c3a1e11' }, resource: { type: 'membership', id: '6e2f8a1c-9b3d-4c5e-a7f0-1d2c3b4a5e33' },
    subject: { type: 'user', id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c44' },
  },
  window: { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-02T00:00:00Z') },
  limit: 50,
  after: { occurredAtUs: '1780272000123456', id: '4242' },
};

describe('findPage builds parameterized SQL only', () => {
  it('no scope, policy, filter, window or cursor value appears in the statement text; every one is a parameter', async () => {
    const { sql, params } = capture(full);
    const values = [ORG, 'security', 'business', 'auth-service', 'file-service', 'membership.revoked', 'succeeded', 'corr-value-0001', 'user',
      '0b7f7a52-6f55-4c1e-9d59-2f0d7c3a1e11', 'membership', '6e2f8a1c-9b3d-4c5e-a7f0-1d2c3b4a5e33', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c44', '1780272000123456', '4242'];
    for (const v of values) {
      expect(whereOf(sql), v).not.toContain(v);
      expect(JSON.stringify(params), v).toContain(v);
    }
    expect(sql.match(/'[^']*'/g)).toEqual(["'epoch'", "'1 microsecond'"]); // the only literals: fixed SQL, never a value
    expect(sql).toMatch(/ORDER BY "occurredAt" DESC, id DESC LIMIT \$\d+$/);
    expect(params).toContain(51);
  });

  it('every predicate is joined with AND (a filter can only narrow)', async () => {
    const { sql } = capture(full);
    const where = whereOf(sql);
    expect(where).not.toMatch(/\bOR\b/);
    expect(where.split(' AND ').length).toBeGreaterThanOrEqual(15);
  });

  it('the platform scope never widens: all = no organization predicate; platform = IS NULL; organization = one parameter', async () => {
    expect(whereOf(capture({ ...full, scope: { kind: 'platform', target: 'all' } }).sql)).not.toContain('"organizationId"');
    expect(capture({ ...full, scope: { kind: 'platform', target: 'platform' } }).sql).toContain('"organizationId" IS NULL');
    expect(capture({ ...full, scope: { kind: 'platform', target: 'organization', organizationId: ORG } }).sql).toMatch(/"organizationId" = \$\d+::uuid/);
  });
});
