import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

const PDF = ['application/pdf'];
const POLICY = {
  callers: {
    // the Owner-facing service that holds the fraud evidence (any owner service granted the purpose)
    'core-console': { operations: ['upload', 'read', 'attach', 'grant'], organizations: 'none', mediaTypes: PDF, maxBytes: 1024 * 1024, grantPurposes: ['fraud_evidence', 'dispute_evidence'] },
    'core-drive': { operations: ['upload', 'read', 'attach', 'grant'], organizations: 'none', mediaTypes: PDF, maxBytes: 1024 * 1024, grantPurposes: ['dispute_evidence'] },
    // the fraud-evidence grantee
    'billing-service': { operations: ['read_granted'], organizations: 'none', readPurposes: ['fraud_evidence'] },
    'payment-service': { operations: ['read_granted'], organizations: 'none', readPurposes: ['dispute_evidence'] },
  },
};

/**
 * Core V2 S6e-H File prerequisite (register FIL-01, FIL-02; BIL-27; the Owner's H-3, 2026-10-29): the `fraud_evidence` purpose on the REAL
 * application (real PostgreSQL): its one grantee (billing-service), its mandatory Company and subject binding (and no other purpose's),
 * idempotency, the granted read naming them, the database's own rules and the audit intent. Every other purpose is unchanged.
 */
describeWithEnv('fraud evidence grants (Core V2 S6e-H) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const consoleTok = generateServiceToken();
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const payment = generateServiceToken();
  const tokens = [
    { caller: 'core-console', digest: consoleTok.digest }, { caller: 'core-drive', digest: drive.digest },
    { caller: 'billing-service', digest: billing.digest }, { caller: 'payment-service', digest: payment.digest },
  ];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }) => ({ authorization: `Bearer ${tok.token}` });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filefraud');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY) });
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  const uploaded = async (who = consoleTok) => {
    const r = await request(server()).post('/file/files').set({ ...auth(who), 'idempotency-key': randomUUID(), 'x-attach': 'true' }).send(SAMPLES.pdf(2000));
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const grant = (id: string, body: Record<string, unknown>, o: { who?: { token: string }; key?: string } = {}) =>
    request(server()).post(`/file/files/${id}/evidence-grants`).set({ ...auth(o.who ?? consoleTok), 'idempotency-key': o.key ?? randomUUID() }).send(body);
  const fraud = (over: Record<string, unknown> = {}) => ({ purpose: 'fraud_evidence', caseRef: randomUUID(), companyId: randomUUID(), subjectUserId: randomUUID(), ...over });
  const meta = (grantId: string, fileId: string, who = billing) => request(server()).get(`/file/evidence-grants/${grantId}/files/${fileId}`).set(auth(who));

  it('a fraud_evidence grant goes to billing-service only and names its hold (caseRef), Company and subject; audited with its purpose', async () => {
    const id = await uploaded();
    const body = fraud();
    const r = await grant(id, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toEqual({
      grantId: expect.any(String), fileId: id, purpose: 'fraud_evidence', grantee: 'billing-service', caseRef: body.caseRef, organizationId: null,
      status: 'active', expiresAt: expect.any(String), revokedAt: null, createdAt: expect.any(String), companyId: body.companyId, subjectUserId: body.subjectUserId,
    });
    const [row] = await s.query('SELECT "companyId", "subjectUserId", "granteeService" FROM file_evidence_grant WHERE id = $1', [r.body.grantId]);
    expect(row).toEqual({ companyId: body.companyId, subjectUserId: body.subjectUserId, granteeService: 'billing-service' });
    const [a] = await s.query<{ payload: Record<string, any> }>(`SELECT payload FROM outbox WHERE name = 'audit.file.grant_issued' AND payload->'resource'->>'id' = $1`, [r.body.grantId]);
    expect(a!.payload.changes).toMatchObject({ file_id: id, purpose: 'fraud_evidence', case_ref: body.caseRef });
    expect(() => validateAuditPayload(a!.payload, 'file-service')).not.toThrow();
    // the grantee's read names exactly the hold, Company and subject; the dispute grantee cannot read it
    const m = await meta(r.body.grantId, id);
    expect(m.status).toBe(200);
    expect(m.body.grant).toEqual({ id: r.body.grantId, purpose: 'fraud_evidence', caseRef: body.caseRef, expiresAt: r.body.expiresAt, companyId: body.companyId, subjectUserId: body.subjectUserId });
    expect((await meta(r.body.grantId, id, payment)).status).toBe(404);
  });

  it('the Company and subject are required for fraud_evidence and refused for every other purpose; nothing is written', async () => {
    const id = await uploaded();
    for (const body of [fraud({ companyId: undefined }), fraud({ subjectUserId: undefined }), { ...fraud(), companyId: 'not-a-uuid' },
      { purpose: 'dispute_evidence', caseRef: randomUUID(), companyId: randomUUID(), subjectUserId: randomUUID() }, { purpose: 'dispute_evidence', caseRef: randomUUID(), subjectUserId: randomUUID() }]) {
      const r = await grant(id, JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await s.query('SELECT 1 FROM file_evidence_grant WHERE "fileId" = $1', [id])).length).toBe(0);
    // a dispute grant keeps its exact shape: no Company, no subject
    const d = await grant(id, { purpose: 'dispute_evidence', caseRef: randomUUID() });
    expect(d.status).toBe(201);
    expect(Object.keys(d.body)).not.toContain('companyId');
    expect(Object.keys((await meta(d.body.grantId, id, payment)).body.grant).sort()).toEqual(['caseRef', 'expiresAt', 'id', 'purpose']);
  });

  it('only an owner service holding the purpose may grant it; replay is idempotent, another subject under the key is refused', async () => {
    const own = await uploaded(drive);
    expect((await grant(own, fraud(), { who: drive })).body.code).toBe('purpose_not_allowed');
    const id = await uploaded();
    const body = fraud();
    const key = `k-${randomUUID()}`;
    const first = await grant(id, body, { key });
    expect(first.status).toBe(201);
    const again = await grant(id, body, { key });
    expect([again.status, again.body.grantId]).toEqual([200, first.body.grantId]);
    for (const change of [{ subjectUserId: randomUUID() }, { companyId: randomUUID() }]) {
      expect((await grant(id, { ...body, ...change }, { key })).status, JSON.stringify(change)).toBe(422);
    }
    // another service's file cannot be granted (one 404)
    expect((await grant(own, fraud())).status).toBe(404);
  });

  describe('database guarantees (every role)', () => {
    it('a fraud grant always names its Company and subject, no other purpose ever does, and neither ever changes', async () => {
      const id = await uploaded();
      const r = await grant(id, fraud());
      const insert = (purpose: string, grantee: string, company: string | null, subject: string | null) => s.query(
        `INSERT INTO file_evidence_grant (id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "idempotencyKey", "requestHash", "expiresAt", "companyId", "subjectUserId")
         VALUES ($1, $2, 'core-console', $3, $4, $5, NULL, $6, repeat('a', 64), now() + interval '1 hour', $7, $8)`,
        [randomUUID(), id, grantee, purpose, randomUUID(), randomUUID(), company, subject]);
      await expect(insert('fraud_evidence', 'billing-service', null, null)).rejects.toMatchObject({ constraint: 'file_evidence_grant_fraud_subject' });
      await expect(insert('fraud_evidence', 'billing-service', randomUUID(), null)).rejects.toMatchObject({ constraint: 'file_evidence_grant_fraud_subject' });
      await expect(insert('dispute_evidence', 'payment-service', randomUUID(), randomUUID())).rejects.toMatchObject({ constraint: 'file_evidence_grant_fraud_subject' });
      await expect(insert('fraud_evidence', 'payment-service', randomUUID(), randomUUID())).rejects.toMatchObject({ constraint: 'file_evidence_grant_purpose_grantee' });
      await expect(s.query(`UPDATE file_evidence_grant SET "companyId" = $2 WHERE id = $1`, [r.body.grantId, randomUUID()])).rejects.toThrow();
      await expect(s.query(`UPDATE file_evidence_grant SET "subjectUserId" = $2 WHERE id = $1`, [r.body.grantId, randomUUID()])).rejects.toThrow();
    });
  });
});
