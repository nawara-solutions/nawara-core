import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, MAX_LIMIT, decodeCursor, encodeCursor, parseLimit, parseListQuery, toPage } from './pagination.js';

const ID = '3f2b8c1e-0a4d-4b7e-9c11-2d5e6f7a8b90';
const AT = '2024-03-01T10:00:00.123456Z';
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { getResponse(): { code: string } }).getResponse().code;
  }
  return 'none';
};

describe('pagination', () => {
  it('round-trips a cursor with microsecond precision', () => {
    expect(decodeCursor(encodeCursor({ createdAt: AT, id: ID }))).toEqual({ createdAt: AT, id: ID });
  });

  it.each(['', '!!!', 'a'.repeat(300), Buffer.from('not json').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from('{"t":1,"i":2}').toString('base64url'),
    Buffer.from(`{"t":"2024-03-01T10:00:00.123Z","i":"${ID}"}`).toString('base64url'), // millisecond precision is NOT what the service issues
    Buffer.from(`{"t":"2024-13-45T10:00:00.123456Z","i":"${ID}"}`).toString('base64url'),
    Buffer.from(`{"t":"${AT}","i":"1; DROP TABLE company"}`).toString('base64url')])('refuses the cursor %s', (raw) => {
    expect(code(() => decodeCursor(raw))).toBe('invalid_query');
  });

  it('limit: default, bounds, and never silently clamped', () => {
    expect(parseLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit(String(MAX_LIMIT))).toBe(MAX_LIMIT);
    for (const bad of ['0', '101', '-1', '1.5', 'abc', ' 5', '1e2', '0x10']) expect(code(() => parseLimit(bad)), bad).toBe('invalid_query');
  });

  it('parseListQuery allow-lists parameters, lower-cases uuid filters, and refuses repeats, objects and unknown names', () => {
    expect(parseListQuery({ limit: '5' }).limit).toBe(5);
    expect(parseListQuery({ companyId: ID.toUpperCase() }, ['companyId']).filters).toEqual({ companyId: ID });
    expect(code(() => parseListQuery({ companyId: ID }))).toBe('invalid_query'); // not an allowed filter here
    expect(code(() => parseListQuery({ limit: ['1', '2'] }))).toBe('invalid_query');
    expect(code(() => parseListQuery({ limit: { a: '1' } }))).toBe('invalid_query');
    expect(code(() => parseListQuery({ companyId: 'x' }, ['companyId']))).toBe('invalid_query');
    expect(code(() => parseListQuery({ sort: 'name' }))).toBe('invalid_query');
  });

  it('toPage: an extra row means another page, and the cursor is built from the LAST returned row', () => {
    const rows = [1, 2, 3].map((n) => ({ id: `${ID.slice(0, -1)}${n}`, cursorAt: `2024-03-01T10:00:00.00000${n}Z` }));
    const page = toPage(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: '2024-03-01T10:00:00.000002Z', id: rows[1]!.id });
    expect(toPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
    expect(toPage([], 2)).toEqual({ items: [], nextCursor: null });
  });
});
