import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify, type JWSHeaderParameters } from 'jose';
import { APP_CONFIG, JWT_LEGACY_KEY_ID, type AppConfig } from '../config/app-config.js';
import { CLOCK, type Clock } from '../common/ports.js';
import { authError } from '../errors.js';
import { AUTH_MESSAGES } from '../messages.js';

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

/** A ring key id as the configuration accepts it (the kit's key-ring id rule). */
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Access tokens: JWT, HS256 (HMAC-SHA-256 with a configured key of >=32 random bytes),
 * issuer + audience pinned, algorithm allow-list pinned on verify (no "none", no alg confusion).
 * V2 A4.7 (ADR-0058 rules 5 and 6): the active key signs. The legacy key (`JWT_SECRET`) signs with the header exactly
 * {"alg":"HS256"}, as before the ring; a ring key adds only its `kid`. Verification selects exactly one key from the signed
 * header (no `kid`: the legacy key; a `kid`: that ring key) and never tries another; keys carried by the header are never used.
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
    if (exp <= nowS) throw authError(401, 'session_expired', AUTH_MESSAGES.sessionEnded);
    const payload: Record<string, unknown> = { role: c.role, sid: c.sid };
    if (c.adminTier) payload.adminTier = c.adminTier;
    const accessToken = await new SignJWT(payload)
      .setProtectedHeader(this.cfg.jwt.activeKeyId === JWT_LEGACY_KEY_ID ? { alg: 'HS256' } : { alg: 'HS256', kid: this.cfg.jwt.activeKeyId })
      .setSubject(c.sub)
      .setIssuer(this.cfg.jwt.issuer)
      .setAudience(this.cfg.jwt.audience)
      .setIssuedAt(nowS)
      .setExpirationTime(exp)
      .sign(this.activeKey());
    return { accessToken, expiresIn: exp - nowS };
  }

  async verify(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, (header) => this.verificationKey(header), {
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
      throw authError(401, 'invalid_token', AUTH_MESSAGES.invalidToken);
    }
  }

  private activeKey(): Uint8Array {
    const { activeKeyId, legacyKey, ring } = this.cfg.jwt;
    const key = activeKeyId === JWT_LEGACY_KEY_ID ? legacyKey : ring.get(activeKeyId);
    if (!key) throw new Error('JWT active key is not configured'); // unreachable: the configuration loader refuses it
    return key;
  }

  /** The one key a token may be verified with, chosen from its signed header; anything else throws (mapped to invalid_token). */
  private verificationKey(header: JWSHeaderParameters): Uint8Array {
    const kid: unknown = header.kid;
    const key = kid === undefined
      ? this.cfg.jwt.legacyKey
      : typeof kid === 'string' && KEY_ID.test(kid) && kid.toLowerCase() !== JWT_LEGACY_KEY_ID ? this.cfg.jwt.ring.get(kid) : undefined;
    if (!key) throw new Error('no key for this token');
    return key;
  }
}
