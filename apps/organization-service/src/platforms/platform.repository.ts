import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, pgCode, pgConstraint } from '@nawara/service-kit';
import { listPage } from '../common/list.js';
import type { ListQuery, Page } from '../common/pagination.js';
import { notFound, organizationError } from '../domain/errors.js';
import type { CreatePlatformInput, UpdatePlatformInput } from '../domain/platform-input.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';

export interface PlatformRow {
  id: string;
  companyId: string;
  name: string;
  /** Optional public slug, as in auth-service. Read-only here: no request creates or changes it (see migration 0003). */
  key: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The only writer of `platform`. `companyId` is checked by the database (`platform_company_fk`), which is the authority: the
 * application never pre-checks with a separate read (that would race). It is also frozen after creation by trigger.
 */
@Injectable()
export class PlatformRepository {
  constructor(private readonly db: DbService, private readonly idempotency: IdempotencyService) {}

  async create(caller: string, key: string, input: CreatePlatformInput): Promise<{ platform: PlatformRow; replayed: boolean }> {
    const id = randomUUID();
    try {
      return await this.db.tx(async (q) => {
        const reserved = await this.idempotency.reserve(q, {
          caller, operation: 'platform.create', key, requestHash: IdempotencyService.requestHash('platform.create', input), resourceId: id,
        });
        if (reserved.replay) {
          const { rows } = await q.query<PlatformRow>('SELECT * FROM platform WHERE id = $1', [reserved.resourceId]);
          if (!rows[0]) throw notFound();
          return { platform: rows[0], replayed: true };
        }
        const { rows } = await q.query<PlatformRow>('INSERT INTO platform (id, "companyId", name) VALUES ($1, $2, $3) RETURNING *', [id, input.companyId, input.name]);
        return { platform: rows[0]!, replayed: false };
      });
    } catch (e) {
      if (pgCode(e) === '23503' && pgConstraint(e) === 'platform_company_fk') throw organizationError(404, 'company_not_found', 'No such company.');
      throw e;
    }
  }

  async get(id: string): Promise<PlatformRow> {
    const { rows } = await this.db.query<PlatformRow>('SELECT * FROM platform WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  list(query: ListQuery): Promise<Page<PlatformRow & { cursorAt: string }>> {
    return listPage<PlatformRow>(this.db, 'platform', query, { companyId: 'companyId' });
  }

  async update(id: string, input: UpdatePlatformInput): Promise<PlatformRow> {
    return this.db.tx(async (q) => {
      const { rows } = await q.query<PlatformRow>('SELECT * FROM platform WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0];
      if (!current) throw notFound();
      if (input.name === undefined || input.name === current.name) return current;
      const updated = await q.query<PlatformRow>('UPDATE platform SET name = $2, "updatedAt" = now() WHERE id = $1 RETURNING *', [id, input.name]);
      return updated.rows[0]!;
    });
  }
}
