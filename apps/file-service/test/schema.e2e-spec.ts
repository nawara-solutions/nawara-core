import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { fileMigrationsDir } from '../src/app.module.js';
import { describeWithEnv } from './support/env.js';
import { downloadTicketRow, fileRow, newToken, sha, Sql, uploadTicketRow } from './support/fixtures.js';

/**
 * Stage 17.3: the `file` and `file_access_ticket` schema enforces its own truths (SDD §3, §5, §6, §11.1), whatever the application
 * does: shapes, the state machine, set-once content, immutability, ticket bindings, single use, no hard delete, no cascade, no bytes.
 */
describeWithEnv('file schema: constraints and triggers (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let s: Sql;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'fileschema');
    await runMigrations(db.url, [kitMigrationsDir, fileMigrationsDir]);
    s = await Sql.connect(db.url);
  });
  afterAll(async () => {
    await s?.end();
    await db.drop();
  });

  const available = () => ({ status: 'AVAILABLE', mediaType: 'application/pdf', sizeBytes: 1234, sha256: sha(), availableAt: new Date(Date.now() + 1_000) });
  async function availableFile(over: Record<string, unknown> = {}) {
    const [row] = await s.insert('file', fileRow(over));
    await s.update('file', row!.id, available());
    return row!;
  }

  // ---------------------------------------------------------------------------------------------------------------- file

  it('a valid file row is created UPLOADING with database-clock timestamps; an Arabic / French name is kept', async () => {
    const [row] = await s.insert('file', fileRow({ originalName: 'عقد التسجيل – été.pdf', organizationId: randomUUID(), createdBy: 'user:42' }));
    expect(row).toMatchObject({ status: 'UPLOADING', originalName: 'عقد التسجيل – été.pdf', mediaType: null, sizeBytes: null, sha256: null, attachedAt: null });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('a file must be created UPLOADING (the insert trigger runs before the CHECKs, so an unknown status is refused there too)', async () => {
    expect((await s.refusedInsert('file', fileRow(available()))).message).toMatch(/must be created UPLOADING/);
    expect((await s.refusedInsert('file', fileRow({ status: 'ARCHIVED' }))).message).toMatch(/must be created UPLOADING/);
    const [f] = await s.insert('file', fileRow());
    expect((await s.refusedUpdate('file', f!.id, { status: 'ARCHIVED' })).message).toMatch(/cannot move from UPLOADING to ARCHIVED/);
  });

  it.each([
    ['a negative size', { sizeBytes: -1 }, 'file_size_bounded'],
    ['a size above the 100 MiB ceiling', { sizeBytes: 104_857_601 }, 'file_size_bounded'],
    ['an uppercase checksum', { sha256: sha().toUpperCase() }, 'file_sha256_shape'],
    ['a short checksum', { sha256: 'abc123' }, 'file_sha256_shape'],
    ['a non-allow-listed verified type', { mediaType: 'text/html' }, 'file_media_type_allowed'],
    ['an owner outside the caller grammar', { ownerService: 'Core Drive' }, 'file_owner_service_shape'],
    ['a name with a path separator', { originalName: '../../etc/passwd' }, 'file_original_name_safe'],
    ['a name with a backslash', { originalName: 'a\\b.pdf' }, 'file_original_name_safe'],
    ['a name with a control character', { originalName: 'a\r\nb.pdf' }, 'file_original_name_safe'],
    ['a name with a bidi override', { originalName: 'invoice\u202Efdp.exe' }, 'file_original_name_safe'],
    ['a name that is not NFC', { originalName: 'éte.pdf' }, 'file_original_name_safe'],
    ['a name above 255 UTF-8 bytes', { originalName: 'ع'.repeat(128) }, 'file_original_name_safe'],
    ['the name ".."', { originalName: '..' }, 'file_original_name_safe'],
    ['a declared type with a control character', { declaredMediaType: 'application/pdf\n' }, 'file_declared_media_type_bounded'],
    ['an idempotency key without its request hash', { idempotencyKey: 'k-1' }, 'file_idempotency_pair'],
    ['a request hash that is not a digest', { idempotencyKey: 'k-1', requestHash: 'nope' }, 'file_request_hash_shape'],
    ['an attach deadline before creation', { attachDeadline: new Date(Date.now() - 60_000) }, 'file_timestamps_ordered'],
    ['neither attached nor a deadline', { attachDeadline: null }, 'file_attached_or_deadline'],
    ['a provider outside the grammar', { storageProvider: 'S3/../x' }, 'file_storage_provider_shape'],
  ])('refuses %s', async (_label, over, constraint) => {
    const r = await s.refusedInsert('file', fileRow(over));
    expect(r.code).toBe('23514');
    expect(r.constraint).toBe(constraint);
  });

  it('the storage key must be `<prefix>/<this file id>/<32 hex>`: never another file id, a traversal, a name or uppercase', async () => {
    const id = randomUUID();
    for (const key of [`files/${randomUUID()}/${sha().slice(0, 32)}`, `files/../${id}/${sha().slice(0, 32)}`, `/files/${id}/${sha().slice(0, 32)}`,
      `files/${id}/passport.pdf`, `Files/${id}/${sha().slice(0, 32)}`, `files//${id}/${sha().slice(0, 32)}`, `${id}/${sha().slice(0, 32)}`]) {
      expect((await s.refusedInsert('file', fileRow({ id, storageKey: key }))).constraint, key).toBe('file_storage_key_shape');
    }
    await s.insert('file', fileRow({ id, storageKey: `tenant-files/prod/${id}/${sha().slice(0, 32)}` }));
  });

  it('ids and storage keys are unique; checksums are NOT (no deduplication, F33)', async () => {
    const [a] = await s.insert('file', fileRow());
    expect((await s.refusedInsert('file', fileRow({ id: a!.id }))).code).toBe('23505');
    expect((await s.refusedInsert('file', { ...fileRow(), storageKey: a!.storageKey })).code).toMatch(/^(23505|23514)$/); // another id cannot even carry it
    const digest = sha(); // the same bytes, uploaded twice (here by two owners): two independent files
    const [x] = await s.insert('file', fileRow());
    const [y] = await s.insert('file', fileRow({ ownerService: 'core-billing', organizationId: randomUUID() }));
    await s.update('file', x!.id, { ...available(), sha256: digest });
    await s.update('file', y!.id, { ...available(), sha256: digest });
    expect(await s.query('SELECT id FROM file WHERE sha256 = $1', [digest])).toHaveLength(2);
  });

  it('one live file per (owner, Idempotency-Key); a FAILED attempt frees the key for a retry; another owner may use the same key', async () => {
    const key = { idempotencyKey: `idem-${randomUUID()}`, requestHash: sha() };
    const [first] = await s.insert('file', fileRow(key));
    expect((await s.refusedInsert('file', fileRow(key))).constraint).toBe('file_idempotency_unique');
    await s.insert('file', fileRow({ ...key, ownerService: 'core-billing' }));
    await s.update('file', first!.id, { status: 'FAILED', failureCode: 'storage_unavailable' });
    await s.insert('file', fileRow(key)); // the retry
  });

  it('follows the frozen state machine only; terminal states are final', async () => {
    const [f] = await s.insert('file', fileRow());
    expect((await s.refusedUpdate('file', f!.id, { status: 'DELETING', deletionRequestedAt: new Date() })).message).toMatch(/cannot move from UPLOADING to DELETING/);
    // Content must be complete to leave the upload.
    expect((await s.refusedUpdate('file', f!.id, { status: 'AVAILABLE', availableAt: new Date() })).constraint).toBe('file_content_complete');
    expect((await s.refusedUpdate('file', f!.id, { status: 'AVAILABLE', mediaType: 'application/pdf', sizeBytes: 1, sha256: sha() })).constraint).toBe('file_available_at_iff_available');
    await s.update('file', f!.id, { status: 'VERIFYING', mediaType: 'image/png', sizeBytes: 10, sha256: sha() });
    await s.update('file', f!.id, { status: 'AVAILABLE', availableAt: new Date() });
    expect((await s.refusedUpdate('file', f!.id, { status: 'UPLOADING' })).message).toMatch(/cannot move from AVAILABLE to UPLOADING/);
    expect((await s.refusedUpdate('file', f!.id, { status: 'DELETED', deletedAt: new Date() })).message).toMatch(/cannot move from AVAILABLE to DELETED/);
    expect((await s.refusedUpdate('file', f!.id, { status: 'DELETING' })).constraint).toBe('file_deletion_requested_iff_deleting');
    await s.update('file', f!.id, { status: 'DELETING', deletionRequestedAt: new Date() });
    expect((await s.refusedUpdate('file', f!.id, { attachedAt: new Date() })).message).toMatch(/DELETING and cannot be attached/);
    await s.update('file', f!.id, { status: 'DELETED', deletedAt: new Date() });
    expect((await s.refusedUpdate('file', f!.id, { status: 'AVAILABLE' })).message).toMatch(/cannot move from DELETED/);
    for (const change of [{ attachedAt: new Date(Date.now() + 1_000) }, { failureCode: 'x' }]) {
      expect((await s.refusedUpdate('file', f!.id, change)).message).toMatch(/is DELETED and final/);
    }
    const [r] = await s.insert('file', fileRow());
    expect((await s.refusedUpdate('file', r!.id, { status: 'REJECTED' })).constraint).toBe('file_failure_code_iff_refused');
    await s.update('file', r!.id, { status: 'REJECTED', failureCode: 'unsupported_media_type' });
    expect((await s.refusedUpdate('file', r!.id, { status: 'AVAILABLE' })).message).toMatch(/cannot move from REJECTED/);
  });

  it('identity, placement and declaration are immutable; content metadata and stamps are set once', async () => {
    const f = await availableFile({ organizationId: randomUUID(), originalName: 'a.pdf', idempotencyKey: `k-${randomUUID()}`, requestHash: sha() });
    for (const [col, value] of [['ownerService', 'core-billing'], ['organizationId', randomUUID()], ['organizationId', null], ['storageKey', `files/${String(f.id)}/${sha().slice(0, 32)}`],
      ['storageProvider', 's3'], ['originalName', 'b.pdf'], ['createdBy', 'someone'], ['idempotencyKey', 'other'], ['uploadExpiresAt', new Date(Date.now() + 9e6)],
      ['attachDeadline', new Date(Date.now() + 9e7)], ['createdAt', new Date()], ['id', randomUUID()]] as const) {
      expect((await s.refusedUpdate('file', f.id, { [col]: value })).message, col).toMatch(/is immutable/);
    }
    for (const [col, value] of [['sha256', sha()], ['sizeBytes', 99], ['mediaType', 'image/png'], ['availableAt', new Date(Date.now() + 1000)], ['sha256', null]] as const) {
      expect((await s.refusedUpdate('file', f.id, { [col]: value })).message, col).toMatch(/is set once/);
    }
    await s.update('file', f.id, { attachedAt: new Date() }); // NULL → value: attach, once
    expect((await s.refusedUpdate('file', f.id, { attachedAt: new Date(Date.now() + 5000) })).message).toMatch(/is set once/);
  });

  it('a file row is never deleted (logical deletion only), whatever its state', async () => {
    const [f] = await s.insert('file', fileRow());
    expect((await s.refused('DELETE FROM file WHERE id = $1', [f!.id])).message).toMatch(/never deleted/);
  });

  // -------------------------------------------------------------------------------------------------------- tickets

  it('valid download and upload tickets are accepted; an upload ticket is single-use and starts without a file', async () => {
    const f = await availableFile();
    const [d] = await s.insert('file_access_ticket', downloadTicketRow(f));
    expect(d).toMatchObject({ operation: 'download', fileId: f.id, useCount: 0, usedAt: null, revokedAt: null });
    const [u] = await s.insert('file_access_ticket', uploadTicketRow());
    expect(u).toMatchObject({ operation: 'upload', fileId: null, singleUse: true, attach: true });
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ singleUse: false }))).constraint).toBe('file_access_ticket_upload_shape');
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ fileId: f.id }))).message).toMatch(/starts without a file/);
  });

  it('stores digests only: a raw token (or anything but 64 lowercase hex) is refused, and a digest is unique', async () => {
    const f = await availableFile();
    const { token, digest } = newToken();
    expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(f, { tokenDigest: token }))).constraint).toBe('file_access_ticket_token_digest_shape');
    expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(f, { tokenDigest: digest.toUpperCase() }))).constraint).toBe('file_access_ticket_token_digest_shape');
    await s.insert('file_access_ticket', downloadTicketRow(f, { tokenDigest: digest }));
    expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(f, { tokenDigest: digest }))).constraint).toBe('file_access_ticket_token_digest_unique');
  });

  it.each([
    ['an operation other than download / upload', { operation: 'delete' }, 'file_access_ticket_operation_valid'],
    ['a download without a disposition', { disposition: null }, 'file_access_ticket_download_shape'],
    ['a download with upload limits', { maxBytes: 10 }, 'file_access_ticket_download_shape'],
    ['an unknown disposition', { disposition: 'render' }, 'file_access_ticket_disposition_valid'],
    ['a lifetime under 60 s', { expiresAt: new Date(Date.now() + 30_000) }, 'file_access_ticket_lifetime_bounded'],
    ['a lifetime over 300 s', { expiresAt: new Date(Date.now() + 600_000) }, 'file_access_ticket_lifetime_bounded'],
  ])('refuses a download ticket with %s', async (_label, over, constraint) => {
    const f = await availableFile();
    expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(f, over))).constraint).toBe(constraint);
  });

  it('a download ticket with no file is refused', async () => {
    const f = await availableFile();
    expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(f, { fileId: null }))).constraint).toBe('file_access_ticket_download_shape');
  });

  it.each([
    ['no media type', { mediaTypes: [] }],
    ['a media type outside the allow-list', { mediaTypes: ['application/pdf', 'text/html'] }],
    ['a NULL media type', { mediaTypes: ['application/pdf', null] }],
  ])('refuses an upload ticket with %s', async (_label, over) => {
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow(over))).constraint).toBe('file_access_ticket_media_types_allowed');
  });

  it('refuses an upload ticket without its intent, above the size ceiling, or from an issuer outside the caller grammar', async () => {
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ issuedBy: 'Drive!' }))).constraint).toBe('file_access_ticket_issued_by_shape');
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ maxBytes: null }))).constraint).toBe('file_access_ticket_upload_shape');
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ maxBytes: 104_857_601 }))).constraint).toBe('file_access_ticket_max_bytes_bounded');
    expect((await s.refusedInsert('file_access_ticket', uploadTicketRow({ disposition: 'inline' }))).constraint).toBe('file_access_ticket_upload_shape');
  });

  it('a ticket binds only a file of its issuer in its organization (org A never reaches a file of org B, a platform file never an org)', async () => {
    const orgA = randomUUID();
    const f = await availableFile({ organizationId: orgA });
    const platform = await availableFile();
    for (const [file, over] of [[f, { issuedBy: 'core-billing' }], [f, { organizationId: randomUUID() }], [f, { organizationId: null }], [platform, { organizationId: orgA }]] as const) {
      expect((await s.refusedInsert('file_access_ticket', downloadTicketRow(file, over))).message).toMatch(/not the issuer's in this organization/);
    }
    // An upload ticket records its created file once, and only a file of its issuer and organization.
    const [u] = await s.insert('file_access_ticket', uploadTicketRow({ organizationId: orgA }));
    expect((await s.refusedUpdate('file_access_ticket', u!.id, { fileId: platform.id })).message).toMatch(/not the issuer's in this organization/);
    await s.update('file_access_ticket', u!.id, { fileId: f.id });
    const other = await availableFile({ organizationId: orgA });
    expect((await s.refusedUpdate('file_access_ticket', u!.id, { fileId: other.id })).message).toMatch(/is set once/);
  });

  it('bindings and lifetime never change (no extension); revocation and first use are stamped once', async () => {
    const f = await availableFile();
    const [t] = await s.insert('file_access_ticket', downloadTicketRow(f));
    for (const [col, value] of [['expiresAt', new Date(Date.now() + 200_000)], ['operation', 'upload'], ['issuedBy', 'core-billing'], ['tokenDigest', sha()],
      ['singleUse', true], ['disposition', 'inline'], ['organizationId', randomUUID()]] as const) {
      expect((await s.refusedUpdate('file_access_ticket', t!.id, { [col]: value })).message, col).toMatch(/is immutable/);
    }
    await s.update('file_access_ticket', t!.id, { revokedAt: new Date(Date.now() + 1_000) });
    expect((await s.refusedUpdate('file_access_ticket', t!.id, { revokedAt: null })).message).toMatch(/is set once/);
  });

  it('uses count one at a time, only while the ticket is valid; a single-use ticket is used at most once', async () => {
    const f = await availableFile();
    const use = (id: unknown, n: number) => s.refusedUpdate('file_access_ticket', id, { useCount: n, usedAt: new Date() });
    const [single] = await s.insert('file_access_ticket', downloadTicketRow(f, { singleUse: true }));
    expect((await use(single!.id, 2)).message).toMatch(/one at a time/);
    await s.update('file_access_ticket', single!.id, { useCount: 1, usedAt: new Date() });
    expect((await s.refusedUpdate('file_access_ticket', single!.id, { useCount: 2 })).constraint).toBe('file_access_ticket_single_use_once');
    expect((await s.refusedUpdate('file_access_ticket', single!.id, { useCount: 0 })).message).toMatch(/one at a time/);
    const [revoked] = await s.insert('file_access_ticket', downloadTicketRow(f, { revokedAt: new Date(Date.now() + 1_000) }));
    expect((await use(revoked!.id, 1)).message).toMatch(/is not usable/);
    const past = new Date(Date.now() - 600_000);
    const [expired] = await s.insert('file_access_ticket', downloadTicketRow(f, { createdAt: past, expiresAt: new Date(past.getTime() + 120_000) }));
    expect((await use(expired!.id, 1)).message).toMatch(/is not usable/);
    expect((await s.refusedUpdate('file_access_ticket', expired!.id, { useCount: 1 })).message).toMatch(/is not usable|file_access_ticket_used_at_iff_used/);
  });

  it('expired ticket rows may be removed (retention, 17.7); the file they named stays', async () => {
    const f = await availableFile();
    const [t] = await s.insert('file_access_ticket', downloadTicketRow(f));
    await s.query('DELETE FROM file_access_ticket WHERE id = $1', [t!.id]);
    expect(await s.query('SELECT 1 FROM file WHERE id = $1', [f.id])).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------------------------ catalog properties

  it('no byte column, no JSON metadata backdoor, no product concept, no cross-service or cascading foreign key', async () => {
    const cols = await s.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('file', 'file_access_ticket')`);
    expect(cols.length).toBeGreaterThan(30);
    expect(cols.filter((c) => ['bytea', 'oid', 'json', 'jsonb'].includes(c.data_type))).toEqual([]);
    expect(cols.filter((c) => /student|instructor|lesson|exam|invoice|contract|school|driv|documenttype|version|metadata/i.test(c.column_name))).toEqual([]);
    const fks = await s.query<{ conname: string; src: string; target: string; ondelete: string }>(
      `SELECT conname, conrelid::regclass::text AS src, confrelid::regclass::text AS target, confdeltype AS ondelete FROM pg_constraint
       WHERE contype = 'f' AND conrelid::regclass::text IN ('file', 'file_access_ticket')`);
    expect(fks).toEqual([{ conname: 'file_access_ticket_file_fk', src: 'file_access_ticket', target: 'file', ondelete: 'a' }]); // NO ACTION
    const cascades = await s.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND (confdeltype = 'c' OR confupdtype = 'c')`);
    expect(cascades).toEqual([]);
    const shaUnique = await s.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'file' AND indexdef ~* 'UNIQUE.*sha256'`);
    expect(shaUnique).toEqual([]);
  });

  it('the critical lookups use their indexes (digest redemption, scoped file read, the sweeps)', async () => {
    await s.query(`INSERT INTO file (id, "ownerService", "organizationId", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline")
      SELECT g.id, 'core-drive', CASE WHEN g.n % 2 = 0 THEN gen_random_uuid() END, 'filesystem', 'files/' || g.id || '/' || md5(g.id::text),
             now() + interval '1 hour', now() + interval '1 day'
      FROM (SELECT gen_random_uuid() AS id, n FROM generate_series(1, 5000) n) g`);
    await s.query(`INSERT INTO file_access_ticket (id, operation, "issuedBy", "organizationId", "tokenDigest", "maxBytes", "mediaTypes", attach, "singleUse", "expiresAt")
      SELECT gen_random_uuid(), 'upload', 'core-drive', NULL, encode(sha256(n::text::bytea), 'hex'), 1024, ARRAY['application/pdf'], true, true, now() + interval '120 seconds'
      FROM generate_series(1, 5000) n`);
    await s.query('ANALYZE file');
    await s.query('ANALYZE file_access_ticket');
    const plan = async (q: string, p: unknown[] = []) => (await s.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${q}`, p)).map((r) => r['QUERY PLAN']).join('\n');
    expect(await plan(`SELECT * FROM file_access_ticket WHERE "tokenDigest" = $1 AND "revokedAt" IS NULL AND "expiresAt" > now()`, [sha()])).toMatch(/file_access_ticket_token_digest_unique/);
    expect(await plan(`SELECT * FROM file WHERE id = $1 AND "ownerService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3`, [randomUUID(), 'core-drive', null])).toMatch(/file_pkey/);
    expect(await plan(`SELECT id FROM file WHERE status = 'UPLOADING' AND "uploadExpiresAt" <= now() - interval '2 hours' ORDER BY "uploadExpiresAt" LIMIT 50`)).toMatch(/file_upload_lease_idx/);
    expect(await plan(`SELECT id FROM file_access_ticket WHERE "fileId" = $1 AND "revokedAt" IS NULL`, [randomUUID()])).toMatch(/file_access_ticket_file_idx/);
    expect(await plan(`SELECT id FROM file_access_ticket WHERE "expiresAt" < now() - interval '1 day' LIMIT 100`)).toMatch(/file_access_ticket_expiry_idx/);
  });
});
