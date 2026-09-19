import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { hashServiceToken, SERVICE_TOKENS, type AuthClient, type ServiceTokenEntry } from '@nawara/service-kit';
import { AUTH_CLIENT } from './auth-client.token.js';
import type { Caller } from './caller.js';

export type CallerRequest = Request & { caller?: Caller };

/**
 * Endpoints reachable by either a service token or an end-user bearer (SDD section 8.1): the service-token digests are
 * tried FIRST; on a match the caller is that service and the bearer is NEVER sent to Auth. Only when no service token
 * matches is the bearer treated as a user token and asked of Auth, live. An inactive identity is refused (401); Auth
 * being unreachable surfaces as the kit's own fail-closed 503 (thrown by `AuthClient.getIdentity`).
 */
@Injectable()
export class ServiceOrUserGuard implements CanActivate {
  constructor(
    @Inject(SERVICE_TOKENS) private readonly tokens: ServiceTokenEntry[],
    @Inject(AUTH_CLIENT) private readonly authClient: AuthClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CallerRequest>();
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) throw new UnauthorizedException();
    const bearer = match[1];

    const presented = Buffer.from(hashServiceToken(bearer), 'hex');
    let service: string | undefined;
    for (const entry of this.tokens) {
      // Compare against EVERY digest (no early exit) so timing does not reveal which caller matched.
      if (timingSafeEqual(presented, Buffer.from(entry.digest, 'hex'))) service = entry.caller;
    }
    if (service) {
      req.caller = { kind: 'service', service };
      return true;
    }

    const identity = await this.authClient.getIdentity(bearer);
    if (!identity || !identity.isActive) throw new UnauthorizedException();
    req.caller = { kind: 'user', identity };
    return true;
  }
}

/** The caller the guard established: `{ kind: 'service', service }` or `{ kind: 'user', identity }`. */
export const RequestCaller = createParamDecorator((_: unknown, ctx: ExecutionContext): Caller | undefined =>
  ctx.switchToHttp().getRequest<CallerRequest>().caller,
);
