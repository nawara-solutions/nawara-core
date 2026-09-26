import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ServiceRequest } from '@nawara/service-kit';
import type { ReleaseConfig } from '../config/release-config.js';
import { RELEASE_CONFIG } from '../config/release-config.token.js';
import { ReleaseCounters } from '../ops/release-counters.js';
import type { ReleaseCallerPolicy, ReleaseCapability } from './caller-policy.js';

const REQUIRED_CAPABILITY = 'release_required_capability';
/** Every automation route declares the ONE capability it needs. A route that declares none is refused (deny by default). */
export const RequireCapability = (c: ReleaseCapability) => SetMetadata(REQUIRED_CAPABILITY, c);

export type DenialReason = 'unauthenticated' | 'route_declares_no_capability' | 'operation_not_allowed' | 'product_not_allowed';

/**
 * The authorization decision, from the authenticated caller name and configuration ONLY: no database lookup, so a refused caller learns
 * nothing about which products, components or releases exist (an unknown product and a forbidden one are the same answer).
 */
export function authorizationDenial(policy: ReleaseCallerPolicy, caller: string | undefined, product: unknown, capability: ReleaseCapability | undefined): DenialReason | null {
  if (!caller) return 'unauthenticated';
  if (!capability) return 'route_declares_no_capability';
  if (!policy.holds(caller, capability)) return 'operation_not_allowed';
  if (typeof product !== 'string' || !policy.allows(caller, product, capability)) return 'product_not_allowed';
  return null;
}

export function denialError(reason: DenialReason): HttpException {
  if (reason === 'product_not_allowed') return new HttpException({ message: 'This caller has no authority on this product.', code: 'product_not_allowed' }, 403);
  return new HttpException({ message: 'Operation not allowed for this caller.', code: 'operation_not_allowed' }, 403);
}

/**
 * Runs AFTER the token guard (authentication, ADR-0033), BEFORE body validation: is this service admitted to this capability for this
 * product (ADR-0042 decision 2, ADR-0051 §8)? Deny by default. The product comes from the route; it is compared with the caller's
 * configured set, never trusted as authority. No header (`X-Product`, `X-Service`, `X-Role`, `X-Owner`…) is read. The reason goes to the
 * log with bounded fields only (the ADR-0042 d9 floor); the response says only which of the two refusals applies.
 */
@Injectable()
export class ReleasePolicyGuard implements CanActivate {
  private readonly log = new Logger('ReleaseAuthorization');

  constructor(
    private readonly reflector: Reflector,
    @Inject(RELEASE_CONFIG) private readonly config: ReleaseConfig,
    @Inject(ReleaseCounters) private readonly counters: ReleaseCounters,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<ServiceRequest>();
    const capability = this.reflector.getAllAndOverride<ReleaseCapability | undefined>(REQUIRED_CAPABILITY, [ctx.getHandler(), ctx.getClass()]);
    const reason = authorizationDenial(this.config.callerPolicy, req.serviceCaller, req.params.product, capability);
    if (reason === null) return true;
    this.counters.automation.count(capability === 'release.publish' ? 'publish' : 'register', 'denied');
    this.log.warn(`release_authorization_denied caller=${req.serviceCaller ?? 'none'} capability=${capability ?? 'none'} reason=${reason}`);
    throw denialError(reason);
  }
}
