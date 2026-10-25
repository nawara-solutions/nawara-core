import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import type { EvidencePurpose } from '../src/grants/evidence-purposes.js';
import { GrantRepository } from '../src/persistence/grant.repository.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

const PDF = ['application/pdf'];
const POLICY = {
  callers: {
    'core-drive': {
      operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket', 'grant'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024,
      grantPurposes: ['dispute_evidence', 'surplus_evidence'],
    },
    'core-records': { operations: ['upload', 'read', 'attach', 'grant'], organizations: 'none', mediaTypes: PDF, maxBytes: 1024 * 1024, grantPurposes: ['settlement_evidence'] },
    'core-uploader': { operations: ['upload', 'read', 'attach'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024 },
    // the grantees, as ordinary callers: a grant gives them nothing through the existing routes
    'payment-service': { operations: ['read', 'issue_ticket'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024 },
    'billing-service': { operations: ['upload', 'read', 'attach', 'grant'], organizations: 'none', mediaTypes: PDF, maxBytes: 1024 * 1024, grantPurposes: ['surplus_evidence'] },
  },
};

/**
 * Core V2 S2-File.1 (register FIL-01; OD-FILE F1 to F3, F6, F8): evidence-grant issuance and revocation on the REAL application (real
 * PostgreSQL, the filesystem store): owner-service-only authority, purpose and grantee binding, organization isolation, lifetime,
 * idempotency and concurrency, revocation, the database's own integrity rules, the audit intent, and no new access for the grantee.
 */
describeWithEnv('evidence grants (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const records = generateServiceToken();
  const uploader = generateServiceToken();
  const payment = generateServiceToken();
  const billing = generateServiceToken();
  const tokens = [
    { caller: 'core-drive', digest: drive.digest }, { caller: 'core-records', digest: records.digest }, { caller: 'core-uploader', digest: uploader.digest },
    { caller: 'payment-service', digest: payment.digest }, { caller: 'billing-service', digest: billing.digest },
  ];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filegrants');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY) });
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(opts: { org?: string | null; who?: { token: string }; attach?: boolean } = {}): Promise<string> {
    const headers: Record<string, string> = { ...auth(opts.who ?? drive, opts.org), 'idempotency-key': randomUUID() };
    if (opts.attach !== false) headers['x-attach'] = 'true';
    const r = await request(server()).post('/file/files').set(headers).send(SAMPLES.pdf(2000));
    expect(r.status).toBe(201);
    return r.body.id as string;
  }
  const grant = (id: string, body: Record<string, unknown>, o: { who?: { token: string }; org?: string | null; key?: string | null } = {}) => {
    const headers: Record<string, string> = auth(o.who ?? drive, o.org);
    if (o.key !== null) headers['idempotency-key'] = o.key ?? randomUUID();
    return request(server()).post(`/file/files/${id}/evidence-grants`).set(headers).send(body);
  };
  const revoke = (grantId: string, o: { who?: { token: string }; org?: string | null } = {}) =>
    request(server()).post(`/file/evidence-grants/${grantId}/revoke`).set(auth(o.who ?? drive, o.org)).send();
  const dispute = () => ({ purpose: 'dispute_evidence', caseRef: randomUUID() });
  const rows = (fileId: string) => s.query<Record<string, unknown>>('SELECT * FROM file_evidence_grant WHERE "fileId" = $1 ORDER BY "createdAt"', [fileId]);
  const audits = (grantId: string) =>
    s.query<{ name: string; payload: Record<string, any> }>(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [grantId]);
  const use = (grantId: string, fileId: string, granteeService = 'payment-service', purposes: EvidencePurpose[] = ['dispute_evidence']) =>
    ({ grantId, fileId, granteeService, purposes: new Set(purposes) });
  const seconds = (b: { expiresAt: string; createdAt: string }) => (Date.parse(b.expiresAt) - Date.parse(b.createdAt)) / 1000;

  // ───────────────────────────────────────────────────────────────────────────────────────────── issuance (FIL-01)

  describe('issuance', () => {
    it('the owner service grants its file: 201, the grantee fixed by the purpose, the file\'s organization, 24 hours by default, one audit intent', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const body = dispute();
      const r = await grant(id, body, { org });
      expect(r.status).toBe(201);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.body).toEqual({
        grantId: expect.any(String), fileId: id, purpose: 'dispute_evidence', grantee: 'payment-service', caseRef: body.caseRef, organizationId: org,
        status: 'active', expiresAt: expect.any(String), revokedAt: null, createdAt: expect.any(String),
      });
      expect(seconds(r.body)).toBe(24 * 3600);
      const [row] = await rows(id);
      expect(row).toMatchObject({ id: r.body.grantId, grantorService: 'core-drive', granteeService: 'payment-service', organizationId: org, revokedAt: null });
      const events = await audits(r.body.grantId);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        action: 'file.grant_issued', actor: { type: 'service', id: 'core-drive' }, organizationId: org, resource: { type: 'file_evidence_grant', id: r.body.grantId },
        outcome: 'succeeded', changes: { file_id: id, purpose: 'dispute_evidence', case_ref: body.caseRef, expires_at: r.body.expiresAt },
      });
      expect(() => validateAuditPayload(events[0]!.payload, 'file-service')).not.toThrow();
    });

    it('a platform file (no organization) is granted with no organization; surplus_evidence goes to billing-service', async () => {
      const id = await uploaded();
      const r = await grant(id, { purpose: 'surplus_evidence', caseRef: randomUUID() });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ grantee: 'billing-service', organizationId: null });
      const recs = await uploaded({ who: records });
      expect((await grant(recs, { purpose: 'settlement_evidence', caseRef: randomUUID() }, { who: records })).body).toMatchObject({ grantee: 'billing-service' });
    });

    it('F3: an explicit lifetime from 60 seconds to 7 days; outside it, or not an integer, is a validation error', async () => {
      const id = await uploaded();
      expect(seconds((await grant(id, { ...dispute(), expiresInSeconds: 7 * 24 * 3600 })).body)).toBe(7 * 24 * 3600);
      expect(seconds((await grant(id, { ...dispute(), expiresInSeconds: 60 })).body)).toBe(60);
      expect(seconds((await grant(id, { ...dispute(), expiresInSeconds: null })).body)).toBe(24 * 3600); // null is absent (the kit's optional rule): the default
      for (const expiresInSeconds of [7 * 24 * 3600 + 1, 59, 0, -1, 3600.5, '3600']) {
        const r = await grant(id, { ...dispute(), expiresInSeconds });
        expect(r.status, String(expiresInSeconds)).toBe(400);
        expect(r.body.code).toBe('validation_error');
      }
    });

    it('a closed request: unknown purpose, a malformed case, a missing field, an extra field (no grantee, grantor or organization from the body), no Idempotency-Key', async () => {
      const id = await uploaded();
      for (const body of [
        { purpose: 'legal_evidence', caseRef: randomUUID() }, { purpose: 'DISPUTE_EVIDENCE', caseRef: randomUUID() }, { purpose: 'dispute_evidence', caseRef: 'case-1' },
        { purpose: 'dispute_evidence' }, { caseRef: randomUUID() },
        { ...dispute(), grantee: 'core-uploader' }, { ...dispute(), granteeService: 'core-uploader' }, { ...dispute(), grantorService: 'core-records' },
        { ...dispute(), organizationId: randomUUID() }, { ...dispute(), fileId: randomUUID() },
      ]) {
        const r = await grant(id, body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.code).toBe('validation_error');
      }
      expect((await grant(id, dispute(), { key: null })).body.code).toBe('validation_error');
      expect(await rows(id)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── authority (F1, F2, F8)

  describe('authority', () => {
    it('no or an unknown service token is 401; a caller without `grant` is 403 operation_not_allowed, also on revocation', async () => {
      const id = await uploaded({ who: uploader });
      expect((await request(server()).post(`/file/files/${id}/evidence-grants`).set('idempotency-key', 'k').send(dispute())).status).toBe(401);
      expect((await request(server()).post(`/file/files/${id}/evidence-grants`).set({ authorization: `Bearer ${generateServiceToken().token}`, 'idempotency-key': 'k' }).send(dispute())).status).toBe(401);
      expect((await grant(id, dispute(), { who: uploader })).body.code).toBe('operation_not_allowed');
      expect((await grant(id, dispute(), { who: payment })).body.code).toBe('operation_not_allowed');
      expect((await revoke(randomUUID(), { who: uploader })).body.code).toBe('operation_not_allowed');
    });

    it('a purpose outside the caller\'s grantPurposes, and a purpose whose grantee is the caller itself, are 403 purpose_not_allowed', async () => {
      const id = await uploaded();
      const r = await grant(id, { purpose: 'settlement_evidence', caseRef: randomUUID() });
      expect([r.status, r.body.code]).toEqual([403, 'purpose_not_allowed']);
      const own = await uploaded({ who: billing });
      const self = await grant(own, { purpose: 'surplus_evidence', caseRef: randomUUID() }, { who: billing });
      expect([self.status, self.body.code]).toEqual([403, 'purpose_not_allowed']);
      expect([...(await rows(id)), ...(await rows(own))]).toEqual([]);
    });

    it('only the OWNER grants: another service\'s file is the same 404 file_not_found as a missing or malformed id', async () => {
      const mine = await uploaded({ who: records });
      for (const [id, who] of [[mine, drive], [randomUUID(), drive], ['not-a-uuid', drive]] as const) {
        const r = await grant(id, dispute(), { who });
        expect([r.status, r.body.code], id).toEqual([404, 'file_not_found']);
      }
      expect(await rows(mine)).toEqual([]);
    });

    it('a grant never widens organization scope: another organization, or none, is 404; a caller with no organization mode is 403', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      expect((await grant(id, dispute(), { org: randomUUID() })).body.code).toBe('file_not_found');
      expect((await grant(id, dispute())).body.code).toBe('file_not_found');
      const plain = await uploaded();
      expect((await grant(plain, dispute(), { org })).body.code).toBe('file_not_found');
      const recs = await uploaded({ who: records });
      expect((await grant(recs, { purpose: 'settlement_evidence', caseRef: randomUUID() }, { who: records, org })).body.code).toBe('organization_not_allowed');
      expect((await grant(id, dispute(), { org: 'not-a-uuid' })).body.code).toBe('validation_error');
      expect([...(await rows(id)), ...(await rows(plain)), ...(await rows(recs))]).toEqual([]);
    });

    it('ineligible files: an unattached file is 409 file_not_grantable; a deleted file is 410 file_deleted', async () => {
      const loose = await uploaded({ attach: false });
      expect(await grant(loose, dispute()).then((r) => [r.status, r.body.code])).toEqual([409, 'file_not_grantable']);
      const gone = await uploaded();
      expect((await request(server()).delete(`/file/files/${gone}`).set(auth(drive))).status).toBe(202);
      expect(await grant(gone, dispute()).then((r) => [r.status, r.body.code])).toEqual([410, 'file_deleted']);
      expect([...(await rows(loose)), ...(await rows(gone))]).toEqual([]);
    });

    it('a caller that loses `grant` or the purpose can neither issue nor revoke (the policy is read per request)', async () => {
      const id = await uploaded();
      const issued = await grant(id, dispute());
      const narrowed = structuredClone(POLICY);
      narrowed.callers['core-drive'].grantPurposes = ['surplus_evidence'];
      const withoutPurpose = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(narrowed) });
      const without = structuredClone(POLICY) as { callers: Record<string, Record<string, unknown>> };
      without.callers['core-drive'] = { operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket'], organizations: 'request', mediaTypes: PDF, maxBytes: 1024 * 1024 };
      const withoutGrant = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(without) });
      try {
        const key = randomUUID();
        expect((await request(withoutPurpose.app.getHttpServer()).post(`/file/files/${id}/evidence-grants`).set({ ...auth(drive), 'idempotency-key': key }).send(dispute())).body.code)
          .toBe('purpose_not_allowed');
        expect((await request(withoutGrant.app.getHttpServer()).post(`/file/files/${id}/evidence-grants`).set({ ...auth(drive), 'idempotency-key': key }).send(dispute())).body.code)
          .toBe('operation_not_allowed');
        expect((await request(withoutGrant.app.getHttpServer()).post(`/file/evidence-grants/${issued.body.grantId}/revoke`).set(auth(drive)).send()).body.code)
          .toBe('operation_not_allowed');
      } finally {
        await withoutPurpose.app.close();
        await withoutGrant.app.close();
      }
      expect(await rows(id)).toHaveLength(1);
    });

    it('a grant opens nothing on the existing routes: the grantee still gets 404 for the file, its content and a ticket', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      expect((await grant(id, dispute(), { org })).status).toBe(201);
      for (const path of [`/file/files/${id}`, `/file/files/${id}/content`]) {
        const r = await request(server()).get(path).set(auth(payment, org));
        expect([r.status, r.body.code], path).toEqual([404, 'file_not_found']);
      }
      const tk = await request(server()).post(`/file/files/${id}/tickets`).set(auth(payment, org)).send({ operation: 'download' });
      expect([tk.status, tk.body.code]).toEqual([404, 'file_not_found']);
      expect((await revoke((await rows(id))[0]!.id as string, { who: payment, org })).body.code).toBe('operation_not_allowed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── idempotency

  describe('idempotency', () => {
    it('the same key and request answers the recorded grant (200), once in the database and once in the audit', async () => {
      const id = await uploaded();
      const body = dispute();
      const first = await grant(id, body, { key: 'grant-replay-1' });
      const again = await grant(id, body, { key: 'grant-replay-1' });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.body).toEqual(first.body);
      expect(await rows(id)).toHaveLength(1);
      expect(await audits(first.body.grantId)).toHaveLength(1);
      // an explicit default lifetime is the same request as the default
      expect((await grant(id, { ...body, expiresInSeconds: 24 * 3600 }, { key: 'grant-replay-1' })).status).toBe(200);
    });

    it('the same key with a different file, purpose, case, lifetime or organization is 422 idempotency_key_reused, creating nothing', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const other = await uploaded({ org });
      const body = dispute();
      expect((await grant(id, body, { key: 'grant-reuse', org })).status).toBe(201);
      for (const [fileId, b, o] of [
        [other, body, org], [id, { ...body, purpose: 'surplus_evidence' }, org], [id, { ...body, caseRef: randomUUID() }, org], [id, { ...body, expiresInSeconds: 3600 }, org],
      ] as const) {
        const r = await grant(fileId, b, { key: 'grant-reuse', org: o });
        expect([r.status, r.body.code], JSON.stringify(b)).toEqual([422, 'idempotency_key_reused']);
      }
      expect([...(await rows(id)), ...(await rows(other))]).toHaveLength(1);
    });

    it('keys belong to their grantor: another service using the same key gets its own grant', async () => {
      const a = await uploaded();
      const b = await uploaded({ who: records });
      const first = await grant(a, dispute(), { key: 'shared-key' });
      const second = await grant(b, { purpose: 'settlement_evidence', caseRef: randomUUID() }, { who: records, key: 'shared-key' });
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(second.body.grantId).not.toBe(first.body.grantId);
    });

    it('a lost response is recovered as recorded, never re-issued: after revocation (revoked) and after the file\'s deletion', async () => {
      const id = await uploaded();
      const body = dispute();
      const first = await grant(id, body, { key: 'grant-lost-1' });
      await revoke(first.body.grantId);
      const replay = await grant(id, body, { key: 'grant-lost-1' });
      expect([replay.status, replay.body.grantId, replay.body.status]).toEqual([200, first.body.grantId, 'revoked']);
      const second = await grant(id, body, { key: 'grant-lost-2' });
      expect((await request(server()).delete(`/file/files/${id}`).set(auth(drive))).status).toBe(202);
      const after = await grant(id, body, { key: 'grant-lost-2' });
      expect([after.status, after.body.grantId]).toEqual([200, second.body.grantId]);
      expect(await rows(id)).toHaveLength(2);
    });

    it('concurrent issuance with one key creates ONE grant and ONE audit intent; every caller gets that grant', async () => {
      const id = await uploaded();
      const body = dispute();
      const results = await Promise.all(Array.from({ length: 12 }, () => grant(id, body, { key: 'grant-race' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.grantId)).size).toBe(1);
      expect(await rows(id)).toHaveLength(1);
      expect(await audits(results[0]!.body.grantId)).toHaveLength(1);
    });

    it('a grant racing its file\'s deletion either commits before it or sees the file deleted (FOR SHARE)', async () => {
      for (let i = 0; i < 5; i++) {
        const id = await uploaded();
        const [g, d] = await Promise.all([grant(id, dispute()), request(server()).delete(`/file/files/${id}`).set(auth(drive))]);
        expect(d.status).toBe(202);
        expect([201, 410]).toContain(g.status);
        expect(await rows(id)).toHaveLength(g.status === 201 ? 1 : 0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── revocation

  describe('revocation', () => {
    it('the grantor revokes: 200 revoked, one audit intent; again: the same first revocation, no second intent', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const g = await grant(id, dispute(), { org });
      const first = await revoke(g.body.grantId, { org });
      expect(first.status).toBe(200);
      expect(first.headers['cache-control']).toBe('private, no-store');
      expect(first.body).toMatchObject({ grantId: g.body.grantId, status: 'revoked', revokedAt: expect.any(String) });
      const again = await revoke(g.body.grantId, { org });
      expect([again.status, again.body.revokedAt]).toEqual([200, first.body.revokedAt]);
      const events = await audits(g.body.grantId);
      expect(events.map((e) => e.payload.action)).toEqual(['file.grant_issued', 'file.grant_revoked']);
      expect(events[1]!.payload).toMatchObject({ actor: { type: 'service', id: 'core-drive' }, organizationId: org, changes: { file_id: id, purpose: 'dispute_evidence' } });
      expect(() => validateAuditPayload(events[1]!.payload, 'file-service')).not.toThrow();
    });

    it('only the grantor in the grant\'s organization: another service, another organization, a missing or malformed id are one 404 grant_not_found', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const g = await grant(id, dispute(), { org });
      for (const [grantId, o] of [
        [g.body.grantId, { who: records }], [g.body.grantId, { org: randomUUID() }], [g.body.grantId, {}], [randomUUID(), { org }], ['nope', { org }],
      ] as const) {
        const r = await revoke(grantId, o);
        expect([r.status, r.body.code]).toEqual([404, 'grant_not_found']);
      }
      expect((await rows(id))[0]!.revokedAt).toBeNull();
    });

    it('an expired grant shows `expired` and can still be revoked (the decision is recorded)', async () => {
      const id = await uploaded();
      const [old] = await s.query<{ id: string }>(
        `INSERT INTO file_evidence_grant (id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "idempotencyKey", "requestHash", "expiresAt", "createdAt")
         VALUES ($1, $2, 'core-drive', 'payment-service', 'dispute_evidence', $3, NULL, $4, $5, now() - interval '1 hour', now() - interval '2 hours') RETURNING id`,
        [randomUUID(), id, randomUUID(), randomUUID(), 'c'.repeat(64)],
      );
      expect(await t.app.get(GrantRepository).findUsable(use(old!.id, id))).toBeUndefined();
      const r = await revoke(old!.id);
      expect(r.body).toMatchObject({ status: 'revoked' });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────────── the granted-read foundation (S2-File.2)

  it('findUsable: exactly the grantee, the file and an allowed purpose, while active and the file AVAILABLE; anything else is undefined', async () => {
    const repo = t.app.get(GrantRepository);
    const id = await uploaded();
    const g = (await grant(id, dispute())).body;
    expect((await repo.findUsable(use(g.grantId, id)))?.grant).toMatchObject({ id: g.grantId, fileId: id, active: true });
    expect((await repo.findUsable(use(g.grantId, id)))?.file).toMatchObject({ id, status: 'AVAILABLE' });
    expect(await repo.findUsable(use(g.grantId, id, 'billing-service'))).toBeUndefined();
    expect(await repo.findUsable(use(g.grantId, id, 'payment-service', ['surplus_evidence']))).toBeUndefined();
    expect(await repo.findUsable(use(g.grantId, id, 'payment-service', []))).toBeUndefined();
    expect(await repo.findUsable(use(g.grantId, await uploaded()))).toBeUndefined();
    expect(await repo.findUsable(use('nope', id))).toBeUndefined();
    const deleted = await uploaded();
    const dg = (await grant(deleted, dispute())).body;
    await request(server()).delete(`/file/files/${deleted}`).set(auth(drive));
    expect(await repo.findUsable(use(dg.grantId, deleted))).toBeUndefined();
    await revoke(g.grantId);
    expect(await repo.findUsable(use(g.grantId, id))).toBeUndefined();
  });


  // ─────────────────────────────────────────────────────────────────────────────────────── database integrity

  describe('the schema enforces the grant on its own', () => {
    async function refused(text: string, params: unknown[]): Promise<string> {
      try {
        await s.query(text, params);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`accepted: ${text}`);
    }
    const insert = (fileId: string, over: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        id: randomUUID(), fileId, grantorService: 'core-drive', granteeService: 'payment-service', purpose: 'dispute_evidence', caseRef: randomUUID(), organizationId: null,
        idempotencyKey: randomUUID(), requestHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 3600_000), ...over,
      };
      return s.insert('file_evidence_grant', row);
    };

    it('the binding: the grantor owns the file, in its organization, AVAILABLE and attached; created active', async () => {
      const org = randomUUID();
      const id = await uploaded({ org });
      const loose = await uploaded({ attach: false });
      for (const [fileId, over] of [
        [id, { organizationId: org, grantorService: 'core-records' }], [id, { organizationId: null }], [id, { organizationId: randomUUID() }],
        [loose, {}], [randomUUID(), {}], [id, { organizationId: org, revokedAt: new Date() }],
      ] as const) {
        await expect(insert(fileId, over), JSON.stringify(over)).rejects.toThrow(/file_evidence_grant|foreign key/);
      }
      await expect(insert(id, { organizationId: org })).resolves.toHaveLength(1);
    });

    it('the closed purpose-grantee pairs, no self-grant, a bounded lifetime', async () => {
      const id = await uploaded();
      for (const over of [
        { purpose: 'dispute_evidence', granteeService: 'billing-service' }, { purpose: 'surplus_evidence', granteeService: 'payment-service' },
        { purpose: 'other_evidence', granteeService: 'payment-service' }, { grantorService: 'payment-service' },
        { expiresAt: new Date(Date.now() + 8 * 24 * 3600_000) }, { expiresAt: new Date(Date.now() - 1000) }, { requestHash: 'nope' }, { idempotencyKey: '' },
      ]) {
        await expect(insert(id, over), JSON.stringify(over)).rejects.toThrow();
      }
    });

    it('immutable except one terminal revocation; never deleted', async () => {
      const id = await uploaded();
      const g = (await grant(id, dispute())).body;
      for (const [col, value] of [
        ['expiresAt', new Date(Date.now() + 3600_000)], ['purpose', 'surplus_evidence'], ['granteeService', 'billing-service'], ['fileId', await uploaded()],
        ['organizationId', randomUUID()], ['caseRef', randomUUID()], ['grantorService', 'core-records'], ['createdAt', new Date()], ['requestHash', 'e'.repeat(64)],
      ] as const) {
        expect(await refused(`UPDATE file_evidence_grant SET "${col}" = $2 WHERE id = $1`, [g.grantId, value]), col).toMatch(/cannot be changed|immutable|changed/);
      }
      await revoke(g.grantId);
      expect(await refused(`UPDATE file_evidence_grant SET "revokedAt" = NULL WHERE id = $1`, [g.grantId])).toMatch(/set once/);
      expect(await refused(`UPDATE file_evidence_grant SET "revokedAt" = now() + interval '1 minute' WHERE id = $1`, [g.grantId])).toMatch(/set once/);
      expect(await refused(`DELETE FROM file_evidence_grant WHERE id = $1`, [g.grantId])).toMatch(/never deleted/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── audit durability, privacy

  describe('audit intent', () => {
    async function withRefusingOutbox<T>(fn: () => Promise<T>): Promise<T> {
      await s.query(`CREATE OR REPLACE FUNCTION s2f1_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                     CREATE TRIGGER s2f1_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name LIKE 'audit.file.grant_%') EXECUTE FUNCTION s2f1_refuse()`);
      try {
        return await fn();
      } finally {
        await s.query('DROP TRIGGER IF EXISTS s2f1_refuse ON outbox');
      }
    }

    it('is atomic with the change: when the audit intent cannot be written, no grant is issued and no grant is revoked', async () => {
      const id = await uploaded();
      const failed = await withRefusingOutbox(() => grant(id, dispute(), { key: 'grant-atomic' }));
      expect(failed.status).toBe(500);
      expect(await rows(id)).toEqual([]);
      const g = (await grant(id, dispute(), { key: 'grant-atomic-2' })).body;
      expect((await withRefusingOutbox(() => revoke(g.grantId))).status).toBe(500);
      expect((await rows(id))[0]!.revokedAt).toBeNull();
    });

    it('carries identifiers only, and no log line or audit payload carries the Idempotency-Key, the request hash or the file\'s name or bytes', async () => {
      const key = `secret-key-${randomUUID()}`;
      const id = await uploaded();
      const g = (await grant(id, dispute(), { key })).body;
      await revoke(g.grantId);
      const [row] = await s.query<{ requestHash: string }>('SELECT "requestHash" FROM file_evidence_grant WHERE id = $1', [g.grantId]);
      const text = JSON.stringify(await audits(g.grantId)) + JSON.stringify(ALL_LOGS);
      expect(text).not.toContain(key);
      expect(text).not.toContain(row!.requestHash);
      expect(JSON.stringify(await audits(g.grantId))).not.toMatch(/files\/|\.pdf|storage|sha256|sizeBytes|idempotency/i);
      expect(g).not.toHaveProperty('idempotencyKey');
      expect(g).not.toHaveProperty('requestHash');
    });
  });
});
