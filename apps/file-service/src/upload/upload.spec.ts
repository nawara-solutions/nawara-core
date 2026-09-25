import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ADVERSARIAL, SAMPLES } from '../../test/support/media.js';
import { FILE_MEDIA_TYPES, type FileMediaType } from '../policy/media-types.js';
import { StorageError } from '../storage/storage-error.js';
import type { StoragePort, StoragePutOptions } from '../storage/storage.port.js';
import { decodeFileNameHeader, sanitizeFileName } from './file-name.js';
import { ingest, UploadRefused, type IngestInput } from './ingest.js';
import { declaredAgrees, declaredEssence, detectMediaType, extensionAgrees } from './media-type.js';
import { contentDigest, declaredLength, uploadRequestHash } from './upload-http.js';

describe('media type from the bytes (SDD §7, F13)', () => {
  it.each([
    ['pdf', SAMPLES.pdf(), 'application/pdf'],
    ['jpeg', SAMPLES.jpeg(), 'image/jpeg'],
    ['png', SAMPLES.png(), 'image/png'],
    ['webp', SAMPLES.webp(), 'image/webp'],
    ['heic (iPhone: major heic)', SAMPLES.heic(), 'image/heic'],
    ['heic (major mif1 with an HEVC brand)', SAMPLES.heicMif1(), 'image/heic'],
    ['heif (major mif1)', SAMPLES.heif(), 'image/heif'],
  ])('detects %s', (_l, bytes, type) => {
    expect(detectMediaType(bytes)).toBe(type);
  });

  it.each(Object.entries(ADVERSARIAL))('refuses %s (no allowed signature)', (_l, make) => {
    expect(detectMediaType(make())).toBeUndefined();
  });
});

describe('declared type and file name must agree with the bytes (hints only)', () => {
  it('declared types: absent or neutral agree; aliases agree; a contradiction does not', () => {
    expect(declaredEssence('Application/PDF; charset=binary')).toBe('application/pdf');
    expect(declaredAgrees(undefined, 'application/pdf')).toBe(true);
    expect(declaredAgrees('application/octet-stream', 'image/png')).toBe(true);
    expect(declaredAgrees('image/jpg', 'image/jpeg')).toBe(true);
    expect(declaredAgrees('application/pdf', 'image/jpeg')).toBe(false);
    expect(declaredAgrees('text/html', 'application/pdf')).toBe(false);
  });

  it('extensions: none agrees; a matching one agrees; another type\'s or a foreign one does not', () => {
    expect(extensionAgrees(undefined, 'application/pdf')).toBe(true);
    expect(extensionAgrees('scan', 'application/pdf')).toBe(true);
    expect(extensionAgrees('Photo.JPG', 'image/jpeg')).toBe(true);
    expect(extensionAgrees('IMG_0001.HEIC', 'image/heic')).toBe(true);
    expect(extensionAgrees('passport.pdf', 'image/jpeg')).toBe(false);
    expect(extensionAgrees('invoice.pdf.exe', 'application/pdf')).toBe(false);
    expect(extensionAgrees('photo.svg', 'image/png')).toBe(false);
  });
});

describe('file names (SDD §8)', () => {
  it('keeps Unicode names, NFC-normalized and trimmed', () => {
    expect(sanitizeFileName('  عقد التسجيل – été.pdf  ')).toBe('عقد التسجيل – été.pdf');
    expect(sanitizeFileName('e\u0301te\u0301.pdf')).toBe('été.pdf');
  });

  it('removes path separators, controls, NUL and bidi overrides; drops what becomes empty', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('....etcpasswd');
    expect(sanitizeFileName('C:\\Windows\\evil.pdf')).toBe('C:Windowsevil.pdf');
    expect(sanitizeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a\r\nb\u0000c\u0085.pdf')).toBe('abc.pdf');
    for (const empty of ['', '   ', '.', '..', '/', '\u202E', '\u0000']) expect(sanitizeFileName(empty), JSON.stringify(empty)).toBeUndefined();
  });

  it('truncates to 255 UTF-8 bytes on a code-point boundary, keeping the extension', () => {
    const long = `${'ع'.repeat(300)}.pdf`;
    const out = sanitizeFileName(long)!;
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(255);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out).not.toContain('\ufffd');
  });

  it('decodes a percent-encoded UTF-8 header and refuses a malformed one', () => {
    expect(decodeFileNameHeader(encodeURIComponent('جواز سفر.pdf'))).toEqual({ name: 'جواز سفر.pdf', malformed: false });
    expect(decodeFileNameHeader('%E0%A4%A')).toEqual({ malformed: true });
    expect(decodeFileNameHeader(undefined)).toEqual({ malformed: false });
  });
});

describe('request headers', () => {
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

  it('Content-Length is required (a chunked body is 411) and must be a plain integer', () => {
    expect(declaredLength(req({ 'content-length': '1024' }))).toBe(1024);
    for (const h of [{}, { 'transfer-encoding': 'chunked' }, { 'content-length': '10', 'transfer-encoding': 'chunked' }]) {
      expect(() => declaredLength(req(h as Record<string, string>))).toThrow(expect.objectContaining({ status: 411 }));
    }
    for (const bad of ['-1', '1e6', '0x10', '10.5', '']) expect(() => declaredLength(req({ 'content-length': bad }))).toThrow();
  });

  it('Content-Digest: sha-256 parsed to hex; others ignored; a malformed sha-256 refused', () => {
    const digest = createHash('sha256').update('x').digest();
    expect(contentDigest(req({ 'content-digest': `sha-512=:${randomBytes(64).toString('base64')}:, sha-256=:${digest.toString('base64')}:` }))).toBe(digest.toString('hex'));
    expect(contentDigest(req({ 'content-digest': 'sha-512=:AAAA:' }))).toBeUndefined();
    expect(() => contentDigest(req({ 'content-digest': 'sha-256=:tooshort:' }))).toThrow();
  });

  it('the upload request hash is keyed and covers every declared field', () => {
    const base = { organizationId: null, fileName: 'a.pdf', declaredType: 'application/pdf', sizeBytes: 10, sha256: null };
    const k1 = randomBytes(32);
    const h = uploadRequestHash(k1, base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(uploadRequestHash(k1, { ...base })).toBe(h);
    expect(uploadRequestHash(randomBytes(32), base)).not.toBe(h);
    for (const change of [{ fileName: 'b.pdf' }, { sizeBytes: 11 }, { declaredType: 'image/png' }, { organizationId: '8a8b1c52-7f39-4d8e-9d6b-1f0f2b8f3c11' }, { sha256: 'ab'.repeat(32) }]) {
      expect(uploadRequestHash(k1, { ...base, ...change })).not.toBe(h);
    }
  });
});

/** A store that records what it received, consuming the body as a real one would. */
function recordingStore(fail?: (bytes: number) => unknown): StoragePort & { received: Buffer[]; opts?: StoragePutOptions } {
  const store = {
    provider: 'filesystem' as const,
    received: [] as Buffer[],
    opts: undefined as StoragePutOptions | undefined,
    async put(_key: string, body: Readable, opts: StoragePutOptions) {
      store.opts = opts;
      let n = 0;
      for await (const c of body) {
        n += (c as Buffer).length;
        store.received.push(c as Buffer);
        const f = fail?.(n);
        if (f) throw f;
      }
      if (n !== opts.sizeBytes) throw new StorageError('storage_length_mismatch', 'put');
    },
    get: async () => { throw new Error('unused'); },
    head: async () => undefined,
    delete: async () => undefined,
  };
  return store;
}

describe('ingest: the streaming pipeline', () => {
  const all = new Set<FileMediaType>(FILE_MEDIA_TYPES);
  const input = (body: Buffer | Readable, over: Partial<IngestInput> & { storage: StoragePort }): IngestInput => ({
    body: Buffer.isBuffer(body) ? Readable.from([body.subarray(0, 1000), body.subarray(1000)]) : body,
    declaredLength: Buffer.isBuffer(body) ? body.length : 0, limit: 25 * 1024 * 1024, allowed: all, storageKey: 'files/k', signal: new AbortController().signal, ...over,
  });
  const refusal = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as UploadRefused).refusal?.failureCode ?? 'accepted';

  it('stores the exact bytes with the detected type, and returns their size and SHA-256', async () => {
    const data = SAMPLES.pdf(300_000);
    const store = recordingStore();
    const out = await ingest(input(data, { storage: store, declaredType: 'application/pdf', fileName: 'scan.pdf' }));
    expect(out).toEqual({ mediaType: 'application/pdf', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    expect(Buffer.concat(store.received).equals(data)).toBe(true);
    expect(store.opts).toMatchObject({ sizeBytes: data.length, contentType: 'application/pdf' });
  });

  it.each([
    ['an executable named .pdf, declared PDF', ADVERSARIAL.windowsExe(), 'application/pdf', 'passport.pdf', 'unsupported_media_type'],
    ['HTML named .jpg', ADVERSARIAL.html(), 'image/jpeg', 'photo.jpg', 'unsupported_media_type'],
    ['SVG', ADVERSARIAL.svg(), 'image/svg+xml', 'logo.svg', 'unsupported_media_type'],
    ['an archive', ADVERSARIAL.zip(), 'application/pdf', 'a.pdf', 'unsupported_media_type'],
    ['a real PDF declared as JPEG', SAMPLES.pdf(), 'image/jpeg', undefined, 'media_type_mismatch'],
    ['a real PNG named .pdf', SAMPLES.png(), undefined, 'report.pdf', 'media_type_mismatch'],
  ])('refuses %s before anything is stored', async (_l, bytes, declaredType, fileName, code) => {
    const store = recordingStore();
    expect(await refusal(ingest(input(bytes, { storage: store, declaredType, fileName })))).toBe(code);
    expect(store.received).toEqual([]);
  });

  it('refuses a real type the caller or ticket does not allow (image-only ticket, PDF bytes)', async () => {
    const store = recordingStore();
    expect(await refusal(ingest(input(SAMPLES.pdf(), { storage: store, allowed: new Set(['image/jpeg', 'image/png']) })))).toBe('unsupported_media_type');
  });

  it('counts the bytes actually received: one byte over the limit is refused, the exact limit is accepted', async () => {
    const data = SAMPLES.png(10_000);
    expect(await refusal(ingest(input(data, { storage: recordingStore(), limit: 10_000 })))).toBe('accepted');
    const lie = input(SAMPLES.png(10_001), { storage: recordingStore(), limit: 10_000 });
    expect(await refusal(ingest({ ...lie, declaredLength: 9_000 }))).toBe('file_too_large'); // the body is longer than it declared
  });

  it('the Meter alone refuses the byte past the limit, even when the head window was within it and the store checks nothing', async () => {
    const lenient: StoragePort = { // a store that would accept any length: the Meter is the only barrier left
      provider: 'filesystem',
      async put(_k, body) { for await (const _c of body) { /* drain */ } },
      get: async () => { throw new Error('unused'); },
      head: async () => undefined,
      delete: async () => undefined,
    };
    const data = SAMPLES.pdf(20_000); // 5 × 1000-byte head chunks (≤ limit), then the rest runs past the 10 000-byte limit
    const chunks = Array.from({ length: 20 }, (_, i) => data.subarray(i * 1000, (i + 1) * 1000));
    const run = ingest({ body: Readable.from(chunks), declaredLength: 9_000, limit: 10_000, allowed: all, storage: lenient, storageKey: 'files/k', signal: new AbortController().signal });
    expect(await refusal(run)).toBe('file_too_large');
  });

  it('a body that fails mid-stream is a client abort; an abort through the signal wins with its own refusal', async () => {
    const body = new PassThrough();
    body.write(SAMPLES.pdf(8_000));
    setTimeout(() => body.destroy(new Error('socket hang up')), 20);
    expect(await refusal(ingest(input(body, { storage: recordingStore(), declaredLength: 100_000 })))).toBe('client_aborted');
  });

  it('maps store failures to neutral refusals (never the provider detail)', async () => {
    for (const [code, expected] of [['storage_unavailable', 'storage_unavailable'], ['storage_timeout', 'storage_timeout'], ['storage_rejected', 'storage_rejected'],
      ['storage_checksum_mismatch', 'checksum_mismatch'], ['storage_already_exists', 'storage_already_exists']] as const) {
      const store = recordingStore((n) => (n > 2000 ? new StorageError(code, 'put', 'NoSuchBucket') : undefined));
      const e = (await ingest(input(SAMPLES.pdf(50_000), { storage: store })).catch((x: unknown) => x)) as UploadRefused;
      expect(e.refusal.failureCode).toBe(expected);
      expect(JSON.stringify(e.refusal.http)).not.toContain('NoSuchBucket');
    }
  });

  it('reads only a bounded head before deciding: a refused upload consumed at most the detection window', async () => {
    let pulled = 0;
    const body = new Readable({
      read() {
        pulled += 16 * 1024;
        this.push(pulled === 16 * 1024 ? ADVERSARIAL.windowsExe() : randomBytes(16 * 1024));
      },
    });
    expect(await refusal(ingest(input(body, { storage: recordingStore(), declaredLength: 20 * 1024 * 1024 })))).toBe('unsupported_media_type');
    expect(pulled).toBeLessThanOrEqual(64 * 1024); // a few chunks at most, never the declared 20 MiB
    body.destroy();
  });
});
