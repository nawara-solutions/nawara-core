import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, pgConstraint, type Queryable } from '@nawara/service-kit';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

export interface FeeCapRow { id: string; platformId: string; version: number; amount: string; currency: string; setBy: string; createdAt: Date }
export interface FeeDelegationRow { id: string; platformId: string; operatorUserId: string; grantedBy: string; createdAt: Date; revokedAt: Date | null }
export interface FeeProposalRow {
  id: string; platformId: string; organizationId: string; productId: string; amount: string; currency: string; delegationId: string; proposedBy: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; capVersion: number | null; decidedBy: string | null; decidedAt: Date | null; createdAt: Date;
}
export interface BillingPlatformFacts { platformId: string; companyId: string; currency: string }

const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const representCap = (r: FeeCapRow) => ({ platformId: r.platformId, version: r.version, amount: Number(r.amount), currency: r.currency.trim(), createdAt: iso(r.createdAt) });
export const representDelegation = (r: FeeDelegationRow) => ({ id: r.id, platformId: r.platformId, operatorUserId: r.operatorUserId, createdAt: iso(r.createdAt), revokedAt: iso(r.revokedAt) });
export const representProposal = (r: FeeProposalRow) => ({
  id: r.id, platformId: r.platformId, organizationId: r.organizationId, productId: r.productId, amount: Number(r.amount), currency: r.currency.trim(),
  status: r.status, proposedBy: r.proposedBy, capVersion: r.capVersion, createdAt: iso(r.createdAt), decidedAt: iso(r.decidedAt),
});

const DELEGATION = `SELECT d.*, r."createdAt" AS "revokedAt" FROM fee_delegation d LEFT JOIN fee_delegation_revocation r ON r."delegationId" = d.id`;

/**
 * Core V2 S3f (BIL-04 to BIL-07): the ONLY writer and reader of `fee_cap`, `fee_delegation`, `fee_delegation_revocation` and
 * `fee_proposal`. Every write runs in the caller's (idempotent command's) transaction; the database serializes a Platform's fee writes and
 * enforces the cap, the active delegation, one pending proposal per (Organization, product) and the one-way decisions (0025). Actors are
 * the ones Auth verified; nothing here reads an identity, a Company, a currency or a status from a request.
 */
@Injectable()
export class FeeRepository {
  constructor(private readonly db: DbService) {}

  /** The Platform's S3d configuration (its Company and one currency), or null when it is not configured. */
  async platform(q: Queryable, platformId: string): Promise<BillingPlatformFacts | null> {
    const { rows } = await q.query<BillingPlatformFacts>(`SELECT "platformId", "companyId", currency FROM billing_platform WHERE "platformId" = $1`, [platformId]);
    return rows[0] ? { ...rows[0], currency: rows[0].currency.trim() } : null;
  }

  async currentCap(q: Queryable, platformId: string): Promise<FeeCapRow | null> {
    const { rows } = await q.query<FeeCapRow>(`SELECT * FROM fee_cap WHERE "platformId" = $1 ORDER BY version DESC LIMIT 1`, [platformId]);
    return rows[0] ?? null;
  }

  /** A2: a new cap version (the database numbers it), unless the current cap already has this amount (then nothing is written). */
  async setCap(q: Queryable, p: BillingPlatformFacts, amount: number, setBy: string): Promise<{ cap: FeeCapRow; changed: boolean }> {
    await q.query(`SELECT billing_fee_lock($1)`, [p.platformId]);
    const current = await this.currentCap(q, p.platformId);
    if (current && Number(current.amount) === amount) return { cap: current, changed: false };
    const { rows } = await q.query<FeeCapRow>(
      `INSERT INTO fee_cap ("platformId", version, amount, currency, "setBy") VALUES ($1, 0, $2, $3, $4) RETURNING *`,
      [p.platformId, amount, p.currency, setBy],
    );
    return { cap: rows[0]!, changed: true };
  }

  async activeDelegation(q: Queryable, platformId: string, operatorUserId: string): Promise<FeeDelegationRow | null> {
    const { rows } = await q.query<FeeDelegationRow>(`${DELEGATION} WHERE d."platformId" = $1 AND d."operatorUserId" = $2 AND r."delegationId" IS NULL`, [platformId, operatorUserId]);
    return rows[0] ?? null;
  }

  /** A3: one active delegation per (Platform, operator); an existing one is answered as it is (`changed: false`). */
  async grantDelegation(q: Queryable, platformId: string, operatorUserId: string, grantedBy: string): Promise<{ delegation: FeeDelegationRow; changed: boolean }> {
    await q.query(`SELECT billing_fee_lock($1)`, [platformId]);
    const active = await this.activeDelegation(q, platformId, operatorUserId);
    if (active) return { delegation: active, changed: false };
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES ($1, $2, $3) RETURNING id`,
      [platformId, operatorUserId, grantedBy],
    );
    return { delegation: (await this.delegation(q, platformId, rows[0]!.id))!, changed: true };
  }

  async delegation(q: Queryable, platformId: string, id: string): Promise<FeeDelegationRow | null> {
    const { rows } = await q.query<FeeDelegationRow>(`${DELEGATION} WHERE d.id = $1 AND d."platformId" = $2`, [id, platformId]);
    return rows[0] ?? null;
  }

  /** A3: explicit, final revocation; an already revoked delegation is answered as it is. */
  async revokeDelegation(q: Queryable, platformId: string, id: string, revokedBy: string): Promise<{ delegation: FeeDelegationRow; changed: boolean }> {
    await q.query(`SELECT billing_fee_lock($1)`, [platformId]);
    const d = await this.delegation(q, platformId, id);
    if (!d) throw notFound();
    if (d.revokedAt) return { delegation: d, changed: false };
    await q.query(`INSERT INTO fee_delegation_revocation ("delegationId", "revokedBy") VALUES ($1, $2)`, [id, revokedBy]);
    return { delegation: (await this.delegation(q, platformId, id))!, changed: true };
  }

  /** Whether the product is an ACTIVE personal subscription product of this Platform (the fee's one product, A1). */
  async isFeeableProduct(q: Queryable, platformId: string, productId: string): Promise<boolean> {
    const { rows } = await q.query(`SELECT 1 FROM product WHERE id = $1 AND "platformId" = $2 AND "subscriptionTarget" = 'personal' AND status = 'active'`, [productId, platformId]);
    return rows.length === 1;
  }

  /** A4: a pending proposal, within the CURRENT cap (the database decides under the Platform's fee lock). */
  async propose(q: Queryable, p: BillingPlatformFacts, d: FeeDelegationRow, input: { organizationId: string; productId: string; amount: number }): Promise<FeeProposalRow> {
    try {
      const { rows } = await q.query<FeeProposalRow>(
        `INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [p.platformId, input.organizationId, input.productId, input.amount, p.currency, d.id, d.operatorUserId],
      );
      return rows[0]!;
    } catch (e) {
      throw this.mapped(e);
    }
  }

  async proposal(id: string, q: Queryable = this.db): Promise<FeeProposalRow | null> {
    const { rows } = await q.query<FeeProposalRow>(`SELECT * FROM fee_proposal WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** A4: pending -> approved | rejected | withdrawn, once; an approval re-checks the CURRENT cap and records its version (0025). */
  async decide(q: Queryable, id: string, status: 'approved' | 'rejected' | 'withdrawn', decidedBy: string): Promise<FeeProposalRow> {
    const { rows: locked } = await q.query<FeeProposalRow>(`SELECT * FROM fee_proposal WHERE id = $1 FOR UPDATE`, [id]);
    if (!locked[0]) throw notFound();
    if (locked[0].status !== 'pending') throw billingError(409, 'fee_proposal_not_pending', BILLING_MESSAGES.feeProposalNotPending);
    try {
      const { rows } = await q.query<FeeProposalRow>(`UPDATE fee_proposal SET status = $2, "decidedBy" = $3 WHERE id = $1 RETURNING *`, [id, status, decidedBy]);
      return rows[0]!;
    } catch (e) {
      throw this.mapped(e);
    }
  }

  /** A2 at the point of use (S5 calls this): the latest approved fee and whether the CURRENT cap still allows it; null when none. */
  async feeForUse(organizationId: string, productId: string): Promise<{ proposalId: string; amount: number; currency: string; usable: boolean } | null> {
    const { rows } = await this.db.query<{ proposalId: string; amount: string; currency: string; usable: boolean }>(`SELECT * FROM billing_fee_for_use($1, $2)`, [organizationId, productId]);
    const r = rows[0];
    return r ? { proposalId: r.proposalId, amount: Number(r.amount), currency: r.currency.trim(), usable: r.usable } : null;
  }

  private mapped(e: unknown): unknown {
    const c = pgConstraint(e);
    if (c === 'fee_above_cap') return billingError(422, 'fee_above_cap', BILLING_MESSAGES.feeAboveCap);
    if (c === 'fee_proposal_not_pending') return billingError(409, 'fee_proposal_not_pending', BILLING_MESSAGES.feeProposalNotPending);
    if (isUniqueViolation(e, 'fee_proposal_pending_unique')) return billingError(409, 'fee_proposal_pending_exists', BILLING_MESSAGES.feeProposalPendingExists);
    if (c === 'fee_proposal_delegation_active') return operationNotPermitted();
    return e;
  }
}
