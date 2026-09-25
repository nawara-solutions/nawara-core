import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { APPS, PROHIBITED, deadDepth, resetAuditQueues, sql, startAudit, type LiveAudit } from './support/audit.js';
import { describeWithEnv } from './support/env.js';
import { spawnService, waitFor, waitForHealth, type LiveService } from './support/process.js';

/**
 * Stage 18.7.3: REAL Organization (HTTP, its dist build) → its outbox (same transaction as the hierarchy write and its admin_actor_event)
 * → its kit relay → a REAL RabbitMQ → a live audit-service → audit_record. The admin routes ask a stand-in Auth over real HTTP for the
 * caller's grant facts, exactly as in production; the G5 case (an org-admin `member` updates its organization) runs end to end.
 */
const ORG_DIR = `${APPS}organization-service`;
const ORG_PORT = 3875;
const AUDIT_PORT = 3876;
const ORG_URL = `http://127.0.0.1:${ORG_PORT}`;

type Facts = { userId: string; kind: 'member' | 'owner' | 'operator'; companyId: string | null; platformAssignments: string[]; organizationAdminMemberships: string[] };

/** A stand-in for Auth's /auth/grants and /auth/step-up/verify: grant facts per bearer, and step-up proofs that verify once registered. */
function fakeAuth() {
  const grants = new Map<string, Facts>();
  const stepUps = new Set<string>();
  const server: Server = createServer((req, res) => {
    const b = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/auth/grants') {
        const f = grants.get(b);
        res.writeHead(f ? 200 : 401, { 'content-type': 'application/json' }).end(JSON.stringify(f ?? {}));
      } else if (req.method === 'POST' && req.url === '/auth/step-up/verify') {
        const { purpose, stepUpToken } = JSON.parse(body || '{}');
        res.writeHead(stepUps.has(`${b}|${purpose}|${stepUpToken}`) ? 204 : 403).end();
      } else res.writeHead(404).end();
    });
  });
  return { server, grants, stepUps };
}

describeWithEnv('Organization → outbox → RabbitMQ → audit-service (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let orgDb: TestDatabase;
  let org: LiveService;
  let audit: LiveAudit;
  const auth = fakeAuth();
  const provisioning = generateServiceToken();

  const call = async (method: string, path: string, token: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${ORG_URL}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-correlation-id': 'org-e2e-corr-01', ...headers }, body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };

  beforeAll(async () => {
    await new Promise<void>((r) => auth.server.listen(0, '127.0.0.1', r));
    await resetAuditQueues(env.TEST_RABBITMQ_URL);
    audit = await startAudit(env.TEST_DATABASE_ADMIN_URL, env.TEST_RABBITMQ_URL, AUDIT_PORT);
    orgDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'e2eorgaudit');
    await runMigrations(orgDb.url, [kitMigrationsDir, `${ORG_DIR}/db/migrations/`]);
    // A fresh environment made authoritative the legal way (each step passes the ownership transition guard), as test-app.ts does.
    await sql(orgDb.url, `UPDATE ownership_state SET environment_class = 'fresh'`);
    await sql(orgDb.url, `UPDATE ownership_state SET phase = 'VERIFIED', verified_digest = 'test'`);
    await sql(orgDb.url, `UPDATE ownership_state SET phase = 'ACTIVATABLE', approved_by = 'test', approved_reference = 'test', approved_at = now()`);
    await sql(orgDb.url, `UPDATE ownership_state SET phase = 'ACTIVE', activated_by = 'test', activated_at = now()`);
    org = spawnService('organization', ORG_DIR, {
      NODE_ENV: 'test', PORT: String(ORG_PORT), DATABASE_URL: orgDb.url, RABBITMQ_URL: env.TEST_RABBITMQ_URL,
      AUTH_SERVICE_URL: `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}`,
      SERVICE_TOKENS: `provisioning:${provisioning.digest}`, SERVICE_POLICY: JSON.stringify({ callers: { provisioning: { capabilities: ['hierarchy.provision'] } } }),
    });
    try {
      await waitForHealth(`${ORG_URL}/health`, 30_000);
    } catch (e) {
      throw new Error(`${String(e)}\n${org.tail()}`);
    }
  });
  afterAll(async () => {
    await org?.stop();
    await audit?.stop();
    await new Promise((r) => auth.server.close(r));
    await orgDb?.drop();
    await audit?.db.drop();
  });

  it('service and human hierarchy writes, a G5 member update and a denial reach audit_record with the real actor, kind and organization', async () => {
    const company = await call('POST', '/organization/companies', provisioning.token, { name: 'Company Name Not In Audit' }, { 'idempotency-key': `k-${crypto.randomUUID()}` });
    expect(company.status, JSON.stringify(company.body)).toBe(201);

    const owner = crypto.randomUUID();
    auth.grants.set('owner-bearer', { userId: owner, kind: 'owner', companyId: company.body.id, platformAssignments: [], organizationAdminMemberships: [] });
    auth.stepUps.add('owner-bearer|platform.create|su-p').add('owner-bearer|organization.create|su-o');
    const platform = await call('POST', '/organization/admin/platforms', 'owner-bearer', { companyId: company.body.id, name: 'P' }, { 'idempotency-key': `k-${crypto.randomUUID()}`, 'x-step-up-token': 'su-p' });
    expect(platform.status, JSON.stringify(platform.body)).toBe(201);
    const tenant = await call('POST', '/organization/admin/organizations', 'owner-bearer', { platformId: platform.body.id, name: 'Tenant Name Not In Audit' }, { 'idempotency-key': `k-${crypto.randomUUID()}`, 'x-step-up-token': 'su-o' });
    expect(tenant.status, JSON.stringify(tenant.body)).toBe(201);
    const orgId = tenant.body.id as string;

    const memberId = crypto.randomUUID();
    auth.grants.set('member-bearer', { userId: memberId, kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships: [orgId] });
    expect((await call('PATCH', `/organization/admin/organizations/${orgId}`, 'member-bearer', { name: 'Renamed' }, { 'x-organization-id': crypto.randomUUID() })).status).toBe(200);
    expect((await call('PATCH', `/organization/admin/platforms/${platform.body.id}`, 'member-bearer', { name: 'X' })).status).toBe(403);

    const ids = [company.body.id, platform.body.id, orgId];
    await waitFor(async () => (await audit.records(`"sourceService" = 'organization-service' AND "resourceId" = ANY($1::text[])`, [ids])).length === 5, 30_000, 'five organization records');
    const rows = await audit.records(`"sourceService" = 'organization-service' AND "resourceId" = ANY($1::text[])`, [ids]);
    const one = (action: string) => rows.filter((r) => r.action === action);
    expect(rows.map((r) => r.action).sort()).toEqual(['company.created', 'hierarchy.admin_operation_denied', 'organization.created', 'organization.updated', 'platform.created']);
    expect(one('company.created')[0]).toMatchObject({ actorType: 'service', actorId: 'provisioning', userKind: null, organizationId: null, category: 'administrative' });
    expect(one('platform.created')[0]).toMatchObject({ actorType: 'user', actorId: owner, userKind: 'owner', organizationId: null });
    expect(one('organization.created')[0]).toMatchObject({ actorType: 'user', actorId: owner, userKind: 'owner', organizationId: orgId });
    expect(one('organization.updated')[0]).toMatchObject({ actorType: 'user', actorId: memberId, userKind: 'member', organizationId: orgId }); // G5: the real kind
    expect(one('hierarchy.admin_operation_denied')[0]).toMatchObject({
      category: 'security', outcome: 'denied', actorId: memberId, userKind: 'member', organizationId: null, resourceType: 'platform', changes: { operation: 'platform.update', reason: 'no_authority' },
    });
    for (const r of rows) expect(r.correlationId).toBe('org-e2e-corr-01');
    const payloads = await sql(orgDb.url, `SELECT payload FROM outbox WHERE name LIKE 'audit.%'`);
    expect(payloads).toHaveLength(5); // only audit intent: no organization domain events
    for (const p of payloads) {
      for (const re of PROHIBITED) expect(JSON.stringify(p.payload)).not.toMatch(re);
      expect(JSON.stringify(p.payload)).not.toMatch(/Name Not In Audit|Renamed/);
    }
    expect(await deadDepth(env.TEST_RABBITMQ_URL)).toBe(0);
  });
});
