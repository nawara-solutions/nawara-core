import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor, parseLimit, toPage } from './pagination.js';

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
