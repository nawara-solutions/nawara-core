import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, decodePreciseCursor, encodeCursor, encodePreciseCursor, parseLimit, toPage, toPrecisePage } from './pagination.js';

const row = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)) });

describe('parseLimit', () => {
  it('defaults when absent and accepts 1 to the maximum', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
    expect(parseLimit(50)).toBe(50);
  });

  it.each(['0', '-1', '101', '1.5', 'abc', '1e2', ' 5', '5 ', '9999999', NaN, Infinity, {}])('refuses %j with a 400 (never clamps)', (raw) => {
    expect(() => parseLimit(raw)).toThrow(BadRequestException);
  });
});

describe('cursor', () => {
  it('round-trips a position exactly', () => {
    const r = row(7);
    expect(decodeCursor(encodeCursor(r))).toEqual(r);
  });

  it.each([
    ['not base64url', '!!!'],
    ['empty', ''],
    ['oversized', 'A'.repeat(257)],
    ['valid base64url, not JSON', Buffer.from('nope').toString('base64url')],
    ['JSON without the fields', Buffer.from('{}').toString('base64url')],
    ['a non-uuid id (injection attempt)', Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', i: "x' OR 1=1 --" })).toString('base64url')],
    ['a non-canonical date', Buffer.from(JSON.stringify({ t: '2026-13-45', i: '00000000-0000-4000-8000-000000000001' })).toString('base64url')],
    ['a number for the id', Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00.000Z', i: 5 })).toString('base64url')],
  ])('refuses %s with a 400', (_label, raw) => {
    expect(() => decodeCursor(raw)).toThrow(BadRequestException);
  });
});

describe('toPage', () => {
  it('has no next page when the rows fit in the limit (exactly the limit, or fewer)', () => {
    expect(toPage([row(1), row(2)], 2)).toEqual({ items: [row(1), row(2)], nextCursor: null });
    expect(toPage([], 5)).toEqual({ items: [], nextCursor: null });
  });

  it('returns only `limit` items and a cursor at the LAST returned item when one more row exists', () => {
    const page = toPage([row(3), row(2), row(1)], 2);
    expect(page.items).toEqual([row(3), row(2)]);
    expect(decodeCursor(page.nextCursor as string)).toEqual(row(2));
  });
});

describe('F-INV-1: the precise cursor (microseconds, as PostgreSQL wrote them)', () => {
  const id = '00000000-0000-4000-8000-000000000007';
  const raw = (t: unknown, i: unknown = id) => Buffer.from(JSON.stringify({ t, i })).toString('base64url');

  it('round-trips a microsecond position exactly, as text (never through a Date)', () => {
    const at = '2026-11-01T10:00:00.123456Z';
    expect(decodePreciseCursor(encodePreciseCursor({ at, id }))).toEqual({ at, id });
  });

  it('accepts a millisecond cursor issued before F-INV-1, unchanged', () => {
    const legacy = encodeCursor({ createdAt: new Date('2026-11-01T10:00:00.123Z'), id });
    expect(decodePreciseCursor(legacy)).toEqual({ at: '2026-11-01T10:00:00.123Z', id });
  });

  it.each([
    ['five fractional digits', raw('2026-11-01T10:00:00.12345Z')],
    ['seven fractional digits', raw('2026-11-01T10:00:00.1234567Z')],
    ['no fraction', raw('2026-11-01T10:00:00Z')],
    ['no Z', raw('2026-11-01T10:00:00.123456')],
    ['an offset instead of Z', raw('2026-11-01T10:00:00.123456+00:00')],
    ['a day that does not exist', raw('2026-02-30T10:00:00.123456Z')],
    ['hour 24', raw('2026-11-01T24:00:00.000000Z')],
    ['a non-uuid id (injection attempt)', raw('2026-11-01T10:00:00.123456Z', "x' OR 1=1 --")],
    ['SQL in the instant', raw("2026-11-01T10:00:00.123456Z'::timestamptz) OR (1=1")],
    ['a number for the instant', raw(1)],
    ['not base64url', '!!!'],
    ['oversized', 'A'.repeat(257)],
  ])('refuses %s with the same 400', (_label, c) => {
    expect(() => decodePreciseCursor(c)).toThrow(BadRequestException);
  });

  it('BIL-12 keeps its strict millisecond cursor: a microsecond cursor is still refused there', () => {
    expect(() => decodeCursor(encodePreciseCursor({ at: '2026-11-01T10:00:00.123456Z', id }))).toThrow(BadRequestException);
  });

  it('toPrecisePage puts the cursor at the last returned row, at its exact position', () => {
    const rows = ['.000003', '.000002', '.000001'].map((f, n) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, cursorAt: `2026-11-01T10:00:00${f}Z` }));
    const page = toPrecisePage(rows, 2);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodePreciseCursor(page.nextCursor as string)).toEqual({ at: rows[1]!.cursorAt, id: rows[1]!.id });
    expect(toPrecisePage(rows, 3).nextCursor).toBeNull();
  });
});
