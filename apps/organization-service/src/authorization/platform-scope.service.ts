import { Injectable } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';

/** Resolves organization -> platform -> company from THIS service's own hierarchy. The authority never asks a client or another service. */
@Injectable()
export class PlatformScopeService {
  constructor(private readonly db: DbService) {}

  async resolveOrganization(organizationId: string): Promise<{ organizationId: string; platformId: string; companyId: string } | null> {
    const { rows } = await this.db.query<{ organizationId: string; platformId: string; companyId: string }>(
      `SELECT o.id AS "organizationId", o."platformId", p."companyId" FROM organization o JOIN platform p ON p.id = o."platformId" WHERE o.id = $1`, [organizationId]);
    return rows[0] ?? null;
  }
}
