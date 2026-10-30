import { Catch } from '@nestjs/common';
import { KitExceptionFilter, type JsonLogger } from '@nawara/service-kit';

/** The extra response fields Billing documents, by name: nothing else on an exception's response object ever reaches a body. */
const BILLING_EXTRA_FIELDS = ['restriction', 'restrictions', 'reason'] as const; // Core V2 S6g: `reason`, the closed refusal of `late_settlement_refused` (BIL-32)

/**
 * The kit's `KitExceptionFilter` exactly as `configureApp` installs it by default (ADR-0054 localization on, no excluded paths), plus one
 * narrow allow-list of extra response fields: Core V2 S5d's `409 assistance_restricted` carries `restriction` (the compatible singular
 * kind) and `restrictions` (every applicable kind) (register BIL-13 C; S5D-4). Machine values, never translated; every other error body is
 * unchanged.
 */
@Catch()
export class BillingExceptionFilter extends KitExceptionFilter {
  constructor(logger: JsonLogger) {
    super(logger, { localize: true });
  }

  protected override extraResponseFields(raw: unknown): Record<string, unknown> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const r = raw as Record<string, unknown>;
    return Object.fromEntries(BILLING_EXTRA_FIELDS.filter((k) => k in r).map((k) => [k, r[k]]));
  }
}
