import { BadRequestException } from '@nestjs/common';

/** Cursor pagination for lists (ADR-0034): `?limit=&cursor=` returning `{ items, nextCursor }`. Sort is fixed to newest first. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface Page<T> {
  items: T[];
  /** Opaque; null when there is no further page. */
  nextCursor: string | null;
}

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A missing limit is the default; anything that is not an integer from 1 to MAX_LIMIT is a 400, never silently clamped. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new BadRequestException(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  return n;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt.toISOString(), i: position.id }), 'utf8').toString('base64url');
}

/** Strict: a cursor that is not exactly what `encodeCursor` produces is a 400 (never a 500, never trusted as SQL). */
export function decodeCursor(raw: string): CursorPosition {
  const bad = () => new BadRequestException('cursor is not valid');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(raw)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad();
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i)) throw bad();
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== t) throw bad();
  return { createdAt, id: i };
}

/** Build a page from rows fetched with `LIMIT limit + 1`: one extra row means "there is another page". */
export function toPage<T extends CursorPosition>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}
