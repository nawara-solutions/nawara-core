import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ServiceRequest } from '@nawara/service-kit';
import { OwnershipService } from '../ownership/ownership.service.js';
import { REQUIRED_CAPABILITY, type ServiceScope } from './capability.js';
import { SERVICE_POLICY, type RequiredCapability, type ServicePolicy } from './service-policy.js';

const forbidden = () => new HttpException({ message: 'Forbidden.', code: 'forbidden' }, 403);

/**
 * Runs AFTER the token guard (authentication): is this caller admitted to this operation? Deny by default, and it fails closed at every
 * step. A denial says nothing about why beyond the generic 403; the reason class goes to the log only (the audit floor, ADR-0042 d9).
 * Rate limiting is not authorization and is not done here.
 */
@Injectable()
export class ServicePolicyGuard implements CanActivate {
  private readonly log = new Logger('ServiceAuthorization');
  constructor(private readonly reflector: Reflector, @Inject(SERVICE_POLICY) private readonly policy: ServicePolicy, private readonly ownership: OwnershipService) {}

  private deny(caller: string | undefined, capability: string | undefined, reason: string): never {
    this.log.warn(`service_authorization_denied caller=${caller ?? 'none'} capability=${capability ?? 'none'} reason=${reason}`);
    throw forbidden();
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<ServiceRequest & { serviceScope?: ServiceScope }>();
    const caller = req.serviceCaller;
    const capability = this.reflector.getAllAndOverride<RequiredCapability | undefined>(REQUIRED_CAPABILITY, [ctx.getHandler(), ctx.getClass()]);
    if (!caller) return this.deny(caller, capability, 'unauthenticated');
    if (!capability) return this.deny(caller, capability, 'route_declares_no_capability');
    if (!this.policy.has(caller, capability)) return this.deny(caller, capability, 'not_admitted');

    // While this service is not authoritative, the only service reads are Auth's bootstrap `ensure` (a FRESH environment); Billing's and
    // Payment's reference reads wait for the cutover verification, and hierarchy writes are refused by the ownership guard itself.
    if (capability === 'hierarchy.reference.read' || capability === 'hierarchy.read') {
      const st = await this.ownership.state();
      const allowed = st.authoritative || (capability === 'hierarchy.read' && st.environmentClass === 'fresh');
      if (!allowed) throw new HttpException({ message: `organization-service is not authoritative yet (phase ${st.phase}).`, code: 'not_authoritative' }, 409);
    }
    req.serviceScope = { caller, capability, allowedPlatforms: this.policy.platforms(caller) };
    return true;
  }
}
