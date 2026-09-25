import type { AuditActor } from '@nawara/audit-contract';
import { OrganizationAudit } from '../audit/organization-audit.js';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, pgCode, pgConstraint, type Queryable } from '@nawara/service-kit';
import { listPage } from '../common/list.js';
import type { ListQuery, Page } from '../common/pagination.js';
import { notFound, organizationError } from '../domain/errors.js';
import type { CreateOrganizationInput, UpdateOrganizationInput } from '../domain/organization-input.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { OwnershipService } from '../ownership/ownership.service.js';

export interface OrganizationRow {
  id: string;
  platformId: string;
  name: string;
  taxCode: string | null;
  address: string | null;
  phone: string | null;
  type: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const UPDATABLE = ['name', 'taxCode', 'address', 'phone', 'type'] as const;

/**
 * The only writer of `organization`. It reaches its company only THROUGH its platform: there is no `companyId` here (ADR-0031).
 * `platformId` is checked by the database (`organization_platform_fk`) and frozen after creation by trigger. No delete, no status:
 * lifecycle semantics (archive, deactivate, suspend) are an open decision (ADR-0039 "Deferred decisions") and are not invented.
 */
@Injectable()
export class OrganizationRepository {
  constructor(
    private readonly db: DbService,
    private readonly idempotency: IdempotencyService,
    private readonly ownership: OwnershipService,
    private readonly audit: OrganizationAudit,
  ) {}

  /**
   * `within`, when given, runs INSIDE the transaction after the write (the human-admin controller writes its success actor record
   * there, so a mutation cannot commit without it). It runs on a replay too, as the record always has; if it throws, everything rolls back.
   */
  async create(caller: string, key: string, input: CreateOrganizationInput, actor: AuditActor, within?: (q: Queryable, organization: OrganizationRow) => Promise<void>): Promise<{ organization: OrganizationRow; replayed: boolean }> {
    const id = randomUUID();
    try {
      return await this.db.tx(async (q) => {
        await this.ownership.assertWritable(q);
        const reserved = await this.idempotency.reserve(q, {
          caller, operation: 'organization.create', key, requestHash: IdempotencyService.requestHash('organization.create', input), resourceId: id,
        });
        if (reserved.replay) {
          const { rows } = await q.query<OrganizationRow>('SELECT * FROM organization WHERE id = $1', [reserved.resourceId]);
          if (!rows[0]) throw notFound();
          await within?.(q, rows[0]);
          return { organization: rows[0], replayed: true };
        }
        const { rows } = await q.query<OrganizationRow>(
          `INSERT INTO organization (id, "platformId", name, "taxCode", address, phone, type) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, input.platformId, input.name, input.taxCode, input.address, input.phone, input.type],
        );
        await within?.(q, rows[0]!);
        await this.audit.hierarchy(q, 'organization.created', { type: 'organization', id }, actor); // Stage 18.7.3: identifiers only (no name, tax code, address, phone)
        return { organization: rows[0]!, replayed: false };
      });
    } catch (e) {
      if (pgCode(e) === '23503' && pgConstraint(e) === 'organization_platform_fk') throw organizationError(404, 'platform_not_found', 'No such platform.');
      throw e;
    }
  }

  async get(id: string): Promise<OrganizationRow> {
    const { rows } = await this.db.query<OrganizationRow>('SELECT * FROM organization WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    return rows[0];
  }

  list(query: ListQuery, allowedPlatforms?: ReadonlySet<string> | null): Promise<Page<OrganizationRow & { cursorAt: string }>> {
    return listPage<OrganizationRow>(this.db, 'organization', query, { platformId: 'platformId' }, allowedPlatforms === undefined ? undefined : { column: 'platformId', values: allowedPlatforms === null ? null : [...allowedPlatforms] });
  }

  /** Writes only the fields that actually change; a request that changes nothing writes nothing (and leaves `updatedAt` alone). */
  async update(id: string, input: UpdateOrganizationInput, actor: AuditActor, within?: (q: Queryable, organization: OrganizationRow) => Promise<void>): Promise<OrganizationRow> {
    return this.db.tx(async (q) => {
      await this.ownership.assertWritable(q);
      const { rows } = await q.query<OrganizationRow>('SELECT * FROM organization WHERE id = $1 FOR UPDATE', [id]);
      const current = rows[0];
      if (!current) throw notFound();
      const changed = UPDATABLE.filter((f) => input[f] !== undefined && input[f] !== current[f]);
      if (changed.length === 0) {
        await within?.(q, current);
        return current;
      }
      // Column names come from the fixed UPDATABLE list above, never from the request.
      const sets = changed.map((f, i) => `"${f}" = $${i + 2}`).join(', ');
      const updated = await q.query<OrganizationRow>(`UPDATE organization SET ${sets}, "updatedAt" = now() WHERE id = $1 RETURNING *`, [id, ...changed.map((f) => input[f])]);
      await within?.(q, updated.rows[0]!);
      await this.audit.hierarchy(q, 'organization.updated', { type: 'organization', id }, actor);
      return updated.rows[0]!;
    });
  }
}
