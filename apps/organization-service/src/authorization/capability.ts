import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequiredCapability } from './service-policy.js';

export const REQUIRED_CAPABILITY = 'required_capability';
/** Every route declares the ONE capability it needs. A route that declares none is refused (deny by default). */
export const RequireCapability = (c: RequiredCapability) => SetMetadata(REQUIRED_CAPABILITY, c);

export interface ServiceScope {
  caller: string;
  capability: RequiredCapability;
  /** null only for the unrestricted test fixture. */
  allowedPlatforms: ReadonlySet<string> | null;
}
/** The authenticated caller's authorization, as decided by the policy guard. Never taken from the request body or a header. */
export const Scope = createParamDecorator((_: unknown, ctx: ExecutionContext): ServiceScope => ctx.switchToHttp().getRequest<{ serviceScope: ServiceScope }>().serviceScope);
