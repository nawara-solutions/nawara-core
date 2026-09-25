import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { FileRepository, type FileRow, type FileScope, type NewUpload } from '../src/persistence/file.repository.js';
import { FilePersistenceError } from '../src/persistence/persistence-error.js';
import { ticketDigest, type TicketDigest } from '../src/persistence/ticket-digest.js';
import { TicketRepository } from '../src/persistence/ticket.repository.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { newToken, sha, Sql } from './support/fixtures.js';
import { REFUSED_ROW_MARKER } from './support/probe.js';

/**
 * Stage 17.3: the persistence layer through the REAL application module (the repositories as the 17.5+ routes will get them): scoped,
 * non-disclosing reads; server-derived ids and keys; digest-only tickets; atomic single use; transactional revocation. No HTTP route
 * reaches any of it (a test-only probe proves a raw database error stays opaque).
 */
describeWithEnv('file persistence: repositories (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let files: FileRepository;
  let tickets: TicketRepository;
  let dbs: DbService;
  let s: Sql;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'filerepo');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url });
    files = t.app.get(FileRepository);
    tickets = t.app.get(TicketRepository);
    dbs = t.app.get(DbService);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await t?.app.close();
    await db?.drop();
  });

  const drive = (organizationId: string | null = randomUUID()): FileScope => ({ ownerService: 'core-drive', organizationId });
  const upload = (scope: FileScope, over: Partial<NewUpload> = {}): NewUpload => ({
    scope, storage: { provider: 'filesystem', keyPrefix: 'files' }, uploadLeaseSeconds: 3_600, attachment: { deadlineSeconds: 86_400 }, ...over,
  });
  /** Moves a file to AVAILABLE the way 17.5 will (a plain SQL stand-in: the completion primitive belongs to the upload stage). */
  async function makeAvailable(f: FileRow) {
    await s.query(`UPDATE file SET status = 'AVAILABLE', "mediaType" = 'application/pdf', "sizeBytes" = 10, sha256 = $2, "availableAt" = now() WHERE id = $1`, [f.id, sha()]);
  }
  const digest = (): TicketDigest => ticketDigest(newToken().token)!;

  // ------------------------------------------------------------------------------------------------------------ files

  it('creates the UPLOADING row with a server id, a server storage key (never the name) and database-clock deadlines', async () => {
    const scope = drive();
    const f = await files.createUploading(upload(scope, { originalName: 'Passeport – جواز.pdf', declaredMediaType: 'application/pdf', createdBy: 'user:7' }));
    expect(f).toMatchObject({ ownerService: 'core-drive', organizationId: scope.organizationId, status: 'UPLOADING', originalName: 'Passeport – جواز.pdf', attachedAt: null, mediaType: null });
    expect(f.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.storageKey).toMatch(new RegExp(`^files/${f.id}/[0-9a-f]{32}$`));
    expect(f.storageKey).not.toMatch(/passe|pdf|drive|jpg/i);
    expect(f.uploadExpiresAt.getTime() - f.createdAt.getTime()).toBe(3_600_000);
    expect(f.attachDeadline!.getTime() - f.createdAt.getTime()).toBe(86_400_000);
  });

  it('ignores any caller-supplied id, key, status or owner smuggled into the input (they are always derived)', async () => {
    const smuggled = { ...upload(drive()), id: '00000000-0000-4000-8000-000000000000', storageKey: '../../etc/passwd', status: 'AVAILABLE', ownerService: 'core-billing' } as unknown as NewUpload;
    const f = await files.createUploading(smuggled);
    expect(f.id).not.toBe('00000000-0000-4000-8000-000000000000');
    expect(f.storageKey).toMatch(new RegExp(`^files/${f.id}/`));
    expect(f.status).toBe('UPLOADING');
    expect(f.ownerService).toBe('core-drive'); // from scope, the authenticated identity
  });

  it('a file a service generates for itself can be created attached, with no deadline; a platform file has no organization', async () => {
    const f = await files.createUploading(upload(drive(null), { attachment: { attached: true } }));
    expect(f.organizationId).toBeNull();
    expect(f.attachedAt).toBeInstanceOf(Date);
    expect(f.attachDeadline).toBeNull();
  });

  it('findOwned answers only for the owner in the file\'s own organization; everything else is the same undefined', async () => {
    const org = randomUUID();
    const f = await files.createUploading(upload(drive(org)));
    const p = await files.createUploading(upload(drive(null)));
    expect((await files.findOwned(drive(org), f.id))?.id).toBe(f.id);
    expect((await files.findOwned(drive(null), p.id))?.id).toBe(p.id);
    const misses = [
      await files.findOwned({ ownerService: 'core-billing', organizationId: org }, f.id), // another owner
      await files.findOwned(drive(randomUUID()), f.id), // another organization
      await files.findOwned(drive(null), f.id), // the organization omitted
      await files.findOwned(drive(org), p.id), // a platform file asked with an organization
      await files.findOwned(drive(org), randomUUID()), // missing
      await files.findOwned(drive(org), 'not-a-uuid'), // not an id (no database error)
      await files.findOwned(drive(org), `${f.id}' OR '1'='1`),
    ];
    expect(misses).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('the Idempotency-Key is unique per owner among live files: a duplicate is a typed persistence error', async () => {
    const idem = { key: `idem-${randomUUID()}`, requestHash: sha() };
    const first = await files.createUploading(upload(drive(), { idempotency: idem }));
    const e = await files.createUploading(upload(drive(), { idempotency: idem })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FilePersistenceError);
    expect((e as FilePersistenceError).code).toBe('idempotency_key_in_use');
    await files.createUploading(upload({ ownerService: 'core-billing', organizationId: null }, { idempotency: idem })); // another owner
    await s.query(`UPDATE file SET status = 'FAILED', "failureCode" = 'storage_unavailable' WHERE id = $1`, [first.id]);
    await files.createUploading(upload(drive(), { idempotency: idem })); // a failed attempt may be retried with the same key
  });

  it('a creation inside a transaction that rolls back leaves nothing', async () => {
    const org = randomUUID();
    let id = '';
    await expect(dbs.tx(async (q) => {
      id = (await files.createUploading(upload(drive(org)), q)).id;
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await files.findOwned(drive(org), id)).toBeUndefined();
  });

  // ---------------------------------------------------------------------------------------------------------- tickets

  it('a download ticket is recorded only for a file the issuer owns in that organization, in one statement', async () => {
    const org = randomUUID();
    const f = await files.createUploading(upload(drive(org)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const base = { fileId: f.id, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' as const };
    const ok = await tickets.recordDownload({ ...base, scope: drive(org), tokenDigest: digest() });
    expect(ok).toMatchObject({ operation: 'download', fileId: f.id, issuedBy: 'core-drive', organizationId: org, useCount: 0 });
    expect(ok!.expiresAt.getTime() - ok!.createdAt.getTime()).toBe(120_000);
    expect(Object.keys(ok!)).not.toContain('tokenDigest'); // a returned row never carries the digest
    const before = await s.query(`SELECT count(*)::int AS n FROM file_access_ticket WHERE "fileId" = $1`, [f.id]);
    for (const scope of [{ ownerService: 'core-billing', organizationId: org }, drive(randomUUID()), drive(null)]) {
      expect(await tickets.recordDownload({ ...base, scope, tokenDigest: digest() })).toBeUndefined();
    }
    expect(await tickets.recordDownload({ ...base, fileId: randomUUID(), scope: drive(org), tokenDigest: digest() })).toBeUndefined();
    expect(await s.query(`SELECT count(*)::int AS n FROM file_access_ticket WHERE "fileId" = $1`, [f.id])).toEqual(before);
  });

  it('a raw token can never be stored or looked up: the repository takes digests only, and refuses anything else', async () => {
    const f = await files.createUploading(upload(drive(null)));
    const { token } = newToken();
    const input = { scope: drive(null), fileId: f.id, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' as const };
    await expect(tickets.recordDownload({ ...input, tokenDigest: token as TicketDigest })).rejects.toThrow(/digest only/);
    await expect(tickets.recordUpload({ scope: drive(null), tokenDigest: token as TicketDigest, lifetimeSeconds: 120, maxBytes: 10, mediaTypes: ['application/pdf'], attach: false })).rejects.toThrow(/digest only/);
    await expect(tickets.claimUse(token as TicketDigest, 'download')).rejects.toThrow(/digest only/);
    expect(await s.query(`SELECT 1 FROM file_access_ticket WHERE "tokenDigest" = $1`, [token])).toEqual([]);
    expect(ticketDigest('too-short')).toBeUndefined();
    expect(ticketDigest(`${token}=`)).toBeUndefined();
  });

  it('a lifetime outside 60-300 s and a media type outside the allow-list are refused before the database', async () => {
    const f = await files.createUploading(upload(drive(null)));
    for (const lifetimeSeconds of [0, 59, 301, 86_400, 1.5]) {
      await expect(tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: digest(), lifetimeSeconds, singleUse: false, disposition: 'inline' })).rejects.toThrow(/60-300 seconds/);
    }
    await expect(tickets.recordUpload({ scope: drive(null), tokenDigest: digest(), lifetimeSeconds: 60, maxBytes: 10, mediaTypes: ['text/html' as 'application/pdf'], attach: false })).rejects.toThrow(/allow-listed/);
    await expect(tickets.recordUpload({ scope: drive(null), tokenDigest: digest(), lifetimeSeconds: 60, maxBytes: 10, mediaTypes: [], attach: false })).rejects.toThrow(/allow-listed/);
  });

  it('a digest collision is a typed persistence error (the issuer draws a new token)', async () => {
    const d = digest();
    await tickets.recordUpload({ scope: drive(null), tokenDigest: d, lifetimeSeconds: 60, maxBytes: 10, mediaTypes: ['image/png'], attach: false });
    const e = await tickets.recordUpload({ scope: drive(null), tokenDigest: d, lifetimeSeconds: 60, maxBytes: 10, mediaTypes: ['image/png'], attach: false }).catch((x: unknown) => x);
    expect((e as FilePersistenceError).code).toBe('ticket_digest_collision');
  });

  it('an upload ticket is single-use: the first claim wins, every later one is undefined', async () => {
    const d = digest();
    const u = await tickets.recordUpload({ scope: drive(null), tokenDigest: d, lifetimeSeconds: 300, maxBytes: 1024, mediaTypes: ['application/pdf', 'image/jpeg'], attach: true });
    expect(u).toMatchObject({ operation: 'upload', singleUse: true, fileId: null, maxBytes: '1024', mediaTypes: ['application/pdf', 'image/jpeg'], attach: true });
    expect(await tickets.claimUse(d, 'upload')).toMatchObject({ id: u.id, useCount: 1 });
    expect(await tickets.claimUse(d, 'upload')).toBeUndefined();
  });

  it('a download ticket is reusable until expiry by default (each use counted, the first stamped), or single-use when issued so', async () => {
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f);
    const d = digest();
    await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    const first = await tickets.claimUse(d, 'download');
    const second = await tickets.claimUse(d, 'download');
    expect([first!.useCount, second!.useCount]).toEqual([1, 2]);
    expect(second!.usedAt).toEqual(first!.usedAt);
    const once = digest();
    await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: once, lifetimeSeconds: 120, singleUse: true, disposition: 'inline' });
    expect(await tickets.claimUse(once, 'download')).toBeDefined();
    expect(await tickets.claimUse(once, 'download')).toBeUndefined();
  });

  it('unknown, expired, revoked and used-up tickets all give the same undefined (one `ticket_invalid` later)', async () => {
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const expired = digest();
    await s.query(`INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "tokenDigest", disposition, "singleUse", "createdAt", "expiresAt")
      VALUES ($1, 'download', $2, 'core-drive', $3, 'attachment', false, now() - interval '10 minutes', now() - interval '8 minutes')`, [randomUUID(), f.id, expired]);
    const revoked = digest();
    const r = await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: revoked, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, r!.id);
    const used = digest();
    await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: used, lifetimeSeconds: 120, singleUse: true, disposition: 'attachment' });
    await tickets.claimUse(used, 'download');
    const outcomes = [await tickets.claimUse(digest(), 'download'), await tickets.claimUse(expired, 'download'), await tickets.claimUse(revoked, 'download'), await tickets.claimUse(used, 'download')];
    expect(outcomes).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('revocation is issuer-scoped and idempotent; another issuer (or an unknown id) gets the same false and changes nothing', async () => {
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const d = digest();
    const tk = await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    expect(await tickets.revoke({ ownerService: 'core-billing', organizationId: null }, tk!.id)).toBe(false);
    expect(await tickets.claimUse(d, 'download')).toBeDefined(); // still live
    expect(await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, randomUUID())).toBe(false);
    expect(await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, 'nope')).toBe(false);
    expect(await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, tk!.id)).toBe(true);
    const [{ revokedAt }] = await s.query<{ revokedAt: Date }>(`SELECT "revokedAt" FROM file_access_ticket WHERE id = $1`, [tk!.id]);
    expect(await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, tk!.id)).toBe(true);
    expect((await s.query<{ revokedAt: Date }>(`SELECT "revokedAt" FROM file_access_ticket WHERE id = $1`, [tk!.id]))[0]!.revokedAt).toEqual(revokedAt);
    expect(await tickets.claimUse(d, 'download')).toBeUndefined();
  });

  it('a file\'s tickets are revoked in the caller\'s transaction: rolled back together, or committed together', async () => {
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const ds = [digest(), digest()];
    for (const d of ds) await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    const other = await files.createUploading(upload(drive(null)));
    await makeAvailable(other); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const otherDigest = digest();
    await tickets.recordDownload({ scope: drive(null), fileId: other.id, tokenDigest: otherDigest, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    await expect(dbs.tx(async (q) => {
      expect(await tickets.revokeAllForFile(q, f.id)).toBe(2);
      throw new Error('the logical delete failed');
    })).rejects.toThrow();
    expect(await tickets.claimUse(ds[0]!, 'download')).toBeDefined(); // the rollback kept them live
    expect(await dbs.tx((q) => tickets.revokeAllForFile(q, f.id))).toBe(2);
    expect(await tickets.claimUse(ds[0]!, 'download')).toBeUndefined();
    expect(await tickets.claimUse(ds[1]!, 'download')).toBeUndefined();
    expect(await tickets.claimUse(otherDigest, 'download')).toBeDefined(); // another file's ticket untouched
    expect(await dbs.tx((q) => tickets.revokeAllForFile(q, f.id))).toBe(0); // idempotent
  });

  // ------------------------------------------------------------------------------------------------------ concurrency

  it('concurrent claims of one single-use ticket: exactly one wins (20 at once through the pool)', async () => {
    const d = digest();
    await tickets.recordUpload({ scope: drive(null), tokenDigest: d, lifetimeSeconds: 120, maxBytes: 10, mediaTypes: ['application/pdf'], attach: false });
    const results = await Promise.all(Array.from({ length: 20 }, () => tickets.claimUse(d, 'upload')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await s.query<{ useCount: number }>(`SELECT "useCount" FROM file_access_ticket WHERE "tokenDigest" = $1`, [d]))[0]!.useCount).toBe(1);
  });

  it('the losing claim waits on the winner\'s row lock and then fails; if the winner rolls back, the waiter wins', async () => {
    const d = digest();
    await tickets.recordUpload({ scope: drive(null), tokenDigest: d, lifetimeSeconds: 120, maxBytes: 10, mediaTypes: ['application/pdf'], attach: false });
    const a = new pg.Client({ connectionString: db.url });
    await a.connect();
    try {
      await a.query('BEGIN');
      const claimA = await tickets.claimUse(d, 'upload', a); // A holds the row, uncommitted
      expect(claimA).toBeDefined();
      const claimB = tickets.claimUse(d, 'upload'); // B blocks on A's lock
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect(await claimB).toBeUndefined(); // re-evaluated after A's commit: used up
      const d2 = digest();
      await tickets.recordUpload({ scope: drive(null), tokenDigest: d2, lifetimeSeconds: 120, maxBytes: 10, mediaTypes: ['application/pdf'], attach: false });
      await a.query('BEGIN');
      expect(await tickets.claimUse(d2, 'upload', a)).toBeDefined();
      const waiting = tickets.claimUse(d2, 'upload');
      await new Promise((r) => setTimeout(r, 200));
      await a.query('ROLLBACK');
      expect(await waiting).toBeDefined(); // A never happened: B is the one use
    } finally {
      await a.end();
    }
  });

  it('a claim racing a revocation: whichever commits first decides; a ticket is never used after its revocation', async () => {
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    const d = digest();
    const tk = await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: false, disposition: 'attachment' });
    const a = new pg.Client({ connectionString: db.url });
    await a.connect();
    try {
      await a.query('BEGIN');
      expect(await tickets.revoke({ ownerService: 'core-drive', organizationId: null }, tk!.id, a)).toBe(true);
      const claim = tickets.claimUse(d, 'download');
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      expect(await claim).toBeUndefined();
    } finally {
      await a.end();
    }
  });

  // ----------------------------------------------------------------------------------------------- errors and logs

  it('a refused write surfaces as the opaque 500 only: no SQL, constraint, row value or connection detail in the response or any log', async () => {
    const r = await request(t.app.getHttpServer()).get('/probe/persistence/refused').expect(500);
    expect(r.body).toMatchObject({ statusCode: 500, message: 'Internal server error' });
    const body = JSON.stringify(r.body);
    for (const leak of [REFUSED_ROW_MARKER, 'file_original_name_safe', 'INSERT', 'violates', 'files/', new URL(db.url).password || 'no-password-set', '127.0.0.1']) {
      expect(body).not.toContain(leak);
    }
    const logs = JSON.stringify(ALL_LOGS);
    expect(logs).toContain('unhandled error'); // it WAS logged (the scan is not vacuous) …
    for (const leak of [REFUSED_ROW_MARKER, new URL(db.url).password || 'no-password-set']) {
      expect(logs).not.toContain(leak); // … without the row (PostgreSQL's `detail`) or a credential
    }
    expect(logs).not.toMatch(/files\/[0-9a-f]{8}-[0-9a-f]{4}-/); // no storage key (route patterns such as /file/files are fine)
  });

  it('no digest, token or storage key reaches a log line during ticket and file operations', async () => {
    const { token } = newToken();
    const d = ticketDigest(token)!;
    const f = await files.createUploading(upload(drive(null)));
    await makeAvailable(f); // Stage 17.7: download tickets are issued for AVAILABLE files only
    await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: true, disposition: 'attachment' });
    await tickets.claimUse(d, 'download');
    await tickets.claimUse(d, 'download');
    await tickets.recordDownload({ scope: drive(null), fileId: f.id, tokenDigest: d, lifetimeSeconds: 120, singleUse: true, disposition: 'attachment' }).catch(() => undefined);
    const logs = JSON.stringify(ALL_LOGS);
    for (const secret of [token, d, f.storageKey]) expect(logs).not.toContain(secret);
  });
});
