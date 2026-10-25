import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';

const PDF_PNG = ['application/pdf', 'image/png'];
type Policy = { callers: Record<string, Record<string, unknown>> };
const POLICY: Policy = {
  callers: {
    'core-drive': {
      operations: ['upload', 'read', 'attach', 'delete', 'issue_ticket', 'grant'], organizations: 'request', mediaTypes: PDF_PNG, maxBytes: 1024 * 1024,
      grantPurposes: ['dispute_evidence', 'surplus_evidence'],
    },
    // the dispute grantee: may read granted files; its ordinary `read` / `issue_ticket` still reach only its own files
    'payment-service': { operations: ['read', 'issue_ticket', 'read_granted'], organizations: 'request', mediaTypes: PDF_PNG, maxBytes: 1024 * 1024, readPurposes: ['dispute_evidence'] },
    // the surplus / settlement grantee
    'billing-service': { operations: ['read_granted'], organizations: 'none', readPurposes: ['surplus_evidence'] },
    'core-reader': { operations: ['read'], organizations: 'none' },
  },
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const parts: Buffer[] = [];
  res.on('data', (c: Buffer) => parts.push(c));
  res.on('end', () => cb(null, Buffer.concat(parts)));
};

/**
 * Core V2 S2-File.2 (register FIL-02 / FIL-03; ADR-0048 Amendment 1): a grantee service's metadata, content and ticket access to ONE
 * file through ONE of its active evidence grants, on the REAL application (real PostgreSQL, the filesystem store): authority, isolation,
 * revocation, expiry, deletion, policy loss, ticket binding and lifetime, concurrency, and the `file.granted_read` record.
 */
describeWithEnv('granted reads and grant tickets (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const payment = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [
    { caller: 'core-drive', digest: drive.digest }, { caller: 'payment-service', digest: payment.digest },
    { caller: 'billing-service', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest },
  ];
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filegranted');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(POLICY), env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  async function uploaded(opts: { org?: string | null; bytes?: Buffer; name?: string } = {}): Promise<{ id: string; bytes: Buffer }> {
    const bytes = opts.bytes ?? SAMPLES.pdf(3000);
    const headers: Record<string, string> = { ...auth(drive, opts.org), 'idempotency-key': randomUUID(), 'x-attach': 'true' };
    if (opts.name) headers['x-file-name'] = encodeURIComponent(opts.name);
    const r = await request(server()).post('/file/files').set(headers).send(bytes);
    expect(r.status).toBe(201);
    return { id: r.body.id as string, bytes };
  }
  async function granted(opts: { org?: string | null; purpose?: string; bytes?: Buffer; name?: string; expiresInSeconds?: number } = {}) {
    const f = await uploaded(opts);
    const r = await request(server()).post(`/file/files/${f.id}/evidence-grants`).set({ ...auth(drive, opts.org), 'idempotency-key': randomUUID() })
      .send({ purpose: opts.purpose ?? 'dispute_evidence', caseRef: randomUUID(), ...(opts.expiresInSeconds ? { expiresInSeconds: opts.expiresInSeconds } : {}) });
    expect(r.status).toBe(201);
    return { fileId: f.id, bytes: f.bytes, grantId: r.body.grantId as string, expiresAt: r.body.expiresAt as string, org: opts.org ?? null };
  }
  const base = (grantId: string, fileId: string) => `/file/evidence-grants/${grantId}/files/${fileId}`;
  const meta = (g: { grantId: string; fileId: string }, who = payment, srv = server()) => request(srv).get(base(g.grantId, g.fileId)).set(auth(who));
  const content = (g: { grantId: string; fileId: string }, who = payment, srv = server()) =>
    request(srv).get(`${base(g.grantId, g.fileId)}/content`).set(auth(who)).buffer(true).parse(binary);
  const ticket = (g: { grantId: string; fileId: string }, body: Record<string, unknown> = {}, who = payment, srv = server()) =>
    request(srv).post(`${base(g.grantId, g.fileId)}/tickets`).set(auth(who)).send({ operation: 'download', ...body });
  const redeem = (url: string, srv = server()) => request(srv).get(new URL(url).pathname).buffer(true).parse(binary);
  const revokeGrant = (grantId: string, org?: string | null) => request(server()).post(`/file/evidence-grants/${grantId}/revoke`).set(auth(drive, org)).send();
  const reads = (grantId: string) =>
    s.query<{ payload: Record<string, any> }>(`SELECT payload FROM outbox WHERE name = 'audit.file.granted_read' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [grantId]);
  const accesses = async (grantId: string) => (await reads(grantId)).map((r) => r.payload.changes.access as string);
  const bodyCode = (r: { body: unknown }) => (Buffer.isBuffer(r.body) ? (JSON.parse(r.body.toString('utf8')) as { code: string }).code : (r.body as { code: string }).code);
  async function withPolicy<T>(policy: Policy, fn: (srv: ReturnType<TestApp['app']['getHttpServer']>) => Promise<T>): Promise<T> {
    const app = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(policy), env: { FILE_TICKET_FAILURE_LIMIT: '1000' } });
    try {
      return await fn(app.app.getHttpServer());
    } finally {
      await app.app.close();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────── authorized reads

  describe('the grantee reads the granted file', () => {
    it('metadata: 200 (no-store), exactly the file, one `metadata` record by the grantee in the file\'s organization', async () => {
      const org = randomUUID();
      const g = await granted({ org });
      const r = await meta(g);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.body).toMatchObject({ id: g.fileId, status: 'AVAILABLE', mediaType: 'application/pdf', organizationId: org });
      expect(JSON.stringify(r.body)).not.toMatch(/storageKey|storageProvider/);
      const [rec] = await reads(g.grantId);
      expect(rec!.payload).toMatchObject({
        action: 'file.granted_read', actor: { type: 'service', id: 'payment-service' }, organizationId: org,
        resource: { type: 'file_evidence_grant', id: g.grantId }, outcome: 'succeeded', changes: { file_id: g.fileId, purpose: 'dispute_evidence', access: 'metadata' },
      });
      expect(() => validateAuditPayload(rec!.payload, 'file-service')).not.toThrow();
    });

    it('content: the exact bytes, recorded once as `content_authorized` (authorization, not delivery) before the stream', async () => {
      const g = await granted({ org: randomUUID() });
      const r = await content(g);
      expect(r.status).toBe(200);
      expect(sha(r.body as Buffer)).toBe(sha(g.bytes));
      expect(r.headers).toMatchObject({ 'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      expect(r.headers['cross-origin-resource-policy']).not.toBe('cross-origin'); // a service read, not a client ticket
      expect(await accesses(g.grantId)).toEqual(['content_authorized']);
    });

    it('the other grantee reads its own purpose (surplus_evidence → billing-service, a caller with no organization mode)', async () => {
      const g = await granted({ org: randomUUID(), purpose: 'surplus_evidence' });
      expect((await meta(g, billing)).status).toBe(200);
      expect((await meta(g, payment)).status).toBe(404); // not payment's grant
    });

    it('HEAD is refused (405) and records nothing: it would authorize an access just to send headers', async () => {
      const g = await granted();
      expect((await request(server()).head(base(g.grantId, g.fileId)).set(auth(payment))).status).toBe(405);
      expect((await request(server()).head(`${base(g.grantId, g.fileId)}/content`).set(auth(payment))).status).toBe(405);
      expect(await reads(g.grantId)).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────── authority and isolation

  describe('authority and isolation', () => {
    it('no or an unknown token is 401; a caller without read_granted is 403 before any lookup', async () => {
      const g = await granted();
      expect((await request(server()).get(base(g.grantId, g.fileId))).status).toBe(401);
      expect((await request(server()).get(base(g.grantId, g.fileId)).set(auth(generateServiceToken()))).status).toBe(401);
      for (const r of [await meta(g, reader), await content(g, reader), await ticket(g, {}, reader), await meta(g, drive)]) {
        expect([r.status, bodyCode(r)]).toEqual([403, 'operation_not_allowed']);
      }
      expect(await reads(g.grantId)).toEqual([]);
    });

    it('everything else is one 404 file_not_found and records nothing: another grantee, another file, malformed or unknown ids', async () => {
      const g = await granted();
      const other = await granted(); // also payment's, for another file
      for (const [grantId, fileId, who] of [
        [g.grantId, g.fileId, billing], [g.grantId, other.fileId, payment], [other.grantId, g.fileId, payment], [randomUUID(), g.fileId, payment],
        [g.grantId, randomUUID(), payment], ['nope', g.fileId, payment], [g.grantId, 'nope', payment],
      ] as const) {
        for (const r of [await meta({ grantId, fileId }, who), await content({ grantId, fileId }, who), await ticket({ grantId, fileId }, {}, who)]) {
          expect([r.status, bodyCode(r)], `${grantId} ${fileId}`).toEqual([404, 'file_not_found']);
        }
      }
      expect([...(await reads(g.grantId)), ...(await reads(other.grantId))]).toEqual([]);
    });

    it('no scope from the request: a forged X-Organization-Id is ignored, and the organization recorded is the grant\'s', async () => {
      const org = randomUUID();
      const g = await granted({ org });
      const r = await request(server()).get(base(g.grantId, g.fileId)).set(auth(payment, randomUUID()));
      expect(r.status).toBe(200);
      expect(r.body.organizationId).toBe(org);
      expect((await reads(g.grantId))[0]!.payload.organizationId).toBe(org);
    });

    it('a grant opens nothing else: the owner-only routes still answer the grantee 404, and the owner still reads its file', async () => {
      const org = randomUUID();
      const g = await granted({ org });
      expect((await request(server()).get(`/file/files/${g.fileId}`).set(auth(payment, org))).body.code).toBe('file_not_found');
      expect((await request(server()).get(`/file/files/${g.fileId}/content`).set(auth(payment, org))).body.code).toBe('file_not_found');
      expect((await request(server()).post(`/file/files/${g.fileId}/tickets`).set(auth(payment, org)).send({ operation: 'download' })).body.code).toBe('file_not_found');
      expect((await request(server()).get(`/file/files/${g.fileId}`).set(auth(drive, org))).status).toBe(200);
      expect(await reads(g.grantId)).toEqual([]); // owner reads are not granted reads
    });

    it('the CURRENT policy decides: a grantee without the purpose or read_granted, a grantor without grant or the purpose, read nothing', async () => {
      const g = await granted();
      const variants: Array<[string, (p: Policy) => void, number]> = [
        ['grantee lost the purpose', (p) => { p.callers['payment-service']!.readPurposes = ['surplus_evidence']; }, 404],
        ['grantee lost read_granted', (p) => { p.callers['payment-service'] = { operations: ['read'], organizations: 'request' }; }, 403],
        ['grantor lost the purpose', (p) => { p.callers['core-drive']!.grantPurposes = ['surplus_evidence']; }, 404],
        ['grantor lost grant', (p) => { p.callers['core-drive'] = { operations: ['upload', 'read', 'attach'], organizations: 'request', mediaTypes: PDF_PNG, maxBytes: 1024 * 1024 }; }, 404],
      ];
      for (const [label, change, status] of variants) {
        const p = structuredClone(POLICY);
        change(p);
        await withPolicy(p, async (srv) => {
          for (const r of [await meta(g, payment, srv), await content(g, payment, srv), await ticket(g, {}, payment, srv)]) expect(r.status, label).toBe(status);
        });
      }
      expect(await reads(g.grantId)).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────── revocation, expiry, deletion

  describe('revocation, expiry and deletion', () => {
    it('a revoked grant authorizes nothing new (metadata, content, tickets)', async () => {
      const g = await granted();
      expect((await meta(g)).status).toBe(200);
      await revokeGrant(g.grantId);
      for (const r of [await meta(g), await content(g), await ticket(g)]) expect([r.status, bodyCode(r)]).toEqual([404, 'file_not_found']);
      expect(await accesses(g.grantId)).toEqual(['metadata']);
    });

    it('an expired grant authorizes nothing', async () => {
      const f = await uploaded();
      const [row] = await s.query<{ id: string }>(
        `INSERT INTO file_evidence_grant (id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "idempotencyKey", "requestHash", "expiresAt", "createdAt")
         VALUES ($1, $2, 'core-drive', 'payment-service', 'dispute_evidence', $3, NULL, $4, $5, now() - interval '1 second', now() - interval '1 hour') RETURNING id`,
        [randomUUID(), f.id, randomUUID(), randomUUID(), 'a'.repeat(64)],
      );
      const g = { grantId: row!.id, fileId: f.id };
      for (const r of [await meta(g), await content(g), await ticket(g)]) expect(r.status).toBe(404);
    });

    it('a file entering deletion ends access through its grants and kills their tickets', async () => {
      const g = await granted();
      const tk = await ticket(g);
      expect(tk.status).toBe(201);
      expect((await request(server()).delete(`/file/files/${g.fileId}`).set(auth(drive))).status).toBe(202);
      for (const r of [await meta(g), await content(g), await ticket(g)]) expect(r.status).toBe(404);
      expect(bodyCode(await redeem(tk.body.url as string))).toBe('ticket_invalid');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── grant tickets

  describe('tickets from a grant', () => {
    it('bound to the grant, its file and organization, issued by the grantee; redeemed for the exact bytes; both recorded', async () => {
      const org = randomUUID();
      const g = await granted({ org });
      const tk = await ticket(g);
      expect(tk.status).toBe(201);
      expect(tk.body).toEqual({ ticketId: expect.any(String), url: expect.stringMatching(/^https:\/\/files\.test\.invalid\/file\/t\/[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
      const [row] = await s.query<Record<string, unknown>>('SELECT * FROM file_access_ticket WHERE id = $1', [tk.body.ticketId]);
      expect(row).toMatchObject({ grantId: g.grantId, fileId: g.fileId, issuedBy: 'payment-service', organizationId: org, operation: 'download', singleUse: false });
      const r = await redeem(tk.body.url as string);
      expect(r.status).toBe(200);
      expect(sha(r.body as Buffer)).toBe(sha(g.bytes));
      expect(r.headers['cross-origin-resource-policy']).toBe('cross-origin');
      const recs = await reads(g.grantId);
      expect(recs.map((x) => x.payload.changes.access)).toEqual(['ticket_issued', 'ticket_redemption_authorized']);
      expect(recs[0]!.payload.actor).toEqual({ type: 'service', id: 'payment-service' });
      expect(recs[1]!.payload.actor).toEqual({ type: 'system', id: 'file_granted_ticket_redemption' });
      for (const x of recs) expect(() => validateAuditPayload(x.payload, 'file-service')).not.toThrow();
    });

    it('never outlives its grant: a ticket ends with a grant that ends first; a grant ending within 60 s is 409 grant_expiring', async () => {
      const g = await granted({ expiresInSeconds: 90 });
      const tk = await ticket(g);
      expect(tk.body.expiresAt).toBe(g.expiresAt); // the configured 120 s ticket would outlive the 90 s grant
      const f = await uploaded();
      const [row] = await s.query<{ id: string }>(
        `INSERT INTO file_evidence_grant (id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "idempotencyKey", "requestHash", "expiresAt", "createdAt")
         VALUES ($1, $2, 'core-drive', 'payment-service', 'dispute_evidence', $3, NULL, $4, $5, now() + interval '30 seconds', now() - interval '1 hour') RETURNING id`,
        [randomUUID(), f.id, randomUUID(), randomUUID(), 'b'.repeat(64)],
      );
      const late = await ticket({ grantId: row!.id, fileId: f.id });
      expect([late.status, late.body.code]).toEqual([409, 'grant_expiring']);
      expect(await s.query('SELECT 1 FROM file_access_ticket WHERE "grantId" = $1', [row!.id])).toEqual([]);
      expect(await reads(row!.id)).toEqual([]); // the refusal rolled the record back
      const long = await granted();
      expect(Date.parse((await ticket(long)).body.expiresAt) - Date.now()).toBeLessThanOrEqual(121_000); // otherwise the ticket's own lifetime
    });

    it('single use is preserved: one redemption, then ticket_invalid', async () => {
      const g = await granted();
      const tk = await ticket(g, { singleUse: true });
      expect((await redeem(tk.body.url as string)).status).toBe(200);
      expect(bodyCode(await redeem(tk.body.url as string))).toBe('ticket_invalid');
    });

    it('disposition: inline only for an image', async () => {
      const pdf = await granted();
      expect(await ticket(pdf, { disposition: 'inline' }).then((r) => [r.status, r.body.code])).toEqual([422, 'disposition_not_allowed']);
      const png = await granted({ bytes: SAMPLES.png(200) });
      const tk = await ticket(png, { disposition: 'inline' });
      expect(tk.status).toBe(201);
      expect((await redeem(tk.body.url as string)).headers['content-disposition']).toMatch(/^inline/);
    });

    it('revoking the grant revokes its tickets; a ticket is refused even when only the grant was revoked (redemption re-checks it)', async () => {
      const g = await granted();
      const tk = await ticket(g);
      await revokeGrant(g.grantId);
      expect((await s.query<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM file_access_ticket WHERE id = $1', [tk.body.ticketId]))[0]!.revokedAt).not.toBeNull();
      expect(bodyCode(await redeem(tk.body.url as string))).toBe('ticket_invalid');
      // the claim's own re-check: revoke ONLY the grant row (as a bypass would), the ticket row stays live
      const h = await granted();
      const tk2 = await ticket(h);
      await s.query(`UPDATE file_evidence_grant SET "revokedAt" = now() WHERE id = $1`, [h.grantId]);
      expect((await s.query<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM file_access_ticket WHERE id = $1', [tk2.body.ticketId]))[0]!.revokedAt).toBeNull();
      const r = await redeem(tk2.body.url as string);
      expect(bodyCode(r)).toBe('ticket_invalid');
      expect((await s.query<{ useCount: number }>('SELECT "useCount" FROM file_access_ticket WHERE id = $1', [tk2.body.ticketId]))[0]!.useCount).toBe(0);
      expect(await accesses(h.grantId)).toEqual(['ticket_issued']);
    });

    it('redemption re-reads the policy: a grantee that lost read_granted or the purpose, or a grantor that lost grant, redeems nothing', async () => {
      const g = await granted();
      const urls = [(await ticket(g)).body.url as string, (await ticket(g)).body.url as string, (await ticket(g)).body.url as string];
      const variants: Array<(p: Policy) => void> = [
        (p) => { p.callers['payment-service'] = { operations: ['read'], organizations: 'request' }; },
        (p) => { p.callers['payment-service']!.readPurposes = ['surplus_evidence']; },
        (p) => { p.callers['core-drive']!.grantPurposes = ['surplus_evidence']; },
      ];
      for (const [i, change] of variants.entries()) {
        const p = structuredClone(POLICY);
        change(p);
        await withPolicy(p, async (srv) => expect(bodyCode(await redeem(urls[i]!, srv))).toBe('ticket_invalid'));
      }
      expect((await redeem(urls[0]!)).status).toBe(200); // nothing was consumed by the refusals
    });

    it('the schema refuses a grant ticket that its grant does not cover or that outlives it', async () => {
      const g = await granted({ expiresInSeconds: 600 });
      const other = await uploaded();
      const row = (over: Record<string, unknown>) => ({
        id: randomUUID(), operation: 'download', fileId: g.fileId, issuedBy: 'payment-service', organizationId: null, tokenDigest: sha(Buffer.from(randomUUID())),
        disposition: 'attachment', singleUse: false, expiresAt: new Date(Date.now() + 120_000), grantId: g.grantId, ...over,
      });
      for (const over of [{ issuedBy: 'billing-service' }, { fileId: other.id }, { organizationId: randomUUID() }]) {
        await expect(s.insert('file_access_ticket', row(over)), JSON.stringify(over)).rejects.toThrow(/grant does not cover/);
      }
      await expect(s.insert('file_access_ticket', row({ expiresAt: new Date(Date.parse(g.expiresAt) + 1000), createdAt: new Date(Date.parse(g.expiresAt) - 120_000) })))
        .rejects.toThrow(/ends first/);
      const [ok] = await s.insert('file_access_ticket', row({}));
      await expect(s.query(`UPDATE file_access_ticket SET "grantId" = NULL WHERE id = $1`, [ok!.id])).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency

  describe('concurrency', () => {
    it('a deletion that waited for the file row still revokes a ticket created while it waited (the stamp never precedes the ticket)', async () => {
      const g = await granted();
      const holder = new pg.Client({ connectionString: db.url });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM file WHERE id = $1 FOR SHARE', [g.fileId]); // a read holding the file, as an authorization does
        const deletion = request(server()).delete(`/file/files/${g.fileId}`).set(auth(drive)).then((r) => r); // begins, then waits for the row
        await new Promise((r) => setTimeout(r, 200));
        const tk = await ticket(g); // a share lock is still granted: created AFTER the deletion's transaction began
        expect(tk.status).toBe(201);
        await holder.query('COMMIT');
        const d = await deletion;
        expect(d.status).toBe(202); // was 500: revokedAt = now() < the ticket's createdAt failed its CHECK
        expect((await s.query<{ revokedAt: Date | null }>('SELECT "revokedAt" FROM file_access_ticket WHERE id = $1', [tk.body.ticketId]))[0]!.revokedAt).not.toBeNull();
        expect(bodyCode(await redeem(tk.body.url as string))).toBe('ticket_invalid');
      } finally {
        await holder.end();
      }
    });

    it('content reads and ticket requests racing a deletion: the deletion always succeeds; authorized accesses are recorded, later ones refused', async () => {
      for (let i = 0; i < 5; i++) {
        const g = await granted();
        const results = await Promise.all([content(g), ticket(g), request(server()).delete(`/file/files/${g.fileId}`).set(auth(drive)), meta(g), content(g)]);
        expect(results[2]!.status).toBe(202);
        const authorized = results.filter((r, j) => j !== 2 && (r.status === 200 || r.status === 201)).length;
        expect(results.filter((r, j) => j !== 2 && r.status >= 400).every((r) => r.status === 404)).toBe(true);
        expect(await accesses(g.grantId)).toHaveLength(authorized);
        expect((await meta(g)).status).toBe(404);
      }
    });

    it('reads racing a revocation: each read is either authorized-and-recorded or refused; nothing after the revocation', async () => {
      const g = await granted();
      const results = await Promise.all([...Array.from({ length: 10 }, () => meta(g)), revokeGrant(g.grantId), ...Array.from({ length: 10 }, () => meta(g))]);
      const ok = results.filter((r) => r.status === 200 && r.body.id === g.fileId).length;
      expect(results.filter((r) => r.status !== 200).every((r) => r.status === 404)).toBe(true);
      expect(await accesses(g.grantId)).toHaveLength(ok);
      expect((await meta(g)).status).toBe(404);
    });

    it('tickets issued while the grant is revoked all end revoked: none redeems afterwards', async () => {
      const g = await granted();
      const results = await Promise.all([...Array.from({ length: 8 }, () => ticket(g)), revokeGrant(g.grantId)]);
      expect(results.at(-1)!.status).toBe(200); // the revocation succeeds even when it waited for tickets created after it began
      const issued = results.filter((r) => r.status === 201);
      for (const r of issued) expect(bodyCode(await redeem(r.body.url as string))).toBe('ticket_invalid');
      expect(await s.query('SELECT 1 FROM file_access_ticket WHERE "grantId" = $1 AND "revokedAt" IS NULL', [g.grantId])).toEqual([]);
    });

    it('a single-use grant ticket redeemed concurrently serves exactly once and is recorded exactly once', async () => {
      const g = await granted();
      const tk = await ticket(g, { singleUse: true });
      const results = await Promise.all(Array.from({ length: 6 }, () => redeem(tk.body.url as string)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await accesses(g.grantId)).filter((a) => a === 'ticket_redemption_authorized')).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────── audit atomicity, privacy

  describe('the record', () => {
    async function withRefusingOutbox<T>(fn: () => Promise<T>): Promise<T> {
      await s.query(`CREATE OR REPLACE FUNCTION s2f2_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                     CREATE TRIGGER s2f2_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = 'audit.file.granted_read') EXECUTE FUNCTION s2f2_refuse()`);
      try {
        return await fn();
      } finally {
        await s.query('DROP TRIGGER IF EXISTS s2f2_refuse ON outbox');
      }
    }

    it('no record, no access: metadata, content, ticket issuance and redemption all fail closed, consuming nothing', async () => {
      const g = await granted();
      const tk = await ticket(g, { singleUse: true });
      await withRefusingOutbox(async () => {
        expect((await meta(g)).status).toBe(500);
        const c = await content(g);
        expect(c.status).toBe(500);
        expect(sha(c.body as Buffer)).not.toBe(sha(g.bytes));
        expect((await ticket(g)).status).toBe(500);
        expect((await redeem(tk.body.url as string)).status).toBe(500);
      });
      expect(await s.query('SELECT 1 FROM file_access_ticket WHERE "grantId" = $1', [g.grantId])).toHaveLength(1); // only the first
      expect((await redeem(tk.body.url as string)).status).toBe(200); // the single use was not spent
      expect(await accesses(g.grantId)).toEqual(['ticket_issued', 'ticket_redemption_authorized']);
    });

    it('carries identifiers only: no token, ticket URL, file name or bytes in a record or a log line', async () => {
      const name = `SECRET_EVIDENCE_${randomUUID()}.pdf`;
      const g = await granted({ name });
      await meta(g);
      await content(g);
      const tk = await ticket(g);
      await redeem(tk.body.url as string);
      const token = new URL(tk.body.url as string).pathname.split('/').pop()!;
      const recs = JSON.stringify(await reads(g.grantId));
      const logs = JSON.stringify(ALL_LOGS);
      for (const text of [recs, logs]) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(name);
      }
      expect(recs).not.toMatch(/originalName|storage|sha256|sizeBytes|ticket_id|url/);
      expect(logs).toContain(`file_granted_read access=content_authorized grantee=payment-service grant=${g.grantId}`);
    });
  });
});
