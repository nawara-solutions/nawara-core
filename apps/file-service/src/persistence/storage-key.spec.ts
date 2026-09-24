import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isStorageKey, newStorageKey, STORAGE_KEY_GRAMMAR } from './storage-key.js';

describe('storage keys (SDD §6, F30)', () => {
  const id = randomUUID();

  it('is `<prefix>/<fileId>/<32 hex>`, in the adapter grammar, and different every time', () => {
    const a = newStorageKey('files', id);
    const b = newStorageKey('files', id);
    expect(a).toMatch(new RegExp(`^files/${id}/[0-9a-f]{32}$`));
    expect(a).not.toBe(b); // random part: unique even for the same file id and prefix
    expect(STORAGE_KEY_GRAMMAR.test(a)).toBe(true);
    expect(isStorageKey(a)).toBe(true);
    expect(isStorageKey(newStorageKey('tenant-a/prod', id))).toBe(true);
  });

  it.each(['', '/files', 'files/', 'files//x', '../files', 'files/..', 'Files', 'files.pdf', 'files x', 'a'.repeat(131)])('refuses the prefix %j', (prefix) => {
    expect(() => newStorageKey(prefix, id)).toThrow(/prefix/);
  });

  it.each(['passport.pdf', '../../etc/passwd', id.toUpperCase(), `${id}/x`, ''])('refuses %j as a file id (a key is never built from caller input)', (fileId) => {
    expect(() => newStorageKey('files', fileId)).toThrow(/file id/);
  });

  it('the longest allowed prefix still fits the 200-character grammar', () => {
    const key = newStorageKey('a'.repeat(130), id);
    expect(key.length).toBeLessThanOrEqual(200);
    expect(isStorageKey(key)).toBe(true);
  });

  it.each([`files/${id}`, `files/${id}/abc`, `files/${id}/${'g'.repeat(32)}`, `files/../${id}/${'a'.repeat(32)}`, `/files/${id}/${'a'.repeat(32)}`])(
    'recognizes %j as not a key this service generates', (key) => {
      expect(isStorageKey(key)).toBe(false);
    });
});
