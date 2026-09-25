import { describe, expect, it } from 'vitest';
import { contentDisposition } from './content-disposition.js';

/** Built from code points so no invisible character is ever written literally in this source (see check:repo). */
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const HEADER_SAFE = /^[\x20-\x7e]+$/;

describe('Content-Disposition: one encoder, never an injection (RFC 6266 / 8187)', () => {
  it.each([
    ['ASCII', 'report.pdf', 'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf'],
    ['spaces', 'my scan 2026.pdf', 'attachment; filename="my scan 2026.pdf"; filename*=UTF-8\'\'my%20scan%202026.pdf'],
    ['a quote, and a backslash (removed like every path separator)', 'a"b\\c.pdf', 'attachment; filename="a_bc.pdf"; filename*=UTF-8\'\'a%22bc.pdf'],
    ['French accents', 'été-reçu.pdf', 'attachment; filename="_t_-re_u.pdf"; filename*=UTF-8\'\'%C3%A9t%C3%A9-re%C3%A7u.pdf'],
    ['Arabic', 'جواز.pdf', 'attachment; filename="____.pdf"; filename*=UTF-8\'\'%D8%AC%D9%88%D8%A7%D8%B2.pdf'],
  ])('%s', (_l, name, expected) => {
    expect(contentDisposition('attachment', name, 'application/pdf')).toBe(expected);
  });

  it('never lets CR, LF, NUL, other controls or bidi controls reach the header', () => {
    for (const name of [`a\r\nSet-Cookie: x=1.pdf`, `a${cp(0)}b.pdf`, `inv${cp(0x202e)}fdp.exe`, `x${cp(0x2066)}y${cp(0x2069)}.pdf`, `a${cp(0x85)}b.pdf`, `a${cp(0x1b)}[31m.pdf`]) {
      const header = contentDisposition('attachment', name, 'application/pdf');
      expect(header, JSON.stringify(name)).toMatch(HEADER_SAFE);
      expect(header).not.toMatch(/[\r\n]/);
      expect(header.split(';')).toHaveLength(3); // no injected parameter
    }
    expect(contentDisposition('attachment', 'a\r\nSet-Cookie: x=1.pdf', 'application/pdf')).toBe('attachment; filename="aSet-Cookie: x=1.pdf"; filename*=UTF-8\'\'aSet-Cookie%3A%20x%3D1.pdf');
  });

  it('a very long Unicode name stays one header-safe line (the stored name is at most 255 bytes)', () => {
    const header = contentDisposition('attachment', `${'ع'.repeat(120)}.pdf`, 'application/pdf');
    expect(header).toMatch(HEADER_SAFE);
    expect(header.length).toBeLessThan(1_000);
  });

  it('falls back to file.<ext> for a missing or empty name; inline only as asked', () => {
    expect(contentDisposition('attachment', null, 'image/png')).toBe('attachment; filename="file.png"; filename*=UTF-8\'\'file.png');
    expect(contentDisposition('inline', cp(0x202e), 'image/jpeg')).toBe('inline; filename="file.jpg"; filename*=UTF-8\'\'file.jpg');
    expect(contentDisposition('attachment', '..', 'image/heic')).toBe('attachment; filename="file.heic"; filename*=UTF-8\'\'file.heic');
  });
});
