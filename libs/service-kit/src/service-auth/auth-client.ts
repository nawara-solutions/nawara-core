import { ServiceUnavailableException } from '@nestjs/common';
import { correlationHeaders } from '../context/request-context.js';

/** The part of Auth's `GET /auth/me` that other services need. Membership data is READ from Auth, never copied or owned. */
export interface AuthMembership {
  id: string;
  organization: { id: string };
  platform: { id: string };
  status: 'pending' | 'active' | 'rejected' | 'revoked';
  isOrganizationAdmin: boolean;
}
export interface AuthIdentity {
  id: string;
  adminTier: 'owner' | 'operator' | null;
  isActive: boolean;
  memberships: AuthMembership[];
}

/**
 * Port to auth-service for end-user identity (ADR-0033). The END USER's bearer is passed to Auth ONLY, explicitly and
 * separately from any service credential: a service token is never sent here and a user token is never sent anywhere else.
 * Auth answers from live state, so revocation takes effect on the next request.
 */
export interface AuthClient {
  /** null when the token is not valid (Auth said 401/403/404). Throws ServiceUnavailableException when Auth cannot be asked (fail closed). */
  getIdentity(userBearer: string): Promise<AuthIdentity | null>;
  /** True only when Auth says this owner/operator has access to the platform. */
  hasPlatformAccess(userBearer: string, platformId: string): Promise<boolean>;
}

export interface HttpAuthClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class HttpAuthClient implements AuthClient {
  private readonly timeoutMs: number;
  constructor(private readonly opts: HttpAuthClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  private async call(path: string, userBearer: string): Promise<Response> {
    try {
      return await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: { authorization: `Bearer ${userBearer}`, ...correlationHeaders() },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException(); // network error or timeout: fail CLOSED
    }
  }

  async getIdentity(userBearer: string): Promise<AuthIdentity | null> {
    const res = await this.call('/auth/me', userBearer);
    if ([401, 403, 404].includes(res.status)) return null;
    if (!res.ok) throw new ServiceUnavailableException();
    const b = (await res.json()) as Partial<AuthIdentity>;
    if (typeof b.id !== 'string' || typeof b.isActive !== 'boolean' || !Array.isArray(b.memberships)) throw new ServiceUnavailableException();
    return { id: b.id, adminTier: b.adminTier ?? null, isActive: b.isActive, memberships: b.memberships };
  }

  async hasPlatformAccess(userBearer: string, platformId: string): Promise<boolean> {
    const res = await this.call(`/auth/platform-access/${encodeURIComponent(platformId)}`, userBearer);
    if ([401, 403, 404].includes(res.status)) return false;
    if (!res.ok) throw new ServiceUnavailableException();
    return ((await res.json()) as { allowed?: boolean }).allowed === true;
  }
}
