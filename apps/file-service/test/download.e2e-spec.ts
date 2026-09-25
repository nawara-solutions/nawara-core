import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { truncateSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { STORAGE_PORT, type StoragePort } from '../src/storage/storage.port.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { newToken, Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { DOWNLOAD_POLICY } from './support/download.js';
import { liveBytes } from './support/storage-contract.js';

/** Built from code points: no invisible character is written literally in this source (check:repo). */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);


/** Downloads fully through a real socket (for memory, abort and truncation checks); returns status, headers, byte count and digest. */
function download(app: TestApp, path: string, opts: { abortAfterFirstChunk?: boolean; onFirstChunk?: () => Promise<void> } = {}) {
  const port = (app.app.getHttpServer().address() as AddressInfo).port;
  return new Promise<{ status: number; headers: Record<string, unknown>; bytes: number; sha256: string; complete: boolean }>((resolve) => {
    const h = createHash('sha256');
    let bytes = 0;
    let first = true;
    const req = httpGet({ host: '127.0.0.1', port, path }, (res) => {
      res.on('data', (c: Buffer) => {
        h.update(c);
        bytes += c.length;
        if (first) {
          first = false;
          if (opts.abortAfterFirstChunk) return void req.destroy();
          if (opts.onFirstChunk) {
            res.pause();
            void opts.onFirstChunk().then(() => res.resume());
          }
        }
      });
      let settled = false;
      const done = (complete: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, sha256: h.digest('hex'), complete });
      };
      res.on('end', () => done(res.complete));
      res.on('aborted', () => done(false));
      res.on('error', () => done(false));
      res.on('close', () => done(res.complete));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, bytes, sha256: '', complete: false }));
  });
}

/**
 * Stage 17.6: the byte-read boundary end to end (real PostgreSQL, filesystem store): owner reads, download tickets (issue, redeem,
 * revoke), headers, non-disclosure, lifecycle, streaming, integrity faults.
 */
describeWithEnv('download + authorization (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const uploader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-uploader', digest: uploader.digest }];
  const policy = JSON.stringify(DOWNLOAD_POLICY);
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filedownload');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy, env: { FILE_TICKET_FAILURE_LIMIT: '1000', FILE_DOWNLOAD_IDLE_TIMEOUT_MS: '2000' } });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  /** Uploads a file as `who` (service upload) and returns its id and bytes. */
  async function uploaded(bytes: Buffer, opts: { who?: { token: string }; org?: string | null; name?: string } = {}) {
    const headers: Record<string, string> = { ...auth(opts.who ?? drive, opts.org), 'idempotency-key': randomUUID() };
    if (opts.name) headers['x-file-name'] = encodeURIComponent(opts.name);
    const r = await request(server()).post('/file/files').set(headers).send(bytes);
    expect(r.status).toBe(201);
    return { id: r.body.id as string, bytes };
  }
  const issue = (id: string, body: Record<string, unknown> = {}, who = drive, org?: string | null) =>
    request(server()).post(`/file/files/${id}/tickets`).set(auth(who, org)).send({ operation: 'download', ...body });
  const path = (url: string) => new URL(url).pathname;
  const tokenOf = (url: string) => path(url).split('/file/t/')[1]!;
  const invalidBody = (r: request.Response) => {
    const { requestId: _r, ...rest } = r.body as Record<string, unknown>;
    return JSON.stringify(rest);
  };

  // ─────────────────────────────────────────────────────────────────────────────────────────── path A: trusted services

  it('the owner reads metadata and streams content with the exact headers; bytes are byte-exact', async () => {
    const org = randomUUID();
    const pdf = SAMPLES.pdf(300_000);
    const f = await uploaded(pdf, { org, name: 'Relevé été 2026.pdf' });
    const meta = await request(server()).get(`/file/files/${f.id}`).set(auth(drive, org)).expect(200);
    expect(meta.body).toMatchObject({ id: f.id, status: 'AVAILABLE', mediaType: 'application/pdf', sizeBytes: pdf.length, sha256: sha(pdf), organizationId: org });
    expect(JSON.stringify(meta.body)).not.toMatch(/storageKey|storageProvider|files\/[0-9a-f]{8}/);
    const r = await request(server()).get(`/file/files/${f.id}/content`).set(auth(drive, org)).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    expect(sha(r.body as Buffer)).toBe(sha(pdf));
    expect(r.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': "attachment; filename=\"Relev_ _t_ 2026.pdf\"; filename*=UTF-8''Relev%C3%A9%20%C3%A9t%C3%A9%202026.pdf",
      'cache-control': 'private, no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'referrer-policy': 'no-referrer',
      etag: `"${sha(pdf)}"`,
      'accept-ranges': 'none',
    });
  });

  it('non-disclosure: another owner, another organization, no organization, a malformed or unknown id are the same 404', async () => {
    const org = randomUUID();
    const f = await uploaded(SAMPLES.png(500), { org });
    const bodies: string[] = [];
    for (const [who, id, o] of [[billing, f.id, null], [drive, f.id, randomUUID()], [drive, f.id, null], [drive, 'not-a-uuid', org], [drive, randomUUID(), org], [drive, `${f.id}' OR '1'='1`, org]] as const) {
      for (const suffix of ['', '/content']) {
        const r = await request(server()).get(`/file/files/${encodeURIComponent(id)}${suffix}`).set(auth(who, o));
        expect(r.status, `${String(id).slice(0, 8)}${suffix}`).toBe(404);
        bodies.push(invalidBody(r));
      }
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ code: 'file_not_found' });
  });

  it('service reads need a token and the read operation; a spoofed owner changes nothing; organization mode is enforced', async () => {
    const f = await uploaded(SAMPLES.pdf(500));
    await request(server()).get(`/file/files/${f.id}/content`).expect(401);
    await request(server()).get(`/file/files/${f.id}/content`).set({ authorization: 'Bearer not-a-real-token' }).expect(401);
    expect((await request(server()).get(`/file/files/${f.id}/content`).set(auth(uploader))).body.code).toBe('operation_not_allowed');
    expect((await request(server()).get(`/file/files/${f.id}`).set(auth(billing, randomUUID()))).body.code).toBe('organization_not_allowed');
    const spoof = await request(server()).get(`/file/files/${f.id}`).set({ ...auth(billing), 'x-owner-service': 'core-drive' }).query({ ownerService: 'core-drive' });
    expect(spoof.status).toBe(404); // billing is billing, whatever it claims
  });

  it('only AVAILABLE files are served: UPLOADING / FAILED / REJECTED are 409, DELETING / DELETED 410 (to the owner only)', async () => {
    const row = async (status: string) => {
      const f = await uploaded(SAMPLES.pdf(400));
      if (status === 'DELETING' || status === 'DELETED') {
        await s.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now() WHERE id = $1`, [f.id]);
        if (status === 'DELETED') await s.query(`UPDATE file SET status = 'DELETED', "deletedAt" = now() WHERE id = $1`, [f.id]);
        return f.id;
      }
      const id = randomUUID();
      await s.query(`INSERT INTO file (id, "ownerService", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline") VALUES ($1, 'core-drive', 'filesystem', $2, now() + interval '1 hour', now() + interval '1 day')`,
        [id, `files/${id}/${randomBytes(16).toString('hex')}`]);
      if (status !== 'UPLOADING') await s.query(`UPDATE file SET status = $2, "failureCode" = 'x_code' WHERE id = $1`, [id, status]);
      return id;
    };
    for (const [status, code, http] of [['UPLOADING', 'file_not_available', 409], ['FAILED', 'file_not_available', 409], ['REJECTED', 'file_not_available', 409],
      ['DELETING', 'file_deleted', 410], ['DELETED', 'file_deleted', 410]] as const) {
      const id = await row(status);
      const r = await request(server()).get(`/file/files/${id}/content`).set(auth(drive));
      expect([r.status, r.body.code], status).toEqual([http, code]);
      expect((await issue(id)).body.code, `ticket for ${status}`).toBe(code);
      expect((await request(server()).get(`/file/files/${id}/content`).set(auth(billing))).status).toBe(404); // not the owner: 404
    }
  });

  // ───────────────────────────────────────────────────────────────────────────────────────────── path B: tickets

  it('issues a ticket only for the owner\'s AVAILABLE file in its organization; policy and disposition rules hold', async () => {
    const org = randomUUID();
    const pdf = await uploaded(SAMPLES.pdf(1000), { org });
    const png = await uploaded(SAMPLES.png(1000), { org });
    const ok = await issue(pdf.id, {}, drive, org);
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(/^https:\/\/files\.test\.invalid\/file\/t\/[A-Za-z0-9_-]{43}$/);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    const lifetime = new Date(ok.body.expiresAt as string).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(100_000);
    expect(lifetime).toBeLessThanOrEqual(121_000); // the 120 s default (F16: 60-300 s)
    const row = (await s.query(`SELECT * FROM file_access_ticket WHERE id = $1`, [ok.body.ticketId]))[0]!;
    expect(row).toMatchObject({ operation: 'download', fileId: pdf.id, issuedBy: 'core-drive', organizationId: org, singleUse: false, disposition: 'attachment' });
    expect(JSON.stringify(row)).not.toContain(tokenOf(ok.body.url as string));
    expect((await issue(pdf.id, {}, billing)).status).toBe(404); // another owner
    expect((await issue(pdf.id, {}, drive, randomUUID())).status).toBe(404); // another organization
    expect((await issue(randomUUID(), {}, drive, org)).status).toBe(404);
    expect((await issue(pdf.id, {}, uploader, org)).body.code).toBe('operation_not_allowed');
    expect((await issue(pdf.id, { disposition: 'inline' }, drive, org)).body.code).toBe('disposition_not_allowed'); // a PDF is never inline
    expect((await issue(png.id, { disposition: 'inline' }, drive, org)).status).toBe(201);
    expect((await issue(pdf.id, { operation: 'upload' }, drive, org)).status).toBe(400);
    expect((await issue(pdf.id, { fileId: png.id }, drive, org)).status).toBe(400); // no other field: the path names the file
  });

  it('redeems a ticket: exactly the bound file, attachment, private no-store, cross-origin resource policy; reusable until expiry', async () => {
    const pdf = SAMPLES.pdf(80_000);
    const f = await uploaded(pdf, { name: 'contrat.pdf' });
    const url = (await issue(f.id)).body.url as string;
    for (let i = 0; i < 3; i++) {
      const r = await download(t, path(url));
      expect(r).toMatchObject({ status: 200, bytes: pdf.length, sha256: sha(pdf), complete: true });
      expect(r.headers).toMatchObject({ 'content-type': 'application/pdf', 'content-disposition': "attachment; filename=\"contrat.pdf\"; filename*=UTF-8''contrat.pdf",
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'cross-origin' });
    }
    const other = await uploaded(SAMPLES.png(100));
    const withQuery = await download(t, `${path(url)}?fileId=${other.id}&ownerService=core-billing`);
    expect(withQuery.sha256).toBe(sha(pdf)); // nothing in the request can select another file
    expect(((await s.query(`SELECT "useCount" FROM file_access_ticket WHERE "fileId" = $1`, [f.id]))[0] as { useCount: number }).useCount).toBe(4);
  });

  it('an inline ticket for an image is served inline', async () => {
    const png = SAMPLES.png(2000);
    const f = await uploaded(png, { name: 'photo.png' });
    const r = await download(t, path((await issue(f.id, { disposition: 'inline' })).body.url as string));
    expect(r.headers['content-disposition']).toBe("inline; filename=\"photo.png\"; filename*=UTF-8''photo.png");
    expect(r.headers['content-type']).toBe('image/png');
  });

  it('20 concurrent downloads with one reusable ticket all get the same bound file', async () => {
    const pdf = SAMPLES.pdf(120_000);
    const f = await uploaded(pdf);
    const url = (await issue(f.id)).body.url as string;
    const results = await Promise.all(Array.from({ length: 20 }, () => download(t, path(url))));
    expect(results.every((r) => r.status === 200 && r.sha256 === sha(pdf) && r.complete)).toBe(true);
    expect(((await s.query(`SELECT "useCount" FROM file_access_ticket WHERE "tokenDigest" = $1`, [sha(Buffer.from(tokenOf(url)))]))[0] as { useCount: number }).useCount).toBe(20);
  });

  it('a single-use ticket: 20 concurrent redemptions, exactly one gets the bytes', async () => {
    const f = await uploaded(SAMPLES.pdf(50_000));
    const url = (await issue(f.id, { singleUse: true })).body.url as string;
    const results = await Promise.all(Array.from({ length: 20 }, () => request(server()).get(path(url))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404 && r.body.code === 'ticket_invalid')).toHaveLength(19);
  });

  it('every unusable ticket is the same 404 ticket_invalid (malformed, unknown, expired, revoked, upload ticket, file gone, issuer lost the right)', async () => {
    const f = await uploaded(SAMPLES.pdf(700));
    const expired = newToken();
    await s.query(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "createdAt", "expiresAt")
      VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', false, now() - interval '10 minutes', now() - interval '8 minutes')`, [randomUUID(), f.id, expired.digest]);
    const revoked = (await issue(f.id)).body;
    await request(server()).delete(`/file/tickets/${revoked.ticketId}`).set(auth(drive)).expect(204);
    const uploadTicket = await request(server()).post('/file/uploads/tickets').set(auth(drive)).send({ maxBytes: 1000, mediaTypes: ['application/pdf'] });
    // An upload ticket bound to an AVAILABLE file with no use (a state the schema allows): still never a download capability.
    const bound = await uploaded(SAMPLES.pdf(700));
    const uploadBound = newToken();
    const uploadBoundId = randomUUID();
    await s.query(`INSERT INTO file_access_ticket (id, operation, "issuedBy", "tokenDigest", "maxBytes", "mediaTypes", attach, "singleUse", "expiresAt")
      VALUES ($1, 'upload', 'core-drive', $2, 1000, ARRAY['application/pdf'], false, true, now() + interval '120 seconds')`, [uploadBoundId, uploadBound.digest]);
    await s.query(`UPDATE file_access_ticket SET "fileId" = $2 WHERE id = $1`, [uploadBoundId, bound.id]);
    const gone = await uploaded(SAMPLES.pdf(700));
    const goneUrl = (await issue(gone.id)).body.url as string;
    await s.query(`UPDATE file SET status = 'DELETING', "deletionRequestedAt" = now() WHERE id = $1`, [gone.id]); // after issuance
    const bodies: string[] = [];
    for (const token of ['abc', newToken().token, '../../etc/passwd', expired.token, tokenOf(revoked.url as string), tokenOf(uploadTicket.body.url as string), uploadBound.token, tokenOf(goneUrl)]) {
      const r = await request(server()).get(`/file/t/${encodeURIComponent(token)}`);
      expect(r.status, token.slice(0, 6)).toBe(404);
      bodies.push(invalidBody(r));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ statusCode: 404, message: 'The link is not valid.', error: 'Not Found', code: 'ticket_invalid' });
    // The issuer no longer holds issue_ticket: refused, and a single-use ticket is not consumed by the refusal.
    const single = (await issue(f.id, { singleUse: true })).body.url as string;
    const restricted = JSON.parse(policy) as typeof DOWNLOAD_POLICY;
    restricted.callers['core-drive'].operations = ['upload', 'read', 'attach'];
    const other = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(restricted) });
    try {
      expect((await request(other.app.getHttpServer()).get(path(single))).body.code).toBe('ticket_invalid');
    } finally {
      await other.app.close();
    }
    expect((await request(server()).get(path(single))).status).toBe(200);
  });

  it('revocation: the owner in its organization, idempotent; another caller or organization gets the same 404; future redemptions fail', async () => {
    const org = randomUUID();
    const f = await uploaded(SAMPLES.pdf(700), { org });
    const tk = (await issue(f.id, {}, drive, org)).body;
    expect((await request(server()).delete(`/file/tickets/${tk.ticketId}`).set(auth(billing))).body.code).toBe('ticket_not_found');
    expect((await request(server()).delete(`/file/tickets/${tk.ticketId}`).set(auth(drive, randomUUID()))).body.code).toBe('ticket_not_found');
    expect((await request(server()).delete(`/file/tickets/${randomUUID()}`).set(auth(drive, org))).body.code).toBe('ticket_not_found');
    expect((await request(server()).get(path(tk.url as string))).status).toBe(200); // still live
    await request(server()).delete(`/file/tickets/${tk.ticketId}`).set(auth(drive, org)).expect(204);
    await request(server()).delete(`/file/tickets/${tk.ticketId}`).set(auth(drive, org)).expect(204);
    expect((await request(server()).get(path(tk.url as string))).body.code).toBe('ticket_invalid');
  });

  it('revocation race: a download authorized before the revocation commits may complete; the next redemption fails', async () => {
    const pdf = SAMPLES.pdf(3 * 1024 * 1024);
    const f = await uploaded(pdf);
    const tk = (await issue(f.id)).body;
    const r = await download(t, path(tk.url as string), {
      onFirstChunk: async () => {
        await request(server()).delete(`/file/tickets/${tk.ticketId}`).set(auth(drive)).expect(204);
      },
    });
    expect(r).toMatchObject({ status: 200, sha256: sha(pdf), complete: true });
    expect((await request(server()).get(path(tk.url as string))).body.code).toBe('ticket_invalid');
  });

  it('HEAD is refused (405) on byte routes and consumes nothing; Range is ignored (full 200, Accept-Ranges: none)', async () => {
    const pdf = SAMPLES.pdf(10_000);
    const f = await uploaded(pdf);
    const url = (await issue(f.id, { singleUse: true })).body.url as string;
    const head = await request(server()).head(path(url));
    expect(head.status).toBe(405);
    expect(head.headers.allow).toBe('GET');
    expect((await request(server()).head(`/file/files/${f.id}/content`).set(auth(drive))).status).toBe(405);
    const ranged = await request(server()).get(path(url)).set('range', 'bytes=0-99');
    expect(ranged.status).toBe(200); // the single-use ticket survived the HEAD
    expect(ranged.headers['content-length']).toBe(String(pdf.length));
    expect(ranged.headers['accept-ranges']).toBe('none');
  });

  it('filenames never inject headers: CR/LF, bidi controls, quotes and long Unicode names stay one safe line', async () => {
    for (const name of [`x${cp(0x202e)}fdp.exe.pdf`, `quote"d.pdf`, `${'ع'.repeat(100)}.pdf`]) {
      const f = await uploaded(SAMPLES.pdf(300), { name });
      const r = await request(server()).get(`/file/files/${f.id}/content`).set(auth(drive));
      expect(r.headers['content-disposition']).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[\x21-\x7e]+$/);
    }
    // A CR/LF name cannot even be stored (the 17.3 CHECK), and a stored name never changes (the immutability trigger).
    const rowId = randomUUID();
    expect((await s.refusedInsert('file', { id: rowId, ownerService: 'core-drive', storageProvider: 'filesystem', storageKey: `files/${rowId}/${randomBytes(16).toString('hex')}`,
      uploadExpiresAt: new Date(Date.now() + 3_600_000), attachDeadline: new Date(Date.now() + 86_400_000), originalName: 'a\r\nSet-Cookie: x=1.pdf' })).constraint).toBe('file_original_name_safe');
    const id = (await uploaded(SAMPLES.pdf(300))).id; // no name: the fallback
    expect((await s.refused(`UPDATE file SET "originalName" = 'x.pdf' WHERE id = $1`, [id])).message).toMatch(/is immutable/);
    expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive))).headers['content-disposition']).toBe("attachment; filename=\"file.pdf\"; filename*=UTF-8''file.pdf");
  });

  // ──────────────────────────────────────────────────────────────────────────────────────────── streaming and faults

  it('a 20 MiB download: exact digest; a paused client holds the server back (backpressure: bounded live memory, not the file)', async () => {
    const size = 20 * 1024 * 1024;
    const body = Buffer.concat([SAMPLES.pdf(), randomBytes(size - SAMPLES.pdf().length)]);
    const r = await request(server()).post('/file/files').set({ ...auth(drive), 'idempotency-key': randomUUID() }).send(body);
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    const expected = sha(body);
    expect((await download(t, path((await issue(id)).body.url as string))).sha256).toBe(expected); // byte-exact, full speed
    const before = await liveBytes();
    let atPause = 0;
    let afterHold = 0;
    const paused = await download(t, path((await issue(id)).body.url as string), {
      onFirstChunk: async () => {
        atPause = await liveBytes();
        await new Promise((res) => setTimeout(res, 500)); // the client stops reading; the server must stop too
        afterHold = await liveBytes();
      },
    });
    expect(paused.sha256).toBe(expected);
    expect(afterHold - atPause).toBeLessThan(2 * 1024 * 1024); // nothing more is read while the client holds
    expect(atPause - before).toBeLessThan(8 * 1024 * 1024); // and nothing like the 20 MiB object was read ahead
  }, 120_000);

  it('a client that disconnects mid-download stops the stream at once (the rest is never read)', async () => {
    const big = Buffer.concat([SAMPLES.pdf(), randomBytes(8 * 1024 * 1024)]);
    const f = await uploaded(big);
    const url = (await issue(f.id)).body.url as string;
    const before = ALL_LOGS.length;
    const r = await download(t, path(url), { abortAfterFirstChunk: true });
    expect(r.complete).toBe(false);
    const line = await (async () => {
      for (let i = 0; i < 100; i++) {
        const l = ALL_LOGS.slice(before).map((x) => String(x.msg)).find((m) => m.startsWith(`file_download route=ticket outcome=aborted file=${f.id}`));
        if (l) return l;
        await new Promise((res) => setTimeout(res, 20));
      }
      return undefined;
    })();
    expect(line).toBeDefined();
    const sent = Number(/bytes=(\d+)/.exec(line!)![1]);
    expect(sent).toBeLessThan(big.length / 2); // stopped far before the end: not read on in the background
  });

  it('the object missing (record AVAILABLE): 500 file_content_missing, an inconsistency signal, never a status change', async () => {
    const f = await uploaded(SAMPLES.pdf(900));
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [f.id]))[0] as { storageKey: string }).storageKey;
    await t.app.get<StoragePort>(STORAGE_PORT).delete(key, { signal: new AbortController().signal });
    const r = await request(server()).get(`/file/files/${f.id}/content`).set(auth(drive));
    expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
    expect(JSON.stringify(r.body)).not.toMatch(/files\/|storage|ENOENT|tmp/i);
    expect(ALL_LOGS.some((l) => String(l.msg) === `file_storage_inconsistent file=${f.id} reason=object_missing`)).toBe(true);
    expect(((await s.query(`SELECT status FROM file WHERE id = $1`, [f.id]))[0] as { status: string }).status).toBe('AVAILABLE'); // not "repaired"
    const viaTicket = await request(server()).get(path((await issue(f.id)).body.url as string));
    expect(viaTicket.body.code).toBe('file_content_missing');
  });

  it('an object whose size contradicts the record is never served (500 file_content_missing)', async () => {
    const f = await uploaded(SAMPLES.pdf(900));
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [f.id]))[0] as { storageKey: string }).storageKey;
    writeFileSync(join(TEST_STORAGE_ROOT, key), SAMPLES.pdf(950)); // tampered on disk (the adapter never overwrites; an operator did)
    const r = await request(server()).get(`/file/files/${f.id}/content`).set(auth(drive));
    expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
    expect(ALL_LOGS.some((l) => String(l.msg) === `file_storage_inconsistent file=${f.id} reason=size_mismatch`)).toBe(true);
  });

  it('an object that ends early MID-stream ends the connection: the client can never take a truncated file for a whole one', async () => {
    // 20 MiB: far more than the kernel's localhost socket buffers can absorb, so the server is still reading the store when the
    // client pauses (a small object could be sent whole into the kernel before the truncation, and legitimately complete).
    const big = Buffer.concat([SAMPLES.pdf(), randomBytes(20 * 1024 * 1024)]);
    const f = await uploaded(big);
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [f.id]))[0] as { storageKey: string }).storageKey;
    const before = ALL_LOGS.length;
    const started = Date.now();
    const r = await download(t, `/file/t/${tokenOf((await issue(f.id)).body.url as string)}`, {
      onFirstChunk: async () => truncateSync(join(TEST_STORAGE_ROOT, key), 1024 * 1024), // the store loses the tail while streaming
    });
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
    expect(r.bytes).toBeLessThan(big.length);
    expect(Date.now() - started).toBeLessThan(3_000); // the connection is ended at once, not left for the keep-alive timeout
    let logged: string | undefined; // the server logs just after it closed the connection: wait for the line, briefly
    for (let i = 0; i < 100 && !logged; i++) {
      logged = ALL_LOGS.slice(before).map((l) => String(l.msg)).find((m) => m.startsWith(`file_download route=ticket outcome=`) && m.includes(`file=${f.id}`));
      if (!logged) await new Promise((res) => setTimeout(res, 20));
    }
    expect(logged).toMatch(/outcome=stream_failed/); // an integrity failure, never logged as a success
  });

  it('logs: no raw ticket, digest, ticket path or storage key; route patterns only', async () => {
    const f = await uploaded(SAMPLES.pdf(600));
    const url = (await issue(f.id)).body.url as string;
    const token = tokenOf(url);
    await request(server()).get(path(url)).expect(200);
    await request(server()).get(`/file/t/${newToken().token}`).expect(404);
    const logs = JSON.stringify(ALL_LOGS);
    expect(logs).toContain('file_download route=ticket outcome=ok');
    expect(logs).toContain('file_download_ticket_issued owner=core-drive');
    for (const secret of [token, sha(Buffer.from(token)), `/file/t/${token}`]) expect(logs, secret.slice(0, 8)).not.toContain(secret);
    expect(logs).not.toMatch(/files\/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
