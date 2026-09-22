import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { authError } from '../errors.js';

export interface AccessClaims {
  sub: string;
  /** 'admin' (owner/operator) or the neutral 'member'. Never an organization, platform or business role. */
  role: string;
  adminTier?: 'owner' | 'operator';
  /** session (refresh-token family) id: lets live checks and step-ups bind to one session */
  sid: string;
  iat: number;
  exp: number;
}

/**
 * Access tokens: JWT, HS256 (HMAC-SHA-256 with JWT_SECRET, >=32 random bytes from config),
 * issuer + audience pinned, algorithm allow-list pinned on verify (no "none", no alg confusion).
 * They carry NO organization, platform, company or entitlement claim: a user can belong to many organizations,
 * so the context is decided live, server-side, from the resource being accessed and the current membership row.
 * Lifetime = accessTtl, clamped to an operator's session ceiling.
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async sign(
    c: { sub: string; role: string; adminTier?: 'owner' | 'operator'; sid: string },
    sessionExpiresAt?: Date | null,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const nowS = Math.floor(this.clock.now().getTime() / 1000);
    let exp = nowS + this.cfg.jwt.accessTtlSec;
    if (sessionExpiresAt) exp = Math.min(exp, Math.floor(sessionExpiresAt.getTime() / 1000));
    if (exp <= nowS) throw authError(401, 'session_expired', 'Session has ended.');
    const payload: Record<string, unknown> = { role: c.role, sid: c.sid };
    if (c.adminTier) payload.adminTier = c.adminTier;
    const accessToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.sub)
      .setIssuer(this.cfg.jwt.issuer)
      .setAudience(this.cfg.jwt.audience)
      .setIssuedAt(nowS)
      .setExpirationTime(exp)
      .sign(this.cfg.jwt.secret);
    return { accessToken, expiresIn: exp - nowS };
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.cfg.jwt.secret, {
        algorithms: ['HS256'],
        issuer: this.cfg.jwt.issuer,
        audience: this.cfg.jwt.audience,
        currentDate: this.clock.now(),
      });
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string' || typeof payload.role !== 'string') {
        throw new Error('malformed');
      }
      return payload as unknown as AccessClaims;
    } catch {
      throw authError(401, 'invalid_token', 'Invalid or expired token.');
    }
  }
}
