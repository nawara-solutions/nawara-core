import { organizationError } from '../domain/errors.js';
import { UUID } from '../domain/input.js';

/**
 * Cursor pagination for lists (ADR-0034): `?limit=&cursor=` returning `{ items, nextCursor }`, newest first, with allow-listed
 * filters. The cursor carries `createdAt` as a MICROSECOND-precision UTC string produced by PostgreSQL itself (`cursorAt`), never a
 * JavaScript Date: a Date truncates to milliseconds, and rows whose timestamps differ only below that (rows imported with their
 * original timestamps can) would be skipped at a page boundary.
 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Selected next to every list row so the cursor of the last row can be built exactly. */
export const CURSOR_AT_SQL = `to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"`;

export interface Page<T> {
  items: T[];
  /** Opaque; null when there is no further page. */
  nextCursor: string | null;
}
export interface CursorPosition {
  createdAt: string;
  id: string;
}
export interface ListQuery {
  limit: number;
  cursor?: CursorPosition;
  filters: Record<string, string>;
}

const bad = (message: string) => organizationError(400, 'invalid_query', message);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt, i: position.id }), 'utf8').toString('base64url');
}

/** Strict: a cursor that is not exactly what `encodeCursor` produces is a 400 (never a 500, never trusted as SQL). */
export function decodeCursor(raw: string): CursorPosition {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(raw)) throw bad('cursor is not valid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad('cursor is not valid');
  }
  const { t, i } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || !TIMESTAMP.test(t) || !UUID.test(i) || Number.isNaN(Date.parse(t))) throw bad('cursor is not valid');
  return { createdAt: t, id: i };
}

/** A missing limit is the default; anything that is not an integer from 1 to MAX_LIMIT is a 400, never silently clamped. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return n;
}

/** Parses `?limit=&cursor=` plus the allow-listed uuid filters. An unknown or repeated parameter is a 400, never ignored. */
export function parseListQuery(query: Record<string, unknown>, uuidFilters: readonly string[] = []): ListQuery {
  const allowed = ['limit', 'cursor', ...uuidFilters];
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key)) throw bad(`unknown query parameter: ${key}`);
    if (typeof value !== 'string') throw bad(`${key} must be given once`);
  }
  const filters: Record<string, string> = {};
  for (const name of uuidFilters) {
    const v = query[name];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !UUID.test(v)) throw bad(`${name} must be a uuid`);
    filters[name] = v.toLowerCase();
  }
  const cursor = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : undefined;
  return { limit: parseLimit(query.limit), cursor, filters };
}

/** Builds a page from rows fetched with `LIMIT limit + 1`: one extra row means "there is another page". */
export function toPage<T extends { id: string; cursorAt: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.cursorAt, id: last.id }) : null };
}
