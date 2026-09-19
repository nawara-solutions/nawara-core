import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { hashServiceToken, type ServiceTokenEntry } from './service-token.js';

export const SERVICE_TOKENS = Symbol('SERVICE_TOKENS');

/** Request augmented by the guard. The caller is the SERVICE that authenticated, never an end user. */
export type ServiceRequest = Request & { serviceCaller?: string };

/**
 * Authenticates the calling SERVICE from `Authorization: Bearer <service token>`. It says which service called; it says
 * nothing about any end user (that is asked of Auth separately, see AuthClient). An administrator's user token is never
 * accepted as a service credential. Every failure is the same generic 401.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(@Inject(SERVICE_TOKENS) private readonly entries: ServiceTokenEntry[]) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<ServiceRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match || this.entries.length === 0) throw new UnauthorizedException();

    const presented = Buffer.from(hashServiceToken(match[1]), 'hex');
    let caller: string | undefined;
    for (const e of this.entries) {
      // Compare against EVERY digest (no early exit) so timing does not reveal which caller matched.
      const equal = timingSafeEqual(presented, Buffer.from(e.digest, 'hex'));
      if (equal) caller = e.caller;
    }
    if (!caller) throw new UnauthorizedException();
    req.serviceCaller = caller;
    return true;
  }
}

/** Parameter decorator: the name of the calling service that the guard authenticated. */
export const CallerService = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined =>
  ctx.switchToHttp().getRequest<ServiceRequest>().serviceCaller,
);
