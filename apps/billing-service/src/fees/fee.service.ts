import { Inject, Injectable } from '@nestjs/common';
import { httpError, type Queryable } from '@nawara/service-kit';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { FeeActor } from './fee-actor.guard.js';
import { FeeCommandIdempotency, type CommandResult } from './fee-idempotency.js';
import { FeeRepository, representCap, representDelegation, representProposal, type BillingPlatformFacts } from './fee.repository.js';

/** The existing Billing answer for an Organization outside the caller's scope (unknown or invisible: one answer). */
const ORGANIZATION_NOT_PERMITTED = () => httpError(403, 'organization_not_permitted', BILLING_MESSAGES.organizationNotPermitted);

/**
 * Core V2 S3f (register BIL-04 to BIL-07; the Owner's decisions A1 to A5). Every command: the actor Auth verified live (guard), any further
 * live Auth check BEFORE the transaction (never a network call while holding a lock), then ONE idempotent transaction (A5) in which the
 * database enforces the cap, the delegation and the lifecycle under the Platform's fee lock. Authority is never inferred locally:
 *   - Owner commands: the Platform is in the Owner's Company (Auth, guard) AND its S3d projection names that Company (else the same 404);
 *   - operator commands: Auth allows the operator on the Platform right now (guard), an active delegation names them, and Auth places the
 *     Organization on that Platform (`/auth/admin/organizations/:id`, live).
 */
@Injectable()
export class FeeService {
  constructor(
    private readonly fees: FeeRepository,
    private readonly idempotency: FeeCommandIdempotency,
    @Inject(OWNER_AUTHORITY) private readonly auth: OwnerAuthority,
  ) {}

  /** The Owner's own configured Platform: 404 when its projection names another Company; 409 `platform_not_configured` when none. */
  private async ownersPlatform(q: Queryable, owner: FeeActor, platformId: string): Promise<BillingPlatformFacts> {
    const p = await this.fees.platform(q, platformId);
    if (!p) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
    if (p.companyId !== owner.companyId) throw notFound(); // never re-pointed, never confirmed (S3d)
    return p;
  }

  private async configured(q: Queryable, platformId: string): Promise<BillingPlatformFacts> {
    const p = await this.fees.platform(q, platformId);
    if (!p) throw billingError(409, 'platform_not_configured', BILLING_MESSAGES.platformNotConfigured);
    return p;
  }

  /** BIL-04 (A1, A2): `PUT /billing/admin/platforms/:platformId/fee-caps` `{amount}`. 201 a new version; 200 the same amount is already the cap. */
  setCap(owner: FeeActor, key: string, platformId: string, input: { amount: number }) {
    return this.idempotency.run(owner.userId, key, 'fee_cap.set', { platformId, ...input }, async (q): Promise<CommandResult> => {
      const p = await this.ownersPlatform(q, owner, platformId);
      const { cap, changed } = await this.fees.setCap(q, p, input.amount, owner.userId);
      return { status: changed ? 201 : 200, body: representCap(cap) };
    });
  }

  /**
   * BIL-05 (A3): `POST /billing/admin/platforms/:platformId/fee-delegations` `{operatorUserId}`. The operator must belong to the Owner's
   * Company and hold an ACTIVE assignment to this Platform right now (Auth, the Owner's bearer); otherwise the collapsed 404.
   */
  async grantDelegation(owner: FeeActor, key: string, platformId: string, input: { operatorUserId: string }) {
    if (!(await this.auth.operatorAssigned(owner.bearer, input.operatorUserId, platformId, owner.deadline))) throw notFound();
    return this.idempotency.run(owner.userId, key, 'fee_delegation.grant', { platformId, ...input }, async (q) => {
      await this.ownersPlatform(q, owner, platformId);
      const { delegation, changed } = await this.fees.grantDelegation(q, platformId, input.operatorUserId, owner.userId);
      return { status: changed ? 201 : 200, body: representDelegation(delegation) };
    });
  }

  /** A3: `POST /billing/admin/platforms/:platformId/fee-delegations/:delegationId/revoke`. Final; a repeat answers the revoked delegation. */
  revokeDelegation(owner: FeeActor, key: string, platformId: string, delegationId: string) {
    return this.idempotency.run(owner.userId, key, 'fee_delegation.revoke', { platformId, delegationId }, async (q) => {
      await this.ownersPlatform(q, owner, platformId);
      const { delegation } = await this.fees.revokeDelegation(q, platformId, delegationId, owner.userId);
      return { status: 200, body: representDelegation(delegation) };
    });
  }

  /**
   * BIL-06 (A1, A3, A4): `POST /billing/platforms/:platformId/fee-proposals` `{organizationId, productId, amount}` by a delegated operator.
   * 403 `operation_not_permitted` without an active delegation; 403 `organization_not_permitted` for an Organization Auth does not place
   * on this Platform for this operator; 409 `product_not_available`; 422 `fee_above_cap` (no cap: only 0); 409 `fee_proposal_pending_exists`.
   */
  async propose(operator: FeeActor, key: string, platformId: string, input: { organizationId: string; productId: string; amount: number }) {
    const orgPlatform = await this.auth.organizationPlatform(operator.bearer, input.organizationId, operator.deadline);
    if (orgPlatform !== platformId) throw ORGANIZATION_NOT_PERMITTED(); // unknown, invisible to this operator, or another Platform's: one answer
    return this.idempotency.run(operator.userId, key, 'fee_proposal.create', { platformId, ...input }, async (q) => {
      const p = await this.configured(q, platformId);
      const d = await this.fees.activeDelegation(q, platformId, operator.userId);
      if (!d) throw operationNotPermitted(); // never delegated, or revoked: fail closed
      if (!(await this.fees.isFeeableProduct(q, platformId, input.productId))) throw billingError(409, 'product_not_available', BILLING_MESSAGES.productNotAvailable);
      return { status: 201, body: representProposal(await this.fees.propose(q, p, d, input)) };
    });
  }

  /** A4: `POST /billing/platforms/:platformId/fee-proposals/:id/withdraw` — only the proposer, still delegated, while pending. */
  withdraw(operator: FeeActor, key: string, platformId: string, id: string) {
    return this.idempotency.run(operator.userId, key, 'fee_proposal.withdraw', { platformId, id }, async (q) => {
      const proposal = await this.fees.proposal(id, q);
      if (!proposal || proposal.platformId !== platformId || proposal.proposedBy !== operator.userId) throw notFound();
      if (!(await this.fees.activeDelegation(q, platformId, operator.userId))) throw operationNotPermitted();
      return { status: 200, body: representProposal(await this.fees.decide(q, id, 'withdrawn', operator.userId)) };
    });
  }

  /**
   * BIL-07 (A4): `POST /billing/admin/fee-proposals/:id/approve` and `.../reject` — only the Owner of the proposal's Platform (live). An
   * unknown proposal and another Company's are the same 404. An approval re-checks the CURRENT cap (422 `fee_above_cap`).
   */
  async decide(owner: FeeActor, key: string, id: string, status: 'approved' | 'rejected') {
    const proposal = await this.fees.proposal(id);
    if (!proposal || !(await this.auth.platformAllowed(owner.bearer, proposal.platformId, owner.deadline))) throw notFound();
    return this.idempotency.run(owner.userId, key, status === 'approved' ? 'fee_proposal.approve' : 'fee_proposal.reject', { id }, async (q) => {
      await this.ownersPlatform(q, owner, proposal.platformId);
      return { status: 200, body: representProposal(await this.fees.decide(q, id, status, owner.userId)) };
    });
  }
}
