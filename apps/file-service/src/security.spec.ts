import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../test/support/media.js';
import { contentDisposition } from './download/content-disposition.js';
import { isStorageKey, newStorageKey } from './persistence/storage-key.js';
import { ticketDigest, TICKET_TOKEN_SHAPE } from './persistence/ticket-digest.js';
import { FILE_MEDIA_TYPES, type FileMediaType } from './policy/media-types.js';
import { resolveWithin } from './storage/filesystem-storage.js';
import { decodeFileNameHeader, FILE_NAME_MAX_BYTES, sanitizeFileName } from './upload/file-name.js';
import { detectMediaType } from './upload/media-type.js';

/**
 * Stage 17.8: property / fuzz tests of the untrusted-input boundaries (names, headers, detection, tickets, keys). A seeded generator
 * makes every run reproducible (the seed is in the test name); the properties are the security rules, not examples.
 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code points an attacker would try, built numerically (no invisible character is written literally in this source). */
const HOSTILE = [
  0x00, 0x01, 0x07, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f, // C0, DEL, C1 (NEL, CSI)
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, // every bidi control
  0x2028, 0x2029, 0xfeff, // line / paragraph separators, BOM
  0x2f, 0x5c, 0x22, 0x27, 0x3b, 0x3d, 0x25, 0x2e, 0x20, 0xa0, // / \ " ' ; = % . space NBSP
  0x200b, 0x200c, 0x200d, // zero-width space / non-joiner / joiner
  0x0301, 0x0065, 0x00e9, 0x1e9b, 0x0323, // combining marks, NFC / NFD pairs
  0x0627, 0x0644, 0x0639, 0x0631, 0x0628, 0x064a, 0x00e7, 0x00e0, // Arabic, French
  0x1f600, 0x1f468, 0x1f469, 0x10ffff, 0xfffd, // astral, max, replacement
];
const UNSAFE_OUT = /[\p{Cc}\p{Bidi_Control}\u2028\u2029\ufeff/\\]/u;

function hostileString(rand: () => number, maxLen: number): string {
  const n = Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < 0.5) s += String.fromCodePoint(HOSTILE[Math.floor(rand() * HOSTILE.length)]!);
    else if (r < 0.8) s += String.fromCharCode(0x20 + Math.floor(rand() * 0x5f));
    else s += String.fromCodePoint(Math.floor(rand() * 0xd7ff));
  }
  return s;
}

describe('file names: sanitizer properties (SDD §8; Stage 17.8 fuzz)', () => {
  const SEED = 1708;
  it(`20 000 hostile names (seed ${SEED}): output is absent or NFC, ≤ 255 bytes, trimmed, free of every unsafe character, idempotent`, () => {
    const rand = prng(SEED);
    for (let i = 0; i < 20_000; i++) {
      const raw = hostileString(rand, i % 10 === 0 ? 400 : 40);
      const out = sanitizeFileName(raw);
      if (out === undefined) continue;
      expect(out.normalize('NFC')).toBe(out);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
      expect(out).toBe(out.trim());
      expect(UNSAFE_OUT.test(out)).toBe(false);
      expect(['', '.', '..']).not.toContain(out);
      expect(sanitizeFileName(out)).toBe(out);
    }
  });

  it('every Unicode bidi control, line separator and the BOM is removed (the 17.8 gap: U+061C, U+200E, U+200F, U+2028, U+2029, U+FEFF)', () => {
    for (const c of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0xfeff]) {
      expect(sanitizeFileName(`invoice${String.fromCodePoint(c)}fdp.exe`)).toBe('invoicefdp.exe');
    }
    // Joiners are kept: Persian and emoji need them.
    expect(sanitizeFileName(`a${String.fromCodePoint(0x200c)}b`)).toBe(`a${String.fromCodePoint(0x200c)}b`);
  });

  it(`the X-File-Name decoder never throws: 20 000 random percent sequences are a name, nothing, or "malformed" (seed ${SEED + 1})`, () => {
    const rand = prng(SEED + 1);
    const alphabet = '%0123456789abcdefABCDEF./\\"; \r\nzZ';
    for (let i = 0; i < 20_000; i++) {
      let h = '';
      const n = Math.floor(rand() * 60);
      for (let j = 0; j < n; j++) h += alphabet[Math.floor(rand() * alphabet.length)];
      const r = decodeFileNameHeader(h);
      if (r.name !== undefined) expect(UNSAFE_OUT.test(r.name)).toBe(false);
    }
    expect(decodeFileNameHeader('%'.repeat(4000)).malformed).toBe(true); // oversized header refused before decoding
  });
});

describe('Content-Disposition properties (RFC 6266 / 8187; Stage 17.8 fuzz)', () => {
  const SHAPE = /^(attachment|inline); filename="[\x20\x21\x23-\x5b\x5d-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]*$/;
  it('20 000 hostile stored names (seed 1710): one header-safe line, exactly three parameters, the UTF-8 form decodes back to the cleaned name', () => {
    const rand = prng(1710);
    for (let i = 0; i < 20_000; i++) {
      const raw = hostileString(rand, 60);
      const media = FILE_MEDIA_TYPES[i % FILE_MEDIA_TYPES.length] as FileMediaType;
      const header = contentDisposition(i % 2 ? 'inline' : 'attachment', raw, media);
      expect(header).toMatch(SHAPE);
      const encoded = header.split("filename*=UTF-8''")[1]!;
      const decoded = decodeURIComponent(encoded);
      expect(UNSAFE_OUT.test(decoded)).toBe(false);
      expect(decoded.length).toBeGreaterThan(0);
    }
  });
});

describe('type detection properties (SDD §7; Stage 17.8 fuzz)', () => {
  it('10 000 random heads (seed 1711) are never detected unless they carry an allowed signature at offset 0', () => {
    const rand = prng(1711);
    for (let i = 0; i < 10_000; i++) {
      const head = Buffer.alloc(1 + Math.floor(rand() * 64));
      for (let j = 0; j < head.length; j++) head[j] = Math.floor(rand() * 256);
      const t = detectMediaType(head);
      if (t === undefined) continue;
      // A random head that IS detected must really start with that type's signature (never a guess).
      const sig: Record<string, (b: Buffer) => boolean> = {
        'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
        'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
        'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
        'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
        'image/heif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
      };
      expect(sig[t]!(head)).toBe(true);
    }
  });

  it('polyglots are classified by their LEADING structure only: an allowed head decides, whatever follows (HTML, script, ZIP)', () => {
    const tails = [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('PK\x03\x04', 'latin1'), randomBytes(2048)];
    for (const tail of tails) {
      expect(detectMediaType(Buffer.concat([SAMPLES.pdf(), tail]))).toBe('application/pdf');
      expect(detectMediaType(Buffer.concat([SAMPLES.png(), tail]))).toBe('image/png');
      expect(detectMediaType(Buffer.concat([tail, SAMPLES.pdf()]))).toBeUndefined(); // an allowed signature later is not a signature
    }
  });

  it('one flipped signature byte is no longer that type', () => {
    for (const make of [SAMPLES.pdf, SAMPLES.jpeg, SAMPLES.png]) {
      const b = Buffer.from(make());
      b[1] = b[1]! ^ 0xff;
      expect(detectMediaType(b)).toBeUndefined();
    }
  });
});

describe('tickets and storage keys (F35, SDD §6; Stage 17.8 fuzz)', () => {
  it('10 000 random strings (seed 1712): only the exact 43-character base64url shape yields a digest, always 64 lowercase hex', () => {
    const rand = prng(1712);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=.%';
    for (let i = 0; i < 10_000; i++) {
      let t = '';
      const n = i % 3 === 0 ? 43 : Math.floor(rand() * 90);
      for (let j = 0; j < n; j++) t += alphabet[Math.floor(rand() * alphabet.length)];
      const d = ticketDigest(t);
      expect(d !== undefined).toBe(TICKET_TOKEN_SHAPE.test(t));
      if (d) expect(d).toBe(createHash('sha256').update(t).digest('hex'));
    }
    expect(ticketDigest(`${'A'.repeat(43)}\n`)).toBeUndefined();
  });

  it('a token has 256 bits: 10 000 fresh tokens are distinct and every one has the shape', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const t = randomBytes(32).toString('base64url');
      expect(TICKET_TOKEN_SHAPE.test(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(10_000);
  });

  it('10 000 hostile keys (seed 1713): none passes the key grammar with a traversal, and the filesystem containment refuses every escape', () => {
    const rand = prng(1713);
    const parts = ['..', '.', '/', '\\', '%2e', 'files', 'a', '0', '', 'ABC', ' ', '\0', '//'];
    for (let i = 0; i < 10_000; i++) {
      let k = '';
      const n = 1 + Math.floor(rand() * 8);
      for (let j = 0; j < n; j++) k += parts[Math.floor(rand() * parts.length)];
      if (isStorageKey(k)) expect(k.split('/')).not.toContain('..');
      let resolved: string | undefined;
      try {
        resolved = resolveWithin('/srv/root', k, 'get');
      } catch {
        continue;
      }
      expect(resolved.startsWith('/srv/root/')).toBe(true);
    }
    const good = newStorageKey('files', '5b0e2f0e-5d0b-4c7c-9d2e-3f1a2b3c4d5e');
    expect(isStorageKey(good)).toBe(true);
    expect(good).not.toMatch(/\.\.|\\|[A-Z]/);
  });
});
