import type { FileMediaType } from '../policy/media-types.js';

const EXTENSION: Record<FileMediaType, string> = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
};

/** Characters RFC 8187 lets through unencoded in `filename*` (attr-char); everything else is percent-encoded UTF-8. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/** Anything that must never reach a header line, even from a stored (already sanitized) name: controls, bidi, separators, NUL. */
// eslint-disable-next-line no-control-regex -- intentional: control characters are exactly what this removes
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\]/gu;

/**
 * `Content-Disposition` built by ONE encoder (SDD §8, §9; RFC 6266 / RFC 8187):
 *
 *   <attachment|inline>; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded UTF-8>
 *
 * The stored name is untrusted presentation metadata: it is re-cleaned here (defence in depth, the stored value is untouched), the
 * ASCII fallback keeps only printable ASCII without `"` and `\` (others become `_`), and the UTF-8 form is percent-encoded byte by
 * byte, so no quote, CR, LF or control character can ever reach the header. A missing or empty name falls back to `file.<ext>`.
 */
export function contentDisposition(disposition: 'attachment' | 'inline', originalName: string | null, mediaType: FileMediaType): string {
  const fallbackName = `file.${EXTENSION[mediaType]}`;
  const clean = (originalName ?? '').normalize('NFC').replace(UNSAFE, '').trim();
  const name = clean === '' || clean === '.' || clean === '..' ? fallbackName : clean;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, '_'); // one `_` per code point outside printable ASCII, and for `"` and `\`
  const encoded = [...Buffer.from(name, 'utf8')].map((b) => {
    const ch = String.fromCharCode(b);
    return b < 0x80 && ATTR_CHAR.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
