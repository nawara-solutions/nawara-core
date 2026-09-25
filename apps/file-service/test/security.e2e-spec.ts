import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { CleanupWorker } from '../src/cleanup/cleanup.worker.js';
import { ALL_LOGS, createTestApp, TEST_STORAGE_ROOT, type TestApp } from './support/app.js';
import { DELETE_POLICY } from './support/deletion.js';
import { describeWithEnv } from './support/env.js';
import { fileRow, Sql } from './support/fixtures.js';
import { SAMPLES } from './support/media.js';
import { eventually, rawRequest } from './support/upload.js';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/**
 * Stage 17.8: adversarial checks of the File Service boundaries that earlier stages did not already pin (real PostgreSQL, filesystem
 * store): the F32 usage limits (per caller, per organization; issuance, uploads, service reads), the reusable download-ticket cap, the
 * limiter retention, storage tampering (same key: other size, same size with other bytes, missing), HTTP framing, methods / CORS / CSRF,
 * polyglots, hostile file names end to end, log injection, and minimal health bodies.
 */
describeWithEnv('security + integrity hardening (real PostgreSQL, filesystem store)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let s: Sql;
  const drive = generateServiceToken();
  const billing = generateServiceToken();
  const reader = generateServiceToken();
  const tokens = [{ caller: 'core-drive', digest: drive.digest }, { caller: 'core-billing', digest: billing.digest }, { caller: 'core-reader', digest: reader.digest }];
  const LIMITS = {
    FILE_UPLOAD_RATE_PER_CALLER: '8', FILE_UPLOAD_RATE_PER_ORGANIZATION: '4',
    FILE_TICKET_RATE_PER_CALLER: '8', FILE_TICKET_RATE_PER_ORGANIZATION: '4',
    FILE_DOWNLOAD_RATE_PER_CALLER: '8', FILE_DOWNLOAD_RATE_PER_ORGANIZATION: '4',
    FILE_TICKET_MAX_DOWNLOADS: '3', FILE_TICKET_FAILURE_LIMIT: '1000',
  };
  const server = () => t.app.getHttpServer();
  const auth = (tok: { token: string }, org?: string | null) => ({ authorization: `Bearer ${tok.token}`, ...(org ? { 'x-organization-id': org } : {}) });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const count = async (sql: string, params: unknown[] = []) => Number(((await s.query(sql, params))[0] as { n: string }).n);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filesecurity');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(DELETE_POLICY), env: LIMITS });
    await t.app.listen(0, '127.0.0.1');
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await s.query('DELETE FROM kit_rate_limit'); // each case starts with fresh budgets
  });

  const upload = (bytes: Buffer, org?: string | null, who = drive, extra: Record<string, string> = {}) =>
    request(server()).post('/file/files').set({ ...auth(who, org), 'idempotency-key': randomUUID(), ...extra }).send(bytes).then((r) => r);
  const uploadTicket = (org?: string | null) =>
    request(server()).post('/file/uploads/tickets').set(auth(drive)).send({ maxBytes: 100_000, mediaTypes: ['application/pdf'], ...(org ? { organizationId: org } : {}) }).then((r) => r);
  const downloadTicket = (id: string, org?: string | null, body: Record<string, unknown> = {}) =>
    request(server()).post(`/file/files/${id}/tickets`).set(auth(drive, org)).send({ operation: 'download', ...body }).then((r) => r);
  const tokenPath = (url: string) => new URL(url).pathname;
  const files = () => count('SELECT count(*) AS n FROM file');
  const tickets = () => count('SELECT count(*) AS n FROM file_access_ticket');
  /** A file created without spending any usage budget (the limits are reset afterwards by the caller when needed). */
  async function available(bytes: Buffer, org: string | null = null): Promise<string> {
    const r = await upload(bytes, org);
    expect(r.status).toBe(201);
    await s.query('DELETE FROM kit_rate_limit');
    return r.body.id as string;
  }

  function fetchAll(path: string, headers: Record<string, string> = {}) {
    const port = (server().address() as AddressInfo).port;
    return new Promise<{ status: number; headers: Record<string, unknown>; bytes: number; sha256: string; complete: boolean; head: Buffer }>((resolve) => {
      const h = createHash('sha256');
      let bytes = 0;
      let head = Buffer.alloc(0);
      let settled = false;
      const req = httpGet({ host: '127.0.0.1', port, path, headers }, (res) => {
        const done = (complete: boolean) => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, sha256: h.digest('hex'), complete, head });
        };
        res.on('data', (c: Buffer) => {
          h.update(c);
          bytes += c.length;
          if (head.length < 64) head = Buffer.concat([head, c]).subarray(0, 64);
        });
        res.on('end', () => done(res.complete));
        res.on('aborted', () => done(false));
        res.on('error', () => done(false));
        res.on('close', () => done(res.complete));
      });
      req.on('error', () => resolve({ status: 0, headers: {}, bytes, sha256: '', complete: false, head: Buffer.alloc(0) }));
    });
  }

  /** Sends a hand-written HTTP/1.1 request (framing attacks supertest cannot express); resolves with the status line's code. */
  function rawHttp(text: string): Promise<number> {
    const port = (server().address() as AddressInfo).port;
    return new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(text));
      let data = '';
      sock.setTimeout(5_000, () => sock.destroy());
      sock.on('data', (c) => {
        data += c.toString('latin1');
        const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
        if (m) {
          sock.destroy();
          resolve(Number(m[1]));
        }
      });
      sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
      sock.on('error', () => undefined);
    });
  }

  async function logLine(match: (m: string) => boolean, from: number): Promise<string | undefined> {
    for (let i = 0; i < 100; i++) {
      const hit = ALL_LOGS.slice(from).map((l) => String(l.msg)).find(match);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    return undefined;
  }

  // ───────────────────────────────────────────────────────────────────────────────────────── F32: usage limits

  it('service uploads: per (caller, organization) and per caller; a 429 creates nothing; other organizations and platform files keep their own budget', async () => {
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < 4; i++) expect((await upload(SAMPLES.pdf(600), a)).status).toBe(201);
    const before = await files();
    const over = await upload(SAMPLES.pdf(600), a);
    expect([over.status, over.body.code]).toEqual([429, 'rate_limited']);
    expect(await files()).toBe(before); // refused before any row or object
    expect((await upload(SAMPLES.pdf(600), b)).status).toBe(201); // another tenant is unaffected
    expect((await upload(SAMPLES.pdf(600), null)).status).toBe(201); // a platform file: the caller budget only
    expect((await upload(SAMPLES.pdf(600), c)).status).toBe(201); // the 8th attempt of this caller (the refused one counted)
    expect((await upload(SAMPLES.pdf(600), d)).status).toBe(429); // the caller budget is spent, whatever the organization
    expect((await upload(SAMPLES.pdf(600), null, billing)).status).toBe(201); // another caller is unaffected
  });

  it('refused requests spend nothing: no token, a wrong token, an operation or organization mode the policy denies', async () => {
    await request(server()).post('/file/files').set({ 'idempotency-key': randomUUID() }).send(SAMPLES.pdf()).expect(401);
    await request(server()).post('/file/files').set({ authorization: `Bearer ${randomBytes(32).toString('base64url')}`, 'idempotency-key': randomUUID() }).send(SAMPLES.pdf()).expect(401);
    expect((await upload(SAMPLES.pdf(), null, reader)).status).toBe(403);
    expect((await upload(SAMPLES.pdf(), randomUUID(), billing)).status).toBe(403);
    await request(server()).post('/file/uploads/tickets').set(auth(reader)).send({ maxBytes: 10, mediaTypes: ['application/pdf'] }).expect(403);
    expect(await count(`SELECT count(*) AS n FROM kit_rate_limit`)).toBe(0);
  });

  it('ticket issuance: upload and download tickets share one budget per (caller, organization); a 429 records no ticket', async () => {
    const org = randomUUID();
    const id = await available(SAMPLES.pdf(700), org);
    expect((await uploadTicket(org)).status).toBe(201);
    expect((await uploadTicket(org)).status).toBe(201);
    expect((await downloadTicket(id, org)).status).toBe(201);
    expect((await downloadTicket(id, org)).status).toBe(201);
    const before = await tickets();
    expect((await downloadTicket(id, org)).body.code).toBe('rate_limited');
    expect((await uploadTicket(org)).body.code).toBe('rate_limited');
    expect(await tickets()).toBe(before);
    expect((await uploadTicket(randomUUID())).status).toBe(201);
  });

  it('service content reads are limited per (caller, organization); metadata reads are not; a probe of foreign ids spends budget too', async () => {
    const org = randomUUID();
    const id = await available(SAMPLES.pdf(700), org);
    for (let i = 0; i < 3; i++) expect((await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org))).status).toBe(200);
    expect((await request(server()).get(`/file/files/${randomUUID()}/content`).set(auth(drive, org))).status).toBe(404); // counted
    const over = await request(server()).get(`/file/files/${id}/content`).set(auth(drive, org));
    expect([over.status, over.body.code]).toEqual([429, 'rate_limited']);
    expect(over.headers['cache-control']).toBe('private, no-store');
    expect((await request(server()).get(`/file/files/${id}`).set(auth(drive, org))).status).toBe(200);
  });

  it('a window ends: the budget comes back (fixed window, database clock); nobody is locked out for good', async () => {
    const org = randomUUID();
    for (let i = 0; i < 4; i++) await uploadTicket(org);
    expect((await uploadTicket(org)).status).toBe(429);
    await s.query(`UPDATE kit_rate_limit SET "windowStart" = now() - interval '61 seconds'`);
    expect((await uploadTicket(org)).status).toBe(201);
  });

  it('20 concurrent issuances in one organization: exactly the budget (4) succeed (the counter is one atomic upsert)', async () => {
    const org = randomUUID();
    const rs = await Promise.all(Array.from({ length: 20 }, () => uploadTicket(org)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(4);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(16);
  });

  it('the limiter table holds digests only: no caller name, organization id, token or client address', async () => {
    const org = randomUUID();
    await uploadTicket(org);
    await request(server()).get(`/file/t/${randomBytes(32).toString('base64url')}`).expect(404); // a counted redemption failure
    const rows = await s.query<{ bucket: string; key: string }>('SELECT bucket, key FROM kit_rate_limit');
    expect(rows.map((r) => r.bucket).sort()).toEqual(['file_ticket_caller', 'file_ticket_failures', 'file_ticket_org']);
    for (const r of rows) expect(r.key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`core-drive|${org}|127\\.0\\.0\\.1`));
    // The client address is KEYED (HMAC under FILE_RATE_LIMIT_KEY) before the kit hashes it: an unkeyed address would be recoverable
    // by hashing the (small) address space. Neither form of the loopback address may appear, even hashed.
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
      expect(rows.map((r) => r.key)).not.toContain(sha(Buffer.from(`file_ticket_failures:${ip}`)));
    }
  });

  // ────────────────────────────────────────────────────────────────────────────── reusable download ticket cap

  it('a reusable download ticket serves at most FILE_TICKET_MAX_DOWNLOADS (3) times, then ticket_invalid; 100 concurrent redemptions: exactly 3 get bytes', async () => {
    const id = await available(SAMPLES.pdf(800));
    const path = tokenPath((await downloadTicket(id)).body.url as string);
    for (let i = 0; i < 3; i++) expect((await request(server()).get(path)).status).toBe(200);
    const spent = await request(server()).get(path);
    expect([spent.status, spent.body.code]).toEqual([404, 'ticket_invalid']);

    const path2 = tokenPath((await downloadTicket(id)).body.url as string);
    const rs = await Promise.all(Array.from({ length: 100 }, () => request(server()).get(path2).then((r) => r)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3); // never more: one conditional UPDATE per claim
    expect(rs.filter((r) => r.status === 404 && r.body.code === 'ticket_invalid')).toHaveLength(97);
    expect(((await s.query(`SELECT "useCount" FROM file_access_ticket WHERE "tokenDigest" = $1`, [sha(Buffer.from(path2.split('/file/t/')[1]!))]))[0] as { useCount: number }).useCount).toBe(3);
  });

  it('bounded upload concurrency (FILE_UPLOAD_MAX_IN_FLIGHT=1): a second upload is 503 upload_busy and consumes nothing; the slot returns when the first settles', async () => {
    const one = await createTestApp({ databaseUrl: db.url, tokens, policy: JSON.stringify(DELETE_POLICY), env: { ...LIMITS, FILE_UPLOAD_MAX_IN_FLIGHT: '1', FILE_UPLOAD_IDLE_TIMEOUT_MS: '1500' } });
    await one.app.listen(0, '127.0.0.1');
    try {
      const body = SAMPLES.pdf(50_000);
      const stalled = rawRequest(one.app, { method: 'POST', path: '/file/files', headers: { ...auth(drive), 'idempotency-key': randomUUID(), 'content-length': String(body.length) }, body, stallAfter: 1000 });
      await eventually(async () => ((await count(`SELECT count(*) AS n FROM file WHERE status = 'UPLOADING'`)) > 0 ? true : undefined));
      const ticketUrl = (await request(one.app.getHttpServer()).post('/file/uploads/tickets').set(auth(drive)).send({ maxBytes: 100_000, mediaTypes: ['application/pdf'] })).body.url as string;
      const busy = await request(one.app.getHttpServer()).put(tokenPath(ticketUrl)).send(SAMPLES.pdf());
      expect([busy.status, busy.body.code]).toEqual([503, 'upload_busy']);
      const svc = await request(one.app.getHttpServer()).post('/file/files').set({ ...auth(drive), 'idempotency-key': randomUUID() }).send(SAMPLES.pdf());
      expect([svc.status, svc.body.code]).toEqual([503, 'upload_busy']);
      await stalled; // cut by the idle timeout
      // The client can see its socket close a moment before the server has settled the row and released the slot: a 503 in that
      // window is the contract (retryable, nothing consumed), so retry while busy; the ticket must still create the file.
      const after = await eventually(async () => {
        const r = await request(one.app.getHttpServer()).put(tokenPath(ticketUrl)).send(SAMPLES.pdf());
        return r.status === 503 && r.body.code === 'upload_busy' ? undefined : r;
      }, 5_000);
      expect(after.status).toBe(201); // the ticket was never consumed by the refusals
    } finally {
      await one.app.close();
    }
  });

  it('the use cap is server configuration only: a caller cannot set or raise it when issuing (unknown fields are 400)', async () => {
    const id = await available(SAMPLES.pdf(800));
    for (const field of ['maxUses', 'maxDownloads', 'useCount', 'uses']) {
      const r = await downloadTicket(id, null, { [field]: 1_000_000 });
      expect(r.status).toBe(400);
    }
    expect(await count(`SELECT count(*) AS n FROM file_access_ticket WHERE "fileId" = $1`, [id])).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── limiter retention

  it('limiter retention: expired windows of this service\'s buckets are removed by the cleanup pass; live windows and foreign buckets stay', async () => {
    const row = (bucket: string, age: number) => s.query(`INSERT INTO kit_rate_limit (bucket, key, "windowStart", count) VALUES ($1, $2, now() - make_interval(secs => $3), 1)`, [bucket, randomBytes(32).toString('hex'), age]);
    await row('file_upload_caller', 120);
    await row('file_ticket_failures', 3_600);
    await row('file_download_org', 5); // live
    await row('other_service_bucket', 3_600); // not ours
    const result = await t.app.get(CleanupWorker).runOnce();
    expect(result.limitsPurged).toBe(2);
    expect((await s.query<{ bucket: string }>('SELECT bucket FROM kit_rate_limit ORDER BY bucket')).map((r) => r.bucket)).toEqual(['file_download_org', 'other_service_bucket']);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────── storage tampering

  it('tampering, same key, SAME size, other bytes: the response cannot complete (digest verified while streaming), both paths', async () => {
    const bytes = SAMPLES.pdf(300_000);
    const id = await available(bytes);
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [id]))[0] as { storageKey: string }).storageKey;
    const forged = Buffer.from(bytes);
    forged.write('%PDF-1.7 forged', 0, 'latin1'); // same length, other content
    writeFileSync(join(TEST_STORAGE_ROOT, key), forged);
    const from = ALL_LOGS.length;
    const svc = await fetchAll(`/file/files/${id}/content`, auth(drive));
    expect(svc.status).toBe(200); // headers were sent before the end could be verified…
    expect(svc.complete).toBe(false); // …but the body never completes: the client cannot take it for the file
    expect(svc.bytes).toBeLessThan(bytes.length); // the held-back last chunk is never released
    // The exact guarantee, not more: bytes before the last chunk DO reach the client (the forged prefix here), inside a response that
    // ends short of its Content-Length. At most one filesystem read chunk (64 KiB) is held back.
    expect(svc.head.subarray(0, 15).toString('latin1')).toBe('%PDF-1.7 forged');
    expect(bytes.length - svc.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(svc.headers['content-length']).toBe(String(bytes.length));
    expect(await logLine((m) => m === `file_storage_inconsistent file=${id} reason=digest_mismatch`, from)).toBeDefined();
    const tick = await fetchAll(tokenPath((await downloadTicket(id)).body.url as string));
    expect(tick.complete).toBe(false);
    expect(((await s.query(`SELECT status FROM file WHERE id = $1`, [id]))[0] as { status: string }).status).toBe('AVAILABLE'); // reported, never "repaired"
  });

  it('tampering of a file that fits in one read chunk: nothing at all is sent (not even the status line); the connection closes', async () => {
    const bytes = SAMPLES.pdf(5_000);
    const id = await available(bytes);
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [id]))[0] as { storageKey: string }).storageKey;
    const forged = Buffer.from(bytes);
    forged[4_999] = forged[4_999]! ^ 0xff;
    writeFileSync(join(TEST_STORAGE_ROOT, key), forged);
    const r = await fetchAll(`/file/files/${id}/content`, auth(drive));
    // Node sends the headers with the first body write; with nothing released, the destroyed socket carries no response at all.
    expect([r.status, r.complete, r.bytes]).toEqual([0, false, 0]);
  });

  it('tampering, same key, OTHER size (longer or shorter) and a MISSING object: 500 file_content_missing before any byte', async () => {
    const id = await available(SAMPLES.pdf(900));
    const key = ((await s.query(`SELECT "storageKey" FROM file WHERE id = $1`, [id]))[0] as { storageKey: string }).storageKey;
    for (const size of [901, 899]) {
      writeFileSync(join(TEST_STORAGE_ROOT, key), SAMPLES.pdf(size));
      const r = await request(server()).get(`/file/files/${id}/content`).set(auth(drive));
      expect([r.status, r.body.code]).toEqual([500, 'file_content_missing']);
      expect(Object.keys(r.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'statusCode']);
    }
    const { rmSync } = await import('node:fs');
    rmSync(join(TEST_STORAGE_ROOT, key));
    const gone = await request(server()).get(`/file/files/${id}/content`).set(auth(drive));
    expect([gone.status, gone.body.code]).toEqual([500, 'file_content_missing']);
    expect(JSON.stringify(gone.body)).not.toMatch(/files\/|ENOENT|tmp|storage/i);
  });

  it('an untampered object is served whole and byte-exact (the verifier holds back one chunk, never the file)', async () => {
    const bytes = SAMPLES.pdf(2_000_000);
    const id = await available(bytes);
    const r = await fetchAll(`/file/files/${id}/content`, auth(drive));
    expect([r.status, r.complete, r.bytes, r.sha256]).toEqual([200, true, bytes.length, sha(bytes)]);
    expect(r.headers.etag).toBe(`"${sha(bytes)}"`);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── HTTP framing

  it('request smuggling shapes are refused before any file exists: CL + TE, two Content-Lengths, signed / exponent / hex lengths', async () => {
    const before = await files();
    const head = (extra: string) => `POST /file/files HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${drive.token}\r\nIdempotency-Key: ${randomUUID()}\r\nContent-Type: application/pdf\r\n${extra}\r\n`;
    const body = SAMPLES.pdf().toString('latin1');
    const cases = [
      head(`Content-Length: ${body.length}\r\nTransfer-Encoding: chunked\r\n`) + `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
      head(`Content-Length: ${body.length}\r\nContent-Length: ${body.length + 1}\r\n`) + body,
      head(`Content-Length: +${body.length}\r\n`) + body,
      head('Content-Length: -1\r\n'),
      head('Content-Length: 1e3\r\n') + body,
      head(`Content-Length: 0x${body.length.toString(16)}\r\n`) + body,
      head('Transfer-Encoding: chunked\r\nTransfer-Encoding: identity\r\n') + `${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
    ];
    for (const c of cases) {
      const status = await rawHttp(c);
      expect([400, 411]).toContain(status);
    }
    expect(await files()).toBe(before);
  });

  // ───────────────────────────────────────────────────────────────────────────────── methods, CORS, CSRF

  it('methods: only the documented ones; TRACE / OPTIONS / PATCH / PUT on file routes are never 2xx; CORS stays closed; a form POST cannot redeem', async () => {
    const id = await available(SAMPLES.pdf(700));
    for (const [method, path] of [['patch', `/file/files/${id}`], ['put', `/file/files/${id}`], ['post', `/file/files/${id}/content`],
      ['options', '/file/files'], ['options', `/file/t/${randomBytes(32).toString('base64url')}`], ['delete', `/file/t/${randomBytes(32).toString('base64url')}`]] as const) {
      const r = await request(server())[method](path).set({ ...auth(drive), origin: 'https://evil.example', 'access-control-request-method': 'PUT' });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(await rawHttp(`TRACE /file/files HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${drive.token}\r\n\r\n`)).toBeGreaterThanOrEqual(400);
    // A cross-site HTML form can POST (text/plain, urlencoded, multipart) but never PUT: the upload redemption is PUT.
    const form = await request(server()).post(`/file/t/${randomBytes(32).toString('base64url')}`).type('form').send({ a: 'b' });
    expect(form.status).toBe(404);
    const get = await request(server()).get(`/file/files/${id}`).set({ ...auth(drive), origin: 'https://evil.example' });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────────────── polyglots and names

  it('polyglots: a PDF carrying HTML is stored as application/pdf and can only be served as an attachment in a sandbox; an image polyglot inline stays an image', async () => {
    const pdfHtml = Buffer.concat([SAMPLES.pdf(), Buffer.from('<html><script>alert(document.domain)</script></html>')]);
    const up = await upload(pdfHtml);
    expect([up.status, up.body.mediaType]).toEqual([201, 'application/pdf']);
    expect((await downloadTicket(up.body.id as string, null, { disposition: 'inline' })).body.code).toBe('disposition_not_allowed');
    const r = await request(server()).get(`/file/files/${up.body.id}/content`).set(auth(drive));
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    const pngHtml = Buffer.concat([SAMPLES.png(), Buffer.from('<svg onload=alert(1)><script>alert(2)</script>')]);
    const img = await upload(pngHtml);
    expect(img.body.mediaType).toBe('image/png');
    const inline = await request(server()).get(tokenPath((await downloadTicket(img.body.id as string, null, { disposition: 'inline' })).body.url as string));
    expect(inline.headers['content-type']).toBe('image/png');
    expect(inline.headers['content-disposition']).toMatch(/^inline;/);
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    expect(inline.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('hostile names end to end: a control between a letter and its combining mark (the 17.8 NFC finding), bidi marks, separators: 201 with a clean NFC name', async () => {
    const cases: [string, string][] = [
      [`e${cp(0x07)}${cp(0x301)}.pdf`, `${cp(0xe9)}.pdf`],
      [`invoice${cp(0x200f)}fdp.exe.pdf`, 'invoicefdp.exe.pdf'],
      [`a${cp(0x061c)}b${cp(0x200e)}c${cp(0x2028)}d${cp(0xfeff)}.pdf`, 'abcd.pdf'],
      [`${cp(0x202e)}fdp.pdf`, 'fdp.pdf'],
    ];
    for (const [raw, clean] of cases) {
      const r = await upload(SAMPLES.pdf(), null, drive, { 'x-file-name': encodeURIComponent(raw) });
      expect([r.status, r.body.originalName]).toEqual([201, clean]);
      await s.query('DELETE FROM kit_rate_limit');
    }
    // The classic override trick ("invoice<RLO>fdp.exe" displays as "invoiceexe.pdf"): the real extension contradicts the bytes: refused.
    const rlo = await upload(SAMPLES.pdf(), null, drive, { 'x-file-name': encodeURIComponent(`invoice${cp(0x202e)}fdp.exe`) });
    expect([rlo.status, rlo.body.code]).toEqual([422, 'media_type_mismatch']);
  });

  it('the schema refuses a stored name with a bidi mark, line separator or BOM even if the sanitizer were bypassed (0003)', async () => {
    for (const c of [0x061c, 0x200e, 0x200f, 0x2028, 0x2029, 0xfeff]) {
      const refused = await s.refusedInsert('file', fileRow({ originalName: `a${cp(c)}b.pdf` }));
      expect(refused.constraint).toBe('file_original_name_no_marks');
    }
    await s.insert('file', fileRow({ originalName: `a${cp(0x200c)}b.pdf` })); // ZWNJ is legitimate
  });

  // ───────────────────────────────────────────────────────────────────────────────── logs and health bodies

  it('log injection: a name, key or digest carrying CR/LF and fake JSON never reaches a log line; every line stays one JSON object', async () => {
    const from = ALL_LOGS.length;
    const sentinel = `x\r\n{"level":"error","msg":"forged-${randomUUID()}"}`;
    await upload(SAMPLES.pdf(), null, drive, { 'x-file-name': encodeURIComponent(sentinel) });
    await request(server()).post('/file/files').set({ ...auth(drive), 'idempotency-key': 'a\tb' }).send(SAMPLES.pdf()).expect(400);
    await request(server()).get(`/file/t/${encodeURIComponent(sentinel)}`).expect(404);
    const lines = ALL_LOGS.slice(from);
    expect(JSON.stringify(lines)).not.toContain('forged-');
    for (const l of lines) expect(String(l.msg)).not.toMatch(/[\r\n]/);
  });

  it('/health and /ready expose status only: no version, host, database, storage, pid or dependency detail', async () => {
    const h = await request(server()).get('/health');
    const r = await request(server()).get('/ready');
    const text = JSON.stringify([h.body, r.body]);
    expect(text).not.toMatch(/postgres|127\.0\.0\.1|file-service-test|s3|bucket|version|pid|hostname|node|\/tmp/i);
    expect(h.headers['x-powered-by']).toBeUndefined();
  });
});
