/**
 * `originalName` sanitization (SDD §8, F14): presentation metadata only, never a path, never trusted, never logged.
 *
 * NFC; C0 / C1 controls, DEL, EVERY Unicode bidi control (the `Bidi_Control` property: embeddings / overrides U+202A–202E, isolates
 * U+2066–2069 and, since Stage 17.8, the marks U+061C, U+200E, U+200F), the line / paragraph separators U+2028 / U+2029, the BOM
 * U+FEFF, path separators and NUL removed (ZWJ / ZWNJ stay: scripts and emoji need them);
 * surrounding whitespace trimmed; at most 255 UTF-8 bytes, truncated on a code-point boundary while keeping the extension; `.` / `..`
 * and names that become empty are dropped (`undefined`). Arabic, French and other Unicode names are kept.
 */
export const FILE_NAME_MAX_BYTES = 255;
// eslint-disable-next-line no-control-regex -- intentional: control characters are exactly what this removes
const UNSAFE = /[\p{Cc}\p{Bidi_Control}\u2028\u2029\ufeff/\\]/gu;

export function sanitizeFileName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Remove first, THEN normalize (Stage 17.8 fuzz finding): removing a control between a letter and a combining mark would otherwise
  // leave a non-NFC name, which the schema refuses (an opaque 500 for a merely hostile name).
  const cleaned = raw.replace(UNSAFE, '').normalize('NFC').trim();
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
