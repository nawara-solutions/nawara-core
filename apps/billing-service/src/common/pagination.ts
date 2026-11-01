import { BadRequestException } from '@nestjs/common';
import { attachLocalizedMessage } from '@nawara/service-kit';
import { BILLING_MESSAGES } from '../messages.js';

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
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw attachLocalizedMessage(new BadRequestException(`limit must be an integer from 1 to ${MAX_LIMIT}`), { texts: BILLING_MESSAGES.limitRange, params: { max: MAX_LIMIT } }); // code-less, as before
  return n;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.createdAt.toISOString(), i: position.id }), 'utf8').toString('base64url');
}

/** Strict: a cursor that is not exactly what `encodeCursor` produces is a 400 (never a 500, never trusted as SQL). */
export function decodeCursor(raw: string): CursorPosition {
  const bad = () => attachLocalizedMessage(new BadRequestException('cursor is not valid'), { texts: BILLING_MESSAGES.cursorInvalid }); // code-less, as before
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

/**
 * F-INV-1: a position at the database's own precision. A `Date` holds milliseconds, `timestamptz` microseconds, so a millisecond cursor
 * placed after the last row of a page excluded every later row of the same millisecond: they were skipped. `at` is the row's creation
 * instant as PostgreSQL wrote it (`YYYY-MM-DDTHH:MM:SS.ffffffZ`, UTC), compared in SQL as `timestamptz`, never through a `Date`.
 */
export interface PreciseCursorPosition {
  at: string;
  id: string;
}

const PRECISE_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.(\d{3}|\d{6})Z$/;

export function encodePreciseCursor(position: PreciseCursorPosition): string {
  return Buffer.from(JSON.stringify({ t: position.at, i: position.id }), 'utf8').toString('base64url');
}

/**
 * Strict, as `decodeCursor`: the same envelope, with `t` either six fractional digits (what `encodePreciseCursor` writes) or the three of
 * a cursor issued before F-INV-1, which stays accepted and positions exactly as it did (it cannot bring back a row it already skipped).
 * Anything else is the same code-less 400; the instant must be a real one in canonical form.
 */
export function decodePreciseCursor(raw: string): PreciseCursorPosition {
  const bad = () => attachLocalizedMessage(new BadRequestException('cursor is not valid'), { texts: BILLING_MESSAGES.cursorInvalid }); // code-less, as before
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(raw)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null) throw bad();
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i) || !PRECISE_AT.test(t)) throw bad();
  const ms = `${t.slice(0, 23)}Z`; // the instant to the millisecond: it must exist and be canonical (no Feb 30, no hour 24)
  const asDate = new Date(ms);
  if (Number.isNaN(asDate.getTime()) || asDate.toISOString() !== ms) throw bad();
  return { at: t, id: i };
}

/** `toPage` for rows carrying their precise position (`cursorAt`, `id`). */
export function toPrecisePage<T extends { cursorAt: string; id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodePreciseCursor({ at: last.cursorAt, id: last.id }) : null };
}
