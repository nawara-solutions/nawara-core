import { HttpException, UnauthorizedException } from '@nestjs/common';
import { attachLocalizedMessage, correlationHeaders } from '@nawara/service-kit';
import { notFound, operationNotPermitted } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

/** DI token of the Auth port the Platform configuration uses (Core V2 S3d). */
export const OWNER_AUTHORITY = Symbol('BILLING_OWNER_AUTHORITY');

/** What Auth verified, live, for this request: the Owner and THEIR Company (never a request value). */
export interface VerifiedPlatformOwner {
  userId: string;
  companyId: string;
}

/**
 * Core V2 S3d (register BIL-01, AUTH-07; S0 §3.6): the Owner check of the Platform commercial configuration, through Auth's existing,
 * approved routes only. It forwards the human's OWN bearer to Auth and nothing else (never a service credential, never a request value):
 *   1. `GET /auth/grants`: the caller is an Owner, and Auth names their (one, immutable) Company;
 *   2. `GET /auth/platform-access/:platformId`: live, the Platform is in that Owner's Company (Auth allows an Owner exactly when
 *      `Owner.companyId = Platform.companyId`; an unknown Platform, or another Company's, is Auth's collapsed 404).
 * Together these are the Company of the Platform, as Auth knows it now. Anything Auth cannot answer, or answers in an unexpected shape, is
 * a 503: nothing is written, and nothing is inferred locally.
 */
export interface OwnerAuthority {
  /**
   * 401 when Auth refuses the bearer; 403 `operation_not_permitted` for a member or an operator; 404 (collapsed) when the Platform is
   * unknown or not in the Owner's Company; 503 (`auth_timeout` / `auth_unavailable`) when Auth cannot say.
   */
  verifyPlatformOwner(userBearer: string, platformId: string, deadline: AbortSignal): Promise<VerifiedPlatformOwner>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Auth's answers are a few hundred bytes; anything larger is not Auth's answer (and is never buffered whole). The Release bound. */
export const MAX_AUTH_RESPONSE_BYTES = 16 * 1024;

/**
 * Auth could not answer, so the configuration fails closed (503). `auth_timeout`: the request's Auth budget ran out; `auth_unavailable`:
 * every other failure (refused or reset connection, DNS, an unexpected status or redirect, a malformed or oversized answer). The body
 * names the class only, never Auth's address or answer.
 */
export class AuthDependencyError extends HttpException {
  constructor(readonly failure: 'auth_timeout' | 'auth_unavailable') {
    super({ message: BILLING_MESSAGES.authorityUnverified.en, code: failure }, 503);
    attachLocalizedMessage(this, { texts: BILLING_MESSAGES.authorityUnverified });
  }
}

/** The Release / Audit hardened client, for Billing: a deadline, no redirect, a bounded body, every surprise a 503. */
export class HttpOwnerAuthority implements OwnerAuthority {
  constructor(private readonly opts: { baseUrl: string }) {}

  private failure(signal: AbortSignal): AuthDependencyError {
    return new AuthDependencyError(signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'auth_timeout' : 'auth_unavailable');
  }

  private async send(path: string, userBearer: string, deadline: AbortSignal): Promise<Response> {
    try {
      // Never follow a redirect: the bearer goes to the configured Auth and nowhere else; a 3xx is refused like any other unexpected status.
      return await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${userBearer}`, ...correlationHeaders() },
        redirect: 'manual',
        signal: deadline,
      });
    } catch {
      throw this.failure(deadline); // network error or deadline: fail CLOSED
    }
  }

  /** An answer that is not read (a refusal, an unexpected status) is released at once, so its socket returns to the pool. */
  private async release(res: Response): Promise<void> {
    await res.body?.cancel().catch(() => undefined);
  }

  /** A JSON object of at most `MAX_AUTH_RESPONSE_BYTES`, read under the request's deadline; anything else is a 503 (never guess). */
  private async json(res: Response, deadline: AbortSignal): Promise<Record<string, unknown>> {
    try {
      if (Number(res.headers.get('content-length') ?? 0) > MAX_AUTH_RESPONSE_BYTES || !res.body) throw new Error('oversized');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_AUTH_RESPONSE_BYTES) throw new Error('oversized');
        chunks.push(chunk);
      }
      const b: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof b === 'object' && b !== null && !Array.isArray(b)) return b as Record<string, unknown>;
    } catch {
      await this.release(res);
      if (deadline.aborted) throw this.failure(deadline);
    }
    throw new AuthDependencyError('auth_unavailable');
  }

  async verifyPlatformOwner(userBearer: string, platformId: string, deadline: AbortSignal): Promise<VerifiedPlatformOwner> {
    const grants = await this.send('/auth/grants', userBearer, deadline);
    if (grants.status !== 200) {
      await this.release(grants);
      if (grants.status === 401) throw new UnauthorizedException();
      throw new AuthDependencyError('auth_unavailable');
    }
    const g = await this.json(grants, deadline);
    if (typeof g.userId !== 'string' || !UUID.test(g.userId) || (g.kind !== 'owner' && g.kind !== 'operator' && g.kind !== 'member')) throw new AuthDependencyError('auth_unavailable');
    if (g.kind !== 'owner') throw operationNotPermitted(); // an operator or a member: one answer
    if (typeof g.companyId !== 'string' || !UUID.test(g.companyId)) throw new AuthDependencyError('auth_unavailable'); // an owner always has a Company

    const access = await this.send(`/auth/platform-access/${encodeURIComponent(platformId)}`, userBearer, deadline);
    if (access.status === 404) {
      await this.release(access);
      throw notFound(); // unknown, or another Company's: Auth's one answer, and Billing's
    }
    if (access.status !== 200) {
      await this.release(access);
      if (access.status === 401) throw new UnauthorizedException(); // the session ended between the two calls
      throw new AuthDependencyError('auth_unavailable');
    }
    const a = await this.json(access, deadline);
    if (a.allowed !== true || typeof a.platformId !== 'string' || a.platformId.toLowerCase() !== platformId.toLowerCase()) throw new AuthDependencyError('auth_unavailable');
    return { userId: g.userId.toLowerCase(), companyId: g.companyId.toLowerCase() };
  }
}
