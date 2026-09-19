import { Injectable } from '@nestjs/common';
import { DbService, pgCode, type Queryable } from '@nawara/service-kit';
import { billingError } from '../domain/errors.js';

export interface PlatformCurrencyRow {
  platformId: string;
  currency: string;
  enabled: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The Platform-level currency configuration (foundation only, SDD B-036). It answers ONE question, "may this Platform use this currency for
 * NEW billing work?", and stores which currencies a Platform has enabled. It is not called by any invoice operation yet: how an invoice
 * determines its Platform, who may administer this set, a default currency and an Organization-level restriction are undecided.
 *
 * It never touches an invoice, and no invoice references it, so changing it cannot alter a historical record. A currency's exponent lives
 * only in the global `currency` reference; nothing here reads or writes one. There is no authorization here: the caller (a future,
 * separately approved administrative API) decides who may enable or disable.
 */
@Injectable()
export class PlatformCurrencyRepository {
  constructor(private readonly db: DbService) {}

  /** True only when the currency exists globally AND the Platform has it enabled. No configuration means not permitted. */
  async isPermitted(platformId: string, currency: string, q: Queryable = this.db): Promise<boolean> {
    assertShape(platformId, currency);
    const { rows } = await q.query<{ permitted: boolean }>(`SELECT billing_currency_permitted($1, $2) AS permitted`, [platformId, currency]);
    return rows[0]!.permitted;
  }

  /** `422 unsupported_currency` (SDD 18.2) when the Platform may not use the currency for new work. */
  async assertPermitted(platformId: string, currency: string, q: Queryable = this.db): Promise<void> {
    if (!(await this.isPermitted(platformId, currency, q))) throw billingError(422, 'unsupported_currency', 'The currency is not enabled for this platform.');
  }

  /** Enables a currency for a Platform (creating the configuration, or re-enabling a disabled one). Idempotent: enabling an enabled currency changes nothing. */
  async enable(platformId: string, currency: string): Promise<PlatformCurrencyRow> {
    assertShape(platformId, currency);
    try {
      const { rows } = await this.db.query<PlatformCurrencyRow>(
        `INSERT INTO platform_currency ("platformId", currency) VALUES ($1, $2)
         ON CONFLICT ("platformId", currency) DO UPDATE SET enabled = true
         RETURNING *`,
        [platformId, currency],
      );
      return rows[0]!;
    } catch (e) {
      // the foreign key to the global reference: a currency Billing does not know cannot be enabled
      if (pgCode(e) === '23503') throw billingError(422, 'unsupported_currency', 'The currency does not exist.');
      throw e;
    }
  }

  /** Disables a currency for FUTURE use. The configuration row stays; historical invoices are untouched. `404` when the Platform never configured it. */
  async disable(platformId: string, currency: string): Promise<PlatformCurrencyRow> {
    assertShape(platformId, currency);
    const { rows } = await this.db.query<PlatformCurrencyRow>(
      `UPDATE platform_currency SET enabled = false WHERE "platformId" = $1 AND currency = $2 RETURNING *`,
      [platformId, currency],
    );
    if (!rows[0]) throw billingError(404, 'not_found', 'Not found.');
    return rows[0];
  }

  async list(platformId: string): Promise<PlatformCurrencyRow[]> {
    assertPlatformId(platformId);
    const { rows } = await this.db.query<PlatformCurrencyRow>(`SELECT * FROM platform_currency WHERE "platformId" = $1 ORDER BY currency`, [platformId]);
    return rows;
  }
}

/** The platform id comes from trusted server-side code (never a client claim), so a bad one is a programming error, not a `400`. */
function assertPlatformId(platformId: string): void {
  if (typeof platformId !== 'string' || platformId.trim() === '' || platformId.length > 128) throw new Error('platformId must be 1 to 128 characters');
}

function assertShape(platformId: string, currency: string): void {
  assertPlatformId(platformId);
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) throw new Error('currency must be a three-letter ISO 4217 code');
}
