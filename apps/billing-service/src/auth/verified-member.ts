import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AUTH_CLIENT, hashServiceToken, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';

/** Why a request is not a verified member's own. Each route maps these to its answer (401 or 403) and its own log line. */
export type MemberRefusal = 'no_bearer' | 'service_credential' | 'unknown_bearer' | 'inactive' | 'not_a_member';
export type MemberCheck = { ok: true; identity: AuthIdentity } | { ok: false; reason: MemberRefusal };

/**
 * The member rule of BIL-10 (FC-12; OD-01 as the Owner's B6; AUTH-07), shared by direct checkout and the member's own personal
 * subscriptions (BIL-12, D-B4): the caller's OWN bearer, verified LIVE through `/auth/me` on every request (Billing's existing Auth
 * client). A service token is never a member and is never forwarded to Auth; an unknown or revoked bearer is not one; an inactive user,
 * an Owner or an Operator (an admin tier) is not eligible. No Organization or Platform membership is required. When Auth cannot answer,
 * the kit client throws its fail-closed 503, which this check lets through unchanged. Nothing in the request can name the member.
 */
@Injectable()
export class MemberVerifier {
  private readonly serviceDigests: Buffer[];

  constructor(
    @Inject(BILLING_CONFIG) config: BillingConfig,
    @Inject(AUTH_CLIENT) private readonly auth: AuthClient,
  ) {
    this.serviceDigests = config.serviceTokens.map((t) => Buffer.from(t.digest, 'hex'));
  }

  private isServiceToken(bearer: string): boolean {
    const presented = Buffer.from(hashServiceToken(bearer), 'hex');
    let match = false;
    for (const d of this.serviceDigests) if (d.length === presented.length && timingSafeEqual(presented, d)) match = true; // no early exit
    return match;
  }

  async check(authorization: unknown): Promise<MemberCheck> {
    const match = typeof authorization === 'string' ? /^Bearer (\S+)$/.exec(authorization) : null;
    if (!match) return { ok: false, reason: 'no_bearer' };
    if (this.isServiceToken(match[1])) return { ok: false, reason: 'service_credential' };
    const identity = await this.auth.getIdentity(match[1]);
    if (!identity) return { ok: false, reason: 'unknown_bearer' };
    if (!identity.isActive) return { ok: false, reason: 'inactive' };
    if (identity.adminTier !== null) return { ok: false, reason: 'not_a_member' };
    return { ok: true, identity };
  }
}
