import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { TicketRepository } from '../src/persistence/ticket.repository.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { newToken, Sql } from './support/fixtures.js';
import { ADVERSARIAL, SAMPLES } from './support/media.js';
import { peakBufferGrowth } from './support/storage-contract.js';
import { eventually, rawRequest, UPLOAD_POLICY, type RawResponse } from './support/upload.js';

/**
 * Stage 17.5: the upload lifecycle end to end on the REAL application (real PostgreSQL, the filesystem store): ticket issuance by a
 * trusted service, redemption by an untrusted client, service upload, attach; the refusals, the failures and what they leave behind.
 */
describeWithEnv('upload lifecycle (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  let storage: StoragePort;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest }];
  const policy = JSON.stringify(UPLOAD_POLICY);
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }) => ({ authorization: `Bearer ${tok.token}` });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileupload');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1000', FILE_UPLOAD_IDLE_TIMEOUT_MS: '1000' } });
    await t.app.listen(0, '127.0.0.1');
    storage = t.app.get<StoragePort>(STORAGE_PORT);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  const issue = async (body: Record<string, unknown> = {}, who = drive) => {
    const r = await request(server()).post('/file/uploads/tickets').set(auth(who)).send({ maxBytes: 5 * 1024 * 1024, mediaTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'], ...body });
    return r;
  };
  const tokenOf = (url: string) => url.split('/file/t/')[1]!;
  const redeem = (token: string, bytes: Buffer, headers: Record<string, string> = {}) =>
    request(server()).put(`/file/t/${token}`).set({ 'content-type': 'application/octet-stream', ...headers }).send(bytes);
  const fileRow = async (id: string) => (await s.query('SELECT * FROM file WHERE id = $1', [id]))[0] as Record<string, unknown>;
  const ticketRowByToken = async (token: string) => (await s.query('SELECT * FROM file_access_ticket WHERE "tokenDigest" = $1', [createHash('sha256').update(token).digest('hex')]))[0] as Record<string, unknown> | undefined;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const stored = async (key: string) => {
    const got = await storage.get(key, { signal: new AbortController().signal }).catch(() => undefined);
    if (!got) return undefined;
    const h = createHash('sha256');
    for await (const c of got.body) h.update(c as Buffer);
    return h.digest('hex');
  };

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────── issuance

  it('a trusted service gets a short-lived ticket URL; only the digest is stored; the response is not cacheable', async () => {
    const r = await issue();
    expect(r.status).toBe(201);
    expect(r.body.url).toMatch(/^https:\/\/files\.test\.invalid\/file\/t\/[A-Za-z0-9_-]{43}$/);
    expect(r.headers['cache-control']).toBe('no-store');
    const lifetime = new Date(r.body.expiresAt as string).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(100_000);
    expect(lifetime).toBeLessThanOrEqual(121_000); // the 120 s default (F16: 60-300 s)
    const token = tokenOf(r.body.url as string);
    const row = await ticketRowByToken(token);
    expect(row).toMatchObject({ id: r.body.ticketId, operation: 'upload', issuedBy: 'core-drive', singleUse: true, useCount: 0, fileId: null });
    expect(JSON.stringify(await s.query('SELECT * FROM file_access_ticket'))).not.toContain(token); // never the raw token
  });

  it('issuance: no token 401; no issue_ticket 403; the owner cannot be spoofed; policy bounds on organization, size and types', async () => {
    await request(server()).post('/file/uploads/tickets').send({ maxBytes: 10, mediaTypes: ['application/pdf'] }).expect(401);
    expect((await issue({}, reader)).body.code).toBe('operation_not_allowed');
    expect((await issue({ ownerService: 'core-billing' })).status).toBe(400); // unknown field: the owner is the token's caller
    expect((await issue({ maxBytes: 26 * 1024 * 1024 })).body.code).toBe('max_bytes_not_allowed');
    expect((await issue({ mediaTypes: ['text/html'] })).status).toBe(400);
    const billingIssue = await issue({ organizationId: randomUUID() }, billing);
    expect(billingIssue.body.code).toBe('operation_not_allowed'); // billing has no issue_ticket at all
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── redemption

  it('redeems a PDF: 201, the file is AVAILABLE with the detected type, exact size and SHA-256; owned by the issuer; bytes stored', async () => {
    const org = randomUUID();
    const token = tokenOf((await issue({ organizationId: org })).body.url as string);
    const pdf = SAMPLES.pdf(200_000);
    const r = await redeem(token, pdf, { 'x-file-name': encodeURIComponent('جواز السفر.pdf'), 'content-type': 'application/pdf' });
    expect(r.status).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ status: 'AVAILABLE', mediaType: 'application/pdf', sizeBytes: pdf.length, sha256: sha(pdf), organizationId: org, originalName: 'جواز السفر.pdf', attachedAt: null });
    expect(Object.keys(r.body)).not.toEqual(expect.arrayContaining(['storageKey']));
    expect(JSON.stringify(r.body)).not.toMatch(/storageKey|storageProvider|files\/|idempotency/);
    const row = await fileRow(r.body.id as string);
    expect(row).toMatchObject({ ownerService: 'core-drive', organizationId: org, declaredMediaType: 'application/pdf', status: 'AVAILABLE' });
    expect(await stored(row.storageKey as string)).toBe(sha(pdf));
    expect(await ticketRowByToken(token)).toMatchObject({ fileId: r.body.id, useCount: 1 });
  });

  it.each([['jpeg', SAMPLES.jpeg(5000), 'image/jpeg'], ['png', SAMPLES.png(5000), 'image/png'], ['webp', SAMPLES.webp(5000), 'image/webp'],
    ['heic', SAMPLES.heic(5000), 'image/heic'], ['heif', SAMPLES.heif(5000), 'image/heif']])('redeems a %s', async (_l, bytes, type) => {
    const token = tokenOf((await issue()).body.url as string);
    const r = await redeem(token, bytes);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ mediaType: type, sha256: sha(bytes) });
  });

  it('a ticket is single-use: the retry of a completed upload returns the SAME file (200) and writes nothing', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const first = await redeem(token, SAMPLES.png(3000));
    expect(first.status).toBe(201);
    const count = (await s.query<{ n: number }>('SELECT count(*)::int AS n FROM file'))[0]!.n;
    const again = await redeem(token, SAMPLES.pdf(9000)); // even with other bytes
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.mediaType).toBe('image/png');
    expect((await s.query<{ n: number }>('SELECT count(*)::int AS n FROM file'))[0]!.n).toBe(count);
  });

  it('20 concurrent redemptions of one ticket: exactly one uploads; one file, one object', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const results = await Promise.all(Array.from({ length: 20 }, () => redeem(token, SAMPLES.pdf(150_000))));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect([200, 409]).toContain(r.status); // a replay of the finished upload, or "in progress": never a second write
      if (r.status === 200) expect(r.body.id).toBe(created[0]!.body.id);
      if (r.status === 409) expect(r.body.code).toBe('upload_in_progress');
    }
    const ticket = await ticketRowByToken(token);
    expect(ticket).toMatchObject({ useCount: 1, fileId: created[0]!.body.id });
    expect((await s.query('SELECT id FROM file WHERE id = $1', [created[0]!.body.id]))).toHaveLength(1);
  });

  it('every invalid ticket is the same 404 ticket_invalid: unknown, malformed, expired, revoked, used-after-failure, a download ticket', async () => {
    const f = (await redeem(tokenOf((await issue()).body.url as string), SAMPLES.png(100))).body;
    const expired = newToken();
    await s.query(`INSERT INTO file_access_ticket (id, operation, "issuedBy", "tokenDigest", "maxBytes", "mediaTypes", attach, "singleUse", "createdAt", "expiresAt")
      VALUES ($1, 'upload', 'core-drive', $2, 1000, ARRAY['application/pdf'], false, true, now() - interval '10 minutes', now() - interval '8 minutes')`, [randomUUID(), expired.digest]);
    const revokedUrl = (await issue()).body;
    await t.app.get(TicketRepository).revoke('core-drive', revokedUrl.ticketId as string);
    const failedToken = tokenOf((await issue()).body.url as string);
    expect((await redeem(failedToken, ADVERSARIAL.windowsExe())).status).toBe(415); // consumed by a refused upload
    const download = newToken();
    await s.query(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "expiresAt")
      VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', false, now() + interval '120 seconds')`, [randomUUID(), f.id, download.digest]);
    const bodies: unknown[] = [];
    for (const token of [newToken().token, 'abc', '../../../etc/passwd', expired.token, tokenOf(revokedUrl.url as string), failedToken, download.token]) {
      const r = await redeem(encodeURIComponent(token), SAMPLES.pdf());
      expect(r.status, token.slice(0, 6)).toBe(404);
      const { requestId: _r, ...rest } = r.body as Record<string, unknown>;
      bodies.push(rest);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1); // indistinguishable
    expect(bodies[0]).toEqual({ statusCode: 404, message: 'The upload link is not valid.', error: 'Not Found', code: 'ticket_invalid' });
    expect((await s.query<{ useCount: number }>(`SELECT "useCount" FROM file_access_ticket WHERE "tokenDigest" = $1`, [download.digest]))[0]!.useCount).toBe(0); // not consumed by a PUT
  });

  it('a ticket whose issuer lost issue_ticket is invalid (checked at redemption, the ticket not consumed)', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const restricted = JSON.parse(policy) as typeof UPLOAD_POLICY;
    restricted.callers['core-drive'].operations = ['upload', 'read', 'attach'];
    const other = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(restricted) });
    try {
      const r = await request(other.app.getHttpServer()).put(`/file/t/${token}`).send(SAMPLES.pdf());
      expect(r.body.code).toBe('ticket_invalid');
      expect(await ticketRowByToken(token)).toMatchObject({ useCount: 0, fileId: null });
    } finally {
      await other.app.close();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────── size

  it('size: over the ticket limit 413 before anything (ticket still usable); the exact limit accepted; over FILE_MAX_BYTES 413', async () => {
    const token = tokenOf((await issue({ maxBytes: 4096 })).body.url as string);
    const over = await redeem(token, SAMPLES.pdf(4097));
    expect(over.status).toBe(413);
    expect(over.body.code).toBe('file_too_large');
    expect(await ticketRowByToken(token)).toMatchObject({ useCount: 0, fileId: null }); // refused before the claim committed
    const exact = await redeem(token, SAMPLES.pdf(4096));
    expect(exact.status).toBe(201);
    expect(exact.body.sizeBytes).toBe(4096);
    const huge = await rawRequest(t.app, { method: 'PUT', path: `/file/t/${tokenOf((await issue()).body.url as string)}`, headers: { 'content-length': String(26 * 1024 * 1024) }, body: Buffer.alloc(0) });
    expect((huge as RawResponse).status).toBe(413); // answered from the header alone, the body never read (Connection: close)
    expect((huge as RawResponse).headers.connection).toBe('close');
  });

  it('a body without Content-Length (chunked) is 411 length_required; the ticket is untouched', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const r = (await rawRequest(t.app, { method: 'PUT', path: `/file/t/${token}`, headers: { 'transfer-encoding': 'chunked' }, body: Readable.from([SAMPLES.pdf()]) })) as RawResponse;
    expect(r.status).toBe(411);
    expect(r.json().code).toBe('length_required');
    expect(await ticketRowByToken(token)).toMatchObject({ useCount: 0 });
  });

  it('a body shorter than its Content-Length (client gone) never becomes AVAILABLE: FAILED, no object, no temporary file', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const pdf = SAMPLES.pdf(300_000);
    expect(await rawRequest(t.app, { method: 'PUT', path: `/file/t/${token}`, headers: { 'content-length': String(pdf.length) }, body: pdf, abortAfter: 100_000 })).toBe('socket_closed');
    const row = await eventually(async () => {
      const tk = await ticketRowByToken(token);
      const f = tk?.fileId ? await fileRow(tk.fileId as string) : undefined;
      return f && f.status !== 'UPLOADING' ? f : undefined;
    });
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'client_aborted', mediaType: null, sha256: null });
    expect(await stored(row.storageKey as string)).toBeUndefined();
    expect(readdirSync(join(TEST_STORAGE_ROOT, '.tmp'))).toEqual([]);
  });

  it('a stalled upload is cut at the idle timeout: FAILED upload_timeout, nothing stored', async () => {
    const token = tokenOf((await issue()).body.url as string);
    const pdf = SAMPLES.pdf(100_000);
    const started = Date.now();
    const r = await rawRequest(t.app, { method: 'PUT', path: `/file/t/${token}`, headers: { 'content-length': String(pdf.length) }, body: pdf, stallAfter: 20_000 });
    expect(Date.now() - started).toBeLessThan(6_000); // FILE_UPLOAD_IDLE_TIMEOUT_MS=1000 in this suite
    expect(r === 'socket_closed' || (r as RawResponse).status === 408).toBe(true);
    const row = await eventually(async () => {
      const tk = await ticketRowByToken(token);
      const f = tk?.fileId ? await fileRow(tk.fileId as string) : undefined;
      return f && f.status !== 'UPLOADING' ? f : undefined;
    });
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'upload_timeout' });
    expect(await stored(row.storageKey as string)).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────────── types

  it.each([
    ['an executable named passport.pdf, declared PDF', ADVERSARIAL.windowsExe(), 'passport.pdf', 'application/pdf', 415, 'unsupported_media_type'],
    ['an ELF binary', ADVERSARIAL.elf(), 'doc.pdf', 'application/pdf', 415, 'unsupported_media_type'],
    ['HTML named photo.jpg', ADVERSARIAL.html(), 'photo.jpg', 'image/jpeg', 415, 'unsupported_media_type'],
    ['SVG', ADVERSARIAL.svg(), 'logo.svg', 'image/svg+xml', 415, 'unsupported_media_type'],
    ['a ZIP archive', ADVERSARIAL.zip(), 'a.zip', 'application/zip', 415, 'unsupported_media_type'],
    ['a DOCX (Office)', ADVERSARIAL.docx(), 'cv.docx', undefined, 415, 'unsupported_media_type'],
    ['random bytes', ADVERSARIAL.randomBinary(), undefined, undefined, 415, 'unsupported_media_type'],
    ['an empty body', ADVERSARIAL.empty(), undefined, undefined, 415, 'unsupported_media_type'],
    ['a truncated PNG signature', ADVERSARIAL.truncatedPng(), undefined, undefined, 415, 'unsupported_media_type'],
    ['a real PNG declared as PDF', SAMPLES.png(), undefined, 'application/pdf', 422, 'media_type_mismatch'],
    ['a real PDF named photo.jpg', SAMPLES.pdf(), 'photo.jpg', undefined, 422, 'media_type_mismatch'],
  ])('refuses %s: REJECTED, nothing stored, the ticket consumed', async (_l, bytes, name, declared, status, code) => {
    const token = tokenOf((await issue()).body.url as string);
    const headers: Record<string, string> = {};
    if (name) headers['x-file-name'] = name;
    if (declared) headers['content-type'] = declared;
    const r = await redeem(token, bytes, headers);
    expect(r.status).toBe(status);
    expect(r.body.code).toBe(code);
    const tk = await ticketRowByToken(token);
    const row = await fileRow(tk!.fileId as string);
    expect(row).toMatchObject({ status: 'REJECTED', failureCode: code, mediaType: null });
    expect(await stored(row.storageKey as string)).toBeUndefined();
    expect((await redeem(token, SAMPLES.pdf())).body.code).toBe('ticket_invalid'); // no second chance with one ticket
  });

  it('an image-only ticket refuses real PDF bytes', async () => {
    const token = tokenOf((await issue({ mediaTypes: ['image/jpeg', 'image/png'] })).body.url as string);
    const r = await redeem(token, SAMPLES.pdf());
    expect(r.body.code).toBe('unsupported_media_type');
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── service upload (A)

  const serviceUpload = (who: { token: string }, bytes: Buffer, headers: Record<string, string>) =>
    request(server()).post('/file/files').set({ ...auth(who), 'content-type': 'application/octet-stream', ...headers }).send(bytes);

  it('a service uploads its own file (owner = the token\'s caller, never a header); a replay returns the same file without storing again', async () => {
    const key = `inv-${randomUUID()}`;
    const pdf = SAMPLES.pdf(50_000);
    const r = await serviceUpload(billing, pdf, { 'idempotency-key': key, 'x-file-name': 'invoice-0001.pdf', 'x-owner-service': 'core-drive', 'content-type': 'application/pdf' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'AVAILABLE', mediaType: 'application/pdf', sha256: sha(pdf), organizationId: null });
    expect(await fileRow(r.body.id as string)).toMatchObject({ ownerService: 'core-billing', idempotencyKey: key });
    const replay = await serviceUpload(billing, pdf, { 'idempotency-key': key, 'x-file-name': 'invoice-0001.pdf', 'content-type': 'application/pdf' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(r.body.id);
    const conflict = await serviceUpload(billing, pdf, { 'idempotency-key': key, 'x-file-name': 'invoice-0002.pdf', 'content-type': 'application/pdf' });
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('idempotency_key_reused');
    expect((await serviceUpload(drive, pdf, { 'idempotency-key': key })).status).toBe(201); // another owner, the same key: independent
  });

  it('service upload: policy (operation, organization mode, types, size), required headers, Content-Digest enforced before storing', async () => {
    const pdf = SAMPLES.pdf(1000);
    expect((await serviceUpload(reader, pdf, { 'idempotency-key': 'k1' })).body.code).toBe('operation_not_allowed');
    expect((await serviceUpload(billing, pdf, { 'idempotency-key': 'k2', 'x-organization-id': randomUUID() })).body.code).toBe('organization_not_allowed');
    expect((await serviceUpload(billing, SAMPLES.png(), { 'idempotency-key': 'k3' })).body.code).toBe('unsupported_media_type'); // billing: PDF only
    expect((await serviceUpload(billing, SAMPLES.pdf(1024 * 1024 + 1), { 'idempotency-key': 'k4' })).status).toBe(413);
    expect((await serviceUpload(billing, pdf, {})).body.code).toBe('validation_error'); // Idempotency-Key required
    const good = `sha-256=:${createHash('sha256').update(pdf).digest('base64')}:`;
    expect((await serviceUpload(billing, pdf, { 'idempotency-key': `d-${randomUUID()}`, 'content-digest': good })).status).toBe(201);
    const bad = `sha-256=:${createHash('sha256').update('other').digest('base64')}:`;
    const mismatch = await serviceUpload(billing, pdf, { 'idempotency-key': `d-${randomUUID()}`, 'content-digest': bad });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('checksum_mismatch');
  });

  it('a REJECTED attempt frees its Idempotency-Key: the retry with valid bytes creates the file', async () => {
    const key = `retry-${randomUUID()}`;
    const bad = await serviceUpload(billing, ADVERSARIAL.windowsExe(), { 'idempotency-key': key });
    expect(bad.status).toBe(415);
    const good = await serviceUpload(billing, SAMPLES.pdf(700), { 'idempotency-key': key });
    expect(good.status).toBe(201);
  });

  it('concurrent service uploads with one Idempotency-Key create ONE file', async () => {
    const key = `race-${randomUUID()}`;
    const pdf = SAMPLES.pdf(200_000);
    const results = await Promise.all(Array.from({ length: 8 }, () => serviceUpload(drive, pdf, { 'idempotency-key': key })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
    expect((await s.query(`SELECT id FROM file WHERE "idempotencyKey" = $1 AND "ownerService" = 'core-drive'`, [key]))).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── attach

  it('attach: the owner attaches (idempotent); another owner or organization gets 404; a failed file 409; attach-on-completion tickets', async () => {
    const org = randomUUID();
    const up = await redeem(tokenOf((await issue({ organizationId: org })).body.url as string), SAMPLES.png(200));
    const attach = (who: { token: string }, id: string, orgHeader?: string) =>
      request(server()).post(`/file/files/${id}/attach`).set({ ...auth(who), ...(orgHeader ? { 'x-organization-id': orgHeader } : {}) });
    const a1 = await attach(drive, up.body.id as string, org);
    expect(a1.status).toBe(200);
    expect(a1.body.attachedAt).toBeTruthy();
    expect((await attach(drive, up.body.id as string, org)).body.attachedAt).toBe(a1.body.attachedAt);
    expect((await attach(billing, up.body.id as string)).body.code).toBe('file_not_found');
    expect((await attach(drive, up.body.id as string, randomUUID())).body.code).toBe('file_not_found');
    expect((await attach(drive, up.body.id as string)).body.code).toBe('file_not_found'); // the organization omitted
    expect((await attach(drive, randomUUID(), org)).body.code).toBe('file_not_found');
    const failedToken = tokenOf((await issue()).body.url as string);
    await redeem(failedToken, ADVERSARIAL.html());
    const failedId = (await ticketRowByToken(failedToken))!.fileId as string;
    expect((await attach(drive, failedId)).body.code).toBe('file_not_available');
    const auto = await redeem(tokenOf((await issue({ attach: true })).body.url as string), SAMPLES.png(200));
    expect(auto.body.attachedAt).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────────────────────────── failure after the store

  it('a database failure at finalization: 500 (opaque), the stored object removed, the row FAILED — never AVAILABLE', async () => {
    await s.query(`CREATE FUNCTION test_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status = 'AVAILABLE' AND NEW."originalName" = 'finalize-fail.pdf' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await s.query(`CREATE TRIGGER test_fail_finalize BEFORE UPDATE ON file FOR EACH ROW EXECUTE FUNCTION test_fail_finalize()`);
    try {
      const token = tokenOf((await issue()).body.url as string);
      const r = await redeem(token, SAMPLES.pdf(5000), { 'x-file-name': 'finalize-fail.pdf' });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/injected|trigger|file_|files\//);
      const row = await fileRow((await ticketRowByToken(token))!.fileId as string);
      expect(row).toMatchObject({ status: 'FAILED', failureCode: 'finalize_failed' });
      expect(await stored(row.storageKey as string)).toBeUndefined();
    } finally {
      await s.query('DROP TRIGGER test_fail_finalize ON file');
      await s.query('DROP FUNCTION test_fail_finalize()');
    }
  });

  // ────────────────────────────────────────────────────────────────────────────────────────────── memory and logs

  it('a 20 MiB upload streams through with bounded memory (no buffering of the file) and a correct digest', async () => {
    const token = tokenOf((await issue({ maxBytes: 25 * 1024 * 1024 })).body.url as string);
    const size = 20 * 1024 * 1024;
    const head = SAMPLES.pdf();
    const block = randomBytes(64 * 1024);
    const hash = createHash('sha256');
    let sent = 0;
    const body = new Readable({
      read() {
        if (sent >= size) return void this.push(null);
        const part = sent === 0 ? Buffer.concat([head, block.subarray(0, 64 * 1024 - head.length)]) : Buffer.from(block.subarray(0, Math.min(64 * 1024, size - sent)));
        hash.update(part);
        sent += part.length;
        this.push(part);
      },
    });
    let res = 'socket_closed' as RawResponse | 'socket_closed';
    const growth = await peakBufferGrowth(async () => {
      res = await rawRequest(t.app, { method: 'PUT', path: `/file/t/${token}`, headers: { 'content-length': String(size), 'content-type': 'application/pdf' }, body });
    });
    const r = res as RawResponse;
    expect(r.status).toBe(201);
    expect(r.json()).toMatchObject({ sizeBytes: size, sha256: hash.digest('hex') });
    expect(growth).toBeLessThan(12 * 1024 * 1024); // client + server together hold a small fraction of the 20 MiB
  }, 120_000);

  it('rate limit on failed redemptions: once over, EVERY redemption from that client is 429, valid or not (no oracle)', async () => {
    // Its own rate-limit key: the same address becomes a different (keyed) identity, so earlier failures in this database do not count.
    const limited = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '3', FILE_RATE_LIMIT_KEY: randomBytes(32).toString('base64') } });
    try {
      const valid = tokenOf((await issue()).body.url as string);
      for (let i = 0; i < 3; i++) expect((await request(limited.app.getHttpServer()).put(`/file/t/${newToken().token}`).send(SAMPLES.pdf())).status).toBe(404);
      const blockedInvalid = await request(limited.app.getHttpServer()).put(`/file/t/${newToken().token}`).send(SAMPLES.pdf());
      const blockedValid = await request(limited.app.getHttpServer()).put(`/file/t/${valid}`).send(SAMPLES.pdf());
      expect([blockedInvalid.status, blockedValid.status]).toEqual([429, 429]);
      expect(blockedValid.body.code).toBe('rate_limited');
      expect(await ticketRowByToken(valid)).toMatchObject({ useCount: 0 }); // the valid ticket was not consumed while blocked
      expect(JSON.stringify(await s.query(`SELECT * FROM kit_rate_limit WHERE bucket = 'file_ticket_failures'`))).not.toContain('127.0.0.1');
    } finally {
      await limited.app.close();
    }
  });

  it('no raw ticket, ticket digest, storage key, file name or file content in any log line', async () => {
    const issued = (await issue()).body;
    const token = tokenOf(issued.url as string);
    const up = await redeem(token, SAMPLES.pdf(5000), { 'x-file-name': 'secret-name-4242.pdf' });
    await redeem(newToken().token, SAMPLES.pdf());
    const row = await fileRow(up.body.id as string);
    const logs = JSON.stringify(ALL_LOGS);
    expect(logs).toContain('file_upload route=ticket outcome=available'); // the upload WAS logged
    for (const secret of [token, createHash('sha256').update(token).digest('hex'), row.storageKey as string, 'secret-name-4242', '%PDF-1.7']) {
      expect(logs, `leaked ${secret.slice(0, 10)}`).not.toContain(secret);
    }
    expect(existsSync(TEST_STORAGE_ROOT)).toBe(true);
  });
});
