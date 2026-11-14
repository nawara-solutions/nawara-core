import { Inject, Injectable, Logger } from '@nestjs/common';
import { ORGANIZATION_REFERENCE, getRequestContext, type AuthIdentity, type AuthMembership, type Caller, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { notFound, operationNotPermitted } from '../errors.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** Relations a caller may hold to a payment (SDD section 8.3). Core V2 S4e adds `organization_actor` (register PAY-03 F; OD-07 and OD-08 for
 * the active-Organization scope only). Seller-side membership relations stay undecided (O-20). */
export type PaymentRelation = 'producer' | 'payer' | 'organization_actor' | null;

type PaymentParties = Pick<PaymentRow, 'producer' | 'payerType' | 'payerId' | 'organizationId'>;
type AttemptParties = PaymentParties & Pick<PaymentRow, 'purpose'>;

/**
 * The ONLY place that establishes a caller's relation to a payment and applies the operation rules of section 8.4.
 * A caller with no relation gets the same 404 as a resource that does not exist (collapsed, no existence leak).
 */
@Injectable()
export class AuthorizationService {
  private readonly log = new Logger('PaymentAuthorization');

  constructor(@Inject(ORGANIZATION_REFERENCE) private readonly reference: OrganizationReferenceResolver) {}

  async relationTo(payment: PaymentParties, caller: Caller): Promise<PaymentRelation> {
    if (caller.kind === 'service' && caller.service === payment.producer) return 'producer';
    if (caller.kind === 'user' && payment.payerType === 'user' && payment.payerId === caller.identity.id) return 'payer';
    if (caller.kind === 'user' && payment.payerType === 'organization' && (await this.isOrganizationActor(payment, caller.identity))) return 'organization_actor';
    return null;
  }

  /** Read a payment: the producer (only its own payments), the user payer and, for an Organization payer, its Organization actor. */
  async assertCanRead(payment: PaymentParties, caller: Caller): Promise<PaymentRelation> {
    const relation = await this.relationTo(payment, caller);
    if (!relation) throw notFound();
    return relation;
  }

  /** Cancel: the producer only, in this phase (SDD section 8.4). */
  async assertCanCancel(payment: PaymentParties, caller: Caller): Promise<void> {
    const relation = await this.relationTo(payment, caller);
    if (!relation) throw notFound();
    if (relation !== 'producer') throw operationNotPermitted();
  }

  /**
   * Start an attempt: the user payer, or the Organization actor of an Organization payer (Core V2 S4e, OD-08). Never a service (AD-2).
   * Core V2 DO-28 (B-026, the Owner's decision of 2026-11-14): for an `organization_subscription` the payer must ALSO be, on this request, an
   * active administrator of the payment's exact Organization ({@link isSubscriptionAdministrator}); otherwise 403, before any idempotency
   * reservation, attempt row or provider call, so a replayed key is refused the same way and nothing new happens.
   */
  async assertCanStartAttempt(payment: AttemptParties, caller: Caller): Promise<void> {
    const relation = await this.relationTo(payment, caller);
    if (!relation) throw notFound();
    if (relation !== 'payer' && relation !== 'organization_actor') throw operationNotPermitted();
    if (payment.purpose === 'organization_subscription') {
      // the pairing (and the database's payment_purpose_user_payer) makes a subscription's payer a user, so the relation is `payer` here
      if (relation !== 'payer' || caller.kind !== 'user' || !(await this.isSubscriptionAdministrator(payment, caller.identity))) throw operationNotPermitted();
    }
  }

  /** Sync an attempt: anyone with a read relation (producer, payer, Organization actor), per SDD section 8.4. */
  async assertCanSync(payment: PaymentParties, caller: Caller): Promise<void> {
    if (!(await this.relationTo(payment, caller))) throw notFound();
  }

  /**
   * Core V2 DO-28 (B-026; the Owner's decision of 2026-11-14): the named payer of an `organization_subscription` may start a NEW attempt only
   * while Auth's LIVE answer for their own bearer (`/auth/me`, read by the guard on this very request; never cached, never a request value)
   * shows exactly one well-formed membership in the payment's exact Organization that is `active` with `isOrganizationAdmin` true, and that
   * membership's Platform is the Organization's authoritative Platform (the Organization reference read; its Company follows from the
   * Platform). Anything else is a refusal: no Organization on the payment, a missing, malformed or duplicated membership entry, a pending,
   * rejected or revoked membership, a removed administrator flag, another Organization's membership (same Company or not), or a Platform
   * mismatch. Auth or the Organization reference unable to answer fails closed with 503 (thrown by the client or the resolver).
   *
   * Only NEW attempts are gated. An attempt started while the payer qualified keeps its provider, webhook, retry, recovery and
   * reconciliation lifecycle (those paths never call this), and reading or syncing it stays the payer's (`assertCanSync`).
   */
  private async isSubscriptionAdministrator(payment: AttemptParties, identity: AuthIdentity): Promise<boolean> {
    const organizationId = payment.organizationId;
    const deny = (reason: string) => {
      this.log.warn(`subscription_payer_denied organizationId=${organizationId ?? '-'} reason=${reason} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
      return false;
    };
    if (!organizationId) return deny('no_organization');
    const entries = (Array.isArray(identity.memberships) ? identity.memberships : []) as unknown[];
    const forOrganization = entries.filter((m) => (m as { organization?: { id?: unknown } } | null)?.organization?.id === organizationId);
    if (forOrganization.length !== 1) return deny(forOrganization.length === 0 ? 'no_membership' : 'ambiguous_membership');
    const m = forOrganization[0];
    if (!isWellFormedMembership(m)) return deny('malformed_membership');
    if (m.status !== 'active') return deny('membership_not_active');
    if (m.isOrganizationAdmin !== true) return deny('not_organization_admin');
    const ref = await this.reference.resolve(organizationId); // throws (503 hierarchy_unavailable) when the authority cannot answer
    if (!ref) return deny('unresolved');
    if (ref.platformId !== m.platform.id) return deny('platform_mismatch');
    return true;
  }

  /**
   * Core V2 S4e (register PAY-03 F; the Owner's A-2 to A-4, A-6, A-7): the caller acts for the paying Organization when Auth's LIVE answer for
   * their own bearer (`/auth/me`, read by the guard on this very request, which already refused an inactive user) shows an ordinary member (no
   * Owner or operator tier) holding an `active` administrator membership in exactly that Organization, and that membership's Platform is the
   * Organization's authoritative Platform (the Organization reference read: unavailable fails closed with 503, unknown is no relation).
   *
   * This is the ACTIVE-Organization actor set only. No lifecycle state exists yet (S0 §3.6.4: no scope can be inactive before V-4), so Auth's
   * membership facts suffice for now; R-6a (OD-R6a, open) and the effective lifecycle state must be enforced here no later than the V-4
   * activation. The actor set for an inactive Organization is V-5, decided before S5, and must keep existing settlement and recovery
   * dischargeable: this function is the one place it extends.
   */
  private async isOrganizationActor(payment: PaymentParties, identity: AuthIdentity): Promise<boolean> {
    if (!identity.isActive || identity.adminTier !== null) return false;
    const organizationId = payment.organizationId;
    if (!organizationId || organizationId !== payment.payerId) return false; // the database guarantees it; checked again, never assumed
    const membership = identity.memberships.find((m) => m.organization.id === organizationId && m.status === 'active' && m.isOrganizationAdmin === true);
    if (!membership) return false; // no Organization lookup for a caller who could not qualify anyway
    const ref = await this.reference.resolve(organizationId); // throws (503 hierarchy_unavailable) when the authority cannot answer
    if (!ref || ref.platformId !== membership.platform.id) {
      this.log.warn(`organization_actor_denied organizationId=${organizationId} reason=${!ref ? 'unresolved' : 'platform_mismatch'} correlationId=${getRequestContext()?.correlationId ?? '-'}`);
      return false;
    }
    return true;
  }
}

/** A membership entry exactly as Auth's `/auth/me` states it (Core V2 DO-28): anything else is not evidence and never qualifies. */
function isWellFormedMembership(m: unknown): m is AuthMembership {
  if (typeof m !== 'object' || m === null) return false;
  const x = m as Record<string, unknown>;
  const ref = (v: unknown) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string';
  return typeof x.id === 'string' && ref(x.organization) && ref(x.platform)
    && ['pending', 'active', 'rejected', 'revoked'].includes(x.status as string) && typeof x.isOrganizationAdmin === 'boolean';
}
