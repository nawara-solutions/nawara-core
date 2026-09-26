import { HttpException, UnauthorizedException } from '@nestjs/common';
import { correlationHeaders } from '@nawara/service-kit';

/** DI token of the Auth port the owner read uses (Stage 19.3). Tests inject their own. */
export const OWNER_AUTHORITY = Symbol('OWNER_AUTHORITY');

/**
 * Stage 19.3 (ADR-0050 decision 6, Audit-X): the ONLY place audit-service calls another service. It forwards the Company owner's OWN bearer
 * to Auth and nothing else: never a service credential, never a value the request supplied beyond the path's organization id, which Auth
 * resolves itself. Auth answers from live state (account active, session active, token tier = database kind), so a blocked owner, a revoked
 * session or a changed hierarchy takes effect on the next read. Anything Auth cannot answer, or answers in an unexpected shape, is a 503:
 * the read fails closed and returns no evidence.
 */
export interface OwnerAuthority {
  /**
   * The verified owner's user id. 401 when Auth refuses the bearer; 403 when the identity is not a Company owner; 503 (`auth_timeout` /
   * `auth_unavailable`) when Auth cannot say. `deadline` (Stage 19.5): one budget shared by every Auth call of a request.
   */
  verifyOwner(userBearer: string, deadline?: AbortSignal): Promise<string>;
  /** True only when Auth confirms the organization belongs to the caller's Company (Auth's collapsed 404 otherwise). 503 when Auth cannot say. */
  ownsOrganization(userBearer: string, organizationId: string, deadline?: AbortSignal): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Stage 19.4: Auth's two answers are a few hundred bytes; anything larger is not Auth's answer (and is never buffered whole). */
export const MAX_AUTH_RESPONSE_BYTES = 16 * 1024;

/**
 * Stage 19.5: Auth could not answer, so the read fails closed (503). The code separates a slow Auth (`auth_timeout`: the request's Auth
 * budget ran out) from every other failure (`auth_unavailable`: refused or reset connection, DNS, an unexpected status or redirect, a
 * malformed or oversized answer). The body names the class only, never Auth's address or answer.
 */
export class AuthDependencyError extends HttpException {
  constructor(readonly failure: 'auth_timeout' | 'auth_unavailable') {
    super({ message: 'Authorization could not be verified; no evidence is returned.', code: failure }, 503);
  }
}

export class HttpOwnerAuthority implements OwnerAuthority {
  constructor(private readonly opts: { baseUrl: string; timeoutMs: number }) {}

  private failure(signal: AbortSignal): AuthDependencyError {
    return new AuthDependencyError(signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError' ? 'auth_timeout' : 'auth_unavailable');
  }

  private async get(path: string, userBearer: string, deadline?: AbortSignal): Promise<Response> {
    const signal = deadline ?? AbortSignal.timeout(this.opts.timeoutMs);
    try {
      // Stage 19.4: never follow a redirect. The bearer goes to the configured Auth and to nothing else, and an answer from any other
      // location (even another Auth path) is not an answer to this question: a 3xx is refused below like any unexpected status.
      return await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: { authorization: `Bearer ${userBearer}`, ...correlationHeaders() },
        redirect: 'manual',
        signal,
      });
    } catch {
      throw this.failure(signal); // network error or deadline: fail CLOSED
    }
  }

  /** Stage 19.5: an answer that is not read (a refusal, an unexpected status) is released at once, so its socket returns to the pool. */
  private async release(res: Response): Promise<void> {
    await res.body?.cancel().catch(() => undefined);
  }

  /** A JSON object of at most `MAX_AUTH_RESPONSE_BYTES`, read under the request's deadline; anything else is a 503 (never guess). */
  private async json(res: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
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
      if (signal?.aborted) throw this.failure(signal);
    }
    throw new AuthDependencyError('auth_unavailable'); // malformed, oversized or interrupted answer: never guess
  }

  async verifyOwner(userBearer: string, deadline?: AbortSignal): Promise<string> {
    const res = await this.get('/auth/grants', userBearer, deadline);
    if (res.status !== 200) {
      await this.release(res);
      if (res.status === 401) throw new UnauthorizedException();
      throw new AuthDependencyError('auth_unavailable'); // 3xx (never followed), 204, any other status: not an answer
    }
    const b = await this.json(res, deadline);
    if (typeof b.userId !== 'string' || !UUID.test(b.userId) || (b.kind !== 'owner' && b.kind !== 'operator' && b.kind !== 'member')) throw new AuthDependencyError('auth_unavailable');
    if (b.kind !== 'owner') throw new HttpException({ message: 'Only a Company owner may read audit evidence here.', code: 'operation_not_allowed' }, 403);
    if (typeof b.companyId !== 'string' || b.companyId === '') throw new AuthDependencyError('auth_unavailable'); // an owner always has a Company
    return b.userId.toLowerCase();
  }

  async ownsOrganization(userBearer: string, organizationId: string, deadline?: AbortSignal): Promise<boolean> {
    const res = await this.get(`/auth/admin/organizations/${encodeURIComponent(organizationId)}`, userBearer, deadline);
    if (res.status !== 200) {
      await this.release(res);
      if (res.status === 404) return false;
      if (res.status === 401) throw new UnauthorizedException();
      throw new AuthDependencyError('auth_unavailable');
    }
    const b = await this.json(res, deadline);
    if (typeof b.id !== 'string' || b.id.toLowerCase() !== organizationId) throw new AuthDependencyError('auth_unavailable'); // Auth answered about another organization
    return true;
  }
}
