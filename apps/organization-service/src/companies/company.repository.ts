import type { AuditActor } from '@nawara/audit-contract';
import { OrganizationAudit } from '../audit/organization-audit.js';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { listPage } from '../common/list.js';
import type { ListQuery, Page } from '../common/pagination.js';
import type { CreateCompanyInput, UpdateCompanyInput } from '../domain/company-input.js';
import { notFound } from '../domain/errors.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { OwnershipService } from '../ownership/ownership.service.js';

export interface CompanyRow {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The only writer of `company`. There is no delete: a company with platforms cannot be removed (`ON DELETE RESTRICT`), and no
 * decision establishes deleting or archiving one, so no such operation exists (ADR-0039: lifecycle semantics are deferred).
 */
@Injectable()
export class CompanyRepository {
  constructor(
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
    private readonly ownership: OwnershipService,
    private readonly audit: OrganizationAudit,
  ) {}

  /** The id is generated here, by this service. The database would also accept an explicit one (see migration 0001), but no API does. */
  async create(caller: string, key: string, input: CreateCompanyInput, actor: AuditActor, opts: { bootstrap?: boolean } = {}): Promise<{ company: CompanyRow; replayed: boolean }> {
    const id = randomUUID();
    return this.db.tx(async (q) => {
      await this.ownership.assertWritable(q, opts.bootstrap ? 'bootstrap' : 'normal');
      const reserved = await this.idempotency.reserve(q, {
        caller, operation: 'company.create', key, requestHash: IdempotencyService.requestHash('company.create', input), resourceId: id,
      });
      if (reserved.replay) {
        const { rows } = await q.query<CompanyRow>('SELECT * FROM company WHERE id = $1', [reserved.resourceId]);
        if (!rows[0]) throw notFound();
        return { company: rows[0], replayed: true };
      }
      const { rows } = await q.query<CompanyRow>('INSERT INTO company (id, name) VALUES ($1, $2) RETURNING *', [id, input.name]);
      await this.audit.hierarchy(q, 'company.created', { type: 'company', id }, actor); // Stage 18.7.3: same transaction
      return { company: rows[0]!, replayed: false };
    });
  }

  async get(id: string): Promise<CompanyRow> {
    const { rows } = await this.db.query<CompanyRow>('SELECT * FROM company WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  list(query: ListQuery): Promise<Page<CompanyRow & { cursorAt: string }>> {
    return listPage<CompanyRow>(this.db, 'company', query);
  }

  /** Only the name can change. A no-op update writes nothing (and leaves `updatedAt` alone). */
  async update(id: string, input: UpdateCompanyInput, actor: AuditActor): Promise<CompanyRow> {
    return this.db.tx(async (q) => {
      await this.ownership.assertWritable(q);
      const { rows } = await q.query<CompanyRow>('SELECT * FROM company WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0];
      if (!current) throw notFound();
      if (input.name === undefined || input.name === current.name) return current;
      const updated = await q.query<CompanyRow>('UPDATE company SET name = $2, "updatedAt" = now() WHERE id = $1 RETURNING *', [id, input.name]);
      await this.audit.hierarchy(q, 'company.updated', { type: 'company', id }, actor); // a no-op update writes nothing, and no evidence
      return updated.rows[0]!;
    });
  }
}
