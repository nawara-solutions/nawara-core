import type { FileMediaType } from '../policy/media-types.js';

/**
 * Stage 17.5: the media type of an upload is decided from its FIRST BYTES (SDD §7, F13), never from the declared `Content-Type` or
 * the filename. An explicit ALLOW-LIST of signatures, one per V1 type: anything that is not positively one of them is refused. No
 * general-purpose detector parses untrusted input here (none is needed to refuse an executable, an archive, HTML or SVG: they simply
 * match no allowed signature).
 *
 * This is SIGNATURE validation: it proves a file starts like a PDF / JPEG / PNG / WebP / HEIC / HEIF, not that it is well formed or
 * harmless. It is not a malware scanner (F19, deferred) and does not detect polyglots whose prefix is a valid allowed signature.
 */

/** The bytes read before deciding: enough for every signature, including an ISO-BMFF `ftyp` box with its brand list. */
export const DETECTION_WINDOW_BYTES = 4096;

/** HEIF brands (ISO/IEC 23008-12) that are HEVC-coded still images: `image/heic`. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis']);
/** Image-sequence and non-HEVC brands we do NOT accept (image/heic-sequence, image/heif-sequence, AVIF, video). */
const REFUSED_BRANDS = new Set(['hevc', 'hevx', 'hevm', 'hevs', 'msf1', 'avif', 'avis', 'avio']);

function startsWith(head: Buffer, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

const ascii = (head: Buffer, start: number, end: number) => head.subarray(start, end).toString('latin1');

/**
 * The HEIF family, from the leading `ftyp` box (ISO/IEC 14496-12): `size(4) 'ftyp' major(4) minor(4) compatible(4)*`. The box must be
 * the first box, complete within the window, sanely sized, with 4-byte-aligned brands.
 */
function heif(head: Buffer): FileMediaType | undefined {
  if (head.length < 16 || ascii(head, 4, 8) !== 'ftyp') return undefined;
  const size = head.readUInt32BE(0);
  if (size < 16 || size > DETECTION_WINDOW_BYTES || size > head.length || (size - 16) % 4 !== 0) return undefined;
  const major = ascii(head, 8, 12);
  const compatible: string[] = [];
  for (let at = 16; at < size; at += 4) compatible.push(ascii(head, at, at + 4));
  const brands = [major, ...compatible];
  if (brands.some((b) => REFUSED_BRANDS.has(b)) && !HEIC_BRANDS.has(major)) return undefined; // AVIF / sequences / video
  if (HEIC_BRANDS.has(major)) return 'image/heic';
  if (major === 'mif1') return compatible.some((b) => HEIC_BRANDS.has(b)) ? 'image/heic' : 'image/heif';
  return undefined; // mp4, quicktime, 3gp, … : an ftyp box, but not an allowed image
}

/** The allowed V1 type the bytes start as, or `undefined` (refused: `unsupported_media_type`). */
export function detectMediaType(head: Buffer): FileMediaType | undefined {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // "%PDF-" at offset 0 (strict: no leading junk)
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'; // SOI + a marker
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'; // the full 8-byte PNG signature
  if (ascii(head, 0, 4) === 'RIFF' && head.length >= 16 && ascii(head, 8, 12) === 'WEBP' && /^VP8[ LX]$/.test(ascii(head, 12, 16))) return 'image/webp';
  return heif(head);
}

/** Filename extensions that agree with each detected type (a hint that must not contradict the bytes, SDD §7). */
const EXTENSIONS: Record<FileMediaType, readonly string[]> = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic', 'heif', 'hif'],
  'image/heif': ['heif', 'heic', 'hif'],
};

/** Declared `Content-Type` values that agree with each detected type (aliases seen in the wild included). */
const DECLARED: Record<FileMediaType, readonly string[]> = {
  'application/pdf': ['application/pdf', 'application/x-pdf'],
  'image/jpeg': ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  'image/png': ['image/png', 'image/x-png'],
  'image/webp': ['image/webp'],
  'image/heic': ['image/heic', 'image/heif'],
  'image/heif': ['image/heif', 'image/heic'],
};

/** Declarations that assert nothing about the content (a client that does not know): accepted with any detected type. */
const NEUTRAL_DECLARATIONS = new Set(['application/octet-stream', 'binary/octet-stream']);

/** The media-type essence of a `Content-Type` header (lowercase, parameters dropped), or `undefined` when absent. */
export function declaredEssence(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const essence = header.split(';', 1)[0]!.trim().toLowerCase();
  return essence === '' ? undefined : essence;
}

/** Does a declared type agree with the detected one? (absent or neutral declarations agree) */
export function declaredAgrees(essence: string | undefined, detected: FileMediaType): boolean {
  return essence === undefined || NEUTRAL_DECLARATIONS.has(essence) || DECLARED[detected].includes(essence);
}

/** Does the filename's extension agree with the detected type? (no name, or a name without an extension, agrees) */
export function extensionAgrees(name: string | undefined, detected: FileMediaType): boolean {
  if (!name) return true;
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return true;
  return EXTENSIONS[detected].includes(name.slice(dot + 1).toLowerCase());
}
