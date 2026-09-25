/**
 * `originalName` sanitization (SDD §8, F14): presentation metadata only, never a path, never trusted, never logged.
 *
 * NFC; C0 / C1 controls, DEL, bidi embeddings / overrides / isolates (U+202A–202E, U+2066–2069), path separators and NUL removed;
 * surrounding whitespace trimmed; at most 255 UTF-8 bytes, truncated on a code-point boundary while keeping the extension; `.` / `..`
 * and names that become empty are dropped (`undefined`). Arabic, French and other Unicode names are kept.
 */
export const FILE_NAME_MAX_BYTES = 255;
// eslint-disable-next-line no-control-regex -- intentional: control characters are exactly what this removes
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/gu;

export function sanitizeFileName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw.normalize('NFC').replace(UNSAFE, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return undefined;
  if (Buffer.byteLength(cleaned, 'utf8') <= FILE_NAME_MAX_BYTES) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  const budget = FILE_NAME_MAX_BYTES - Buffer.byteLength(extension, 'utf8');
  let stem = '';
  for (const ch of dot > 0 && extension ? cleaned.slice(0, dot) : cleaned) {
    if (Buffer.byteLength(stem + ch, 'utf8') > budget) break;
    stem += ch;
  }
  const result = (stem + extension).normalize('NFC').trim();
  return result === '' || result === '.' || result === '..' ? undefined : result;
}

/**
 * The `X-File-Name` header: HTTP header values are Latin-1, so a Unicode name travels percent-encoded UTF-8 (as `encodeURIComponent`
 * produces). A malformed encoding is refused (`undefined` with `malformed: true`) rather than guessed.
 */
export function decodeFileNameHeader(header: string | undefined): { name?: string; malformed: boolean } {
  if (header === undefined || header === '') return { malformed: false };
  if (header.length > 3 * 1024) return { malformed: true };
  try {
    return { name: sanitizeFileName(decodeURIComponent(header)), malformed: false };
  } catch {
    return { malformed: true };
  }
}
