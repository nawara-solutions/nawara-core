import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations, type Queryable } from '@nawara/service-kit';
import { auditMigrationsDir } from '../../src/app.module.js';
import { AuditRecordRepository } from '../../src/persistence/audit-record.repository.js';
import type { AuthorizedAuditQuery } from '../../src/query/query-model.js';
import { sql } from '../support/db.js';
import { describeWithEnv } from '../support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from '../support/roles.js';

/**
 * Stage 18.6 §48–§50, §84: `EXPLAIN (ANALYZE, BUFFERS)` of the EXACT statements `findPage` builds, on a representative volume: 500 000
 * records over ~1 year (one every 63 s), 1 000 organizations, 5 % platform-level, 4 actions / sources / categories, 5 000 actors,
 * a subject on a third of them, a correlation id each. Plans go to `QUERY_PLANS_OUT` when set.
 */
const ROWS = Number(process.env.QUERY_PLAN_ROWS ?? 500_000);
const ALL = ['security', 'business', 'commercial', 'administrative'] as const;

describeWithEnv('audit query plans at volume (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let d: ProvisionedDatabase;
  let pool: pg.Pool;
  const out: string[] = [];

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aplans');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    const t0 = Date.now();
    await sql(d.adminUrl, `
      INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "userKind", "organizationId",
        "resourceType", "resourceId", "subjectType", "subjectId", outcome, changes, "correlationId", "causationId", "occurredAt")
      SELECT gen_random_uuid(), k.src, k.act, k.cat, 1, 'user', md5('u' || (g % 5000))::uuid::text, 'member',
             CASE WHEN g % 20 = 0 THEN NULL ELSE md5('o' || (g % 1000))::uuid END,
             k.rtype, md5('r' || g)::uuid::text,
             CASE WHEN g % 3 = 0 THEN 'user' END, CASE WHEN g % 3 = 0 THEN md5('s' || (g % 7000))::uuid::text END,
             'succeeded', NULL, 'corr-' || lpad(g::text, 10, '0'), NULL, timestamptz '2025-10-01T00:00:00Z' + g * interval '63 seconds'
        FROM generate_series(1, ${ROWS}) g
        CROSS JOIN LATERAL (SELECT (ARRAY['membership.revoked', 'membership.admin_granted', 'invoice.issued', 'organization.updated'])[1 + g % 4] AS act,
                                   (ARRAY['auth-service', 'auth-service', 'billing-service', 'organization-service'])[1 + g % 4] AS src,
                                   (ARRAY['business', 'security', 'commercial', 'administrative'])[1 + g % 4] AS cat,
                                   (ARRAY['membership', 'membership', 'invoice', 'organization'])[1 + g % 4] AS rtype) k`);
    await sql(d.adminUrl, 'ANALYZE audit_record');
    out.push(`seeded ${ROWS} rows in ${Date.now() - t0} ms; PostgreSQL ${(await sql<{ server_version: string }>(d.adminUrl, 'SHOW server_version'))[0]!.server_version}`);
    pool = new pg.Pool({ connectionString: d.appUrl, max: 2 });
  });
  afterAll(async () => {
    if (process.env.QUERY_PLANS_OUT) writeFileSync(process.env.QUERY_PLANS_OUT, out.join('\n'));
    await pool?.end();
    await d?.drop();
  });

  /** Runs `findPage`'s exact statement under EXPLAIN (as the runtime role) and returns the plan text. */
  async function plan(label: string, query: AuthorizedAuditQuery): Promise<string> {
    let text = '';
    const explaining: Queryable = {
      query: (async (statement: string, params?: unknown[]) => {
        const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${statement}`, params);
        text = r.rows.map((x: Record<string, string>) => x['QUERY PLAN']).join('\n');
        return { rows: [] };
      }) as unknown as Queryable['query'],
    };
    await new AuditRecordRepository(undefined as never).findPage(query, explaining);
    out.push(`\n=== ${label}\n${text}`);
    return text;
  }
  const one = async (column: string, where = 'true') =>
    (await sql<Record<string, string>>(d.adminUrl, `SELECT ${column} AS v FROM audit_record WHERE ${where} AND "organizationId" IS NOT NULL LIMIT 1`))[0]!.v;
  const exec = (p: string) => Number(/Execution Time: ([\d.]+) ms/.exec(p)?.[1] ?? NaN);
  const base = (over: Partial<AuthorizedAuditQuery>): AuthorizedAuditQuery => ({
    scope: { kind: 'platform', target: 'all' }, policy: { categories: [...ALL] }, filters: {}, limit: 51,
    window: { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') }, ...over,
  });

  it('organization-scope queries use an index and never scan the table', async () => {
    const orgId = await one('"organizationId"::text');
    const org = { kind: 'organization' as const, organizationId: orgId };
    const orgWindow = { from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') }; // 91 days
    const actor = await one(`"actorId"`, `"organizationId" = '${orgId}'`);
    const resource = await one(`"resourceId"`, `"organizationId" = '${orgId}'`);
    const subject = await one(`"subjectId"`, `"organizationId" = '${orgId}' AND "subjectId" IS NOT NULL`);
    const correlation = await one(`"correlationId"`, `"organizationId" = '${orgId}'`);
    const cases: Array<[string, AuthorizedAuditQuery]> = [
      ['1 organization, newest page', base({ scope: org, window: orgWindow })],
      ['2 organization + action', base({ scope: org, window: orgWindow, filters: { action: 'invoice.issued' } })],
      ['3 organization + actor', base({ scope: org, window: orgWindow, filters: { actor: { type: 'user', id: actor } } })],
      ['4 organization + resource', base({ scope: org, window: orgWindow, filters: { resource: { type: 'membership', id: resource } } })],
      ['5 organization + subject', base({ scope: org, window: orgWindow, filters: { subject: { type: 'user', id: subject } } })],
      ['6 organization + correlation', base({ scope: org, window: orgWindow, filters: { correlationId: correlation } })],
      ['8 organization, a page after a cursor', base({ scope: org, window: orgWindow, after: { occurredAtUs: String(Date.parse('2026-06-15T00:00:00Z') * 1000), id: '999999999' } })],
      ['8b organization, security-only policy', base({ scope: org, window: orgWindow, policy: { categories: ['security'] } })],
    ];
    for (const [label, q] of cases) {
      const p = await plan(label, q);
      expect(p, label).not.toMatch(/Seq Scan on audit_record/);
      expect(exec(p), label).toBeLessThan(50);
    }
  });

  it('platform-scope queries use an index too (0002 audit_record_time_idx: the platform-wide time-index decision deferred by 18.3)', async () => {
    const cases: Array<[string, AuthorizedAuditQuery]> = [
      ['7 platform, all organizations, newest page (31 days)', base({})],
      ['7b platform, platform-level only', base({ scope: { kind: 'platform', target: 'platform' } })],
      ['7c platform, one organization', base({ scope: { kind: 'platform', target: 'organization', organizationId: await one('"organizationId"::text') } })],
      ['7d platform, all + action', base({ filters: { action: 'membership.admin_granted' } })],
      ['7e platform, all + security-only policy', base({ policy: { categories: ['security'] } })],
      ['7f platform, all, a deep page (cursor mid-window)', base({ after: { occurredAtUs: String(Date.parse('2026-06-10T00:00:00Z') * 1000), id: '999999999' } })],
    ];
    for (const [label, q] of cases) {
      const p = await plan(label, q);
      out.push(`--- ${label}: ${exec(p)} ms, seq scan: ${/Seq Scan on audit_record/.test(p)}`);
      // Before 0002 every "all organizations" page here was a parallel sequential scan (32–42 ms at 500 000 rows, linear in the table).
      expect(p, label).not.toMatch(/Seq Scan on audit_record/);
      expect(exec(p), label).toBeLessThan(50);
    }
  });
});
