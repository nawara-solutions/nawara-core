import type { HttpException } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

/**
 * Core V2 S5d: the restriction kinds derived (S5D-1, S5D-2), in their deterministic order. Core V2 S6f (BIL-26 T3): an open recovery
 * obligation, cleared when its verified recovered principal reaches the base.
 */
export const RESTRICTION_KINDS = ['T1', 'T2', 'T3'] as const;
/**
 * RESERVED, never produced (S5D-7, §12): `inactive` (D6) with V-4's authoritative effective lifecycle state, read live from Organization
 * Service and failing closed when unknown. Never inferred from `/auth/me`, platform access, membership status or any local state. This
 * list is the future integration boundary.
 */
export const RESERVED_RESTRICTION_KINDS = ['inactive'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number] | (typeof RESERVED_RESTRICTION_KINDS)[number];

export interface Restriction {
  kind: (typeof RESTRICTION_KINDS)[number];
  sourceId: string;
  since: Date;
}

/**
 * The Organization lock (S5D-5): the FIRST lock of every path that admits a request or creates or clears T1 or T2. Documented order:
 * (payment rows) -> Organization -> assistance request -> cash-return obligation -> dispute. Re-entrant within a transaction.
 */
export async function lockOrganization(q: Queryable, organizationId: string): Promise<void> {
  await q.query(`SELECT billing_assistance_organization_lock($1)`, [organizationId]);
}

/**
 * The Organization's current restrictions, from the ONE authoritative model (`billing_assistance_restrictions`, migration 0032), at the
 * database's CURRENT clock (never the transaction's start, never an application timestamp, never a cached answer). Deterministic order:
 * kind, then `since`, then `sourceId`.
 */
export async function organizationRestrictions(q: Queryable, organizationId: string): Promise<Restriction[]> {
  return (await q.query<Restriction>(`SELECT kind, "sourceId", since FROM billing_assistance_restrictions($1, clock_timestamp())`, [organizationId])).rows;
}

/**
 * S5D-4: `409 assistance_restricted` with every applicable kind (deterministic, distinct) and the compatible singular `restriction` (the
 * first). Kinds only: never another beneficiary's request or obligation id, amount, personal detail or payment reference.
 */
export function assistanceRestricted(restrictions: readonly Restriction[]): HttpException {
  const kinds = [...new Set(restrictions.map((r) => r.kind))];
  const e = billingError(409, 'assistance_restricted', BILLING_MESSAGES.assistanceRestricted);
  const body = e.getResponse() as Record<string, unknown>;
  body.restriction = kinds[0];
  body.restrictions = kinds;
  return e;
}
