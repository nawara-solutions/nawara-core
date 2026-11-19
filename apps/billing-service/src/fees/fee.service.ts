import { Inject, Injectable } from '@nestjs/common';
import { httpError, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { requestTransitionContext, type TransitionContext } from '../domain/actors.js';
import { billingError, notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { FeeActor } from './fee-actor.guard.js';
import { FeeCommandIdempotency, type CommandResult } from './fee-idempotency.js';
import { FeeRepository, representCap, representDelegation, representProposal, type BillingPlatformFacts, type FeeProposalRow } from './fee.repository.js';

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
    private readonly audit: BillingAudit,
  ) {}

  /** Core V2 G6-A (DO-67): the catalog actor of a fee fact is the actor Auth verified live for this command, with the kind Auth verified. */
  private ctx(actor: FeeActor): TransitionContext {
    return requestTransitionContext({ type: 'user', id: actor.userId, userKind: actor.kind });
  }

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
      // Core V2 G6-A: one audit intent per NEW cap version, in this transaction (an unchanged cap writes nothing, so it records nothing)
      if (changed) await this.audit.record(q, 'fee_cap.set', { organizationId: null, resource: { type: 'fee_cap', id: cap.id },
        changes: { platform_id: cap.platformId, version: cap.version, amount: Number(cap.amount) } }, this.ctx(owner));
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
      if (changed) await this.audit.record(q, 'fee_delegation.granted', { organizationId: null, resource: { type: 'fee_delegation', id: delegation.id },
        changes: { platform_id: delegation.platformId, operator_user_id: delegation.operatorUserId } }, this.ctx(owner));
      return { status: changed ? 201 : 200, body: representDelegation(delegation) };
    });
  }

  /** A3: `POST /billing/admin/platforms/:platformId/fee-delegations/:delegationId/revoke`. Final; a repeat answers the revoked delegation. */
  revokeDelegation(owner: FeeActor, key: string, platformId: string, delegationId: string) {
    return this.idempotency.run(owner.userId, key, 'fee_delegation.revoke', { platformId, delegationId }, async (q) => {
      await this.ownersPlatform(q, owner, platformId);
      const { delegation, changed } = await this.fees.revokeDelegation(q, platformId, delegationId, owner.userId);
      if (changed) await this.audit.record(q, 'fee_delegation.revoked', { organizationId: null, resource: { type: 'fee_delegation', id: delegation.id },
        changes: { platform_id: delegation.platformId, operator_user_id: delegation.operatorUserId } }, this.ctx(owner));
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
      const proposal = await this.fees.propose(q, p, d, input);
      await this.audit.record(q, 'fee_proposal.created', { organizationId: proposal.organizationId, resource: { type: 'fee_proposal', id: proposal.id },
        changes: { platform_id: proposal.platformId, product_id: proposal.productId, delegation_id: proposal.delegationId, amount: Number(proposal.amount) } }, this.ctx(operator));
      return { status: 201, body: representProposal(proposal) };
    });
  }

  /** A4: `POST /billing/platforms/:platformId/fee-proposals/:id/withdraw` — only the proposer, still delegated, while pending. */
  withdraw(operator: FeeActor, key: string, platformId: string, id: string) {
    return this.idempotency.run(operator.userId, key, 'fee_proposal.withdraw', { platformId, id }, async (q) => {
      const proposal = await this.fees.proposal(id, q);
      if (!proposal || proposal.platformId !== platformId || proposal.proposedBy !== operator.userId) throw notFound();
      if (!(await this.fees.activeDelegation(q, platformId, operator.userId))) throw operationNotPermitted();
      const decided = await this.fees.decide(q, id, 'withdrawn', operator.userId);
      await this.recordDecision(q, decided, operator);
      return { status: 200, body: representProposal(decided) };
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
      const decided = await this.fees.decide(q, id, status, owner.userId);
      await this.recordDecision(q, decided, owner);
      return { status: 200, body: representProposal(decided) };
    });
  }

  /** Core V2 G6-A: a proposal's one-way decision (pending -> withdrawn | approved | rejected happens once, so its intent is written once). */
  private async recordDecision(q: Queryable, p: FeeProposalRow, actor: FeeActor): Promise<void> {
    const fact = { organizationId: p.organizationId, resource: { type: 'fee_proposal', id: p.id } };
    if (p.status === 'withdrawn') await this.audit.record(q, 'fee_proposal.withdrawn', { ...fact, changes: { platform_id: p.platformId } }, this.ctx(actor));
    else if (p.status === 'rejected') await this.audit.record(q, 'fee_proposal.rejected', { ...fact, changes: { platform_id: p.platformId } }, this.ctx(actor));
    else if (p.status === 'approved') {
      await this.audit.record(q, 'fee_proposal.approved', { ...fact, changes: { platform_id: p.platformId, cap_version: p.capVersion!, amount: Number(p.amount) } }, this.ctx(actor));
    }
  }
}
