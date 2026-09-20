import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';

/**
 * ADR-0042 decision 6 / Amendment 1 A.1-A.2: the server-derived authorization facts Auth exposes about
 * the caller whose bearer is forwarded here. Deliberately NOT `AuthClient`/`HttpAuthClient` from
 * `@nawara/service-kit` (those are named and forbidden by boundary.spec.ts's Stage-9 guard, which still
 * holds everywhere in this service except this module): this is a bespoke, narrowly-scoped client that
 * exists ONLY in `admin/`, forwards only the end user's own bearer (never a service credential), and is
 * used only to evaluate human administrative authority. It never becomes a general identity client for
 * the rest of the service.
 */
export interface AuthGrantFacts {
  userId: string;
  kind: 'member' | 'owner' | 'operator';
  companyId: string | null;
  platformAssignments: string[];
  organizationAdminMemberships: string[];
}

export interface AuthGrantsClient {
  /** Throws UnauthorizedException if Auth rejects the bearer; ServiceUnavailableException if Auth cannot be asked (fail closed). */
  grantsFor(userBearer: string): Promise<AuthGrantFacts>;
  /** True only if Auth confirms a valid, unconsumed step-up for this purpose and session. Never throws for a denial. */
  verifyStepUp(userBearer: string, purpose: string, stepUpToken: string): Promise<boolean>;
}

export interface HttpAuthGrantsClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class HttpAuthGrantsClient implements AuthGrantsClient {
  private readonly timeoutMs: number;
  constructor(private readonly opts: HttpAuthGrantsClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  private async call(method: 'GET' | 'POST', path: string, userBearer: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${userBearer}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...correlationHeaders(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException(); // network error or timeout: fail CLOSED
    }
  }

  async grantsFor(userBearer: string): Promise<AuthGrantFacts> {
    const res = await this.call('GET', '/auth/grants', userBearer);
    if (res.status === 401) throw new UnauthorizedException();
    if (!res.ok) throw new ServiceUnavailableException();
    const b = (await res.json()) as Partial<AuthGrantFacts>;
    if (
      typeof b.userId !== 'string' ||
      (b.kind !== 'member' && b.kind !== 'owner' && b.kind !== 'operator') ||
      !Array.isArray(b.platformAssignments) ||
      !Array.isArray(b.organizationAdminMemberships)
    ) {
      throw new ServiceUnavailableException(); // malformed response: never guess, fail closed
    }
    return { userId: b.userId, kind: b.kind, companyId: b.companyId ?? null, platformAssignments: b.platformAssignments, organizationAdminMemberships: b.organizationAdminMemberships };
  }

  async verifyStepUp(userBearer: string, purpose: string, stepUpToken: string): Promise<boolean> {
    const res = await this.call('POST', '/auth/step-up/verify', userBearer, { purpose, stepUpToken });
    if (res.status === 204) return true;
    if (res.status === 401 || res.status === 403) return false;
    throw new ServiceUnavailableException();
  }
}
