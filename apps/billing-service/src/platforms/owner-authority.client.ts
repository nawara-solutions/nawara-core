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
  /** Core V2 S3f: `GET /auth/grants` — who the bearer is, live (kind, and the Company of an Owner). 401 refused; 503 unanswerable. */
  actor(userBearer: string, deadline: AbortSignal): Promise<VerifiedActor>;
  /** Core V2 S3f: `GET /auth/platform-access/:platformId` — may this Owner or operator act on the Platform right now? (404 is `false`.) */
  platformAllowed(userBearer: string, platformId: string, deadline: AbortSignal): Promise<boolean>;
  /** Core V2 S3f: `GET /auth/admin/organizations/:id` — the Organization's Platform as Auth derives it, when the caller may see it (else null). */
  organizationPlatform(userBearer: string, organizationId: string, deadline: AbortSignal): Promise<string | null>;
  /**
   * Core V2 S3f: `GET /auth/admin/operators/:id/platform-assignments` with the OWNER's bearer — whether that operator of the Owner's Company
   * holds an ACTIVE assignment to the Platform right now (an unknown operator, another Company's, or no assignment: `false`).
   */
  operatorAssigned(ownerBearer: string, operatorUserId: string, platformId: string, deadline: AbortSignal): Promise<boolean>;
}

/** Core V2 S3f: the live facts of `/auth/grants` the fee commands need. */
export interface VerifiedActor {
  userId: string;
  kind: 'owner' | 'operator' | 'member';
  /** The Owner's Company; null for an operator or a member (Billing never infers one). */
  companyId: string | null;
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

  /** A JSON value of at most `MAX_AUTH_RESPONSE_BYTES`, read under the request's deadline; anything else is a 503 (never guess). */
  private async body(res: Response, deadline: AbortSignal): Promise<unknown> {
    try {
      if (Number(res.headers.get('content-length') ?? 0) > MAX_AUTH_RESPONSE_BYTES || !res.body) throw new Error('oversized');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_AUTH_RESPONSE_BYTES) throw new Error('oversized');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      await this.release(res);
      if (deadline.aborted) throw this.failure(deadline);
    }
    throw new AuthDependencyError('auth_unavailable');
  }

  private async json(res: Response, deadline: AbortSignal): Promise<Record<string, unknown>> {
    const b = await this.body(res, deadline);
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) return b as Record<string, unknown>;
    throw new AuthDependencyError('auth_unavailable');
  }

  /** 200 is read; 404 is `null` (Auth's collapsed "unknown, not yours, not assigned"); 401 is 401; anything else is a 503. */
  private async read(path: string, userBearer: string, deadline: AbortSignal): Promise<unknown> {
    const res = await this.send(path, userBearer, deadline);
    if (res.status === 200) return this.body(res, deadline);
    await this.release(res);
    if (res.status === 404) return null;
    if (res.status === 401) throw new UnauthorizedException();
    throw new AuthDependencyError('auth_unavailable');
  }

  async actor(userBearer: string, deadline: AbortSignal): Promise<VerifiedActor> {
    const res = await this.send('/auth/grants', userBearer, deadline);
    if (res.status !== 200) {
      await this.release(res);
      if (res.status === 401) throw new UnauthorizedException();
      throw new AuthDependencyError('auth_unavailable');
    }
    const g = await this.json(res, deadline);
    if (typeof g.userId !== 'string' || !UUID.test(g.userId) || (g.kind !== 'owner' && g.kind !== 'operator' && g.kind !== 'member')) throw new AuthDependencyError('auth_unavailable');
    if (g.kind === 'owner' && (typeof g.companyId !== 'string' || !UUID.test(g.companyId))) throw new AuthDependencyError('auth_unavailable'); // an owner always has a Company
    return { userId: g.userId.toLowerCase(), kind: g.kind, companyId: g.kind === 'owner' ? (g.companyId as string).toLowerCase() : null };
  }

  async platformAllowed(userBearer: string, platformId: string, deadline: AbortSignal): Promise<boolean> {
    const a = await this.read(`/auth/platform-access/${encodeURIComponent(platformId)}`, userBearer, deadline);
    if (a === null) return false; // unknown, another Company's, or not assigned: Auth's one answer
    const o = a as Record<string, unknown>;
    if (typeof a !== 'object' || Array.isArray(a) || o.allowed !== true || typeof o.platformId !== 'string' || o.platformId.toLowerCase() !== platformId.toLowerCase()) {
      throw new AuthDependencyError('auth_unavailable');
    }
    return true;
  }

  async organizationPlatform(userBearer: string, organizationId: string, deadline: AbortSignal): Promise<string | null> {
    const a = await this.read(`/auth/admin/organizations/${encodeURIComponent(organizationId)}`, userBearer, deadline);
    if (a === null) return null;
    const o = a as Record<string, unknown>;
    if (typeof a !== 'object' || Array.isArray(a) || typeof o.id !== 'string' || o.id.toLowerCase() !== organizationId.toLowerCase()
      || typeof o.platformId !== 'string' || !UUID.test(o.platformId)) throw new AuthDependencyError('auth_unavailable');
    return o.platformId.toLowerCase();
  }

  async operatorAssigned(ownerBearer: string, operatorUserId: string, platformId: string, deadline: AbortSignal): Promise<boolean> {
    const a = await this.read(`/auth/admin/operators/${encodeURIComponent(operatorUserId)}/platform-assignments`, ownerBearer, deadline);
    if (a === null) return false; // not an operator of this Owner's Company
    if (!Array.isArray(a)) throw new AuthDependencyError('auth_unavailable');
    return a.some((r: unknown) => {
      const o = r as Record<string, unknown> | null;
      if (typeof o !== 'object' || o === null || typeof o.platformId !== 'string' || typeof o.active !== 'boolean') throw new AuthDependencyError('auth_unavailable');
      return o.active && o.platformId.toLowerCase() === platformId.toLowerCase();
    });
  }

  async verifyPlatformOwner(userBearer: string, platformId: string, deadline: AbortSignal): Promise<VerifiedPlatformOwner> {
    const a = await this.actor(userBearer, deadline);
    if (a.kind !== 'owner') throw operationNotPermitted(); // an operator or a member: one answer
    if (!(await this.platformAllowed(userBearer, platformId, deadline))) throw notFound(); // unknown, or another Company's: Auth's one answer, and Billing's
    return { userId: a.userId, companyId: a.companyId! };
  }
}
