import type { Queryable } from '@nawara/service-kit';
import { CURSOR_AT_SQL, toPage, type ListQuery, type Page } from './pagination.js';

/**
 * The one list query shared by the three entities: newest first, `id` as the tie-break, keyset-paged. `table` and every column in
 * `filterColumns` are literals chosen by the calling repository, never request input; only VALUES are parameters.
 */
export async function listPage<R extends { id: string }>(
  db: Queryable,
  table: 'company' | 'platform' | 'organization',
  query: ListQuery,
  filterColumns: Record<string, string> = {},
): Promise<Page<R & { cursorAt: string }>> {
  const where: string[] = [];
  const params: unknown[] = [];
  for (const [name, value] of Object.entries(query.filters)) {
    params.push(value);
    where.push(`"${filterColumns[name]}" = $${params.length}`);
  }
  if (query.cursor) {
    params.push(query.cursor.createdAt, query.cursor.id);
    where.push(`("createdAt", id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit + 1);
  const { rows } = await db.query<R & { cursorAt: string }>(
    `SELECT *, ${CURSOR_AT_SQL} FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY "createdAt" DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return toPage(rows, query.limit);
}
