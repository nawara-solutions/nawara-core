import {
  CanActivate, ExecutionContext, Inject, Injectable, SetMetadata, UseGuards, applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DbService } from '../db/db.service.js';
import { forbidden, unauthenticated } from '../errors.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { TokenService } from '../tokens/token.service.js';
import type { UserKind } from '../users/users.service.js';

export interface Actor {
  userId: string;
  kind: UserKind;
  sid: string;
  role: string;
}
export type AuthedRequest = Request & { actor: Actor };

const ACTOR_KINDS = 'actor_kinds';

/** Marks a route as authenticated AND restricts it to the listed identity kinds. */
export const Actors = (...kinds: UserKind[]) => applyDecorators(SetMetadata(ACTOR_KINDS, kinds), UseGuards(AuthGuard));

/**
 * Authenticates every protected route and makes the decision from CURRENT state, not just the token:
 *   1. verifies the JWT (signature, HS256 only, issuer, audience, expiry),
 *   2. loads the user: kind comes from the DATABASE, the token's adminTier claim must agree with it,
 *   3. rejects disabled accounts immediately,
 *   4. requires the session (refresh family) to be still active — so logout, family revocation,
 *      reuse detection, block, recovery and an operator's session ceiling all take effect on the very
 *      next request instead of waiting for the access token to expire.
 * Policy (explicit): auth-service's OWN protected routes never rely on token lifetime for
 * revocation. Downstream services that verify the JWT locally see revocation only after the short
 * access-token TTL (default 15 min) — which is why platform-scoped access is always re-asked here via
 * GET /auth/platform-access/:platformId rather than inferred from claims.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(DbService) private readonly db: DbService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthenticated();
    const claims = await this.tokens.verify(token);

    const { rows } = await this.db.query(`SELECT id, kind, role, "isActive" FROM "user" WHERE id = $1`, [claims.sub]);
    const u = rows[0];
    const claimedTier = claims.adminTier ?? null;
    const actualTier = u && u.kind !== 'member' ? u.kind : null;
    if (!u || !u.isActive || claimedTier !== actualTier) throw unauthenticated();
    if (!(await this.refresh.isSessionActive(u.id, claims.sid))) throw unauthenticated();

    const kinds = this.reflector.getAllAndOverride<UserKind[]>(ACTOR_KINDS, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (kinds.length && !kinds.includes(u.kind)) throw forbidden();
    req.actor = { userId: u.id, kind: u.kind, sid: claims.sid, role: u.role };
    return true;
  }
}
