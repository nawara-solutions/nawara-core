import { Inject, Injectable } from '@nestjs/common';
import type { Queryable } from '../db/db.service.js';
import type { UserRow } from '../users/users.service.js';
import { RefreshTokenService } from '../tokens/refresh-token.service.js';
import { TokenService } from '../tokens/token.service.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** The one place a session (refresh family + access token) is created, for every kind of user. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RefreshTokenService) private readonly refresh: RefreshTokenService,
  ) {}

  async issue(q: Queryable, user: UserRow, sessionExpiresAt?: Date | null): Promise<SessionTokens & { sid: string }> {
    const r = await this.refresh.issue(q, { userId: user.id, sessionExpiresAt });
    const { accessToken, expiresIn } = await this.access(user, r.familyId, r.sessionExpiresAt);
    return { accessToken, expiresIn, refreshToken: r.raw, sid: r.familyId };
  }

  async access(user: UserRow, familyId: string, sessionExpiresAt: Date | null) {
    const { accessToken, expiresIn } = await this.tokens.sign(
      {
        sub: user.id,
        role: user.role,
        organizationId: user.organizationId,
        adminTier: user.kind === 'member' ? undefined : user.kind,
        sid: familyId,
      },
      sessionExpiresAt,
    );
    return { accessToken, expiresIn };
  }
}
