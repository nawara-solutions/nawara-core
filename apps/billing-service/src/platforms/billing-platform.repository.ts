import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import type { VerifiedPlatformOwner } from './owner-authority.client.js';

export interface BillingPlatformRow {
  platformId: string;
  companyId: string;
  currency: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * Core V2 S3d (register BIL-01): the ONLY writer and reader of `billing_platform`. Every call carries the Owner Auth verified for this
 * request (their Company included); nothing here reads a Company from a request. A row is written once and never changed (the schema
 * refuses the rest), so a Platform's Company and currency are fixed for ever.
 *
 * Non-disclosure: a row whose Company is not the verified Owner's is answered exactly like a missing row (404). Auth already places the
 * Platform in the Owner's Company, so that can only mean the Platform moved Company in Auth after it was configured: Billing never
 * re-points the row and never confirms it to anyone (an anomaly is logged as a class, without identifiers).
 */
@Injectable()
export class BillingPlatformRepository {
  private readonly log = new Logger('BillingPlatform');

  constructor(private readonly db: DbService) {}

  /**
   * Configures the Platform, or answers the identical earlier configuration (`changed: false`). `409 billing_platform_exists` when the
   * Owner's own Platform already has a different currency. Concurrent first writes are serialized by the primary key: one inserts, the
   * other then sees that row and answers as a replay or a conflict.
   */
  async create(owner: VerifiedPlatformOwner, platformId: string, currency: string): Promise<{ platform: BillingPlatformRow; changed: boolean }> {
    const { rows } = await this.db.query<BillingPlatformRow>(
      `INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("platformId") DO NOTHING RETURNING *`,
      [platformId, owner.companyId, currency, owner.userId],
    );
    if (rows[0]) return { platform: rows[0], changed: true };
    const existing = await this.findOwned(owner, platformId);
    if (existing.currency !== currency) throw billingError(409, 'billing_platform_exists', BILLING_MESSAGES.billingPlatformExists);
    return { platform: existing, changed: false };
  }

  /** The Owner's own Platform configuration; 404 when there is none (or it is recorded for another Company: the same answer). */
  async findOwned(owner: VerifiedPlatformOwner, platformId: string): Promise<BillingPlatformRow> {
    const { rows } = await this.db.query<BillingPlatformRow>(`SELECT * FROM billing_platform WHERE "platformId" = $1`, [platformId]);
    const row = rows[0];
    if (!row) throw notFound();
    if (row.companyId !== owner.companyId) {
      this.log.warn('billing_platform_company_mismatch'); // Auth and the immutable projection disagree: refused, never re-pointed
      throw notFound();
    }
    return row;
  }
}

export interface BillingPlatformRepresentation {
  platformId: string;
  companyId: string;
  currency: string;
  createdAt: string;
}

/** The register's shape: `createdBy` is attribution, kept in the row and not exposed. */
export function representBillingPlatform(row: BillingPlatformRow): BillingPlatformRepresentation {
  return { platformId: row.platformId, companyId: row.companyId, currency: row.currency.trim(), createdAt: row.createdAt.toISOString() };
}
